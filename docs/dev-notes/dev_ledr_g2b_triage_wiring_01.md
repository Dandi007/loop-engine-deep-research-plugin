# G2b —— triage 接线（把 `spawnTriage()` 从 no-op 接到真实 `dr-triage` role）

> 实现者证据：`dev_ledr_g2b_triage_wiring_01`（spec `dev-dispatch.attempt-context/v1`，mode initial）
> 上游：`wf-dc0c15` spec §2.2 / §3.1 / §3.2 / §3.4；姊妹包 G2a（`src/generate.ts` 已合入形状）。

## 目标回顾

`src/tick-run.ts` 的 `case "triage"` 原为 `skipped += 1`（no-op），triage 从未真派发，
proposed 卡永不裁走 ⇒ `proposed=0` 永不成立 ⇒ 永远走不到正常收敛，只能触顶终止（§0）。
本包把该分支接到真实 `dr-triage` role 的派发 + 收割 + CAS + 两条校验 + 写入预算。

## 改动落点（仅产品文件；`.dev-dispatch/**` 未动）

| 文件 | 改动 |
|---|---|
| `src/tick.ts` | triage `Decision` 从 `{kind:"triage"}` 扩展为携带 `proposedClues` / `exploredSummaries`（板面快照原料）；`decideTick` 在触发 triage 时把本轮 proposed 集合与 explored 摘要装进决策 |
| `src/tick-run.ts` | ① 新增 triage 类型与生产函数：`TriageCorpus`、`TriageResultDecision`、`TriageReport`、`TRIAGE_ROLE`、`TRIAGE_ACTIONS`、`serializeTriageCorpusToPositional`、`buildTriageArgv`、`writeTriageInputFile`、`spawnTriageRole`、`findTriageResult`、`InvalidTriageActionError`、`OutOfScopeTriageClueError`、`MissingTriageQuestionError`；② `WriteDeps` 增 `spawnTriage` / `triageSpawnRuntime` / `readQuestion`；③ `runWrite` 的 `case "triage"` 从 `skipped+=1` 换成生产派发 + `applyTriageBatch`（值域/越界校验 + 整批 CAS + 预算整批跳过）；④ `RunWriteOutcome`/`WriteResult` 增 `triageReports`；⑤ `runChannelWrite` 接生产 `readQuestion`（`--question`）与缺省 `spawnTriage`；⑥ `parseRunCliArgs`/CLI 增 `--question` |
| `src/tick-entry.ts` | `--run` 用法文本与 `--question` 文档 |
| `test/g2b-triage-wiring.test.ts` | 新增 T1–T7（14 用例） |
| `docs/dev-notes/dev_ledr_g2b_triage_wiring_01.md` | 本文件 |

## 硬验收逐条

| # | 判据 | 证据 |
|---|---|---|
| **T1** | 位置参数承载板面快照（只断言 `--input` 不算数） | `test/g2b-triage-wiring.test.ts` `describe("T1")`：走生产默认 `spawnTriageRole`（注入 `triageSpawnRuntime`、不注入 `spawnTriage`），假 agent-run 记 argv，断言 `clue one text` / `clue two text` 字面出现在 `--` 之后的位置参数 |
| **T2** | 跨仓契约断言：引擎组装的快照能过 `agent-runtime/.../triage-input.v1.json` | `describe("T2")`：注入 `spawnTriage` 捕获引擎组装语料，用极简 schema 校验器（复刻 G2a `generate.test.ts` 做法）断言零错误；路径解析走 `AGENT_RUNTIME_PROFILES` env + `/data/code/self/agent-runtime/profiles` 回退 + 可用性守卫（`describe.skipIf(!agentRuntimeAvailable)`），不硬编码绝对路径导致换机器整套变红 |
| **T3** | `keep`⇒CAS `proposed→open`、`drop`⇒CAS `proposed→dropped`，且 `rationale` 落卡 | `describe("T3")`：断言 cas 捕获的 `from:"proposed"`、`to:"open"/"dropped"`、`rationale` 各一条 |
| **T4** | 非法 `action`（如 `"maybe"`）被响亮拒绝，既不当 keep 也不当 drop | `describe("T4")`：`runWrite` rejects `InvalidTriageActionError`，`cas` 调用 0 次；另断言 `TRIAGE_ACTIONS === ["keep","drop"]` |
| **T5** | 越界 `clue_id`（不在本轮 proposed）被丢弃且响亮记录，且不改任何卡 | `describe("T5")`：rejects `OutOfScopeTriageClueError`，断言 `cas` 调用 0 次 |
| **T6** | 预算不足时整批跳过并响亮报告，不做半批 | `describe("T6")`：正例 `maxWrites=10` 全 CAS、`budgetSkipped=false`；反例 `maxWrites=2 < 3` 零 CAS、`budgetSkipped=true`、`casCount=0` |
| **T7** | spawn 依赖必填且无条件调用（无静默零-spawn 假成功）；临时文件在 `finally` 清理 | `describe("T7")`：① 生产 `spawnTriageRole` 恰好 spawn 一次；② 缺 `spawnTriage` 与 `triageSpawnRuntime` ⇒ 响亮抛错（非静默 skip）；③ 缺 `readQuestion` ⇒ `MissingTriageQuestionError`（不空 question 派发）；④ `spawnTriageRole` 在 `readResult` 抛错时仍删临时载荷文件（`existsSync(filePath)===false`） |
| **T8** | 全量 `npx vitest run` 全绿，文件数/用例数 ≥ 基线 17 / 319 | `18 files / 333 tests passed`（基线 17/319，新增 1 文件 14 用例）；`npm run typecheck` 通过 |
| **T9** | 变异矩阵逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | 见下节；还原后 `git status --porcelain` 仅含本包预期产物 |
| **T10** | `tests/` 与 `src/` 的每一处删除都给出必要性说明 | 无删除；`tick-run.ts` 的 no-op 分支（`skipped += 1`）替换为生产派发属 spec 明示必要变更 |

> ⚠️ 本包不端到端真跑真 bus：`dr-triage.result.v1` 尚未注册，真发会 422（注册在异议窗口后由派发方执行）。
> 未为让真跑通过而注册任何协议；验收全部落在「接线可判别」。

## §4 变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 | 实测 |
|---|---|---|---|
| **N1** | 生产路径去掉位置参数里的快照（只留 `--input`） | **T1 必须挂** | ✅ 移除 `buildTriageArgv` 的 `"--", serializeTriageCorpusToPositional(...)` 后 `npx vitest run -t "T1"` → 2 failed（位置参数断言 `indexOf("--")+1` 失败），T1 零功率被杀 |
| **N2** | 去掉 `action` 值域校验（非法值按 keep 处理） | **T4 必须挂** | ✅ 移除 `if (d.action !== "keep" && d.action !== "drop") throw InvalidTriageActionError` 后 `-t "T4"` → 1 failed（`rejects.toBeInstanceOf(InvalidTriageActionError)` 失败） |
| **N3** | 去掉 `clue_id` 越界检查（照单 CAS） | **T5 必须挂** | ✅ 移除 `if (!proposedIds.has(d.clue_id)) throw OutOfScopeTriageClueError` 后 `-t "T5"` → 1 failed |

**还原证据**：每轮变异后 `cp /tmp/tick-run.bak.ts src/tick-run.ts` 还原；
全部还原后 `npm run typecheck` 通过、`test/g2b-triage-wiring.test.ts` 14/14 绿、
`git status --porcelain` 仅含本包预期产物（见交付）。

## 关键设计（对应 spec 三条既有事实）

- **§1.1 `--input` 只校验、不注入**：快照经 `serializeTriageCorpusToPositional` 序列化后放进 `--` 之后的位置参数（照 G2a `src/generate.ts` 的 `serializeCorpusToPositional` 形状）。
- **§1.2 跨仓契约**：快照形状对齐 `triage-input.v1.json`；T2 用真实 schema 断言。
- **§1.3 无静默零-spawn 假成功**：`TriageSpawnRuntime.spawnProcess` 必填且 `spawnTriageRole` 无条件调用；临时载荷文件在 `finally` 清理。
- **§2.2 收割逐条 CAS**：`keep→proposed→open`、`drop→proposed→dropped`，`rationale` 写卡（版本链留痕）；clue 唯一写者仍是调度器（引擎按 decision CAS，不是 role 直接改卡）。
- **§2.3 两条引擎侧兜住校验**：(a) `action` 值域非 `keep/drop` ⇒ 响亮抛错（bus `openSchema()` 剥 enum，bus 拦不住）；(b) `clue_id` 不在本轮 proposed ⇒ 响亮抛错且整批零 CAS（查得到 ≠ 有权改）。
- **§2.4 写入预算**：triage CAS 计入 `--max-writes`；不足 ⇒ 整批跳过并 `triageReports[].budgetSkipped=true` 响亮报告，不做半批。

## 交付物

- 实现：`src/tick-run.ts`（triage 生产派发 + 收割 + CAS + 两条校验 + 预算）、`src/tick.ts`（Decision 类型扩展）、`src/tick-entry.ts`（`--question`）
- 测试：`test/g2b-triage-wiring.test.ts`（T1–T7）
- 证据：本文件
