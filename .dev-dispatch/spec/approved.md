# G10 —— 生成段四个 role 共用一个 `--run-id`：并发 spawn 撞 bus 幂等键，结果也无法区分

> 派发方：`line-deep-research`。仓库：`loop-engine-deep-research-plugin`。前置：G8(v2) 已合入 main `f99b14f`。
> **Phase 6 真跑当场抓到，证据全部实测逐字。**

---

## 0　生产实况

G8(v2) 合入后，生成段**第一次真正 spawn 出 debater**。派发方用 shim 包住 `AGENT_RUN_BIN`
逐条留档真实 argv + exit code + stderr，得到（同一次 tick，两条）：

```
--role dr-debater-advocate  --run-id 1b2f8d45-6f51-4f52-a02a-bf2e4b2df346  --input … --prompt-file …
--role dr-debater-opponent  --run-id 1b2f8d45-6f51-4f52-a02a-bf2e4b2df346  --input … --prompt-file …
                                       ↑ 同一个 run-id
```

第二条的 stderr 逐字：

```
AGENT_RUN_ERROR code=CONTRACT_ERROR detail=started.v2 publish failed:
  send lifecycle failed for agent.run.started.v2: bus returned 409
  body={"code":"IDEMPOTENCY_CONFLICT","message":"Same idempotency_key with different intent"}
⇒ exit 91
```

**派发方独立复现**（不依赖引擎）：拿同一个 `--run-id` 并发起两个 agent-run ⇒ 两边都非零退出，
一边报 409 IDEMPOTENCY_CONFLICT。⇒ **agent-run 用 run_id 做 lifecycle 幂等键，run-id 必须每次 spawn 唯一。**

## 0.1　根因（定位到行号，非推断）

`src/tick-run.ts:1300-1302`：

```ts
    spawnRuntime: {
      get agentRunBin() { return opts.workerCmd ?? resolveAgentRunBin(); },
      runId: randomUUID(),          // ← 整个生成段只求值一次
```

`GenerateSpawnRuntime.runId` 是**单值字段**（`src/generate.ts:255`），
而 `spawnGenerateRole(role, corpus, runtime)` 对**四个 role 全部**用 `runtime.runId`
（`src/generate.ts` 的 `buildGenerateRoleArgv({ runId: runtime.runId, … })`）。

### ⛔ 第二重后果：结果在 run_id 上不可区分

`readBody(runId)` → `readGenerateResult(runId)` 是**按 run_id 回读**的。四个 role 共用一个 run_id
⇒ 即使 409 不发生，**四份结果也无从区分谁是谁**。advocate / opponent / judge / synthesizer
的 body 会互相串。**这不是并发才有的问题，是设计上的单值问题。**

---

## 1　要做什么

把 `GenerateSpawnRuntime` 的**单值 `runId: string`** 换成**每次 spawn 现取的工厂**，例如：

```ts
export interface GenerateSpawnRuntime {
  agentRunBin: string;
  newRunId(): string;      // ⛔ 每次 spawn 调用一次，返回全新 id
  …
}
```

`spawnGenerateRole` 内部：**调用一次 `newRunId()`**，把同一个值同时用于
`buildGenerateRoleArgv({ runId })` 与该次的 `readBody(runId)` ⇒ **argv 与回读用的是同一个 id**（关键）。

生产装配（`src/tick-run.ts:1302`）改为 `newRunId: () => randomUUID()`。

⛔ **不要**保留 `runId` 字段再"顺便"生成一个新的 —— 本仓纪律：**不留没有消费者的字段**
（G4d 对 `anchorCheckRoute`、G8(v2) 对 per-role `route` 都是这么处理的）。既有断言随之更新（属必要删除，须说明）。

⛔ **不要用「role 名当 run-id」或「基础 id + role 后缀」**：run-id 需要在**跨 tick、跨研究**范围唯一
（bus 是 append-only，幂等键冲突不可回退）。同一研究重跑第二次会与第一次撞。**用 `randomUUID()`。**

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **Y1** | ⭐ **四个 role 的 run-id 两两不同**：一次 `runGenerate` 里 advocate / opponent / judge / synthesizer 落到 argv 上的 `--run-id` 互不相同 | 假 spawn 记录**全部** argv，收集 `--run-id` 值，断言 `new Set(ids).size === 4` |
| **Y2** | ⭐ **argv 与回读同 id**：某次 spawn 传给 `readBody` 的 runId **等于**该次 argv 里 `--run-id` 的值 | 逐次配对断言；⛔ 这条是 Y1 之外的独立判据，**Y1 通过而 Y2 挂是完全可能的**（各自现取一次就会串） |
| **Y3** | ⛔ **无死字段**：`GenerateSpawnRuntime` 不再保留没有消费者的 `runId`；全仓 grep 无悬空引用 | grep + 读到行号 |
| **Y4** | ⛔ **断言打在生产组装出的 deps 上**：`assembleGenerateDeps` 已导出，用它组装再驱动；⛔ 自建 runtime 注入的用例不算数 | 照 G5/G6/G7 已交付的做法 |
| **Y5** | triage / worker 两条路径的 run-id 生成**不受影响**（它们各自已每次现取，本包不碰） | 既有断言仍有效；读到行号 |
| **Y6** | 全量 `npx vitest run` **在干净环境下真绿**（`ANCHOR_CHECK_BIN`/`DOC_CHANNEL`/`RESEARCH_ORIGIN`/`EXPORT_ROOT`/`AGENT_RESULT_*` 均未设置）。基线：main `f99b14f` 实测 **29 files / 501 tests**，终值两项均不得低于基线 | ⛔ **必须实跑并贴本次运行的完整尾部输出**（`Test Files` / `Tests` 两行 + 有无 FAIL 段） |
| **Y7** | **可达性声明**：Y1–Y5 每条**指名唯一那条会在该行为回归时失败的用例**，并一两句说明**它为什么在缺少该行为时不可能通过** | dev-note |
| **Y8** | `git status --porcelain` 为空 | 贴输出 |
| **Y9** | 每处删除给出必要性说明 | — |

---

## 3　⛔ 关于变异自检：本包不要求你自报，也不要编造

**实测变异由派发方在 gate 亲手施加**（G5 的 Q1–Q4、G6 的 S1–S2、G7 的 U1–U2、G8(v2) 的 W1–W2
全部由派发方亲手改产品码并复跑）。

你**只需**给 §2 Y7 的**可达性声明** —— 一个**可被评审读代码核实**的声明。
⛔ **不要写「实测 / 被杀 ✓」这类字样**，除非你真的做了并能贴出被改行与失败输出。
**写不出就如实写「未实测，理由：见可达性声明」——这不扣分。**

---

## 4　⛔ 前几包实付的学费（直接照用）

1. ⛔ **源码字符串匹配一律不构成证据**。
2. **有状态装配必须驱动生产组装**（`assembleGenerateDeps` 已导出）；
   **纯函数则直接调用、断言返回值，⛔ 不要 `vi.mock` 被测模块**（G8 v1 正是死在 mock 上）。
3. **dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit**，不是 H0 提交。
4. ⛔ **不得用「基线计数方式差异」解释测试数缺口**。
5. **贴证据必须是本次运行的完整尾部**，⛔ 不得贴上一个包的陈旧 `.dd-evidence`。
6. **修好一条路径时必须查同一形状是否还在别处**（本包已查：triage `:1302` 之外、worker `:729` 的
   `generateRunId()` 均为每次现取，无需改 —— Y5 是为此设的回归守卫）。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 改 triage / worker 的 run-id 生成 | 它们本来就每次现取（已实测），只需 Y5 守住不回归 |
| 改 `E2BIG` / prompt 投递 | 那是 G9，**在 agent-runtime 仓**，与本包并行推进 |
| 改模型档位 / role YAML | 已拍死在 golden-order |
| 注册任何 bus 协议 | 已完成 |
| 改 `profiles/deploy/*.env` | 归部署方 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 6　交付物落点

- 实现：`src/generate.ts`（`GenerateSpawnRuntime.newRunId` + `spawnGenerateRole` 每次现取 + 死字段清理）、
  `src/tick-run.ts:1302`（生产装配）
- 测试：`test/g10-per-role-runid.test.ts`（Y1–Y5）
- 证据：`docs/dev-notes/dev_ledr_g10_per_role_runid_01.md`（Y1–Y9 逐条 + §3 可达性声明 +
  本次运行的全量测试尾部 + `git status` 输出）
