# AGENTS.md — loop-engine-deep-research-plugin

deep-research 的**确定性调度引擎插件**（loop-engine plugin）：clue 板面读写、CAS 认领、调度 tick、覆盖度计算、终止判定、生成阶段编排。

## 关键入口

- **插件入口**：`src/tick-entry.ts`（`package.json` 的 `main` / `exports`）。
- **常用命令**：`npm run tick`、`tick:help`、`tick:selfcheck`、`tick:seed`（均为 `vite-node src/tick-entry.ts -- ...`）。
- **驱动脚本**：`bin/deep-research-loop.sh`。**workflow 与模板**：`workflows/deep-research/`。**profile**：`profiles/`。
- **验收**：`npm test`（vitest）、`npm run typecheck`、**`npm run smoke:cas`**（CAS 认领专测，`vitest.smoke.config.ts`）。
- **协议**：`research.clue.v2`（线索，有版本链）、`research.evidence.v2`(证据，leaf 不可变)、`research.doc.v2`（长文本，leaf 不可变）。
- **依赖的既有基建**：agent-bus（板面读写与协议校验）、agent-runtime / subagent-mcp（worker 派发）、loop-engine（`superviseDrain`、lock、node）。本仓不自造这三样。
- spec 在 work folder `wf-dc0c15`；开发一律走 dev-dispatch。详见 [README.md](README.md)。

## 文档地图

命名 `NNN-kebab-topic.md`，三位递增、号码不复用；`docs/specs/` 与 `docs/constitution/` 独立编号。

**[`docs/constitution/`](docs/constitution/)** —— 硬线、纪律、不变量，违反即 REJECT。

- [001 开发纪律](docs/constitution/001-development-discipline.md) —— 开发走 dd、不自造基建、**协议与 CAS 不变量**、**被测试钉死的文档**、验收面、文档纪律

**`docs/specs/`** —— 设计与规格。**当前无条目**：设计 SSoT 在 work folder `wf-dc0c15`。

**其他（被测试按路径钉死，明确不迁、不适用 `NNN-` 命名）**

- [docs/deploy.md](docs/deploy.md) —— 部署四步。`test/d1-deploy-config.test.ts:247-249` 读它并**断言正文内容**，改它等于改验收面。
- [`docs/dev-notes/`](docs/dev-notes/) —— 32 份 dd 单实施笔记。其中 `dev_ledr_a7_plugin_wiring_01.md` 与 `dev_ledr_a8e_harvest_01.md` 被 `test/plugin-wiring.test.ts:163`、`test/harvest.test.ts:415` 断言存在。
- `workflows/deep-research/tick/templates/tick.md` —— 产品内容（注入 pipeline 的模板），被 `bin/deep-research-loop.sh` 依赖。

## 开发纪律

细则见 [docs/constitution/001-development-discipline.md](docs/constitution/001-development-discipline.md)，要点：

- **开发一律走 dev-dispatch**，不手写直提；`main` 只经人工审核代合，禁止直接 push。
- **dev-dispatch 单的 base 禁止是 `main`**（生态宪法第十条）。
- 不在主 checkout 上开分支干活，新工作起独立 worktree。本仓无 release 分支。
- **不自造总线 / 派发 / 调度**：分别归 agent-bus、agent-runtime、loop-engine。
- **evidence 与 doc 是不可变 leaf**，改证据只能追加，不得原地改写；clue 才有版本链。
- **认领必须走 CAS**，不得退化成先读后写；`smoke:cas` 专测这条。
- 终止判定与覆盖度是确定性代码，不交模型自由裁量。
- **`docs/deploy.md` 与 `docs/dev-notes/` 被测试钉死**：不迁、不改名，改 `deploy.md` 必须连同 `test/d1-deploy-config.test.ts` 一起改。
- 文档移动必须 `git mv` 保历史；新增文档同步登记进上面的文档地图。
