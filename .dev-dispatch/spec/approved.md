# A8a —— tick 接真实 agent-bus（**只读侧**，零写入）

> 上游依据：`spec.md`(rev7) §3.2 第 1、5、6 步，§2.2；`golden-order.md`（bus 为 SSoT）。
> 前置已合入 main（`e9dc2f6`，141/141 绿）：链 A 七包，含 A7 的 `src/tick-entry.ts`
> （当前只有 `--help` / `--selfcheck` 两个无副作用模式）。

---

## 0　本包为什么存在

A7 把 plugin 接线做完了，但 tick 节点硬接的是 `--selfcheck`——**在空板面上跑纯决策**。

⇒ **`decideTick` / `decideTermination` 至今从未见过真实 bus 数据。**

P0.2 只验过「历史消息合不合 v2 schema」，**没验过「真实 payload 能否驱动决策函数」**。
这两件事不同：schema 通过只说明字段齐全，不说明 `status` / `depth` / `sources`
的实际取值组合能被状态机正确消费。

> **判据：一个纯函数在真实数据上从未跑过，它的正确性只在作者构造的样例范围内成立。**

**本包只做读侧**：读真实 channel → 解析 → 跑决策 → **打印**。
**⛔ 不 CAS、不 spawn、不发布、零写入。** 写侧属 A8b（依赖链 C 的 role 存在）。

---

## 1　交付

给 `src/tick-entry.ts` 增加**一个只读模式**：

```
--inspect <channel_id>
```

行为：
1. 用**已交付的** `src/bus.ts` 的 `getMessages` **分页**读该 channel（`after_seq` 翻到取空）
2. 把 `research.clue.v2` 消息按 **entity 版本链取 head**（同 `entity_id` 取 `channel_seq` 最大的一条）
3. 把 `research.evidence.v2` 的 `clue_id` 收集为覆盖集合
4. 组装成 `BoardState` 与 `TerminationInput`，调**已交付的** `decideTick` / `decideTermination`
5. 以 JSON 打印：卡数按 status 分布、决策列表、coverage、终态、`capHit`
6. **exit 0**（无论终态如何——本模式是观察，不是判决）

⛔ **不得重新实现任何决策逻辑**：`decideTick` / `decideTermination` / `computeCoverage`
一律从 `./tick` import。

---

## 2　⛔ 零写入（本包最硬的约束）

⛔ **本模式不得对 agent-bus 发起任何非 GET 请求。**

> agent-bus 是 **append-only、无 DELETE 路由**，任何写入不可回退。
> 本线曾为确认体量上限写进 4 条共 5.3MB 垃圾，**至今清不掉**。

⛔ 同样不得触碰真实 MinerU、不得写 vault。

---

## 3　真实语料（实测，勿按想象假设）

| channel | 条数 | kind 分布 |
|---|---|---|
| `research:p02-smoke-1dce60` | **5** | `clue.v2`×3 / `evidence.v2`×1 / `doc.v2`×1 |
| `research:loop-mcp-semantics.index` | 86 | **全是 v1**（`clue.v1`×55 / `finding.v1`×27 / `verdict.v1`×4） |
| `research:smoke-bus-semantics.index` | 29 | **全是 v1** |

⇒ **唯一的 v2 语料是 `research:p02-smoke-1dce60` 的 5 条**，且其中 3 条 clue 属**同一条版本链**
（1 次创建 + 1 次 CAS 修订 + P0.2 遗留），**必须按 head 取，不能当成 3 张卡**。

⛔ **v1 channel 是冻结只读的**（`spec.md §8`）。
遇到 `research.*.v1` 消息**必须显式跳过并计数**，**不得**当成 v2 解析、也**不得**静默丢弃——
静默丢弃会让「板上有 55 张卡」被读成「板上 0 张卡」。

---

## 4　硬验收（逐条可机械核验）

> **本表已逐条比对 spec 全文的每个 ⛔ 与限定词，含 §0 / §2 / §3 / §6 / §7。**
> 前面的包**三次**因「限定词只在正文、没进验收表」被拒。

| # | 断言 | 怎么验 |
|---|---|---|
| **H1** | ⛔ 版本链按 **head** 取 | 纯数据入参：同一 `entity_id` 的 3 条消息（seq 1/2/3，status 依次 open/in_flight/explored）⇒ 组装出的板面**只有 1 张卡且 status=explored** |
| **H2** | ⛔ `research.*.v1` 消息被**显式跳过并计数** | 喂入混合数组（v1×2 + v2×1）⇒ 返回结构含 `skipped_v1 === 2`，且板面只含那 1 张 v2 卡 |
| **H3** | ⛔ 分页读到取空 | 打桩令三次返回 100/20/0 条 ⇒ 发起 **3** 次读取，第 2/3 次 URL 含 `after_seq=` |
| **H4** | coverage 取自 `evidence.clue_id` 的**集合大小** | 同一 `clue_id` 的 2 条 evidence ⇒ coverage === 1 |
| **H5** | ⛔ **不重新实现决策逻辑** | `grep` 确认 `tick-entry.ts` 从 `./tick` import `decideTick`/`decideTermination`；全仓 `decideTick` 的函数**定义**数 === 1 |
| **H6** | ⛔ **零写入**：`--inspect` 全程只发 GET | 打桩 fetch 记录所有请求，断言 **每一个 `method` 都是 GET（或未指定）**，且**至少发生过一次请求**（安全性+活性配对） |
| **H7** | ⛔ 不触碰 MinerU / vault | `--inspect` 代码路径不 import `./mineru`、不 import `./export`；grep 零命中 |
| **H8** | 真实语料实跑 | 对 `research:p02-smoke-1dce60` 真跑一次 `--inspect`，**exit 0**，输出贴进 `docs/dev-notes/<development_id>.md` |
| **H9** | ⛔ H8 那次真跑**零写入** | 跑前/跑后该 channel 消息数**不变**（把两个计数一并贴进 dev-notes） |
| **H10** | 终态为任何值都 exit 0 | 构造 converged / capped / null 三种 ⇒ 均 exit 0 |
| **H11** | ⛔ 不得触碰 `.dd-evidence/` | `git diff --name-only <base>..HEAD -- .dd-evidence/` **为空** |
| **H12** | 证据写 `docs/dev-notes/<development_id>.md` | 该文件存在；仓根**无** `IMPLEMENTATION_SUMMARY.md` |
| **H13** | typecheck + 全量测试 | 均 exit 0 |
| **H14** | 既有 141 条用例**一行未删** | `git diff` 中既有测试文件无 `it(` 净减少 |

---

## 5　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **V1m** 版本链取**首条**而非 head | **H1** |
| **V2m** v1 消息**静默丢弃**（不计数） | **H2** |
| **V3m** 去掉分页（只读第一页） | **H3** |
| **V4m** coverage 数 evidence **条数**而非集合大小 | **H4** |
| **V5m** `--inspect` 里插一次 `POST` | **H6** |
| **V6m** 终态为 capped 时 `exit 1` | **H10** |

> **只报「N/N 挂了」不算数。** 本线曾第一次变异跑出 10/10 差点签字，
> 去看挂的是哪几条才发现**核心那条断言全程存活**。
> **变异杀死的断言集合，必须与该变异所模拟的缺陷对得上。**
> **破坏后必须回显被改的那一行**，跑完逐字还原。

### 5.1 ⚠️ 本线学费换来的六条纪律（逐条适用）

1. **打桩不得让两次读返回相同的值**——否则「读一次」与「读两次」观测相同，断言无法区分。
   **H3 尤其要注意**：三页必须内容可辨。
2. **`describe` 块名不得枚举多个判据 ID**（如 `(H1/H2)`）——会让基于测试名的自动归因跨断言误配，
   产生「变异 ✓」的假阳性。**一个 describe 一个判据。**
3. **安全性断言必须配活性断言**——「不发生坏事」可被「什么都不做」满足。
   **H6 必须同时断言「至少发生过一次请求」**，否则「一个请求都不发」也能通过。
4. **凡本包必须实现的能力，验收行须对纯数据求值**——依赖注入会让核心逻辑
   **可以不存在而测试全绿**。H1/H2/H4 即为此设：直接喂消息数组。
5. **断言的作用域必须收窄到被测对象**——对「整份产物」断言某片段存在，
   无法区分它来自 A 还是 B。
6. **断言里有 fallback 链（`a ?? b`）时，只变异 `b` 什么也证明不了。**

---

## 6　⛔ 派发面硬约束

**`.dd-evidence/` 是 dd 保留路径，任何提交碰它都是硬失败**
（`attempt_controller.py:892-914`，且**重试无用**）。

⛔ **仓内出现属于别的 development 的陈旧 `acceptance.json` 是正常的**——它随 H0 从 main 继承。
**它不是本包的问题，也不该由本包修**：dd 会在本包 acceptance 阶段**自己生成新证据**，
**该问题会自行消解**。**若 reviewer 就此提出 finding，正确回应是说明它不在本包 scope——
而不是去动那个文件。** 已有一条 development 因此被 cancel。

运行证据写 `docs/dev-notes/<development_id>.md`，⛔ **不得复用仓根 `IMPLEMENTATION_SUMMARY.md`**。

---

## 7　非目标

- ⛔ **不做写侧**（CAS 认领 / spawn / 发布）——属 **A8b**，依赖链 C 的 role 存在
- 不把 tick 节点模板从 `--selfcheck` 切到本模式（切换属 A8b，届时才有完整行为）
- 不创建任何 channel（`research:content` 当前 **404 不存在**，属独立的基建动作）
- **不改** `src/protocol.ts`；不改既有模块的导出签名，确需新增则**新增**
- 不做 `SKILL.md` 重写 / `workflow.js` 退役（链 B R4，且须在 A8b 之后）

---

## 8　环境

- `setup_commands` 含 `npm ci`
- agent-bus：`http://127.0.0.1:7490`，Bearer，token 在 `/data/agent-bus/tokens/`
- ⛔ `GET /v1/channels/<id>/messages` 默认 `limit=100` 且返回**最早** 100 条 ⇒ **必须分页**
- ⛔ **`research:content` 当前 404**——本包不依赖它，若代码路径会碰它须能优雅报错
- node **不支持** `--experimental-strip-types`（本机实测 `ERR_NO_TYPESCRIPT`）；
  仓内已有 `vite-node` 可作 runner
