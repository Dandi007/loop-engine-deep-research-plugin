# C5 冷启动终验新失败签名：worker exit 0 无 result → in_flight 永卡 → terminate 门控死锁 → generate 永不触发（判别性 spec）

## 一、真机实据（逐字取证，本轮 2026-08-30 已在 origin/main=e0a74b3 干净构建上复现）

全新题目冷启动（`确定性编排中 evidence 不可变 leaf 与 clue 版本链如何共同支撑端到端审计回溯`，`--sources 4 --tier heavy --profile agent-harness`），构建 HEAD=e0a74b3（`收割: C5 冷启动最终复验产物（dev-fg-ab89b4a64897）(#123)`，含 PR#122 max_passes 推导修复）。run `2026-08-30T101725-31adcd7c-1788056245300-1427531`，channels `research:agent-harness-84e2ebd6621e.*`。

**终态逐字：**
- `drain.json`：`{"contract_version":2,"drain_id":"2026-08-30T101725-31adcd7c-1788056245300-1427531","status":"done","outstanding":1,"last_heartbeat":1788062870961,"ended":1788062876783}` —— **status=done 但 outstanding=1**。
- `index.jsonl` run.end（末尾）：`{"kind":"run.end","run_id":"2026-08-30T101725-31adcd7c-...","status":"error","exit_code":1,"duration_ms":6631483}` —— **drain 最终 exit_code=1（error），耗时 ~1.84h**。
- `loop-events.jsonl`：68× `round_start` + 68× `round_end(errors=0)`，**无任何 `phase_change` / `pipeline_drained` / generate 事件**。
- tick68（末 tick）`raw.txt` termination（逐字）：`{"state":null,"coverage":25,"zeroGrowthRounds":36,"capHit":true,"boardComposition":{"proposed":0,"open":14,"inFlight":4,"explored":25,"blocked":4}}`；4 张 harvest 卡全部 `{"skipped":true,"skippedReason":"no_result","casExplored":false,"degenerateRejections":[]}`。
- docs channel `research:agent-harness-84e2ebd6621e.docs` head_seq=0；`/data/vault/DeepThought/` 无该题 ⇒ **报告未生成**。

## 二、根因链（单一精确根因）

1. 4 张 in_flight 卡的 worker 以 **exit_code=0 clean 退出，但从未发布 `worker.result.v1`**（harvest `no_result`；本轮恒 4 张在飞）。
2. `decideTick`（src/tick.ts:222-229）对 `run.state!=="started" && run.exitCode===0` 的 in_flight 卡**只发 `harvest` 决策**，绝不发 reclaim/block。
3. `harvestCard`（src/harvest.ts:782-801）`readWorkerResult→null` ⇒ `no_result` 分支，按 A10a §0.3「找不到结果 ≠ 无产出」**留 in_flight、casExplored=false**，下一 tick 幂等重放。
4. C5-fix3 的恢复路径 `startedInFlightCards`（src/tick-run.ts:205-212）**只选 `run.state==="started"`**；已 exited 的卡被排除 ⇒ `pollStartedWorker`（ready/exited-without-result/timed-out）对其**永不执行** ⇒ 无 reclaim。
5. `decideTermination`（src/tick.ts:375-389）非空 state 需 `(capHit && drained)` 或 `(zgr>=2 && inFlight===0 && proposed===0)`，`drained` 要求 `inFlight===0`。inFlight 恒 4 ⇒ **state 恒 null**。
6. `decideGenerate`（src/generate.ts:81-83）`= term.state !== null` ⇒ **恒 false** ⇒ `runGenerate` 永不触发（tick-run.ts:2294-2296）。
7. 轮次预算 `max_passes=68`（`deriveMaxPasses`，PR#123 已有界推导）耗尽 ⇒ drain **exit_code=1** 收尾，**零报告**。

**与 PR#123 的区别（本单的新信息）**：PR#123 修的是「固定 16 太小被截断」（干净 exit 0 零报告）；本缺陷独立存在且幸存——即使预算有界充分（68），**只要 ≥1 个 worker exit 0 却无 result，terminate 门控就被 inFlight>0 永久卡死**，generate 段永远到不了。这是「worker.result.v1 缺席（exit 0 无 result / result-timeout）」触发的 **loop-engine 收割/终止门控死锁**，不是 agent-runtime role 证据契约缺失。

## 三、修复对象与层

- 修复落在 deep-research 插件（本仓）：`src/tick.ts`（decideTick 收割回收）、`src/harvest.ts`（no_result 终态化）、必要时 `src/tick-run.ts`（startedInFlightCards 覆盖范围）。不改 loop-engine 基座、不改 worker role/persona、不改协议 schema。
- 铁律（共性判别）：「确定性编排的端到端流水线：一个 in_flight 工作单元，其 worker 已 exit 0 但未产出可收割 result，必须进入**响亮终态（blocked，带 machine-readable rationale）**，绝不允许无限期停留在 in_flight 使终止判定死锁」——这是通用平台契约，非 DR 专属 hack。

## 四、判别性规格（不可放宽）

1. 一张 in_flight 卡的 run 已 exit（exitCode 任意，含 0），且宽限窗口内 `worker.result.v1` 仍不可读 ⇒ 该卡必须转移到**终态（blocked，带点名 run_id / exit_code / 缺 result / 宽限时长的 rationale）**，或等价地使 `decideTermination` 能在不依赖该卡 inFlight 归零的前提下达成。禁止无限 in_flight。
2. 上述终态转移后，`termination.state` 必须在「有界轮次预算内」达到非空（converged / partial / capped 之一）⇒ generate 段必须被保证触发。「干净 exit 0 零报告」**和**「budget-then-exit-nonzero 零报告」两者都被禁止。
3. partial/capped 终态同样必须产出报告（`blocked>0` ⇒ partial；anchor 核验率 <90% 标报告头部，不阻断导出）。不得只在 converged 才生成。
4. 保留 PR#123 的 max_passes 有界推导与 C3 sentinel-loud 既有行为逐字回归；不得回退 846+ 测试。
5. 不改 loop-engine 基座；若发现基座有更适的「in_flight 工作单元终态化」钩子，记录精确缺失、不静默绕过。

## 五、判别测试（必须真跑，机械可判）

1. 新测试构造「worker exit 0 且 board:agent-runs 上无 worker.result.v1」的板面，驱动 decideTick + harvest，断言该卡不再无限 in_flight（进入 blocked/reclaim），且 terminate 最终非空、generate 被触发——修复前红、修复后绿。
2. 新测试直接断言：含 ≥1 张「exit 0 无 result」卡时，decideTermination 在有限轮次后 state 非空（不依赖 inFlight 归零死等）——修复前红。
3. 既有 846+ 测试 + `npm run smoke:cas` 全绿不得回退。

## 验收

```dd-acceptance
npm ci
npm run typecheck
npm test
npm run smoke:cas
```

- 四命令全绿；判别测试在 `npm test` 中真实执行（判别用例通过）；不少于既有 846 测试。

## 边界

- 不碰生产主 checkout `/data/code/self/loop-engine-deep-research-plugin`；所有 git/install/test 仅在本 worktree 及未来验证 worktree。
- 不改 loop-engine 基座、不改 worker role/persona、不改协议 schema、不改 agent-runtime。
- 本单只修「worker exit 0 无 result ⇒ in_flight 死锁」新失败签名；兼容覆盖到 PR#122 harvest-robustness / C3 sentinel-loud / PR#123 max-passes 的行为须逐字回归，不得回退。