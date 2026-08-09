# G4b(v2) —— 终态贯通：生产 `--run` 从不计算终止判定，「正常收敛」当前**不可达**

> 派发方：`line-deep-research`（deep-research V2 收尾线）。**这是已核实的生产缺陷，不是加功能。**
> 前置已合入 main `70898c4`（G4a(v2) `--question` 贯通已完成）。
>
> ⚠️ **这是重开包。** 上一个 development（`dev_ledr_g4b_termination_wiring_01`，PR #35）被派发方取消，
> 原因**与 spec 和实现都无关**：implementer 首选档持续 60s 首包超时（100 分钟内 55 次，约 5.4 分钟/step，
> 只推进到 step=71 远未收敛）。attempt-context v1 的 `reconfigure` 与 `steer` 在 IMPLEMENTING 均 409（已实测），
> 无法在飞换档，故取消重开并把 implementer 钉到实测健康的备用档。**spec 内容与上一轮逐字相同。**

---

## 0　两条已核实的事实（grep 到行号，非推断）

### 0.1 生产 `--run` 路径**从不调用** `decideTermination`

```
grep -n "termination" src/tick-run.ts   →   零命中
```

`decideTermination`（`src/tick.ts:359`）的调用者只有两处，**都不是生产写路径**：
- `src/tick-entry.ts:73` —— `--selfcheck`（空板面自检）
- `src/tick-inspect.ts:112` —— `--inspect`（只读观察）

⇒ **生产每个 tick 只做「决策 → 执行 → 报 `hasPendingWork`」，从不判断研究是否结束。**

### 0.2 ⛔ 更硬的一条：`zeroGrowthRounds` **没有任何跨 tick 持久化**，导致「正常收敛」永不可达

三个调用点**全部硬编码 `prevCoverage: 0, prevZeroGrowthRounds: 0`**
（`tick-entry.ts:74-75`、`tick-inspect.ts:113-114`）。

代入 `tick.ts:362-363`：

```ts
const zeroGrowthRounds = coverage > input.prevCoverage ? 0 : input.prevZeroGrowthRounds + 1;
//                                    ^^^ 恒为 0                        ^^^ 恒为 0
```

⇒ `zeroGrowthRounds` **恒为 0 或 1**，而阈值 `zeroGrowthThreshold = 2`（`tick.ts:88`）
⇒ **条件 1（正常收敛）永远不成立**，唯一可达终态是 `capped`（触顶）。

> ⛔ 这正是 `spec` §3.4 明令要区分的两件事：**因触顶而停 ≠ 收敛**。
> 现状下**每一次研究的终态都只能是触顶**，报告的完备性主张随之失真。
> G2b 修掉了「proposed 永不被裁走」那一半；**这一半（计数器无记忆）还在。**

---

## 1　要做什么

### 1.1 生产 `--run` 必须计算并返回终止判定

`runChannelWrite` 在执行完本轮决策后，**用本轮真实板面**调用 `decideTermination`，
并把 `TerminationState` 放进 `--run` 的 JSON 输出（与既有 `hasPendingWork` 并列）。

⛔ **不得新造一套判定逻辑**：`decideTermination` / `computeCoverage` 是已交付的纯函数，**调用它们**。

### 1.2 ⛔ `prevCoverage` / `prevZeroGrowthRounds` 必须跨 tick 传递

**走已经铺好的 trigger body 通道，不要新造存储：**

| 位置 | 现状 |
|---|---|
| `workflows/deep-research/fleet.yaml.tpl:27-28` | `claim.bind` 已把 `trigger_id: id` / **`trigger_body: body`** 绑进 pipeline input |
| `tick.md:46` | 续投时写死 `"body":{"tick":true}` —— **body 是可用载体，但当前只放了一个常量** |
| `tick.md` | **从不读 `{{trigger_body}}`** —— 载体已通，两端都没接 |

⇒ 续投时把本轮的 `{coverage, zeroGrowthRounds}` 写进下一条 trigger 的 body；
下一轮 tick 读回来，作为 `prevCoverage` / `prevZeroGrowthRounds` 传给 `decideTermination`。

⛔ **首轮无前值** ⇒ 用 `0 / 0`（与现状一致，且首轮本来就不该收敛）。
⛔ **body 解析失败 / 字段缺失** ⇒ **响亮失败**，不得静默回落到 `0 / 0`
（静默回落 = 计数器被无声重置 = 本缺陷原样复发，而且更难查）。

### 1.3 显式不做：不要在这里触发生成段

`decideGenerate` 的接线归 **G4c**。本包只让**终态本身可算、可达、可观察**。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **R1** | ⛔ **可达性**：存在一条从**生产入口**（`tick-entry --run`）出发的用例，其 JSON 输出里含 `termination`；⛔ 只验 `--selfcheck`/`--inspect` **不算数**（那两条本来就有） | 读用例到行号 |
| **R2** | ⭐ **「正常收敛」可达**：构造连续多轮零增长，断言 `zeroGrowthRounds` **能长到 ≥ 2** 且 `state === "converged"`。⛔ 这条在改动前**必然挂**——它是本包的存在理由 | 多轮驱动用例 |
| **R3** | ⛔ **判别性**：同样多轮但**覆盖度有增长** ⇒ `zeroGrowthRounds` 被重置、**不得**收敛 | 反例（一个永远收敛的检查等于没有检查） |
| **R4** | **跨 tick 传递真的经过 trigger body**：断言续投写出的 trigger body 里含本轮的 `coverage` / `zeroGrowthRounds`，且下一轮从 `{{trigger_body}}` 读回 | 两端各一条；⛔ 只断言「函数收了参数」不算数 |
| **R5** | ⛔ **body 缺失/损坏 ⇒ 响亮失败**，不得静默回落 `0/0` | 正反两例 |
| **R6** | `capped` 与 `converged` **仍然可区分**：触顶路径产出 `capped`，零增长路径产出 `converged` | 各一条 |
| **R7** | 全量 `npx vitest run` 全绿，文件数/用例数不少于**基线（以 G4a 合入后的 main 实测为准，请自己先跑一次记下来）** | 贴基线与终值两次输出 |
| **R8** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **R9** | `src/`、`test/`、`workflows/` 的每一处删除给出必要性说明 | — |

---

## 3　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **S1** | 把跨 tick 传递去掉，`prevZeroGrowthRounds` 恒传 `0`（= 回到改动前） | **R2 必须挂**；⛔ 杀不掉即判 R2 零功率、必须重写 |
| **S2** | 让 body 缺失时静默回落 `0/0`（去掉响亮失败） | **R5 的失败侧必须挂** |
| **S3** | 让 `coverage` 增长时**不**重置 `zeroGrowthRounds`（照单 +1） | **R3 必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 4　显式不做

| 不做 | 理由 |
|---|---|
| 触发生成段（`decideGenerate` → `runGenerate`） | 归 **G4c** |
| 接导出 / anchor-check | 归 **G4d** |
| 播种入口 | 归 **G4e** |
| 改 `profiles/deploy/*.env` 的 channel 取值 | 归 **D2** |
| 改 `decideTermination` / `computeCoverage` 的判定语义 | 它们是已交付的纯函数，本包只**接线与持久化**，不改判定 |
| 注册任何 bus 协议 | 不可逆，走公示流程 |
| 改 `agent-runtime` | 不同仓 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 5　交付物落点

- 实现：`src/tick-run.ts`（`--run` 计算终态 + 读写跨 tick 计数）、
  `workflows/deep-research/tick/templates/tick.md`（读 `{{trigger_body}}` + 续投写计数）、
  必要时 `workflows/deep-research/fleet.yaml.tpl`
- 测试：`test/g4b-termination-wiring.test.ts`（R1–R6）
- 证据：`docs/dev-notes/dev_ledr_g4b_termination_wiring_01.md`（R1–R9 逐条 + §3 变异三行 + 还原证据）

> ⚠️ **dev-note 的 `input_commit` 必须等于最终交付 commit**；中途 rework 则 note 必须同步更新。
> 派发方在 D1 上实测到「note 停在 attempt 1、数字与交付物对不上」，gate 会核对这一项。
