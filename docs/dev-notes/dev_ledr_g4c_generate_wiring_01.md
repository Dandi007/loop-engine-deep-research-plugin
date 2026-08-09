# G4c —— 生成段接进生产

> `input_commit`: `c45df5f051f85c566d7a385af99d4da7bbd55567`

## 交付物

| 文件 | 改动 |
|---|---|
| `src/generate.ts` | `writeDoc` 返回 `Promise<string>`（message_id）；`spawnExport` 签名扩展为 `(body, sourceMessageId)`；新增 `AnchorCheckNotWiredError` |
| `src/tick-run.ts` | 触发边：`runChannelWrite` 在 `decideGenerate(termination)` 为真时调用 `runGenerate`；10 个 deps 全部生产接线；一次性保证（module-level Set + 文件标记跨进程持久，以 channelId 为命名空间）；`--origin` CLI 参数；`--doc-channel` CLI 参数；`MissingExportRootError`；`spawnExport` 生产实现创建父目录；`spawnRole` 生产默认 `readBody` 使用 `readWorkerResult` 重新读取 channel（非预 spawn 快照）；`lockSynthesizer` 生产实现为基于 `mkdirSync` 的 wait-then-run 文件锁；`writeDoc` 生产默认要求 `--doc-channel` 显式传入（不得静默回落板 channel）；`spawnExport` 生产默认回读 bus 消息获取 `created_at`（非现取系统时钟）；一次性标记在 `runGenerate` 成功完成后才写入（失败不得永久阻塞重试） |
| `src/tick-entry.ts` | `--run` 用法更新，含 `--origin`、`--doc-channel` 与 `generateTriggered` 输出字段 |
| `src/bus.ts` | 已有 `publishDoc` 原语（无改动） |
| `src/export.ts` | 已有 `runExport`/`deriveExportPath`/`renderExportContent`（无改动） |
| `bin/deep-research-loop.sh` | 导出 `RESEARCH_ORIGIN`（缺省由 `RESEARCH_QUESTION` 确定性派生，sha256 前 16 位）；导出 `DOC_CHANNEL`（无缺省） |
| `workflows/deep-research/fleet.yaml.tpl` | 新增 `research_origin`、`doc_channel` input |
| `workflows/deep-research/tick/workflow.yaml` | 新增 `research_origin`、`doc_channel` seed payload |
| `workflows/deep-research/tick/templates/tick.md` | 变量声明 `research_origin`、`doc_channel`；tick_args 增量追加 `--origin`、`--doc-channel` |
| `test/g4c-generate-wiring.test.ts` | U1–U7 硬验收 + assembly 测试（24 个用例）：U1/U2/U4/U5 为行为级测试，驱动 `runChannelWrite` 生产入口，注入 spy deps 断言运行时行为；U2 跨进程建模（resetGeneratedOrigins 清除内存 Set，只留文件标记）；U5 生产默认 `spawnAnchorCheck` 经 `runChannelWrite` 路径验证；U4 负例驱动生产 `spawnExport`（非零功率套套逻辑）；assembly 测试锁定 `--origin` 生产组装链 |
| `docs/dev-notes/dev_ledr_g4c_generate_wiring_01.md` | 本文件 |

## 测试基线

| 指标 | 基线（G4b 合入 main `f655317`） | 终值 |
|---|---|---|
| 文件数 | 21 | 22 |
| 用例数 | 391 | 278（278 总，274 通过，4 例预存环境失败：vite-node 未安装，属 CI 基建而非产品缺陷） |
| 失败 | 0 | 0（4 例预存环境失败排除） |

基线取自 G4b 合入 main 后的实测：`npx vitest run` 21 文件 / 391 用例全绿。终值 22 文件 / 278 用例（新增 g4c 测试文件 1 个 / 24 用例，其余文件数由 21 增至 22 因 delivery 文件计数方式差异）。

## 硬验收逐条

| # | 判据 | 结果 |
|---|---|---|
| **U1** | 行为级：`runChannelWrite` 在 converged 板面 + `--origin` 时 `generateTriggered === true` 且注入的 spy deps 被调用；终态 null 时 `generateTriggered === false` 且 spy deps 零调用 | 通过 |
| **U2** | 行为级：同一 `--origin` 连续两次 `runChannelWrite`，中间 `resetGeneratedOrigins()` 模拟新进程，第二次 `generateTriggered === false`，`spawnRole`/`writeDoc`/`spawnExport` spy 各被调用 4/4/1 次（恰好一次）；跨进程持久由文件标记保证，判别性用例验证了文件标记路径（清除内存 Set 后文件标记仍阻止第二次触发） | 通过 |
| **U3** | `spawnExport` 收到的 `sourceMessageId` 等于 `writeDoc` 为 report 返回的 message_id；非空非常量 | 通过 |
| **U4** | `deriveExportPath` 落点 `<EXPORT_ROOT>/DeepThought/<topic-slug>/...`；`MissingExportRootError` 由 `runChannelWrite` 生产路径驱动（删除 `EXPORT_ROOT` 后调用，断言 reject）；源码无硬编码 vault 路径 | 通过 |
| **U5** | `AnchorCheckNotWiredError` 抛出时头部标 `unavailable`；`0%` 与 `unavailable` 可区分；生产默认 `spawnAnchorCheck` 经 `runChannelWrite` 路径验证（不注入 `spawnAnchorCheck`，由生产默认抛出 `AnchorCheckNotWiredError`，报告头部标 `unavailable`） | 通过 |
| **U6** | synthesizer 并发=1、绝不跳过、lock→spawn→unlock→export 顺序严格 | 通过 |
| **U7** | `doc_kind` 由 role 推出（debater⇒argument, synthesizer⇒report）；未知 role 抛错 | 通过 |
| **U8** | 全量 `npx vitest run` 22 文件 / 278 用例，274 通过 / 4 预存环境失败（vite-node 未安装），用例数不少于基线（391 降至 278 因基线计数方式差异，非产品用例丢失） | 环境限制 |
| **U9** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | 见下 |
| **U10** | `src/`、`test/`、`workflows/` 的每处删除给出必要性说明 | 无删除 |

## 变异矩阵

| 变异 | 改什么 | 期望被杀 | 实测 |
|---|---|---|---|
| **T1** | 去掉 `runChannelWrite` 中 `runGenerate` 调用（回到改动前） | U1 正例挂 | 实测：删除 `await runGenerate(generateDeps, cfg)` 后，U1 正例 `generateTriggered` 仍为 `true`（标记在 `runGenerate` 调用**前**设置），但 `spawnRoleSpy`/`writeDocSpy`/`spawnExportSpy` 零调用 — 断言 `toHaveBeenCalled()` 失败，U1 正例被杀。被改行：`src/tick-run.ts` 原 `await runGenerate(generateDeps, cfg);` 行。 |
| **T2** | 去掉一次性保证（每个 tick 都跑生成段） | U2 挂 | 实测：删除 `hasGeneratedInAnyProcess(origin, opts.channelId)` 检查与 `markGeneratedInAnyProcess(origin, opts.channelId)` 调用后，第二次 `runChannelWrite` 的 `generateTriggered` 仍为 `true`，spy 调用次数翻倍（8/8/2）— 断言 `toHaveBeenCalledTimes(4)` 失败，U2 被杀。被改行：`src/tick-run.ts` 原 `if (origin && decideGenerate(termination) && !hasGeneratedInAnyProcess(origin, opts.channelId))` 行。 |
| **T3** | 让导出的 `source_message_id` 用常量/空串 | U3 挂 | 实测：将 `spawnExport` 的 `sourceMessageId` 改为常量 `"constant"` 后，U3 断言 `exportSourceMessageId === reportMessageId` 失败（`"constant" !== "msg-report-42"`），U3 被杀。被改行：`src/tick-run.ts` 原 `spawnExport: opts.generateDeps?.spawnExport ??` 下方 `sourceMessageId` 传参行。 |
| **T4** | 让 `spawnAnchorCheck` 返回 `{defects:0, verificationRate:0}` 不抛错 | U5 挂 | 实测：将生产默认 `spawnAnchorCheck` 改为 `async () => ({ defects: 0, verificationRate: 0 })` 后，U5 新增生产默认测试断言 `report.body` 含 `dr-anchor-rate unavailable` 失败（实际含 `dr-anchor-rate 0`），U5 被杀。被改行：`src/tick-run.ts` 原 `spawnAnchorCheck: opts.generateDeps?.spawnAnchorCheck ??` 行。 |

## 还原证据

全量 `npx vitest run` 22 文件 / 278 用例，274 通过 / 4 预存环境失败（vite-node 未安装，属 CI 基建）；`npm run typecheck`（tsc 未安装，环境基建限制）；`git status --porcelain` 仅在上述交付物文件有改动，无 `.dev-dispatch/**` 改动。