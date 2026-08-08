# G2a —— 生成段接线：把 S4 的占位 spawn 接到真实 R2 role

> 上游依据：`wf-dc0c15` `spec.md`(rev7) §1 / §3.2 第 7 步 / §5.5 / §6、`wf-ecf9fc` `design.md`。
> 前置已合入 `agent-runtime` main `efa7579`：`dr-triage`、`dr-synthesizer`、`dr-debater-{advocate,opponent,judge}` 五个 role 全部就位。
> 本仓前置：`ee4a1e3`（G1 已合）。

---

## 0　现状：S4 只有编排，没有接线

`src/generate.ts` 的 `GenerateDeps` 是这样的：

```ts
spawnDebater(route: string): Promise<void>;
spawnSynthesizer(route: string): Promise<void>;
```

**它只收一个 route 字符串**，不带 role、不带证据、不收结果。
`DEFAULT_GENERATE_CONFIG` 里的 `debaterRoutes: ["debater.pro","debater.con","debater.judge"]`、
`synthesizerRoute: "synthesizer"` **是占位符，不是真实 route**。

⇒ **生成段至今 0 次真跑。** 本包就是把这一段接上。

---

## 1　⛔ 两条必须照做的运行时事实（前三包各付过一次学费，别再踩）

### 1.1 `--input` **只校验、不注入 prompt**，内容必须走位置参数

| 位置 | 事实 |
|---|---|
| `agent-runtime/src/dispatch.ts:1107-1108` | `prompt = personaContent + "\n\n" + prompt` —— prompt **只**由 persona + **位置参数**构成 |
| `agent-runtime/src/dispatch.ts:922` | `--input` 的唯一用途是 `validateJsonSchema(...)` —— **校验完就扔，从不注入 prompt** |
| 本仓 `src/tick-run.ts:694` | `args.push("--input", inputPath, "--", clueText)` —— worker 能拿到线索**靠的就是位置参数** |

⇒ **生成段三类角色的语料（证据集合 / 论辩稿）必须由引擎序列化后放进位置参数**，
`--input` 只作 schema 守卫。**这条不做，生成段全部角色会交回空结果，且长得像「模型不会干活」**
（R2a 第一版就是这么死的：3 条 clue 进去，`decisions: []` 出来）。

### 1.2 `doc_kind` **必须由引擎从「派的是哪个 role」推出，绝不读 payload**

`dr-doc.result.v1` 的 payload 只有 `{body, digest?}`，**没有 `doc_kind` 字段**。
⚠️ 且实测：该 schema **没有** `additionalProperties: false`，而 bus 注册时 `openSchema()` 还会**剥掉闭包**
⇒ **schema 层拦不住多余字段**。派发方已就此发过公开更正。

⇒ **「debater 产不出 report」这条保护的唯一执行点就在本包**：
`dr-synthesizer` → `doc_kind: "report"`；`dr-debater-*` → `doc_kind: "argument"`。
⛔ **不得从 payload 里读 `doc_kind`**，哪怕它存在。

---

## 2　要做什么

### 2.1 `GenerateDeps` 改为按 role 派发并回收产物

把 `spawnDebater(route)` / `spawnSynthesizer(route)` 换成能表达「派哪个 role、喂什么语料、拿回什么」的形状。
建议（**实现方可调整命名，但三件事必须齐**：role、语料、返回 body）：

```ts
spawnDebater(role: string, route: string, corpus: DebaterCorpus): Promise<{ body: string }>;
spawnSynthesizer(role: string, route: string, corpus: SynthesizerCorpus): Promise<{ body: string }>;
```

`GenerateConfig` 的占位符换成真实值（**以 `agent-runtime/profiles/routes.yaml` 与 `profiles/roles/` 的实际内容为准，别照本文猜**）：

| 角色 | role | route |
|---|---|---|
| debater 立论 | `dr-debater-advocate` | `opus-4-8/ccs` |
| debater 反方 | `dr-debater-opponent` | `gpt-5.6-sol/ccs` |
| debater 裁判 | `dr-debater-judge` | `ds-v4-pro/ccs` |
| synthesizer | `dr-synthesizer` | `opus-5/ccs` |

⛔ 三条 debater route **必须互不相同**（`assertDistinctDebaterRoutes()` 已在，保留它）。
⛔ **不新增 opus native 直连用量**。

### 2.2 语料组装（引擎侧确定性代码）

- **debater 语料** = `{question, evidences[]}`，`evidences` 从 evidence channel 读回（`anchor`/`quote`/`claim`/`clue_id`）。
  judge 的语料额外带 `prior_arguments`（advocate 与 opponent 的 body）。
- **synthesizer 语料** = `{question, evidences[], arguments[], terminal_marker}`，
  `terminal_marker` 用**已有的** `buildReportMarker()` 产出（⛔ 不要重造）。
- 序列化后**放进位置参数**（§1.1）。

### 2.3 产物回写

每个角色返回的 `body` → 发一条 `research.doc.v2`：
- `doc_kind`：**由 role 推出**（§1.2）
- `origin`：本次研究 id
- `body`：原样透传，⛔ **> 4MB 报错拒绝**（`spec` §5.3）
- `digest`：缺省由引擎按 body 计算

synthesizer 的 report 还要把**终态标记行 + anchor-check 核验率**写进 body 头部
（核验率来自 `spawnAnchorCheck` 的返回；**软闸门**：核验率 < 90% **不阻断导出**，但必须**标在报告头部**）。

### 2.4 串行边保持不变

`debater ×3（可并行）→ synthesizer（单例 lock）→ anchor-check → 导出`。
⛔ **不得跳过 synthesizer**、⛔ **synthesizer 任一时刻并发 = 1**（现有断言保留）。

---

## 3　硬验收（gate 逐条核，缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **D1** | ⛔ **存在一条用例：从生产入口出发，断言角色 prompt 里真的出现了语料内容**——不是断言「`--input` 被传了」，而是**断言序列化后的证据文本出现在位置参数里** | 用假 `agent-run` 记录 argv，断言某条 evidence 的 `anchor` 字面出现在**位置参数**中；⛔ 只断言 `--input` 存在**不算数** |
| **D2** | ⛔ **`doc_kind` 由 role 推出的判别性用例**：构造一个 payload 里带 `doc_kind: "report"` 的 **debater** 返回值，断言引擎发出的 `research.doc.v2` 的 `doc_kind` **仍是 `argument`** | 该用例是 §1.2 保护的**唯一执行点**，必须能杀 |
| D3 | 三条 debater route 互不相同的断言保留且仍有效；四个角色的 role/route 与 `agent-runtime` 实际文件一致 | 读配置到行号 |
| D4 | 串行边：`synthesizer` 并发 = 1 断言保留；**绝不跳过 synthesizer** 的断言保留 | 读用例到行号 |
| D5 | 4MB 护栏**正反两个用例**（4MB-1 通过 / 4MB+1 拒绝） | 一个永远红或永远绿的检查等于没有检查 |
| D6 | 报告 body 头部**同时**含终态标记与 anchor-check 核验率；核验率 < 90% 时**仍导出**（软闸门）且头部标注 | 正反两个用例（<90% 与 ≥90%） |
| D7 | 全量 `npx vitest run` 全绿，**文件数与用例数均不少于基线 17 / 305** | 贴输出 |
| D8 | 变异矩阵（见 §4）逐断言归因，回显被改行，全部还原后 `git status --porcelain` 为空 | 贴证据 |
| D9 | 交付**只加/改本仓代码与测试**；⛔ **不碰 `agent-runtime`**（不同仓） | `git diff --stat` |

> ⚠️ **本包不要求端到端真跑真 bus**。理由：`dr-triage.result.v1` / `dr-doc.result.v1` **尚未注册**
> （注册在异议窗口结束后由派发方执行），真发会 422。
> **本包的验收全部落在「接线可判别」上**，真跑留给 Phase 6。
> ⛔ **不得为让真跑通过而去注册协议。**

---

## 4　变异矩阵（逐断言归因，不得只报 N/N）

| 变异 | 改什么 | 期望被杀的断言（点名） |
|---|---|---|
| **M1** | 把语料从**位置参数**挪回只传 `--input`（即删掉位置参数里的语料） | **D1 必须挂**。⛔ 若 D1 杀不掉 M1，说明 D1 只是在断言 `--input` 存在，是零功率，必须重写 |
| **M2** | 让 `doc_kind` 改从 payload 读（`payload.doc_kind ?? 由 role 推`） | **D2 必须挂** |
| **M3** | 去掉 4MB 上限判断 | D5 的**拒绝侧**用例必须挂（通过侧不受影响——这正是为什么要正反两例） |

**纪律**（`wf-dc0c15/plan.md` §6）：变异功率逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 5　显式不做（越界即超出 scope）

| 不做 | 理由 |
|---|---|
| **triage 的 spawn 接线** | `tick-run.ts:471-472` 明写「本包不处理 triage 的 spawn 副作用」——那是**另一处接线缺口**，归 **G2b**，本包不碰。塞进来会重演 A10「一包三项」被拆的教训 |
| 注册任何 bus 协议 | 不可逆，走公示流程，由派发方在异议窗口后执行 |
| 改 `agent-runtime` | 不同仓。若发现 role/persona 需要改，**停下并在 review 里说明**，不要跨仓改 |
| 端到端真跑真 bus | 协议未注册，真发必 422；留给 Phase 6 |
| 改 `bin/deep-research-loop.sh` 的部署配置 | 归 D1 包（部署固化） |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 6　交付物落点

- 实现：`src/generate.ts`（deps 形状 + config 真实值 + doc_kind 推出 + 头部渲染）、
  以及产物回写所需的最小改动（`src/bus.ts` / `src/export.ts` 视实现需要）
- 测试：`test/generate.test.ts` 扩充（D1–D6）
- 证据：`docs/dev-notes/dev_ledr_g2a_generate_wiring_01.md`（D1–D9 逐条 + §4 变异矩阵三行 + 还原证据）
