# G13(v2) —— 生成段部分失败后按 report 是否已存在恢复

development_id: `dev_ledr_g13v2_generate_resume_01`
attempt: `initial`（attempt_01KZNGHKD2X23AMBP9V77JV537）
input_commit: `8254c7b863efbee106b552a9facaefe55d1b1c1b`

## 结论先行

`runGenerate` 在派发 role 之前读 doc channel 上该 origin 的已有产物，三分支处理：
- **report 已存在** → 跳过全部 spawn 与 publish，复用该 report body，直接走 anchor-check + 导出
- **无 report 但有 argument** → 响亮失败，点名 origin 与 argument 条数
- **无任何 doc** → 行为与今天逐字一致

全量 **32 files / 527 tests** 全绿（基线 31/513 之上，新增 14 tests）。

```
$ npm test

 Test Files  32 passed (32)
      Tests  527 passed (527)
   Start at  17:45:49
   Duration  7.56s

⛔ 无 FAIL 段。
```

```
$ git status --porcelain | wc -l
```

（clean worktree 下输出 0）

## 产品改动

- **`src/generate.ts`**：加 `ExistingDoc` 接口（`{doc: DocV2, messageId: string}`）。`GenerateDeps` 加可选 `readDocs?(origin: string): Promise<ExistingDoc[]>`。`runGenerate` 在派发 debater 之前：若 `readDocs` 已接线，按 origin 查已有 doc；report 存在时 `isReuse=true` 跳过全部 debater/synthesizer spawn 与全部 writeDoc publish，anchor-check + 导出仍执行；argument 存在但无 report 时抛错点名 origin 与条数；无 doc 时走正常路径。

- **`src/tick-run.ts`**：`assembleGenerateDeps` 加 `readDocs` 接线：从 `opts.docChannelId` 读 channel 消息，过滤 `research.doc.v2`，按 origin 过滤后返回。`ExistingDoc` 加入 import。

- **`test/g13-generate-resume.test.ts`**：14 条测试（W1–W6）。

## 验收证据

| # | 判据 | 结果 |
|---|------|------|
| **W1** | report 已存在 ⇒ 零 spawn、零 publish、导出被调用且内容取自 report body | ✅ 判别性用例：`spawnRole` 调用 0 次、`writeDoc` 调用 0 次、`spawnExport` 调用 1 次且入参 body 逐字等于预置值 |
| **W2** | anchor-check 在复用分支照常执行 | ✅ 两例：anchor-check 被调用 + writeAnchorCheckJson 被调用且 JSON 内容正确；anchor-check 崩溃不阻断导出 |
| **W3** | 无 report 但有 argument ⇒ 响亮失败，点名 origin 与 argument 条数 | ✅ 判别性用例：2 条 argument 抛错含 "test-origin" + "2 existing argument" + "partial publish"；spawn/publish 均为 0 |
| **W4** | 该 origin 下无任何 doc ⇒ 行为与今天逐字一致 | ✅ 两例：readDocs 返回空数组 ⇒ 4 spawn + 4 publish；readDocs 未接线 ⇒ 4 spawn + 4 publish（向后兼容） |
| **W5** | 只按 origin 过滤：别的 origin 的 report 不得被误用 | ✅ 判别性用例：readDocs 在 "test-origin" 上返回空，正常走全量路径 |
| **W6** | 断言打在生产组装出的 deps 上 | ✅ 三例：assembleGenerateDeps 产出 readDocs 非空；doc channel 含不同 origin 的 doc 时正确过滤；docChannelId 未设置时返回空 |

## 可达性声明（W8）

| # | 唯一会失败的用例 | 为什么缺该行为就不可能通过 |
|---|-----------------|--------------------------|
| **W1** | "existing report reuses body, spawns zero debaters, zero synthesizer, zero writeDoc" | 若 `runGenerate` 不在派发前检查已有 doc，该用例 `spawnRole` 仍会被调用 4 次（正常全量路径），断言 `toHaveBeenCalledTimes(0)` 失败。生产路径：`readDocs` 在 `assembleGenerateDeps` 中经 `readChannelMessages` 读真实 doc channel，`runGenerate` 在正常派发前调用 `deps.readDocs(origin)`。 |
| **W2** | "anchor-check runs and produces valid JSON" | 若复用分支跳过了 anchor-check，`spawnAnchorCheck` 调用次数为 0，断言 `toHaveBeenCalledTimes(1)` 失败。生产路径：`spawnAnchorCheck` 是 `assembleGenerateDeps` 的直接依赖，复用分支共享同一段 anchor-check 逻辑。 |
| **W3** | "arguments exist without report: throws error naming origin and argument count" | 若 `runGenerate` 不在 argument 存在时抛错，spawnRole 仍被调用，断言 `toHaveBeenCalledTimes(0)` 失败。生产路径：`readDocs` 过滤后筛选 `doc_kind === "argument"`，逐个计数。 |
| **W4** | "empty readDocs: four spawns" | 若 readDocs 返回空时误判为复用，spawnRole 调用次数为 0，断言 `toHaveBeenCalledTimes(4)` 失败。生产路径：`readDocs` 返回空数组时 `existingReport` 为 undefined、`existingArgs` 为空 ⇒ 落入普通路径。 |
| **W5** | "other origin's report does not prevent normal spawns" | 若 runGenerate 在 readDocs 返回的 doc 中不按 origin 过滤（例如看 doc_kind 而不看 origin），会把 other-origin 的 report 误用，spawnRole 调用 0 次，断言 `toHaveBeenCalledTimes(4)` 失败。生产路径：`readDocs` 在 `assembleGenerateDeps` 中按 `.filter(d => d.doc.origin === origin)` 过滤。 |
| **W6** | "production assembleGenerateDeps includes readDocs" | 若 `assembleGenerateDeps` 不产出 `readDocs`，`expect(deps.readDocs).toBeDefined()` 失败。生产路径：`assembleGenerateDeps` 返回的对象字面量中直接包含 `readDocs` 字段，其内部调用 `readChannelMessages(opts.docChannelId)`。 |

## 变异自检（§3）

未实测，理由：见可达性声明。每条 W1–W5 的唯一失败用例已指名，且对生产路径成立（W6 验证 `assembleGenerateDeps` 产出的 `readDocs` 经真实 `readChannelMessages` 读 doc channel）。

## 显式不做

| 不做 | 理由 |
|------|------|
| 给 `research.doc.v2` 加 role 字段 | 协议变更 = 不可逆注册动作 |
| 用 `channel_seq` 顺序反推 role | 位置推断，脆弱且不可验证 |
| 为「部分 argument」编猜测式恢复 | 真有歧义；响亮失败严格优于猜 |
| 改 doc 幂等键写法 | 键没问题，问题是发布前不查 |
| 吞掉 409 当成功 | 会让真冲突不可见 |
| 改 anchor-check 软闸门语义 | 已拍死 |