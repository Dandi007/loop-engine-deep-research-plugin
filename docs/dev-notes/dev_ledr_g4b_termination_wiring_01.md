# G4b(v3) —— 终态贯通：生产 `--run` 计算并返回终止判定，`prevCoverage`/`prevZeroGrowthRounds` 跨 tick 传递

development_id: `dev_ledr_g4b3_termination_wiring_01`
attempt: `implement`（initial）
input_commit: `09b461c640d83f6fbde92a5722defee5bc658116`

## 结论先行

本包修两条已核实的生产缺陷（spec §0）：

1. **§0.1**：生产 `--run` 路径（`runChannelWrite`）从不调用 `decideTermination` ⇒ 每个 tick 只做
   「决策→执行→报 hasPendingWork」，从不判断研究是否结束。
2. **§0.2**：`prevCoverage` / `prevZeroGrowthRounds` 没有任何跨 tick 持久化（三处调用点全部硬编码
   `0/0`）⇒ `zeroGrowthRounds` 恒为 0 或 1，阈值 `2` 永不达到 ⇒ 唯一可达终态是 `capped`（触顶），
   「正常收敛」当前不可达。

接线方式（spec §1.2）：走已经铺好的 trigger body 通道——续投时把本轮 `{coverage, zeroGrowthRounds}`
写进下一条 trigger 的 body；下一轮 tick 从 `{{trigger_body}}` 读回，作为 `prevCoverage` /
`prevZeroGrowthRounds` 传给 `decideTermination`。⛔ 不新造存储、不新造判定逻辑（`decideTermination` /
`computeCoverage` 是已交付纯函数，只调用它们）。

改动落点（spec §5）：
- `src/tick-run.ts`：`runChannelWrite` 调用 `decideTermination` 并把 `termination` 放进 `RunWriteOutcome`；
  新增 `prevCoverage` / `prevZeroGrowthRounds` 入参（CLI `--prev-coverage` / `--prev-zero-growth`）；
  新增 `parseTerminationFromBody` + `TriggerBodyTerminationError`（body 缺失/损坏 ⇒ 响亮失败）。
- `workflows/deep-research/tick/templates/tick.md`：读 `{{trigger_body}}` 解析上一轮计数并以
  `--prev-coverage` / `--prev-zero-growth` 传给 tick-entry；续投时把本轮 `termination.coverage` /
  `termination.zeroGrowthRounds` 写进下一条 trigger body。
- `workflows/deep-research/tick/workflow.yaml`：seed payload 加 `trigger_body: "{{trigger_body}}"`。
- `src/tick-entry.ts`：USAGE 文档更新（记录 `--prev-coverage` / `--prev-zero-growth` 与 `termination`）。
- 新增 `test/g4b-termination-wiring.test.ts`（21 条，R1–R6）。
- 既有测试的必要改动：fake tick-entry 的 JSON 输出加 `termination` 字段（4 个测试文件的桩）。

> 按 spec §5 更正后的 dev-note 要求：`input_commit` 记本次 implement attempt 的 input_commit
> （即 `09b461c…`），不去追交付 commit；正文描述的就是最终交付物本身（测试文件/用例数、变异矩阵
> 实测、最终代码行为均与交付 commit 一致，rework 时同步更新）。⛔ 不为对齐 commit hash 做额外提交。

## 产品改动

### `src/tick-run.ts`

- **import**：从 `./tick` 增 `decideTermination`、`TerminationState`。
- **`TriggerBodyTerminationError`**（新 class）：body 缺失/损坏 ⇒ 响亮失败。错误文本明确说明
  「静默回落 0/0 = 计数器被无声重置 = 本缺陷原样复发，而且更难查」。
- **`parseTerminationFromBody`**（新纯函数）：从 trigger body 字符串解析 `{prevCoverage, prevZeroGrowthRounds}`。
  契约（spec §1.2 R5）：body 解析失败 / 非 JSON 对象 / 缺字段 / 类型错 ⇒ 抛 `TriggerBodyTerminationError`，
  不得静默回落 0/0。
- **`RunWriteOptions`**：增 `prevCoverage?: number` / `prevZeroGrowthRounds?: number`（首轮无前值不传，
  `runChannelWrite` 缺省 0）。
- **`RunWriteOutcome`**：增 `termination: TerminationState`（与 `hasPendingWork` 并列）。
- **`runChannelWrite`**：用写后板面（`postWriteState.cards`）+ `assembled.coveredClueIds` 调用
  `decideTermination`，prev 值从 `opts` 取（生产由 tick.md 从 `{{trigger_body}}` 解析后传入）。
  ⛔ 不得新造判定逻辑：`decideTermination` / `computeCoverage` 是已交付纯函数，只调用它们。
- **`RunCliOptions` / `parseRunCliArgs`**：增 `--prev-coverage <n>` / `--prev-zero-growth <n>`
  （非负整数校验；不传即 undefined，`runChannelWrite` 缺省 0 = 首轮语义）。

### `workflows/deep-research/tick/templates/tick.md`

- 读 `{{trigger_body}}`：用 quoted heredoc（`<<'G4B_TRIGGER_BODY_EOF'`）捕获 verbatim JSON
  （body 含双引号/花括号，bash 双引号赋值会被 verbatim 渲染破坏）。`$(cat ...)` 命令替换已剥离尾换行。
- 从 trigger_body 解析 `{coverage, zeroGrowthRounds}`：用 `node - "$trigger_body" <<'G4B_PARSE_EOF'`
  （JS 脚本经 heredoc 喂 node stdin，避免 `node -e '...'` 里 JS 字符串的单引号过早闭合 bash 单引号）。
  解析出的值以 `--prev-coverage` / `--prev-zero-growth` 增量拼进 `tick_args`。
  - 首个 seed 触发 body 形如 `{"seed":true}`（无计数字段）⇒ node 退出码 0、空输出 ⇒ 不传 `--prev-*`。
  - body 缺失/损坏 ⇒ node stderr 打印 `G4b: trigger_body ...` + exit 1 ⇒ tick.md `exit 1`（响亮失败）。
- 续投写计数：`hasPendingWork=true` 时，从 `run_output` 的 JSON 解析 `termination.coverage` /
  `termination.zeroGrowthRounds`（同样用 `node - "$run_output" <<'G4B_NEXT_EOF'` heredoc），
  写进下一条 trigger body：`{"tick":true,"coverage":<n>,"zeroGrowthRounds":<m>}`。
- ⛔ 本文件禁用反引号字符与 `${var%$'\n'}` 参数展开：bash 静态解析在「heredoc + 命令替换」组合下
  会被反引号误导成跨行命令替换状态、被 `%$'\n'` 误导成未闭合单引号，导致整脚本 syntax error。
  注释和代码一律用普通文字描述。

### `workflows/deep-research/tick/workflow.yaml`

- seed payload 加 `trigger_body: "{{trigger_body}}"`（claim.bind 已把 trigger body 绑进 pipeline input；
  workflow 需显式 pass-through 到 tick.md）。

### `src/tick-entry.ts`

- USAGE 文档更新：记录 `--prev-coverage` / `--prev-zero-growth` 参数与 `termination` JSON 输出字段。

### 既有测试的必要改动（非删除；spec §5 G4b 接线对 fake tick-entry 的契约更新）

本包让 tick.md 在 `hasPendingWork=true` 时从 `run_output` 读 `termination.coverage` /
`termination.zeroGrowthRounds` 写进下一条 trigger body。既有测试的 fake tick-entry 桩输出的
JSON 不含 `termination` ⇒ tick.md 解析失败。改动方式**只在桩的 JSON 输出里补 `termination` 字段**，
不删任何断言：

- `test/a9-tick-trigger.test.ts`：`makeFakeTick` 的 JSON 输出加 `termination`。
- `test/a10c-writebudget.test.ts`：fake tick-entry JSON 输出加 `termination`。
- `test/a10b-convergence.test.ts`：`makeFakeTick` 的 JSON 输出加 `termination`。
- `test/g4a-question-wiring.test.ts`：`runRenderedTick` 的 fake tick-entry JSON 输出加 `termination`。

**R9 —— src/、test/、workflows/ 的删除**：本包**未删除任何函数或断言**；`src/` 仅 import 加宽与
`runChannelWrite` 增 termination 计算。唯一「删除」是 tick.md 移除了 `${trigger_body%$'\n'}` 参数
展开行（bash 静态解析在 heredoc 组合下语法错误，属必要而非误删），以及把 tick.md 注释里的反引号
字符去掉（同上语法约束）。

## 硬验收（spec §2 逐条）

| # | 判据 | 证据 |
|---|---|---|
| **R1** | ⛔ 可达性：从生产入口 tick-entry --run 的用例，其 JSON 输出含 termination | `R1` 三条：`runChannelWrite` outcome 有 `termination` 对象（含 state/coverage/zeroGrowthRounds/capHit）；`parseRunCliArgs` 解析 `--prev-coverage`/`--prev-zero-growth`；不传时 undefined（首轮语义）。⛔ 不是只验 selfcheck/inspect |
| **R2** | ⭐ 正常收敛可达：连续多轮零增长 ⇒ zeroGrowthRounds ≥ 2 且 state === converged | `R2` 主例：三轮驱动（首轮 zgr=0、二轮 zgr=1、三轮 zgr=2 ⇒ converged）。⛔ 这条在改动前必然挂——附加「恒传 0」对照例证明 R2 有判别力 |
| **R3** | ⛔ 判别性：覆盖度有增长 ⇒ zeroGrowthRounds 重置、不得收敛 | `R3` 例：prevCov=1/prevZgr=1，本轮 cov=2（增长）⇒ zgr 重置为 0（非 +1 到 2），state=null |
| **R4** | ⛔ 跨 tick 传递真的经过 trigger body（两端各一条） | `R4` 四条：(1) `parseTerminationFromBody` 读回；(2) outcome 值序列化成 body 再回读（闭环）；(3) **bash 端到端**——渲染 tick.md 喂带计数的 trigger_body，断言假 tick-entry 收到 `--prev-coverage 4 --prev-zero-growth 1`，且续投 trigger body 含本轮 `coverage:7 zeroGrowthRounds:3`；(4) seed body `{"seed":true}` 不传 `--prev-*` |
| **R5** | ⛔ body 缺失/损坏 ⇒ 响亮失败，不得静默回落 0/0 | `R5` 九条：undefined/空串/非 JSON/缺 coverage/缺 zeroGrowthRounds/非整数/负数/字符串类型 各抛 `TriggerBodyTerminationError`；bash 层 malformed body 非零退出且 stderr 点名 trigger_body/G4b |
| **R6** | capped 与 converged 仍然可区分 | `R6` 两条：64 卡（≥ maxClues）drained ⇒ `capped`（非 converged）；1 卡多轮零增长 ⇒ `converged`（非 capped） |
| **R7** | 全量 `npx vitest run` 全绿，文件数/用例数 ≥ 基线 | 三次 `21 files / 384 tests` 全绿（见下）。基线 `20 files / 363 tests`（input_commit 实测）→ 本包 `21 files / 384 tests`（+1 文件 +21 用例） |
| **R8** | 变异矩阵逐断言归因、回显被改行、全部还原后 git status --porcelain 干净 | 见下变异矩阵 + 还原证据 |
| **R9** | src/、test/、workflows/ 的每一处删除给出必要性说明 | 见上「既有测试的必要改动」；`src/` 零删除（仅加宽 import + 增计算）；tick.md 的 `%$'\n'` 与反引号注释移除属 bash 语法约束的必要项 |

### R7 —— 连跑 3 次输出

```
===== RUN 1 =====
 Test Files  21 passed (21)
      Tests  384 passed (384)
===== RUN 2 =====
 Test Files  21 passed (21)
      Tests  384 passed (384)
===== RUN 3 =====
 Test Files  21 passed (21)
      Tests  384 passed (384)
```

基线 `20 files / 363 tests`（input_commit `09b461c` 实测）→ 本包交付 `21 files / 384 tests`（+1 文件 +21 用例）。

## 变异矩阵（spec §3，逐断言归因）

| 变异 | 改什么 | 被杀断言 | 实测 |
|---|---|---|---|
| **S1** | 把 `runChannelWrite` 里 `prevZeroGrowthRounds: opts.prevZeroGrowthRounds ?? 0` 改成 `prevZeroGrowthRounds: 0`（恒传 0，= 回到改动前 §0.2） | **R2 主例挂**（三轮驱动第三轮 zeroGrowthRounds 仍为 1，state 仍为 null，断言 `toBe(2)` / `toBe("converged")` 失败） | `1 failed / 20 passed`（R2 主例） |
| **S2** | 让 `parseTerminationFromBody` 静默回落 0/0（去掉所有 throw，try/catch 返回 0/0） | **R5 的 8 条失败侧断言全挂**（不再抛 `TriggerBodyTerminationError`） | `8 failed / 13 passed`（R5 的 8 条 throw 期望） |
| **S3** | 让 `decideTermination` 在 coverage 增长时不重置 zeroGrowthRounds（`tick.ts:363` 改成恒 `prevZeroGrowthRounds + 1`） | **R3 挂**（cov 增长时 zgr 应为 0，实为 2，断言 `toBe(0)` 失败） | `1 failed / 20 passed`（R3） |

每次变异后已回显被改行（见上「改什么」列）、跑完即还原；**全部还原后** `git status --porcelain`
只剩本包应提交的文件，无残留（见下 R8 验证）。

## R8 —— 还原证据

全部变异还原后 `git status --porcelain` 输出（仅本包应提交的产品文件 + 新增测试 + dev-note，
无 `.dev-dispatch/**`、无 `.dd-evidence/`、无 `.bak` 残留）：

```
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
- `npm test` → 连跑 3 次 `21 files / 384 tests` 全绿。
- `.dev-dispatch/**` 全程字节未变；`.dd-evidence/` 未动。

## 非目标（未触碰）

- 未触发生成段（`decideGenerate` → `runGenerate`，归 G4c）。
- 未接导出 / anchor-check（归 G4d）；未做播种入口（归 G4e）。
- 未改 `profiles/deploy/*.env` 的 channel 取值（归 D2）。
- 未改 `decideTermination` / `computeCoverage` 的判定语义（已交付纯函数，本包只接线与持久化）。
- 未注册任何 bus 协议；未改 `agent-runtime`；未动 `tsconfig` 的 `include`。
