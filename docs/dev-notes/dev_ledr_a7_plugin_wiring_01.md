# dev_ledr_a7_plugin_wiring_01 —— A7 插件装配

## 产品改动

把链 A 的六个能力包（S1b/S2/S3/S4/N1/N3）接成 loop-engine 可加载的插件形态。
本包交付的是「接线存在且能解析」，不是真实端到端跑通（真实启动连 bus 属 V1，本包不做、也不声称做到）。

- **新增 `src/tick-entry.ts`**（可执行入口，CLI）：
  - `--help` / `--selfcheck` 均为无副作用调用：不发网络、不写 store、不触 bus（spec G6/G7）。
  - 只**import `./tick`** 复用已交付的 `decideTick` / `decideTermination` / `DEFAULT_TICK_CONFIG`，
    **不重新实现**任何决策逻辑（spec G9）。
- **新增 `bin/tick-entry.sh`**：tick 入口的 bash 包装，干净环境下用 `vite-node` 调起 `src/tick-entry.ts`。
- **新增 `workflows/deep-research/fleet.yaml.tpl`**：fleet 定义，`max_passes` + 单个 `tick` pipeline（spec G2）。
- **新增 `workflows/deep-research/tick/workflow.yaml`**：`limits` / `harness` / `seed` 节点定义（spec G3/G4）。
- **新增 `workflows/deep-research/tick/templates/tick.md`**：可执行体（bash harness），调起 tick 入口自检。
- **新增 `bin/deep-research-loop.sh`**：驱动脚本，渲染 tpl → 调 loop-engine CLI；`--dry-run` 只渲染不跑引擎（spec G1）。
- **新增 `scripts/render-template.mjs`**：`${ENV_VAR}` 占位符渲染器（任一缺失即失败）。
- **`package.json`**：补 `main` / `exports` 指向 `src/tick-entry.ts`，增加 `tick` / `deep-research:dry-run` 等 scripts（spec G8）。
- **新增 `test/plugin-wiring.test.ts`**：覆盖 G1–G9 / G11（一个 describe 一个判据，spec §5.1）。
- **架构裁定（spec §1）**：clue 状态不落 loop-engine 的 `store_dir`；claim 的 store 只承载周期
  trigger 记录，不引用 clue/board 语义（spec G5）。数据持久化归宿仍是 agent-bus，FS 仅作临时/工作面。

## 硬验收映射

| # | 断言 | 覆盖 |
|---|---|---|
| G1 | `bin/deep-research-loop.sh --dry-run` exit 0 且无网络请求 | `G1 dry-run exits 0 without network` |
| G2 | 渲染 fleet 合法 YAML，含 `max_passes` 与非空 `pipelines` | `G2 rendered fleet is valid YAML...` |
| G3 | 每个 `config_dir` 真实存在且含 `workflow.yaml` | `G3 each rendered config_dir...` |
| G4 | `seed[].template` 指向的模板文件真实存在 | `G4 seed template files exist on disk` |
| G5 | 无 `clue.*store_dir` / `store_dir.*clue` | `G5 rendered fleet carries no...` |
| G6 | tick 入口干净环境下可调起（--help exit 0） | `G6 tick entry invocable in clean env` |
| G7 | 无副作用调用不触碰 bus（指向不可达地址不失败） | `G7 no-side-effect call does not touch bus` |
| G8 | `package.json` 暴露入口且路径真实存在 | `G8 package.json exposes a real entry path` |
| G9 | tick 入口 import `./tick`，决策原语各 1 份实现 | `G9 tick entry reuses src/tick...` |
| G10 | 未改 `.dd-evidence/` | git diff 校验为空 |
| G11 | 运行证据写 `docs/dev-notes/<development_id>.md`，仓根无 `IMPLEMENTATION_SUMMARY.md` | `G11 running evidence...` |
| G12 | `npm run typecheck` 与 `npm test` 均 exit 0 | 派发面 acceptance |
| G13 | 既有 127 条用例一行未删 | git diff 校验无 `it(` 净减少 |

## 变异自检归因

| 变异 | 被杀断言 |
|---|---|
| U1 某 `config_dir` 改成不存在的路径 | G3 |
| U2 `seed[].template` 改成不存在的名字 | G4 |
| U3 给某 pipeline 加承载 clue 状态的 `claim.store_dir` | G5 |
| U4 `exports` 指向不存在的文件 | G8 |
| U5 tick 入口自己重写 `decideTick` 而非 import | G9 |
| U6 `--dry-run` 分支加真实网络请求 | G1 |

## 验收

- `npm run typecheck` —— exit 0
- `npm test` —— 127 条既有用例 + 新增 plugin-wiring 用例全绿
- `bash bin/deep-research-loop.sh --dry-run` —— exit 0，渲染 fleet 合法
- `bash bin/tick-entry.sh --help` / `--selfcheck` —— exit 0，不发网络、不触 bus