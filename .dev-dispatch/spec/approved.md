# E0c3b —— 解开 triage 死锁 + 消灭 acceptance 抖动

> **前一版 `dev_dr_e0c3_20260812_2255` 的下场**：两轮 attempt 过审，`bin/e0-regression.sh` 的三项改动
> **实现都是对的**，但 **acceptance 的 `npm test` 挂了一条** ⇒ development FAILED。
> 派发方在**同一 commit** 上复跑：单测隔离跑 ✅、**全量 `npm test` 也全绿（37 files / 611 tests / 46s）**
> ⇒ 那是**抖动**，不是缺陷。根因见 **GT-12**，本版把它一并修掉。

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E0c2f 的 `main`）
**为什么存在**：E0c2f 已交付终止语义域并**已合并**——跨 drain 循环、退避、上限、GT-6 退出码分类、
终态取真值、续投门对齐、失败轮回显、进度行，真机全部验过。**唯独判据 Z1（跑到非 null 终态）没达成**，
原因不在 E0c2f 的实现，而在 `src/tick.ts` 的 triage 门限——本包只修这一件事。

**⛔ 请保持改动面小。** 本包**不碰**已交付的终止语义、入口循环、取证链路。

---

## 0　⛔ 地面真相（真机取证，照抄，不得推测、不得由 fixture 反推）

### GT-12　⭐⭐ 假 bus 端口是「随机数不校验」，并发跑必然偶发撞车

`test/e0c2-termination.test.ts:259-262` 逐字：

```ts
const busPort = 18000 + Math.floor(Math.random() * 1000);
const prodBusPort = 19000 + Math.floor(Math.random() * 1000);
```

**纯随机、不检测占用、不重试**。仓内有二十余处这样起假 bus 的用例，vitest 跨文件并行 ⇒
生日悖论下撞车是常态；撞上之后 `startFakeBus` 不响亮失败，被测入口连到**别的用例的 bus**、
读到别人的板面 ⇒ 断言莫名其妙地红。

真机实录（派发方 2026-08-12 23:32 acceptance 现场 vs 23:48 同 commit 复跑）：

```
acceptance（dd 沙箱内）：
  FAIL test/e0c2-termination.test.ts > 判据 6d (GT-8) … > progress line contains numeric head_seq (not '?')
  AssertionError: expected 1 to be +0        （入口退出码 1，期望 0）
  Test Files 1 failed | 36 passed    Tests 1 failed | 610 passed
派发方同 commit 复跑：
  隔离跑该用例：           ✓ 3131ms
  全量 npm test：          Test Files 37 passed (37)   Tests 611 passed (611)   46.45s
```

⇒ **一条抖动的测试会整包毙掉 development**（acceptance 不区分 flake 与真失败），
这是这个仓每个后续包都要交的税。本包顺手把它修掉。

### GT-11　⭐⭐ 板上只有 1–2 条 `proposed` ⇒ **永久死锁**，终态永远为 null

仓内逐字（`src/tick.ts`）：

```ts
// :298-311  §5 派 triage：count(proposed) >= K 且 triage 无在途。
if (proposedClues.length >= cfg.triageThreshold && !state.triageInFlight) {
  decisions.push({ kind: "triage", proposedClues, exploredSummaries });
}

// :82-89
export const DEFAULT_TICK_CONFIG: TickConfig = {
  triageThreshold: 3,
  maxConcurrentWorkers: 4,
  maxDepth: 3,
  maxRetries: 2,
  maxClues: 64,
  zeroGrowthThreshold: 2,
};
```

而 `decideTermination`（`:369-388`）要求 `inFlight === 0 && open === 0 && proposed === 0`。

⇒ **`proposed` 数量落在 1..2 时：triage 不触发（1 < 3）⇒ proposed 永远清不掉 ⇒ 终态永远 null。**
不是"慢"，是**结构上不可达**。

**真机实录**（派发方 2026-08-12 22:06–22:34 在 E0c2f 候选上跑 `bash bin/e0-regression.sh`，逐字）：

```
[e0-regression] drain #1:  reason=max_rounds termination.state=null head_seq=2
[e0-regression] drain #2:  reason=max_rounds termination.state=null head_seq=2
[e0-regression] drain #3:  reason=max_rounds termination.state=null head_seq=4   ← worker 返回、收割发生
[e0-regression] drain #4..#12: reason=max_rounds termination.state=null head_seq=4  ← 此后毫无变化
[e0-regression] HIT ATTEMPT LIMIT: max_attempts=12 drain_attempts=13
run.meta: drain_attempts=13  final_termination_state=null
          prod_bus_sum_before=10263  prod_bus_sum_after=10263  prod_bus_delta=0  entry_exit_code=4
```

同一块板的实况（测试总线 7495，`research:e0-a692fcbd9fe2632d.*`）：

```
index    4 条： seq1 open(depth0) → seq2 in_flight → seq4 explored ；seq3 = 新 clue，status=proposed, depth=1
evidence 3 条 research.evidence.v2      ← 证据确实被收割出来了
docs     2 条
board:agent-runs  24 → 27（worker 真跑过，agent.run.exited.v2 exit=0）
```

只读复核（`vite-node src/tick-entry.ts -- --inspect <index>`，逐字）：

```json
{ "messageCount": 4, "clueEntities": 2,
  "statusDistribution": { "explored": 1, "proposed": 1 },
  "coverage": 0,
  "decisions": [],
  "termination": { "state": null, "coverage": 0, "zeroGrowthRounds": 1, "capHit": false } }
```

**`decisions: []` —— 板上有活儿，但这一轮什么决定都不做。** 这就是死锁的样子。

> 种子只有 1 条线索、一个 worker 大约提 1 条新线索 ⇒ 这条回归基线**结构上永远到不了终态**。

## 1　交付内容（只此四项）

### 1.1 让回归基线结构上能收敛

必须让"1–2 条 proposed"不再是死路。**实现方式二选一或都做**：

- **(a)** `triageThreshold` 由 profile 声明（**缺省仍是 3，⛔ 不得改缺省**），回归 profile 显式设为 **1**；
- **(b)** profile 声明 **≥3 条**种子线索（`bin/tick-entry.sh --seed` 支持重复 `--clue`），
  使 proposed 能自然攒到阈值。

⛔ **不得改 `decideTermination` 的 `proposed === 0`**（那是把温度计砸了）。
⛔ 不得把 proposed 直接判成终态、不得在 tick 里"自动丢弃"低于阈值的 proposed。
若选 (a)：该配置项要与仓内既有 profile 键同一套读法，缺省行为对其它 profile **逐字不变**。

### 1.2 以「proposed 未清空」收尾必须响亮

撞上限退出时，错误信息除了点名撞的是哪个上限，**还必须打印板面构成**：
`proposed=<n> open=<m> in_flight=<k> explored=<x> blocked=<y>`，
并在 `proposed > 0 且 proposed < triageThreshold` 时**显式点名这是 triage 门限死锁**
（给出该轮的 threshold 实测值）。⛔ 不得只报"撞了哪个上限"——那让 GT-11 这种死锁看起来像"跑得慢"。

### 1.3 消灭假 bus 端口撞车（GT-12）

起假 bus 一律改成**由内核分配端口**（`listen(0)` 后读回实际端口）或**占用即重试**，
使并发跑不可能撞车；`startFakeBus` 在起不来时必须**响亮失败**（⛔ 不得静默继续，
那正是"连到别人的 bus"的成因）。仓内**所有**这样起假 bus 的用例都要改到同一条路径上，
⛔ 不得只改本包新加的那几条。

### 1.4 修 `drain_attempts` 报数

实测：`max_attempts=12` 却报 `drain_attempts=13`（`run.meta` 与 stdout 两处一致地多 1）。
按"实际执行过的 drain 次数"报，⛔ 不得只改文案掩盖差 1。

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` 全绿；**`test/a10b-convergence.test.ts` 的 B1/B2 仍绿且余量充足**
   （E0c2f 已把它们的 timeout 放宽，⛔ 本包不得改回）。
2. **⭐ 判别性（GT-11 核心）**：构造「板上恰好 1 条 proposed、无在途、未触顶」⇒
   在回归 profile 下**必须能推进**（triage 被派出 / 或该形态在本 profile 下不可能出现）；
   把 §1.1 的改动撤回（threshold 回到 3 且种子回到 1 条）⇒ 该测试**变红**。
3. **⭐ 判别性**：其它 profile（未声明 threshold）行为逐字不变——缺省仍是 3。
4. **⭐ 判别性**：撞上限且 `proposed > 0` ⇒ 错误信息**同时**含板面构成与"triage 门限死锁"点名；
   去掉板面构成 ⇒ 测试变红。
5. `drain_attempts` 与实际 drain 次数一致（上限 12 ⇒ 最多报 12）。
5b. **⭐ 判别性（GT-12）**：仓内不再出现 `Math.random()` 派生的假 bus 端口；
   端口来自内核分配或占用重试，且起不来时响亮失败。
   把端口改回随机常量范围 ⇒ 该检查变红。
   **⛔ `npm test` 连跑两次都必须全绿**（抖动一次即视为未交付）。
6. **回归 ⛔**：E0c2f 与 E0c1 的全部行为逐字不变（跨 drain 循环与退避、GT-6 三分类、
   终态取真值、续投门、失败轮回显、进度行、per-run 板、种子带 sources、head_seq 只从列表端点取、
   生产总线真实全量求和与护栏、运行记录归档）。
7. **Z1（真机）**：`bash bin/e0-regression.sh` 跑到**非 null 终态**、**退出 0**，
   `board:agent-runs` head_seq 相对跑前严格增长，**且证据 channel head_seq > 0**。
8. **Z2（真机）**：运行前后生产总线 `sum(head_seq)` 零增长（派发方独立复算）。
9. **Z3（真机）**：连续两次执行都退出 0、各自独立 run id 与独立研究板、两次都满足判据 7。

> 判据 7–9 由派发方在真机上验证。⚠️ 一次真机跑预计**若干分钟到几十分钟**
> （单个 code-local worker ≈ 158 秒，退避 120 秒）——这是正常的；
> ⛔ 不得为求快把研究范围缩到秒级，⛔ 不得为让判据过而放宽判据本身。

## 3　⛔ 明确不做

web/content 接线（E2b）、ingest（E1）、anchor scheme（E3）、收工仲裁者（E5）、原子产物（E4）、
驱动脚本重写进 TS 入口（E7）、协议注册、`recipes/*` 工具白名单、生产 profile `agent-harness.env`。
⛔ 不重写 E0c2f 已交付的任何东西。

## 4　运行环境前提（派发方已就位，⛔ 实现者不需要做也不得与之冲突）

测试总线 `http://127.0.0.1:7495`（独立 SQLite，与生产 7490 零共享）：三个 agent 已注册、
token 落 `/data/agent-bus-test/tokens/`；`board:agent-runs` 已建；协议已用
`agent-run register-bus-protocols` 供给齐全（14 个 kind）。
⛔ 实现者不得在代码里自动注册 protocol：协议注册不可逆，是拍板级动作。

## 5　评审口径

- **REJECT 只用于 blocker 级**：判据不成立、判别性缺失、自造契约、放宽终态判据、
  改坏 E0c2f/E0c1 已有行为、越出 §1 范围。文风与偏好写成 non-blocking 建议。
- ⚠️ 本线累计因「为观察不到的产物发明契约、再写 fixture 迎合它」被驳回 7 次，
  另有 2 次因「测试绕开被测入口、在测试内部重实现一遍逻辑」被驳回。
  **判据 2 与 4 的测试必须真正驱动被测对象**，⛔ 不得在测试内部重实现 triage 判定。
- reviewer 只读，判据 1–6 由 acceptance 命令的执行结果作证，⛔ 不要求 reviewer 执行 shell。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`（引擎保留路径，写入即永久 wedge）。
