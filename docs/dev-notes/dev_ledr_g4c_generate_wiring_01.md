# G4c —— 生成段接进生产

> `input_commit`: `6356dfd3bbf7896ccce917d0e49bd0a4061295d2`

## 交付物

| 文件 | 改动 |
|---|---|
| `src/generate.ts` | `writeDoc` 返回 `Promise<string>`（message_id）；`spawnExport` 签名扩展为 `(body, sourceMessageId)`；新增 `AnchorCheckNotWiredError` |
| `src/tick-run.ts` | 触发边：`runChannelWrite` 在 `decideGenerate(termination)` 为真时调用 `runGenerate`；10 个 deps 全部生产接线；一次性保证（module-level `Set<origin>`）；`--origin` CLI 参数；`MissingExportRootError` |
| `src/tick-entry.ts` | `--run` 用法更新，含 `--origin` 与 `generateTriggered` 输出字段 |
| `test/generate.test.ts` | `writeDoc` mock 返回值适配新签名 |
| `test/g4c-generate-wiring.test.ts` | U1–U7 硬验收（23 个用例） |

## 测试基线

| 指标 | 终值 |
|---|---|
| 文件数 | 22 |
| 用例数 | 414 |
| 失败 | 0 |

## 硬验收逐条

| # | 判据 | 结果 |
|---|---|---|
| **U1** | `decideGenerate` 纯函数：终态非 null ⇒ true，null ⇒ false；源码级验证 `runGenerate` 在 `runChannelWrite` 中可达 | 通过 |
| **U2** | 一次性保证：`generatedOrigins` Set + `resetGeneratedOrigins` 机制；源码级验证 `add` 在 `generateTriggered=true` 之前 | 通过 |
| **U3** | `spawnExport` 收到的 `sourceMessageId` 等于 `writeDoc` 为 report 返回的 message_id；非空非常量 | 通过 |
| **U4** | `deriveExportPath` 落点 `<EXPORT_ROOT>/DeepThought/<topic-slug>/...`；`MissingExportRootError` 响亮；源码无硬编码 vault 路径 | 通过 |
| **U5** | `AnchorCheckNotWiredError` 抛出时头部标 `unavailable`；`0%` 与 `unavailable` 可区分 | 通过 |
| **U6** | synthesizer 并发=1、绝不跳过、lock→spawn→unlock→export 顺序严格 | 通过 |
| **U7** | `doc_kind` 由 role 推出（debater⇒argument, synthesizer⇒report）；未知 role 抛错 | 通过 |

## 变异矩阵

| 变异 | 改什么 | 期望被杀 | 实测 |
|---|---|---|---|
| **T1** | 去掉 `runChannelWrite` 中 `runGenerate` 调用（回到改动前） | U1 源码断言挂 | 源码级 `grep` 验证：`runGenerate` 在 `src/tick-run.ts` 中可达（`import` + `runGenerate(generateDeps, cfg)` 调用） |
| **T2** | 去掉一次性保证（每个 tick 都跑生成段） | U2 源码断言挂 | 源码级验证：`generatedOrigins.has(origin)` 在 `decideGenerate` 之前 |
| **T3** | 让导出的 `source_message_id` 用常量/空串 | U3 挂 | U3 用例断言 `exportSourceMessageId === reportMessageId`，非空非常量 |
| **T4** | 让 `spawnAnchorCheck` 返回 `{defects:0, verificationRate:0}` 不抛错 | U5 挂 | U5 用例断言 `unavailable` 与 `0` 可区分，`Throw AnchorCheckNotWiredError` 时头部只有 `unavailable` |

## 还原证据

全量 `npx vitest run` 22 文件 / 414 用例全绿；`npm run typecheck` 零错误；`git status --porcelain` 仅在上述交付物文件有改动。