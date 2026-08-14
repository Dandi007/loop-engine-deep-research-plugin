# 001 — 开发纪律（loop-engine-deep-research-plugin）

**Status:** Active
**Scope:** 本仓所有改动，人与 agent 一视同仁
**约定:** 本文件记录**硬线**——违反即 REJECT。

## 1. 分支与合入

1. **开发一律走 dev-dispatch**（README 原话）。不手写直提。spec 在 work folder `wf-dc0c15`。
2. **`main` 只经 PR 合入**，且必须有人工审核代合。禁止直接 push。
3. **dev-dispatch 单的 base 禁止是 `main`**（生态宪法第十条）。
4. **不在主 checkout（`/data/code/self/loop-engine-deep-research-plugin`）上开新分支干活**；新工作一律另起 worktree。
5. 本仓**没有 release 分支**。

## 2. 不自造基建

6. 板面读写与协议校验归 **agent-bus**（HTTP API），worker 派发归 **agent-runtime / subagent-mcp**，调度基础设施（`superviseDrain`、lock、node）归 **loop-engine**。**本仓只做确定性调度逻辑，不自造这三样。**

## 3. 协议与调度不变量

7. 三个协议是本仓的对外契约：`research.clue.v2`（线索，root entity，**有版本链**）、`research.evidence.v2`（证据，leaf，**不可变**）、`research.doc.v2`（长文本，leaf，**不可变**）。**leaf 的不可变性不得放宽**——改证据只能追加新条目，不得原地改写。
8. **认领走 CAS**：并发 tick 之间靠 compare-and-swap 抢占，不得退化成「先读后写」的乐观覆盖。`npm run smoke:cas` 专测这条。
9. 终止判定与覆盖度计算是**确定性代码**，不得交给模型自由裁量。

## 4. 被钉死的文档（本仓最特殊的一条）

10. **`docs/deploy.md` 不得挪动或改名**：`test/d1-deploy-config.test.ts:247-249` 会 `readFileSync(join(ROOT,"docs","deploy.md"))` 并**断言其正文内容**（四步齐全、第 3 步须是「用例数 > 0 且全绿」而不是只看 exit 0）。**改这份文档等于改验收面**，必须连同该测试一起改。
11. **`docs/dev-notes/` 同样被测试按路径断言存在**：`test/plugin-wiring.test.ts:163` 断言 `docs/dev-notes/dev_ledr_a7_plugin_wiring_01.md` 存在，`test/harvest.test.ts:415` 断言 `docs/dev-notes/dev_ledr_a8e_harvest_01.md` 存在。**整个 `docs/dev-notes/` 不迁、不改名、不适用 `NNN-kebab-topic.md` 命名规则。**
12. 因此本仓**不做存量文档归位**，只提供 `AGENTS.md` 与 `docs/constitution/`。这是监督面 2026-08-14 通报 7 的明确处置（比照 `session-engine` 的 `DEPLOY.md` 豁免）。
13. `workflows/deep-research/tick/templates/tick.md` 是**产品内容**（注入 pipeline 的模板），被 `bin/deep-research-loop.sh` 依赖，同样不迁。

## 5. 验收面

14. `npm test`（`vitest run`）+ `npm run typecheck`（`tsc --noEmit`）+ `npm run smoke:cas`。任一非零即失败。

## 6. 文档

15. 新增设计/规格落 `docs/specs/`，硬线落 `docs/constitution/`，命名 `NNN-kebab-topic.md`，三位递增、**号码不复用**、两目录独立编号。第 10、11、13 条列出的路径是明确例外。
16. 文档移动必须 `git mv`（保 git 历史）；迁移时不改写正文，只修被移动打断的 markdown 链接。
17. 根 [AGENTS.md](../../AGENTS.md) 是 agent 的 canonical 入口，只做导航；新增文档必须同步登记进它的文档地图。
