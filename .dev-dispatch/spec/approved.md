# N3 —— 导出节点：doc(report) → vault 只读渲染

> 上游依据：work folder `wf-dc0c15` 的 `spec.md`(rev7) §5.5、§3.4，`plan.md` §2「链 A · N3」。
> **本包是链 A 的最后一个包。**
> 前置已合入 main：S1b（协议 + bus 客户端）、S2（调度 tick）、S3（终止判定 + `capHit`）、
> S4（生成编排 + `renderReportBody` / `parseReportMarker`）、N1（ingest + `buildDigestIndex` / 分页扫描）。

---

## 0　⛔ 派发面硬约束（上一条 development 死在这里，务必先读）

### 0.1 `.dd-evidence/` 是 dd 保留路径，**任何提交碰它都是硬失败**

机制（`attempt_controller.py:892-914`）：dd 对
`git log --raw {input_commit}..{work_head_commit} -- .dd-evidence/acceptance.json`
取输出，**非空即抛 `ACTOR_ACCEPTANCE_PATH_CHANGED`**，且**重试无用**（每次重试重做同样的修改）。

> ⛔ **不得以任何方式修改、删除、重建 `.dd-evidence/` 下的任何文件。**
>
> ⛔ **仓内出现属于别的 development 的陈旧 `acceptance.json` 是正常的**——它随 H0 从 main 继承。
> **它不是本包的问题，也不该由本包修**：dd 会在本包的 acceptance 阶段**自己生成新证据**，
> 该 finding 会在流程推进中自然消解。
> **若 reviewer 就此提出 finding，正确的回应是说明它不在本包 scope —— 而不是去动那个文件。**
> 上一条 development 正是因为「照着一条正确的 finding 去做了一个被禁止的动作」而被 cancel。

### 0.2 运行证据写 `docs/dev-notes/<development_id>.md`

⛔ **不得新建或复用仓根的 `IMPLEMENTATION_SUMMARY.md`。**
文件名必须带 `development_id` —— **让路径携带归属**，结构上不可能变成无主债。

---

## 1　本包要建什么

`spec.md §5.5`：报告落 `doc(report)` 进 `research:content`（**bus 是 SSoT**），
**同时**由确定性导出节点导出一份到 vault 供阅读。

```
doc(report)  ──[导出节点·确定性]──▶  vault 上的 .md 只读渲染
   (SSoT)                              (可删可重生·带来源 message_id·不接受编辑)
```

> **报告不可重建**——证据可以重新检索，但「这次综合得出了什么」是 LLM 一次性产物、不可重放。
> 它不在 bus 里就违反「数据持久化归 bus」。
>
> **导出件不是第二份真相，是渲染。** 先例就在本 vault 里：飞书镜像的规矩是
> `.ast.json` 为 SSoT、`.md` 只读渲染、**勿直接编辑 `.md`**。

沿用前四包的结构：**渲染与路径计算必须是纯函数**，文件写入与 bus 读取只在执行壳里、经 deps 注入。

---

## 2　落点（本 spec 定案）

```
<vaultRoot>/研究报告/<YYYY-MM-DD>-<topic-slug>.md
```

- `vaultRoot` **由配置传入**，不得硬编码（测试要能指向临时目录）
- **不进 `docs/`**（那是工程产物区）、**不进 `Zettelkasten/`**（那是原子笔记，且已迁 wiki MCP）
- `topic-slug` 由 topic 确定性派生（见 §4）

---

## 3　导出件头部：来源 + 终态，原样带出

导出件**必须**在头部携带：

| 字段 | 来源 |
|---|---|
| `source_message_id` | `doc(report)` 在 bus 上的 message_id |
| 终态标记 | S4 已写进 report body 头部的 `<!-- dr-terminal stop=… blocked=… capHit=… -->` |
| 只读声明 | 明示「本文件是渲染产物，可删可重生，请勿直接编辑」 |

⛔ **终态标记必须原样带出，不得重新解释或省略字段**（`spec.md §5.5` 末句）。
S4 已提供 `parseReportMarker(body)`，**直接复用，不要另写解析器**。

> **一份因触顶而停、且有 12 条线索卡住的报告，与一份正常收敛的报告，
> 在读者眼里必须长得完全不一样。**

---

## 4　⛔ 幂等：同一 report 导两次，结果逐字一致

`plan.md` 的 N3 DoD：**重复导出幂等**。

- 路径派生必须是**纯函数**：给定同一个 `doc(report)` + 同一 `vaultRoot` ⇒ **同一路径**
- 内容派生必须是**纯函数**：同一输入 ⇒ **逐字相同的字节**
- ⛔ **不得使用 `Date.now()` / `new Date()` / 随机数参与路径或内容**——
  那会让两次导出产出不同结果，幂等直接失效。
  日期若需出现在文件名里，**必须从 report 的数据派生**（如 bus 消息的 `created_at`），
  **由调用方经参数传入**，不得现取系统时钟。

---

## 5　硬验收（逐条可机械核验）

> **本表已逐条比对过 spec 全文的每个限定词与 ⛔ 标记，
> 包括 §0「派发面」、§7「非目标」、§8「环境」等看起来不承载需求的节。**
>
> 前面的包**三次**因「限定词只在正文、没进验收表」被拒（S3 的「条件 3 只拦新 clue」、
> S4 的「lock 是结构保证」、N1 的「必须分页」）。第三次那条恰恰藏在「环境」节里。

| # | 断言 | 怎么验 |
|---|---|---|
| **F1** | ⛔ 路径派生是**纯函数**且**不依赖桩** | 直接喂纯数据（doc + vaultRoot + createdAt 字面量），断言返回路径字符串 |
| **F2** | ⛔ 内容派生是**纯函数**且**不依赖桩** | 同上，断言返回的字节内容 |
| **F3** | ⛔ **幂等**：同一输入两次 ⇒ 路径与内容**逐字相同** | `expect(render(x)).toBe(render(x))` 且路径同理 |
| **F4** | ⛔ 源码中**无时钟/随机** | `grep -nE "\bDate\b\|Math\.random\|Date\.now" src/export.ts` **零命中** |
| **F5** | 头部含 `source_message_id` | 断言导出内容含给定的 message_id |
| **F6** | ⛔ 头部含终态标记且**逐字取自 report body** | report body 头部为 `stop=capped blocked=12 capHit=true`，断言三个值**全部**出现在导出件头部 |
| **F7** | ⛔ 复用 S4 的 `parseReportMarker`，不另写解析器 | `grep` 导入了 `parseReportMarker`；且 `src/export.ts` 中**无**新的 `dr-terminal` 正则 |
| **F8** | 头部含只读声明 | 断言含「渲染」「勿直接编辑」等约定文案（文案可自定，但须有该断言） |
| **F9** | ⛔ 落点在 `<vaultRoot>/研究报告/` 下 | 断言路径以该前缀开头 |
| **F10** | ⛔ `vaultRoot` **不硬编码** | 传两个不同 `vaultRoot` ⇒ 得到两个不同路径 |
| **F11** | ⛔ **不写 `docs/` 与 `Zettelkasten/`** | 断言路径不含这两个片段 |
| **F12** | 执行壳真的写了文件 | 打桩 fs 写入 dep，断言以 F1 的路径、F2 的内容各调用一次（**安全性+活性配对**） |
| **F13** | ⛔ 写入失败 ⇒ **响亮失败**，不得静默 | 打桩令写入抛错，断言错误向上传播（**不得**返回 null/undefined 当作成功） |
| **F14** | ⛔ **不得触碰 `.dd-evidence/`** | `git diff --name-only <base>..HEAD -- .dd-evidence/` **必须为空** |
| **F15** | 运行证据写 `docs/dev-notes/<development_id>.md` | 该文件存在；且仓根**无** `IMPLEMENTATION_SUMMARY.md` |
| **F16** | 全量测试与类型检查通过 | `npm run typecheck` 与 `npm test` 均 exit 0 |
| **F17** | 既有 114 条用例**一行未删** | `git diff` 中既有测试文件无 `it(` 净减少 |

---

## 6　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **T1** 路径里掺入 `Date.now()` | **F3 与 F4** |
| **T2** 内容里掺入变化量（如递增计数器） | **F3** |
| **T3** 终态标记只带 `stop=`、丢掉 `blocked`/`capHit` | **F6** |
| **T4** 头部去掉 `source_message_id` | **F5** |
| **T5** 落点改成 `docs/` | **F9 与 F11** |
| **T6** `vaultRoot` 改成硬编码常量 | **F10** |
| **T7** ⛔ 写入失败时 `catch` 并返回（静默吞掉） | **F13** |

> **只报「N/N 挂了」不算数。** 本线曾第一次变异跑出 10/10 差点签字，
> 去看挂的是哪几条才发现**核心那条断言全程存活**。
> **变异杀死的断言集合，必须与该变异所模拟的缺陷对得上。**
> **破坏后必须回显被改的那一行**，跑完逐字还原。

### 6.1 ⚠️ 打桩与命名纪律（本线学费换来的四条）

1. **打桩不得让两次读返回相同的值** ——「读了一次」与「读了两次」若产出相同观测值，
   断言无法区分，**测的是 stub 的确定性而非被测代码的行为**。
2. **describe 块名不得枚举多个判据 ID**（如 `(F1/F2/F3)`）——块名会污染块内每条用例的全名，
   让基于测试名的自动归因**跨断言误配**，产生「变异 ✓」的假阳性。
   **一个 describe 一个判据。**
3. **安全性断言必须配活性断言** ——「不发生坏事」可被「什么都不做」满足。
   F12 断言「以正确路径/内容调用写入」的同时，**必须断言确实发生了写入**。
4. ⛔ **凡本包必须实现的能力，验收行必须对纯数据求值，不得只经打桩的依赖验证** ——
   依赖注入会让核心逻辑**可以不存在而测试全绿**。F1/F2 即为此设。

---

## 7　非目标

- 不实现 worker / role 定义（链 C）
- 不改 `src/protocol.ts`（协议已在 agent-bus 上不可逆注册）
- 不改 S1b/S2/S3/S4/N1 已交付部分的既有导出签名；确需新增则**新增**
- **不做导出件的回读/校验**（导出件不是真相，不需要被验证；bus 才是 SSoT）
- 不做导出件的清理/GC

---

## 8　环境

- `setup_commands` 必须含 `npm ci`
- ⛔ **agent-bus append-only、无 DELETE 路由，写入不可回退。
  本包不得对真实 bus 发起写入**——全部打桩单测。
- ⛔ **本包不得向真实 vault（`/data/vault`）写入任何文件**——
  测试一律用临时目录或打桩的写入 dep。
- `src/generate.ts` 已导出 `parseReportMarker` / `renderReportBody`，直接复用。
