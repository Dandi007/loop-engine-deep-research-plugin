# G4a —— `--question` 生产贯通：第五次「组件支持、生产不传」

development_id: `dev_ledr_g4a_question_wiring_01`
attempt: `implement`（rework，继承前次实现提交；修复 Q8 证据完整性的 input_commit 同步）
input_commit: `fd9299fd5b0efbb6dbf6db1f35203243924f66c1`

## 根因（spec §0，逐条 grep 到行号）

`--question` 已被 CLI 解析（`src/tick-run.ts:1279` parseRunCliArgs）、被 usage 记录
（`src/tick-entry.ts:41,50`）、被引擎依赖（triage 决策缺 question ⇒ `MissingTriageQuestionError`，
`src/tick-run.ts:674-678`），但生产装配链 `bin/deep-research-loop.sh` → `fleet.yaml.tpl` →
`tick.md` **从不传**（bin 与 fleet grep question 零命中）⇒ V2 端到端一旦跑到 triage 就停在
第一个 triage 决策。这是「组件支持而生产模板不接线」的第五次同形复现（前四次：max-writes、evidence、
allowed-root、tick）。

## 修复（照 `MAX_WRITES` 已经走通的那条形状，不另发明）

研究主问题从部署配置一路贯通到 `tick-entry --run --question`：

```
bin/deep-research-loop.sh  (export RESEARCH_QUESTION + 无内置缺省响亮失败)
  → workflows/deep-research/fleet.yaml.tpl  (input.research_question: ${RESEARCH_QUESTION})
    → workflows/deep-research/tick/workflow.yaml  (seed payload research_question)
      → workflows/deep-research/tick/templates/tick.md  (增量拼 argv → --question "$research_question")
        → "$tick_entry" --run <channel> … --question "<研究主问题>"
```

### 1. 无内置缺省、未配置即响亮失败（spec §1.1）
- `bin/deep-research-loop.sh`：`export RESEARCH_QUESTION="${RESEARCH_QUESTION:-}"`；未由 profile 或
  显式 env 提供 ⇒ 响亮失败拒绝启动（点名 `RESEARCH_QUESTION` + 理由：编出的缺省问题会让整场研究跑偏，
  bus append-only 不可回退）。**绝不**从 channel 名 / topic slug 推导问题字符串（同 EVIDENCE_CHANNEL 判据）。
- `profiles/deploy/production.env` / `local.env`：**只加该变量的键**，取值用占位说明（未改 channel 取值）。

### 2. tick.md 分支树 → 增量拼 argv（spec §1.2）
`tick.md` 原本是 `evidence_channel × allowed_root` 的 **4 分支组合树**；再加 question 会变 8 分支。
改为**增量拼 argv**（`tick_args=("$tick_entry" --run "$tick_channel")` 起步，逐参数追加后一次调用）：
`--evidence-channel` / `--allowed-root` / `--max-writes` / `--question` 各按「有则追加、无则不加」。
`set -euo pipefail` 下数组空值安全；**`run_output` 捕获与 `hasPendingWork` 续投判定逐字不变**（A9 不碰）。

## 硬验收（spec §2 逐条）

| # | 判据 | 证据 |
|---|---|---|
| **Q1** | 从生产入口渲染：只设 profile/env、`--dry-run`，fleet tick input 有 question 字段且等于配置值 | `test/g4a-question-wiring.test.ts` `Q1`：显式 env 与 `DEPLOY_PROFILE=production` 两例，渲染出的 `input.research_question` 等于配置值 |
| **Q2** | ⛔ 真正的贯通断言：渲染 `tick.md` + 假 `tick-entry` 记录 argv，断言 `--question` 及其值真出现在 argv | `Q2`：`argv.indexOf("--question")` 的下一项等于注入的研究问题；`--max-writes` 仍并排贯通（重构未丢） |
| **Q3** | ⛔ 无内置缺省：不设相关 env 且无 profile ⇒ 非零退出且错误消息点名该变量；且不得出现推导/编造问题串 | `Q3` 三例：无 env 无 profile ⇒ 非零 + 点名 `RESEARCH_QUESTION`；错误消息不含 `research:v1`（无编造）；正例显式 env ⇒ exit 0 |
| **Q4** | ⛔ 组合矩阵：`evidence_channel` / `allowed_root` / `question` 有/无全部 8 种组合，argv 只含该有的参数 | `Q4` 参数化 8 例：`--question` / `--evidence-channel` / `--allowed-root` 各「有⇒有、无⇒无」，`--max-writes` 恒在 |
| **Q5** | ⭐ 可达性断言：从生产入口出发证明 question 到达 tick-entry | 见 Q2（渲染 `tick.md` 即生产装配产物，假 tick-entry 记录 argv 是判别证据） |
| **Q6** | 全量 `npx vitest run` 全绿，文件数/用例数 ≥ 基线 19/348 | `20 files / 363 tests` 全绿（基线 19/348，新增 1 文件 15 用例）；`npm run typecheck` 通过 |
| **Q7** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 仅含本包产物 | 见下变异矩阵；还原后干净 |
| **Q8** | `src/`、`test/`、`workflows/` 的每一处删除给出必要性说明 | `src/` **零删除**；`workflows/.../tick.md` 的 4 分支树改写为增量 argv 属 spec §1.2 明示必要重写；`test/` 无删除（既有用例仅因「新必填 env / 新结构」作等价改写） |

### 既有测试的必要改动（非删除；Q8）

新增必填 env `RESEARCH_QUESTION`（无内置缺省、未配置即响亮失败）后，所有裸跑
`bin/deep-research-loop.sh` 的既有用例必须在 execFile 的 env 里补一个测试问题（否则在入口被
响亮失败拦下）：`a10b-convergence`（renderFleet / B6 / runRealE2E / B1-guard）、`a9-tick-trigger`
（F2/F3 / F4 / F5 / F6）、`a10c-writebudget`（renderedDefaultMaxWrites / D3 / G1-D1）、
`a8f-adddir`（F1 渲染）、`plugin-wiring`（dryRun / A8e 渲染）、`d1-deploy-config`
（RELEVANT_ENV + 内置缺省例）。

`tick.md` 分支树→增量 argv 重构后，原断言「4 条 `--run` 分支」的**结构**不再成立，作等价改写
（不删判据意图）：
- `a10c-writebudget`：`--max-writes` 断言改为断言 `tick_args+=(--max-writes "$max_writes")`。
- `plugin-wiring`：`--run "$tick_channel"` / `--evidence-channel` 断言改为断言
  `tick_args=("$tick_entry" --run "$tick_channel")` 与 `tick_args+=(--evidence-channel "$evidence_channel")`。

## 变异矩阵（spec §3，逐断言归因）

| 变异 | 改什么 | 期望被杀 | 实测 |
|---|---|---|---|
| **P1** | 生产 `tick.md` 去掉 `--question` 传参（其余不动） | **Q2 必须挂**；⛔ **Q1 应当仍绿**（证明 Q1 单独存在零功率） | ✅ 移除 `tick_args+=(--question …)` 后 `-t` 全量：Q2 的 `--question` 断言挂，且 Q4 中 question=true 的 4 例挂；**Q1 仍绿**（正是本包要证明的） |
| **P2** | 给研究主问题编一个内置缺省值（`RESEARCH_QUESTION:-<编造值>` 且删响亮失败） | **Q3 失败侧必须挂** | ✅ 改默认 + 删响亮失败后：Q3 两例否定断言（非零退出点名 / 无编造串）均挂 |
| **P3** | 只在 `evidence_channel` 与 `allowed_root` 都有的那一支传 `--question`（`&&` 收紧条件） | **Q4 必须挂** | ✅ 条件改为三者皆有才追加后：Q4 中 question=true 且 evidence/allowed 不全有的 4 例挂 |

**还原证据**：每轮变异前 `cp tick.md /tmp/tick.md.bak`、`cp bin /tmp/bin.bak`，变异验证后逐字还原；
全部还原后 `npm run typecheck` 通过、`npx vitest run` 20/363 全绿、`git status --porcelain`
仅含本包预期产物（见交付），无残留。

## 验证命令

- `npm run typecheck` → exit 0。
- `npm test`（`npx vitest run`）→ `20 files / 363 tests` 全绿（基线 19/348）。
- `.dev-dispatch/**` 全程字节未变；`.dd-evidence/` 未动。

## 非目标（未触碰）

- 未接生成段（G4b）、未接导出（G4c）；未改 `profiles/deploy/*.env` 的 channel 取值（归 D2）。
- 未注册任何 bus 协议；未端到端真跑真 bus（归 Phase 6）。
- 未动 A9 续投逻辑 / `hasPendingWork` 判定；未动 `tsconfig` 的 `include`；未改 `agent-runtime`。

## 交付物

- 实现：`bin/deep-research-loop.sh`、`workflows/deep-research/fleet.yaml.tpl`、
  `workflows/deep-research/tick/workflow.yaml`、`workflows/deep-research/tick/templates/tick.md`
- 配置：`profiles/deploy/production.env`、`profiles/deploy/local.env`（只加 RESEARCH_QUESTION 键）
- 测试：`test/g4a-question-wiring.test.ts`（Q1–Q4，15 用例）+ 既有测试的必要等价改写
- 证据：本文件
