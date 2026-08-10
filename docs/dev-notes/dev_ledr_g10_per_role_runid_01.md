# G10 —— 生成段四个 role 各得唯一 run-id

- **development_id**: `dev_ledr_g10_per_role_runid_01`
- **input_commit**: `c2e441d3ef175f4bed47fad5f858360c1450ce7b`

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

1. `worker dispatch generates unique run-id per spawn via runWrite` — 驱动 `runWrite`（生产写侧入口）传入两个 dispatch 决策，注入 `spawnWorker` 记录 `runId`，断言 `new Set(ids).size === 2`。`runWrite` 在 dispatch 分支（`src/tick-run.ts:728`）调用 `generateRunId()` 为每个 dispatch 生成 runId。
2. `triage spawn generates unique run-id per invocation via runWrite` — 两次调用 `runWrite`，每次注入一个 `triageSpawnRuntime`，驱动生产 `spawnTriage` 缺省闭包（`src/tick-run.ts:1534-1568`），断言两次 triage 报告的 `runId` 互不相同。

**可达性声明**: `test/g10-per-role-runid.test.ts` > Y5 > "worker dispatch generates unique run-id per spawn via runWrite"。若 `generateRunId()`（`src/tick-run.ts:536-538`）被改为 hoisted 单值，两个 dispatch 获得的 runId 相同，`new Set(ids).size === 2` 必挂。

`test/g10-per-role-runid.test.ts` > Y5 > "triage spawn generates unique run-id per invocation via runWrite"。该用例通过 `runWrite` 驱动生产 triage 组装路径（`src/tick-run.ts:1534-1568`）。若 `TriageSpawnRuntime.runId` 字段被改为 `newRunId` 工厂，TypeScript 编译在注入点即报错。`runId: randomUUID()`（`src/tick-run.ts:1540`）仅在 `triageSpawnRuntime` 未注入时到达；该用例注入 `triageSpawnRuntime` 以控制可观测性，故不直接守卫该行被 hoist 的回归。

### Y6: 全量 npx vitest run 真绿

```
 Test Files  30 passed (30)
      Tests  509 passed (509)
   Start at  12:00:38
   Duration  7.21s
```

无 FAIL 段。`ANCHOR_CHECK_BIN` / `DOC_CHANNEL` / `RESEARCH_ORIGIN` / `EXPORT_ROOT` / `AGENT_RESULT_*` 均未设置。

### Y7: 可达性声明

见上 Y1-Y5 各条。Y5 的 worker 守卫直接驱动 `runWrite`（生产写侧入口），若 `generateRunId()` 被 hoist 则必挂。Y5 的 triage 守卫通过 `runWrite` 驱动生产 triage 组装路径（`src/tick-run.ts:1534-1568`），如实声明了其守卫边界（`runId: randomUUID()` 行在注入 `triageSpawnRuntime` 时不可达）。

### Y8: git status --porcelain 为空

```
```

**PASS**. 提交后 `git status --porcelain` 输出为空（如上），工作区清洁，无未跟踪文件。

### Y9: 每处删除给出必要性说明

- `src/generate.ts:255` `runId: string` → 删除。单值字段导致四个 role 共用一个 run-id（spec §0.1 根因），替换为 `newRunId(): string` 工厂（每次 spawn 现取全新 id）。
- `src/tick-run.ts:1302` `runId: randomUUID()` → 删除。对应 `GenerateSpawnRuntime.runId` 字段删除，替换为 `newRunId: () => randomUUID()`。
- `test/generate.test.ts` 两处 `runId: "run-1"` → 改为 `newRunId: () => "run-1"`。接口变更，无消费者保留。
- `test/g7-prompt-file.test.ts` 多处 `runId: "run-*"` → 改为 `newRunId: () => "run-*"`（仅 `GenerateSpawnRuntime` 实例，`TriageSpawnRuntime` 实例未动）。接口变更，无消费者保留。