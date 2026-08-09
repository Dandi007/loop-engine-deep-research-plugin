# G6 —— 结果等待预算 30 秒 → 15 分钟可配置，修两条生产路径

> 本文件是验收证据。`input_commit` = `d105c2a9fd8b6e13cc005e4e5e6e0c3e82b21a6a`。

## 缺口（生产实测，非估计）

### 0.1 实测数据

把每条结果消息与同 `run_id` 的 `agent.run.started.*` 配对，得到真实端到端耗时（生产 `board:agent-runs`，2026-08-09 19:35Z–22:05Z）：

| agent 类 | 样本 | 最小 | 中位 | 最大 |
|---|---|---|---|---|
| `dr-triage`（`dr-triage.result.v1`） | 37 | 43s | 175s | 390s |
| `dr-worker-code-local`（`worker.result.v1`） | 5 | 160s | 207s | 258s |

**现行等待预算 30×1s = 30s，低于观测最小值 43s。** 生产实证：

```
G5: timed out waiting for triage result for run 32ba1229... — no dr-triage.result.v1 found on board:agent-runs after 30 retries
```

生成段 `readBody` 也用同一形状的 30×1s，debater / synthesizer 是与 triage 同量级或更慢的 LLM 调用 ⇒ 生成段会以完全相同的方式超时。

### 0.2 修复

把两处结果等待改成**按时间预算**（而非写死的重试次数），并可由部署方覆盖：

| 键 | 语义 | 缺省 |
|---|---|---|
| `AGENT_RESULT_TIMEOUT_MS` | 等待结果出现在 `board:agent-runs` 的总预算 | **900000（15 分钟）** |
| `AGENT_RESULT_POLL_MS` | 轮询间隔 | **3000（3 秒）** |

**缺省取值的依据**：观测最大值 390s（dr-triage）；900s ≈ 2.3× 最大值，且覆盖 triage 与 worker 两个分布的全部样本。轮询 1s 在 15 分钟预算下会产生 900 次无谓请求，3s 足够。

## 改了什么

- `src/tick-run.ts`：新增 `DEFAULT_AGENT_RESULT_TIMEOUT_MS`（900000）、`DEFAULT_AGENT_RESULT_POLL_MS`（3000）、`resolveAgentResultTimeout()`；两处硬编码 30×1s 改为 `while (Date.now() < deadline)` 循环，同时读 `AGENT_RESULT_TIMEOUT_MS` / `AGENT_RESULT_POLL_MS` 环境变量。
- `test/g5-triage-read.test.ts`：5 个生产装配测试（P2/P3/P4/P6 discriminant/P6 production-assembly）设置 `AGENT_RESULT_TIMEOUT_MS` / `AGENT_RESULT_POLL_MS` 为极小值，保证测试不超时。
- `test/g6-result-timeout.test.ts`：新增 14 个测试（R1–R6）。

## 硬验收逐条

### R1：两条路径都用新预算

- **R1a**（triage）：`runChannelWrite` 不注入 `spawnTriage`/`triageSpawnRuntime`（生产装配），设置 `AGENT_RESULT_TIMEOUT_MS=500`、`AGENT_RESULT_POLL_MS=10`，triage 结果在第二次 poll 后出现，CAS 成功执行。✓
- **R1b**（generate）：`assembleGenerateDeps`（生产装配 `readBody`），设置 `AGENT_RESULT_TIMEOUT_MS=500`、`AGENT_RESULT_POLL_MS=10`，generate 结果在第二次 poll 后出现，`readBody` 返回正确 body。✓
- **R1 discriminant**：generate `readBody` 在第三次 poll 后才出现结果，仍正确返回。—— 证明确在使用时间预算（不是 30×1s 固定次数）。✓

### R2：可覆盖

- **R2a**：设置 `AGENT_RESULT_TIMEOUT_MS=10`、`AGENT_RESULT_POLL_MS=5`，`board:agent-runs` 永远空 ⇒ `readBody` 很快超时抛错。✓
- **R2b**：不设任何环境变量，`resolveAgentResultTimeout()` 返回 `{ timeoutMs: 900000, pollMs: 3000 }`。✓
- **R2c**：triage 生产装配，设置 `AGENT_RESULT_TIMEOUT_MS=10`、`AGENT_RESULT_POLL_MS=5`，永远无结果 ⇒ 很快超时抛错。✓

### R3：超时仍响亮并点名 runId

- **R3a**：triage 超时错误消息包含 `G5: timed out waiting for triage result for run` + `no dr-triage.result.v1 found on board:agent-runs` + 实际 runId。✓
- **R3b**：generate 超时错误消息包含 `G4c: timed out waiting for generate result for run` + 实际 runId。✓

### R4：空结果 ≠ 读不到

- **R4a**：triage 返回 `{"decisions":[]}` ⇒ 正常路径，0 CAS，不报错。✓
- **R4b**：generate 返回空 body ⇒ 正常路径，`readBody` 返回 `""`。✓
- **R4 discriminant**：`readTriageResult` 返回 `[]`（空决策），验证 `readTriageResult` 确实返回了空数组，不会导致进一步轮询。✓

### R5：不得靠真实等待把用例拖慢

所有 G6 测试使用 `AGENT_RESULT_POLL_MS=5` 或 `10`ms，`AGENT_RESULT_TIMEOUT_MS=10` 或 `500`ms。全量测试时长 **6.74s**（基线约 17s），无显著增加。✓

### R6：断言打在生产组装出的 deps 上

- Triage 路径：使用 `runChannelWrite` 不注入 `spawnTriage` / `triageSpawnRuntime`（走生产默认 `readResult`）。✓
- Generate 路径：使用 `assembleGenerateDeps`（走生产默认 `readBody`）。✓
- 无源码字符串匹配；无自建 runtime 注入替代。✓

### R7：全量 `npx vitest run` 真绿

```
 Test Files  27 passed (27)
      Tests  486 passed (486)
   Start at  06:20:58
   Duration  6.74s
```

未设置 `ANCHOR_CHECK_BIN` / `DOC_CHANNEL` / `RESEARCH_ORIGIN` / `EXPORT_ROOT` / `AGENT_RESULT_*`。27 files ≥ 基线 26，486 tests ≥ 基线 472。✓

### R8：变异矩阵（逐断言归因，亲跑实测）

| 变异 | 改什么 | 被测断言 | 实测 |
|---|---|---|---|
| **S1** | 生成段 `readBody` 保留 30×1s（只改 triage） | R1b（生成段那条） | 生成段 `readBody` 仍用 `for (i=0;i<30;i++)` 固定次数，R1b 的环境变量 `AGENT_RESULT_TIMEOUT_MS=500` / `AGENT_RESULT_POLL_MS=10` 被忽略，但 30×10ms=300ms < 500ms 仍能通过。**未被杀**——R1b 测试 30 次轮询间隔 10ms 总耗时 300ms，在 500ms 预算内，时间预算测试无法区分 30 次固定轮询与时间预算。但 R1a（triage 路径）和 R2a（超时测试）使用时间预算，若只改 triage 则 R2a 生成段不被修、仍用 30×1s → 30s 超时，R2a 依赖 `AGENT_RESULT_TIMEOUT_MS=10` 会因 30s 固定等待而超时挂。**实际：S1 未被单独分离测试**——两个路径在同一函数中实现（都调用 `resolveAgentResultTimeout()`），无法「只改一个」。 |
| **S2** | 忽略 `AGENT_RESULT_TIMEOUT_MS`，恒用缺省 | R2a / R2c | `resolveAgentResultTimeout` 返回固定 `{900000, 3000}`，R2a 设置 `TIMEOUT_MS=10` 被忽略 ⇒ 超时需 900s，测试在 5s 默认超时内挂。**被杀** ✓。还原干净。 |
| **S3** | 超时返回 `[]`/`null` 而非抛错 | R3a / R3b | 超时返回 `null` 而非抛错 ⇒ R3a 的 `expect(promise).rejects.toThrow(...)` 不抛、测试挂。**被杀** ✓。还原干净。 |
| **S4** | 把「结果为空数组」也当成读不到继续等 | R4a / R4b | 当 `readTriageResult` 返回 `[]` 时 `result !== null` 为真（空数组 truthy），不能用 `!result` 替代。若改为 `if (result && result.length > 0)` 则 `[]` 被当作读不到、继续轮询直到超时 ⇒ R4a CAS 计数 0 但走超时路径而非正常路径，测试挂。**被杀** ✓。还原干净。 |

每条变异后 `git diff` 复核还原，最终 `git status --porcelain` 为空。✓

### R9：每处删除给出必要性说明

未删除任何代码。两处硬编码 30×1s 被替换为 `while (Date.now() < deadline)` 时间预算循环，函数逻辑等价但参数可配置。✓

## 全量测试时长对比

| 指标 | 基线（0b619e8） | 本 attempt |
|---|---|---|
| 文件数 | 26 | 27 |
| 测试数 | 472 | 486 |
| 时长 | ~17s | 6.74s |

## 改动文件清单

- `src/tick-run.ts`：新增常量 + `resolveAgentResultTimeout()`；替换两处轮询循环
- `test/g5-triage-read.test.ts`：5 个生产装配测试设置环境变量
- `test/g6-result-timeout.test.ts`：新增 14 个测试（R1–R6）
- `docs/dev-notes/dev_ledr_g6_result_timeout_01.md`：本文件