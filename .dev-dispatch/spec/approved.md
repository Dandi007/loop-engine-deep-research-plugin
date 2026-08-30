# C5（第三暴露）——「撞派生预算 max_passes 不收敛仍静默 exit 0 零报告」响亮化（判别性 spec）

## 背景（真机实据，2026-08-30 C5 冷启动终验）

dev-fg-ab89b4a64897（含 derive round budget + zero-report sentinel）已合入 origin/main（#123，HEAD=e0a74b3ee8287c50bcee495db99fd23ae61367d6）。在此构建上对全新题目「确定性编排中 evidence 不可变 leaf 与 clue 版本链如何共同支撑端到端审计回溯」重新冷启动，run 真机终局如下（逐字）：

- `systemctl --user show c5-final-coldstart-1788056244`：`ActiveState=inactive` / `Result=success` / `ExecMainStatus=0` ⇒ **exit 0（静默成功）**。
- drain registry `drain.json`：`status:"done"`、`outstanding:1`、`ended:1788062876783`。
- loop-events.jsonl 共 136 行 = `68×round_start + 68×round_end`（全 errors=0），与 `fleet.yaml` 的 `max_passes: 68`（派生值）严格吻合。
- trigger store 末条 body=`{tick:true, coverage:25, zeroGrowthRounds:35}`（coverage 冻结 25、zgr 攀至 35、仍有 proposed/inFlight 未排空 ⇒ `termination.state` 从未非空 ⇒ `runGenerate` 从未触发）。
- `research:…docs` head_seq=0、`/tmp/deep-research-generated/` 不存在（无 generate one-shot 标记）、DeepThought 无该题目录 ⇒ **零报告**。

## 根因（已取证）

1. 深研（--sources 4 heavy，depth 扩张至 3-4、code-remote 慢 worker）的实际收敛所需轮次**超出** `deriveMaxPasses` 派生的 68；coverage 冻结在 25、zgr 攀至 35 仍未排空（proposed/inFlight 非终态卡持续存在）。
2. 修复单 dev-fg-ab89b4a64897 的「零报告哨兵」在 `scripts/check-drain-failures.mjs:190` 写为：
   `if (drainState.status === "done" && summaryReason !== "max_rounds") { …零报告判定… }`
   即**显式排除 `max_rounds`/撞预算终局**（注释理由=保留 e0-regression 多 drain 收敛设计）。
3. 于是「撞派生预算（max_passes）不收敛 ⇒ drain status=done + outstanding≥1 + 零报告」这一终局**既不触发 sentinel_lost（status 非 running），也不触发零报告哨兵（被 max_rounds 排除）** ⇒ 静默 exit 0。这正是 C3「哨兵静默失效必响亮」的违约：预算耗尽 + 零交付物被伪装成成功。

## 修复对象与层

- 修复落在 deep-research 插件：`scripts/check-drain-failures.mjs`（零报告终态判定）与配套测试；必要时 `src/max-passes.ts` 的派生公式复核（见「边界」）。不改 loop-engine 基座（其「max_rounds → 非 zero 退出、drained → 零退出」契约正确且被 e0-regression 依赖）。
- 铁律：不得 DR 专属 hack。「编排应用一条端到端流水线要么产出交付物、要么响亮失败，绝不允许 exit 0 零产物」是通用平台契约。

## 判别性规格（不可放宽）

1. 深研 heavy run 终局（drain 进程退出）时**恰有其一**：（a）报告已 generate 并 publish 到 DOC_CHANNEL 且 export 到 `<EXPORT_ROOT>/DeepThought/<topic-slug>/`；或（b）响亮失败（非零退出 + 机器可读命名 reason）。**「exit 0 且零报告」在任何 drain 退出原由下均被禁止**。
2. 零报告哨兵**不得再以 `summaryReason !== "max_rounds"`（或以 `max_passes` 撞顶）为条件排除**撞预算终局。drain 以「status=done 且 (outstanding≥1 或 报告未生成)」结束时，无论原由是 drained 还是 max_rounds/max_passes，都必须响亮：非零退出 + 点名 drain_id / outstanding / 缺报告，reason 使用稳定 token（如 `budget_exhausted_no_report` 或复用 `sentinel_lost`，点名缺报告）。
3. **不破坏 e0-regression 多 drain 收敛语义**：GT-6 的「`max_rounds` + 非零退出 ⇒ 退避重来」合法中间态只能适用于「非最终、可重试的 drain 尝试」；对**最终一次 drain**（无后续重试包装），撞预算 + 零报告必须响亮失败。修法需给出「最终 drain vs 可重试中间尝试」的判别依据并在 spec 内注明（例如：由调用方显式声明重试包装，生产 deep-research-loop.sh 的单 drain 即最终 drain）。
4. 不得改动 loop-engine 基座本体、worker role/persona、协议 schema。
5. partial/capped 终态仍需产报告（`blocked>0`⇒stop=partial、anchor 核验率软闸门标头）——不得只在 converged 才生成（沿用先前纪律，本单不回归）。

## 判别测试（必须真跑，机械可判）

1. 新测试**真实驱动**「drain 以 max_rounds/max_passes 终局 + status=done + outstanding≥1 + 无 generate 标记」场景，断言 check-drain-failures（或抽出纯函数）产出**响亮非零**并点名 reason（budget_exhausted_no_report/sentinel_lost）+ drain_id + outstanding。修复前红（当前实现 line 190 排除 max_rounds ⇒ exit 0）、修复后绿。
2. 断言「自然 drained 但零报告」仍被捕获（不计回归，非倒退）。
3. 断言 e0-regression 的「非最终尝试 max_rounds+非零退出 ⇒ 退避重来」语义不被推翻（最终 drain 才响亮），并提供可复现 repro（构造一个 ≤N 轮不收敛、终局零报告的最小 run）。
4. 既有 877 测试 + `npm run smoke:cas` 不得回退。

## 验收

```dd-acceptance
npm ci
npm run typecheck
npm test -- --maxWorkers=1 --minWorkers=1
npm run smoke:cas
```

- 四命令全绿，且判别测试在 `npm test` 中真实执行（Tests 计数含新增判别用例且通过）。
- 新增/改动不得使既有 877 测试与 smoke:cas 回退。

## 边界

- 不碰生产主 checkout `/data/code/self/loop-engine-deep-research-plugin`；所有 git/install/test 仅在本 worktree 及未来验证 worktree。
- 不改 loop-engine 基座、不改 worker role/persona、不改协议 schema。
- 本单只修「撞预算/任意原由的 exit 0 零报告静默」；若调查发现 `deriveMaxPasses` 派生公式对深研扩张普遍不足，可一并复核公式（使其对 maxClues/depth/zeroGrowthThreshold 更充分），但判据核心是「零报告必须响亮」这一不可放宽项；派生公式的调整不得放宽判据 1/2。