# E0c11 —— 生产总线守卫必须按「本次运行」判定，而不是「这段时间生产没人写」

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E0c10 的 `main`）
**本包只做一件事。⛔ 请保持改动面小。**

---

## 0　⛔ 地面真相（真机取证，照抄，不得推测、不得由 fixture 反推）

### GT-P1　现有守卫在这台机器上**不可能通过**

E0 §1.2 交付的守卫是：入口在跑之前与跑之后各读一次生产总线（`http://127.0.0.1:7490`）的
**全量 `sum(head_seq)`**，两个读数不相等 ⇒ 判失败、非零退出。

派发方 2026-08-13 20:40–22:00 用 E0c10 候选连续跑两次，逐字：

```
run 1  e0-1786624808050351641-3921156
  final_termination_state=capped   drain_attempts=12   entry_exit_code=3
  prod_bus_sum_before=10677  prod_bus_sum_after=10689  prod_bus_delta=12
run 2  e0-1786626801291543512-4113047
  final_termination_state=capped   drain_attempts=10   entry_exit_code=3
  prod_bus_delta=10
两次的 delta **全部落在 board:agent-runs 一条 channel 上**。
```

派发方逐条核对了那些消息的来源（生产总线 `board:agent-runs` 尾部）：

```
9041 / 9044 / 9052  agent.run.started.v2  role=goal_coordinator  label=claude/opus-5/lingzhi
9048                agent.run.started.v1  label=opencode/glm-5.2/zhipu-codeplan
9050                agent.run.started.v1  label=opencode/opus-5/ccs
```

**全部来自本机其它开发线**（goal coordinator 与别的 development 的 implement/review agent），
**与这次回归运行无关**——本次运行一条都没往生产总线写。

⇒ 守卫**判的是「这段时间生产总线有没有人写」**，而这台机器上生产总线一直有别的线在写，
所以它**恒为失败**。这不是被测系统的缺陷，是判据本身设计错了（派发方的责任）。

### GT-P2　这个守卫要证明的东西

它要证明的是：**这次回归运行没有往生产总线写任何东西**——
⛔ 不是「生产总线在这段时间里静止」。

## 1　交付内容（只此一项）

把生产总线守卫改成**按本次运行的身份判定**。可行做法（任选其一或组合，⛔ 必须给出理由）：

- **按 run 身份过滤**：跑后读生产总线上本次运行**可能写到**的 channel（`board:agent-runs` 及
  本 run 派生的三条 research channel 名），断言其中**没有任何一条消息属于本次运行**
  （`run_id` / `entity_id` / sender 与本次 run 的标识对得上即算违规）；
- **按 channel 存在性**：本 run 派生的 research channel 名在生产总线上**不得存在**；
- 保留既有的**启动前护栏**（`AGENT_BUS_URL` 指向 7490 或 `AGENT_BUS_TOKEN_FILE` 落在
  `/data/agent-bus/` 下 ⇒ 拒绝启动）——⛔ 这一条行为不变。

⛔ 不得把守卫**删掉或降级成警告**：它仍必须在「本次运行真的写了生产总线」时**非零退出并点名**。
⛔ 不得改成只比对某个固定 channel 的绝对值。
运行记录里仍要保留跑前/跑后的生产总线读数（供人工复盘），但**判定不再依赖两者相等**。

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` **连跑两次都全绿**。
2. **⭐⭐ 判别性（GT-P1）**：构造「本次运行期间，生产总线上**由别人**写入了若干消息」
   ⇒ 守卫**必须放行**（不因此失败）；把守卫改回比对全量 `sum(head_seq)` ⇒ 该测试变红。
3. **⭐⭐ 判别性（GT-P2）**：构造「**本次运行自己**往生产总线写了一条」
   ⇒ 守卫**必须非零退出并点名是哪条 channel / 哪条消息**；把该断言删掉 ⇒ 测试变红。
4. 启动前护栏行为逐字不变（`AGENT_BUS_URL` / `AGENT_BUS_TOKEN_FILE` 指向生产 ⇒ 拒绝启动）。
5. **回归**：`main` 上已有的一切行为逐字不变（跨 drain 循环与退避、GT-6 三分类、终态取真值、
   续投门、失败轮回显、进度行与板面构成、per-run 板、种子带 sources、head_seq 只从列表端点取、
   运行记录归档、`TRIAGE_THRESHOLD` 与 `MAX_CLUES` 可配且真接线、`node_timeout`/`wall_clock`=1810、
   「run 退出无 result ⇒ 记录并继续」、假 bus 端口由内核分配）。
6. **Z1（真机）**：`bash bin/e0-regression.sh` 在交付 profile 声明的预算内跑到非 null 终态、**退出 0**，
   `board:agent-runs`（测试总线）head_seq 严格增长，证据 channel head_seq > 0。
7. **Z3（真机）**：**连续两次**执行都退出 0、各自独立 run id 与独立研究板。

> ⚠️ 派发方已实测：E0c10 交付在真机上**连续两次都跑到 `capped`**（12 轮 / 10 轮，均在预算内，
> evidence 各 77 条）——唯一挡住 exit 0 的就是本包要修的这个守卫。
> 判据 6–7 由派发方在真机上验证（一跑约 40–50 分钟）。

## 3　⛔ 明确不做

web/content 接线（E2b）、ingest（E1）、anchor scheme（E3）、收工仲裁者（E5）、原子产物（E4）、
驱动脚本重写进 TS 入口（E7）、协议注册、工具白名单、生产 profile `agent-harness.env`。

## 4　运行环境前提（派发方已就位）

测试总线 `http://127.0.0.1:7495`（独立 SQLite，与生产 7490 零共享），协议齐全、三个 agent 已注册。
⛔ 实现者不得在代码里自动注册 protocol。
⚠️ 本机生产总线 `127.0.0.1:7490` **始终有其它开发线在写**——这正是 GT-P1 的前提，
⛔ 不得假设它安静。

## 5　评审口径

- **REJECT 只用于 blocker 级**：守卫被删/降级、判别性缺失或方向钉反、越出 §1 范围、
  改坏 §2.5 列出的既有行为。
- ⚠️ 本线累计因「测试绕开被测对象」被驳回十余次。**判据 2/3 的测试必须真正驱动入口**
  （真的跑 `bin/e0-regression.sh`，用可控的假生产总线制造两种情形），
  ⛔ 不得只读脚本文本、不得只断言纯函数。
- reviewer 只读，判据 1–5 由 acceptance 命令的执行结果作证。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`。
