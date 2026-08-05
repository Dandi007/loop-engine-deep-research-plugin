# A10c —— 写入预算在生产链路上不可达：真实卡永远收割不了（修复）

development_id: `dev_ledr_a10c_writebudget_01`
attempt: `implement`（initial）
input_commit: `448d52667ef02bef8cefdeb4139fb99350e17267`

## 根因（spec §0）

`--max-writes` 在 CLI 层支持（`src/tick-entry.ts`），但生产装配链 `bin/deep-research-loop.sh`
→ `fleet.yaml.tpl` → `workflow.yaml` → `templates/tick.md` **从不传**，导致 `tick-entry --run`
永远吃代码默认 5。真实 worker 产出实测 6~10 条 evidence ⇒ needed（evidence+clue+CAS）≥ 6 > 5
⇒ 整卡跳过 ⇒ `skippedReason:"budget"` ⇒ 卡恒 `in_flight` ⇒ `hasPendingWork` 恒 true ⇒
每 tick 续投 ⇒ **永不 `drained`，恒 `max_rounds`**。这是「组件支持而生产模板不接线」的第四次同形复现。

## 修复

### 1. `--max-writes` 一路接到生产链路（spec §1.1 / D3）
- `bin/deep-research-loop.sh`：`export MAX_WRITES="${MAX_WRITES:-64}"`（缺省足以收割一张真实卡，有限护栏；显式覆盖语义保留）。
- `workflows/deep-research/fleet.yaml.tpl`：`input.max_writes: ${MAX_WRITES}`。
- `workflows/deep-research/tick/workflow.yaml`：seed payload `max_writes: "{{max_writes}}"`。
- `workflows/deep-research/tick/templates/tick.md`：四条 `--run` 分支均追加 `--max-writes "$max_writes"`。
- `src/tick-run.ts`：`DEFAULT_MAX_WRITES` 5 → **64**（代码层缺省与生产层一致，避免直跑 `--run` 时仍吃旧默认）。

### 2. 死锁必须可辨识（spec §1.2 / D5 / D6）
- `src/harvest.ts`：`HarvestBudget` 新增 `total()`；`HarvestReport.skippedReason` 新增 `"budget_infeasible"`。
- 预算不足判定区分两种形态：
  - `needed > 总预算`（与本轮已用无关，配置错误）⇒ **`budget_infeasible`**（响亮、可被上层识别）；
  - `needed ≤ 总预算` 但 `remaining` 不足（本轮被前面的卡用掉）⇒ 仍 **`budget`**（下一轮可继续）。
- `src/tick-run.ts`：harvest 的共享 budget 补 `total: () => maxWrites`。

### 3. 预算语义不变（spec §1.3）
- 仍是不可回退写的上限；v1 冻结 channel 拒写；证据 channel 无默认值。以上均未放宽。

## 硬验收

### D1 / D2 —— 真实 7490 bus 端到端（spec §2.1，真 bus、真 worker 产物）
- 跑前记录：`research:v1-tick-reclaim.index` head_seq=2（卡 `msg_01KZ7SCFAYY79KFXQ7CP2YPR57` 为
  `in_flight`，run `243d00ce-02a2-41e4-b031-9f1b2fdb8a7e`）；`research:v1-tick-reclaim.evidence`
  head_seq=0（空）；`board:agent-runs` head_seq=6764，其中 run `243d00ce` 的 `worker.result.v1`
  含 **6 条 evidence**（seq 6756）、`agent.run.exited.v2` exit=0（seq 6757）。
- 跑真实驱动（未打桩，TICK_CHANNEL=reclaim.index、EVIDENCE_CHANNEL=reclaim.evidence、
  MAX_WRITES 缺省 64、`LOOP_ENGINE_CLI=/data/worktrees/loop-engine-v1build/dist/cli.js`、bun 跑）：
  - 驱动 exit 0；drain 输出 `{"reason":"drained","rounds":1}` ⇒ **D2 通过**。
- 跑后回读：
  - 证据 channel head_seq **0 → 6**，全部 `research.evidence.v2`，clue_id 指向该卡 ⇒ **D1 通过**（+6）。
  - 卡 `msg_01KZ7SCFAYY79KFXQ7CP2YPR57` 状态 CAS 至 **`explored`**；index channel head_seq 2 → 3（+1 CAS）。
- 若预算仍为 5（needed=6+0+1=7 > 5），该卡必被整卡跳过、evidence 为 0 —— 实际 +6 证明 `--max-writes`
  在生产链路上**真的被传到了**（spec D3 端到端）。

### D3 —— 四层接线 + 值真到达
- `test/a10c-writebudget.test.ts`：bin / fleet / workflow / tick.md 逐层断言 + 渲染 `tick.md` 用假
  tick-entry 记录 argv，断言 `--max-writes 64` 真到达。

### D5 / D6 —— 判别对
- `test/harvest.test.ts`：`needed(5) > maxWrites(3)` ⇒ `budget_infeasible`（D5）；卡 A 消耗预算后
  卡 B `needed(5) ≤ maxWrites(5)` 但 remaining 不足 ⇒ `budget`（D6）。

### D7 —— H13 守卫不变
- 预算不足 ⇒ **零发布、零 CAS、卡不置终态**（原 H13 零发布/零 CAS 断言原文保留，仅将
  needed>maxWrites 场景的 skippedReason 按 D5 语义更正为 `budget_infeasible`）。

### 变异自检（spec §3，破坏后逐字还原并 `git diff --stat` 确认干净）
- **P1**（`tick.md` 去掉 `--max-writes`）⇒ D3 挂（grep + 端到端两例）✓ 已杀
- **P2**（缺省预算改回 5）⇒ D3 的缺省断言挂；且 6 条 evidence 卡在 maxWrites 5 下归 `budget_infeasible`（D1 单元面）✓ 已杀
- **P3**（把永不可收割也报成普通 `budget`）⇒ D5 挂 ✓ 已杀
- **P4**（预算不足改成发一部分再 CAS）⇒ 仍被 H13 零发布/零 CAS 拦截（未放宽，守卫保持）✓

### D11 —— typecheck + 全量测试 exit 0
- `npm run typecheck`：exit 0。
- `npm test`（D9）：连跑 5 次，退出码 `0 0 0 0 0`（17 文件 / 303 tests 全绿；读退出码时命令后未接管道）。

## 非目标（未触碰）
- 未改 `loop-engine` 仓；未注册/未改任何协议；未实现 triage/synthesizer/debater、`anchor-check`。
- 未放宽 A8e H13 守卫；预算仍是有限护栏（64，非无穷大）。
- 未触碰 `.dd-evidence/`；未删任何既有用例。