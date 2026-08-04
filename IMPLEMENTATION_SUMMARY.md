# IMPLEMENTATION_SUMMARY — dev_ledr_s3_terminate_01 (attempt 2 / rework)

S3 覆盖度计算 + 三条终止条件 + 终态区分。本文件记录 spec §7（B1 守卫收紧的自验）与
§8（P1–P6 变异自检的逐断言归因）的机械证据。所有变异均在受检源文件上临时改写、
跑相关断言、确认被杀后再还原；还原后 `git diff` 仅含产品改动。

## 一、本次 rework 相对上一 attempt 的修复

最终 review（`rf-attempt_01KZ6JMXBR6BG738BVV08Z6TFB`）的核心阻断项：

- **[major] 条件 3 忽略「只拦新 clue，已 open 的跑完」限定词**。原实现
  `max(depth) >= maxDepth` 一出现即返回非空终态 `capped`，把在途 worker 与 open 卡的
  工作全部放弃。修复：`decideTermination` 对条件 2/3 增加**排空闸门**——触顶后若仍有
  `in_flight` / `open` / `proposed` 工作未排空，`state` 保持 `null`（未终止），仅置
  `capHit = true`；待全部排空才正式报 `capped`。为让 API 层能表达「已触顶、仍在排空」，
  `TerminationState` 新增字段 `capHit`（对应 spec §3 line 37 与 review 关于
  “type has no way to express 'capped but still draining'” 的指摘）。
- **[minor] capped 与 blocked 降级重叠无测试覆盖**。新增 `C8c`：触顶且 `blocked>0`
  时终态为 `capped`（诚实触顶信号，绝不为 `converged`）。§3.2 的安全内核本就成立
  （`converged` 仅当 `blocked===0` 可达），此处显式固化并覆盖。
- **[note] 过时注释**。`TickConfig.maxDepth` 注释由「本包只透传，不消费」改为
  「条件 3：max(depth) >= maxDepth 即触顶」（现已被 `decideTermination` 消费）。
- **[note] 无 IMPLEMENTATION_SUMMARY / 无 §7 注入痕迹**。本文件补齐（见下）。

## 二、spec §8 变异自检——逐断言归因

每次变异：改 `src/tick.ts` 单点 → 跑对应断言 → 确认杀掉 → 还原。被改行如下回显。

| 变异 | 模拟缺陷 | 被杀断言 | 结果 |
|---|---|---|---|
| **P1** | coverage 数 evidence 条数（`.length`）而非去重集合 | **C1** | ✅ 杀 |
| **P2** | coverage 增长时不归零 `zeroGrowthRounds` | **C3** | ✅ 杀 |
| **P3** | 条件 1 去掉「在途 = 0」子条件 | **C5a** | ✅ 杀 |
| **P4** | 条件 2 终态由 `capped` 改 `converged` | **C6** | ✅ 杀 |
| **P5** | 去掉 `blocked > 0` 降级（核心判据） | **C8 与 C9** | ✅ 杀 |
| **P6** | B1 守卫正则改回 `/new\s+Date/` | **§7 自验用例**（注入） | ✅ 见下 |

被改行回显（逐条，变异时实际写入的代码）：

- P1: `return coveredClueIds.length;` （原 `new Set(coveredClueIds).size`）→ C1 失败
- P2: `coverage > input.prevCoverage ? input.prevZeroGrowthRounds : ...+1` → C3 失败
- P3: 条件 1 删掉 `inFlight === 0 &&` → C5a 失败
- P4: capped 分支 `state = "converged"` → C6 失败
- P5: `state = "converged";`（去掉 blocked 三元）→ C8、C9 均失败

P5 是本包核心判据：它模拟的正是 §3.2「因全面卡死而停止、却产出一份自称完备的报告」
的失效模式，C8/C9 双双击杀，符合 spec §8 要求「被杀断言集合与该变异所模拟的缺陷对得上」。

## 三、spec §7 B1 守卫收紧自验（即 P6 的唯一击杀手段）

`test/tick.test.ts` B1 守卫与 `test/s3.test.ts` C13 均用收紧后的 `/\bDate\b/`。

临时向 `src/tick.ts` 的 `computeCoverage` 注入一行：

    const _now = Date.now();

实测：
- B1（`/\bDate\b/`）→ **失败**（说明收紧后的守卫确实拦下 `Date.now()`，不是永远绿的假检查）
- C13（`/\bDate\b/`）→ **失败**（同样拦截）

并单独验证 `Date.now()` 对宽松正则 `/\bDate\b/` 的对抗：
- `/\bDate\b/.test("const _now = Date.now();")` → `true`（收紧后的守卫能拦）
- `/new\s+Date/.test("const _now = Date.now();")` → `false`（旧正则漏网）
- `/new\s+Date/.test("const d = new Date();")` → `true`（旧正则只认 `new Date`）

故 P6（把正则改回 `/new\s+Date/`）不会被任何常驻测试击杀（`src/tick.ts` 无三个禁用 token），
只有上述 §7 注入运行（配合 `/\bDate\b/`）能证明其有杀伤力——本文件即该次运行的记录。
注入后已还原，`grep -c "Date.now()" src/tick.ts` 为 0。

## 四、验收

- `npm run typecheck` → exit 0
- `npm test` → 5 files / 61 tests 全部通过（既有 42 条 + S3 净增 19 条，`it(` 无净减少）
