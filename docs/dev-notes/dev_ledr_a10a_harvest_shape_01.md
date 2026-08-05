# A10a —— 只做一件事：止住证据被静默丢弃

## 缺口（实测，非推断）

F0 真跑：worker 产出 `worker.result.v1`（`evidences` 6 条）发布上总线，tick 把该卡 CAS 到
`explored`，**证据 channel 0 条**。根因在 `src/harvest.ts` 的读取形状偏离真实：

- `result.evidence ?? []`：字段名错（真实是 `evidences`）。
- `result.proposed_clues?.items ?? []`：形状错（真实是裸数组）。

两处取到 `undefined` ⇒ `needed = 0 + 0 + 1 = 1 ≤ 预算` ⇒ 一条不发 ⇒ CAS `explored`。
夹具（`evidence` / `proposed_clues:{items}`）与代码共享同一错误模型，彼此印证、一起偏离现实。

次要缺陷：`no_result` 仍写终态——把「没找到结果」当成了「worker 确实没产出」。

## 改动（交付仅三项，不含收敛、不含真跑）

### 新增 `profiles/roles/schemas/worker-result.v1.json`
把已冻结的 `worker.result.v1` 权威形状落进仓内供测试读取（`required: [evidences,
proposed_clues, materials]`，三者均为数组）。**夹具字段名从此 schema 读出，绝不手写**（B1/B2）。

### `src/harvest.ts`
1. `WorkerResultV1` 改为 `evidences / proposed_clues / materials` 三数组。
2. 新增 `assertWorkerResultShape`：required 键必须**齐全**且均为数组，缺任一 ⇒ **响亮失败**，
   绝不当作「空产物」静默通过（含旧错误形状 `evidence` / `{items}`，B5/B6）。
3. `harvestCard`：
   - `no_result`（读不到 worker.result）⇒ 卡留 `in_flight`、`casExplored: false`、响报告
     `skippedReason:"no_result"`（B7）。
   - 结果存在且 `evidences` 为**空数组** ⇒ 才允许 `casExplored: true`（B8，与 B7 只差一项，判别性）。
   - 读 `result.evidences` / `result.proposed_clues`（裸数组）做发布（B3/B4）。

### `src/tick-inspect.ts`
`findWorkerResult` 的 payload 到 `WorkerResultV1` 的转换改经 `unknown`（接口字段变为
必需后，直接断言转换不再被 TS 接受；守卫在 `harvestCard` 承担运行期形状校验）。

### `test/harvest.test.ts`
- 夹具由 `profiles/roles/schemas/worker-result.v1.json` 的 `required` 键驱动（B1）。
- 默认夹具顶层键集合 === schema required 集合（精确相等，B2）。
- 既有夹具/内联 payload 全部改为真实形状（`evidences` / `proposed_clues` / `materials`）。
- 新增 B3–B8 判别用例。

### `test/a9-tick-trigger.test.ts`
F9 生产路径用例的 `worker.result.v1` payload 改为真实形状（`evidences` / `proposed_clues` /
`materials`），断言不变（`cluesPublished=1`、`hasPendingWork=true`）。

## 硬验收（B1–B11）

| 判据 | 实现/测试 |
|---|---|
| B1 夹具字段名从 schema 读出 | `test/harvest.test.ts` `readFileSync` schema，`REQUIRED_KEYS` 驱动夹具 |
| B2 夹具顶层键集合 === schema required 集合（精确相等） | 断言 `Object.keys(fixture).sort()` === `[...REQUIRED_KEYS].sort()` |
| B3 真实形状三者均数组 ⇒ publish 次数 === `evidences.length` | `publishEvidence` 计数 === 3 |
| B4 `proposed_clues` 裸数组被正确读取（非 `.items`） | `publishClue` 计数 === 3 |
| B5 旧错误形状（`evidence` / `{items}`）⇒ 响亮失败，非 0 发布 + CAS | `harvestCard` rejects + 零 publish |
| B6 缺 `materials` ⇒ 响亮失败 | 守卫独立用例 rejects |
| B7 `no_result` ⇒ 零 publish、`casExplored=false`、`skippedReason:"no_result"` | 读 null ⇒ 断言 |
| B8 结果存在 + `evidences` 空数组 ⇒ `casExplored=true`（判别性） | 与 B7 对照 |
| B9 A9 F0、A8f F1/F5、A8e H6/H7/H14 仍成立 | 原用例仍在且通过 |
| B10 不碰 `.dd-evidence/`；既有 270 条一条不删 | `git diff --stat`（净增 9 条） |
| B11 typecheck + 全量测试 exit 0；dev-notes 存在、仓根无 `IMPLEMENTATION_SUMMARY.md` | 已验证 |

## 变异自检（亲跑，破坏后还原并验证干净）

| 变异 | 被杀断言 | 验证 |
|---|---|---|
| M1 `result.evidences` 改回 `result.evidence` | B3（B1/B2 使夹具无法共谋） | 亲跑 B3 挂；还原干净 |
| M2 `no_result` 分支改回 `casExplored: true` | B7 | 亲跑 B7 挂；还原干净 |
| M3 空 `evidences` 数组也留 `in_flight` | B8 | 亲跑 B8 挂；还原干净 |
| M4 守卫去掉 required 齐全检查 | B6 | 亲跑 B6 挂；还原干净 |

> 每条变异后 `git diff --stat` 复核还原，未把变异留在工作区。
> 变异纪律（§3.1）：语义合法、命中语义位置、改次序真移动。

## 非目标

- 不做自然收敛（seed 触发终态化）、不做端到端真跑 —— 属 **A10b**。
- 不改 `loop-engine` 仓；不注册/不改任何协议（`worker.result.v1` 已冻结）。
- 不实现 triage/synthesizer/debater、不实现 `anchor-check`。