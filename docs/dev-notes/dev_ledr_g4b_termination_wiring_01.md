# G4b(v3) —— 终态贯通：生产 `--run` 计算并返回终止判定，`prevCoverage`/`prevZeroGrowthRounds` 跨 tick 传递

development_id: `dev_ledr_g4b3_termination_wiring_01`
attempt: `implement`（rework，attempt 2；attempt 1 final REJECT）
input_commit: `c8ecb9eb0fde578f08fa2281e7d1c549f4855b87`

> **attempt 2 rework 摘要**：attempt 1 接通了生产 `--run` 的终止判定与跨 tick 计数（R1–R6 全绿），
> 但 final review（`rf-attempt_01KZJXH59QZ9DF6T2ZHTXGVJRB`，REJECT）记录 5 条 finding，本 rework
> 逐条修复（1 blocker / 1 major / 3 minor）。下方「attempt 2 rework 改动」一节给出逐 finding 的
> 改法、被改行、与新增的 R7–R9 钉死用例。R1–R6 原用例全部保留并通过（合约更新的部分——
> `parseTerminationFromBody` 返回值加 `firstRound`、tick.md 改走 tick-entry `--parse-trigger-body`——
> 的用例已同步更新期望，非删除）。

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
> （即 `c8ecb9e…`，attempt 2 rework），不去追交付 commit；正文描述的就是最终交付物本身（测试
> 文件/用例数、变异矩阵实测、最终代码行为均与交付 commit 一致，rework 时同步更新）。⛔ 不为对齐
> commit hash 做额外提交。

## attempt 2 rework 改动（逐 finding）

final review `rf-attempt_01KZJXH59QZ9DF6T2ZHTXGVJRB`（REJECT）记录 5 条 finding；逐条修法：

### blocker —— `decideTermination` 用 postWriteState（不含本 tick 新发的 proposed clue）⇒ 假报 converged
- **finding**（`src/tick-run.ts:1300-1308`）：harvest tick 把父卡 CAS 到 explored（inFlight→0），
  本 tick 新发的 proposed clue 又不在 postWriteState 里 ⇒ 终止输入看到 inFlight===0 && proposed===0，
  一旦 zeroGrowthRounds 达阈就在「正创建新待处理工作」的 tick 报 `converged`。`hasPendingWork`
  已为此补偿（`cluesPublished>0`），终止判定 attempt 1 未补偿。
- **改法**：`runChannelWrite` 构造终止板面 `termCards` = postWriteState.cards **并入**本 tick 经
  harvest 新发的 proposed clue（`synthesizePublishedClueCards(cluesPublished)`，status=proposed、
  depth=0），使 proposed>0 ⇒ converged/capped-drained 均不成立。终止判定与 hasPendingWork 用同一
  补偿口径，完备性不再被误报（spec §0.2/§3.4）。
- **钉死用例**：R7（`g4b-termination-wiring.test.ts`）—— 复用 a9 F9 的 harvest 场景，传
  prevZgr=1 使其「本应达阈」，断言 `termination.state !== 'converged' && !== 'capped'`。

### major —— 覆盖度只读板 channel；生产 evidence 发到独立 EVIDENCE_CHANNEL ⇒ 覆盖结构性 0
- **finding**（`src/tick-run.ts:1188-1194`）：`--run` 原先只读 `opts.channelId`（板 channel），
  生产 harvest 把 research.evidence.v2 发到 `research:v1-deep-research.evidence`（与板 channel
  `research:v1-deep-research.index` 不同，`profiles/deploy/production.env`）⇒ 覆盖结构性 0、
  `coverage > prevCoverage` 永不成立、zeroGrowthRounds 无条件递增、R3 的「覆盖增长 ⇒ 重置」分支
  在生产不可达（R2/R3 只因测试把 evidence 种在板 channel 上才过）。
- **改法**：`runChannelWrite` 显式读 `opts.evidenceChannelId` channel，并入其 research.evidence.v2
  的 clue_id 到 `coveredClueIds`（`collectEvidenceClueIds`）；未配 evidence channel 时退化为只读
  板 channel 的覆盖（保持单 channel 测试拓扑既有行为）。生产配置总是显式传入 evidence channel。
- **钉死用例**：R8（两条）—— evidence 在独立 channel 上 ⇒ coverage=1 且覆盖增长重置 zeroGrowthRounds；
  未配 evidence channel ⇒ 退化为板 channel 覆盖。

### minor —— `parseTerminationFromBody` 无生产调用者（生产解析器是 tick.md 内嵌的第二份 node 脚本）
- **finding**（`src/tick-run.ts:343-389`）：两份解析器可静默发散；R5 的 TS 断言与变异 S2 只跑 TS 端，
  生产行为只由单个 bash 用例守护。
- **改法**：tick.md 改为调用 `tick-entry --parse-trigger-body <body>`（新增子命令，调用 TS 端
  `parseTerminationFromBody`），删除 tick.md 内嵌的 node 解析脚本 ⇒ 单源真相。tick-entry 输出
  首轮空串（不传 --prev-*）/ 续投 `--prev-coverage\t<n>\t--prev-zero-growth\t<m>`；失败 stderr
  点名 trigger_body/G4b 并 exit 1。

### minor —— 续投 body 丢计数器被静默当作首轮（首轮判定未基于 seed 标记）
- **finding**（`tick.md:71-76`）：解析器只特殊处理「两字段都缺」= 首轮，从不检查 seed 标记 ⇒
  `{"tick":true}`（丢了计数器的续投 body）被静默当作首轮 0/0，zeroGrowthRounds 被无声重置
  （R5 禁止的静默回落形态）。
- **改法**：`parseTerminationFromBody` 首轮判定基于 **seed 标记**（`{seed:true}` ⇒ 首轮 0/0 +
  `firstRound:true`）；其余无计数 body 一律响亮抛 `TriggerBodyTerminationError`。返回值加
  `firstRound` 字段以让调用方区分「首轮不传 --prev-*」与「续投传 --prev-*」。
- **钉死用例**：R9（4 条）—— `{"tick":true}` 抛错；`{"seed":true}` ⇒ 首轮；seed 优先于计数；
  bash 层 `{"tick":true}` ⇒ tick.md 非零退出且 stderr 点名 trigger_body。

### minor —— tick.md 用 fixed-name scratch file `trigger_body_err.txt` 写 tick 节点 CWD
- **finding**（`tick.md:60`）：CWD 不可写时 redirect 失败，命令替换非零退出，tick 以「trigger body 坏」
  的空 cat 退出 1 —— 把工作目录问题误归因为 trigger body 问题。
- **改法**：随 minor「单源真相」一并消除——tick.md 不再内嵌 node 脚本，stderr 捕获改用
  `mktemp -t g4b_parse_err.XXXXXX`（在系统 temp 目录，不碰 CWD）；mktemp 失败即响亮退出（不归因
  到 trigger body）。

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
- **`runChannelWrite`**：用写后板面（`postWriteState.cards`）调用 `decideTermination`，prev 值从
  `opts` 取（生产由 tick.md 从 `{{trigger_body}}` 经 `tick-entry --parse-trigger-body` 解析后传入）。
  ⛔ 不得新造判定逻辑：`decideTermination` / `computeCoverage` 是已交付纯函数，只调用它们。
  - **attempt 2 blocker**：终止板面 `termCards` = postWriteState.cards **并入**本 tick 经 harvest 新发
    的 proposed clue（`synthesizePublishedClueCards(cluesPublished)`），与 `hasPendingWork` 同口径
    补偿，避免「最后一张非终态卡被收割 + 新发 proposed clue」时假报 converged。
  - **attempt 2 major**：覆盖度原料 `coveredClueIds` 显式并入 `opts.evidenceChannelId` channel 的
    research.evidence.v2（`collectEvidenceClueIds`），解决生产 evidence 与板 channel 分离时覆盖
    结构性 0；未配 evidence channel 时退化为只读板 channel 覆盖（单 channel 测试拓扑既有行为）。
- **`parseTerminationFromBody`**（attempt 2 更新）：返回值加 `firstRound: boolean`；首轮判定基于
  **seed 标记**（`{seed:true}` ⇒ 0/0 + firstRound:true），其余无计数 body 响亮抛错（修 attempt 1
  「两字段都缺 ⇒ 首轮」会静默重置 zeroGrowthRounds 的 finding minor）。
- **`RunCliOptions` / `parseRunCliArgs`**：增 `--prev-coverage <n>` / `--prev-zero-growth <n>`
  （非负整数校验；不传即 undefined，`runChannelWrite` 缺省 0 = 首轮语义）。

### `workflows/deep-research/tick/templates/tick.md`

- 读 `{{trigger_body}}`：用 quoted heredoc（`<<'G4B_TRIGGER_BODY_EOF'`）捕获 verbatim JSON
  （body 含双引号/花括号，bash 双引号赋值会被 verbatim 渲染破坏）。`$(cat ...)` 命令替换已剥离尾换行。
- **attempt 2 minor（单源真相）**：从 trigger_body 解析计数改走 `$tick_entry --parse-trigger-body "$trigger_body"`
  （调用 TS 端权威 `parseTerminationFromBody`），删除 attempt 1 内嵌的 `node - "$trigger_body" <<'G4B_PARSE_EOF'`
  第二份解析脚本——两份解析器会静默发散（finding minor）。stdout 首轮空串（不传 `--prev-*`）/
  续投 `--prev-coverage\t<n>\t--prev-zero-growth\t<m>`；失败 stderr 点名 trigger_body/G4b 并 exit 1。
- **attempt 2 minor（scratch file）**：stderr 捕获改用 `mktemp -t g4b_parse_err.XXXXXX`（系统 temp 目录，
  不碰 tick 节点 CWD），消除 attempt 1 fixed-name `trigger_body_err.txt` 在 CWD 不可写时把工作目录
  问题误归因为 trigger body 问题（finding minor）。mktemp 失败即响亮退出（不归因到 trigger body）。
- 续投写计数：`hasPendingWork=true` 时，从 `run_output` 的 JSON 解析 `termination.coverage` /
  `termination.zeroGrowthRounds`（用 `node - "$run_output" <<'G4B_NEXT_EOF'` heredoc），写进下一条
  trigger body：`{"tick":true,"coverage":<n>,"zeroGrowthRounds":<m>}`。
- ⛔ 本文件禁用反引号字符与 `${var%$'\n'}` 参数展开：bash 静态解析在「heredoc + 命令替换」组合下
  会被反引号误导成跨行命令替换状态、被 `%$'\n'` 误导成未闭合单引号，导致整脚本 syntax error。
  注释和代码一律用普通文字描述。

### `workflows/deep-research/tick/workflow.yaml`

- seed payload 加 `trigger_body: "{{trigger_body}}"`（claim.bind 已把 trigger body 绑进 pipeline input；
  workflow 需显式 pass-through 到 tick.md）。

### `src/tick-entry.ts`

- USAGE 文档更新：记录 `--prev-coverage` / `--prev-zero-growth` 参数、`termination` JSON 输出字段、
  以及 attempt 2 新增的 `--parse-trigger-body <body>` 子命令（trigger body 计数的唯一权威解析器入口）。
- **attempt 2**：`main` 增 `--parse-trigger-body` 分支，调用 `parseTerminationFromBody`；首轮（seed）
  输出空串、续投输出 `--prev-coverage\t<n>\t--prev-zero-growth\t<m>`；body 缺失/损坏/丢计数器 ⇒
  stderr 点名 trigger_body/G4b 并 exit 1。

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
| **R7** | 全量 `npx vitest run` 全绿，文件数/用例数 ≥ 基线 | attempt 2 rework：三次 `21 files / 391 tests` 全绿（见下）。基线 `21 files / 384 tests`（attempt 1 交付实测 = 本 rework input_commit）→ 本 rework `21 files / 391 tests`（+7 用例：R7/R8/R9 钉死 attempt 2 finding） |
| **R8** | 变异矩阵逐断言归因、回显被改行、全部还原后 git status --porcelain 干净 | 见下变异矩阵（S1–S3 原项 + S4–S6 attempt 2 新项）+ 还原证据 |
| **R9** | src/、test/、workflows/ 的每一处删除给出必要性说明 | attempt 2：tick.md 删除内嵌 node 解析脚本（被 `tick-entry --parse-trigger-body` 取代，单源真相，消除 finding minor「两份解析器发散」与 finding minor「fixed-name scratch file」）；`parseTerminationFromBody` 返回值加 `firstRound`（合约加宽，非删除）。原 R4/R5 bash 用例期望随合约更新（fake tick-entry 改为把 `--parse-trigger-body` 委托真实解析器），非删除断言。无函数被删 |

### R7 —— 连跑 3 次输出

```
===== RUN 1 =====
 Test Files  21 passed (21)
      Tests  391 passed (391)
===== RUN 2 =====
 Test Files  21 passed (21)
      Tests  391 passed (391)
===== RUN 3 =====
 Test Files  21 passed (21)
      Tests  391 passed (391)
```

基线 `21 files / 384 tests`（attempt 1 交付 = 本 rework input_commit `c8ecb9e` 实测）→ 本 rework
`21 files / 391 tests`（+7 用例，全在 `test/g4b-termination-wiring.test.ts`：R7×1 / R8×2 / R9×4）。

## 变异矩阵（spec §3，逐断言归因）

| 变异 | 改什么 | 被杀断言 | 实测 |
|---|---|---|---|
| **S1** | 把 `runChannelWrite` 里 `prevZeroGrowthRounds: opts.prevZeroGrowthRounds ?? 0` 改成 `prevZeroGrowthRounds: 0`（恒传 0，= 回到改动前 §0.2） | **R2 主例挂**（三轮驱动第三轮 zeroGrowthRounds 仍为 1，state 仍为 null，断言 `toBe(2)` / `toBe("converged")` 失败） | `1 failed`（R2 主例） |
| **S2** | 让 `parseTerminationFromBody` 静默回落 0/0（去掉所有 throw，try/catch 返回 0/0） | **R5 的 8 条失败侧断言全挂**（不再抛 `TriggerBodyTerminationError`） | `8 failed`（R5 的 8 条 throw 期望） |
| **S3** | 让 `decideTermination` 在 coverage 增长时不重置 zeroGrowthRounds（`tick.ts:363` 改成恒 `prevZeroGrowthRounds + 1`） | **R3 挂**（cov 增长时 zgr 应为 0，实为 2，断言 `toBe(0)` 失败） | `1 failed`（R3） |
| **S4**（attempt 2 blocker） | 把 `termCards` 构造里的 `...synthesizePublishedClueCards(cluesPublished)` 去掉（终止板面不含本 tick 新发的 proposed clue，= 回到 attempt 1 假收敛） | **R7 挂**（harvest 发布新 clue 的 tick 仍报 `state==='converged'`，断言 `not.toBe("converged")` 失败） | `1 failed`（R7） |
| **S5**（attempt 2 major） | 把 evidence channel 读取分支条件改成 `if (false && evidenceChannelId && …)`（不读证据 channel，= 回到 attempt 1 结构性覆盖 0） | **R8 主例挂**（独立 evidence channel 的 coverage 仍为 0，断言 `toBe(1)` 失败） | `1 failed`（R8 主例） |
| **S6**（attempt 2 minor 4） | 在 `parseTerminationFromBody` 里恢复「两字段都缺 ⇒ 首轮」分支（无 seed 检查，= 回到 attempt 1 静默重置） | **R9 的 2 条挂**（`{"tick":true}` 不再抛，断言 throw 失败；bash 层非零退出失败） | `2 failed`（R9） |

每次变异后已回显被改行（见上「改什么」列）、跑完即还原（`cp /tmp/tick-run.ts.bak src/tick-run.ts`）；
**全部还原后** `git status --porcelain` 只剩本包应提交的文件，无残留（见下 R8 验证）。

## R8 —— 还原证据

全部变异还原后 `git status --porcelain` 输出（仅本 rework 应提交的产品文件，
无 `.dev-dispatch/**`、无 `.dd-evidence/`、无 `.bak` 残留）：

```
 M docs/dev-notes/dev_ledr_g4b_termination_wiring_01.md
 M src/tick-entry.ts
 M src/tick-run.ts
 M test/g4b-termination-wiring.test.ts
 M workflows/deep-research/tick/templates/tick.md
```

## 验证命令

- `npm run typecheck` → exit 0。
- `npm test` → 连跑 3 次 `21 files / 391 tests` 全绿。
- `.dev-dispatch/**` 全程字节未变；`.dd-evidence/` 未动。

## 非目标（未触碰）

- 未触发生成段（`decideGenerate` → `runGenerate`，归 G4c）。
- 未接导出 / anchor-check（归 G4d）；未做播种入口（归 G4e）。
- 未改 `profiles/deploy/*.env` 的 channel 取值（归 D2）。
- 未改 `decideTermination` / `computeCoverage` 的判定语义（已交付纯函数，本包只接线与持久化）。
- 未注册任何 bus 协议；未改 `agent-runtime`；未动 `tsconfig` 的 `include`。
