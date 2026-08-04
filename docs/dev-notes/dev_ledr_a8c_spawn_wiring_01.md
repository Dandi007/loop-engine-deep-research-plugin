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
  - `runChannelWrite` 注入**真实 spawn** `spawnWorkerProcess`（A8c 重做 finding 2）：CAS 成功后
    **真正启动一个 worker 子进程**（`child_process.spawn`，命令可经 `TICK_WORKER_CMD`/options 配置）。
    ⛔ spawn 本身**不写 agent-bus**、**不伪造 `agent.run.started`**（spec §2：spawn 不写 bus，
    仅每次 spawn 前的 CAS 计入；评审 blocker：`agent.run.started` 必须由真正启动的 worker 自行发布，
    无进程却发布 started 会把在飞卡永久钉死在 in_flight）。CAS 一律走 A8b 的 `realCas`，
    **不得绕过另写 CAS**（spec §4.1 纪律 8）。worker 产出（worker.result.v1 未注册）属 V1，不在本包范围（spec §7）。
  - **第三次重做（评审 blocker）**：缺省 spawn 命令不再退化为 `bash`（把 role 当脚本路径、退出 127）。
    新增真实 launcher `bin/worker-launcher.sh` + 占位 worker `bin/worker-placeholder.sh`（可执行）；
    `bin/deep-research-loop.sh` **显式导出 `TICK_WORKER_CMD`** 指向 launcher；`defaultWorkerCmd()`
    缺省退化为随包 launcher 路径。`spawnWorkerProcess` 增加「就绪窗口」：窗口内非零退出 ⇒ reject
    （N5 回滚触发），仅「存活超窗」或「正常退出 0」才 resolve。新增**组合默认端到端用例**把
    launcher 与 wiring 一起验证。
  - `--max-writes` 默认 5（M10）、channel 无默认值（M11）、v1 冻结 channel 拒写（M12）均沿用。
- **修改 `src/tick.ts`**：删除 A8b 变异自检遗留的两行 mutation-marker 注释
  （`// V5 mutation: …` / `// V6 mutation: …`，finding 3 的 minor）——它们与注释上方
  实际正确 block 的分支相矛盾，误导读者；删注释即逐字还原为交付态（V5/V6 分支不变）。
- **修改 `src/tick-entry.ts`**：`--run` 用法/注释更新为「CAS + spawn（接线判别）」。
- **切换 `workflows/deep-research/tick/templates/tick.md`**：由 `--selfcheck` 切到真实 tick 入口
  `--run <channel>`（N9）；`--selfcheck` 仍保留（未注入 `tick_channel` 时退化自检，A7 G6/G7）。
  `workflow.yaml` seed payload 增加 `tick_channel`。
- **打通 `tick_channel` 全链路（A8c 重做 finding 1，blocker）**：此前 `tick.md` 里
  `--run "$tick_channel"` 从未被触发——`fleet.yaml.tpl` 只声明 `tick_entry`，`deep-research-loop.sh`
  不导出 `TICK_CHANNEL`，装配系统任何路径都不供给 `tick_channel`。本次：
  - `fleet.yaml.tpl` input 增加 `tick_channel: ${TICK_CHANNEL}`（pipeline input namespace）。
  - `bin/deep-research-loop.sh` 导出 `TICK_CHANNEL`（默认 `research:p02-smoke-1dce60`，可用 env 覆盖）。
  - 于是渲染出的 fleet 里 tick pipeline 的 input 携带非空 `tick_channel`，经 `{{tick_channel}}`
    注入 seed payload，`tick.md` 的 `--run "$tick_channel"` 真实可达（N9 判别性断言）。
- **新增测试**：`test/tick-run.test.ts`（N1–N5 接线判别 + spawn 接线 + **A8c 真实 spawn 启动
  worker 子进程且不写 bus**）、`test/tick.test.ts`（N6/N7/N8 role 映射 + web/枚举外 block 且
  rationale 进决策）、`test/plugin-wiring.test.ts`（N9 **判别性**模板切换 + `tick_channel` 端到端 wiring + selfcheck 保留）。

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
| N9 | 模板已切到真实 tick 入口 | `N9`（判别性：tick.md 命中 `--run` 且 `--selfcheck` 保留 + `fleet.yaml.tpl` 声明 `tick_channel`、loop 脚本导出 `TICK_CHANNEL`、渲染 fleet 的 pipeline input 携带非空 `tick_channel`） |
| N10 | --selfcheck 仍保留且无副作用 | G6/G7 + `N9`（exit 0，不可达 bus 零网络） |
| N11 | --max-writes 默认 5 且生效 | `M10` 沿用 |
| N12 | v1 冻结 channel 拒写 | `M12` 沿用 |
| N13 | 真机 `--run` 对 `research:p02-smoke-1dce60` | 下方运行证据（跑前无在飞卡，增量 1 ≤ 5，spawn 启动 worker 子进程） |
| N14 | 不得触碰 `.dd-evidence/` | git diff 校验为空 |
| N15 | typecheck + 全量测试 | 均 exit 0（**196** 条全绿） |
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
  （1 次 CAS）成功 ⇒ **spawn 拉起一个真实 worker 进程**（走 `TICK_WORKER_CMD`/缺省
  `bin/worker-launcher.sh`），带 `role=dr-worker-code-local`、`runId=33793a1b…`（N3）。
  spawn **不写 agent-bus**、不伪造 started（增量只有 1 次 clue CAS）。
- **⚠️ 本包 spawn 的真实边界（spec §7）**：worker 的**研究行为与产出**（`worker.result.v1` 未注册）
  属 **V1**，本包**不信机验证**。真机只能证明「**CAS + spawn 真实拉起 worker 进程**」到这一步，
  **不得把 spawned:true 说成 worker 已产出结果**。占位 worker（`bin/worker-placeholder.sh`）只是
  「worker 进程真实启动」的落地证明；真实 worker 由部署方经 `TICK_WORKER_RUNNER`（agent-runtime /
  subagent-mcp）接入（V1）。
- **一致性（评审 finding 2）**：随后再跑一次 `--run` 亦 exit 0（reclaim 回 open，writes 1，spawns 空）。
  在重做后的代码下这是**一致**的——tick 的 spawn 不再向 `board:agent-runs` 写 started，因此下一次 tick
  读到该在飞卡 `runId=33793a1b…` 在 runs channel 无 started，便按崩溃恢复 reclaim 回 open（writes 1、
  spawns 空）。之前那条「随后 reclaim 回 open」的 N13 描述与 old 代码（spawn 写 started）矛盾，现已消除：
  churn 的真正消除依赖被启动的 worker 自行发布 started（那属 V1 / worker 的职责），本包只保证
  **spawn 真实拉起 worker 进程**与 **W1/N1 接线判别**（有 started 即不 reclaim）。

## 重做（final review findings 修复）

| finding | 处置 |
|---|---|
| **blocker（§1.3）**：`tick_channel` 无供给路径，`--run` 永不触发 | 打通全链路：`fleet.yaml.tpl` input 声明 `tick_channel: ${TICK_CHANNEL}`，`bin/deep-research-loop.sh` 导出 `TICK_CHANNEL`（默认 `research:p02-smoke-1dce60`）；渲染 fleet 的 pipeline input 携带非空 `tick_channel`，经 `{{tick_channel}}` 注入 seed payload，`tick.md` 的 `--run "$tick_channel"` 真实可达。N9 改为判别性断言（不再只 grep 文本）。 |
| **blocker（§1.2 spawn 伪造）**：`spawnAgentRun` 发布 `agent.run.started` 但无进程，把在飞卡永久钉死 | 移除伪造 bus 事实。真实 spawn 改为 `spawnWorkerProcess`：CAS 成功后**真正启动 worker 子进程**（`child_process.spawn`，命令经 `TICK_WORKER_CMD`/options 配置）。`agent.run.started` 改由真正启动的 worker 自行发布（spec §2：spawn 不写 bus；评审 blocker：started 必须对应真实进程）。启动失败 ⇒ reject ⇒ N5 当场 CAS 回 open。 |
| **major（N13 证据矛盾）**：dev-note 称「随后 --run reclaim 回 open」与 old 代码（spawn 写 started）矛盾 | 见上方 N13 一致性说明：tick 不再写 started，随后 --run 读无 started ⇒ reclaim 回 open，描述自洽；churn 消除改为依赖 worker 自行发布 started（V1）。 |
| **major（spawn 绕过写预算写 bus）**：spawn 发布走 board:agent-runs，不计入 --max-writes | spawn 不再写 agent-bus：`--max-writes` 只计 CAS（每次 spawn 前的 CAS 计入），无未计预算的额外 append（spec §2 前提恢复）。 |
| **major（web block rationale 未落卡）**：`WEB_BLOCK_RATIONALE` 无生产路径引用，block CAS 只写 status | `Decision.block` 增加 `rationale`；`decideTick` 对 web/invalid/unmapped 各带明确 rationale；`runWrite` block 分支把它写进卡；`realCas` 把它并入 payload。N7 断言 web block 决策携带非空 `WEB_BLOCK_RATIONALE`。 |
| **minor**：`src/tick.ts` 残留 V5/V6 mutation-marker 注释，与所注释分支矛盾 | 删除两行遗留注释（分支逻辑逐字不变，即变异自检后的还原态）。 |

## 第三次重做（attempt_01KZ76W5ETA48E7WSGSG1C27CV final review findings 修复）

| finding | 处置 |
|---|---|
| **blocker（生产 spawn 无法拉起任何 worker）**：`defaultWorkerCmd()` 在 `TICK_WORKER_CMD` 未设时退化 `bash`，仓库无人设置它 ⇒ 部署态执行 `bash dr-worker-code-local <clueId> <runId>`（脚本不存在 ⇒ 退出 127，从未拉起 worker）；且组合默认从不被一起验证（wiring 注入 spawnWorker、原语给显式 cmd） | ① 新增真实 launcher `bin/worker-launcher.sh`（可执行，把 role/clueId/runId 作为**参数**拉起 worker，不再是 `bash <role>` 把 role 当脚本路径）；`bin/deep-research-loop.sh` **显式导出 `TICK_WORKER_CMD`** 指向它（评审：仓库此前无人设置）。② `defaultWorkerCmd()` 缺省退化为随包 launcher 路径，不再退化 `bash`。③ 新增**组合默认端到端用例**：`runChannelWrite` 不注入 spawnWorker、用缺省 launcher，验证它真实拉起 worker 进程（marker 文件作证，参数为 role/clueId/runId），且不写 `agent.run.started`——launcher 与 wiring **一起**被测。 |
| **major（spawnWorkerProcess 只在 spawn 事件上断言成功）**：立即死亡（退出 127）的命令仍记 spawned:true，N5 补偿永不触发 | `spawnWorkerProcess` 增加「就绪窗口」：窗口内**非零退出**（如 127）⇒ reject `WorkerStartupError` ⇒ 上层 N5 当场 CAS 回 open；仅「存活超过窗口」或「正常退出 0」才 resolve。新增用例：立即退出 127 ⇒ reject（N5 会触发）。 |
| **major（N13 真机证据夸大）**：dev-note 称 spawn 带 role=dr-worker-code-local 启动 worker；但旧缺省是 `bash dr-worker-code-local`，无法启动任何 worker | 见上方 N13 修订：本包 spawn 的真实边界是「**CAS + spawn 真实拉起 worker 进程**」（spec §7，不信机验证 worker 产出）；占位 worker 仅为「进程真实启动」的落地证明，真实 worker 属 V1 / 部署方经 `TICK_WORKER_RUNNER` 接入。不再把 spawned:true 说成 worker 已产出。 |
| **minor（N7 rationale 只在决策层断言）**：写路径（runWrite block 分支 → realCas 并入 payload）无 publish-body 断言；删除 `if (input.rationale !== undefined) update.rationale = …` 测试仍全绿 | 新增 `realCas` block 分支 publish-body 断言：payload 携带非空 `rationale`（`WEB_BLOCK_RATIONALE`）。该变异（删除 rationale 并入）现会被杀。 |

## 验收

- `npm run typecheck` —— exit 0
- `npm test` —— 全量绿（**196** 条；既有用例一行未删，只增未减）
- `--run` 对 `research:p02-smoke-1dce60` 真跑 exit 0；跑前无在飞卡，增量 1 ≤ 5，spawn 真实拉起 worker 进程
- V1–V6 变异逐条杀到对应断言并逐字还原
- 未触碰 `.dd-evidence/`