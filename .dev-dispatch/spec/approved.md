# A10c —— 写入预算在生产链路上不可达：真实卡永远收割不了

> 上游依据：`wf-dc0c15` `spec.md`(rev7) §3.2；**全部依据来自 2026-08-05 V1 首次真实端到端跑（真 bus、真 worker）。**
> 前置已合入 main：链 A 全部 + A7 + A8a–A8f + A9 + A10a + A10b。

---

## 0　实测：V1 真跑走到最后一步，卡在预算上

2026-08-05 18:52，第一次完整真实端到端（真 7490 bus、真 `agent-run` worker、
全程走 `bin/deep-research-loop.sh`，未手加任何参数）：

| 环节 | 结果 |
|---|---|
| seed 触发 → drain → tick | ✅ 16 ticks |
| tick 读真板面、认领 `open` 卡 | ✅ |
| CAS `open → in_flight` 带 `run_id` | ✅ **恰好 1 次写** |
| 真实 worker（`dr-worker-code-local` / `glm-5.2/zhipu`） | ✅ exit 0，168s，`conformance_retries: 0` |
| `worker.result.v1` 发布并通过校验 | ✅ `msg_01KZ8S03QJHH7QS6T2RSQ7KDGW`，**6 条 evidence，锚点齐备** |
| tick 决策 | ✅ `--inspect` 输出 `kind: "harvest"`，runId 正确 |
| **收割执行** | ❌ **整卡跳过** |
| 证据 channel | ❌ **0 条** |
| 收敛 | ❌ `max_rounds/16`，非 `drained` |

**`--run` 的逐字输出（生产 argv 形状，未加 `--max-writes`）**：
```json
"harvestReports": [{
  "skipped": true, "skippedReason": "budget", "budgetShortfall": 2,
  "evidencePublished": 0, "cluesPublished": 0, "casExplored": false
}],
"writes": 0, "hasPendingWork": true
```
needed = 6 evidence + 0 clue + **1 CAS** = **7**；budget = **5**；shortfall = **2**。

### 0.1 根因：`--max-writes` **在生产链路上根本没被传**

`workflows/deep-research/tick/templates/tick.md:23-29` 的四个分支：
```bash
"$tick_entry" --run "$tick_channel" --evidence-channel "$evidence_channel" --allowed-root "$allowed_root"
"$tick_entry" --run "$tick_channel" --evidence-channel "$evidence_channel"
"$tick_entry" --run "$tick_channel" --allowed-root "$allowed_root"
"$tick_entry" --run "$tick_channel"
```
**四条都没有 `--max-writes`。** CLI 支持该参数（`src/tick-entry.ts:41`），
但生产模板从不传 ⇒ 永远吃默认值 5（`src/tick-run.ts:44`）。

⇒ **任何 worker 产出 ≥5 条 evidence 的卡，在生产里永远收割不了**：
needed = evidences + clues + 1 ≥ 6 > 5 ⇒ 整卡跳过 ⇒ 卡永远 `in_flight`
⇒ `hasPendingWork` 恒 true ⇒ 每 tick 续投 ⇒ **永不 `drained`，恒 `max_rounds`**。

⚠️ 而**真实 worker 就是会产出 6~10 条**：本次 6 条；更早一次真跑 9 条、另一次 10 条。
⇒ **默认预算与真实产出量根本不匹配**，不是边界情况，是常态。

### 0.2 ⛔ 这是「接线」缺陷的第四次同形复现

本 folder 已记三次（A8c 的 `workerCmd`、A8d 的 `agent-run` 解析、A8e 的 evidence channel）：
**我规定了组件行为，没规定组件被接进生产链路。**
这次一模一样：CLI 支持 `--max-writes`，模板不传 ⇒ 单元测试全绿（它们直接传 `maxWrites`），
**只有真实端到端跑才暴露**。

> ### ⛔ 判据（写进本包验收）：凡组件支持而生产模板需要传的参数，
> ### 必须有一条**从 `bin/*.sh` 出发**的用例证明它**真的被传到了**，
> ### 而不只是「CLI 接受它」。

### 0.3 守卫本身是对的，不要改坏它
A8e 的 H13（预算不足 ⇒ 零发布、零 CAS、响亮报告）**行为完全正确**：
它拒绝半写，避免了「发了 3 条 evidence 就把卡置终态」这种不可回退的损坏。
⛔ **本包不得放宽该守卫**，只修「预算在生产里够不够、传没传」。

---

## 1　交付

### 1.1 ⛔ `--max-writes` 必须一路接到生产链路
`bin/deep-research-loop.sh` 导出 → fleet → workflow → `tick.md` → `tick-entry --run`。
⛔ 缺省值必须**足以收割一张真实卡**（真实产出实测 6~10 条 evidence）。
⛔ 显式覆盖（env）语义保留。

### 1.2 ⛔ 死锁必须可辨识，不能只报 `budget`
当前形态下，预算不足的卡**每 tick 重复跳过、永不前进**，而报告只说 `skippedReason: "budget"`
—— 与「这一轮恰好预算用完了、下一轮会好」**完全同形**。
⛔ 必须区分「本轮预算已被别的卡用掉」与「**该卡在当前预算下永远不可能被收割**」
（needed > maxWrites 本身，与本轮已用无关）后者是**配置错误**，必须响亮、必须可被上层识别。

### 1.3 ⛔ 写入预算的语义不变
仍是不可回退写的上限；v1 冻结 channel 拒写；证据 channel 无默认值。

---

## 2　硬验收

| # | 断言 | 怎么验 |
|---|---|---|
| **D1** | ⛔ **真实端到端**：`research:v1-tick-reclaim.index` 上那张卡（run `243d00ce`，已有 6 条 evidence 在 `board:agent-runs`）**被真的收割**：`research:v1-tick-reclaim.evidence` 出现 **6 条 `research.evidence.v2`**，卡 CAS 到 `explored` | 真跑；⛔ 不得打桩 bus。**这是本包不可替代的一条** |
| **D2** | ⛔ 同一次真跑跑完，drain 输出 **`reason === "drained"`** | 断言 JSON 字段 |
| **D3** | ⛔ `--max-writes` **从 `bin/deep-research-loop.sh` 一路传到 `tick-entry --run`**（四层各一条断言） | `bin` → fleet → workflow → `tick.md` 逐层 grep + 一条端到端用例证明**值真的到达** |
| **D4** | ⛔ 变异：把 `tick.md` 里的 `--max-writes` 去掉 ⇒ **D3 与 D1 必须挂** | 破坏后回显被改行，跑完还原 |
| **D5** | ⛔ `needed > maxWrites`（该卡在当前预算下**永不可收割**）⇒ 报告用**与「本轮预算耗尽」不同的可辨识标记**，且响亮 | 两例对照，**判别对** |
| **D6** | ⛔ 本轮预算被前面的卡用掉（needed ≤ maxWrites 但 remaining 不足）⇒ 仍报 `budget`、下一轮可继续 | 与 D5 只差一项输入 |
| **D7** | ⛔ A8e 的 H13 守卫仍成立：预算不足 ⇒ **零发布、零 CAS**、卡不置终态 | 原用例仍在且通过 |
| **D8** | ⛔ A10b 的 B1/B5/B6/B7a/B7b、A10a 的 C0–C4 仍成立 | 原用例仍在且通过 |
| **D9** | ⛔ `npm test` **连跑 5 次全绿** | 记录 5 个退出码；⛔ 读退出码时命令后不接管道 |
| **D10** | ⛔ 不触碰 `.dd-evidence/`；用例一条不删 | `git diff` |
| **D11** | typecheck + 全量测试 exit 0；证据写 `docs/dev-notes/<development_id>.md` | 仓根无 `IMPLEMENTATION_SUMMARY.md` |

### 2.1 ⛔ D1/D2 的执行约束（与以往不同，本包**必须**打真机）
- ⛔ **本包的 D1 必须在真实 7490 bus 上完成**，因为待收割的产物（run `243d00ce` 的 6 条 evidence）
  **已经在真实 `board:agent-runs` 上**，这是一次不可复制的真实语料。
- 允许写的 channel：**`research:v1-tick-reclaim.index`（板）与 `research:v1-tick-reclaim.evidence`（证据）**。
  ⚠️ 本包**解除**以往「不得写 `research:v1-*`」的限制 —— 那条限制的目的是保留干净板面给 V1 首跑，
  **而 V1 首跑已经发生（本 spec §0），该板面现在正是待完成的现场。**
- ⛔ 仍不得写任何冻结 channel（`research:loop-mcp-semantics.*` / `research:smoke-bus-semantics.*`）。
- 跑前跑后记录三个 channel 的消息数增量，写进 dev-notes。
- ⚠️ 预期增量：evidence channel **+6**，index channel **+1**（explored CAS）。

---

## 3　变异自检

| 变异 | 必须杀死 |
|---|---|
| **P1** `tick.md` 去掉 `--max-writes` | **D3 与 D1** |
| **P2** 缺省预算改回 5 | **D1**（6 条 evidence 的卡收割不了） |
| **P3** 把「永不可收割」也报成普通 `budget` | **D5**（与 D6 判别） |
| **P4** 预算不足时改成「发一部分再 CAS」 | **D7**（⛔ 半写是最坏形态，必须仍被拦） |

> **破坏后必须回显被改的那一行**，跑完逐字还原并 `git diff --stat` 确认干净。

### 3.1 变异纪律（本线各栽过一次）
1. ⛔ 必须语义合法（曾写错变量名 ⇒ 运行期错误炸整个模块，什么都没归因）。
2. ⛔ 必须命中语义位置（曾把正则打在类型声明上，运行器不做类型检查 ⇒ 全绿被误读成「实现对」）。
3. ⛔ 改次序必须真移动（曾只在前面**加**一次 CAS ⇒ 该挂的没挂）。
4. ⛔ **变异未命中时该次运行不构成证据**，必须回显 diff 确认命中（本 gate 今日刚栽过一次）。
5. ⚠️ **变异通过只证明「该断言有牙」，不证明「该设计正确」**
   —— A10b 的 `max_nodes: 2` 曾被变异"证明"正确，实则结构上仍错。

---

## 4　非目标
- ⛔ 不改 `loop-engine` 仓；⛔ 不注册/不改任何协议
- ⛔ 不实现 triage/synthesizer/debater（R2）；不实现 `anchor-check`
- ⛔ **不得放宽 A8e H13 守卫**（预算不足仍须零发布零 CAS）
- ⛔ 不得为了让 D1 通过而把预算设成无穷大 —— 预算仍是不可回退写的护栏，
  只是缺省值必须能容纳一张真实卡

---

## 5　⛔ 派发面
- `setup_commands`: `npm ci`
- `LOOP_ENGINE_CLI` 用 `/data/worktrees/loop-engine-v1build/dist/cli.js`；⛔ 必须用 `bun` 跑
- ⛔ 读退出码时命令后不接管道
- ⛔ 对会增长的 channel 做存在性判断，先取尾部再 `after_seq` 倒查
  （`limit=N` 返回**最早** N 条；`board:agent-runs` 已有约 6767 条）
- `.dd-evidence/` 是保留路径，陈旧 `acceptance.json` 不该由本包修
