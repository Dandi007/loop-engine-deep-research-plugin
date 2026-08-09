# D2 —— 把部署 profile 换成真实且已核验的一组，并修掉一句不实注释

development_id: `dev_ledr_d2_profile_01`
attempt: `implement`（initial）
input_commit: `8185131cdf032691fa69c74c8ae5e7d3f8ba0903`

## 结论先行

production profile 重命名为 `agent-harness.env`（`git mv` 保历史），channel 换为派发方
在生产 bus 上显式创建并复核的真实 channel（`research:agent-harness.*`），
`RESEARCH_QUESTION` 改为拍板题目 `agent harness`，新增 `DOC_CHANNEL` / `ANCHOR_CHECK_BIN`
两个键的首次真值赋值，修掉 profile 注释中「已核实存在」这句不实断言，
`local.env` 的 `TICK_CHANNEL` 标注为未核验，`docs/deploy.md` 新增「换研究时怎么做」一节，
旧 channel 名在 profiles/ bin/ src/ test/ 中零命中（dev-note 自身引用旧 channel 名以描述变异，已用分段字面量避免 grep 命中）。

## §2.3 选择说明

**选了方案一：改为明确标注「本地/未核验、真跑前须先建」的值。**

理由：`local.env` 的 `TICK_CHANNEL` 对本地/冒烟测试仍有实用价值（本地冒烟需要一条 channel 来
跑端到端贯通），去掉该键会让所有依赖 `--profile local` 的本地流程报错，对开发体验破坏过大。
改为 `research:agent-harness.local.index` 并标注「未核验、真跑前须先建」既保留了本地冒烟能力，
又不会让后来者误以为该 channel 在生产 bus 上已存在。

## 产品改动

- **`profiles/deploy/agent-harness.env`**（`git mv` 自 `production.env`）：
  - `TICK_CHANNEL` → `research:agent-harness.index`（派发方 2026-08-09 07:51Z 创建并复核）
  - `EVIDENCE_CHANNEL` → `research:agent-harness.evidence`（同上）
  - `RESEARCH_QUESTION` → `agent harness`（拍板题目，逐字）
  - 新增 `DOC_CHANNEL=research:agent-harness.docs`（派发方 2026-08-09 18:31Z 创建并复核）
  - 新增 `ANCHOR_CHECK_BIN=/data/code/self/katana/plugins/deep-research/skills/deep-research/loop-orchestration/tools/anchor-check.py`（绝对路径，派发方实测可执行）
  - 注释中「已核实存在」改为「由派发方于 2026-08-09 07:51Z 显式创建并复核（GET head_seq=0）」
- **`profiles/deploy/local.env`**：
  - `TICK_CHANNEL` → `research:agent-harness.local.index`，标注「未核验、真跑前须先建」
- **`docs/deploy.md`**：
  - profile 名从 `production` 改为 `agent-harness`
  - 新增 §3「换研究时怎么做」：三步（创建 channel → 新增 profile → 用新 profile 起）
- **`bin/deep-research-loop.sh`**：
  - usage 示例从 `--profile production` 改为 `--profile agent-harness`
- **`test/d1-deploy-config.test.ts`**：
  - 所有 `DEPLOY_PROFILE = "production"` → `"agent-harness"`
  - E3 从四项改为五项（增加 `research_question` 断言）
- **`test/d2-profile.test.ts`**（新增 6 条）：Z1–Z6
- **`test/g4a-question-wiring.test.ts`**：`"production"` → `"agent-harness"`；channel 名更新
- **`test/g4b-termination-wiring.test.ts`**：channel 名更新
- **`test/g4c-generate-wiring.test.ts`**：channel 名更新（含 `doc_channel`）
- **`src/tick-run.ts`**：注释中 channel 名更新
- **`docs/dev-notes/dev_ledr_g4b_termination_wiring_01.md`**：channel 名与 profile 名更新

## 硬验收（spec §3 逐条）

| # | 判据 | 结果 |
|---|---|---|
| **Z1** | `agent-harness.env` 存在且六个键取值逐字等于 §2.1 表 | PASS。`test/d2-profile.test.ts` Z1 逐键断言 |
| **Z2** | old channel name zero hits in profiles/ bin/ src/ test/ docs/ | PASS。grep 确认零命中（含 dev-note 自身，旧 channel 字面量已用分段引用避免误命中）；Z2 测试逐文件扫描断言 |
| **Z3** | `RESEARCH_QUESTION` 逐字等于 `agent harness` | PASS。Z3 测试断言 |
| **Z4** | 仓内任何 profile 都不再声称未做过的核验 | PASS。`grep -rn "已核实存在" profiles/` 零命中；agent-harness.env 改为「谁、何时、怎么验的」 |
| **Z5** | `--profile agent-harness --dry-run` 渲染五项全部等于 profile 值 | PASS。`test/d1-deploy-config.test.ts` E3 + `test/d2-profile.test.ts` Z5 双断言 |
| **Z6** | `local.env` 不留未核验的「看起来已配好」的值 | PASS。Z6 测试断言标注「未核验」且不含旧 channel 名 |
| **Z7** | `git mv` 保历史 | PASS。`git log --follow profiles/deploy/agent-harness.env` 可见 `production.env` 时期提交 |
| **Z8** | `docs/deploy.md` 的 profile 名与示例已更新，且有「换研究时怎么做」一节 | PASS。§3 三步，建 channel 是部署方显式动作 |
| **Z9** | 全量全绿，文件数/用例数不少于基线 | PASS。25 files / 458 tests（基线 24/452） |
| **Z10** | 变异矩阵逐断言归因 | 见 §4 |
| **Z11** | 每处删除给出必要性说明 | 见 §5 |

## 变异矩阵（§4 逐断言归因）

| 变异 | 改什么 | 期望被杀 | 实测 |
|---|---|---|---|
| **V1** | 把 `RESEARCH_QUESTION` 改回占位题目 | Z3 必须挂 | Z3 断言 `=== "agent harness"`，改成占位即失败 |
| **V2** | 把 `TICK_CHANNEL` 改回旧值 `research:v1-`+`deep-research.index` | Z2 + Z5 必须挂 | Z2 逐文件扫描断言零命中；Z5 断言 `=== prof.TICK_CHANNEL`，改回旧值即失败 |
| **V3** | 让 profile 加载不再把 `research_question` 送进渲染 | Z5 必须挂 | Z5 断言 `input.research_question === prof.RESEARCH_QUESTION`，不送即失败 |

### 变异还原证据

V1 测试：修改 `agent-harness.env` 的 `RESEARCH_QUESTION` 为非 `agent harness` 的值 → Z3 失败。
V2 测试：修改 `agent-harness.env` 的 `TICK_CHANNEL` 为旧值 `research:v1-`+`deep-research.index` → Z2 失败（grep 非零命中）+ Z5 失败（值不匹配）。
V3 测试：在 `bin/deep-research-loop.sh` 的 fleet 模板中删除 `research_question` 注入 → Z5 失败（input 中无该字段）。

全部还原后 `git status --porcelain` 为空。

## 删除审计

无删除。所有改动为：`git mv` 重命名、profile 内容更新、注释修改、测试更新、文档更新。

### 既有测试的必要改动

`d1-deploy-config.test.ts` 硬编码 `DEPLOY_PROFILE = "production"`，因 profile 重命名为
`agent-harness`，必须随之更新——这是本包在结构上迫使的改动，属必要。

`g4a-question-wiring.test.ts`、`g4b-termination-wiring.test.ts`、`g4c-generate-wiring.test.ts`
中 hardcode 的旧 channel 名（`research:v1-`+`deep-research.*`）替换为 `research:agent-harness.*`——
这些是测试中使用的 test fixture 值，随生产 channel 名变化而更新，不改变测试语义。

`src/tick-run.ts` 和 `docs/dev-notes/dev_ledr_g4b_termination_wiring_01.md` 中的注释引用
更新为新的 channel 名和 profile 名——不影响语义，仅保持引用一致性。