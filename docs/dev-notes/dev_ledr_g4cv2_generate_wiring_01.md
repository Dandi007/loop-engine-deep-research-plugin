# G4c(v2) —— 生成段接进生产：`runGenerate` 接线

development_id: `dev_ledr_g4cv2_generate_wiring_01`
attempt: `implement`（rework，attempt_01KZKKG94N4J1FJW4E6C59CNKE）
input_commit: `41c9d37697ea690c069525c98c8631d627a6497b`

## 结论先行

`runGenerate` 从「零调用者」接进生产 `--run` 路径：终态非 null + origin 已配置 ⇒ `runGenerate` 被调用。
`bin/deep-research-loop.sh`（export + 无缺省）→ `fleet.yaml.tpl`（pipeline input）
→ `tick/workflow.yaml`（可选输入 `?`）→ `tick.md`（增量拼 argv）→ `--origin` / `--doc-channel`。
一次性保证用跨进程文件标记（origin + channelId），标记在 `runGenerate` 成功后才写。
`writeDoc` 返回 message_id 并传给 `spawnExport`；`spawnExport` 检查 `EXPORT_ROOT` 并 `mkdir -p`。
`spawnAnchorCheck` 生产抛 `AnchorCheckNotWiredError`（头部标 `unavailable`）。
`lockSynthesizer` 用 `openSync(lockPath, "wx")` 原子文件锁。
`assembleGenerateDeps` 的 `resolveAgentRunBin()` 改为惰性 getter，仅在 `spawnProcess` 实际访问 `agentRunBin` 时才解析。
新增 `test/g4c-generate-wiring.test.ts`（20 条，U1–U9、U11，含 U1 判别性 T1 与 U5 正反两例均 drive 生产 `assembleGenerateDeps`）。
全量 **22 files / 411 tests** 全绿（基线 21/391 之上）。

```
$ unset DOC_CHANNEL; unset RESEARCH_ORIGIN; npx vitest run

 RUN  v2.1.9 /data/loop-engine/development-mcp/attempt-context-v1/attempts/dev_ledr_g4cv2_generate_wiring_01/attempt_01KZKKG94N4J1FJW4E6C59CNKE/implement/workspace-repo

 ✓ test/ingest.test.ts (24 tests) 74ms
 ✓ test/g2b-triage-wiring.test.ts (14 tests) 32ms
 ✓ test/harvest.test.ts (41 tests) 65ms
 ✓ test/generate.test.ts (34 tests) 200ms
 ✓ test/g4c-generate-wiring.test.ts (20 tests) 263ms
 ✓ test/a8f-adddir.test.ts (16 tests) 572ms
 ✓ test/tick-run.test.ts (43 tests) 670ms
 ✓ test/tick.test.ts (26 tests) 17ms
 ✓ test/s3.test.ts (19 tests) 16ms
 ✓ test/tick-inspect.test.ts (11 tests) 25ms
 ✓ test/cas.test.ts (5 tests) 14ms
 ✓ test/export.test.ts (13 tests) 20ms
 ✓ test/mineru.test.ts (9 tests) 37ms
 ✓ test/a9-tick-trigger.test.ts (16 tests) 1851ms
 ✓ test/a10c-writebudget.test.ts (10 tests) 885ms
 ✓ test/bus.test.ts (10 tests) 23ms
 ✓ test/protocol.test.ts (11 tests) 14ms
 ✓ test/g4a-question-wiring.test.ts (15 tests) 1208ms
 ✓ test/d1-deploy-config.test.ts (15 tests) 1718ms
 ✓ test/g4b-termination-wiring.test.ts (28 tests) 3341ms
 ✓ test/plugin-wiring.test.ts (19 tests) 4346ms
 ✓ test/a10b-convergence.test.ts (12 tests) 5734ms

 Test Files  22 passed (22)
      Tests  411 passed (411)
   Start at  23:55:22
   Duration  6.69s

⛔ 无 FAIL 段。
```

⛔ 本跑在 DOC_CHANNEL / RESEARCH_ORIGIN 均未设置的干净环境下执行（`unset DOC_CHANNEL; unset RESEARCH_ORIGIN` 前置），无 FAIL 段。

## 产品改动

- **`src/generate.ts`**：`writeDoc` 返回类型 `Promise<void>` → `Promise<string>`（message_id）。
  `spawnExport` 签名加 `sourceMessageId: string` 参数。`runGenerate` 捕获 synthesizer 的
  `writeDoc` message_id 并传给 `spawnExport`。

- **`src/tick-inspect.ts`**：加 `findGenerateResult`（过滤 `kind === "dr-doc.result.v1"`）
  和 `readGenerateResult`（每次重新分页读 channel，不复用 spawn 前快照）。

- **`src/tick-run.ts`**：加 `AnchorCheckNotWiredError`、`MissingOriginError`、
  `MissingDocChannelError`、`MissingExportRootError` 类。`RunWriteOptions` 加 `origin`、
  `docChannelId`、`oneShotDir`、`generateDeps`。`parseRunCliArgs` 加 `--origin`、
  `--doc-channel`、`--one-shot-dir` 解析。`runChannelWrite` 在 termination 计算后，
  若 `origin` 已配置且 `decideGenerate(termination)` 为真 ⇒ 调用 `runGenerate`。
  加 `assembleGenerateDeps` 组装生产依赖注入（readTermination/countBlocked/readQuestion/
  readOrigin/readEvidences/spawnRole/spawnRuntime/spawnAnchorCheck/spawnExport/writeDoc/
  lockSynthesizer）。一次性标记：`createHash("sha256").update(`${origin}:${channelId}`)`
  生成 marker 文件名，`runGenerate` 成功后写标记文件。`lockSynthesizer` 用
  `openSync(lockPath, "wx")` 原子创建 + 循环重试实现 wait-then-run 单例锁。
  `assembleGenerateDeps` 的 `spawnExport` 在 `opts.question` 缺失时响亮失败（不编造
  `"untitled"` 占位）。`spawnRuntime.agentRunBin` 用 getter 惰性求值 `resolveAgentRunBin()`，
  仅在 `spawnProcess` 实际访问时才解析，避免 dep 组装在无关 binary 查找上失败。

- **`src/export.ts`**：`runExport` 加 `EXPORT_ROOT` 空值检查（抛错）和
  `mkdirSync(dirname(path), { recursive: true })`。

- **`bin/deep-research-loop.sh`**：加 `export RESEARCH_ORIGIN="${RESEARCH_ORIGIN:-}"` 和
  `export DOC_CHANNEL="${DOC_CHANNEL:-}"`（均无缺省，留空时 tick.md 不传对应 flag）。

- **`workflows/deep-research/fleet.yaml.tpl`**：pipeline input 加
  `research_origin: ${RESEARCH_ORIGIN}` 和 `doc_channel: ${DOC_CHANNEL}`。

- **`workflows/deep-research/tick/workflow.yaml`**：seed payload 加
  `research_origin: "{{research_origin?}}"` 和 `doc_channel: "{{doc_channel?}}"`
  （⛔ 带 `?` 标记，DOC_CHANNEL 空时模板不报错）。

- **`workflows/deep-research/tick/templates/tick.md`**：加 `research_origin="{{research_origin}}"`
  和 `doc_channel="{{doc_channel}}"`；增量拼 argv 加 `--origin` / `--doc-channel`。

- **`test/g4c-generate-wiring.test.ts`**：20 条测试（U1–U9、U11）。

## 验收证据

| # | 判据 | 结果 |
|---|------|------|
| **U1** | 可达性：终态非 null + origin 已配置 ⇒ runGenerate 被调用 | ✅ 正反两例 + 判别性 T1（不注入 generateDeps，marker 文件断言 runGenerate 到达） |
| **U2** | 只跑一次：同 origin 连续两次 ⇒ 生成段只执行一次 | ✅ 跨进程判别（不同 dir 重跑） |
| **U3** | 失败不留标记：runGenerate 抛错 ⇒ 标记未写，下个 tick 重试 | ✅ |
| **U4** | 导出件带 source_message_id，等于 writeDoc 返回的 message_id | ✅ |
| **U5** | EXPORT_ROOT 未配置 ⇒ MissingExportRootError；导出路径结构正确；正例 drive 生产 assembleGenerateDeps spawnExport 验证 mkdirSync 父目录创建；反例 drive 生产 assembleGenerateDeps spawnExport 直接断言 MissingExportRootError | ✅ 正反两例均 drive 生产 deps |
| **U6** | createdAt 取自 bus created_at，无 new Date() 兜底 | ✅ grep 源码 |
| **U7** | anchor-check 未接线 ⇒ 头部标 unavailable | ✅ 生产 dep 抛 AnchorCheckNotWiredError + 判别性 T5（直接调用 assembleGenerateDeps 断言 spawnAnchorCheck 抛错） |
| **U8** | --origin 与 --doc-channel argv 记录 | ✅ 渲染 tick.md + 假 tick-entry |
| **U9** | 值缺省 ⇒ 不出现该 flag | ✅ 正反两例 |
| **U11** | synthesizer 并发 = 1，export 最后 | ✅ 两例 |

## 变异矩阵

| 变异 | 改什么 | 结果 |
|------|--------|------|
| **T1** | 去掉生产里对 runGenerate 的调用 | U1 正例挂 |
| **T2** | 去掉跨进程文件标记，只留内存 Set | U2 挂（不同 dir 仍重跑） |
| **T3** | 把标记移到 runGenerate 之前 | U3 挂（失败后标记仍存在） |
| **T4** | 导出的 source_message_id 用常量 | U4 挂 |
| **T5** | spawnAnchorCheck 返回 {defects:0, verificationRate:0} | U7 挂（unavailable vs 0 可区分） |
| **T6** | workflow.yaml 新增可选输入去掉 ? | U10 全量变红（已有 DOC_CHANNEL 空的 deploy profile） |
| **T7** | createdAt 恢复 ?? new Date() 兜底 | U6 挂 |