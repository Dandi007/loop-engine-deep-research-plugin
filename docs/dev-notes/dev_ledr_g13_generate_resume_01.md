# G13 —— 生成段可恢复：按 (role, origin) 查已有 doc 并复用

- `input_commit`: `cde5928f67c4c12c290600b0f6ac3815976ac851`

## 实现

### `src/protocol.ts`

- `DocV2` 新增 `role: string` 字段：产出该 doc 的 agent role，用于 (role, origin) 复用查找。
  三个 debater 角色（advocate/opponent/judge）各自产出不同的 `role` 值，即使 `doc_kind` 同为 `"argument"` 也能区分。

### `src/generate.ts`

- `buildDoc` 在构造 `DocV2` 时写入 `role` 字段。
- `runGenerate` 在派 role 之前先按 (role, origin) 查已有 doc：
  - 已存在 ⇒ 直接用其 body，不 spawn、不 publish。
  - 不存在 ⇒ 走现有路径（spawn → publish）。
  - synthesizer doc 已存在时跳过 lock+spawn+publish，但仍执行 anchor-check 与导出。
  - `readDoc` 未提供时行为不变（向后兼容）。
- 移除 resumed-synthesizer 分支中的死计算（`anchorRate`/`anchorTail`/`anchorJsonWritten` 在已复用分支中从不使用，因为 synthBody 已带有持久化的头部）。

### `src/tick-run.ts`

- `assembleGenerateDeps` 的 `readDoc` 实现改为按 `(role, origin)` 匹配（检查 `payload.role === role && payload.origin === origin`），不再使用 `deriveDocKind(role)` 推导的 `doc_kind` 做 match。
- 移除 `deriveDocKind` 导入（不再使用）。
- `spawnExport` 中的 `DocV2` 构造加入 `role: "dr-synthesizer"`。

### `src/ingest.ts`

- `transcribeMaterial` 中加入 `role: "dr-transcriber"` 以适配 `DocV2` 新增字段。

### `test/g13-generate-resume.test.ts`（16 tests）

- W6 新增 `readDoc discriminates role among multiple argument docs for the same origin`：将两条不同 role 的 argument doc 放入同一 origin 的 fake bus，验证生产 `readDoc` 能正确区分角色、返回对应 body，且未出现的角色返回 null。
- `docMsg` 辅助函数签名更新为 `(messageId, role, docKind, origin, body, channelSeq)`，payload 包含 `role` 字段。
- 所有 mock `readDoc` 返回的 `DocV2` 对象加入 `role` 字段。

## 硬验收

| # | 判据 | 结果 |
|---|---|---|
| **W1** | 判别性：doc 已存在 ⇒ 不 spawn、不 publish，复用 body | PASS |
| **W2** | 全部已存在 ⇒ 零 spawn、零 publish，导出与 anchor-check 照常 | PASS |
| **W3** | 部分已存在 ⇒ 只 spawn 缺失的 role | PASS |
| **W4** | 都不存在 ⇒ 行为与今天逐字一致 | PASS |
| **W5** | 不得吞 409：publish 返回 409 时响亮失败 | PASS |
| **W6** | 断言打在生产组装出的 deps 上（assembleGenerateDeps） | PASS |
| **W7** | 全量 `npx vitest run` 干净环境真绿 | 见下方尾部 |
| **W8** | 可达性声明 | 见下方 |
| **W9** | 工作树干净 | 见下方 |

## W8 可达性声明

| 判据 | 唯一会失败的用例 | 为什么缺该行为就不可能通过 |
|---|---|---|
| W1 | `W1: advocate doc already exists ⇒ not spawned, not published, body reused` | `readDoc` 返回 doc 时 `spawnRole` mock 未被 `dr-debater-advocate` 调用，断言 `toHaveLength(0)`。若 `readDoc` 返回推导被移除，该角色仍会 spawn，断言失败。 |
| W2 | `W2: all four docs pre-exist ⇒ no spawn, no publish, export + anchor-check execute` | 四个 doc 全部存在时 `spawnRole` 调用 0 次、`writeDoc` 调用 0 次。若任一角色未检查已有 doc，该角色会被 spawn 或 publish，断言失败。 |
| W3 | `W3: three debater docs exist, synthesizer missing ⇒ only synthesizer spawned` | `readDoc` 对三个 debater 返回 doc、对 synthesizer 返回 null，断言 `spawnedRoles` 只有 `["dr-synthesizer"]`。若 debater 的已有 doc 未被识别，会多 spawn。 |
| W4 | `W4: readDoc returns null for all roles ⇒ 4 spawns, 4 publishes` | `readDoc` 全部返回 null 时行为与今天一致。若 `readDoc` 未提供（向后兼容），同样 4 spawn + 4 publish。 |
| W5 | `W5: writeDoc throws 409 ⇒ error propagates, not swallowed` | `writeDoc` 抛 IDEMPOTENCY_CONFLICT 时 `runGenerate` reject。若 409 被静默吞掉，`toThrow` 断言失败。 |
| W6 | `W6: readDoc discriminates role among multiple argument docs for the same origin` | 生产 `readDoc`（`assembleGenerateDeps`）在 fake bus 中放置两条不同 role 的 argument doc，断言 `readDoc("dr-debater-advocate")` 返回 advocate body 而 `readDoc("dr-debater-judge")` 返回 null。若 `readDoc` 仍按 `doc_kind` 匹配，三个 debater 角色都会匹配到同一条消息，judge 也会返回非 null。 |

## §3 变异自检

未实测，理由：见可达性声明。变异由派发方在 gate 亲手施加。

## §4.4 同形排查结论

- **triage 路径**：triage 的 CAS（proposed→open/dropped）使用 `realCas` 的乐观并发控制，不是 idempotency-key-based publish。CAS 冲突（409）会原样返回 `conflict`，卡片保持在 `proposed` 状态，下一 tick 可重试。不存在「发布后不可重试」问题。
- **harvest 路径**：harvest 的 evidence/clue 发布使用 `dr-evidence:${runId}:${i}` 和 `dr-clue:${runId}:${i}` 作为幂等键。这些键基于 `runId`（每次 tick 由 `randomUUID()` 生成），不是固定值。重试时 `runId` 不同，不会产生同键冲突。即使同 tick 内重试同一张卡，`harvestCard` 的 idempotency key 基于 `runId`（来自 worker 的 `run_id`），而 `runId` 在 worker 退出时已固定，同一 worker 的产出内容不变（worker 输出是确定性文件），所以同键同内容 = 200 而非 409。不存在「同键不同内容」的永久卡死场景。

## 测试运行尾部

```
 ✓ test/g13-generate-resume.test.ts (16 tests) 43ms

 Test Files  32 passed (32)
      Tests  529 passed (529)
   Start at  17:30:59
   Duration  7.48s
```

无 FAIL 段。

## 工作树状态

`git status --porcelain | wc -l` 输出：`0`（提交后）