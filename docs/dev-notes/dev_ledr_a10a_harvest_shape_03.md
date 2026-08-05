# A10a —— 只做一件事：止住证据被静默丢弃

## 缺口（F0 真跑实证）

worker 产出 `worker.result.v1`（`evidences` 6 条）发布上总线后，tick 把卡 CAS 到 `explored`，
但证据 channel 至今 0 条。根因在 `src/harvest.ts` 两处**形状读错**：

- `result.evidence ?? []` —— 字段名错（真实是 `evidences`）；
- `result.proposed_clues?.items ?? []` —— 形状错（真实是**裸数组**；`items` 是 JSON Schema 关键字
  `evidences.items` 描述数组元素，被当成了运行期结构）。

两处取到 `undefined` ⇒ `needed = 0+0+1 = 1` ≤ 预算 ⇒ 一条不发 ⇒ CAS `explored`。

单元测试**无法**发现此缺陷，因为夹具与代码共享同一个错误模型：夹具手写 `evidence` / `{items}`，
与错误读法彼此印证。**只有从权威源导出夹具**（冻结的 `worker-result.v1.json` schema）才能发现。

## 改动

### 新增 `profiles/roles/schemas/worker-result.v1.json`
- 已冻结的 `worker.result.v1` schema 的权威副本（`required: ['evidences','proposed_clues','materials']`，
  三者 `type: array`）。测试夹具从它 `readFileSync` 读出键（B1/B2），不再手写错误形状。

### `src/harvest.ts`
- `WorkerResultV1`：字段修正为 `evidences / proposed_clues / materials`（三者数组），删除单数
  `evidence` 与 `{items}` 嵌套。
- 新增 `WorkerResultShapeError` + `assertWorkerResultShape`：守卫查 **required 键齐全**且均为数组；
  缺任一（含旧单数 `evidence`、`{items}` 嵌套）⇒ **响亮失败**，绝不当作「0 发布 + CAS explored」
  静默通过（B5/B6）。
- `harvestCard`：
  - `no_result`（找不到 worker.result）⇒ **留 in_flight**：`casExplored: false`、`skippedReason:
    "no_result"`、零 publish。⛔ 不再写终态（B7）。
  - result 存在 ⇒ 先 `assertWorkerResultShape`，再读 `result.evidences` / `result.proposed_clues`
    （裸数组）/ `result.materials`。
  - result 存在且 `evidences` 为空数组（worker 确实无产出）⇒ 允许 `casExplored: true`（B8，
    与 B7 只差「结果是否存在」这一项，判别性）。

### `test/harvest.test.ts`
- 夹具改由 `readWorkerResultSchema()` 驱动：`validWorkerResult()` 按 schema 的 required 键构造
  （顶层键集合 === required 集合，B2）。
- 既有 A8e 用例（H6/H7/H8/H9/H12/H13/H14/H15/H16/H1）与 A9 生产路径用例的 worker.result
  夹具同步改为真实形状。
- 新增 B1–B8 硬验收用例。

## 硬验收对照

| # | 结果 |
|---|---|
| B1 | schema 读出 required 键，夹具不再手写 ✓ |
| B2 | 夹具顶层键集合 === schema required 集合（精确相等）✓ |
| B3 | 真实形状 ⇒ publish 次数 === `evidences.length` ✓ |
| B4 | `proposed_clues` 裸数组正确读取（非 `.items`）✓ |
| B5 | 旧错误形状（`evidence` / `{items}`）⇒ 响亮失败，非 0 发布 + CAS ✓ |
| B6 | 缺 `materials` ⇒ 响亮失败 ✓ |
| B7 | `no_result` ⇒ 零 publish、`casExplored:false`、`skippedReason:"no_result"` ✓ |
| B8 | result 存在 + 空 `evidences` ⇒ `casExplored:true`（与 B7 判别）✓ |
| B9 | A9 F0/F9、A8f F1/F5、A8e H6/H7/H14 仍成立（原用例未删，夹具已修正形状）✓ |
| B10 | 未触碰 `.dd-evidence/`；既有 270 条用例一条未删 ✓ |
| B11 | typecheck + 全量测试 exit 0；本文件为证据；仓根无 `IMPLEMENTATION_SUMMARY.md` ✓ |

## 变异自检（亲跑，破坏后逐字还原并验证干净）

| 变异 | 被杀断言 | 验证 |
|---|---|---|
| **M1** `result.evidences` 改回 `result.evidence` | **B3**（且 B1/B2 使夹具无法与之共谋） | 亲跑 B3 挂；还原干净 |
| **M2** `no_result` 分支改回 `casExplored: true` | **B7**（两条断言全挂） | 亲跑 B7 挂；还原干净 |
| **M3** 空 `evidences` 数组也留 `in_flight` | **B8**（两条断言全挂） | 亲跑 B8 挂；还原干净 |
| **M4** 守卫去掉 required 齐全检查 | **B6** | 亲跑 B6 挂；还原干净 |

> 每条变异后 `git diff --stat` 复核还原，未把变异留在工作区；最终工作区干净。

## 非目标（A10b 另开）
- 不做自然收敛（seed 触发终态化）。
- 不做端到端真跑（`reason === "drained"` / 证据 channel 非空）。
- 不改 `loop-engine` 仓；不注册/不改任何协议（`worker.result.v1` 已冻结，本包仅 vendor 其权威副本供夹具读取）。
