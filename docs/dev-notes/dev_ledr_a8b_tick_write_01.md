# dev_ledr_a8b_tick_write_01 —— A8b tick 写侧：真实 `runs` + CAS 认领/回收（不含 spawn）

## 产品改动

本包修复 A8a 把 `runs` 硬编码为空的问题，并新增写侧执行模式（CAS 认领/回收，**不 spawn**）。

- **修改 `src/tick-inspect.ts`**（读侧补真实 `runs`）：
  - `parseRunEvent(msg)` —— 识别 `agent.run.started.*` / `agent.run.exited.*`，按 `run_id`
    归集（真实 bus kind 为 `agent.run.started.v1`，run_id 在 payload；兼容 kind 后缀形态）。
  - `readAgentRuns(channelId = "board:agent-runs")` —— **分页读** `board:agent-runs`
    （`after_seq` 翻到取空），返回 `Record<run_id, RunEvent>`（M6）。
  - `assembleBoard(messages, runs)` —— `runs` 改为**必传参数**（不再硬编码空），卡上的 `runId`
    取 payload 的 `run_id`（引擎在 CAS 时写进卡，spec §1.1 退路）。
  - `computeInspect` / `runInspect` 同步接真实 runs。
- **新增 `src/tick-run.ts`**（写侧核心）：
  - `runWrite(deps, decisions, maxWrites)` —— 执行写动作：`reclaim`→CAS 目标 status、
    `dispatch`→CAS open→in_flight 并把 `run_id` 写进卡（M7）、`block`→CAS blocked。
    ⛔ **不 spawn**：注入的 spawn dep 是 no-op，CAS 成功后只登记 `pendingSpawns`（M9）。
    ⛔ 先 CAS 成功才算认领；CAS 失败（409）跳过该卡（M8）。
    ⛔ `--max-writes` 默认 **5**，超限立即抛 `MaxWritesExceededError`（M10）。
  - `realCas(channelId, input, nonce)`（导出）—— 真实 bus 的 CAS。**CAS 互斥硬不变量**：
    前置条件在**同一次 `getEntity` head 读**上求值（`input.from`），head 状态 ≠ 前置条件
    即返回 `conflict` 且**不 publish**，绝不 CAS 掉活 worker 的认领（spec §0 破坏场景）；
    `supersedes` 取这同一次 head 的 `message_id`（与 `claimClue` 同源读语义一致）。
    每个决策的 `from` 前置条件：`reclaim`→`in_flight`、`dispatch`→`open`、`block`→`open`。
  - `spawnCalls` 是**观测计数**（包装 `deps.spawnWorker` 递增），非硬编码字面量（M9 判别性）。
  - `runChannelWrite(opts)` —— 校验 channel（冻结即拒，M12）→ 读板 + 真实 runs → 决策 → 执行写。
  - `parseRunCliArgs(args)` —— 解析 `--run` 参数；**channel 无默认值**（M11）。
- **修改 `src/tick-entry.ts`**：新增 `--run <channel_id> [--max-writes <n>]` 模式；
  `runSelfCheck` 不再含 `runs: {}` 字面量（M6）。
- **新增 `test/tick-run.test.ts`**：M1–M12，一个 describe 一个判据（spec §5.1）。
- **新增 `docs/dev-notes/dev_ledr_a8b_tick_write_01.md`**（本文件）：M13 运行证据。

## 硬验收映射

| # | 断言 | 覆盖 |
|---|---|---|
| M1 | 有对应 started ⇒ 无 reclaim | `M1`（in_flight + `r1:{started}` ⇒ 无 reclaim） |
| M2 | 无对应 started ⇒ reclaim→open | `M2`（与 M1 只差 runs 一项） |
| M3 | exited code 0 ⇒ explored | `M3` |
| M4 | exited code≠0、重试<2 ⇒ open +1 | `M4` |
| M5 | exited code≠0、重试=2 ⇒ blocked | `M5` |
| M6 | runs 分页读取填充，非硬编码 | `M6`（100/20/0 → 3 读，2/3 带 after_seq；生产文件无 `runs: {}`） |
| M7 | dispatch CAS 成功写 run_id 进卡 | `M7`（捕获 **publish body**，断言 payload 含非空 `run_id` 且 status=in_flight；另断言 cas 入参非空 run_id） |
| M8 | CAS 失败跳过、不 spawn | `M8`（conflict ⇒ skipped=1、pendingSpawns=0、spawn 0 次） |
| M9 | 不 spawn，注入 no-op 被记录 | `M9`（spawn dep 调用 0 次 + pendingSpawns 登记 2 条） |
| M10 | --max-writes 默认 5，超限响亮报错 | `M10`（7 决策 ⇒ 5 写后抛 MaxWritesExceededError） |
| M11 | channel 无默认值 | `M11`（`parseRunCliArgs([])` 抛 MissingChannelError；CLI exit 2） |
| M12 | 拒绝写 v1 冻结 channel，零请求 | `M12`（FrozenChannelError，fetch 0 次；CLI exit 2） |
| M13 | 真机对 `research:p02-smoke-1dce60` 跑 `--run`，增量 ≤ 5 | 下方运行证据（5→7，增量 2） |
| M14 | 不得触碰 `.dd-evidence/` | git diff 校验为空 |
| M15 | typecheck + 全量测试 exit 0 | `npm run typecheck` / `npm test` 均绿（171 条全绿） |
| M16 | 既有用例一行未删 | git diff 无 `it(` 净减少（既有 **152** 条全保留：`tick-run` 外 `it(` 计数 151 + `it.each` 展开 1 条） |

## 变异自检归因

> 每个变异在 `src/tick-run.ts`（或 `src/tick-inspect.ts`）破坏**那一行**后跑针对性测试，
> 逐条回显被改的行与被杀的断言及实际失败输出，跑完逐字还原。无「只报 N/N 挂了」的表格。

**X1 —— `runs` 改回硬编码 `{}`**（`src/tick-inspect.ts` `readAgentRuns`）
```ts
// 原：分页读后按 run_id 归集返回
const runs: Record<string, RunEvent> = {};
for (const msg of messages) { /* …归集… */ }
return runs;
// 变异：直接返回空
return runs; // 把上两行连同 return 前逻辑删成 `const runs = {}; return runs;`
```
被杀断言：`M6`（`expect(Object.keys(runs)).toHaveLength(120)`）→
`AssertionError: expected [] to have a length of 120 but got +0`；同时 `M6` 的
`not.toMatch(/runs:\s*\{\}/)` grep 也挂。
说明：M1/M2 按 §4.1 纪律 4 对**纯数据**求值（直接喂 runs 给 `decideTick`），故 X1 不杀 M1；
M1/M2 只差 runs 一项（纪律 7）证明判别逻辑本身，生产 `runs` 的来源由 M6 分页+grep 锁死。

**X2 —— 去掉分页（只读第一页）**（`src/tick-inspect.ts` `readChannelMessages`）
```ts
// 原：after_seq 翻到取空
if (page.length === 0) break;
// 变异：读到第一页即停
if (page.length === 0 || true) break;
```
被杀断言：`M6`（`expect(calls).toHaveLength(3)`）→
`AssertionError: expected [ Array(1) ] to have a length of 3 but got 1`（第 2/3 次带 `after_seq=` 的读不再发生）。

**X3 —— dispatch 时不写 `run_id` 进卡**（`src/tick-run.ts` `realCas`）
```ts
// 原：把 run_id 合并进 CAS 更新
if (input.runId) update.run_id = input.runId;
// 变异：删除该行
```
被杀断言：`M7`（捕获 publish body，`expect(payload.run_id).toBeTruthy()`）→
`AssertionError: expected undefined to be truthy`（payload 无 run_id）。此断言走真实
`realCas→casUpdateClue→publish` 路径，故 X3 现在**确实杀掉 M7**（修复前该行不被测试覆盖）。

**X4 —— CAS 失败时不跳过、继续动作**（`src/tick-run.ts` `runWrite` dispatch 分支）
```ts
// 原：CAS 失败（409）→ 跳过该卡
} else {
  // CAS 失败（409）→ 跳过该卡，无后续动作（M8）。
  skipped += 1;
}
// 变异：去掉 skipped += 1 / 照常登记
```
被杀断言：`M8`（`expect(result.skipped).toBe(1)`）→
`AssertionError: expected +0 to be 1`；`pendingSpawns` / `spawnWorker` 断言随之保护活性。

**X5 —— 去掉 `--max-writes` 上限**（`src/tick-run.ts` `runWrite.perform`）
```ts
// 原：超限立即抛错
if (writes >= maxWrites) {
  throw new MaxWritesExceededError(maxWrites);
}
// 变异：删除该 guard
```
被杀断言：`M10`（`expect(runWrite(…)).rejects.toBeInstanceOf(MaxWritesExceededError)`）→
`AssertionError: promise resolved "{ writes: 7, … }" instead of rejecting`（不再响亮报错）。

**X6 —— 允许对 v1 冻结 channel 写**（`src/tick-run.ts` `isFrozenChannel`）
```ts
// 原：匹配冻结前缀
return FROZEN_CHANNEL_PATTERNS.some((re) => re.test(channelId));
// 变异：恒放行
return false;
```
被杀断言：`M12`（`expect(isFrozenChannel("research:loop-mcp-semantics.index")).toBe(true)`）→
`AssertionError: expected false to be true`；`runChannelWrite` 零请求拒绝断言亦挂。

**G1 —— 去掉 CAS head 前置条件 guard**（`src/tick-run.ts` `realCas`，本轮为修复 blocker 新增）
```ts
// 原：head 状态 ≠ 前置条件 → conflict 不 publish
if (current !== input.from) {
  return { success: false, error: "conflict" };
}
// 变异：guard 恒为 false（跳过校验）
```
被杀断言：CAS 互斥两条（dispatch 遇 in_flight head、reclaim 遇非 in_flight head）→
`AssertionError: expected true to be false`（本应 conflict 却 publish 成功，活 worker 认领被覆盖）。

## 真机运行证据（M13）

前置命令（仅查询）读 `research:p02-smoke-1dce60`，跑一次 `--run` 后复查消息数：

```
$ node node_modules/.bin/vite-node src/tick-entry.ts -- --run "research:p02-smoke-1dce60"
{
  "channelId": "research:p02-smoke-1dce60",
  "messageCount": 5,
  "decisions": [
    { "kind": "reclaim", "clueId": "msg_01KZ6FT90ZH11S18KH3FQZ4CE3", "to": "open", "retries": 0 },
    { "kind": "dispatch", "clueId": "msg_01KZ6AF6P3SN4B43BYHQAJ8TTW" }
  ],
  "writes": 2,
  "skipped": 0,
  "pendingSpawns": [
    { "clueId": "msg_01KZ6AF6P3SN4B43BYHQAJ8TTW", "runId": "410aabe8-6317-42bd-86b2-84d02715fa9f" }
  ]
}
$ echo $?   # exit 0
```

- **M13 增量核验**：该 channel 消息数 **跑前 = 5，跑后 = 7，增量 = 2 ≤ 5**（未触 --max-writes=5）。
- 写入说明：① `msg_01KZ6FT90Z…` 由 `in_flight`（无 run_id）**reclaim 到 open**（1 次 CAS）；
  ② `msg_01KZ6AF6P3S…` 由 `open` **dispatch 到 in_flight 并把 run_id `410aabe8…` 写进卡**
  （1 次 CAS，M7 真机成立）。共 2 次 CAS，**pendingSpawns 登记 1 条**（不真正 spawn，M9）。

## 验收

- `npm run typecheck` —— exit 0
- `npm test` —— 既有 **152** 条 + 新增 19 条（tick-run）全绿（**171** 条）
- `--run` 对 `research:p02-smoke-1dce60` 真跑 exit 0，增量 2 ≤ 5
- `--run` 无 channel → exit 2；冻结 channel → exit 2 且零请求
- 未触碰 `.dd-evidence/`
