# E0c5 —— tick 被 **30 秒的引擎级 node_timeout** 砍掉（与板面规模无关）

> **前一版 `dev_dr_e0c4_20260813_0410` 的下场**：四轮 attempt 过审，但**核心交付 §1.1 在真机上是空转的** ⇒ gate REJECT。
> 它把"tick 上界"做成了 profile 里的 `TICK_TIMEOUT_MS`，而**真正砍掉 tick 的不是这个 env**。
> 详见 **GT-15**。⚠️ 同时它推翻了我上一版给的 GT-13 前提：**超时与板面规模无关**。
>
> **前一版做对、本包必须原样保留的**：§1.3（驱动响亮报 `TICK FAILURE`、入口具名失败而不是继续空转）、
> `MAX_CLUES=24`（按 Z1 要求收窄回归范围）。⛔ 不得回退这两项。

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E0c3b 的 `main`）
**前序**：E0c3b 已把 triage 门限死锁解开并**已合并**——真机上板面第一次到达非 null 终态
（`termination.state=capped`）。但**入口观察不到它**：板面一上规模，tick 叶子本身开始超时。
本包只修这一件事。**⛔ 请保持改动面小。**

---

## 0　⛔ 地面真相（真机取证，照抄，不得推测、不得由 fixture 反推）

### GT-15　⭐⭐ 真正砍掉 tick 的是 `workflow.yaml` 里的 `node_timeout: 30`（引擎级，秒）

`workflows/deep-research/tick/workflow.yaml:9` 逐字（**前一版没动过这一行**）：

```yaml
limits: { max_nodes: 64, wall_clock: 60, node_timeout: 30, max_retries: 0, concurrency: 1 }
```

前一版在 profile 里声明 `TICK_TIMEOUT_MS=600000`（10 分钟）并经
`fleet.yaml.tpl → workflow.yaml → tick.md` 注入成 **env**，但 env 只影响 tick-entry 自己的内部行为，
**决定引擎何时杀掉这个叶子的是上面那个 `node_timeout`**。⇒ 声明的 10 分钟上界**永远不可能生效**。

真机实录（派发方 2026-08-13 05:27 在 E0c4 候选上跑 `bash bin/e0-regression.sh`，逐字）：

```
drain #1: reason=max_rounds termination.state=null head_seq=2
drain-2.stderr:
  [deep-research-loop] TICK FAILURE: run_dir=/data/loop-engine/runs/2026-08-13T053003-d4fb0f0a error=exec
  [deep-research-loop]   journal result: [外部调用失败 status=TIMEOUT]
  [deep-research-loop] TICK FAILURE: run_dir=/data/loop-engine/runs/2026-08-13T053044-b655217f error=exec
  [deep-research-loop]   journal result: [外部调用失败 status=TIMEOUT]
两个 tick run 的 events 均为 ["start","spawn","dispatch","done","exec_failed","stop"]
时长分别 39.9 秒 与 30.5 秒          ← 与 node_timeout: 30 吻合，与 600000ms 完全无关
入口：DRAIN FAILED (attempt 2) reason=read_termination_failed exit=3 ⇒ 入口 exit=5
```

### GT-16　⭐⭐ 超时**与板面规模无关**（推翻上一版的 GT-13 前提）

上面两次超时发生在 **drain #2、index head_seq=2** 的板面上——**只有种子那一条线索**。
所以本包要回答的真问题是：

> **在一块只有 2 条消息的板上，一个 tick 为什么会跑超过 30 秒？**

⛔ 不得把答案假设成"板子大"；⛔ 不得靠调大 `node_timeout` 掩盖（那只是把闸刀往后挪）。
必须取证到**那 30 秒花在哪一步**（进程启动 / bus I/O / spawn / 等 worker 结果 / harvest），
再决定是消除它还是给它一个**引擎能看见的**上界。

> 参考：早先在 E0c3b 长跑里也观察到过 tick 以 `status=TIMEOUT` 死亡、单次 904 秒。
> 两个数字（30–40 秒 与 904 秒）都真实存在，说明**不止一个超时源**，取证时不要只认一个。

### （历史）GT-13　板面上规模后 tick 连续 4/4 以 `status=TIMEOUT` 死亡（904 秒）

派发方 2026-08-13 01:52–04:05 在 E0c3b 候选上真机长跑（自建 `e0-long` profile：
40 轮上限 / 10800 秒墙钟 / `TRIAGE_THRESHOLD=1`），逐字实录：

```
板面增长：head_seq 2 → 6 → 6 → 16 → 31 → 53 → 61 → 66（drain #1..#8，各约 2–3 分钟）
drain #9 起：单轮 drain 跑 110 分钟仍未结束，round 9/16，
             loop-events 每轮恒为 {"round":N,"pending":{"tick":6}}
抽样最近 4 个 tick run：4 个全部 TIMEOUT
  journal: {"identity":"tick","error":"exec","result":"[外部调用失败 status=TIMEOUT]\\n"}
  events:  ["start","spawn","dispatch","done","exec_failed","stop"]   时长 904.2 秒
测试总线板面（同一时刻）：
  research:…index 70 条   research:…evidence 84 条   board:agent-runs 27 → 159
```

**⭐ 决定性对照**：同一块板上跑**只读** `vite-node src/tick-entry.ts -- --inspect <index>`，
**秒级返回**，逐字：

```json
{ "statusDistribution": { "explored": 12, "dropped": 1, "blocked": 21 },
  "decisions": [],
  "termination": { "state": "capped", "capHit": true,
    "boardComposition": { "proposed": 0, "open": 0, "inFlight": 0, "explored": 12, "blocked": 21 } } }
```

⇒ **决策计算本身很快；慢的是 `--run` 的副作用路径。**
⇒ 板面**早已是终态**（`capped`，`proposed/open/inFlight` 全 0），
但每个 tick 都在超时里死掉、吐不出 stdout ⇒ drain 拿不到可用结果 ⇒ 一直烧轮次 ⇒
入口**永远读不到那个已经存在的终态**。

### GT-14　排查线索（⛔ 是线索不是结论，必须自己取证确认）

- 仓内已有测试提到 `AGENT_RESULT_TIMEOUT_MS` / `AGENT_RESULT_POLL_MS` 同时被
  **triage 的 readResult** 与 **generate 的 readBody** 使用（见 `test/g6-result-timeout.test.ts` 附近的 R1 用例）。
- 若一个 worker **退出了却没发 result**，上述读取就会等满整个超时。
  `board:agent-runs` 在本次长跑里从 27 涨到 159，其中有多次 `agent.run.exited.v2`。
- `workflows/deep-research/tick/workflow.yaml:9` 逐字：
  `limits: { max_nodes: 64, wall_clock: 60, node_timeout: 30, max_retries: 0, concurrency: 1 }`

⛔ 不得未经取证就断定原因；⛔ 更不得"把超时调大"当作修复。

## 1　交付内容（只此三项）

### 1.1 回答「一个 tick 为什么会超过 30 秒」并消除它

先**取证**：把一次 `--run` 的耗时按阶段拆开（进程/依赖启动、bus 读写、CAS、spawn、
等 worker 结果、harvest、triage、续投 put），给出**实测数字**，指认那 30 秒花在哪。
然后消除它，使**在种子板（2 条消息）上的一个 tick 稳定远低于引擎的 `node_timeout`**。

⛔ 不得靠调大 `node_timeout` 或 `AGENT_RESULT_TIMEOUT_MS` 掩盖；
⛔ 不得为求快跳过 harvest / triage（那是把功能砍了）；
⛔ 若确实需要更大的引擎级上界，必须**改那个引擎真的会读的地方**（`workflow.yaml` 的 `limits`），
并说明为什么这个值是够用的下界——⛔ 而不是再在 profile 里声明一个引擎看不见的 env。

### 1.2 「worker 退出但没发 result」必须有界且响亮

任何等待 worker 结果的读取（triage readResult / harvest / generate readBody）在
**对应 run 已 exited 却无 result** 时，必须**立即停止等待**并记录一条可观测的诊断
（点名 run_id、role、已等时长），⛔ 不得死等满超时。

### 1.3 tick 超时不得被 drain 静默吞掉

现状：tick 以 `exec_failed` 死掉后，drain 继续烧轮次、`pending` 恒定不降、
最终以 `max_rounds` 收场，入口只看到"又一轮没收敛"。
本包要让**一轮 drain 内出现 tick 超时/exec_failed ⇒ 响亮失败**（点名 run_dir 与超时步骤），
使这种情形不再伪装成"还没收敛"。
（仓内已有 `scripts/check-drain-failures.mjs` 走同类取证路径，⛔ 复用它，不要另写一份。）

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` **连跑两次都全绿**（抖动一次即视为未交付）。
2. **⭐⭐ 判别性（GT-15/GT-16）**：在**种子板（只有 1 条线索）**上驱动真实 `--run`，
   断言其耗时**低于引擎 `node_timeout` 的一半**且 `termination` 可被读出；
   把 §1.1 的修复撤回 ⇒ 该测试变红。
   ⛔ 断言必须针对**引擎真正生效的那个上界**，不得只断言 profile 里的 `TICK_TIMEOUT_MS`。
3. **⭐ 判别性（GT-14/§1.2）**：构造"run 已 exited 但无 result" ⇒ 读取**立即结束**并产出诊断；
   改回死等 ⇒ 测试变红。
4. **⭐ 判别性（§1.3）**：drain 内出现 tick `exec_failed` ⇒ 入口**响亮失败**且点名 run_dir；
   改回"继续当作没收敛" ⇒ 测试变红。
4b. **回归 ⛔（前一版已做对的两项）**：驱动响亮报 `TICK FAILURE`（含 run_dir 与 status）、
   入口以具名原因非零退出；以及 `MAX_CLUES` 由 profile 声明并收窄回归范围。⛔ 不得回退。
5. **回归 ⛔**：E0c1/E0c2f/E0c3b 的全部行为逐字不变（跨 drain 循环与退避、GT-6 三分类、
   终态取真值、续投门、失败轮回显、进度行与板面构成、per-run 板、种子带 sources、
   head_seq 只从列表端点取、生产总线真实全量求和与护栏、运行记录归档、
   `TRIAGE_THRESHOLD` 可配且缺省仍为 3、假 bus 端口由内核分配）。
6. **Z1（真机）**：`bash bin/e0-regression.sh` 在**交付 profile 自己声明的预算内**跑到非 null 终态、
   **退出 0**，`board:agent-runs` head_seq 严格增长，且证据 channel head_seq > 0。
   ⚠️ 派发方实测：当前形态下到终态约需 **3 小时**，而交付 profile 声明的墙钟是 **2400 秒**——
   两者必须**自洽**。⛔ 自洽的做法**不是**把墙钟调到几小时（那样的回归基线没人跑得起），
   而是**收窄回归基线的研究范围**（例如给回归 profile 单独降 `maxClues`、或用更聚焦的种子），
   使它在 profile 声明的预算内**真的能收敛**。⛔ 同时不得缩到秒级而失去回归意义。
7. **Z2（真机）**：运行前后生产总线 `sum(head_seq)` 零增长（派发方独立复算）。
8. **Z3（真机）**：连续两次执行都退出 0、各自独立 run id 与独立研究板、两次都满足判据 6。

> 判据 6–8 由派发方在真机上验证。

## 3　⛔ 明确不做

web/content 接线（E2b）、ingest（E1）、anchor scheme（E3）、收工仲裁者（E5）、原子产物（E4）、
驱动脚本重写进 TS 入口（E7）、协议注册、`recipes/*` 工具白名单、生产 profile `agent-harness.env`。
⛔ 不重写 E0c1/E0c2f/E0c3b 已交付的任何东西。

> 旁证（⛔ 本包不修，仅供理解现场）：长跑里 34 条线索有 **21 条 blocked**
> （source 映射不到 worker role），因为 web/content worker 还没接线——那是 E2b。
> 也就是说当前基线有相当比例的工作量花在探不动的线索上。

## 4　运行环境前提（派发方已就位，⛔ 实现者不需要做也不得与之冲突）

测试总线 `http://127.0.0.1:7495`（独立 SQLite，与生产 7490 零共享）：三个 agent 已注册、
token 落 `/data/agent-bus-test/tokens/`；`board:agent-runs` 已建；协议已用
`agent-run register-bus-protocols` 供给齐全（14 个 kind）。
⛔ 实现者不得在代码里自动注册 protocol：协议注册不可逆，是拍板级动作。

## 5　评审口径

- **REJECT 只用于 blocker 级**：判据不成立、判别性缺失、自造契约、用调大超时掩盖 §1.1、
  改坏前序已有行为、越出 §1 范围。文风与偏好写成 non-blocking 建议。
- ⚠️ 本线累计因「为观察不到的产物发明契约、再写 fixture 迎合它」被驳回 7 次，
  因「测试绕开被测入口、在测试内部重实现一遍逻辑」被驳回 3 次，
  因「实现对了但判别性没落地」被驳回 4 次。**判据 2–4 的测试必须真正驱动被测对象**。
- reviewer 只读，判据 1–5 由 acceptance 命令的执行结果作证，⛔ 不要求 reviewer 执行 shell。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`（引擎保留路径，写入即永久 wedge）。
