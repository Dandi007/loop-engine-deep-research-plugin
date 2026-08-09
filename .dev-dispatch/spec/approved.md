# G4c(v2) —— 生成段接进生产：`runGenerate` 至今**零调用者**

> 派发方：`line-deep-research`。**这是已核实的生产缺陷，不是加功能。**
> 前置：G4a(v2) + G4b(v3) 均已合入 main `f655317`。
>
> ⚠️ **这是重开包。上一个 development（`dev_ledr_g4c_generate_wiring_01`，PR #38）跑了 5 个 attempt，
> attempt 5 的 final review 判 APPROVE，但 dd 的 acceptance 阶段 `npm test` 返回 `exit_code 1` ⇒ 判 FAILED。**
> **那 5 轮的全部 finding 与已验证正确的解法形状，已前置写进本 spec 的 §2–§4。⛔ 照做，不要重新发现一遍。**
>
> ### ⛔ 本包最该记住的一条：**评审判过 ≠ 命令跑过。**
> attempt 5 的 final review 没有 finding，而同一份代码上 `npm test` 是红的。
> **验收命令必须由你自己真的跑一遍并贴出完整尾部输出。**

---

## 0　已核实的事实（grep 到行号，非推断）

| # | 事实 | 证据 |
|---|---|---|
| A | **`runGenerate` 在 `src/` 内零调用者** | `grep -rn 'from "./generate"' src/` 只命中 `src/export.ts:14`，且只取两个纯函数 |
| B | tick 决策集里没有 generate | `tick.ts` 的 kind 只有 `reclaim/harvest/dispatch/block/triage` |
| C | fleet 只有一条 pipeline | `fleet.yaml.tpl` 全文只有 `- label: tick` |
| D | `src/export.ts` 零 importer；`EXPORT_ROOT` 无运行时消费者 | `grep -rn EXPORT_ROOT bin/ src/ workflows/` |

⇒ `runGenerate`（`generate.ts:348-424`）本身完整，**但生产里没有任何一条边指向它**
⇒ plan §0 的产物 1（report）与 2（导出件）**都产不出**。

> **判据**：**「模块写好了」与「生产会调用它」是两条独立命题。** 单测全绿、`git log` 有合入记录，**都不构成可达性证据**。

---

## 1　要做什么（总述）

生产 `--run` 在本轮决策执行完、拿到 G4b 的 `TerminationState` 之后：
`decideGenerate(term)` 为真 ⇒ 调用 `runGenerate(deps, cfg)`。

⛔ `decideGenerate` 已是交付好的纯函数（`generate.ts:83`），**调用它，不要另判一套**。

---

## 2　⛔ 前置给你的解法形状（上一轮已验证正确，照做）

以下每一条都是上一轮 5 个 attempt **被评审逐条打回后最终收敛的正确形状**。⛔ 不要另起炉灶。

### 2.1 `spawnRole` 的 `readBody` —— **读 `dr-doc.result.v1`，不是 `worker.result.v1`**

⛔ **上一轮在这里连挂两轮**。两个坑：

1. **快照坑**：不得用 `findWorkerResult(runId, runsMessages)` —— `runsMessages` 是 spawn **之前**读的
   `board:agent-runs` 快照（普通数组，不重读不变更），而 `runId` 是 spawn 时才生成的
   ⇒ 确定性落空。**必须每次重新分页读 channel。**
2. **形状坑**：`WorkerResultV1` 的冻结形状是 `{run_id, evidences, proposed_clues, materials}`
   （`harvest.ts:48-53`）—— **没有 `body` 字段**。生成角色产出的是 **`dr-doc.result.v1`**。

**正确形状**（上一轮 attempt 5 交付、final review 判过）：在 `src/tick-inspect.ts` 加

```ts
export async function readGenerateResult(
  runId: string, channelId = "board:agent-runs",
): Promise<{ body: string } | null> {
  const messages = await readChannelMessages(channelId);   // ⛔ 每次重读
  return findGenerateResult(runId, messages);              // 过滤 kind === "dr-doc.result.v1"
}
```

`readBody` 用它 + **重试等待**（spawn 是异步的，结果不会立刻在 channel 上；上一轮用 30 次 × 1s）。

### 2.2 一次性保证 —— **跨进程 + 成功之后才标记**

⛔ **上一轮在这里也连挂两轮**：

1. **进程内状态无效**：每个 tick 都是全新进程（`tick.md` 每轮 `exec node … tick-entry.ts`），
   模块级 `Set` 每轮都是空的 ⇒ **完全不覆盖 spec 要求的威胁模型**。必须有**跨进程持久**载体。
2. **先标记后执行 = 把响亮失败变成永久静默跳过**：若在 `runGenerate` **之前**标记且不回滚，
   任何失败都把标记留下 ⇒ 首个 tick 响亮失败退出、fleet 退回 claim、其后每个 tick 都看到标记 ⇒
   **永远静默跳过**。⛔ **标记必须在 `runGenerate` 成功返回之后才写。**

标记 key 必须同时含 **origin 与 channelId**（只用 origin 会让不同研究互相污染）。

### 2.3 导出 —— 三个已知坑

1. ⛔ **必须 `mkdirSync(dirname(path), { recursive: true })`**：`src/` 全仓原无 `mkdir`，
   首次真导出必 ENOENT，且抛在 doc **已发进 append-only bus 之后**。
2. ⛔ **`createdAt` 取 bus `created_at`，绝不落回系统时钟**：`export.ts:11/:22` 是硬不变量
   （`deriveExportPath` 把该日期放进文件名，导出必须同输入⇒同字节可重生成）。
   回读不到该 message ⇒ **响亮失败**，⛔ 不得 `?? new Date().toISOString()`。
3. ⛔ `EXPORT_ROOT` 未配置 ⇒ **响亮失败**，不得静默跳过。

### 2.4 dep 形状缺陷：`spawnExport` 拿不到 `source_message_id`

`generate.ts:331` 是 `spawnExport(body: string): Promise<void>`，而 plan §0 产物 2 硬要求导出件带
`source_message_id`；上游 `writeDoc` 返回 `void`，message id 被丢弃。
⇒ **本包必须修这个契约**：`writeDoc` 返回发布出的 message id，并传给导出。

### 2.5 `--origin` / `--doc-channel` 必须**从 bin 一路贯通到 argv**

⛔ **上一轮在这里挂了一轮**：触发边挂在 `origin && …` 上，而 `tick.md` / `fleet.yaml.tpl` /
`workflow.yaml` / `bin/` **全都不供给 `--origin`** ⇒ 生成段从生产入口**静默地永不进入**。
这正是 G4a 那个包存在的理由的原样复发（「CLI 支持、引擎依赖、生产不传」）。

照 `MAX_WRITES` / `RESEARCH_QUESTION` 已走通的同一条链接：
`bin/deep-research-loop.sh` → `fleet.yaml.tpl` → `tick/workflow.yaml` → `tick.md` → `tick-entry --run`。

### 2.6 ⭐⭐ `workflow.yaml` 里新增的可选输入**必须带 `?` 标记**

⛔ **上一轮就死在这一个字符上**（dd acceptance `npm test` exit 1 ⇒ development FAILED）。

`workflows/deep-research/tick/workflow.yaml` 既有的可选输入写法是：

```yaml
      evidence_channel: "{{evidence_channel?}}"
      allowed_root: "{{allowed_root?}}"
```

上一轮新增的写成了 `doc_channel: "{{doc_channel}}"`（**无 `?`**）⇒ `DOC_CHANNEL` 为空时
（**当前所有 deploy profile 的默认值**）模板按必填渲染 ⇒ **tick 节点报错**。

**派发方实测的因果证据**：`DOC_CHANNEL` 空 ⇒ `test/a10b-convergence.test.ts` 的 **B2** 连挂 3/3；
`DOC_CHANNEL` 给值 ⇒ 同文件 12/12 全绿。

**⛔ 放大器比 bug 本身更严重**：
`loop-events.jsonl` 记 `{"kind":"round_end","detail":{"ticked":["tick"],"errors":1}}`，
而同目录 `drain.json` 记 `{"reason":"drained"}` 且脚本 **exit 0**
⇒ **每个 tick 都在报错，而从外面看是一次干净的收敛。**

⇒ **本包新增的每一个可选 pipeline input 都必须带 `?`，并且必须在 `DOC_CHANNEL` / `RESEARCH_ORIGIN`
未设置的干净环境下跑通全量测试。**

### 2.7 `writeDoc` 的目标 channel

⛔ 不得静默默认到板 channel（`research.doc.v2` 发进 clue 板是 append-only 不可回退的错误落点）。
无 `--doc-channel` ⇒ **响亮失败**。

### 2.8 anchor-check 本包**不接**，但必须是「可观测的未接线」

`generate.ts:414-421` 已设计好：`spawnAnchorCheck` 抛错 ⇒ `anchorRate` 保持 `null` ⇒
`renderReportHead` 头部标 **`unavailable`**。
⇒ 本包的生产实现**必须抛一个专有且响亮的错误**（如 `AnchorCheckNotWiredError`）。
⛔ 不得返回编造的核验率；⛔ 不得静默返回 0（`0%` 与 `unavailable` 是两件事）。真实接线归 **G4d**。

### 2.9 `lockSynthesizer` 必须是**真的单例锁**

⛔ 上一轮交付过一个 no-op 桩（只翻转一个局部 boolean，不获取、不等待、不排他）。
`generate.ts:344-349` 的语义是**单例 lock，wait-then-run，不是拿不到就跳过**。

---

## 3　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **U1** | ⭐ **可达性**：从**生产入口**（`runChannelWrite`）出发，终态非 null + origin 已配置 ⇒ `runGenerate` **真的被调用**（注入假 deps，断言 spy 被调用）；终态为 null ⇒ **不被调用** | 正反两例。⛔ **`expect(source).toContain(...)` 这类源码字符串搜索一律不算数**（上一轮 attempt 1 就死在这个形状上） |
| **U2** | ⛔ **只跑一次**：同一 origin 连续两次 `runChannelWrite` ⇒ 生成段只执行一次（spawn / writeDoc / 导出次数都不翻倍）；且**跨进程那一半必须被判别**（内存 Set 若先命中，文件标记分支就从不决策 ⇒ 该用例零功率）| 判别性用例；⛔ 必须能杀掉「删掉文件标记读写、只留内存 Set」这个变异 |
| **U3** | ⛔ **失败不留标记**：`runGenerate` 抛错 ⇒ 标记**未被写入**，下一个 tick 仍会重试 | 判别性用例 |
| **U4** | ⛔ 导出件带 `source_message_id`，且**等于 report doc 实际发布出的 message id** | 断言两者相等；⛔ 只断言字段存在不算数 |
| **U5** | ⛔ 导出落点 `<EXPORT_ROOT>/DeepThought/<主题-slug>/…`；`EXPORT_ROOT` 未配置 ⇒ **响亮失败**；父目录自动创建 | 正反两例 + grep 源码无硬编码 vault 路径 |
| **U6** | ⛔ `createdAt` 取自 bus `created_at`；回读不到 ⇒ **响亮失败**，grep 生产路径无 `new Date()` 兜底 | 判别性用例 + 读到行号 |
| **U7** | ⛔ **anchor-check 未接线 ⇒ 头部标 `unavailable`**，不得是编造值、不得是 `0%`。**且该断言必须打在生产组装出的 dep 上**（把生产默认改成返回 `{defects:0,verificationRate:0}` 必须被杀） | ⛔ 上一轮此条零功率：所有用例都自建 `GenerateDeps` 注入自己的 stub，生产默认从未被执行 |
| **U8** | ⛔ **`--origin` 与 `--doc-channel` 各有一条 argv 记录用例**：渲染 `tick.md` + 假 `tick-entry`，断言 flag **及其值**出现在 argv | 照 `test/g4a-question-wiring.test.ts:124-143/177-199`；⛔ 字符串包含不算数 |
| **U9** | ⛔ **值缺省 ⇒ 不出现该 flag**（不是空串参数） | 正反两例 |
| **U10** | ⭐ **全量 `npx vitest run` 真的全绿**，且**在 `DOC_CHANNEL` / `RESEARCH_ORIGIN` 均未设置的干净环境下** | ⛔ **必须实跑并贴完整尾部输出**（`Test Files` / `Tests` 两行 + 有无 FAIL 段）。基线：main `f655317` 实测 **21 files / 391 tests**；终值两项均不得低于基线。⛔ 不得用「基线计数方式差异」解释缺口 —— 同一条命令，口径可比 |
| **U11** | `synthesizer` 并发 = 1 且**绝不跳过**；导出在最后；`doc_kind` 由 role 推出（不读 payload） | 既有断言保留且仍有效（读到行号） |
| **U12** | 变异矩阵（§4）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **U13** | 每处删除给出必要性说明 | — |

> ⚠️ **本包不要求端到端真跑真 bus**：`dr-doc.result.v1` 的注册由派发方处置。验收全部落在「接线可判别」上。

---

## 4　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **T1** | 去掉生产里对 `runGenerate` 的调用 | **U1 正例必须挂**；⛔ 杀不掉即判 U1 零功率 |
| **T2** | 去掉跨进程文件标记，只留内存 Set | **U2 必须挂** |
| **T3** | 把标记移到 `runGenerate` **之前** | **U3 必须挂** |
| **T4** | 导出的 `source_message_id` 用常量/空串 | **U4 必须挂** |
| **T5** | 生产 `spawnAnchorCheck` 改成返回 `{defects:0, verificationRate:0}` | **U7 必须挂**；⛔ 杀不掉即判 U7 零功率 |
| **T6** | `workflow.yaml` 的新增可选输入去掉 `?` | **U10 全量必须变红** |
| **T7** | `createdAt` 恢复 `?? new Date().toISOString()` 兜底 | **U6 必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| anchor-check 真实接线（引入 `tools/anchor-check.py`、确定性子进程、报告落盘） | 归 **G4d**；本包只保证「未接线」**可观测** |
| 播种入口 | 归 **G4e** |
| 改 `profiles/deploy/*.env` 的取值（含 `DOC_CHANNEL` 该填什么） | 归 **D2**。本包只保证**它为空时不炸** |
| 改 `runGenerate` 的编排顺序或串行边语义 | 已交付且被断言保护；本包只接线 + 修 §2.4 那一处 dep 契约 |
| 一次性标记改成 bus 侧/run-root 作用域、`lockSynthesizer` 陈旧锁回收 | 已记为独立 finding，归后续包；⛔ 本包不扩面 |
| 注册任何 bus 协议 | 不可逆，走公示流程 |
| 改 `agent-runtime` / katana | 不同仓 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 6　交付物落点

- 实现：`src/tick-run.ts`（触发边 + deps 组装 + 一次性保证）、`src/tick-inspect.ts`（`readGenerateResult`）、
  `src/generate.ts`（仅 §2.4 的 dep 契约）、`src/export.ts`、`src/bus.ts`（如需）、
  `bin/deep-research-loop.sh`、`workflows/deep-research/fleet.yaml.tpl`、
  `workflows/deep-research/tick/workflow.yaml`、`workflows/deep-research/tick/templates/tick.md`
- 测试：`test/g4c-generate-wiring.test.ts`（U1–U9、U11）
- 证据：`docs/dev-notes/dev_ledr_g4cv2_generate_wiring_01.md`（U1–U13 逐条 + §4 变异七行 + 还原证据）

> **dev-note 的 `input_commit` 记本次 implement attempt 的 input_commit**（该字段本来的语义）。
> 真正的要求是**正文描述交付物本身**：测试文件数/用例数、变异矩阵各行**实测**结果、最终代码行为必须与交付一致；
> 若中途 rework 改了实现，正文数字与结论同步更新。
> ⛔ **不要为对齐 commit hash 做额外提交。**
