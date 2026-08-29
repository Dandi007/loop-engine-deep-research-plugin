# C5 再暴露新缺陷：深研干净收敛（drain status=done / exit 0）却未生成报告（docs 空 + 无 DeepThought 目录）——判别性 spec

## 背景（真机实据）

前代 C5 冷启动（题目「agent-bus 网关如何用 lease_token 的 lease fencing 保证 stale ack 被拒绝且消息版本链不可分叉」，run `2026-08-30T045717-6abacc44`，channels `research:agent-harness-95f8bcfd8085.*`）在含 C5 两修复（sentinel-loud 425b8fb + harvest-robustness 4f54cf0）的 plugin 上，16 轮全部 `round_end(errors=0)`、drain 干净收尾 `status=done`（exit 0），但**报告未生成**：docs channel head_seq=0、`/data/vault/DeepThought/` 无该题目录。done 态下 drain.json 记录 `outstanding=1` 且触发 store 末条 `a9-1788042815398945805-411188.json` 恒为 `status="open"`（续投 trigger 未被消费），进程 pid 74545 已退出。

本座位本轮重建 origin/main(50ae84b8) 独立 worktree 复验：`git diff 4f54cf0 50ae84b8 -- src test workflows bin docs profiles` 为空 ⇒ origin/main 与 4f54cf0 源码逐字节同源（仅 .dev-dispatch/.dd-evidence 元数据被清），缺陷随之继承。本轮已新建独立 worktree 并 `npm ci`(0) + `typecheck`(0) 后对**全新题目**发起 C5 冷启动（见 progress 五件套①②），预期同样复现本缺陷。

## 根因链（已取证，缺 generate 段被轮次预算截断）

1. 深研（`--sources 4` heavy，role 含 code-remote，result-timeout ~900s + reclaim/retry）每个带慢 worker 的 tick 跨时极长，收敛所需轮次往往 > 16。
2. `workflows/deep-research/fleet.yaml.tpl` 硬编码 `max_passes: 16` ⇒ loop-engine `runResident` 的 `maxRounds=16`（`dist/fleet.js` `maxRounds: manifest.max_passes`）——第 16 轮后无论板面是否已到终态 tick 都不再投递。
3. 终态 tick 判定依赖 `decideGenerate(term) = term.state !== null`（src/generate.ts:81-83）；`decideTermination`（src/tick.ts:355）仅在 `(capHit && drained)` 或 `(zeroGrowthRounds>=threshold && inFlight===0 && proposed===0)` 时给非空 state。前代 16 轮结束时板面仍有 in-flight，`hasPendingWork=true`，续投 trigger 写了 `{coverage:13, zeroGrowthRounds:5}`（open），但第 17 轮（本应见 `inFlight=0` 且 zgr 达阈 → state 非空 → runGenerate）被 `max_passes=16` 截断，report 永不落盘。
4. 该失败**不被 C3 哨兵响亮捕获**：`scripts/check-drain-failures.mjs` 仅把 `status==="running" && outstanding>0`、或 drain 无 run.end、或 round 轮次未闭合判为 `sentinel_lost`。本缺陷是 `status==="done"` + `outstanding=1` + run.end 有 + 轮次全闭合 ⇒ sentinelLost=false ⇒ exit 0 静默通过。→「干净 exit 0 但零产物」是 C3 之外的**新失败签名**。

## 修复对象与层

- 修复落在 deep-research 插件（本仓）：`workflows/deep-research/fleet.yaml.tpl`（round 预算）、`bin/deep-research-loop.sh` / `scripts/check-drain-failures.mjs`（drain 后哨兵与终判）、必要时 `src/tick-run.ts`（终态 trigger/generate 装配）。不改 loop-engine 基座（loop-engine 归他线，`maxRounds` 护栏语义正确）。
- 铁律：不得 DR 专属 hack。「确定性编排应用的一条端到端流水线**要么产出交付物、要么响亮失败，绝不允许 exit 0 零产物**」是通用平台契约（chatgroup/dd/未来新域同基座可用），不是 DR 私有胶水。

## 判别性规格（不可放宽）

1. 深研 heavy run 终局时**恰有其一**成立：（a）报告已由 generate 段生成并 publish 到 DOC_CHANNEL 且 export 到 `<EXPORT_ROOT>/DeepThought/<topic-slug>/`；或（b）响亮失败（非零退出 + 机器可读命名 reason）。**「干净 exit 0 且零报告」被禁止**。
2. 轮次预算不得静默截断终态 generate tick：
   - 要么把 round 预算做成**有界但充分**（由 fan-out `sources` / depth 确定性推导，而非固定 16，且保证终止 tick 必在当前预算内可达）；
   - 要么**解耦** generate 段于 tick 内 termination（drain 循环结束后，在已排空的板上强制跑一次终态 generate pass）。
   两者取一或兼取，但必须使「报告生成」在 drain 成功退出前被**保证**触发。
3. 哨兵终判扩展：drain 后若「status=done 且 outstanding>0（存在未消费续投 trigger）」或「drain 干净收尾但 docs channel 无报告（未生成/未落盘）」⇒ 响亮终态（类比 sentinel_lost，非零退出 + 点名 drain_id/outstanding/缺报告），禁止静默 exit 0。
4. 不得改动 loop-engine 基座本体；若发现基座层有更适的「终局必产交付物」钩子，记录精确缺失、不静默绕过。
5. partial/capped 终态同样必须产出报告（`blocked>0` ⇒ stop=partial；anchor 核验率软闸门 `<90%` 标在报告头部，不阻断导出）——不得只在 `converged` 才生成。

## 判别测试（必须真跑，机械可判）

1. 新测试**真实驱动**「round 预算在终态 tick 前耗尽」的场景，断言：非「exit 0 无报告」——要么报告已 publish + export，要么响亮失败（命名 reason）；修复前红（当前实现 max_passes=16 + 哨兵不捕获 ⇒ 静默 exit 0）、修复后绿。
2. 新测试直接调用哨兵判定（`check-drain-failures.mjs` 或抽出的纯函数），给入 `status=done + outstanding=1` 与「docs channel 为空」两种 registry 形态，断言产出响亮终态（非零）——修复前红。
3. 断言 round 预算非固定 16（或终态 generate 不依赖 tick 内 termination 兜底成立），即「终止 tick/generate 必在预算内可达」这一性质具备可测形态（如：推导出的预算 >= 使 `zeroGrowthRounds` 达阈所需轮数的下界）。
4. 既有 846+ 测试与 `npm run smoke:cas` 不得回退；新增/改动不得让 generate 段在 partial/capped 下丢失报告头部 anchor-rate 行。

## 验收

```dd-acceptance
npm ci
npm run typecheck
npm test
npm run smoke:cas
```

- 四命令全绿，且判别测试在 `npm test` 中真实执行（Tests 计数 > 基线且判别用例通过）。
- 不少于既有 846 测试 + smoke:cas 全绿。

## 边界

- 不碰生产主 checkout `/data/code/self/loop-engine-deep-research-plugin`；所有 git/install/test 仅在本 worktree 及未来验证 worktree。
- 不改 loop-engine 基座、不改 worker role/persona、不改协议 schema。
- 本单只修「干净 exit 0 零报告」新失败签名；若因本单改动又兼容性覆盖到 C3 sentinel-loud 或 harvest-robustness 已修行为，必须逐字回归其既有测试，不得回退。