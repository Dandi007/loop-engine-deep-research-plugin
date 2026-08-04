# dev_ledr_a8c_spawn_wiring_01 —— A8c tick spawn + 接线判别 + 切换节点模板

## 产品改动

本包兑现 A8b 之后缺失的核心接线：**「读 runs」与「用 runs」之间的接线守卫** +
**spawn 真实执行**（role 注入 / spawn 失败回滚 / CAS 失败不 spawn）+ **节点模板切到真实 tick 入口**。

- **修改 `src/tick.ts`**（决策层，仍纯函数）：
  - 新增 `SOURCE_TO_ROLE`（`code-local→dr-worker-code-local`、`code-remote→dr-worker-code-remote`、
    `wiki→dr-worker-wiki`、`feishu→dr-worker-feishu`，R1a 的 4 个 role）与 `roleForSources(sources)`。
  - 新增 `isWebSource` / `WEB_SOURCE` / `WEB_BLOCK_RATIONALE`：`sources` 含 `web` ⇒ 卡 `blocked`
    并带非空 rationale（spec §1.2：`web` 枚举内但暂无 role，不得静默跳过、不得派给别的 role）。
  - `decideTick` dispatch 分支：先 `web`⇒block(`web_unimplemented`)，再枚举外⇒block(`invalid_sources`)，
    再无 role 的枚举内 source（如 `web-search`）⇒block(`unmapped_source`)；dispatch 决策携带映射出的 `role`。
  - `Decision.dispatch` 增加 `role` 字段；`Decision.block.reason` 扩展为三值。
  - `TickDeps.spawnWorker(clueId, role, runId?)`；`runTick` dispatch 分支按 role spawn、失败当场 CAS 回 open。
- **修改 `src/tick-run.ts`**（写侧执行，真实 spawn）：
  - `WriteDeps.spawnWorker(clueId, role, runId)`。
  - `runWrite` dispatch：**先 CAS open→in_flight 并把 run_id 写进卡**（M7）⇒ CAS 成功才按 `decision.role`
    调用 spawnWorker(clueId, role, runId)（N3）；**CAS 失败（409）跳过该卡、不 spawn**（N4）；
    **spawn 同步失败 ⇒ 当场 CAS 回 open**（N5，S2 补偿规则真实兑现）。
  - `WriteResult` 用 `spawns: SpawnRecord[]`（含 role/runId/spawned）取代 A8b 的 `pendingSpawns`。
  - `runChannelWrite` 注入真实 spawnWorker（CAS 成功后调用）；CAS 一律走 A8b 的 `realCas`，
    **不得绕过另写 CAS**（spec §4.1 纪律 8）。
  - `--max-writes` 默认 5（M10）、channel 无默认值（M11）、v1 冻结 channel 拒写（M12）均沿用；
    **spawn 本身不计入写入预算，但每次 spawn 前的 CAS 计入**（spec §2）。
- **修改 `src/tick-entry.ts`**：`--run` 用法/注释更新为「CAS + spawn（接线判别）」。
- **切换 `workflows/deep-research/tick/templates/tick.md`**：由 `--selfcheck` 切到真实 tick 入口
  `--run <channel>`（N9）；`--selfcheck` 仍保留（未注入 `tick_channel` 时退化自检，A7 G6/G7）。
  `workflow.yaml` seed payload 增加 `tick_channel`。
- **新增测试**：`test/tick-run.test.ts`（N1–N5 接线判别 + spawn 接线）、`test/tick.test.ts`（N6/N7/N8
  role 映射 + web/枚举外 block）、`test/plugin-wiring.test.ts`（N9 模板切换 + selfcheck 保留）。

## 硬验收映射

| # | 断言 | 覆盖 |
|---|---|---|
| N1 | W1：bus 有 started ⇒ 不 reclaim、不发 CAS | `N1`（打桩 HTTP：clue channel 固定、runs 通道返回含 started ⇒ publish 0 次） |
| N2 | W2：无 started ⇒ reclaim→open 且发 CAS | `N2`（与 N1 **只差 runs 通道内容** ⇒ 恰好 1 次 to=open 的 publish） |
| N3 | CAS 成功 ⇒ spawn 一次，带 clueId/role/runId | `N3` |
| N4 | CAS 失败（409）⇒ spawn 0 次 | `N4` |
| N5 | spawn 同步抛错 ⇒ 当场 CAS 回 open | `N5`（rollback CAS to=open/from=in_flight） |
| N6 | sources 枚举外 ⇒ blocked，不 spawn | `N6` |
| N7 | sources 含 web ⇒ blocked 且 rationale 非空，不 spawn | `N7`（与 N6 分开） |
| N8 | role 映射正确 | `N8`（四条各一例 + dispatch 携带 role） |
| N9 | 模板已切到真实 tick 入口 | `N9`（grep tick.md 命中 `--run`，且 `--selfcheck` 保留） |
| N10 | --selfcheck 仍保留且无副作用 | G6/G7 + `N9`（exit 0，不可达 bus 零网络） |
| N11 | --max-writes 默认 5 且生效 | `M10` 沿用 |
| N12 | v1 冻结 channel 拒写 | `M12` 沿用 |
| N13 | 真机 `--run` 对 `research:p02-smoke-1dce60` | 下方运行证据（跑前无在飞卡，增量 1 ≤ 5，spawn 被调用） |
| N14 | 不得触碰 `.dd-evidence/` | git diff 校验为空 |
| N15 | typecheck + 全量测试 | 均 exit 0（**188** 条全绿） |
| N16 | 既有用例一行未删 | git diff 无 `it(` 净减少（既有 171 全保留，净增 +17） |
| N17 | 证据写 `docs/dev-notes/<development_id>.md` | 本文件；仓根无 `IMPLEMENTATION_SUMMARY.md` |

## 变异自检归因（逐断言回显 + 逐字还原）

**V1 —— `assembleBoard(messages, runs)` 的 runs 换成 `{}`**（`src/tick-inspect.ts`）
```ts
// 原：const state: BoardState = { cards, runs, triageInFlight: false };
// 变异：const state: BoardState = { cards, runs: {}, triageInFlight: false };
```
被杀断言：`N1`（`expect(publishes).toHaveLength(0)`）→ `AssertionError`（runs 被清空后 started
丢失，W1 误 reclaim 而发 CAS）。**本包存在的理由**：A8b 时该变异杀 0 条，本包 N1 必须挂。

**V2 —— `readAgentRuns` 永远返空**（`src/tick-inspect.ts`）
```ts
// 原：分页读后按 run_id 归集返回
const messages = await readChannelMessages(channelId);
const runs: Record<string, RunEvent> = {};
for (const msg of messages) { /* 归集 */ }
return runs;
// 变异：const runs = {}; return runs;
```
被杀断言：`N1`（`expect(publishes).toHaveLength(0)` 挂）+ `M6`（分页 3 读挂）。

**V3 —— CAS 失败后仍 spawn**（`src/tick-run.ts` `runWrite` dispatch）
```ts
// 原：if (result.success) { …spawn… } else { skipped += 1; }
// 变异：if (true) { …spawn… }
```
被杀断言：`N4`（`expect(spawnWorker).toHaveBeenCalledTimes(0)` 挂）+ `M8`。

**V4 —— 去掉 spawn 失败的回滚 CAS**（`src/tick-run.ts` `runWrite` dispatch catch 分支）
```ts
// 原：catch { const rollback = await perform({ to:"open", from:"in_flight", … }); … }
// 变异：catch { if (false) { …rollback… } }
```
被杀断言：`N5`（`expect(casInputs).toHaveLength(2)` 与实际 1 次不符）。

**V5 —— `web` 走正常派发而非 blocked**（`src/tick.ts` `decideTick`）
```ts
// 原：if (isWebSource(card.sources)) { …block(web_unimplemented)… continue; }
// 变异：if (false && isWebSource(card.sources)) { … }
```
被杀断言：`N7`（`expect(d).toEqual([{ kind:"block", …, reason:"web_unimplemented" }])` 挂）。

**V6 —— 枚举外 `sources` 静默跳过而非 blocked**（`src/tick.ts` `decideTick`）
```ts
// 原：if (!isValidSources(card.sources)) { …block(invalid_sources)… continue; }
// 变异：if (false && !isValidSources(card.sources)) { … }
```
被杀断言：`N6`（`expect(d).toEqual([{ kind:"block", …, reason:"invalid_sources" }])` 挂）。

> 每个变异破坏后跑针对性测试，确认挂掉，跑完**逐字还原**；破坏前/后均回显被改的那一行如上。

## 真机运行证据（N13）

真机验证只允许在 `research:p02-smoke-1dce60`（spec §2）。分两步：

**① 预备：把板面清成无在飞卡**（该 channel 历史遗留 1 张 dead in_flight——run_id `410aabe8…`
在 `board:agent-runs` 无 started，即崩溃残留；本次 `--run` 正确 reclaim 回 open，并 block 掉
枚举外 `sources:['smoke']` 的卡）：
```
$ node node_modules/.bin/vite-node src/tick-entry.ts -- --run "research:p02-smoke-1dce60"
{ "messageCount": 7, "writes": 2, "spawns": [],
  "decisions": [ {reclaim msg_01KZ6AF6P3S… ->open}, {block msg_01KZ6FT90Z… invalid_sources} ] }
```
跑后 `--inspect` 确认板面 `statusDistribution: {"open":1,"blocked":1}`，**无 in_flight 卡**。

**② N13 正式一次 `--run`**（跑前确认无在飞卡）：
```
跑前消息数 = 9   （且确认 statusDistribution 无 in_flight）
$ node node_modules/.bin/vite-node src/tick-entry.ts -- --run "research:p02-smoke-1dce60"
{ "messageCount": 9, "writes": 1, "skipped": 0,
  "spawns": [ { clueId: "msg_01KZ6AF6P3SN4B43BYHQAJ8TTW",
                role: "dr-worker-code-local",
                runId: "33793a1b-0d34-45f8-b540-498f76075da0", spawned: true } ],
  "decisions": [ { kind:"dispatch", clueId: "msg_01KZ6AF6P3S…", role:"dr-worker-code-local" } ] }
$ echo $?   # exit 0
跑后消息数 = 10
增量 = 1 ≤ 5 ✓
```
- **N13 增量核验**：跑前 = 9，跑后 = 10，**增量 = 1 ≤ 5**（未触 --max-writes=5）。
- **接线判别真机成立**：只有一张 open 卡（`code-local`），`--run` 一次 dispatch CAS open→in_flight
  （1 次 CAS）成功 ⇒ **spawn 被调用**，带 `role=dr-worker-code-local`、`runId=33793a1b…`（N3）。
  worker 产出（`worker.result.v1` 未注册）属 V1，本包不信机验证（spec §7）。
- 随后再跑一次 `--run` 亦 exit 0（reclaim 回 open，writes 1，spawns 空），验证 reclaim 真机路径。

## 验收

- `npm run typecheck` —— exit 0
- `npm test` —— 既有 171 条 + 新增 17 条全绿（**188** 条）
- `--run` 对 `research:p02-smoke-1dce60` 真跑 exit 0；跑前无在飞卡，增量 1 ≤ 5，spawn 被调用
- V1–V6 变异逐条杀到对应断言并逐字还原
- 未触碰 `.dd-evidence/`