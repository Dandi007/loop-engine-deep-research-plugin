# N1 —— ingest 节点：取材 + MinerU 转写 + 按 digest 全局去重

> 上游依据：work folder `wf-dc0c15` 的 `spec.md`(rev7) §5.1、§5.3、§2.6，`plan.md` §2「链 A · N1」。
> 前置包已合入 main（`aaa9676`）：S1b（协议类型 + bus 客户端）、S2（`decideTick`/`runTick`）、
> S3（终止判定）、S4（生成阶段编排）。

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
本包按该退路实现（读 channel、在应用层按 `doc.digest` 建索引）。

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
| **R7** 去掉并发限制（放开并行） | **E13** |

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
