# E0c1 —— 回归基线：板面与凭证域

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E0 的 `main`）
**为什么是小包**：前一版 E0c 一次做完全部内容（14 文件 / 1120 insertions），
final review **连续两次跑满 3000 秒硬超时**（`exit 93 / reason=timeout`），共烧 100 分钟、零 verdict。
而本线顺利过审的两个包分别是 4 文件 523 行（E0）与 11 文件 391 行（E2a）。
⇒ 本包**只做板面与凭证域**，终止语义域另开 E0c2。**⛔ 请保持改动面小**，
超出本 spec 的顺手改动会把包撑大到审不完。

---

## 0　⛔ 地面真相（真机取证，照抄，不得推测、不得由 fixture 反推）

本目标的前两版累计被驳回多轮，其中 4 轮同一形状：**实现者为自己观察不到的产物发明契约，
再写 fixture 满足这个发明**——单测全绿、真机必挂。以下形状全部实测：

### GT-1　bus 两个 channel 端点字段集不同

```
GET /v1/channels/<id>   →  channel_id, closed_at, created_at, default_lease_ms,
                            delivery_mode, max_attempts, metadata, owner_agent_id,
                            refs_required, visibility          ← ⛔ 没有 head_seq
GET /v1/channels        →  channel_id, closed_at, created_at, delivery_mode,
                            head_seq, owner_agent_id, visibility ← head_seq 只在这里
```
列表把**已创建但为空**的 channel 以 `head_seq: 0` 列出（不是省略）；假 bus 必须照此实现。

### GT-2　种子不带 `sources` ⇒ 卡结构性不可派发

真机板面实录：

```
seq 1 | research.clue.v2 | status=open    | sources=[]
seq 2 | research.clue.v2 | status=blocked | sources=[] | rationale="source list has no mapped worker role; cannot dispatch"
board:agent-runs head_seq=0    evidence head_seq=0
```
⇒ 没派出任何 worker。`bin/tick-entry.sh --seed` 支持 `--source <name>`，必须用。
带上之后实测：`sources=['code-local']`、卡为 `open`、下一 tick 即 `dispatch`。

### GT-3　贪婪正则从单行 JSON 抽多值不是求和

bus 返回单行 JSON；`sed -n 's/.*"head_seq"[^0-9]*\([0-9]*\).*/\1/p'` 每行只捕获**最后一个**。
实测：该写法算出 **3**，真实 `sum(head_seq)` 是 **9788**。
⇒ 用它做「生产总线零写入」判据，等于判据是空的。

## 1　交付内容（只此四项）

### 1.1 head_seq 只从列表端点取
读 `GET /v1/channels`，按 `channel_id` 定位取 `head_seq`。
找不到该 channel、或该项无 `head_seq` ⇒ **响亮失败并点名 channel 与实际拿到的字段集**；
⛔ 不得当作 0 继续（把「读不到」和「确实是 0」混为一谈会让增长判据失效）。

### 1.2 生产总线 `sum(head_seq)` 是真实全量求和
对列表里**所有** channel 求和。⛔ 凡从 JSON 取值一律真解析（仓内已依赖 Node，`JSON.parse` 即可，
⛔ 不新增依赖）；⛔ 禁止贪婪正则抽多值（GT-3）。
入口在跑之前与跑之后各读一次生产总线（`http://127.0.0.1:7490`，只读 GET）并写进运行记录；
两个读数不相等 ⇒ 判失败并非零退出。读失败即失败，⛔ 不得跳过检查。

### 1.3 每次运行用一块属于该 run 的干净研究板
三条 research channel 名由 profile 基名 + 本次 `run_id` 派生
（如 `research:e0-<run_id>.{index,evidence,docs}`）；`board:agent-runs` 是全局的、不随 run 变，
但**必须在预备清单里**（`src/tick-run.ts` 的 `runsChannelId` 缺省即它，harvest/triage 都读它；
该名字在仓内只留一处真相源，⛔ 不要再写一份字面量）。
每次运行创建这三条新 channel（不存在则建）。
⛔ 不得用「清空/删除旧 channel」实现——bus 是 append-only 无 DELETE，做不到也不许假装做到。

### 1.4 空板自播种，且种子必须带 `--source`
种子文本与 sources 均由 profile 声明（⛔ 不写死在脚本里），本 profile 用 `code-local`；
种子文本须与 `ALLOWED_ROOT` 指向的仓相称、能让 code-local worker 真找到东西，
⛔ 不得是放之四海皆可的空话。播种失败 ⇒ 响亮失败、非零退出。
幂等：板非空时不重复播种。

> 另：入口需保留 E0 已有的**生产总线护栏**（`AGENT_BUS_URL` 指向 7490，或
> `AGENT_BUS_TOKEN_FILE` 落在 `/data/agent-bus/` 下 ⇒ 拒绝启动、非零退出）与运行记录归档
> （仓外、含 profile/channel 名/exit code/loop run 目录路径/生产总线跑前跑后读数）。
> ⛔ 这两块**行为不变**，本包不重写它们。

## 2　⛔ 本包不做（留给 E0c2）

- 终态判定（`termination.state` 怎么读、读不到怎么办）——**本包入口的退出码沿用现状语义即可**，
  ⛔ 不要在本包里改终态判据，也不要为它写测试。
- 续投门（`tick.md` 的 `hasPendingWork`）——⛔ 本包**完全不碰** `workflows/` 下任何文件。
- 入口反复 drain / 退避 / 墙钟上限。

其余不做项与 E0 一致：web/content 接线、ingest、anchor scheme、仲裁者、原子产物、
E7 入口重写、协议注册、`recipes/*` 工具白名单、生产 profile `agent-harness.env`。

## 3　验收判据

1. `npm ci && npm run typecheck && npm test` 全绿。
2. **⭐ 判别性**：假 bus 的单 channel GET 若返回 `head_seq`，或列表 GET 不列出空 channel ⇒ 测试变红（GT-1）。
3. **⭐ 判别性**：把 §1.2 的求和换成贪婪正则实现 ⇒ 测试变红（GT-3）。
4. **⭐ 判别性**：profile 未声明 sources（或播种未传 `--source`）⇒ 播种**响亮失败**，
   ⛔ 不得静默播一条 `sources: []` 的线索（GT-2）。
5. **⭐ 判别性**：两次运行使用的 research channel 名不同且各含自己的 run_id；
   把 channel 名改回固定值 ⇒ 第二次运行的测试变红。
6. `board:agent-runs` 在预备清单内，且该名字在仓内只有一处真相源。
7. 生产总线护栏与运行记录归档行为与 E0 逐字一致（回归）。
8. 仓内不得出现任何 token 明文。
9. **真机（派发方执行）**：`bash bin/e0-regression.sh` 跑完后——
   三条 per-run channel 被创建；板上种子 clue 的 `sources` 非空且等于 profile 声明值；
   **`board:agent-runs` head_seq 相对跑前严格增长**（真派出过 worker）；
   生产总线 `sum(head_seq)` 零增长且两个读数在运行记录里（派发方独立复算）。
   ⚠️ 本包**不要求**入口退出 0——跑到终态是 E0c2 的事。

## 4　运行环境前提（派发方已就位，⛔ 实现者不需要做也不得与之冲突）

测试总线 `http://127.0.0.1:7495`（`agent-bus-test.service`，独立 SQLite `/data/agent-bus-test`，
与生产 7490 零共享）：三个 agent 已注册、token 落 `/data/agent-bus-test/tokens/`；
`board:agent-runs` 已建；**协议已用 `agent-run register-bus-protocols` 一条命令供给齐全**
（14 个 kind，含 `research.clue.v2` 与 `agent.run.{started,exited}.{v1,v2}`——
缺后者时 worker 会以 `CONTRACT_ERROR`(exit 91) 死在发生命周期事件那步）。
⛔ 实现者不得在代码里自动注册 protocol：协议注册不可逆，是拍板级动作。

## 5　评审口径

- **REJECT 只用于 blocker 级**：判据不成立、判别性缺失、自造契约（见 §0）、
  静默失败、凭证泄漏、**越出 §1 范围**（尤其碰了 `workflows/` 或终态判据）。
  文风与偏好写成 non-blocking 建议。
- ⚠️ 逐处核对：**每一处从 HTTP 响应里取字段的代码，取的字段在真实 API 里到底存不存在**。
- reviewer 只读，判据 1–8 由 acceptance 命令的执行结果作证，⛔ 不要求 reviewer 执行 shell。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`（引擎保留路径，写入即永久 wedge）。
