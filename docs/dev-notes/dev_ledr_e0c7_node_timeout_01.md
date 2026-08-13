# E0c7 —— tick 超时间歇性修复；上限按预算给

> input_commit: `21ab77548397776d60ebda5192181a869294ab38`

## 硬验收逐条

| # | 判据 | 结果 |
|---|---|---|
| **1** | `npm ci && npm run typecheck && npm test` 全绿 | 见下方测试尾部。 |
| **2** | 判据 2: workflow.yaml limits.node_timeout ≥ 600，改回 30 ⇒ 变红 | PASS. `test/e0c7-node-timeout.test.ts` > "判据 2: workflow.yaml limits.node_timeout ≥ 600 (GT-18)" — 读 workflow.yaml 断 node_timeout ≥ 600 且 ≠ 30。 |
| **2a** | 判据 2a: 墙钟预算为主，次数上限仅为失控兜底（GT-19） | PASS. `test/e0c7-node-timeout.test.ts` > "判据 2a" — 真实执行 e0-regression.sh（maxAttempts=2, wallClock=15s, always-null 终止），入口继续超过次数上限，最终撞墙钟限。 |
| **2b** | 判据 2b: 种子板 --run 耗时 < node_timeout/2（GT-15/GT-16） | PASS. `test/e0c7-node-timeout.test.ts` > "判据 2b" — 真实 vite-node tick-entry --run 对 1-clue 种子板，耗时 < node_timeout/2，termination 可读，timings 有值。 |
| **2z** | 判据 2z: run 已 exited 但无 result ⇒ tick exit 0，诊断出现（GT-17） | PASS. `test/e0c7-node-timeout.test.ts` > "判据 2z" — runChannelWrite 直接调用：diagnostics 含 E0c7 §1.2；tick-entry --run 真实执行 exit 0。bus 不可达 ⇒ 非零退出。 |
| **3** | 判据 3: read 立即停止并产出诊断 | PASS. `test/e0c7-node-timeout.test.ts` > "判据 3" — findRunExited 检测 exited，E0c7RunExitedWithoutResultError 含 runId/role/elapsed。 |
| **4** | 判据 4: drain exec_failed ⇒ 入口响亮失败 | PASS. `test/e0c7-node-timeout.test.ts` > "判据 4" — check-drain-failures.mjs 检测引擎杀掉的 tick（status=TIMEOUT, error=exec），stderr 含 TICK FAILURE/engine-killed/run_dir。 |
| **4b** | 判据 4b: MAX_CLUES 由 profile 声明 | PASS. `test/e0c7-node-timeout.test.ts` > "判据 4b" — e0-regression profile 含 MAX_CLUES=24，< DEFAULT_TICK_CONFIG.maxClues=64，fleet.yaml.tpl/tick.md/workflow.yaml 装配链完整。 |

## 关键变更

- **profiles/deploy/e0-regression.env**: 新增 `MAX_CLUES=24`，收窄回归范围使 2400s 墙钟内可收敛。
- **workflows/deep-research/tick/workflow.yaml**: `wall_clock` 从 60 抬到 600（与 node_timeout 一致），注释更新为基于 GT-15/GT-18 地面真相。
- **src/tick-run.ts**: 
  - 新增 `TickTimings` 接口与 `runChannelWrite` 分阶段埋点（readBoardMs/decideTickMs/writeSideMs/decideTerminationMs/generateMs/totalMs），totalMs 含 generate 段。
  - 新增 `--max-clues` CLI 参数，profile 的 `MAX_CLUES` 经此传入 tick config。
  - triage 的 `E0c7RunExitedWithoutResultError` 处理器不再误报 `budgetSkipped: true`，改为 `budgetSkipped: false` 并使用真实 `runId`。
- **src/tick-inspect.ts**: `E0c7RunExitedWithoutResultError` 新增 `runId` 公开属性。
- **bin/e0-regression.sh**: 次数上限检查改为仅首次超限时打印警告（runaway guard），后续迭代不再重复 stderr；墙钟是主上限。
- **test/e0c7-node-timeout.test.ts**: 重写判据 2a/2b/2z 测试为真实入口执行（fake bus + e0-regression.sh / tick-entry --run），新增判据 4b 测试，新增 timings 与 wall_clock 断言。

## 实测 timings 依据

node_timeout=600 的依据（基于地面真相，非推测）：
- GT-18：背靠背两跑，小板面（2 条线索）tick 在 30.5–39.9s 被引擎 kill（node_timeout:30）
- GT-15：大板面（70+ 条线索）tick 以 status=TIMEOUT 死亡，单次 904s
- GT-15 对照：--inspect 子秒级返回，决策计算本身很快，慢的是 --run 副作用路径
- 600s 约 6.7× 最短 kill 上限（39.9s），容纳合法副作用路径（bus I/O、spawn、harvest、triage、generate）
- 配合 MAX_CLUES=24 收窄回归范围，单 tick 在 24 条线索以内足以完成合法工作
- wall_clock=600 保证引擎不会在 node_timeout 之前截断 tick
- ⛔ 保留有界上限语义（非无上限），超时仍响亮失败

## 全量测试尾部

```text
Test Files  2 passed (2)
     Tests  42 passed (42)
```