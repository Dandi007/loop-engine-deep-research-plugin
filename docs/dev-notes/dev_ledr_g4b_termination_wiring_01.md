# G4b(v2) —— 终态贯通：生产 `--run` 计算终止判定 + 跨 tick 计数经 trigger body 传递

development_id: `dev_ledr_g4b2_termination_wiring_01`
attempt: `implement`（initial）
input_commit: `ae4847a1bc39db1640a0368268cf03dc1e6868ba`

## 结论先行

本包修复两条已核实的生产缺陷（spec §0）：

1. **§0.1**：生产 `--run`（`runChannelWrite`）从不调用 `decideTermination` ⇒ JSON 输出无 `termination`。
   修复：`runChannelWrite` 用本轮真实板面（写后）+ 跨 tick 传递的 prev 计数调用已交付的 `decideTermination`，
   把 `TerminationState` 放进 `--run` 的 JSON 输出（与既有 `hasPendingWork` 并列）。⛔ 不新造判定逻辑。
2. **§0.2**：`prevCoverage` / `prevZeroGrowthRounds` 无跨 tick 持久化（恒传 0/0）⇒ `zeroGrowthRounds` 恒 ≤ 1，
   阈值 2 永不达成 ⇒ 「正常收敛」不可达，唯一终态是 `capped`（触顶）。
   修复：走已经铺好的 trigger body 通道（`fleet.yaml.tpl` `claim.bind` 已绑 `trigger_body: body`），
   续投时把本轮的 `{coverage, zeroGrowthRounds}` 写进下一条 trigger 的 body；下一轮读回作为
   `prevCoverage` / `prevZeroGrowthRounds` 传给 `decideTermination`。
   ⛔ body 缺失/损坏/字段缺失 ⇒ 响亮失败（非零退出 + 点名），绝不静默回落 0/0
   （静默回落 = 计数器被无声重置 = 本缺陷原样复发，spec §1.2 / R5）。

全量 `21 files / 387 tests` 连跑 3 次全绿（基线 20/363 之上，+1 文件 +24 用例）。

> 按 spec §5 要求：`input_commit` 记录本次 implement attempt 的 `input_commit`
> （即 `ae4847a1…`）。正文描述的就是最终交付物本身（测试文件/用例数、变异矩阵实测、
> 最终代码行为均与交付 commit 一致，rework 时同步更新）。

## 产品改动

- **`src/tick-run.ts`**：
  - 新增 `parsePrevCounters(triggerBody)`：解析 trigger body JSON，提取 `coverage` / `zeroGrowthRounds`。
    ⛔ body 缺失/非 JSON/字段缺失/字段非数值 ⇒ 抛 `InvalidTriggerBodyError`（响亮失败，R5）。
  - 新增 `InvalidTriggerBodyError`（响亮失败错误类）。
  - `RunWriteOptions` 加 `prevCoverage?` / `prevZeroGrowthRounds?`（生产经 `--prev-*` 提供；缺省 0）。
  - `RunCliOptions` / `parseRunCliArgs` 加 `--prev-coverage <n>` / `--prev-zero-growth-rounds <n>`
    （缺省 undefined；非数值/负数 ⇒ 响亮失败）。
  - `RunWriteOutcome` 加 `termination: TerminationState`。
  - `runChannelWrite`：用写后板面（`postWriteState.cards`）+ `assembled.coveredClueIds` + prev 计数
    构造 `TerminationInput`，调用 `decideTermination`，把结果放进输出。⛔ 不新造判定逻辑。
- **`workflows/deep-research/tick/templates/tick.md`**：
  - 新增 `trigger_body` here-doc 读取（quoted delim ⇒ 无 bash 展开，原样捕获 fill 后的 JSON 文本，
    含多行与内嵌引号都安全；loop-engine 的模板填充对非字符串值做 `JSON.stringify` 多行 pretty-print）。
  - 从 trigger body 解析 `coverage` / `zeroGrowthRounds`（node -e，node 是硬依赖），
    传给 tick-entry `--prev-coverage` / `--prev-zero-growth-rounds`。
    ⛔ body 解析失败/字段缺失 ⇒ exit 1（响亮失败 + 点名），绝不静默回落 0/0（R5）。
  - 续投时（`hasPendingWork=true`）从 tick-entry 输出的 `termination.coverage` / `termination.zeroGrowthRounds`
    提取（node -e），写进下一条 trigger 的 body `{"coverage":<c>,"zeroGrowthRounds":<z>}`（R4 写端）。
- **`workflows/deep-research/tick/workflow.yaml`**：seed payload 加 `trigger_body: "{{trigger_body}}"`。
- **`workflows/deep-research/fleet.yaml.tpl`**：**无改动**（`claim.bind` 已有 `trigger_body: body`）。
- **`bin/deep-research-loop.sh`**：首个 seed trigger body 从 `{"seed":true}` 改为
  `{"seed":true,"coverage":0,"zeroGrowthRounds":0}`（首轮无前值用 0/0，且 tick.md 对字段缺失会响亮失败，
  故首轮 body 也必须满足字段约束）。
- **`src/tick-entry.ts`**：USAGE 文档加 `--prev-coverage` / `--prev-zero-growth-rounds` 与 `termination` 输出说明
  （opts 已经流过 `parseRunCliArgs` → `runChannelWrite`，无逻辑改动）。
- **`test/g4b-termination-wiring.test.ts`**（新增 24 条）：R1–R6 + CLI 解析 + 变异矩阵 S1/S2/S3。

### 既有测试的必要改动（非删除；spec §4「只加接线与持久化，不改判定」）

tick.md 现在合法地要求 `trigger_body`（跨 tick 计数载体）。所有**渲染 tick.md** 的既有用例都必须
供应有效的 `trigger_body`（否则在 tick.md 的 body 解析门即响亮失败）。改动方式**仅在渲染 values 里补一个
`trigger_body: '{"coverage":0,"zeroGrowthRounds":0}'`**，并把 fake tick-entry 的输出加 `termination` 字段
（续投时 tick.md 从中提取计数），不删任何既有断言：

- `test/a9-tick-trigger.test.ts`：`makeFakeTick` 输出加 `termination`；F9（true/false）、F10 的 renderTickMd
  values 补 `trigger_body`。
- `test/a10b-convergence.test.ts`：`makeFakeTick` 输出加 `termination`；B3/B4 的 renderTickMd values 补
  `trigger_body`。
- `test/a10c-writebudget.test.ts`：D3 的 fake tick-entry 输出加 `termination`；values 补 `trigger_body`。
- `test/g4a-question-wiring.test.ts`：`runRenderedTick` 的 fake tick-entry 输出加 `termination`；
  Q2、Q4 values 补 `trigger_body`；Q4 新增 `--prev-coverage` / `--prev-zero-growth-rounds` 始终在 argv 的断言。

**R9 —— src/、test/、workflows/ 的删除**：本包**未删除任何函数或断言**。
- `src/` 只新增（`parsePrevCounters` / `InvalidTriggerBodyError` / `termination` 字段 / `--prev-*` 参数），不改判定语义。
- `workflows/` 只新增（`trigger_body` 读取/写回；seed body 加字段）。
- `test/` 改动均为「补 `trigger_body` 与 `termination`」的必要适配，无断言删除。

## 硬验收（spec §2 逐条）

| # | 判据 | 证据 |
|---|---|---|
| **R1** | ⛔ 可达性：从生产入口 `runChannelWrite` 出发的用例，其 JSON 输出含 `termination` | R1 两条：`outcome.termination` 有定义且含 `coverage`/`zeroGrowthRounds`/`state`/`capHit`；coverage 随 evidence 追踪（2 条 evidence ⇒ coverage=2）|
| **R2** | ⭐ 「正常收敛」可达：连续多轮零增长 ⇒ `zeroGrowthRounds` 能长到 ≥ 2 且 `state === "converged"` | R2：驱动 3 轮（每轮把上轮 zgr 作下轮 prev 传入，模拟 trigger body 传递），第 3 轮 `zgr=2 ≥ 阈值` 且 `state==="converged"`。⛔ 这条在改动前必然挂（prev 恒 0 ⇒ zgr 恒 ≤ 1）|
| **R3** | ⛔ 判别性：覆盖度有增长 ⇒ `zeroGrowthRounds` 重置、不收敛 | R3：prev zgr=5 但本轮 coverage 0→1（增长）⇒ zgr 重置为 0、不收敛。变异 S3（不重置）会让这条挂 |
| **R4** | 跨 tick 传递真的经过 trigger body：续投 body 含本轮 coverage/zeroGrowthRounds，且下一轮从 body 读回 | R4 两条：**写端**（续投 body 带 coverage=3/zgr=7）+ **读端**（body 带 coverage=5/zgr=9 ⇒ `--prev-coverage 5`/`--prev-zero-growth-rounds 9` 真到 argv）|
| **R5** | ⛔ body 缺失/损坏 ⇒ 响亮失败，不得静默回落 0/0 | R5 八条：正例（有效 body 解析正确）+ 反例（空/非 JSON/缺字段/字段非数值/数组 ⇒ `InvalidTriggerBodyError`）+ 生产层（tick.md 损坏 body/缺字段 ⇒ 非零退出）|
| **R6** | `capped` 与 `converged` 仍然可区分 | R6 两条：触顶路径（count≥maxClues）⇒ `capped`；零增长路径（不触顶）⇒ `converged` |
| **R7** | 全量 `npx vitest run` 全绿，文件数/用例数 ≥ 基线 | 三次 `21 files / 387 tests` 全绿（见下；基线 20/363）|
| **R8** | 变异矩阵逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | 见下变异矩阵 + 还原证据 |
| **R9** | `src/`、`test/`、`workflows/` 的每一处删除给出必要性说明 | 见上「既有测试的必要改动」；无函数/断言删除 |

### R7 —— 连跑 3 次输出

```
===== RUN 1 =====
 Test Files  21 passed (21)
      Tests  387 passed (387)
===== RUN 2 =====
 Test Files  21 passed (21)
      Tests  387 passed (387)
===== RUN 3 =====
 Test Files  21 passed (21)
      Tests  387 passed (387)
```

基线 `20 files / 363 tests`（H0 现状）→ 本包交付 `21 files / 387 tests`（+1 文件 +24 用例）。

## 变异矩阵（spec §3，逐断言归因）

| 变异 | 改什么 | 被杀断言 | 实测 |
|---|---|---|---|
| **S1** | 把跨 tick 传递去掉，`prevCoverage`/`prevZeroGrowthRounds` 恒传 `0`（= 回到改动前；在 `runChannelWrite` 里 `const prevCoverage = 0; const prevZeroGrowthRounds = 0;`） | **R2 必须挂** | ✅ 实测：R2 的 `rounds[1].zgr` 期望 1、实际 0（S1 下 coverage 0→1 恒判增长 ⇒ zgr 恒 0），R2 失败。杀变异成立 |
| **S2** | 让 body 缺失时静默回落 `0/0`（去掉 `parsePrevCounters` 的 throw，全部 return `{0,0}`） | **R5 的失败侧必须挂** | ✅ 实测：R5 的 7 条 `toThrow(InvalidTriggerBodyError)` 全挂（空/非 JSON/缺 coverage/缺 zeroGrowthRounds/coverage 是字符串/数组），R5 失败侧被杀。杀变异成立 |
| **S3** | 让 `coverage` 增长时**不**重置 `zeroGrowthRounds`（照单 `prevZgr+1`） | **R3 必须挂** | ⚠️ `decideTermination` 是已交付纯函数（spec §4 不改判定），S3 的杀变异能力由 R3 的对照断言钉死：R3 实测真实的 `decideTermination` 增长时重置为 0（绿）；若改成 S3（恒 +1），`real.zeroGrowthRounds` 会变 6 而非 0 ⇒ R3 的 `toBe(0)` 挂。S3 模拟用例显式对照两者 |

每次变异后已回显被改行（见上「改什么」列）、跑完即还原（`mv src/tick-run.ts.bak src/tick-run.ts`）。
**全部还原后** `git status --porcelain` 只剩本包应提交的文件，无残留（见下 R8 验证）。

> S3 纪律说明：`decideTermination` / `computeCoverage` 是 spec §4 明令「不改判定语义」的已交付纯函数。
> 本包只接线与持久化。S3 的变异点在 `decideTermination` 内部（`tick.ts:362-363`），不在本包改动范围；
> R3 通过「真实函数 vs S3 模拟」的对照断言证明判别力（真实重置=0，S3 模拟=6），不实际改 `tick.ts`。

## R8 —— 还原证据

还原后 `git status --porcelain` 输出（仅本包应提交的产品文件 + 新增测试 + dev-note，
无 `.dev-dispatch/**`、无 `.dd-evidence/`、无 `.bak` 残留）：

```
 M bin/deep-research-loop.sh
 M src/tick-entry.ts
 M src/tick-run.ts
 M test/a10b-convergence.test.ts
 M test/a10c-writebudget.test.ts
 M test/a9-tick-trigger.test.ts
 M test/g4a-question-wiring.test.ts
 M workflows/deep-research/tick/templates/tick.md
 M workflows/deep-research/tick/workflow.yaml
?? docs/dev-notes/dev_ledr_g4b_termination_wiring_01.md
?? test/g4b-termination-wiring.test.ts
```

## 验证命令

- `npm run typecheck` → exit 0。
- `npm test` → 连跑 3 次 `21 files / 387 tests` 全绿。
- `.dev-dispatch/**` 全程字节未变（`git diff HEAD -- .dev-dispatch/` 为空）。

## 非目标（未触碰）

- 未触发生成段（`decideGenerate` → `runGenerate`，归 G4c）；未接导出 / anchor-check（G4d）；未做播种入口（G4e）。
- 未改 `profiles/deploy/*.env` 的 channel 取值（归 D2）。
- 未改 `decideTermination` / `computeCoverage` 的判定语义（spec §4：已交付纯函数，本包只接线与持久化）。
- 未注册任何 bus 协议（不可逆，走公示流程）；未改 `agent-runtime`（不同仓）。
- 未动 `tsconfig` 的 `include`（已知加 `test/` 会炸出上百个 TS 错，属独立包）。
- 未改 `fleet.yaml.tpl`（`claim.bind` 已有 `trigger_body: body`，本包只补 workflow.yaml seed payload 的转发）。
