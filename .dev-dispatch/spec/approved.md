# C5 冷启动新失败签名：max_passes 有界预算耗尽而板面未排空、报告未生成 → drain 静默 exit 0（判别性 spec）

## 一、真机实据（逐字取证，2026-08-30，cold-start run）

run=2026-08-30T143121-50abeb55，channel `research:agent-harness-f5b30e61878b.*`，构建 HEAD=`01ea9a98`（= dev-fg-eca29b32b462 merger；merge-base --is-ancestor 50ae84b HEAD = YES、ddd6494 c5fix4 terminalize = YES）。fleet.yaml `max_passes=68`（deriveMaxPasses：maxClues64 + zeroGrowthThreshold2 + margin2）。

终态逐字（亲读）：
- `drain.json`：`{"contract_version":2,"drain_id":"2026-08-30T143121-50abeb55-1788071481360-2578830","pid":2578830,"status":"done","last_heartbeat":1788088188037,"outstanding":1,"ended":1788088193890}` —— **status=done 但 outstanding=1，无 reason、无 exit_code 字段**。
- systemd 宿主单元 `c5final2-coldstart-1788071480.service`：`Result=success, ExecMainCode=0, ExecMainStatus=0` —— **静默 exit 0**。
- `loop-events.jsonl`：68× round_start + 68× round_end，**全 errors=0**，无任何 phase_change / pipeline_drained / generate 事件。
- trigger 末 done tick：`{"id":"a9-1788088188014162731-3838848","status":"done","body":{"tick":true,"coverage":40,"zeroGrowthRounds":38}}`；遗留 1 张 open tick `a9-1788088193822040043-3839171`（coverage=40、zgr=39，未被收割）。
- coverage 轨迹：36→38→**40 平台**；此后 zgr 0→39 单调累积。coverage=40 **远低于 maxClues=64 未触 capHit（按 count>=maxClues）**；但 maxDepth=3 已触顶（depth 封顶）。
- index 板面快照（末段）：`proposed≈11, in_flight≈26, open≈11, explored≈25, blocked≈6, dropped≈5` —— **板面未排空**（in_flight≈26、proposed≈11 恒非零）。
- docs channel `research:agent-harness-f5b30e61878b.docs` head_seq=0；`/data/vault/DeepThought/` 无该题 ⇒ **报告未生成**。

## 二、根因链（单一精确根因）

1. coverage 爬到 40 后触 maxDepth=3 深度封顶（`decideTermination` 条件 3：`max(depth)>=maxDepth`），`capHit=true`，但 `capHit` 仅「拦住新 clue」，仍须 `drained`（inFlight===0 && open===0 && proposed===0）才报 `capped`。
2. 板面上约 26 张卡停留在 `in_flight`、约 11 张 `proposed`、11 张 `open`，**在 68 轮有界预算内始终未排空**（worker 或 exited-0-no-result 未被 terminalize、或 started 但超预算仍未归终）。
3. `decideTick` 对 `run.state==="started"` 的卡只 `continue`（不回收）；对 `run.exitCode===0` 的卡只发 `harvest`；`startedInFlightCards` 只选 `state==="started"`。exited 但无 result / started 但迟迟不 exit 的卡**既无 reclaim 也无 blocked terminalize**，恒 in_flight。
4. `decideTermination` 非空 state 需 `(capHit && drained)` 或 `(zgr>=2 && inFlight===0 && proposed===0)`；drained 恒 false（in_flight≈26）⇒ **state 恒 null**。
5. `decideGenerate = term.state !== null` ⇒ 恒 false ⇒ `runGenerate` 永不触发 ⇒ 零报告。
6. 轮次预算 `max_passes=68` 耗尽 ⇒ drain 以 **`Result=success/exit 0`** 收尾，drain.json **无 reason 字段**，**静默零报告**。

**与 c5fix4（PR#125，治「worker exit 0 无 result ⇒ 收割卡永 in_flight」）的区别（本单新信息）**：c5fix4 覆盖的是「exited(0) 无 result」这一条回收路径。本缺陷独立幸存：即便该路径已就位，**深度封顶（maxDepth=3）后仍有多类卡（started-永不-exit、proposed 永不被派满、open 永不被 triage 提上）在有界预算内无法排空**，且**耗尽时 drain 静默 exit 0、不写 reason**。这是「有界预算耗尽 + 板面未排空 = 响亮非收敛终态」这一平台契约缺失，不是单一 worker-result 缺席。

## 三、修复对象与层

- 落 deep-research 插件本仓：`src/tick.ts`（in_flight 卡的 bounded-terminalize，started 超预算→reclaim/blocked）、`src/tick-run.ts`（预算耗尽时的 run 级响亮收口）、`src/deep-research-entry.ts`/`src/run-exit-diagnostic.ts`（drain 退出契约）、必要时 `bin/deep-research-loop.sh`（把「预算耗尽 + 未排空」转成非零 drain + reason 落盘）。不改 loop-engine 基座、不改 worker role/persona、不改协议 schema、不改 agent-runtime。
- 铁律（共性判别）：「确定性编排端到端流水线：有界轮次预算耗尽时，若板面尚未排空、报告尚未生成，必须进入**响亮非收敛终态**（drain reason 点名 outstanding/in_flight/proposed 计数 + 非零退出），绝不静默 exit 0」；「一个 in_flight 工作单元在超预算前必被 bounded-terminalize 到响亮态（blocked 带 machine-readable rationale），使板面可排空、termination 条件可评估」。这是通用平台契约，非 DR 专属 hack。

## 四、判别性规格（不可放宽，机械可判）

1. 当 loop 耗尽 `max_passes`（推导预算）且板面仍未排空（in_flight>0 或 proposed>0）、报告未生成时，drain 必须**写响亮非收敛 reason**（machine-readable，点名 `outstanding`/`in_flight`/`proposed`/`open` 计数）且**非零退出**。绝不静默 exit 0。`status=done + outstanding>0 + 无 reason + exit 0` 必须被废止。
2. 卡死的 `in_flight` worker（started 超预算 / exited 无 result）须在**有界预算内被 bounded-terminalize**（转 `blocked` 等响亮态，带点名 run_id / 卡停留时长 / 缺 result 或超时的 rationale），使板面可排空、`decideTermination` 条件可评估、`generate` 可点燃，或走上述响亮失败。
3. 上述终态转移后，`termination.state` 必须在有界轮次预算内达到非空（converged / partial / capped 之一）⇒ generate 段被保证触发；「静默 exit 0 零报告」和「budget-then-exit-nonzero 却无 reason 零报告」两者都被禁止。
4. partial/capped 终态同样必须产出报告（`blocked>0` ⇒ partial；anchor 核验率<90% 报在报告头部，不阻断导出）。不得只在 converged 才生成。
5. 保留 PR#123 的 max_passes 有界推导、PR#125 c5fix4 的收割-terminalize、C3 sentinel-loud 既有行为逐字回归；不得回退既有测试（≥846）。

## 五、判别测试（必须真跑，机械可判）

1. 新测试构造「深度封顶后板面仍有 in_flight(26)/proposed(11) 排不尽」的板面，驱动 decideTick + decideTermination，断言：预算耗尽路径产出**非空响亮的非收敛终态**（state 或 reason 非空），且 drain 退出契约非零 —— 修复前红、修复后绿。
2. 新测试直接断言：含 ≥1 张「started 但超预算仍未 exit」或「exited(0) 无 result」卡时，bounded-terminalize 在有限轮次内把该卡转 blocked（响亮态），不无限 in_flight —— 修复前红。
3. 新测试断言「预算耗尽 + 未排空」时 drain 写 reason 点名三个计数且 exit_code!=0。
4. 既有 ≥846 测试 + `npm run smoke:cas` 全绿不得回退。

## 验收

```dd-acceptance
npm ci
npm run typecheck
npm test
npm run smoke:cas
```

- 四命令全绿；判别测试在 `npm test` 中真实执行（判别用例通过）；不少于既有 846 测试。

## 边界

- 不碰生产主 checkout `/data/code/self/loop-engine-deep-research-plugin`；所有 git/install/test 仅在本 worktree 及验证 worktree。
- 不改 loop-engine 基座、不改 worker role/persona、不改协议 schema、不改 agent-runtime。
- 本单只修「预算耗尽 + 板面未排空 = 静默 exit 0 零报告」新失败签名；兼容覆盖 PR#122/123/124/125 及 C3 sentinel-loud 的行为须逐字回归。