# E0c8 —— 依据要真、兜底要真、测试要真驱动

> **前一版 `dev_dr_e0c7_20260813_1155`**：四轮 attempt，最后 **acceptance 挂在自己新写的测试上** ⇒ development FAILED。
> 四轮里 reviewer 反复抓到同一类问题，本包把它们写成硬约束（GT-20～GT-23）。

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E0c3b 的 `main`）
**前序**：E0c3b 已把 triage 门限死锁解开并**已合并**——真机上板面第一次到达非 null 终态
（`termination.state=capped`）。但**入口观察不到它**：板面一上规模，tick 叶子本身开始超时。
本包只修这一件事。**⛔ 请保持改动面小。**

---

## 0　⛔ 地面真相（真机取证，照抄，不得推测、不得由 fixture 反推）

### GT-20　⭐⭐ 交付自己的 acceptance 挂了：重构后的取证链路有 bug

`npm test` 逐字：

```
FAIL test/e0c2-termination.test.ts > 判据 6 (GT-3 limits) …
     > always null ⇒ hits wall clock limit (not attempt limit — GT-19 wall clock is primary)
AssertionError: expected '[e0-regression] loaded deploy profile…' to match /HIT WALL CLOCK LIMIT/i
实际输出里出现的是：
  [e0-regression] FAILED to read termination.state (attempt 2):
    [read-termination] FAILED at step "find lane entries": no lane entries found in i…
```

⇒ 前一版把 read-termination 重构出一个新步骤 **"find lane entries"**，它在自己的测试环境里就取不到条目，
于是入口在撞墙钟之前先死在取证上。**⛔ 本包必须先让取证链路在自己的测试里稳定成立**，再谈上限语义。

### GT-21　⭐⭐ 「依据」不得编造：`timings` 必须真覆盖整个 tick

前一版给 `node_timeout` 的依据写的是「timings 埋点实测 p95 约 180s、最大 390s」，
但 reviewer 核实：`totalMs` = `tTerm - t0`，**不含 generate 段**，也没有按被问的那一阶段拆分
⇒ 那两个数字**不是这套埋点能产出的**。

⛔ 本包若再以实测为依据，`timings` 必须**覆盖整个 tick 的所有阶段**（含 generate），
并且交付里要能指出**这些数字是从哪个字段、哪次运行、哪个文件读出来的**。
⛔ 不得给出无法溯源的数字。

### GT-22　⭐ 兜底必须真能终止

前一版把 `DRAIN_MAX_ATTEMPTS` 改成撞上限只打 warning 然后继续重试 ⇒ **兜底不再兜任何底**。
⛔ 失控兜底必须**真的终止循环并非零退出**；它只是要满足「正常情形下不会先于墙钟触发」，
不是「永远不触发」。

### GT-23　⭐ 判别性测试必须驱动被测对象（本线累计第 7 次）

前一版判据 2a 的四个用例是把 `bin/e0-regression.sh` 当**文本**读、比较
`"HIT WALL CLOCK LIMIT"` 与 `"HIT ATTEMPT LIMIT"` 两个字面量的**字节偏移**谁在前再做算术；
判据 2b 把 `fetch` 与 `node:child_process.spawn` 全 mock 掉，`elapsed` 天然是几毫秒。
⛔ 两者都不成立。判别性测试必须**真的执行入口 / 真的跑 `--run`**。

### （历史）GT-18　⭐⭐ 同一交付背靠背两跑，一次零超时、一次两次超时 ⇒ 超时是间歇性的

```
run 1  e0-1786589921832979147-1672191
  entry_exit_code=4  drain_attempts=12  final_termination_state=null  prod_bus_delta=0
  全程 0 次 TICK FAILURE；板面只有 2 条线索（explored 1 / in_flight 1）、head_seq=8
  worker 正常：agent.run.exited.v2 exit=0，耗时 221.084s 与 36.109s
  ⇒ HIT ATTEMPT LIMIT: max_attempts=12 drain_attempts=12

run 2  e0-1786591650752241473-1751345
  entry_exit_code=5  drain_attempts=2   final_termination_state=null  prod_bus_delta=0
  drain #2 两个 tick 双双：
    journal: {"identity":"tick","result":"[外部调用失败 status=TIMEOUT]\n","error":"exec"}
  ⇒ FAILED to read termination.state … DRAIN FAILED reason=read_termination_failed exit=3
```

⇒ **`node_timeout: 30`（引擎级，秒）对一个合法地要做 bus I/O + spawn 的 tick 就是太紧**，
只是有时候赶得及、有时候赶不及。⛔ 不要再把"这次没超时"当成修好了。

### GT-19　⭐ 固定的 attempt 次数上限会让「研究这次慢」变成「基线失败」

run 1 里 worker 一切正常（exit 0），只是这一轮研究产出少、节奏慢；
12 次 attempt × 约 2.5 分钟就烧完了，而**墙钟预算 2400 秒还没用掉**。
⇒ 决定成败的变成了"次数"这个与研究进度无关的量。

### （历史）GT-17　⭐⭐ 同一交付、同一台机器、背靠背两跑：一次 exit 0，一次 exit 5

**第二跑（成功，逐字）** `run.meta`：

```
final_termination_state=capped   entry_exit_code=0   drain_attempts=9
prod_bus_sum_before=10502  prod_bus_sum_after=10502  prod_bus_delta=0
板面：index 61  evidence 76  docs 4      board:agent-runs 227 → 460
```

**第三跑（失败，逐字）**：drain #2 挂，入口 `exit=5`，tick 的 journal result 是：

```
[bash 非零退出 EXIT:2]
E0c5 §1.2: run 13d6c444-bb8a-40e9-81e5-a2b4e1ed42b9 (generate) exited without
producing a dr-doc.result.v1 after 3159ms — refusing to wait the full timeout
```

⇒ §1.2 的**检测是对的**（3159ms 就发现并拒绝死等），但它**让整个 tick 非零退出**，于是：
tick 失败 → 驱动报 `TICK FAILURE` → 入口的终态读取失败 → **整跑 exit 5**。

**两跑唯一的差别就是有没有一个 generate worker 没产出 doc。**
⛔ 这是把"某个可恢复的局部失败"升级成了"整条基线失败"。

### （历史）GT-15　⭐⭐ 真正砍掉 tick 的是 `workflow.yaml` 里的 `node_timeout: 30`（引擎级，秒）

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

### 1.1 ⭐ 把引擎级 tick 上界抬到真实需求之上，并给出依据

改 `workflows/deep-research/tick/workflow.yaml` 的 `limits.node_timeout`（**引擎真的会读的那个**），
把它抬到能容纳一个 tick 的真实工作量。⛔ 取值不得拍脑袋：用前一版已交付的 `timings`
分阶段埋点，给出**实测的 p95/最大单 tick 耗时**，说明所选值为什么是够用的下界。
同时保留"超过上界要响亮失败"的语义（⛔ 不得变成无上限）。

> 说明：上一版 spec 曾禁止"调大 node_timeout 掩盖问题"。GT-18 之后判断改变：
> 实测表明 tick 的**合法工作**本身就可能超过 30 秒，此时抬高引擎上界是**正确的修复**，
> 不是掩盖——前提是给出实测依据。

### 1.1b ⭐ 上限按**预算**给，不按次数给（GT-19）

入口的收尾条件以**墙钟预算**为主：只要墙钟没用完就继续退避重试，
⛔ 不得让一个与研究进度无关的固定 attempt 次数先撞线。
`DRAIN_MAX_ATTEMPTS` 可保留为**失控兜底**，但必须显著大于"墙钟预算 ÷ (最短 drain + 退避)"，
使它在正常情形下**不可能先于墙钟触发**；profile 声明的三个值必须自洽，并在注释里写清算式。

### （保留）1.1c 「run 退出却没产出 result」必须**记录并继续**，不得毙掉 tick

检测逻辑保留（不死等、点名 run_id / role / 已等时长），但处理方式改为：
**把它作为该条工作的局部失败记录下来（诊断进 stdout 与运行记录），本轮 tick 继续处理其余工作并正常返回**。
⛔ 不得让 tick 非零退出；⛔ 不得静默（诊断必须留存、可被 grep 到）；
⛔ 也不得反过来把它当成成功（该条 clue/doc 的状态要如实反映失败，
若既有状态机没有对应终态，按仓内既有语义标注并说明理由）。

> 边界：**真正让 tick 无法继续的错误**（如 bus 不可达、板面读不出来）仍应非零退出——
> ⛔ 不要把本条改成"tick 永不失败"。

### （保留）1.1b 「一个 tick 为什么会超过 30 秒」——上一版已解决，⛔ 不得回退

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
2. **⭐⭐ 判别性（GT-18）**：一条测试断言 `workflow.yaml` 的 `limits.node_timeout`
   **不小于**交付中记录的实测最大单 tick 耗时的若干倍（倍数与依据写在注释里）；
   把它改回 30 ⇒ 测试变红。⛔ 断言必须读 `workflow.yaml` 里那个键，不得只读 profile 的 env。
2a. **⭐ 判别性（GT-19）**：构造「墙钟预算充足但 attempt 次数已用尽」的情形 ⇒
   入口**必须继续**（不得因次数撞线而失败）；把上限逻辑改回"次数优先" ⇒ 测试变红。
2z. **⭐⭐ 判别性（GT-17，回归）**：构造「一个 generate/worker run 已 exited 但没产出 result」⇒
   tick **仍以 0 退出**、其余决策照常执行、且诊断出现在输出里；
   把处理改回"非零退出" ⇒ 该测试变红。
   再配一条反向用例：**bus 不可达**这类真正无法继续的错误 ⇒ tick 仍必须非零退出。
2b. **⭐ 判别性（GT-15/GT-16，回归）**：在**种子板（只有 1 条线索）**上驱动真实 `--run`，
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
