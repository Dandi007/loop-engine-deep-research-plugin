# G4c —— 生成段接进生产：`runGenerate` 至今**零调用者**

> 派发方：`line-deep-research`。**这是已核实的生产缺陷，不是加功能。**
> 前置：G4a(v2)（`--question` 贯通）+ G4b(v3)（终态贯通）均已合入 main `f655317`。

---

## 0　已核实的事实

| # | 事实 | 证据 |
|---|---|---|
| A | **`runGenerate` 在 `src/` 内零调用者** | `grep -rn 'from "./generate"' src/` **只命中 `src/export.ts:14`**，且只取 `parseReportMarker` / `renderReportBody` 两个纯函数 |
| B | **tick 决策集里没有 generate** | `tick.ts` 的 kind 只有 `reclaim/harvest/dispatch/block/triage`；`tick-run.ts` 的 switch 同样五个 |
| C | **fleet 只有一条 pipeline** | `fleet.yaml.tpl` 全文只有 `- label: tick` |
| D | **`src/export.ts` 零 importer**；`EXPORT_ROOT` 无运行时消费者 | `grep -rn EXPORT_ROOT bin/ src/ workflows/` 只命中 `bin` 的 export 与测试文件 |

⇒ **`runGenerate` 本身是完整的**（`generate.ts:348-424` 已编排 debater×3 → writeDoc → synthesizer(lock) → anchor-check → report doc → export），
**但生产里没有任何一条边指向它** ⇒ plan §0 的产物 1（report）与 2（导出件）**都产不出**。

> **判据（本线已记）**：**「模块写好了」与「生产会调用它」是两条独立命题。**
> 单元测试全绿、`git log` 有合入记录，**都不构成可达性证据**。

---

## 1　要做什么

### 1.1 触发边

生产 `--run` 在本轮决策执行完、拿到 G4b 的 `TerminationState` 之后：
`decideGenerate(term)` 为真 ⇒ 调用 `runGenerate(deps, cfg)`。

⛔ **`decideGenerate` 已是交付好的纯函数**（`generate.ts:83`：`term.state !== null`），**调用它，不要另判一套**。
⛔ **幂等**：同一次研究的终态可能被多个 tick 观察到 ⇒ **必须保证生成段只跑一次**
（`writeDoc` 的 idempotencyKey 已按 `dr-doc:<role>:<origin>` 构造，但**导出与 spawn 的重复执行不受它保护**）。
本包必须给出一个明确的一次性保证机制并断言它。

### 1.2 十个 deps 的真实实现

`GenerateDeps`（`generate.ts:306-338`）的每一项都要有生产实现。**已有的东西一律复用，别重写**：

| dep | 怎么实现 |
|---|---|
| `readTermination` | G4b 已让 `--run` 算出 `TerminationState`，直接用 |
| `countBlocked` | 板面里 `status === "blocked"` 的卡数（`tick.ts:370` 已有同款算法） |
| `readQuestion` | G4a(v2) 的 `--question` |
| `readOrigin` | 本次研究 id。**取值来源必须显式且稳定**（同一次研究的多个 tick 必须得到同一个 origin，否则 `writeDoc` 的幂等键失效） |
| `readEvidences` | 从 evidence channel 回读（`--evidence-channel` 已贯通）；字段 `anchor/quote/claim/clue_id` |
| `spawnRuntime` | 复用 `tick-run.ts` 里派 worker/triage 用的那套 `agent-run` 运行时 |
| `writeDoc` | 发 `research.doc.v2`；`src/bus.ts` 已有发布原语，照 `publishClue`/`publishEvidence` 的形状加 |
| `lockSynthesizer` | 单例 lock，**wait-then-run，不是拿不到就跳过**（`generate.ts:333-337` 注释已写死语义） |
| `spawnExport` | 见 §1.3 |
| `spawnAnchorCheck` | ⚠️ 见 §1.4 —— **本包不接真实实现** |

### 1.3 ⛔ 导出：先修一个 dep 形状缺陷

`generate.ts:331` 的签名是 `spawnExport(body: string): Promise<void>` ——
**它拿不到 `source_message_id`**，而 plan §0 产物 2 硬要求导出件带 `source_message_id`。
上游 `writeDoc` 在它之前发出了 report doc，**但 `writeDoc` 返回 `void`，message id 被丢弃**。

⇒ **本包必须修这个形状**（改 `runGenerate` 的 dep 契约属本包范围，因为本包正是它的接线方）：
让 `writeDoc` 返回发布出的 message id，并把它传给导出。

导出实现复用 `src/export.ts` 的既有形状（`deriveExportPath` / `renderExportContent`），
落点 `<EXPORT_ROOT>/DeepThought/<主题-slug>/`（D1 已确立，**源码不得硬编码 vault 路径**）。
⛔ `EXPORT_ROOT` 未配置 ⇒ **响亮失败**，不得静默跳过导出（静默跳过 = 产物 2 消失且没人知道）。

### 1.4 ⚠️ anchor-check 本包**不接**，但必须是「可观测的未接线」

`generate.ts:414-421` 已经设计好：`spawnAnchorCheck` 抛错 ⇒ `anchorRate` 保持 `null` ⇒
`renderReportHead` 在报告头部标 **`unavailable`**（而不是伪装成 0%）。

⇒ 本包的 `spawnAnchorCheck` 实现**必须抛一个专有且响亮的错误**（如 `AnchorCheckNotWiredError`），
使报告头部如实标 `unavailable`。
⛔ **不得**返回一个编造的核验率（那会让软闸门判据凭空出现）；
⛔ **不得**静默返回 0（`0%` 与 `unavailable` 是两件事，既有代码明确区分）。
真实接线归 **G4d**。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **U1** | ⭐ **可达性**：从**生产入口**（`tick-entry --run`）出发，终态非 null 时 `runGenerate` **真的被调用**；终态为 null 时**不被调用** | 正反两例；⛔ 断言「函数存在」或「决策为真」**不算数** |
| **U2** | ⛔ **只跑一次**：同一次研究的终态被**连续两个 tick** 观察到时，生成段**只执行一次**（spawn 次数、writeDoc 次数、导出次数都不翻倍） | 判别性用例；这是 §1.1 幂等要求的唯一执行点 |
| **U3** | ⛔ **导出件带 `source_message_id`**，且该值 **等于 report doc 实际发布出的 message id**（不是编造、不是空串） | 断言两者相等；⛔ 只断言「字段存在」不算数 |
| **U4** | ⛔ **导出落点** = `<EXPORT_ROOT>/DeepThought/<主题-slug>/…`，且 `EXPORT_ROOT` 未配置 ⇒ **响亮失败** | 正反两例；grep 源码无硬编码 vault 路径 |
| **U5** | ⛔ **anchor-check 未接线时头部标 `unavailable`**，⛔ **不得**出现编造的核验率、⛔ **不得**是 `0%` | 断言头部字面；`0%` 与 `unavailable` 必须可区分 |
| **U6** | 串行边保持：`synthesizer` 并发 = 1、**绝不跳过 synthesizer**、导出在最后 | 既有断言保留且仍有效（读到行号） |
| **U7** | `doc_kind` 仍由 role 推出（debater ⇒ `argument`，synthesizer ⇒ `report`），**不读 payload** | 既有判别性用例保留 |
| **U8** | 全量 `npx vitest run` 全绿，文件数/用例数不少于**基线（以 G4b 合入后的 main 实测为准，自己先跑一次记下来）** | 贴基线与终值 |
| **U9** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **U10** | `src/`、`test/`、`workflows/` 的每处删除给出必要性说明 | — |

> ⚠️ **本包不要求端到端真跑真 bus**：`dr-doc.result.v1` 在派发方完成注册前真发会 422。
> 验收全部落在「接线可判别」上。⛔ **不得为让真跑通过而去注册协议。**

---

## 3　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **T1** | 去掉生产里对 `runGenerate` 的调用（回到改动前） | **U1 的正例必须挂**；⛔ 杀不掉即判 U1 零功率 |
| **T2** | 去掉一次性保证（每个 tick 都跑生成段） | **U2 必须挂** |
| **T3** | 让导出的 `source_message_id` 用一个常量/空串而非真实 message id | **U3 必须挂** |
| **T4** | 让 `spawnAnchorCheck` 返回 `{defects:0, verificationRate:0}` 而不是抛错 | **U5 必须挂**（`unavailable` 变成 `0%`） |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 4　显式不做

| 不做 | 理由 |
|---|---|
| anchor-check 真实接线（引入 `tools/anchor-check.py`、改成确定性子进程、报告落盘） | 归 **G4d**。本包只保证「未接线」是**可观测**的 |
| 播种入口 | 归 **G4e** |
| 改 `profiles/deploy/*.env` 的 channel 取值 | 归 **D2** |
| 改 `runGenerate` 的**编排顺序**或串行边语义 | 它是已交付且被断言保护的；本包只接线 + 修 §1.3 那一处 dep 形状 |
| 注册任何 bus 协议 | 不可逆，走公示流程 |
| 改 `agent-runtime` | 不同仓 |
| 端到端真跑真 bus | 协议未注册，真发必 422；留 Phase 6 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 5　交付物落点

- 实现：`src/tick-run.ts`（触发边 + deps 组装 + 一次性保证）、`src/generate.ts`（仅 §1.3 的 dep 契约）、
  `src/export.ts`（生产写入，若需要）、`src/bus.ts`（发布 `research.doc.v2` 的原语，若需要）
- 测试：`test/g4c-generate-wiring.test.ts`（U1–U7）
- 证据：`docs/dev-notes/dev_ledr_g4c_generate_wiring_01.md`（U1–U10 逐条 + §3 变异四行 + 还原证据）

> **dev-note 的 `input_commit` 记本次 implement attempt 的 input_commit**（该字段本来的语义）。
> 真正的要求是**正文描述交付物本身**：测试文件数/用例数、变异矩阵各行实测结果、最终代码行为必须与交付一致；
> 若中途 rework 改了实现，正文数字与结论同步更新。⛔ **不要为对齐 commit hash 做额外提交。**
