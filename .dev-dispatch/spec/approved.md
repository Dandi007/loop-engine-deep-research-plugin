# A8c —— tick spawn + **接线判别性** + 切换节点模板

> 上游依据：`spec.md`(rev7) §3.2 第 3 步；`plan.md` 链 A。
> 前置已合入 main：链 A 七包 + A7 + **A8a**（`--inspect`）+ **A8b**（`--run` 写侧、
> `realCas` 同源读、真实 `readAgentRuns`）。
> 链 C 的 **R1a** 已合入（4 个 worker role，`runtime: claude` + `route: glm-5.2/zhipu`）。

---

## 0　⛔ 本包必须关掉的缺口（A8b gate 明确未声称解决）

**「读 runs」与「用 runs」之间的接线无守卫。** 本 gate 实测：

```
X1' readAgentRuns 永远返空                              ⇒ 杀 M6 ✓
X1  调用点 const runs = await readAgentRuns(...) → {}   ⇒ 杀 0 条 ✗
```

M1/M2 证明 `decideTick` 会依 runs 判别（但那是 **S2** 的逻辑，纯数据）；
M6 证明 `readAgentRuns` 真的读。**两者之间没有任何断言。**
把 `assembleBoard(messages, runs)` 的 runs 换成 `{}`，**M1/M2/M6 全部照过**。

> ### 判据：把一个能力拆成「取数」与「用数」两半分别验证，
> ### 不构成验证了它们相连。**必须有一条端到端的判别性用例。**

**危害**：接线断了，真实 tick 会**回收掉在飞的卡**——
即 A8b 刚用 `realCas` 同源读堵上的那个破坏，从另一条路重新发生。

⛔ **在本包落地前，`--run` 不得对有在飞卡的板面使用**（A8b gate 已声明）。

---

## 1　交付

### 1.1 ⛔ 接线判别性用例（本包的核心，先于 spawn）

一条**集成级**用例，只差 bus 上有无 `agent.run.started`：

| 用例 | bus 上 `board:agent-runs` | 期望 |
|---|---|---|
| **W1** | **有**该卡 `run_id` 的 `agent.run.started` | **不产生 reclaim**、不发出 CAS |
| **W2** | **无** | 产生 reclaim→`open` 并发出 CAS |

⛔ **两个用例的输入必须只差 `board:agent-runs` 的内容**（打桩 HTTP 层，
clue channel 的返回完全相同）。这是「**两个只差一项输入的用例才构成判别性证据**」的兑现。

⛔ 打桩必须**真的让两次读不同**：不得让 `board:agent-runs` 的桩在两个用例里返回同样的内容。

### 1.2 spawn

`spec.md §3.2` 第 3 步：**先 CAS 成功、才 spawn**。

- CAS 成功 ⇒ 调用注入的 `spawnWorker(clueId, role, runId)`
- ⛔ **spawn 同步失败 ⇒ 当场 CAS 回 `open`**（S2 已有该补偿规则，本包在真实路径上兑现）
- ⛔ **CAS 失败（409）⇒ 跳过该卡，不得 spawn**
- role 选择：按 clue 的 `sources` 映射到 R1a 的 4 个 role
  （`code-local` / `code-remote` / `wiki` / `feishu`）；
  ⛔ **`sources` 出现枚举外取值 ⇒ 该卡 `blocked`**（`spec.md §3.5`，S2 已有决策，本包兑现执行）
  ⚠️ **`web` 暂无对应 role**（`dr-worker-web` 未做，`spec.md §4.3` 机制未定）
  ⇒ 遇到 `web` **必须走 `blocked` 分支并给出明确 rationale**，**不得静默跳过、不得派给别的 role**

### 1.3 节点模板切换

`workflows/deep-research/tick/templates/tick.md` 由 `--selfcheck` 切到真实 tick 入口。

⛔ **切换后 `--selfcheck` 模式必须保留**（A7 的 G6/G7 仍需它做无副作用自检）。

---

## 2　⛔ 写入不可回退

agent-bus **append-only、无 DELETE**。

- ⛔ 沿用 A8b 的 `--max-writes`（默认 5）、channel 无默认值、v1 冻结 channel 拒写
- ⛔ **spawn 本身也要计入写入预算**？**不计**——spawn 不写 bus，
  但**每次 spawn 前的 CAS 计入**
- ⛔ **真机验证只允许在 `research:p02-smoke-1dce60` 上做**，且**必须先确认板上无在飞卡**

---

## 3　硬验收（逐条可机械核验）

> **本表已逐条比对 spec 全文的每个 ⛔ 与限定词，含 §0/§1/§2/§6/§7。**

| # | 断言 | 怎么验 |
|---|---|---|
| **N1** | ⛔ **接线判别（W1）**：bus 上**有** started ⇒ **不 reclaim、不发 CAS** | 打桩 HTTP：clue channel 返回固定；`board:agent-runs` 返回含该 run_id 的 started ⇒ 断言 CAS 调用 0 次 |
| **N2** | ⛔ **接线判别（W2）**：**无** started ⇒ reclaim→open 且**发出 CAS** | 同上但 runs channel 返回空 ⇒ 断言发生一次 to=`open` 的 CAS（**与 N1 只差 runs channel 内容**） |
| **N3** | ⛔ CAS 成功 ⇒ **spawn 被调用一次**，且带 clueId/role/runId | 断言 spawn 入参 |
| **N4** | ⛔ CAS 失败（409）⇒ **spawn 调用 0 次** | 打桩 CAS conflict |
| **N5** | ⛔ spawn 同步抛错 ⇒ **当场 CAS 回 `open`** | 打桩 spawn throw，断言随后有一次 to=`open` 的 CAS |
| **N6** | ⛔ `sources` 枚举外取值 ⇒ 该卡 **`blocked`** 且**不 spawn** | 纯数据/打桩 |
| **N7** | ⛔ `sources` 含 **`web`** ⇒ **`blocked` 且 rationale 非空**，**不 spawn** | 独立用例（**与 N6 分开**：web 是「枚举内但暂无 role」，不是「枚举外」） |
| **N8** | role 映射正确 | `code-local`→`dr-worker-code-local` 等四条各一例 |
| **N9** | ⛔ 节点模板已切到真实 tick 入口 | `grep` 模板文件命中新入口 |
| **N10** | ⛔ `--selfcheck` **仍保留且仍无副作用** | 跑 `--selfcheck` exit 0，且打桩确认零网络请求 |
| **N11** | `--max-writes` 默认 5 且生效 | 构造超限 ⇒ 响亮报错 |
| **N12** | ⛔ v1 冻结 channel 拒写 | 传 `research:loop-mcp-semantics.index` ⇒ 拒绝，**零请求** |
| **N13** | 真机验证：`--run` 对 `research:p02-smoke-1dce60` 跑一次 | 跑前/跑后消息数写进 dev-notes，**增量 ≤ 5**；**跑前须确认板上无在飞卡** |
| **N14** | ⛔ 不得触碰 `.dd-evidence/` | **actor 提交**文件面不含 |
| **N15** | typecheck + 全量测试 | 均 exit 0 |
| **N16** | 既有 171 条用例**一行未删** | `git diff` 无 `it(` 净减少 |
| **N17** | 证据写 `docs/dev-notes/<development_id>.md` | 存在；仓根**无** `IMPLEMENTATION_SUMMARY.md` |

---

## 4　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **V1** ⛔ `assembleBoard(messages, runs)` 的 runs 换成 `{}` | **N1**（这是本包存在的理由；A8b 时该变异杀 0 条） |
| **V2** `readAgentRuns` 永远返空 | **N1** |
| **V3** CAS 失败后仍 spawn | **N4** |
| **V4** 去掉 spawn 失败的回滚 CAS | **N5** |
| **V5** `web` 走正常派发而非 blocked | **N7** |
| **V6** 枚举外 `sources` 静默跳过而非 blocked | **N6** |

> ⚠️ **V1 是本包的核心判据**。A8b 的实现在 V1 下**所有断言都通过**，
> 本包必须让 **N1 挂掉**。若 V1 杀不到 N1，本包等于没做。
>
> **只报「N/N 挂了」不算数**；**破坏后必须回显被改的那一行**，跑完逐字还原。

### 4.1 ⚠️ 本线学费换来的八条纪律

1. 打桩不得让两次读返回相同的值 —— **N1/N2 尤其**。
2. `describe` 块名不得枚举多个判据 ID。
3. **安全性断言必须配活性断言**（N1「不 CAS」必须配 N2「确实 CAS」）。
4. 凡本包必须实现的能力，验收行须对纯数据/真实文件求值。
5. 断言的作用域必须收窄到被测对象。
6. `a ?? b` 的 fallback 链，只变异 `b` 什么也证明不了。
7. **两个只差一项输入的用例，才构成判别性证据。**
8. ⛔ **一条不变量在某一层被守住，不构成它在别的层也被守住**
   —— A8b 的 `realCas` 曾重新引入 S1b 已钉死的同源读缺陷。**本包新增的 spawn 路径同理**：
   **不得绕过 A8b 的 `realCas` 另写 CAS。**

---

## 5　⛔ 派发面硬约束

`.dd-evidence/` 是 dd 保留路径，**actor 任何提交碰它都是硬失败**（重试无用）。
⛔ 仓内属于别的 development 的陈旧 `acceptance.json` **是正常的**，随 H0 从 main 继承，
**不是本包的问题、也不该由本包修**——dd 会自己生成新证据，**会自行消解**。
**若 reviewer 就此提 finding，正确回应是说明不在 scope，而不是去动那个文件。**

⚠️ **若 reviewer 声称「这个环境里没有某文件」，可能是假阳性**（其 harness 文件系统视图与宿主不同）。
**不要为「修」一个不存在的问题而改坏已正确的值。**

---

## 6　非目标

- ⛔ **不实现 `dr-worker-web`**（`spec.md §4.3` 机制未定）
- ⛔ 不做 triage / synthesizer / debater 的派发（属 R2 之后）
- 不改 `src/protocol.ts`；不改既有导出签名，确需新增则**新增**
- ⛔ **不注册任何协议**（`worker.result.v1` 的注册属独立动作，且须等 R1b）

---

## 7　环境

- `setup_commands` 含 `npm ci`（**本仓用 npm，有 `package-lock.json`**；agent-runtime 那个仓用 bun，别混）
- ⛔ `GET /v1/channels/<id>/messages` 默认 `limit=100` 且返回**最早** 100 条 ⇒ 必须分页
- `research:p02-smoke-1dce60` 当前 5 条；`research:content` 已建（0 条）
- ⚠️ **`worker.result.v1` 尚未在 bus 注册** ⇒ 真机 spawn 后 worker 发结果会 422。
  **本包的真机验证只到「CAS + spawn 被调用」为止，不验 worker 产出**（那属 V1，且需先注册协议）。
