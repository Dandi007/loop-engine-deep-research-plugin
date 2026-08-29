# C5 收割鲁棒性：单 worker 退化证据不得令整 tick 崩（判别性 spec）

## 背景（真机实据，2026-08-30 冷启动）

C5 冷启动（题目「agent-runtime 的 agent-run 退出契约如何用 result_published 区分正常产出与无结构化输出」，run 2026-08-30T025406-f574d347，channels research:agent-harness-9ef10c0ad61b.*）在 tick 收割步响亮崩溃：

```
[deep-research-loop] TICK FAILURE: run_dir=/data/loop-engine/runs/2026-08-30T025406-f574d347 exit=2
  journal: {"identity":"tick","result":"[bash 非零退出 EXIT:2]\nA8e: worker evidence missing source/locator/revision for anchor; refusing to derive a degenerate empty anchor (no silent empty-string fallback).\n..."}
```

随后 `check-drain-failures.mjs` exit3，generate 段从未触发 ⇒ 报告未生成。根因链已取证：`dr-worker-code-remote` worker 读了 stale 非 git 目录 `/data/agent-runtime-research`（其自身运行根 = 2026-08-23 23:31 打包的 agent-runtime release，source_commit d25b645f，无 .git），按 persona「无 revision 则留空、绝不杜撰 sha」契约，产出含空 `revision` 的退化 evidence。

**失效范围收窄语义（本单相对上一单 C3-sentinel-loud sha256:48bbf002… 的新增信息）**：上一单修的是「drain 带未收割卡死亡却静默 exit 0」（哨兵不响亮，drain 进程层）。本单修的是**同一 tick 内单卡收割层**「单个 worker 产出一条缺 revision 的退化 evidence ⇒ 整 tick 崩（exit2）」。当前 A8e 收割步对退化 evidence 的处理是**抛错而非隔离**：`anchorForEvidence`（src/harvest.ts 约 306-310）抛 `A8e: worker evidence missing source/locator/revision for anchor...`，而 `runWrite` 的 `case "harvest":`（src/tick-run.ts 约 1002 处 `harvestCard` 调用）**无 try/catch** ⇒ 抛错存活到 tick 顶 ⇒ exit2 ⇒ `check-drain-failures` exit3 ⇒ generate 段永不执行。对比同文件 `case "dispatch":`（约 1056-1099）已有 per-card try/catch 把 `ContentTranscriptMissingError` 隔离为单卡 blocked——收割侧缺同级卡级隔离。

## 修复对象与层

- 修复落在 deep-research 插件收割层：`src/harvest.ts` 的 `harvestCard`/`anchorForEvidence`/`evidenceFromWorker` 与 `src/tick-run.ts` 的 `case "harvest":`（收割写依赖装配）。不改 loop-engine 基座、不改 worker role/persona（worker 的「无 revision 留空、绝不杜撰」契约正确，无需回退）。
- 铁律：不得 DR 专属 hack。失效隔离是「确定性编排的卡级容错」通用语义：任一 worker 产物越界时，编排层把该卡隔离（blocked/failed + 命名 rationale）、继续推进其余卡与后续段，是 chatgroup/dd/未来新域同一编排基座的通用能力，不是 DR 私有胶水。

## 判别性规格（不可放宽）

1. 单条 worker evidence 缺 `source`/`locator`/`revision` 任一项（或为空串）时，A8e 收割步**不得**抛未捕获异常令整 tick 非零退出（不得 exit2）。
2. 该退化 evidence **不得**以退化空锚（`://@` 或 `code://@` 等）发布到 append-only 证据 channel。
3. 该卡必须被**隔离**为 blocked（或 failed），并写命名 rationale（点名 missing source/locator/revision 与 run_id/clue_id），**绝不 CAS 到 explored**；隔离是单卡语义，**不阻断同 tick 其余 harvest 卡的正常收割与 CAS explored**。
4. 同卡其余**合规** evidence 仍照常发布；退化为单条隔离，不连坐整卡合规产物（对齐既有 `evidenceRejections` 的条目级拒发纪律）。
5. 该 tick 结束后，generate 段判定照常进行（`termination.state !== null` 时 `runGenerate` 仍被调用；隔离卡不得让 tick 崩或让 generate 被跳过）。

## 判别测试（必须真跑、真 dispatch 走 tick 决策）

新增测试必须**真实驱动一次 `runWrite`/`harvestCard`** 走到「某卡 worker 结果含一条缺 revision 的 evidence、其余卡结果正常」的场景，并断言：
- 修复前必须红（当前实现：`anchorForEvidence` 抛错未捕获 ⇒ runWrite 抛 `A8e: worker evidence missing source/locator/revision...`）；修复后必须绿（runWrite 正常返回，该卡隔离、其余卡正常收割）。
- 断言点（机械可判）：
  a. runWrite/harvest 不抛 `A8e: worker evidence missing source/locator/revision`（不 exit2）；
  b. 退化卡被标 blocked（或 failed），rationale 点名 source/locator/revision；
  c. 退化卡**未** CAS 到 explored，且其退化 evidence **未**以空锚 publishEvidence；
  d. 同 tick 其余合规卡的 evidence/clue 仍被发布并 CAS explored；
  e. generate 判定仍可计算（不被 harvest 异常短路）。
- 禁止「exit 0 也算过」：必须断言上述 b/c/d 的隔离语义真实成立，勿只测「不崩」。

## 验收

```dd-acceptance
npm ci
npm run typecheck
npm test
npm run smoke:cas
```

- 四命令全绿，且判别测试在 `npm test` 中真实执行（Tests M passed 且 M>0）。
- 新增/改动不得使既有 846 测试与 smoke:cas 回退。

## 边界

- 不碰生产主 checkout `/data/code/self/loop-engine-deep-research-plugin`；所有 git/install/test 仅在独立 worktree。
- 不修改 worker role/persona（`dr-worker-code-remote` 的「无 revision 留空、绝不杜撰」契约不变）；若调查发现 worker 侧还有更早可补强点，本单只记录、不越界改。
- 不修改 loop-engine 基座本体；若发现基座对「卡级失败隔离」有更适层，记录精确缺失，不静默绕过、不改基座。