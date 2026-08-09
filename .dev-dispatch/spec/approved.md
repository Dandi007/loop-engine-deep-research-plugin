# G5 —— triage 的结果读回查的是 spawn **之前**的快照：33 次真实裁定被全部丢弃

> 派发方：`line-deep-research`。前置：D2 已合入 main `4312cae`。
> **这是 Phase 6 真跑当场抓到的生产缺陷，不是推断。** 证据在 §0，全部取自生产 bus。

---

## 0　生产实况（2026-08-09 19:35Z–20:35Z，真跑一小时）

研究「agent harness」在生产 bus 上跑了约一小时，**板面在第一次 triage 之后就永久停滞**：

| 观察 | 数值 |
|---|---|
| `research:agent-harness.index` | 32 条消息 / 22 个线索实体：**5 explored、17 proposed** |
| `research:agent-harness.evidence` | 65 条真实证据（收集段工作正常） |
| 板面停滞时长 | ≥ 25 分钟内 `head_seq` **一动不动**（32 / 65 两次采样完全相同） |
| 驱动轮次 | 19+ 轮，每轮 `loop-events.jsonl` 均 **`errors: 0`**、`drain.json` 均 `reason: drained`、脚本 **exit 0** |

**手工单跑一次 tick 的输出（逐字）**：

```json
"triageReports": [ { "runId": "", "budgetSkipped": false, "invalidActions": 0,
                     "outOfScopeDropped": 0, "casCount": 0, "casResults": [] } ],
"writes": 0, "spawns": [],
"termination": { "state": null, "coverage": 5, "zeroGrowthRounds": 0, "capHit": false }
```

**而 `board:agent-runs` 上（`after_seq=7500`，⚠️ 不带 `after_seq` 只会返回最早 100 条）**：

```
kind 分布: {'dr-triage.result.v1': 33, 'worker.result.v1': 5,
            'agent.run.started.v2': 41, 'agent.run.exited.v2': 38, …}
dr-triage.result.v1 样本: run_id=db677302-… decisions=17
                          run_id=f8fbcdc0-… decisions=17
                          run_id=df6d7781-… decisions=17
```

⇒ **triage agent 一直在正确工作**：被派出、读板、对那 17 条 proposed 逐条做出 keep/drop 裁定、发布到板上。
⇒ **引擎从不读取它们。33 次真实裁定全部被丢弃。** 17 条线索永远停在 `proposed`，永不可被 worker 认领。

> ### ⛔ 这是本仓反复出现的那个形态的最完整标本：
> **工作发生了 → 结果发布了 → 消费方读了一份陈旧快照 → 零效果 → 全链路报告成功。**
> `errors: 0`、`drained`、`exit 0`、`casCount: 0` —— **没有任何一处是红的。**

---

## 1　根因（已定位到行号，非推断）

`src/tick-run.ts`：

```ts
:1449   const runsMessages = await readChannelMessages(runsChannelId);   // ← spawn 之前读的快照
...
:1529             runId: randomUUID(),                                   // ← spawn 时才生成
:1541   readResult: async (runId) => findTriageResult(runId, runsMessages) ?? [],
```

`runsMessages` 是**普通数组**，读取后不重读、不变更。而 `runId` 是 spawn 时新生成的
⇒ `findTriageResult(runId, runsMessages)` **在数学上不可能命中**，恒返回 `null` ⇒ `?? []` ⇒ 零 CAS。

### ⛔ 同一条缺陷已在生成段被修过，triage 没享受到

G4c(v2) 的 final review 对**生成段**记过逐字相同的判定：
「`runsMessages` 是 spawn **之前**读的快照…`runId` 是新生成的 `randomUUID()`…该 run id 不可能出现在那个 pre-spawn 数组里」。
G4c(v2) 已用 **`readGenerateResult`** 修好（见 §2）。**triage 这条路径由更早的 G2b 交付，未随之更新。**

---

## 2　⛔ 照抄已验证正确的形状（不要重新发明）

`src/tick-inspect.ts` 里 G4c(v2) 交付并已合入的正确形状：

```ts
export async function readGenerateResult(
  runId: string, channelId = "board:agent-runs",
): Promise<{ body: string } | null> {
  const messages = await readChannelMessages(channelId);   // ⛔ 每次调用都重新读
  return findGenerateResult(runId, messages);
}
```

配套的调用侧（`tick-run.ts` 的生成段 `readBody`）带**重试等待**：spawn 是异步的，
结果不会在 spawn 返回的瞬间就在 channel 上（上一包用 30 次 × 1s）。

**本包要做的**：
1. 加 `readTriageResult(runId, channelId = "board:agent-runs")` —— **每次调用重新分页读 channel**，
   过滤 `kind === "dr-triage.result.v1"` 且 `payload.run_id` 匹配（复用既有 `findTriageResult` 做纯匹配）。
2. 生产 `triageSpawnRuntime.readResult` 改用它，并加**重试等待**（与生成段同量级；实现方可调具体次数/间隔，
   但必须在 dev-note 写明取值与理由）。
3. ⛔ **等待耗尽仍无结果 ⇒ 必须响亮**：不得再返回 `[]` 当成「triage 判了 0 条」。
   **空结果与「读不到结果」是两件事**，正是本缺陷得以静默一小时的原因。
   响亮形态由实现方定（抛错或在 `triageReport` 里显式标记并使该 tick 非零退出），但**必须在日志/输出里点名 runId**。
4. **`triageReport.runId` 必须是真实 runId**，不得是空串（实测为 `""`，使「结果被丢弃」在输出里不可诊断）。

⛔ 不要改 `applyTriageBatch` 的校验/CAS 语义（值域校验、不做半批），本包只修**结果读回**这一环。

---

## 3　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **P1** | ⭐ **判别性**：假 bus 在 spawn **之后**才出现该 runId 的 `dr-triage.result.v1` ⇒ `readResult` **仍能读到**并产生 CAS。⛔ 用 spawn 前的快照必然读不到 —— 这是本包的存在理由 | 驱动**生产组装**出的 triage runtime（见 P6），断言 `casCount === 决策条数` |
| **P2** | ⛔ **读不到 ⇒ 响亮**：重试耗尽仍无结果 ⇒ 不得返回 `[]` 静默通过；错误/标记里**点名 runId** | 正反两例 |
| **P3** | ⛔ **空决策 ≠ 读不到**：agent 真的返回 `{"decisions":[]}` ⇒ 走正常路径（0 条 CAS，不报错） | 判别性用例；与 P2 必须可区分 |
| **P4** | `triageReport.runId` 等于实际 spawn 的 runId，非空串 | 断言相等 |
| **P5** | `applyTriageBatch` 的既有语义未被削弱（非法 action 响亮拒绝、不做半批、越界丢弃计数） | 既有断言保留且仍有效（读到行号） |
| **P6** | ⛔ **断言必须打在生产组装出的 deps 上**：`runChannelWrite` 在 `opts.spawnTriage` / `opts.triageSpawnRuntime` 存在时走注入分支、**跳过生产组装**。⛔ 自建 runtime 注入的用例不算数 | 照 G4c(v2)/G4d(v2) 的做法（`assembleGenerateDeps` 已导出的同款思路）；⛔ **源码字符串匹配一律不构成证据** |
| **P7** | 全量 `npx vitest run` **在干净环境下真绿**（`ANCHOR_CHECK_BIN`/`DOC_CHANNEL`/`RESEARCH_ORIGIN`/`EXPORT_ROOT` 均未设置）。基线：main `4312cae` 实测 **25 files / 458 tests**，终值两项均不得低于基线 | ⛔ **必须实跑并贴完整尾部输出**（`Test Files` / `Tests` 两行 + 有无 FAIL 段） |
| **P8** | 变异矩阵（§4）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **P9** | 每处删除给出必要性说明 | — |

---

## 4　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **Q1** | `readResult` 改回 `findTriageResult(runId, runsMessages)`（= 回到改动前的 pre-spawn 快照） | **P1 必须挂**；⛔ 杀不掉即判 P1 零功率、必须重写 |
| **Q2** | 重试耗尽时返回 `[]` 而非响亮失败 | **P2 的失败侧必须挂** |
| **Q3** | 让真实的 `{"decisions":[]}` 也走响亮失败路径 | **P3 必须挂**（空结果被误判成读不到） |
| **Q4** | `triageReport.runId` 写死空串 | **P4 必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 5　⛔ 前几包实付的学费（直接照用）

1. **测试必须驱动生产组装**：注入 deps 会跳过生产装配分支，这一形态已在 G4c/G4d 连挂五轮。
2. ⛔ **源码字符串匹配（`expect(source).toContain(...)` / `readFileSync(测试文件)`）一律不构成证据。**
3. **`workflow.yaml` 新增的可选 pipeline input 必须带 `?`**（本包大概率不涉及，涉及则遵守）。
4. **dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit**，**不是 H0 提交**；
   ⛔ 不要为对齐 hash 做额外提交；⛔ 不得用「基线计数方式差异」解释测试数缺口。
5. **变异矩阵各行必须是实测**，不得写预测；若某行杀不掉，如实写「未被杀」并说明，⛔ 不得编造失败现象。

---

## 6　显式不做

| 不做 | 理由 |
|---|---|
| 改 `applyTriageBatch` 的校验/CAS 语义 | 已交付且被断言保护；本包只修结果读回 |
| 改生成段的 `readGenerateResult` | 已修好，本包照抄其形状即可 |
| 改 worker 收割路径 | 生产实测正常（65 条证据、5 条 `worker.result.v1` 被正确收割） |
| 改 `profiles/deploy/*.env` | 归部署方 |
| 注册任何 bus 协议 | 已由派发方于 2026-08-09 19:00Z 完成（`dr-triage.result.v1` 已注册，生产实测可发布） |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 7　交付物落点

- 实现：`src/tick-inspect.ts`（`readTriageResult`）、`src/tick-run.ts`（生产 `readResult` + 重试 + 响亮失败 + 真实 runId）
- 测试：`test/g5-triage-read.test.ts`（P1–P6）
- 证据：`docs/dev-notes/dev_ledr_g5_triage_read_01.md`（P1–P9 逐条 + §4 变异四行**实测** + 还原证据 + 你采用的重试次数/间隔与理由）
