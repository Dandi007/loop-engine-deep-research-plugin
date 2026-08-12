# E0c —— 真机端到端回归基线（自包含重做）

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E0 的 `main`）
**背景**：E0 已合入；E0a 在人工闸门被驳回、E0b 跑了 7 个 attempt / 6 次 final REJECT 后被取消——
**两者的失败原因都不是实现能力，而是判据在构造上不可达**（详见 §0.4 / §0.5）。
本包一次性把这条基线做成，**自包含**，不依赖 E0a/E0b 的任何未合入产物。

## 0　⛔ 先读这一节：五份地面真相，禁止再自造契约

E0a/E0b 累计 7 轮驳回，其中 4 轮是同一件事：**实现者为自己观察不到的东西发明契约，
再写 fixture 去满足这个发明**——单测全绿、真机必挂。opus-5 reviewer 把它叫作
"the fourth same-shape recurrence"。以下全部由派发方在真机上逐字取证。
**照抄，不得推测，不得由 fixture 反推。**

### GT-1　bus 的两个 channel 端点，字段集不同

```
GET /v1/channels/<id>   →  channel_id, closed_at, created_at, default_lease_ms,
                            delivery_mode, max_attempts, metadata, owner_agent_id,
                            refs_required, visibility          ← ⛔ 没有 head_seq
GET /v1/channels        →  channel_id, closed_at, created_at, delivery_mode,
                            head_seq, owner_agent_id, visibility ← head_seq 只在这里
```
列表会把**已创建但为空**的 channel 以 `head_seq: 0` 列出（不是省略）；假 bus 必须照此实现。

### GT-2　驱动 `bin/deep-research-loop.sh` 的 stdout 只有三行，⛔ 不含 termination

```
{"id":"a9-…","status":"open","body":{"seed":true}}
[deep-research-loop] mode=deep-research run_root=/data/loop-engine/e0-runs/<run>/loop-run
{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"…","drain_id":"…"}
```

### GT-3　`termination` 在 tick 自己的 stdout 里，经 journal 落盘（**嵌套转义字符串**）

tick `--run` 打印的完整 JSON（派发方直接调 `vite-node src/tick-entry.ts -- --run …` 实测，逐字）：

```json
{ "channelId": "research:…index", "messageCount": 0, "decisions": [], "writes": 0,
  "skipped": 0, "spawns": [], "harvestReports": [], "triageReports": [],
  "hasPendingWork": false,
  "termination": { "state": null, "coverage": 0, "zeroGrowthRounds": 1, "capHit": false } }
```

它由 loop-engine 收进 `<run_dir>/journal.jsonl`，每行形如
`{"run_id":"tick~1","identity":"tick","result":"<tick 的完整 stdout，转义字符串>","effects":[],…}`。
⛔ `termination` **不是** journal 行的顶层键；必须先取 `result` 再解析其中的 JSON。
取证路径（沿用仓内 `scripts/check-drain-failures.mjs` 同一条）：
`drain 摘要.drain_id → index.jsonl → run_dir → journal.jsonl → 最后一轮 tick 的 result → termination.state`。

### GT-4　⭐ 种子不带 `sources` ⇒ 卡结构性不可派发

真机板面实录（E0b 候选，测试总线）：

```
seq 1 | research.clue.v2 | status=open    | sources=[]
seq 2 | research.clue.v2 | status=blocked | sources=[] | rationale="source list has no mapped worker role; cannot dispatch"
board:agent-runs head_seq=0   evidence head_seq=0   docs head_seq=0
```
⇒ 没派出任何 worker、没有任何 evidence。`bin/tick-entry.sh --seed` 支持 `--source <name>`，必须用。

### GT-5　⭐⭐ 续投门与终态判据差一拍 ⇒ `termination.state` 在小板面上永远是 null

派发方逐行核对源码确认（这是**上游流水线的缺陷**，不是入口脚本的）：

- `src/tick.ts:383-389` `decideTermination`：只有
  `zeroGrowthRounds >= cfg.zeroGrowthThreshold`（缺省 **2**，见 `src/tick.ts:88`）
  且 `inFlight === 0 && proposed === 0` 时，`state` 才非 null。
- `workflows/deep-research/tick/templates/tick.md:93`：**续投门是 `hasPendingWork`**——
  板面还有 proposed/open/in_flight 才投下一条 trigger。

于是小板面上：所有 clue 一旦跑成 explored/blocked，`hasPendingWork` 立刻 false ⇒ 不再续投
⇒ drain 收敛退出，而此刻 `zeroGrowthRounds` 往往才 1 ⇒ **永远攒不到 2**。

**佐证**：派发方遍历 `/data/loop-engine/runs/` 全部历史 run，**从未出现过一次非 null 的
`termination.state`**——不是没跑过，是结构上跑不出来。

## 1　交付内容

### 1.1 承接 E0b 已经做对的四块（⛔ 原样承接，不要重新发明）

1. **head_seq 只从列表端点取**：读 `GET /v1/channels`，按 `channel_id` 定位；
   找不到该 channel 或该项无 `head_seq` ⇒ 响亮失败并**点名 channel 与实际拿到的字段集**；
   ⛔ 不得当作 0 继续。
2. **生产总线 `sum(head_seq)` 是真实全量求和**：对列表里**所有** channel 求和。
   ⛔ 凡从 JSON 取值一律真解析（Node 已在依赖内，`JSON.parse` 即可），
   ⛔ 禁止用贪婪正则从单行 JSON 抽多值（历史事故：实测得 3，真实和 9788，使判据变空）。
3. **空板自播种，且种子必须带 `--source`**（GT-4）：种子文本与 sources 均由 profile 声明，
   ⛔ 不写死在脚本里；本 profile 用 `code-local`；种子文本须与 `ALLOWED_ROOT` 指向的仓相称，
   能让 code-local worker 真找到东西，⛔ 不得是放之四海皆可的空话。
   播种失败 ⇒ 响亮失败、非零退出。
4. **终态从 `termination.state` 取真值**（GT-3 路径）。读取链路任一步失败 ⇒
   响亮失败并**点名是哪一步**，⛔ 不得回退成「用 drain reason 凑合」、
   ⛔ 不得把「读不到」当成任一方向的默认值。

### 1.2 ⭐ 每次运行用一块属于该 run 的干净研究板

三条 research channel 的名字由 profile 基名 + 本次 `run_id` 派生
（如 `research:e0-<run_id>.{index,evidence,docs}`）；`board:agent-runs` 是全局的、不随 run 变。
每次运行创建这三条新 channel（不存在则建）。
⛔ 不得用「清空/删除旧 channel」实现——bus 是 append-only 无 DELETE，做不到也不许假装做到。
在**测试总线**上累积 channel 是可接受代价。

### 1.3 ⭐⭐ 对齐续投门与终态判据（GT-5，本包的关键修正）

`workflows/deep-research/tick/templates/tick.md` 的续投条件从

```
hasPendingWork == true
```

改为

```
hasPendingWork == true  或  (termination.state 仍为 null 且 未触顶)
```

即：**板面已排空但终态尚未判定时，仍要继续投 trigger**，让零增长轮把 `zeroGrowthRounds` 攒够，
直到 `decideTermination` 给出非 null 的 `converged` / `partial` / `capped`。

- 触顶（`capHit`）时按既有语义走（`capped` 需等在途排空），⛔ 不得因本改动绕过熔断。
- ⛔ 不得取消或提高 `max_passes` 之外的任何既有上限；本改动只补「差的那一拍」，
  不得让 loop 在真正无事可做时无限空转——续投必须在拿到非 null 终态后停止。
- 续投条件的判定必须用**真 JSON 解析**读 `run_output`
  （现状 `tick.md:93` 用 `grep -q '"hasPendingWork": *true'` 正则，本包一并改掉）。

> ⚠️ 本条动的是流水线终止语义（rev7 §3.4 的地界）。派发方判定这是**让既定目标可达的最小修正**
> 而非方向变更：spec 一直要求「跑到终态」，而现状使终态不可达。E5（收工仲裁者）后续会重写这块，
> 本改动与其方向一致（都是让「何时收工」成为可判定的事）。

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` 全绿。
2. **⭐ 判别性**：假 bus 的单 channel GET 若返回 `head_seq`，或列表 GET 不列出空 channel ⇒ 测试变红（GT-1）。
3. **⭐ 判别性**：把 §1.1.2 的求和换成贪婪正则实现 ⇒ 测试变红。
4. **⭐ 判别性**：种子不带 sources（或 profile 未声明 sources）⇒ 播种**响亮失败**，
   ⛔ 不得静默播一条 `sources: []` 的线索。
5. **⭐ 判别性**：`termination.state` 为 `null` ⇒ 入口非零退出；
   把终态判据换成「用 drain 摘要的 reason」⇒ 测试变红。
6. **⭐ 判别性（§1.3）**：构造「板面已排空但 `termination.state` 仍为 null 且未触顶」的情形
   ⇒ **仍然续投**；把续投门改回只看 `hasPendingWork` ⇒ 测试变红。
7. **⭐ 判别性（§1.2）**：两次运行使用的 research channel 名不同且各含自己的 run_id；
   把 channel 名改回固定值 ⇒ 第二次运行的测试变红。
8. 生产总线护栏（`AGENT_BUS_URL` 指向 7490 或 token 落在 `/data/agent-bus/` 下 ⇒ 拒绝启动、非零退出）
   与运行记录归档（仓外、含 profile/channel/exit code/loop run 目录路径/生产总线跑前跑后读数）齐备。
9. 仓内不得出现任何 token 明文。
10. **Z1（真机）**：`bash bin/e0-regression.sh` 跑到**非 null 终态**、退出 0；
    且 **`board:agent-runs` 的 head_seq 相对跑前严格增长**（= 本次运行真的派出过 worker）。
    ⛔ 只有板面 clue 增长、worker 从未被派出，不算跑通。
11. **Z2（真机）**：该次运行前后生产总线 `sum(head_seq)` 零增长；两个读数进运行记录。
    **派发方会用与实现无关的独立脚本复算这两个数字**，对不上即判不过。
12. **Z3（真机）**：连续两次执行**都退出 0**、各自独立 run id 与独立研究板、两次都满足判据 10。

> 判据 10–12 由派发方在真机上执行验证，不要求 reviewer 自己跑。

## 3　运行环境前提（派发方已就位，实现者不需要做，也不得与之冲突）

测试总线 `http://127.0.0.1:7495`（systemd user unit `agent-bus-test.service`，
独立 SQLite `/data/agent-bus-test`，与生产 7490 零共享）上，派发方已完成：

- 三个 agent 已注册、token 落 `/data/agent-bus-test/tokens/`（`uther-tui` / `agent-run` / `arbiter`）；
- `board:agent-runs` 已创建；
- **六个 protocol kind 已从生产总线原样复制注册**：`research.clue.v2` / `research.evidence.v2` /
  `research.doc.v2` / `worker.result.v1` / `dr-triage.result.v1` / `dr-doc.result.v1`。
  （E0b 首次真机跑正是先挂在 `422 Protocol kind 'research.clue.v2' not registered`。）

⛔ 实现者不得在代码里自动注册 protocol——协议注册不可逆，是拍板级动作；
测试总线的协议供给属环境 provisioning，归派发方。

## 4　⛔ 明确不做

| 不做 | 理由 |
|---|---|
| web / content 信源接线（`SOURCE_ENUM` / `SOURCE_TO_ROLE`） | E2b 的范围 |
| ingest / MinerU / digest 权威计算 | E1 |
| 扩 anchor-check 的 scheme | E3 |
| 收工仲裁者（用模型判该不该收工） | E5；本包只修「差一拍」的机械缺陷 |
| 原子产物切分、引用过滤 | E4 |
| 把 199 行驱动脚本重写进 TS 入口 | E7 |
| 注册任何新的 protocol / message kind | 不可逆，需另行拍板 |
| 改 `recipes/*` 工具白名单 | 已拍板豁免（V-4） |
| 动生产 profile `agent-harness.env` | 生产配置不在本包范围 |

额外：⛔ 不得为了让判据过而放宽判据本身（把终态断言改成「没报错就算过」、
把 Z2 改成只比较某一个 channel、伪造 worker 派发等）。判据的严格性就是本包的交付物。

## 5　评审口径

- **REJECT 只用于 blocker 级**：判据不成立、判别性缺失、自造契约（见 §0）、
  放宽或删除已列判据、静默失败、凭证泄漏、越出 §1 范围。
  文风与偏好写成 non-blocking 建议。
- ⚠️ **特别提醒**：本包的前两版（E0a/E0b）合计带着 4 次「自造契约」形状通过了 continuous
  与 final 两道 review，最终靠人工闸门与真机验收才拦下。审本包时请逐处核对：
  **每一处从 HTTP 响应或落盘产物里取字段的代码，取的字段在真实产物里到底存不存在**。
- reviewer 只读，判据 1–9 由 acceptance 命令的执行结果作证，⛔ 不要求 reviewer 执行 shell。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`（引擎保留路径，写入即永久 wedge）。
