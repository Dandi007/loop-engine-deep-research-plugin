# G10 —— 生成段四个 role 各得唯一 run-id

- **development_id**: `dev_ledr_g10_per_role_runid_01`
- **input_commit**: `e2b8c104a65c581fd4a0ae688c247c57e10ac648`

## Y1-Y9 逐条判据

### Y1: 四个 role 的 run-id 两两不同

**PASS**. `test/g10-per-role-runid.test.ts` "Y1: four role run-ids are pairwise distinct" — 驱动生产 `assembleGenerateDeps` 组装 `spawnRuntime`，对四个 role 各调用一次 `spawnGenerateRole`，记录 argv 上的 `--run-id` 值，断言 `new Set(ids).size === 4`。

**可达性声明**: `test/g10-per-role-runid.test.ts` > Y1 > "four spawnGenerateRole calls each get a unique run-id on argv"。若 `newRunId` 退化回单值（如返回固定字符串），则 `new Set(ids).size` 为 1，此条必挂。

### Y2: argv 与回读同 id

**PASS**. `test/g10-per-role-runid.test.ts` "Y2: argv run-id equals readBody run-id for each spawn" — 对四个 role 逐次 spawn，pair 记录 argv 上的 `--run-id` 与 `readBody` 收到的 `runId`，断言全部相等。

**可达性声明**: `test/g10-per-role-runid.test.ts` > Y2 > "each spawn passes the same run-id to argv and readBody"。若 `spawnGenerateRole` 对 argv 和 `readBody` 各自调用 `newRunId()`（即两次现取），则 pair 不相等，此条必挂。

### Y3: 无死字段

**PASS**. `test/g10-per-role-runid.test.ts` "Y3: no dead runId field on GenerateSpawnRuntime" — 断言 `runtime` 有 `newRunId`（函数）、无 `runId` 属性；`newRunId()` 返回非空字符串；连续 10 次调用返回 10 个唯一值。

**可达性声明**: `test/g10-per-role-runid.test.ts` > Y3 > "GenerateSpawnRuntime has newRunId, not runId"。若有人重新加回 `runId` 字段，`expect(runtime).not.toHaveProperty("runId")` 必挂。

### Y4: 断言打在生产组装出的 deps 上

**PASS**. 所有 G10 测试均通过 `assembleGenerateDeps(…)` 获取 `spawnRuntime`，不手写 `GenerateSpawnRuntime` 对象。Y4 显式断言 `deps.spawnRuntime` 的非空性与各字段类型。

**可达性声明**: `test/g10-per-role-runid.test.ts` > Y4 > "Y1/Y2/Y3 all obtain runtime from assembleGenerateDeps, not hand-built"。若有人用自建 runtime 替代 `assembleGenerateDeps`，此条 `expect(deps.spawnRuntime).toBeDefined()` 虽可过，但 Y1/Y2/Y3 的 `assembleGenerateDeps` 调用处会因缺少 `newRunId` 而挂。

### Y5: triage / worker 两条路径的 run-id 生成不受影响

**PASS**. `test/g10-per-role-runid.test.ts` "Y5: triage and worker run-id generation unchanged" — 两个用例：

1. `TriageSpawnRuntime has runId (not newRunId)` — 构造 `TriageSpawnRuntime` 实例，断言 `runtime` 有 `runId`、无 `newRunId`，且 `runId` 为非空字符串。若有人误将 `TriageSpawnRuntime.runId` 改为 `newRunId`，`expect(runtime).not.toHaveProperty("newRunId")` 必挂。
2. `worker per-dispatch runId is const runId = randomUUID()` — 读取 `src/tick.ts` 源码，断言 `const runId = randomUUID()` 存在。若有人将 worker 的 per-dispatch `randomUUID()` 改为 hoisted 单值，正则 `/const runId = randomUUID\(\)/` 不匹配，此条必挂。

**可达性声明**: `test/g10-per-role-runid.test.ts` > Y5 > "TriageSpawnRuntime has runId (not newRunId)" — 若 triage 的 `runId` 字段被改为 `newRunId` 工厂，`not.toHaveProperty("newRunId")` 必挂。`test/g10-per-role-runid.test.ts` > Y5 > "worker per-dispatch runId is const runId = randomUUID()" — 若 worker 的 `const runId = randomUUID()` 被改为 hoisted 单值，正则匹配必挂。

### Y6: 全量 npx vitest run 真绿

```
 Test Files  30 passed (30)
      Tests  509 passed (509)
   Start at  11:43:11
   Duration  7.18s
```

无 FAIL 段。`ANCHOR_CHECK_BIN` / `DOC_CHANNEL` / `RESEARCH_ORIGIN` / `EXPORT_ROOT` / `AGENT_RESULT_*` 均未设置。

### Y7: 可达性声明

见上 Y1-Y5 各条。Y5 的可达性声明已修正为指向实际校验 triage `runId` 字段和 worker `const runId = randomUUID()` 源码的用例，而非仅检查 generate runtime 的类型属性。

### Y8: git status --porcelain 为空

```
```

**PASS**. 提交后工作区清洁，无未跟踪文件。

### Y9: 每处删除给出必要性说明

- `src/generate.ts:255` `runId: string` → 删除。单值字段导致四个 role 共用一个 run-id（spec §0.1 根因），替换为 `newRunId(): string` 工厂（每次 spawn 现取全新 id）。
- `src/tick-run.ts:1302` `runId: randomUUID()` → 删除。对应 `GenerateSpawnRuntime.runId` 字段删除，替换为 `newRunId: () => randomUUID()`。
- `test/generate.test.ts` 两处 `runId: "run-1"` → 改为 `newRunId: () => "run-1"`。接口变更，无消费者保留。
- `test/g7-prompt-file.test.ts` 多处 `runId: "run-*"` → 改为 `newRunId: () => "run-*"`（仅 `GenerateSpawnRuntime` 实例，`TriageSpawnRuntime` 实例未动）。接口变更，无消费者保留。