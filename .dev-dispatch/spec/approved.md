# S2 —— 调度 tick：回收 → 派 worker → 派 triage

> 上游依据：work folder `wf-dc0c15` 的 `spec.md`(rev7) §3.1–§3.6，`plan.md` §2「链 A · S2」。
> 前置包 S1b 已合入 main（`72562f6`）：`src/protocol.ts`（三协议类型 + 状态机）、
> `src/bus.ts`（bus 客户端 + CAS 认领原语）可直接使用。

## 1　本包要建什么

deep-research 调度器的**一个 tick**。调度器是 loop-engine plugin，**零 LLM**——
它的输入全是整数与枚举，输出只有几种动作。

本包实现 `spec.md §3.2` 的**第 1–4 步**：增量读板 → 回收在途 → 派 worker → 派 triage。
第 5–6 步（覆盖度与终止判定）属 S3，**本包不做**。

### 1.1 强制的结构切分：纯决策函数 + 薄执行壳

```
decideTick(state: BoardState, cfg: TickConfig): Decision[]     // 纯函数，无 IO
runTick(deps): Promise<void>                                    // 读板 → decideTick → 执行副作用
```

**`decideTick` 必须是纯函数**：同样的入参永远给同样的出参，不碰网络/时钟/随机。
这不是风格偏好——它是「可重放、可单测」这条 DoD 的唯一实现方式，
也是让状态机的每条分支都能被**廉价地**构造出来的前提。

副作用（CAS、spawn）只允许发生在 `runTick` 里，且必须严格按 `decideTick` 返回的顺序执行。

## 2　⛔ 本包唯一的硬不变量：先 CAS，后 spawn

> **必须先在 bus 上把卡从 `open` CAS 到 `in_flight`，成功之后才 `spawn` job。**
> **顺序反了会产生孤儿 job。**

三条补偿规则（`spec.md §3.2` 第 3 步）：

| 情形 | 处置 |
|---|---|
| CAS 失败（409 = 别人抢先） | **跳过该卡，不得 spawn** |
| CAS 成功但 spawn 同步失败 | **当场 CAS 回 `open`** |
| 引擎在两步之间崩溃 | 由回收步兜底（见 §3），本包不额外处理 |

**背景**：本项目发生过真实事故——两条线各自认为持有同一个槽、**无人拿到 409**。
认领原语的正确性是整条流程的地基。S1b 已把 `claimClue` 的「同源读」守住
（`test/cas.test.ts` 的 A6，变异 M4 可杀），**本包要守的是它的调用顺序**。

## 3　回收：遍历 `status=in_flight` 的卡

依据 `board:agent-runs` 上的 `agent.run.*` 事件（`spec.md §3.2` 第 2 步）：

| 观察到 | 动作 |
|---|---|
| 无对应 `agent.run.started` | CAS 回 `open`（崩溃恢复） |
| `exited` 且 `exit_code === 0` | CAS 到 `explored` |
| `exited` 且 `exit_code !== 0`，重试 < 2 | CAS 回 `open`，重试 +1 |
| `exited` 且 `exit_code !== 0`，重试 = 2 | CAS 到 `blocked` |

> ⛔ **不得引入 lease / 超时猜测机制。** `spec.md §3.3` 已明确删除租约：
> 「worker 死没死」由 `agent.run.exited` 从**猜**变成**被观察到的事实**。
> **少一个靠阈值猜的机制，比多一个测过的机制强。**
> 若你发现需要「超过 N 分钟没动静就认为死了」，那是设计回退，不是补强。

## 4　派 worker

```
n = min(maxConcurrentWorkers - 在途数, open 数)
```

逐条 `open → in_flight`，按 §2 的顺序与补偿规则。

**`sources` 校验**：`sources` 是**封闭枚举**的子集，取值只能来自
`code-local` / `code-remote` / `wiki` / `feishu` / `web-search`。
**出现枚举外的取值 ⇒ 该卡 CAS 到 `blocked`，研究继续，不整体停机**（`spec.md §3.5`）。

> ⛔ **不加 LLM 兜底。** 确定性调度的真风险是「超出状态机时不会想办法」，
> 正确缓解是让它**响亮失败**，不是给它加智能。调度器查表，不理解。

## 5　派 triage

`count(proposed) ≥ K` 且 triage 无在途 → spawn 一个 triage。

`K = 3`（08-02 实跑值）。「无在途」由 loop-engine 的命名 `lock` 保证；
本包只需在决策层表达该条件，**lock 的接线属 S4**。

## 6　参数（全部来自 `spec.md §3.4`，不得自行取值）

| 参数 | 取值 |
|---|---|
| `K`（triage 触发阈值） | 3 |
| `maxConcurrentWorkers` | 4 |
| `maxDepth` | 3 |
| 重试上限 | 2 |

参数以 `TickConfig` 传入并给出上述缺省值，**不得硬编码在逻辑里**。

## 7　硬验收（逐条可机械核验）

| # | 断言 | 怎么验 |
|---|---|---|
| **B1** | `decideTick` 是纯函数 | 其模块不 import `./bus`，且函数体内无 `fetch` / `Date` / `Math.random`（grep 零命中） |
| **B2** | 同一入参重复调用结果深相等 | 同一 `state` 调 3 次，`expect(r1).toEqual(r2)` 且 `toEqual(r3)` |
| **B3** | ⛔ CAS 失败时**不得发生 spawn** | 打桩令 CAS 返回 `conflict`，断言 spawn 的调用次数 **=== 0** |
| **B4** | ⛔ spawn 与 CAS 的**实际发生顺序** | 记录一条共享调用序列，断言该卡的 `cas` 索引 **<** 其 `spawn` 索引 |
| **B5** | spawn 同步失败 → 当场 CAS 回 `open` | 打桩令 spawn 抛错，断言随后发生一次把该卡写回 `open` 的 CAS |
| **B6** | 回收四分支各有独立用例 | 无 started / exit 0 / exit≠0 重试<2 / exit≠0 重试=2 |
| **B7** | 并发上限生效 | 在途 3、open 5、`maxConcurrentWorkers=4` ⇒ 只派 1 |
| **B8** | `sources` 含枚举外取值 ⇒ 该卡 `blocked` 且**其余卡照常派发** | 一张坏卡 + 两张好卡，断言 1 blocked + 2 dispatched |
| **B9** | triage 阈值 | proposed=2 不派；proposed=3 且无在途 → 派；proposed=3 但有在途 → 不派 |
| **B10** | 不存在 lease / 超时机制 | `grep -riE "lease\|timeout.*(stale\|dead)\|超时.*僵死" src/` 零命中 |
| **B11** | 参数不得硬编码 | 传入 `TickConfig{K:1}` 时 proposed=1 即触发 triage |
| **B12** | 全量测试与类型检查通过 | `npm run typecheck` 与 `npm test` 均 exit 0 |
| **B13** | S1b 既有 26 条用例**一行未删** | `git diff -- test/protocol.test.ts test/bus.test.ts test/cas.test.ts` 中无 `it(` 净减少 |

## 8　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **N1** 把「先 CAS 后 spawn」改成「先 spawn 后 CAS」 | **B4** |
| **N2** CAS 返回 conflict 时不跳过、照常 spawn | **B3** |
| **N3** 删掉 spawn 失败后的回滚 CAS | **B5** |
| **N4** 并发上限改成不减在途数（`n = open 数`） | **B7** |
| **N5** `sources` 枚举校验改为放行 | **B8** |
| **N6** triage 阈值判定改成 `> K` | **B9** |

> **只报「N/N 挂了」不算数。** 本线曾第一次变异跑出 10/10 差点签字，
> 去看挂的是哪几条才发现**核心那条断言全程存活**——而它才是那个包存在的理由。
> **变异杀死的断言集合，必须与该变异所模拟的缺陷对得上。**
>
> **破坏后必须回显被改的那一行**，不能只信脚本说改了——曾有正则命中注释行而非真代码，
> 脚本打印 `patched: True`、测试全绿。

### 8.1 ⚠️ 关于打桩：本包最容易踩的坑

前一个包（S1b）连续两次交付出**零功率的守卫**，两次都是同一个指纹：

> **打桩让两次读返回了相同的值，于是「读了一次」与「读了两次」产出完全相同的结果，
> 断言无法区分。** 测的是 stub 的确定性，不是被测代码的行为。

⇒ 写 B3 / B4 时，**必须让「顺序错了」这件事在你的桩上产生可观测的差异**：
用一条**共享的调用序列**记录 `cas` 与 `spawn` 的发生次序并断言其相对位置，
而不是分别断言「cas 被调用过」和「spawn 被调用过」——后者对调换顺序完全无感。

**自检方法：把 N1 变异真打进去跑一遍，确认 B4 挂掉。** 若不挂，你的桩就是无效的。

## 9　顺带清理

**删除仓根的 `IMPLEMENTATION_SUMMARY.md`。**

它是 S1b 的一次性交付证据（冒烟输出），已随该包合入并完成使命。留着它的代价是实测过的：
本项目另一个仓的同名文件**横跨 8+ 个 development、被 18 处评审提及、一次也没被修**——
因为每个 reviewer 都**正确地**判定它不在自己包的 scope 内。

> **局部各自正确，全局持续失败。** reviewer 反复标记同一个「note, not blocker」时，
> 那不是噪音，是无归属的公共债；这类债只能由专包清，而现在清最便宜。

若本包仍需留下运行证据，写进 commit message **与** 一个随包新增的文件二者皆可，
但**不要复用 `IMPLEMENTATION_SUMMARY.md` 这个名字**。

## 10　非目标

- 不做覆盖度计算与终止判定（S3）
- 不做生成阶段编排、不接 loop-engine `lock`（S4）
- 不实现 ingest / 导出节点（N1 / N3）
- 不写 role 定义（链 C）
- **不改 `src/protocol.ts`**（协议已在 agent-bus 上不可逆注册）
- 不改 `src/bus.ts` 的既有导出签名；确需新增能力则**新增函数**，不改既有的

## 11　环境

- `setup_commands` 必须含 `npm ci`
- `tsconfig.json` 的 `include` 已含 `test/`
- agent-bus：`http://127.0.0.1:7490`，Bearer 认证，token 在 `/data/agent-bus/tokens/`
- ⛔ **agent-bus 是 append-only、无 DELETE 路由，任何写入不可回退。**
  **本包不需要、也不得对真实 bus 发起写入**——全部用打桩单测。
- `GET /v1/channels/<id>/messages` 默认 `limit=100` 且返回**最早**100 条；
  增量读必须带 `after_seq`（`getMessages` 已支持，`afterSeq=0` 亦被正确携带）
