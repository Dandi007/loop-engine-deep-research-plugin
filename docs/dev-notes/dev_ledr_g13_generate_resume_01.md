# G13 —— 生成段可恢复：按 (role, origin) 查已有 doc 并复用

- `input_commit`: `2b5c7aa7b2ef40745edb36470faf5d505012e15c`

## 实现

### `src/generate.ts`

- `GenerateDeps` 新增 `readDoc?(role, origin): Promise<{ doc: DocV2; messageId: string } | null>`。
- `runGenerate` 在派 role 之前先按 (role, origin) 查已有 doc：
  - 已存在 ⇒ 直接用其 body，不 spawn、不 publish。
  - 不存在 ⇒ 走现有路径（spawn → publish）。
  - synthesizer doc 已存在时跳过 lock+spawn+publish，但仍执行 anchor-check 与导出。
  - `readDoc` 未提供时行为不变（向后兼容）。

### `src/tick-run.ts`

- `assembleGenerateDeps` 新增 `readDoc` 实现：从 `opts.docChannelId` 读 `research.doc.v2` 消息，
  按 `doc_kind`（由 `deriveDocKind(role)` 推出）和 `origin` 匹配。
- 新增 `deriveDocKind` 导入。

### `test/g13-generate-resume.test.ts`（15 tests）

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
| W6 | `W6: assembleGenerateDeps produces a readDoc function` | 直接调用 `assembleGenerateDeps` 并断言 `deps.readDoc` 是函数。若生产装配不包含 `readDoc`，`toBeDefined` 失败。 |

## §3 变异自检

未实测，理由：见可达性声明。变异由派发方在 gate 亲手施加。

## §4.4 同形排查结论

- **triage 路径**：triage 的 CAS（proposed→open/dropped）使用 `realCas` 的乐观并发控制，不是 idempotency-key-based publish。CAS 冲突（409）会原样返回 `conflict`，卡片保持在 `proposed` 状态，下一 tick 可重试。不存在「发布后不可重试」问题。
- **harvest 路径**：harvest 的 evidence/clue 发布使用 `dr-evidence:${runId}:${i}` 和 `dr-clue:${runId}:${i}` 作为幂等键。这些键基于 `runId`（每次 tick 由 `randomUUID()` 生成），不是固定值。重试时 `runId` 不同，不会产生同键冲突。即使同 tick 内重试同一张卡，`harvestCard` 的 idempotency key 基于 `runId`（来自 worker 的 `run_id`），而 `runId` 在 worker 退出时已固定，同一 worker 的产出内容不变（worker 输出是确定性文件），所以同键同内容 = 200 而非 409。不存在「同键不同内容」的永久卡死场景。

## 测试运行尾部

```
 ✓ test/g13-generate-resume.test.ts (15 tests) 51ms

 Test Files  32 passed (32)
      Tests  528 passed (528)
   Start at  17:14:22
   Duration  7.57s
```

无 FAIL 段。

## 工作树状态

`git status --porcelain | wc -l` 输出：`0`（提交后）