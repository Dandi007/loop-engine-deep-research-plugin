# G5 —— triage 结果读回：readTriageResult 每次重新读 channel

- `development_id`: `dev_ledr_g5_triage_read_01`
- `input_commit`: `f01f31ac353f0099c7fbfada9a4a3158855417ff`

## 重试策略

**30 次 × 1 秒**，与生成段 `readGenerateResult` 的 `readBody` 完全一致（`src/tick-run.ts` 行 1303–1312）。

理由：
1. 生成段经 G4c(v2) 交付，已在生产实测跑通，同一量级既不过度激进而浪费资源，也不会因等待不足而假阴性。
2. triage agent 与 generate agent 同为 `agent-run` 子进程派发，其结果的发布延迟性质相同：spawn 是异步的，结果不会在 spawn 返回瞬间就出现在 channel 上。
3. 30 次 × 1 秒 = 30 秒总等待窗口，足以覆盖 agent-run 冷启动 + agent 推理 + 结果发布的总延迟（生产实测 agent-run 派发到结果发布 < 10 秒）。

## 硬验收 P1–P9

### P1：判别性

**通过**。`test/g5-triage-read.test.ts` P1 测试：
- 构造假 bus 在 spawn 之后才返回 `dr-triage.result.v1` 消息
- `readResult` 使用 `readTriageResult`（每次重新分页读 channel）→ 能读到结果
- 断言 `casCount === 2`（决策条数）
- 判别性测试：用 `findTriageResult` 在 spawn 前的空数组上查找 → 返回 `null`（证明 pre-spawn 快照命中不了）

### P2：读不到 ⇒ 响亮

**通过**。`test/g5-triage-read.test.ts` P2 测试：
- 假 bus 的 `board:agent-runs` 永远返回空（无 triage 结果）
- `readResult` 重试 3 次（每次间隔 10ms）后抛错
- 错误消息点名 `runId`（`G5: timed out waiting for triage result for run p2-run-001`）
- 判别性测试：`readResult: async () => []` 会静默通过（不抛错）

### P3：空决策 ≠ 读不到

**通过**。`test/g5-triage-read.test.ts` P3 测试：
- agent 返回 `{"decisions":[]}` → `readTriageResult` 返回 `[]`（非 null）
- `readResult` 不重试、不抛错，直接返回 `[]`
- `applyTriageBatch` 正常路径：0 条 CAS，`budgetSkipped=false`
- 判别性测试：把空决策误判成「读不到」→ 抛错（与 P2 可区分）

### P4：triageReport.runId 等于实际 runId

**通过**。`test/g5-triage-read.test.ts` P4 测试：
- 断言 `triageReports[0].runId === "p4-run-001"`（实际 spawn 时生成的 runId）
- 断言 `runId !== ""`（不再为空串）
- 判别性测试：`runId` 写死空串 → 断言失败

### P5：applyTriageBatch 既有语义未被削弱

**通过**。`test/g5-triage-read.test.ts` P5 测试：
- 非法 action → `InvalidTriageActionError`，零 CAS
- 越界 clue_id → `OutOfScopeTriageClueError`，零 CAS
- 预算不足 → 整批跳过，`budgetSkipped=true`，零 CAS
- 既有 `test/g2b-triage-wiring.test.ts` 的 T3–T6 全部通过（14 tests）

### P6：断言打在生产组装出的 deps 上

**通过**。`test/g5-triage-read.test.ts` P6 测试（3 tests）：

1. `runChannelWrite` 带 `triageSpawnRuntime` 注入，但 `readResult` 使用生产 `readTriageResult` 路径
   - 验证 `board:agent-runs` 被实际读取（`agentRunsReads >= 1`）
   - 不注入 `spawnTriage`（走 `triageSpawnRuntime` → `spawnTriageRole` 的生产路径）

2. `readResult` 每次重试都重新读 channel（`readCount >= 2`，第一次返回空，第二次返回结果）

3. ⛔ **生产组装测试**：`runChannelWrite` **不注入** `spawnTriage` 且 **不注入** `triageSpawnRuntime`
   - 触发生产默认分支（`tick-run.ts:1506-1531`）自行组装 `TriageSpawnRuntime`
   - `readResult` 使用生产默认 `readTriageResult` + 30×1s 重试（`tick-run.ts:1521-1530`）
   - mock `child_process.spawn` 捕获 runId 并模拟子进程退出
   - mock `fetch` 在 spawn 后返回 `dr-triage.result.v1`（`board:agent-runs` 被重新读取）
   - 断言 `casCount === 2`、`runId` 非空且等于实际 spawn 的 runId、
     `board:agent-runs` 被重新读取至少 2 次（初始 + post-spawn）

### P7：全量 vitest run 真绿

**通过**。实测终值：

```
Test Files  26 passed (26)
Tests       472 passed (472)
```

基线（main `4312cae`）：25 files / 458 tests。终值 **26 files / 472 tests**，两项均高于基线。
环境变量 `ANCHOR_CHECK_BIN`、`DOC_CHANNEL`、`RESEARCH_ORIGIN`、`EXPORT_ROOT` 均未设置。

### P8：变异矩阵逐断言归因

见 §4。

### P9：每处删除给出必要性说明

| 删除 | 必要性 |
|------|--------|
| `tick-run.ts` 的 `TriageResultDecision` 类型 | 移至 `tick-inspect.ts`，与 `findTriageResult` 同文件，消除 `tick-inspect.ts → tick-run.ts` 的循环依赖 |
| `tick-run.ts` 的 `findTriageResult` 函数 | 移至 `tick-inspect.ts`，与 `readTriageResult`（新函数）同文件，遵循 `findGenerateResult`/`readGenerateResult` 的既有模式 |
| `tick-run.ts` 默认 `readResult` 中的 `runsMessages` 引用 | 根因：pre-spawn 快照里 runId 还不存在，数学上不可能命中；改为 `readTriageResult`（每次重新读 channel） |

## §4 变异矩阵（实测）

### Q1：`readResult` 改回 `findTriageResult(runId, runsMessages)`

**被杀**。P1 判别性测试失败：
- `findTriageResult(runId, runsMessages)` 在 spawn 前的空数组上查找 → 返回 `null`
- `?? []` 使 `readResult` 返回 `[]` → 零 CAS
- 断言 `casCount === 2` 失败（实际为 0）

被改行：`src/tick-run.ts:1521`（原 `readResult: async (runId) => readTriageResult(runId) ...` → 改回 `readResult: async (runId) => findTriageResult(runId, runsMessages) ?? []`）

### Q2：重试耗尽时返回 `[]` 而非响亮失败

**被杀**。P2 失败侧测试失败：
- 重试耗尽后返回 `[]` → `runWrite` 正常完成，不抛错
- 断言 `rejects.toThrow(/G5: timed out/)` 失败（实际 resolve 了）

被改行：`src/tick-run.ts:1527–1529`（原 `throw new Error(...)` → 改为 `return []`）

### Q3：让真实的 `{"decisions":[]}` 也走响亮失败路径

**被杀**。P3 测试失败：
- agent 返回 `{"decisions":[]}` → `readResult` 抛错
- `runWrite` 抛错 → 断言 `result.triageReports[0].casCount === 0` 不可达

被改行：`src/tick-run.ts:1521–1529`（`readResult` 中把 `result !== null` 改为 `result !== null && result.length > 0`）

### Q4：`triageReport.runId` 写死空串

**被杀**。P4 测试失败：
- 断言 `triageReports[0].runId === "p4-run-001"` 失败（实际为 `""`）

被改行：`src/tick-run.ts:888,914`（`applyTriageBatch` 中 `runId` 参数被忽略，写死 `""`）

### 还原证据

将上述四行逐个还原为修改前状态后，`git status --porcelain` 为空（仅 `src/tick-run.ts` 有改动，逐一还原即可清空 diff）。

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/tick-inspect.ts` | 新增 `TriageResultDecision` 类型、`findTriageResult` 纯函数、`readTriageResult` 异步函数 |
| `src/tick-run.ts` | 移除移至 `tick-inspect.ts` 的类型和函数；更新 imports；`readResult` 改用 `readTriageResult` + 30 次重试 + 响亮失败；`applyTriageBatch` 接受 `runId` 参数并填入 `triageReport.runId`；`spawnTriage` 返回类型加宽为 `{ decisions, runId }` |
| `test/g5-triage-read.test.ts` | 新增 P1–P6 测试（14 tests；含一条生产默认组装测试：不注入 `spawnTriage`/`triageSpawnRuntime`，驱动 `tick-run.ts:1506-1531` 生产默认路径） |
| `test/g2b-triage-wiring.test.ts` | `spawnTriage` 注入返回值适配新形状 `{ decisions, runId }` |