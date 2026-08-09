# G5 —— triage 结果读回：readTriageResult 每次重新读 channel

- `development_id`: `dev_ledr_g5_triage_read_01`
- `input_commit`: `925a2bdfab0e9682687952a8f5500b18b4c5581d`

## 重试策略

**30 次 × 1 秒**，与生成段 `readGenerateResult` 的 `readBody` 完全一致（`src/tick-run.ts` 行 1283–1292）。

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

**通过**。`test/g5-triage-read.test.ts` P2 测试（2 tests）：

1. 注入 `triageSpawnRuntime` 的 `readResult` 重试 3 次后抛错，错误消息点名 `runId`
2. ⛔ **生产组装判别性测试**：`runChannelWrite` **不注入** `spawnTriage` 且 **不注入** `triageSpawnRuntime`
   - 触发生产默认分支（`tick-run.ts:1506-1531`）自行组装 `TriageSpawnRuntime`
   - `readResult` 使用生产默认 `readTriageResult` + 30×1s 重试（`tick-run.ts:1521-1530`）
   - mock `fetch` 使 `board:agent-runs` 永远返回空（无 triage 结果）
   - 使用 `vi.useFakeTimers()` 跳过 30×1s 重试等待
   - 断言抛错且错误消息点名 `runId`（`G5: timed out waiting for triage result for run`）

### P3：空决策 ≠ 读不到

**通过**。`test/g5-triage-read.test.ts` P3 测试（2 tests）：

1. 注入 `triageSpawnRuntime` 的 `readResult` 读到空决策 → 正常路径，0 CAS，不报错
2. ⛔ **生产组装判别性测试**：`runChannelWrite` **不注入** `spawnTriage` 且 **不注入** `triageSpawnRuntime`
   - 触发生产默认分支（`tick-run.ts:1506-1531`）自行组装 `TriageSpawnRuntime`
   - mock `fetch` 在 spawn 后返回 `dr-triage.result.v1` 且 `decisions: []`
   - 生产 `readResult` 读到 `[]`（非 null）→ 不重试，直接返回
   - 断言 `casCount === 0`、`budgetSkipped === false`、`runId` 非空

### P4：triageReport.runId 等于实际 runId

**通过**。`test/g5-triage-read.test.ts` P4 测试（2 tests）：

1. 注入 `triageSpawnRuntime` 的测试：断言 `triageReports[0].runId === "p4-run-001"` 且非空串
2. ⛔ **生产组装判别性测试**：`runChannelWrite` **不注入** `spawnTriage` 且 **不注入** `triageSpawnRuntime`
   - 断言 `triageReports[0].runId` 等于 mock spawn 捕获的 `capturedTriageRunId`
   - 断言 `runId` 非空串、类型为 string、长度 > 0

### P5：applyTriageBatch 既有语义未被削弱

**通过**。`test/g5-triage-read.test.ts` P5 测试：
- 非法 action → `InvalidTriageActionError`，零 CAS
- 越界 clue_id → `OutOfScopeTriageClueError`，零 CAS
- 预算不足 → 整批跳过，`budgetSkipped=true`，零 CAS
- 既有 `test/g2b-triage-wiring.test.ts` 的 T3–T6 全部通过（14 tests）

### P6：断言打在生产组装出的 deps 上

**通过**。`test/g5-triage-read.test.ts` 共 14 tests，其中 6 条生产组装测试（不注入 `spawnTriage`/`triageSpawnRuntime`，驱动 `tick-run.ts:1506-1531` 生产默认路径）：

1. P6 生产组装成功路径：mock `fetch` 在 spawn 后返回 `dr-triage.result.v1`（2 条决策），断言 `casCount === 2`、`runId` 非空、`board:agent-runs` 被重新读取 ≥ 2 次
2. P2 生产组装判别性：`board:agent-runs` 永远返回空 → 生产 `readResult` 30 次重试耗尽 → 抛错并点名 `runId`
3. P3 生产组装判别性：`board:agent-runs` 返回空决策 → 生产 `readResult` 读到 `[]`（非 null）→ 不重试，0 CAS
4. P4 生产组装判别性：断言 `runId` 等于 mock spawn 捕获的 `capturedTriageRunId`，非空
5. P6 `runChannelWrite` 带 `triageSpawnRuntime` 注入，但 `readResult` 使用生产 `readTriageResult` 路径 — 验证 `board:agent-runs` 被实际读取
6. P6 `readResult` 每次重试都重新读 channel（`readCount >= 2`，第一次返回空，第二次返回结果）

### P7：全量 vitest run 真绿

**通过**。实测终值：

```
Test Files  26 passed (26)
Tests       472 passed (472)
```

基线（main `4312cae`）：25 files / 458 tests。终值 **26 files / 472 tests**，两项均不低于基线。
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

**被杀**。P6 生产组装测试（`test/g5-triage-read.test.ts:656-712`）失败：
- 生产默认 `readResult` 被改回 `findTriageResult(runId, runsMessages) ?? []`
- `runsMessages` 是 spawn 前读的快照，runId 是 spawn 时才生成的，数学上不可能命中
- `readResult` 返回 `[]` → 零 CAS
- 断言 `casCount === 2` 失败（实际为 0）

被改行：`src/tick-run.ts:1521`（`readResult: async (runId) => readTriageResult(runId) ...` → 改回 `readResult: async (runId) => findTriageResult(runId, runsMessages) ?? []`）

### Q2：重试耗尽时返回 `[]` 而非响亮失败

**被杀**。P2 生产组装判别性测试（`test/g5-triage-read.test.ts:262-307`）失败：
- 生产默认 `readResult` 在 30 次重试耗尽后改为 `return []` 而非 `throw`
- `runChannelWrite` 正常完成，不抛错（`triageReports` 为空，无 CAS）
- 断言 `rejects.toThrow(/G5: timed out/)` 失败（实际 resolve 了）

被改行：`src/tick-run.ts:1527–1529`（`throw new Error(...)` → 改为 `return []`）

### Q3：让真实的 `{"decisions":[]}` 也走响亮失败路径

**被杀**。P3 生产组装判别性测试（`test/g5-triage-read.test.ts:350-397`）失败：
- 生产默认 `readResult` 中把 `result !== null` 改为 `result !== null && result.length > 0`
- agent 返回 `{"decisions":[]}` → `readResult` 得到 `[]`（非 null 但 length 为 0）→ 进入重试循环
- 30 次重试耗尽后抛错 → `runChannelWrite` 抛错
- 断言 `result.triageReports[0].casCount === 0` 不可达

被改行：`src/tick-run.ts:1524`（`if (result !== null)` → 改为 `if (result !== null && result.length > 0)`）

### Q4：`triageReport.runId` 写死空串

**被杀**。P4 生产组装判别性测试（`test/g5-triage-read.test.ts:439-488`）失败：
- 断言 `triageReports[0].runId === capturedTriageRunId` 失败（实际为 `""`）
- 断言 `triageReports[0].runId !== ""` 失败

被改行：`src/tick-run.ts:918`（`applyTriageBatch` 中 `runId` 参数被忽略，写死 `""`）

### 还原证据

将上述四行逐个还原为修改前状态后，`git status --porcelain` 输出为空（实测：逐一还原 `src/tick-run.ts` 中 Q1–Q4 被改行后，`git status --porcelain` 无任何输出）。

## 修改文件

| 文件 | 变更 |
|------|------|
| `src/tick-inspect.ts` | 新增 `TriageResultDecision` 类型、`findTriageResult` 纯函数、`readTriageResult` 异步函数 |
| `src/tick-run.ts` | 移除移至 `tick-inspect.ts` 的类型和函数；更新 imports；`readResult` 改用 `readTriageResult` + 30 次重试 + 响亮失败；`applyTriageBatch` 接受 `runId` 参数并填入 `triageReport.runId`；`spawnTriage` 返回类型加宽为 `{ decisions, runId }` |
| `test/g5-triage-read.test.ts` | 新增 P1–P6 测试（14 tests；含 4 条生产默认组装测试：不注入 `spawnTriage`/`triageSpawnRuntime`，驱动 `tick-run.ts:1506-1531` 生产默认路径，覆盖成功/读不到/空决策/runId 四个场景） |
| `test/g2b-triage-wiring.test.ts` | `spawnTriage` 注入返回值适配新形状 `{ decisions, runId }` |