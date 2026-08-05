# A10a —— 只做一件事：止住证据被静默丢弃

> 上游依据：`wf-dc0c15` `spec.md`(rev7) §3.2。依据全部来自 2026-08-05 F0 真跑实测。
> 前置已合入 main：链 A 全部 + A7 + A8a–A8f + A9（22 个包）。
> 本包是 A10 拆分后的前半（修复形状 + 形状守卫 + no_result 不写终态）；
> 「自然收敛 + 端到端真跑」另开 A10b，本包**不做**。

## 缺口

F0 真跑：worker 产出 `worker.result.v1`（`evidences` 6 条）发布上总线；tick 把该卡
CAS 到 `explored`；证据 channel 却 0 条。根因（§0.1）在 `src/harvest.ts`：

```js
const evItems   = result.evidence ?? [];               // ⛔ 字段名错（真实是 evidences）
const clueItems = result.proposed_clues?.items ?? [];  // ⛔ 形状错（真实是裸数组）
```

已冻结的 `worker.result.v1`：`required: ['evidences','proposed_clues','materials']`、
三者均为数组。两处取到 `undefined` ⇒ `needed = 0+0+1 = 1` ≤ 预算 ⇒ **一条不发** ⇒
**CAS `explored`**。旧夹具 `evidence:[...]`、`proposed_clues:{items:[...]}` 与代码
共享同一个错误模型，彼此印证、一起偏离现实——单测发现不了，只有从权威 schema 导出
夹具或真实产物才能发现。

第二缺陷（§0.3）：`no_result` 分支把「该 run 无 worker.result」也 CAS 到 explored——
把「没找到结果」当成了「worker 确实没产出」。

## 改动

### 新增 `profiles/roles/schemas/worker-result.v1.json`
从冻结权威源逐字 vendor 的 worker.result.v1 schema：`required: ['evidences','proposed_clues','materials']`、
三者均为数组。测试夹具从此处 `readFileSync` 读出字段名，**不再手写**（B1）。

### `src/harvest.ts`
- `WorkerResultV1` 改为 `evidences?: WorkerEvidenceItem[]`、`proposed_clues?: WorkerProposedClue[]`、
  `materials?: unknown[]`（裸数组，不再是 `.items`）。
- 新增 `WorkerResultShapeError` 与 `assertWorkerResultShape(result)`：查 `evidences/proposed_clues/materials`
  三个 required 键**全齐且均为数组**；缺任一（含旧的单数 `evidence`、`{items}` 嵌套形状）⇒ 响亮失败，
  绝不当作「0 发布 + CAS explored」静默通过（§1.3）。
- `harvestCard` 读 `result.evidences` / `result.proposed_clues`（裸数组）；`materials` 只校验形状不发布。
- `no_result`（`readWorkerResult` 返回 null）⇒ **留 `in_flight`**：`casExplored=false`、`skippedReason="no_result"`、
  响亮报告；下一 tick 幂等重放仍可再收割（§1.2）。只有「结果存在且 `evidences` 为空数组」才可置终态（§1.2 / B8）。

### `test/harvest.test.ts`（270 → 281 条，+11 条 B 判据）
- 夹具 `validWorkerResult` 由 schema 的 `required` 驱动；`resultWith` 改真实形状。
- 新增 A10a 硬验收 B1–B8。既有 A8e 的 H1–H16 / A9 用例保持通过（B9）。

### `test/a9-tick-trigger.test.ts`
- F9 生产路径里的 `worker.result.v1` 载荷改成真实形状（`evidences` 裸数组 + `materials`）。

## 硬验收（B1–B11）

| # | 断言 | 实现/测试 |
|---|---|---|
| B1 | 夹具字段名从 schema 读出 | `readWorkerResultSchema()` readFileSync schema |
| B2 | 夹具顶层键集合 === required（精确相等） | `Object.keys(validWorkerResult()).sort()` |
| B3 | 三者数组 ⇒ publish 次数 === `evidences.length` | `harvestCard` + 打桩 publish 计数 |
| B4 | 裸数组 `proposed_clues` 正确读取（非 `.items`） | clue publish 次数 === 数组长度 |
| B5 | 旧形状 `evidence` / `{items}` ⇒ 响亮失败，零发布零 CAS | 断言抛 `WorkerResultShapeError` |
| B6 | 缺 `materials` ⇒ 响亮失败（守卫查 required 齐全） | 独立用例 |
| B7 | `no_result` ⇒ 零发布、`casExplored=false`、`skippedReason:"no_result"` | 打桩返回 null |
| B8 | 结果存在 + `evidences` 空数组 ⇒ `casExplored=true`（与 B7 判别） | 两例对照 |
| B9 | A9 的 F0、A8f 的 F1/F5、A8e 的 H6/H7/H14 仍成立 | 原用例仍在且通过 |
| B10 | 不碰 `.dd-evidence/`；既有 270 条用例一条不删 | `git diff`（净增 11 条，共 281） |
| B11 | typecheck + 全量测试 exit 0；证据写本 dev-note | 仓根无 `IMPLEMENTATION_SUMMARY.md` |

## 变异自检（⛔ 必做；每条：回显被改行 → 记录挂掉的判据 → 逐字还原 → diff 确认干净）

| 变异 | 被改行（回显） | 挂掉的判据 | 结论 |
|---|---|---|---|
| M1 `result.evidences` 改回 `result.evidence` | `const evItems = result.evidence ?? [];` | **B3**（publish 3 次期望，实为 0 次） | 杀死 ✓ |
| M2 `no_result` 分支改回 `casExplored: true` | no_result 返回块 `casExplored: true` | **B7**（runWrite 仍 CAS 到 explored） | 杀死 ✓ |
| M3 空 `evidences` 也留 `in_flight` | `if (evItems.length===0) return {…casExplored:false}` | **B8**（空数组不再允许 CAS） | 杀死 ✓ |
| M4 守卫去掉 required 齐全检查 | `for (const key of ["evidences"] as const)` | **B6**（缺 materials 不再抛错） | 杀死 ✓ |

每个变异均：先回显被改的那一行 → 跑对应判据用例看到挂掉（B3/B7/B8/B6 各自失败）→
逐字还原 → `git grep MUTANT` 无残留、`git diff --stat` 干净（只剩上述产品改动）。
M4 变异点在 `src/harvest.ts` 的 `assertWorkerResultShape` 循环迭代集合上（命中语义位置），
M3 变异点在 `harvestCard` 的真实发布路径上（非接口类型声明）。

## 非目标（§4，本包明确不做）

⛔ 不做自然收敛（A10b）；⛔ 不做端到端真跑（A10b）；⛔ 不改 `loop-engine` 仓；
⛔ 不注册/不改任何协议（`worker.result.v1` 已冻结）；⛔ 不实现 triage / synthesizer /
debater / `anchor-check`。

## 验收

- **B1–B8** 新增判据全通过；**B9** 既有 A9 F0/F1/F5、A8f F1/F5、A8e H6/H7/H14 原用例仍通过。
- **B10** 既有 270 条用例一条不删（281 = 270 + 11）；不碰 `.dd-evidence/`。
- **B11** `npm run typecheck` + `npm test` exit 0（281 passed）；证据写本 dev-note；
  仓根无 `IMPLEMENTATION_SUMMARY.md`。
