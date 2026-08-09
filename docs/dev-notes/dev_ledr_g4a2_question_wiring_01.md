# G4a(v2) —— `--question` 生产贯通：研究主问题从部署配置到 tick-entry --run

development_id: `dev_ledr_g4a2_question_wiring_01`
attempt: `implement`（initial）
input_commit: `5bc91fa6a3c9234fc040a8251d1d296dcd26825b`

## 结论先行

研究主问题从部署配置一路贯通到 `tick-entry --run --question`：
`bin/deep-research-loop.sh`（export + 无缺省响亮失败）→ `fleet.yaml.tpl`（pipeline input）
→ `tick/workflow.yaml`（payload）→ `tick.md`（增量拼 argv）→ `--question`。
`profiles/deploy/{production,local}.env` 各加 `RESEARCH_QUESTION` 键。
新增 `test/g4a-question-wiring.test.ts`（15 条，Q1–Q4，含 8 种组合矩阵）。
全量 `20 files / 363 tests` 连跑 3 次全绿（基线 19/348 之上）。

> 按 spec §5 更正后的 dev-note 要求：`input_commit` 记录本次 implement attempt 的
> `input_commit`（即 `5bc91fa6…`），不去追交付 commit；正文描述的就是最终交付物本身
> （测试文件/用例数、变异矩阵实测、最终代码行为均与交付 commit 一致，rework 时同步更新）。

## 产品改动

- **`bin/deep-research-loop.sh`**：在 `TICK_CHANNEL` 响亮失败块之后，加
  `export RESEARCH_QUESTION="${RESEARCH_QUESTION:-}"` + 空值响亮失败（exit 3，错误消息点名
  `RESEARCH_QUESTION`，说明「编造或推导的缺省会让整场研究跑偏，且 bus 写入不可回退」）。
- **`workflows/deep-research/fleet.yaml.tpl`**：pipeline input 加 `research_question: ${RESEARCH_QUESTION}`
  （与 `max_writes` 同级）。
- **`workflows/deep-research/tick/workflow.yaml`**：seed payload 加 `research_question: "{{research_question}}"`。
- **`workflows/deep-research/tick/templates/tick.md`**：加 `research_question="{{research_question}}"`；
  把 4 分支组合树重构为增量拼 argv（数组累加后一次调用，用 `if` 块避免 `set -e` 下
  `[ … ] && …` 假时非零终止脚本）；`run_output` 捕获与后续 `hasPendingWork` 判定逐字不变。
- **`profiles/deploy/{production,local}.env`**：**只加 `RESEARCH_QUESTION` 键**，channel 取值一字不改。
- **`test/g4a-question-wiring.test.ts`**（新增 15 条）：Q1–Q4。

### 既有测试的必要改动（非删除；spec §4「只加一个参数的贯通」）

`RESEARCH_QUESTION` 改为「无缺省、未配置即响亮失败」后，所有**裸跑** `bin/deep-research-loop.sh`
的既有用例都必须显式提供 `RESEARCH_QUESTION`（否则在入口被响亮失败拦下）。改动方式**仅在
execFile 的 env 里补一个测试 question**，不删任何断言：

- `test/plugin-wiring.test.ts`：`dryRun()` 与 A8e 渲染补 `RESEARCH_QUESTION`；A8e 的
  `tick.md` 逐行断言随重构更新（`--run "$tick_channel" --evidence-channel …` 同行为断言改为
  `tick_args+=(--evidence-channel "$evidence_channel")` 增量断言）。
- `test/a9-tick-trigger.test.ts`：F2/F4/F5 的 `runDriver`、渲染补 `RESEARCH_QUESTION`。
- `test/a10c-writebudget.test.ts`：`renderedDefaultMaxWrites()`、三处渲染补 `RESEARCH_QUESTION`；
  D3 的「tick.md 四条分支都带 --max-writes」断言随重构改为「增量拼 argv、单调用点、--max-writes
  始终追加」。
- `test/a8f-adddir.test.ts`：F1 渲染补 `RESEARCH_QUESTION`。
- `test/a10b-convergence.test.ts`：`renderFleet`、`runRealE2E`、B1-guard、B6 并发渲染补
  `RESEARCH_QUESTION`。
- `test/d1-deploy-config.test.ts`：`RESEARCH_QUESTION` 加入 `RELEVANT_ENV`（`cleanChildEnv` 清理）；
  E4「内置缺省」一例补 `RESEARCH_QUESTION`。

**Q8 —— src/、test/、workflows/ 的删除**：本包**未删除任何函数或断言**；`src/` 零改动。
唯一「删除」是 `tick.md` 的 4 分支组合树 → 增量拼 argv（spec §1.2 明示该重构为本包必要项），
且以「单调用点」断言锁定，属必要而非误删。

## 硬验收（spec §2 逐条）

| # | 判据 | 证据 |
|---|---|---|
| Q1 | 从生产入口渲染，fleet tick pipeline input 有 question 字段且等于配置值 | `Q1` 四条断言 + 手动 `--profile production --dry-run` 渲染出 `research_question: 光伏并网系统的谐波特性与治理策略研究` |
| Q2 | ⛔ 真贯通：渲染出的 tick.md + 假 tick-entry 记录 argv，断言 `--question` 及其值在 argv | `Q2` 用例（`expect(argv).toContain("--question")` + 紧邻值）——不是只验 fleet input |
| Q3 | ⛔ 无内置缺省：不设 env 且无 profile ⇒ 非零退出 + 点名变量；不得出现推导/编造问题 | `Q3` 两例 + 手动 `exit=3` 点名 `RESEARCH_QUESTION`/`Refusing`，错误消息无编造问题串 |
| Q4 | ⛔ 组合矩阵：evidence/allowed/question 三者全 8 种组合，argv 只含该有的参数 | `Q4` 参数化 `it.each` 8 组合 |
| Q5 | 可达性判据说明（不是额外用例） | 见 Q2：证据是「从生产入口到达 tick-entry argv」，模块支持/渲染有值不构成可达性 |
| Q6 | 全量 `npx vitest run` 全绿，≥ 19/348 | 三次 `20 files / 363 tests` 全绿（见下） |
| Q7 | 变异矩阵逐断言归因、回显被改行、全部还原后 `git status --porcelain` 干净 | 见下变异矩阵 |
| Q8 | src/、test/、workflows/ 每处删除给出必要性说明 | 见上「既有测试的必要改动」；`src/` 零改动 |

### Q6 —— 连跑 3 次输出

```
===== RUN 1 =====
 Test Files  20 passed (20)
      Tests  363 passed (363)
===== RUN 2 =====
 Test Files  20 passed (20)
      Tests  363 passed (363)
===== RUN 3 =====
 Test Files  20 passed (20)
      Tests  363 passed (363)
```

基线 `19 files / 348 tests`（H0 现状）→ 本包交付 `20 files / 363 tests`（+1 文件 +15 用例）。

## 变异矩阵（spec §3，逐断言归因）

| 变异 | 改什么 | 被杀断言 | 实测 |
|---|---|---|---|
| **P1** | 生产 `tick.md` 去掉 `--question` 传参（删 `if [ -n "$research_question" ]; then tick_args+=(--question …); fi`） | **Q2 挂**（`--question` 不在 argv）；⛔ **Q1 仍绿**（fleet input 仍有 question）——证明 Q1 单独存在是零功率 | `5 failed / 10 passed`（Q2 + 4 个 Q4 question=true 组合） |
| **P2** | 给 `RESEARCH_QUESTION` 编内置缺省（`${RESEARCH_QUESTION:-研究主问题缺省}`） | **Q3 失败侧挂**（不再响亮失败） | `1 failed / 14 passed` |
| **P3** | 只在 evidence 与 allowed 都有的那一支传 `--question`（`if [ -n "$evidence_channel" ] && [ -n "$allowed_root" ] && …`） | **Q4 挂**（组合分支漏一支的真实形态） | `3 failed / 12 passed`（question=true 且 evidence/allowed 不同时为真的组合） |

每次变异后已回显被改行（见上「改什么」列）、跑完即还原；**全部还原后**
`git status --porcelain` 只剩本包应提交的文件，无残留（见下 Q7 验证）。

## Q7 —— 还原证据

还原后 `git status --porcelain` 输出（仅本包应提交的产品文件 + 新增测试 + dev-note，
无 `.dev-dispatch/**`、无 `.dd-evidence/`）：

```
 M bin/deep-research-loop.sh
 M profiles/deploy/local.env
 M profiles/deploy/production.env
 M test/a10b-convergence.test.ts
 M test/a10c-writebudget.test.ts
 M test/a8f-adddir.test.ts
 M test/a9-tick-trigger.test.ts
 M test/d1-deploy-config.test.ts
 M test/plugin-wiring.test.ts
 M workflows/deep-research/fleet.yaml.tpl
 M workflows/deep-research/tick/templates/tick.md
 M workflows/deep-research/tick/workflow.yaml
?? docs/dev-notes/dev_ledr_g4a2_question_wiring_01.md
?? test/g4a-question-wiring.test.ts
```

## 验证命令

- `npm run typecheck` → exit 0。
- `npm test` → 连跑 3 次 `20 files / 363 tests` 全绿。
- `.dev-dispatch/**` 全程字节未变；`.dd-evidence/` 未动。

## 非目标（未触碰）

- 未做终态贯通 / 生成段 / 导出 / anchor-check / 播种入口（归 G4b–G4e）。
- 未改 `profiles/deploy/*.env` 的 channel 取值（归 D2）；未注册 bus 协议；未改 `agent-runtime`；
  未动 A9 续投 / `hasPendingWork` 判定；未做端到端真跑真 bus（归 Phase 6）；未动 `tsconfig` 的 `include`。
