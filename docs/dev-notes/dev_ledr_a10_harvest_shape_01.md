# A10 —— 收割静默丢证据 + 自然收敛（V1 首跑实测三缺陷）

## 缺口

2026-08-05 V1/F0 真跑实测：6 条 evidence 被静默丢弃、卡被置成终态。根因是
`src/harvest.ts` 用**错误形状**读 `worker.result.v1`：

```js
const evItems   = result.evidence ?? [];               // ⛔ 字段名错（应为复数 evidences）
const clueItems = result.proposed_clues?.items ?? [];  // ⛔ 形状错（应为直接数组）
```

而注册在案的 `worker.result.v1` 的 `required` 是 `['evidences','proposed_clues','materials']`，
三者均为数组。真实 payload 实测量到 `evidences: list(6)`、`proposed_clues: list(2)`、
`materials: list(0)`。⇒ 两处都取到 `undefined` ⇒ `needed = 0+0+1 = 1` ≤ 预算 ⇒
**顺利通过预算检查、一条不发、CAS 到 explored**。

⛔ 单元测试无法发现「夹具与代码共享同一个错误模型」：夹具手写的 `evidence` /
`proposed_clues: {items}` 与代码自洽、共同偏离现实。真相一直在总线上机器可读。

另有第二个缺陷：`no_result`（找不到 worker.result）仍写终态（`casExplored: true`），
把「没找到结果」错当成「worker 确实没产出」。第三个缺陷：不收敛（撞 max_passes 而非
自然 `drained`）。

## 改动

### `src/harvest.ts`
- `WorkerResultV1` 改用**权威形状**：`evidences?: WorkerEvidenceItem[]`（复数数组）、
  `proposed_clues?: WorkerProposedClue[]`（直接数组，非 `{items}`）、`materials?: unknown[]`。
  `evidence` 单数字段仅保留供形状校验识别旧错误形状。
- 新增 `assertWorkerResultShape(result)`：`evidence` 出现、或 `evidences/proposed_clues/materials`
  存在但非数组 ⇒ 抛 `WorkerResultShapeError`（响亮失败，C2）。
- `harvestCard`：
  - `evItems = result.evidences ?? []`；`clueItems = result.proposed_clues ?? []`。
  - `no_result`（`!result`）⇒ `casExplored: false`——**不写终态**，卡留 `in_flight`、
    下一 tick 重试、响亮报告（skippedReason="no_result"），绝不 CAS 到 explored（C3）。
  - 结果存在但 `evidences` 为空数组 ⇒ 正常走发布/预算/CAS，允许置终态（C4，判别性）。

## 硬验收（C0–C9）

| 判据 | 实现/测试 |
|---|---|
| C0 夹具形状由注册 schema 的 required 集合导出 | `test/harvest.test.ts`：固化的真实产物 fixture 顶层键 === `['evidences','proposed_clues','materials']` |
| C1 真实形状 ⇒ 发布 N 条 evidence | publishEvidence 调用次数 === evidences 长度 |
| C2 旧错误形状（evidence / {items}）⇒ 响亮失败 / 零 CAS | `assertWorkerResultShape` + runWrite 断言零 publish 零 CAS |
| C3 no_result ⇒ 零 publish、零 CAS、卡留 in_flight、报告含原因 | 打桩 readWorkerResult 返回 null |
| C4 结果存在但 evidences 为空 ⇒ 允许 CAS explored（与 C3 对照） | 两例对照 |
| C5/C6 端到端 real run（reason==="drained" / evidence channel 出现 v2） | 真机验证（本包脚本化验收 gate 之真跑，需 loop-engine CLI + 真实 bus） |
| C7 A9 F0 / A8f F1/F5 / A8e H6/H7/H14 仍成立 | 原用例仍在且通过 |
| C8 不触碰 `.dd-evidence/`；既有 270 条用例一条不删 | git diff（本改动仅 src/harvest.ts + 测试夹具形状对齐 + 本文档） |
| C9 typecheck + 全量测试 exit 0 | `npm run typecheck` + `npm test`（278 条全绿） |

## 收敛说明

F0 不收敛的根因是收割静默吞掉产物 + no_result 误置终态，板面从未真正推进到全终态。
修复形状与 no_result 语义后，收割按真实形状发布 evidence/新 clue，卡正常推进到 explored，
板面全终态时 `hasPendingWork=false` ⇒ 不再续投触发 ⇒ drain 以 `reason === "drained"` 退出
（C5 真机验证）。