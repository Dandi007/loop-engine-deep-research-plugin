# S3 —— 覆盖度计算 + 三条终止条件 + 终态区分

> 上游依据：work folder `wf-dc0c15` 的 `spec.md`(rev7) §3.2 第 5–6 步、§3.4，
> `plan.md` §2「链 A · S3」。
> 前置包已合入 main：S1b（`src/protocol.ts` 三协议类型 + 状态机、`src/bus.ts` bus 客户端与
> CAS 认领原语）、S2（`src/tick.ts` 的 `decideTick` 纯决策函数 + `runTick` 执行壳）。

## 1　本包要建什么

调度器 tick 的**后半段**：算覆盖 → 判终止 → **给出可区分的终态**。
实现 `spec.md §3.2` 的第 5–6 步与 `§3.4` 全部内容。

沿用 S2 确立的结构：**新增的判定逻辑必须是纯函数**，与 `decideTick` 同模块或同风格，
副作用只允许出现在执行壳里。

## 2　覆盖度

```
coverage = |{ clue_id : 存在至少一条 evidence 的 clue_id 等于它 }|
```

> ⛔ **它是【集合大小】，不是 evidence 条数。**
> 同一条 clue 下挂 5 条 evidence，coverage 只算 **1**。

与上一 tick 的 coverage 比较：
- 未增长 → `zeroGrowthRounds += 1`
- 增长 → `zeroGrowthRounds` **归零**

## 3　三条终止条件（`spec.md §3.4`，任一满足即停）

| # | 条件 | 终态 |
|---|---|---|
| 1 | `zeroGrowthRounds >= 2` **且** 在途 = 0 **且** proposed = 0 | **正常收敛** |
| 2 | `count(clue) >= maxClues` | **触顶终止** |
| 3 | `max(depth) >= maxDepth` | **触顶终止** |

条件 3 **只拦新 clue，已 open 的跑完**。

### 3.1 ⛔ 硬约束①：终态必须可区分，不得是布尔

因触顶而停 **≠** 收敛。报告若是撞上限停下来的，**它的完备性主张就不成立**，
必须在产物里带这个标记。

> 旧设计里 `converged` 是个布尔——**触顶和收敛长得完全一样，读报告的人分不出来。**

终态至少是三值：`converged` / `capped` / `partial`（命名可自定，但**必须三者互斥且可判别**）。

### 3.2 ⛔ 硬约束②：`blocked > 0` 时终态一律不得为「正常收敛」

只能是「部分完成」。

**这是整套设计里最阴险的失效模式**，且是「局部降级」这个选择直接引入的：

```
clue 一条条卡住 → 没有新 evidence → 覆盖不增长 → 连续 2 轮零增长
→ 判定「正常收敛」→ 报告宣称证据充分
```

⇒ **研究因全面卡死而停止，产出的却是一份自称完备的报告。**

## 4　终止性（必须可证）

每个 tick 必须使下列三者**之一严格单增且有上界**：

- `explored + dropped + blocked` 的卡数（上界 `maxClues`）
- `zeroGrowthRounds`（上界 2）
- `ticks`（上界由 loop-engine `maxTicks` 兜）

> **为什么必须有条件 2/3**：worker 是 LLM，它几乎总能产出**一条**新 evidence，哪怕无关。
> 只要每轮都有一条边缘 evidence 挂上一个新 clue，「零新增覆盖」就永远不成立，循环不终止。
> loop-engine 的 `maxTicks` / wallclock 会兜住它，**但那是失控保护，
> 触发时你得到的是一次超时，不是一份研究。**

## 5　参数（全部来自 `spec.md §3.4`，不得自行取值）

| 参数 | 取值 |
|---|---|
| `maxClues` | 64（对齐 loop-engine `max_fanout`） |
| `maxDepth` | 3 |
| `zeroGrowthRounds` 阈值 | 2 |

> 阈值取 2 的依据：N=1 太敏感（一轮几个 worker 恰好探同一面即误停）；
> N=3 在 11-turn 规模下近 1/3 轮次空转。

参数经 `TickConfig` 传入并给出上述缺省值，**不得硬编码在逻辑里**。

## 6　硬验收（逐条可机械核验）

| # | 断言 | 怎么验 |
|---|---|---|
| **C1** | coverage 是集合大小 | 同一 `clue_id` 下 5 条 evidence ⇒ coverage **=== 1** |
| **C2** | coverage 跨 clue 累计 | 3 条 clue 各挂 1 条 evidence ⇒ coverage === 3 |
| **C3** | 增长时 `zeroGrowthRounds` 归零 | 先累到 1，再让 coverage 增长 ⇒ 归 **0** |
| **C4** | 条件 1 判正常收敛 | zeroGrowth=2 且 在途=0 且 proposed=0 且 **blocked=0** ⇒ `converged` |
| **C5** | 条件 1 的三个子条件**各自**必要 | 三个独立用例：在途>0 / proposed>0 / zeroGrowth<2，各自都**不得**终止 |
| **C6** | 条件 2 判触顶 | `count(clue) >= maxClues` ⇒ `capped`（**不是** `converged`） |
| **C7** | 条件 3 判触顶 | `max(depth) >= maxDepth` ⇒ `capped` |
| **C8** | ⛔ **全部 clue 都 blocked ⇒ 终态不得为正常收敛** | 构造该场景，断言终态 **!== `converged`** 且 === `partial` |
| **C9** | ⛔ `blocked > 0` 且其余满足条件 1 ⇒ `partial` | 仅 1 张 blocked，其余全 explored、在途 0、proposed 0、zeroGrowth=2 ⇒ **`partial`** |
| **C10** | 终态三值互斥 | 断言返回值属于封闭枚举，且三种场景各得其一 |
| **C11** | 终止性度量单增 | 连续两 tick，断言三度量之一严格增大 |
| **C12** | 参数不硬编码 | 传 `TickConfig{maxClues:2}` ⇒ 2 张 clue 即 `capped` |
| **C13** | 判定逻辑为纯函数 | 其模块不 import `./bus`；函数体内 **`grep -nE "\bDate\b\|Math\.random\|fetch\("` 零命中** |
| **C14** | 全量测试与类型检查通过 | `npm run typecheck` 与 `npm test` 均 exit 0 |
| **C15** | 既有 42 条用例**一行未删** | `git diff` 中三个既有测试文件无 `it(` 净减少 |

## 7　顺带修：把 S2 的 B1 纯度守卫收紧

`test/tick.test.ts` 现有的 B1 守卫正则只匹配 `/new\s+Date/`，
**`Date.now()` 写法能绕过它**（S2 的 final reviewer 提出，本 gate 采纳）。

产品代码当时对三者均干净，所以那是**守卫强度不足，不是缺陷**。本包顺手改正：
把该正则收紧为 **`/\bDate\b/`**，使 `Date.now()` 与 `new Date()` 都被拦下。

**改完必须验证它真的会拦**：临时往被检查的源文件里加一行 `Date.now()`，
确认该断言挂掉，再撤掉。**一个永远绿的检查等于没有检查。**

## 8　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **P1** coverage 改成数 evidence 条数（`.length`）而非去重集合大小 | **C1** |
| **P2** coverage 增长时不归零 `zeroGrowthRounds` | **C3** |
| **P3** 条件 1 去掉「在途 = 0」子条件 | **C5** 中对应那条 |
| **P4** 条件 2 的终态由 `capped` 改成 `converged` | **C6** |
| **P5** ⛔ 去掉 `blocked > 0` 对终态的降级 | **C8 与 C9** |
| **P6** 把 B1 纯度守卫的正则改回 `/new\s+Date/` | **§7 的自验用例** |

> **只报「N/N 挂了」不算数。** 本线曾第一次变异跑出 10/10 差点签字，
> 去看挂的是哪几条才发现**核心那条断言全程存活**——而它才是那个包存在的理由。
> **变异杀死的断言集合，必须与该变异所模拟的缺陷对得上。**
>
> **破坏后必须回显被改的那一行**，不能只信脚本说改了。
>
> **P5 是本包的核心判据**——它模拟的正是 §3.2 那条「因全面卡死而停止、
> 却产出一份自称完备的报告」的失效模式。若 P5 杀不到 C8/C9，本包等于没做。

### 8.1 ⚠️ 打桩纪律（本线连栽两次的指纹）

前面的包连续两次交付出**零功率的守卫**，两次同一个指纹：

> **打桩让两次读返回了相同的值** ⇒「读了一次」与「读了两次」产出完全相同的结果，
> 断言无法区分。**测的是 stub 的确定性，不是被测代码的行为。**

本包的对应风险在 **C3 / C11**：若两个 tick 的输入状态构造得完全一样，
「归零了」与「没归零」、「单增了」与「没单增」都可能产出相同的观测值。

⇒ **构造跨 tick 的用例时，必须让前后两个状态在被断言的那一维上真的不同，
并断言其【差值/次序】，而不是分别断言两次各自的绝对值。**

## 9　非目标

- 不做生成阶段编排（debater / synthesizer / anchor-check / 导出）——属 S4
- 不接 loop-engine `lock`——属 S4
- 不实现 ingest / 导出节点（N1 / N3）
- 不写 role 定义（链 C）
- **不改 `src/protocol.ts`**（协议已在 agent-bus 上不可逆注册）
- 不改 `src/bus.ts` 与 `src/tick.ts` 中 S2 已交付部分的既有导出签名；
  确需新增能力则**新增函数/字段**，不改既有的

## 10　环境

- `setup_commands` 必须含 `npm ci`
- ⛔ **agent-bus 是 append-only、无 DELETE 路由，写入不可回退。**
  **本包不需要、也不得对真实 bus 发起写入**——全部用打桩单测。
- `GET /v1/channels/<id>/messages` 默认 `limit=100` 且返回**最早** 100 条；
  增量读必须带 `after_seq`
