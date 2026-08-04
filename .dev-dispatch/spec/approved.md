# S4 —— 生成阶段编排 + 单例 lock + 终态标记

> 上游依据：work folder `wf-dc0c15` 的 `spec.md`(rev7) §3.2 第 7 步、§3.6、§5.5、§6，
> `plan.md` §2「链 A · S4」。
> 前置包已合入 main：S1b（协议类型 + bus 客户端 + CAS 认领）、S2（`decideTick` / `runTick`）、
> S3（`decideTermination` / `computeCoverage` / `capHit` / 三值终态）。

## 1　本包要建什么

终止判定给出非空终态之后的**生成阶段编排**（`spec.md §3.2` 第 7 步）：

```
debater ×3（立论 / 反方 / 裁判，不同 route）
  → synthesizer（⛔ 单例 lock）
    → anchor-check（确定性节点，跑但不拦）
      → 导出（确定性节点）
```

沿用 S2/S3 已确立的结构：**编排决策必须是纯函数**，副作用只在执行壳里。

## 2　触发条件

生成阶段**当且仅当** `decideTermination` 返回**非空** `state` 时启动。

> ⛔ **`capHit === true` 但 `state === null`（已触顶、仍在排空）时不得启动生成阶段。**
> 这是 S3 attempt 1 被拒的那条限定词的下游后果：触顶不等于终止，排空期间研究仍在进行，
> 此时生成报告会把还没跑完的工作写成结论。

## 3　顺序与并发

| 阶段 | 并发 | 约束 |
|---|---|---|
| debater ×3 | 可并行 | **三个立场必须用不同 route**（`spec.md §6.2`：同一 role 的不同参数实例化） |
| synthesizer | ⛔ **任一时刻并发 = 1** | 挂 loop-engine 命名 `lock`（`spec.md §3.6`） |
| anchor-check | 1 | 排在 synthesizer **之后**、导出**之前** |
| 导出 | 1 | 最后 |

**严格串行的边**：`debater 全部完成 → synthesizer → anchor-check → 导出`。

> **为什么 synthesizer 必须单例**：2026-08-02 那次没撞车是**参数侥幸**——
> turn 间隔 600s，triage 实测 130s、synthesizer 360s，**只剩 240s 余量**。
> 证据量增大或间隔调密就会撞，后果是**两个进程并发写同一份稿件**。
> `lock` 把它从侥幸变成结构保证。

## 4　⛔ anchor-check：跑，但不阻断

`anchor-check` 报告落盘，**但不得阻断导出**（`spec.md §5.4`）。

- 它失败 / 报出缺陷 ⇒ **导出照常进行**
- 本期验收口径是「跑通即过」（`spec.md §7`），它产出的数据是
  **下一期决定要不要升级成闸门的唯一依据**

> **不造它等于把 revision 写进每一条 anchor 然后从不使用它**——
> 本项目已有 `anchor` 479 条 refs 零使用、`heartbeat_at` 零使用两个同形前例。
> **revision 的全部价值就是可以回取比对。**

## 5　终态标记写进报告头

`spec.md §5.5`：终态标记由**引擎**写进 `doc(report)` 的 body 头部，导出件原样带出。

### 5.1 ⛔ 标记必须携带两个正交事实，不得只写单个枚举值

| 事实 | 取值 |
|---|---|
| **为什么停** | `converged` / `capped` |
| **有没有未完成的工作** | `blocked` 计数（≥1 时终态为 `partial`） |

**理由**：终态在 S3 里是三值枚举 `converged / capped / partial`，但真实域是两维——
实测 `capHit ∧ blocked>0` 时终态取 `capped`，**读报告的人因此看不到「还有 N 条线索卡住」**。

单个枚举装不下两维。报告头必须同时呈现：**停止原因 + `blocked` 计数 + `capHit`**。

> **一份因触顶而停、且有 12 条线索卡住的报告，与一份正常收敛的报告，
> 在读者眼里必须长得完全不一样。** 旧设计里 `converged` 是个布尔，
> **触顶和收敛长得完全一样，读报告的人分不出来**——本包不得复现该形态。

### 5.2 报告头是机器可解析的

标记必须能被**确定性地**从 body 头部解析出来（固定前缀 / 结构化块均可），
不得只是散文描述——导出节点要原样带出它，`anchor-check` 与下游工具要能读。

## 6　参数

debater 三立场的具体 route **组合本包不定**（`plan.md §7` 记为未决），
但**必须由配置传入且三者互不相同**，不得硬编码。

## 7　硬验收（逐条可机械核验）

> **本表已逐条比对过正文的每个限定词。** 正文里出现而表中没有对应行的限定词，
> 视为本 spec 的缺陷——上一个包（S3）正是因为「条件 3 只拦新 clue」这条限定词
> 只在正文、没进验收表而被 final reviewer 拒了一次。

| # | 断言 | 怎么验 |
|---|---|---|
| **D1** | `state === null` 时**不启动**生成阶段 | 构造未终止板面 ⇒ 生成阶段相关 spawn 次数 === 0 |
| **D2** | ⛔ `capHit === true` 且 `state === null`（排空中）**不启动** | 独立用例，断言 spawn 次数 === 0 |
| **D3** | `state` 非空时启动 | 三种终态各一个用例，均启动 |
| **D4** | debater 恰好 3 个 | 断言 debater spawn 次数 === 3 |
| **D5** | ⛔ 三个 debater 的 route **互不相同** | 收集三次 spawn 的 route 参数，断言去重后 size === 3 |
| **D6** | ⛔ synthesizer 任一时刻并发 = 1 | 打桩令 synthesizer 异步挂起，断言在其未完成时**不会**发起第二次 synthesizer spawn |
| **D7** | ⛔ 严格串行边：debater 全完成才 synthesizer | 共享调用序列，断言 3 个 `debater` 的索引**全部小于** `synthesizer` 的索引 |
| **D8** | ⛔ 串行边：synthesizer → anchor-check → 导出 | 同一共享序列，断言三者索引严格递增 |
| **D9** | ⛔ anchor-check **失败不阻断导出** | 打桩令 anchor-check 抛错，断言导出**仍然发生** |
| **D10** | anchor-check 报出缺陷（非异常）同样不阻断 | 令其返回「有缺陷」结果，断言导出仍发生 |
| **D11** | 报告头含**停止原因** | 解析 body 头部，断言含 `converged`/`capped` 之一 |
| **D12** | ⛔ 报告头含 **`blocked` 计数** | `blocked=12` 的场景，断言头部可解析出 `12` |
| **D13** | ⛔ 报告头含 **`capHit`** | `capHit=true` 场景，断言头部可解析出该事实 |
| **D14** | 触顶+卡住 与 正常收敛 的报告头**可区分** | 两个场景各生成一次，断言两份头部**不相等** |
| **D15** | 报告头可确定性解析 | 提供并测试一个解析函数：给定 body ⇒ 返回结构化标记对象 |
| **D16** | route 组合不硬编码 | 传入自定义三 route ⇒ 实际用的就是它们 |
| **D17** | 编排决策为纯函数 | 其模块不 import `./bus`；`grep -nE "\bDate\b\|Math\.random\|fetch\("` 零命中 |
| **D18** | 全量测试与类型检查通过 | `npm run typecheck` 与 `npm test` 均 exit 0 |
| **D19** | 既有 61 条用例**一行未删** | `git diff` 中既有测试文件无 `it(` 净减少 |

## 8　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **Q1** 去掉 `state === null` 的启动闸门（改为 `capHit` 即启动） | **D1 与 D2** |
| **Q2** 三个 debater 用同一个 route | **D5** |
| **Q3** 去掉 synthesizer 的单例 lock | **D6** |
| **Q4** 把 synthesizer 提到 debater 之前 | **D7** |
| **Q5** ⛔ anchor-check 失败时 `return`（阻断导出） | **D9** |
| **Q6** 报告头只写终态枚举、去掉 `blocked` 计数 | **D12 与 D14** |

> **只报「N/N 挂了」不算数。** 本线曾第一次变异跑出 10/10 差点签字，
> 去看挂的是哪几条才发现**核心那条断言全程存活**——而它才是那个包存在的理由。
> **变异杀死的断言集合，必须与该变异所模拟的缺陷对得上。**
> **破坏后必须回显被改的那一行**，不能只信脚本说改了。

### 8.1 ⚠️ 打桩纪律（本线连栽两次的指纹，S2/S3 已成功规避）

> **打桩让两次读返回相同的值** ⇒「读了一次」与「读了两次」产出完全相同的结果，
> 断言无法区分。**测的是 stub 的确定性，不是被测代码的行为。**

本包的对应风险在 **D6 / D7 / D8**：
若只分别断言「debater 被调用过」「synthesizer 被调用过」，**对调换顺序完全无感**。

⇒ **必须用一条共享的调用序列记录各阶段的发生次序，断言其相对索引**
（S2 的 B4 已用此法并被 N1 变异证明有效，可直接沿用其形状）。

D6 的并发断言同理：**必须让 synthesizer 的桩真的异步挂起**（返回一个未 resolve 的 Promise），
在挂起期间驱动第二次编排，断言不会发起第二次 spawn。
**若桩是同步立即返回的，「并发=1」与「无 lock」产出完全相同的观测值。**

## 9　非目标

- 不实现 debater / synthesizer 的 **role 定义与 prompt**（属链 C 的 R2）
- 不实现 ingest 节点（N1）与导出节点的**内部实现**（N3）——
  本包只负责**编排调用**，把它们当作可打桩的依赖
- 不实现 `anchor-check` 本体（链 B 的 N2 已交付于 katana 仓）
- 不做裁决/投票机制（`spec.md §8` 显式不做）
- **不改 `src/protocol.ts`**（协议已在 agent-bus 上不可逆注册）
- 不改 S1b/S2/S3 已交付部分的既有导出签名；确需新增能力则**新增**，不改既有的

## 10　环境

- `setup_commands` 必须含 `npm ci`
- ⛔ **agent-bus append-only、无 DELETE 路由，写入不可回退。**
  **本包不得对真实 bus 发起写入**——全部用打桩单测。
- `src/tick.ts` 现有导出：`decideTick` / `runTick` / `decideTermination` /
  `computeCoverage` / `TERMINAL_STATES` / `TickConfig` / `DEFAULT_TICK_CONFIG` 等，
  可直接复用，**不要重新实现**。
