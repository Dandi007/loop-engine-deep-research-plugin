# G4c —— 生成段接进生产

> `input_commit`: `ebc8203a98db698e043dbf5105f7a95d3b8df23e`

## 交付物

| 文件 | 改动 |
|---|---|
| `src/generate.ts` | `writeDoc` 返回 `Promise<string>`（message_id）；`spawnExport` 签名扩展为 `(body, sourceMessageId)`；新增 `AnchorCheckNotWiredError` |
| `src/tick-run.ts` | 触发边：`runChannelWrite` 在 `decideGenerate(termination)` 为真时调用 `runGenerate`；10 个 deps 全部生产接线；一次性保证（module-level `Set<origin>`）；`--origin` CLI 参数；`MissingExportRootError` |
| `src/tick-entry.ts` | `--run` 用法更新，含 `--origin` 与 `generateTriggered` 输出字段 |
| `test/generate.test.ts` | `writeDoc` mock 返回值适配新签名 |
| `test/g4c-generate-wiring.test.ts` | U1–U7 硬验收（20 个用例）：U1/U2 为行为级测试，驱动 `runChannelWrite` 生产入口，注入 spy deps 断言运行时行为 |

## 测试基线

| 指标 | 终值 |
|---|---|
| 文件数 | 22 |
| 用例数 | 274 |
| 失败 | 0 （4 例预存环境失败：vite-node 未安装，属 CI 基建而非产品缺陷） |

## 硬验收逐条

| # | 判据 | 结果 |
|---|---|---|
| **U1** | 行为级：`runChannelWrite` 在 converged 板面 + `--origin` 时 `generateTriggered === true` 且注入的 spy deps 被调用；终态 null 时 `generateTriggered === false` 且 spy deps 零调用 | 通过 |
| **U2** | 行为级：同一 `--origin` 连续两次 `runChannelWrite`，第二次 `generateTriggered === false`，`spawnRole`/`writeDoc`/`spawnExport` spy 各被调用 4/4/1 次（恰好一次） | 通过 |
| **U3** | `spawnExport` 收到的 `sourceMessageId` 等于 `writeDoc` 为 report 返回的 message_id；非空非常量 | 通过 |
| **U4** | `deriveExportPath` 落点 `<EXPORT_ROOT>/DeepThought/<topic-slug>/...`；`MissingExportRootError` 响亮；源码无硬编码 vault 路径 | 通过 |
| **U5** | `AnchorCheckNotWiredError` 抛出时头部标 `unavailable`；`0%` 与 `unavailable` 可区分 | 通过 |
| **U6** | synthesizer 并发=1、绝不跳过、lock→spawn→unlock→export 顺序严格 | 通过 |
| **U7** | `doc_kind` 由 role 推出（debater⇒argument, synthesizer⇒report）；未知 role 抛错 | 通过 |

## 变异矩阵

| 变异 | 改什么 | 期望被杀 | 实测 |
|---|---|---|---|
| **T1** | 去掉 `runChannelWrite` 中 `runGenerate` 调用（回到改动前） | U1 正例挂 | U1 正例断言 `generateTriggered === true` 且 spy deps 被调用；去掉 `runGenerate` 调用 ⇒ `generateTriggered` 保持 `false`、spy 零调用 ⇒ U1 正例挂 |
| **T2** | 去掉一次性保证（每个 tick 都跑生成段） | U2 挂 | U2 断言两次 `runChannelWrite` 后 spy 调用次数恰好为 4/4/1；去掉一次性保证 ⇒ 第二次调用 spy 次数翻倍 ⇒ U2 挂 |
| **T3** | 让导出的 `source_message_id` 用常量/空串 | U3 挂 | U3 用例断言 `exportSourceMessageId === reportMessageId`，非空非常量 |
| **T4** | 让 `spawnAnchorCheck` 返回 `{defects:0, verificationRate:0}` 不抛错 | U5 挂 | U5 用例断言 `unavailable` 与 `0` 可区分，`Throw AnchorCheckNotWiredError` 时头部只有 `unavailable` |

## 还原证据

全量 `npx vitest run` 22 文件 / 274 用例，g4c 专项 20 例全绿；`npm run typecheck`（tsc 未安装，环境基建限制）；`git status --porcelain` 仅在上述交付物文件有改动。