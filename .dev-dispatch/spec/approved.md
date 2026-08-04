# N1(v2) —— ingest 节点：取材 + MinerU 转写 + 按 digest 全局去重

> **本包是 `dev_ledr_n1_ingest_01` 的重派**（该条已 CANCELLED）。
> 上一条的 MinerU 契约实现、硬路由、4MB 护栏、失败处置、`docs/dev-notes/` 归位**都做对了**，
> 参考分支 `loopdev/dev_ledr_n1_ingest_01/attempt-context-v1` commit `2293554`（**不作为交付**）。
> 它死于两条：①去重核心只有接口没有实现 ②实现方去修 `.dd-evidence/acceptance.json` 触发硬失败。
> 本版把这两条都写成了硬约束与验收行。

> 上游依据：work folder `wf-dc0c15` 的 `spec.md`(rev7) §5.1、§5.3、§2.6，`plan.md` §2「链 A · N1」。
> 前置包已合入 main（`aaa9676`）：S1b（协议类型 + bus 客户端）、S2（`decideTick`/`runTick`）、
> S3（终止判定）、S4（生成阶段编排）。

## 0　⛔ 上一条 development 的两个死因（务必先读）

### 0.1 `.dd-evidence/` 是 dd 保留路径，**任何提交碰它都是硬失败**

上一条的 continuous reviewer 报了一条 major：
「`.dd-evidence/acceptance.json` 是上一个 development 的陈旧证据」。

实现方照此去"修"它 ⇒ 连续 4 次 `ACTOR_ACCEPTANCE_PATH_CHANGED`（"actor history changed
the acceptance path"）⇒ 死循环，只能 cancel。

**机制（`attempt_controller.py:892-914`）**：dd 对
`git log --raw {input_commit}..{work_head_commit} -- .dd-evidence/acceptance.json`
取输出，**非空即抛 `ACTOR_ACCEPTANCE_PATH_CHANGED`**。

> ⛔ **不得以任何方式修改、删除、重建 `.dd-evidence/` 下的任何文件。**
> 该目录由 dd 自己写。
>
> ⛔ **仓内出现属于别的 development 的陈旧 `acceptance.json` 是正常的**——
> 它随 H0 从 main 继承而来，**不是本包的问题，也不该由本包修**。
> 本包的 acceptance 证据由 dd 在 acceptance 阶段自行生成。
> **若 reviewer 就此提出 finding，正确的回应是说明它不在本包 scope，而不是去动那个文件。**

### 0.2 去重核心只有接口、没有实现

`readExistingTranscript` 上一版只是 `IngestDeps` 的抽象方法，`src/` 下**没有任何函数**
扫描 `research:content` 并按 `doc.digest` 建索引 ⇒
「同一份材料全局只转一次」这条成本护城河**在代码里不存在**，而桩测全绿。

> **判据：当验收全部建立在打桩的依赖之上时，被打桩的那一部分就没有被验收。**
> **依赖注入让核心逻辑可以「不存在」而测试全绿。**
>
> 本版的修法：**§6 增加不依赖桩的验收行**——要求 `src/` 下存在对**纯数据入参**
> 求值的真实函数，用例直接喂数组、断言返回值。**桩绕不过纯数据断言。**

---

## 1　本包要建什么

**本期唯一新造的组件。** 其余全是组装。

```
worker（任意信源）发现材料 → 只发 URI + digest，从不自己下载
        ↓
调度器查 research:content：该 digest 的 doc(transcript) 存在吗？
        ↓ 不存在
ingest 节点：取材（http / 本地拷贝）→ MinerU 转写 → doc(transcript)
        ↓
worker 读 doc → 产出 evidence
```

**为什么是确定性节点而不是 role**：取材与转写都没有裁量空间——给定 URL 下载的输出是确定的，
给定 PDF MinerU 的输出是确定的（内部跑 OCR 模型，但同输入同输出、可缓存、不做取舍）。

**三个理由**（`spec.md §5.1`）：
1. 兑现「同一份材料全局只转一次」——这是 GPU 成本的唯一护城河
2. 避免飞书附件 / web 下载 / 本地文件各实现一遍下载逻辑（**同一件事实现多遍必然漂移**）
3. worker 跑省钱档、只有必要角色跑贵档，成本差一个量级

沿用 S2/S3/S4 的结构：**决策逻辑纯函数化**，IO 只在执行壳里，全部经 deps 注入以便打桩。

---

## 2　⛔ MinerU 的真实契约（已实测，勿按想象实现）

> 以下全部来自 memory card `mineru-service`（`last_verified: 2026-07-29`）
> **加本 spec 作者于 2026-08-04 的独立复现**。**不要自行改用别的调用方式。**

### 2.1 端点与路由

| 角色 | 端点 | 约束 |
|---|---|---|
| 主（GPU） | `http://172.22.62.133:8090` | 0.42 s/页；⛔ **图片输入必炸 cuDNN** |
| backup（CPU） | `http://127.0.0.1:8090` | ~11 s/页 |

⛔ **按扩展名硬路由：图片（bmp/gif/jp2/jpeg/jpg/png/tiff/webp）一律走本机 CPU。**
不要靠「先试 GPU、失败再降级」——那是探错重试，本项目已明确用硬路由。

⛔ **调用必须 `--noproxy '*'` 并清 `http_proxy`/`https_proxy`**：
本机与 133 都跑 mihomo，直连内网会被劫持返回 502。

### 2.2 走同步 `/file_parse`，⛔ 不做任务管理

```
POST /file_parse   multipart/form-data   同步，一发一收，直接回 md_content
```

⛔ **不要用 `POST /tasks` + 轮询那套。** 理由是硬的：

> **MinerU 的任务态是纯内存 dict**（`fast_api.py:1096`），`task_retention_seconds=86400` 到点清、
> **容器重启即全失**。基于它做任务管理等于把状态放在一个会凭空消失的地方。
> 且 **`GET /tasks` 无 list 接口（405）**——你连自己有哪些在飞任务都查不出来。

### 2.3 必须显式传的参数

| 参数 | 值 | 理由 |
|---|---|---|
| `files` | multipart **数组**字段（复数） | 字段名就是 `files=`，不是 `file=` |
| `backend` | ⛔ **`pipeline`** | **两端均无 VLM 模型**，默认的 `hybrid-auto-engine` 会 `failed`，error 为 `Local path for repo_mode 'vlm' is not configured.`（作者 2026-08-04 实测复现） |
| `return_md` | `true` | 默认即 true，显式传以防上游改默认 |

### 2.4 响应形状

```jsonc
{
  "backend": "pipeline",
  "version": "3.1.6",
  "results": {
    "<去掉扩展名的文件名>": { "md_content": "..." }
  }
}
```

⛔ **`results` 的 key 是「去掉扩展名的文件名」，不是原 filename。**
（实测：上传 `probe.pdf` ⇒ key 为 `probe`。）

### 2.5 并发实际为 1

health 报 `max_concurrent_requests: 2`，但启动日志明写 `Request concurrency limited to 1`
（`fast_api.py:258-260`）。**批量只能排队** —— 不要并发打它。

### 2.6 支持格式

pdf + 图片(bmp/gif/jp2/jpeg/jpg/png/tiff/webp) + office(docx/pptx/xlsx)。
**不支持 epub/mobi/chm/azw** ⇒ 遇到这些扩展名必须**响亮失败**，不得静默跳过。

---

## 3　按 digest 全局去重

`research:content` channel（**永久、全局共享、无权限隔离**，`spec.md §2.6`）：

1. 收到 `URI + digest` ⇒ 先查该 digest 的 `doc(transcript)` 是否已存在
2. **存在 ⇒ 直接返回已有 doc，⛔ 不得调用 MinerU**
3. 不存在 ⇒ 取材 → 转写 → 发布 `doc(transcript)`

> **内容面全局共享是硬要求**：MinerU 转写是唯一吃 GPU 的一步，
> **跨研究复用是它唯一的成本护城河**。不共享则「同一份材料全局只转一次」自动失效。

⚠️ **P0.5 探针结论**：bus **不能按 digest 反查消息**，退路是**应用层扫描 channel**。

⛔ **本包必须真正实现该退路，不能只声明接口**：

1. `src/` 下必须存在一个**纯函数**，签名形如
   `buildDigestIndex(messages: BusMessage[]): Map<string, DocV2>`
   —— 入参是**纯数据数组**，不碰网络，可直接喂用例
2. `src/` 下必须存在**分页扫描**实现：读 `research:content` 时**必须带 `after_seq` 翻页**，
   直到取空为止（`GET /v1/channels/<id>/messages` 默认 `limit=100` 且返回**最早** 100 条，
   不翻页只会看到最早的 100 条）
3. `readExistingTranscript` 由上述两者组合实现，**不得只留抽象方法**

---

## 4　4MB 硬护栏

`spec.md §5.3`：**不分段，加护栏，超 4MB 报错拒绝。**

- **不分段的理由**：分段的复杂度会全部落在 anchor 上，而 anchor 是已知最脆弱的地方。
  **为一个可能不发生的场景，把已经在出错的东西变复杂**，是拿确定的复杂度换不确定的收益。
- **4MB 的理由**：它不是「对的数」，是**唯一被实测过的数**。
- **护栏的价值不在拦住大文件，在让失败响亮**——现状是超限不报错，只会内存耗尽或变慢。

---

## 5　MinerU 不可达时：响亮失败 + 标 blocked

MinerU 不可达 / 返回 failed ⇒ **响亮失败**，并把对应 clue 标 `blocked`，
**不得静默降级**（如返回空转写、跳过该材料）。

> 本线在「静默降级」上栽过八次，最狠的一次是一个 `rc=0`、输出 125KB 的错误命令被读成正常空结果。
> **一个不报错、退出码为 0、还给你一个看起来合理的返回值的错误，比报错的危险得多。**

---

## 6　硬验收（逐条可机械核验）

> **本表已逐条比对过正文的每个限定词与「⛔」标记。**
> 正文里出现而表中没有对应行的限定词，视为本 spec 的缺陷——
> 前面的包已两次因「限定词只在正文、没进验收表」被 final reviewer 拒。

| # | 断言 | 怎么验 |
|---|---|---|
| **E1** | ⛔ digest 已存在 ⇒ **不调用 MinerU** | 打桩令 channel 已有该 digest 的 doc，断言 MinerU 调用次数 **=== 0**，且返回已有 doc |
| **E2** | digest 不存在 ⇒ 调用 MinerU **恰好 1 次**并发布 doc | 断言调用 1 次 + publish 1 次 |
| **E3** | ⛔ 同一材料连跑两次，第二次命中去重 | 顺序跑两次，断言 MinerU 总调用次数 **=== 1** |
| **E4** | ⛔ `backend=pipeline` 被显式传出 | 捕获请求体/表单，断言含 `backend=pipeline`；且 **grep 源码中不得出现 `hybrid-auto-engine`** |
| **E5** | ⛔ 走 `/file_parse`，不走 `/tasks` | 捕获请求 URL，断言含 `/file_parse`；且 **grep 源码 `/tasks` 零命中** |
| **E6** | ⛔ 图片扩展名路由到 **CPU** 端点 | `.png` / `.jpg` 各一例，断言 URL 为 `127.0.0.1:8090` |
| **E7** | 非图片路由到 **GPU** 端点 | `.pdf` / `.docx`，断言 URL 为 `172.22.62.133:8090` |
| **E8** | ⛔ 结果按「**去扩展名文件名**」取 | 打桩返回 `{results:{"probe":{md_content:"X"}}}`，输入 `probe.pdf` ⇒ 取到 `"X"` |
| **E9** | ⛔ 4MB **正反两例** | 4MB−1 通过；4MB+1 **报错拒绝**（**一个永远红或永远绿的检查等于没有检查**） |
| **E10** | ⛔ 不支持的扩展名（epub/mobi/chm/azw）**响亮失败** | 断言抛错或返回显式错误，**不得**返回空/成功 |
| **E11** | ⛔ MinerU 不可达 ⇒ 响亮失败 **且** 该 clue 标 `blocked` | 打桩令请求抛错，断言：①向上抛/返回错误 ②发生一次把该 clue 置 `blocked` 的动作 |
| **E12** | ⛔ MinerU 返回 `status=failed` ⇒ 同 E11 处置 | 独立用例（**与 E11 是不同的失败形态，不得只测一个**） |
| **E13** | ⛔ 不并发打 MinerU | 同时投两份材料，断言任一时刻在飞请求数 **≤ 1**（用共享计数器 + 真异步挂起的桩） |
| **E17** | ⛔ `buildDigestIndex` 是**不依赖桩**的真实函数 | 直接喂一个 `BusMessage[]` 字面量数组（含 3 条 doc、其中 2 条同 digest），断言返回索引的 size 与取值正确 |
| **E18** | ⛔ **分页**：>100 条消息时发起多次带 `after_seq` 的读取 | 打桩令首次返回 100 条、第二次返回 20 条、第三次返回 0 条，断言发起 **3** 次读取且第 2/3 次 URL 含 `after_seq=` |
| **E19** | ⛔ `readExistingTranscript` 由上述两者**组合实现**，非抽象 | grep `src/` 中存在其具体实现（非仅 interface 声明）；且有一条用例经**真实实现 + 打桩的 HTTP 层**跑通去重 |
| **E20** | ⛔ **不得修改 `.dd-evidence/`** | `git diff --name-only <base>..HEAD -- .dd-evidence/` **必须为空** |
| **E14** | 决策逻辑纯函数 | 其模块不 import `./bus`；`grep -nE "\bDate\b\|Math\.random\|fetch\("` 零命中 |
| **E15** | 全量测试与类型检查通过 | `npm run typecheck` 与 `npm test` 均 exit 0 |
| **E16** | 既有 81 条用例**一行未删** | `git diff` 中既有测试文件无 `it(` 净减少 |

---

## 7　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **R1** 去掉 digest 去重（每次都调 MinerU） | **E1 与 E3** |
| **R2** `backend` 改回 `hybrid-auto-engine` | **E4** |
| **R3** 图片路由改成 GPU | **E6** |
| **R4** 结果按原 filename（带扩展名）取 | **E8** |
| **R5** 去掉 4MB 上限判断 | **E9 的正例**（4MB+1 应被拒） |
| **R6** ⛔ MinerU 失败时返回空字符串而非报错 | **E11 与 E12** |
| **R7** 去掉并发限制（放开并行） | **E13**（⚠️ 须从串行化函数**本体**下手，例如把 `return prev.then(fn).finally(release);` 改成 `release(); return fn();`；改调用点会让 `transcribe` 根本不被调用，「并发≤1」空洞成立 ⇒ 零功率的假象） |
| **R8** `buildDigestIndex` 只取最后一条（不建全量索引） | **E17** |
| **R9** 去掉分页（只读第一页） | **E18** |

> **只报「N/N 挂了」不算数。** 本线曾第一次变异跑出 10/10 差点签字，
> 去看挂的是哪几条才发现**核心那条断言全程存活**。
> **变异杀死的断言集合，必须与该变异所模拟的缺陷对得上。**
> **破坏后必须回显被改的那一行。**

### 7.1 ⚠️ 打桩与命名纪律（本线已付过学费）

1. **打桩不得让两次读返回相同的值** ——「读了一次」与「读了两次」若产出相同观测值，
   断言无法区分，**测的是 stub 的确定性而非被测代码的行为**。
   E3 / E13 尤其要注意：让两次调用可区分（计数器 / 不同返回值）。
2. **describe 块名不得枚举多个判据 ID**（如 `(E1/E2/E3)`）——
   块名会污染块内每条用例的全名，让基于测试名的自动归因**跨断言误配**，
   产生「变异 ✓」的假阳性。**一个 describe 一个判据，或块名不带 ID。**
3. **安全性断言必须配活性断言**：
   「不发生坏事」可以被「什么都不做」满足。E1 断言「不调用 MinerU」的同时，
   **必须断言「返回了已有 doc」**，否则「直接返回 null」也能通过。

---

## 8　顺带清理：让路径携带归属

⛔ **删除仓根的 `IMPLEMENTATION_SUMMARY.md`；本包及今后的运行证据一律写
`docs/dev-notes/<development_id>.md`。**

**历史**：S2 曾按 spec 删除它，S3 的实现方用同一惯用名重建，S4 继续改它。

> **一次性清理只约束那一个包。** 要让一个名字真正退役，需要**结构性**修法。
> 正解是**让路径携带归属**：文件名带 `development_id` ⇒ 结构上不可能变成无主债，
> 每个包写自己的，谁也不用删谁的。
>
> 反面实证：另一个仓的同名文件横跨 8+ 个 development、被 18 处评审提及、**一次也没被修**——
> 因为每个 reviewer 都**正确地**判定它不在自己包的 scope 内。**局部各自正确，全局持续失败。**

---

## 9　非目标

- 不实现导出节点（N3）
- 不实现 worker / role 定义（链 C）
- 不做 L2 内容摘要去重（`spec.md §8` 显式不做：判据没写出来，现在实现等于把没想清的判据焊进流程）
- 不做对象存储选型（L0 原件的家）——bus 上只留 URI + digest，原件留 MinerU 服务侧
- **不改 `src/protocol.ts`**（协议已在 agent-bus 上不可逆注册）
- 不改 S1b/S2/S3/S4 已交付部分的既有导出签名

---

## 10　环境

- `setup_commands` 必须含 `npm ci`
- ⛔ **agent-bus append-only、无 DELETE 路由，写入不可回退。**
  **本包不得对真实 bus 发起写入，也不得对真实 MinerU 发起转写**——全部用打桩单测。
- `GET /v1/channels/<id>/messages` 默认 `limit=100` 且返回**最早** 100 条；
  应用层扫描 `research:content` 建 digest 索引时**必须分页**（`after_seq`）。
- MinerU 健康检查（仅供人工确认环境，不进 acceptance）：
  `curl -sS --noproxy '*' http://127.0.0.1:8090/health`
