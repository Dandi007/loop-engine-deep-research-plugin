# A10a —— 只做一件事：止住证据被静默丢弃

## 实测缺陷（2026-08-05 F0 真跑）

worker 产出 `worker.result.v1`（`evidences` 6 条）发布上总线；tick 把该卡 CAS 到
`explored`；证据 channel 至今 0 条 —— 6 条证据被**静默丢弃**。

### 根因（用真实总线数据复现）
`src/harvest.ts` 读错字段/形状：
- `result.evidence ?? []` ⛔ 真实字段名是 `evidences`
- `result.proposed_clues?.items ?? []` ⛔ 真实是**裸数组**，`.items` 是 JSON Schema 关键字

⇒ 两处取到 `undefined` ⇒ `needed = 0 + 0 + 1 = 1` ≤ 预算 ⇒ **一条不发** ⇒ CAS `explored`。

### 它怎么骗过 270 条用例
`test/harvest.test.ts` 夹具手写 `evidence: [...]`、`proposed_clues: {items:[...]}` ——
与代码的错误读法完全一致，彼此印证、一起偏离现实。权威形状当时已注册在总线上
（`profiles/roles/schemas/worker-result.v1.json`，机器可读），夹具却手写。

### 第二个缺陷：`no_result` 仍写终态（A8e spec 原文写错）
「该 run 无 worker.result ⇒ 仍 CAS 到 explored」把「没找到结果」当成了「worker 确实没产出」。

## 改动

### `src/harvest.ts`
- `WorkerResultV1` 形状修正：`evidences`（数组）/ `proposed_clues`（数组）/ `materials`（数组）。
- 新增 `RESULT_REQUIRED_KEYS = ["evidences","proposed_clues","materials"]`。
- 新增 `assertResultShape(result)`：**required 键齐全守卫**。缺 `evidences`/`proposed_clues`/`materials`
  任一 ⇒ **响亮失败**，⛔ 不得当作「空产物」静默通过。旧错误形状（`evidence` 单数 / `proposed_clues.items`）
  因缺键/形状不符而触发。
- `harvestCard`：
  - `readWorkerResult` 返回 `null` ⇒ ⛔ **留 `in_flight`**：`casExplored: false`、零 publish、
    `skippedReason:"no_result"`（响亮报告）。
  - 结果存在且 `evidences` 为空数组 ⇒ 才允许 `casExplored: true`（与 `no_result` 判别）。
  - 读 `evItems = result.evidences`、`clueItems = result.proposed_clues`（裸数组）。

### `test/harvest.test.ts`
- 全部夹具改为真实形状（`evidences` / `proposed_clues` 裸数组 / `materials`）。
- 新增 B1–B8 硬验收用例（见下）。

### 新增 `profiles/roles/schemas/worker-result.v1.json`
从权威源（loop-engine 角色 schema）读出并**vendor 为本仓可读的机器可读引用**，供测试
`readFileSync` 取 `required` 与 `properties` 键 —— **夹具字段名从此 schema 读出，不得手写**。

### 新增 `test/a9-tick-trigger.test.ts` 夹具形状修正
`worker.result.v1` payload 改为真实形状（`evidences` / `proposed_clues` 裸数组 / `materials`）。

## 硬验收（B1–B11）

| 判据 | 实现/测试 |
|---|---|
| B1 夹具字段名从 `profiles/roles/schemas/worker-result.v1.json` 读出 | `test/harvest.test.ts` `readFileSync` 该 schema 取 required/properties |
| B2 夹具顶层键集合 === schema 的 required 集合（精确相等） | 集合相等断言（非「包含」） |
| B3 真实形状 ⇒ publish 次数 === `evidences.length` | 打桩 publish 计数（3 evidences ⇒ 3 次） |
| B4 `proposed_clues` 裸数组被正确读取（非 `.items`） | 3 裸数组 ⇒ 3 次 clue publish |
| B5 旧错误形状（`evidence`/`{items}`）⇒ 响亮失败 | `harvestCard` 抛 `/required key/`，publish 0 |
| B6 缺 `materials` 键 ⇒ 响亮失败 | `assertResultShape` 抛 `/materials/` |
| B7 `no_result` ⇒ 零 publish、`casExplored === false`、`skippedReason:"no_result"` | 打桩返回 null |
| B8 结果存在且 `evidences` 为空数组 ⇒ `casExplored === true`（判别性 vs B7） | 两例对照 |
| B9 A9 F0、A8f F1/F5、A8e H6/H7/H14 仍成立 | 原用例仍在且通过 |
| B10 不触碰 `.dd-evidence/`、既有 270 条用例不删 | `git diff` 确认 |
| B11 typecheck + 全量测试 exit 0 | 实测 279 条通过 |

## 变异自检（spec §3 / §3.1 纪律）

### M1 `result.evidences` 改回 `result.evidence`
- 回显被改的行：`const evItems = result.evidences ?? [];` → `const evItems = result.evidence ?? [];`
- 挂掉的判据：**B3**（publish 次数 === evidences.length 不再成立，evidences 取 undefined ⇒ 0 发布）。
  且 B5 守卫不再触发 —— `evidences` 键仍存在（夹具带正确形状），但读取路径用回 `evidence`。
- 逐字还原 ✓ `git diff --stat` 干净 ✓

### M2 `no_result` 分支改回 `casExplored: true`
- 回显被改的行：`casExplored: false,`（no_result 分支）→ `casExplored: true,`
- 挂掉的判据：**B7**（断言 `report.casExplored === false` 失败）。
- 逐字还原 ✓ `git diff --stat` 干净 ✓

### M3 空 `evidences` 数组也留 `in_flight`
- 回显被改的行：在 `evItems.length === 0` 时强制返回 `casExplored: false`（人为加在 B8 路径）。
- 挂掉的判据：**B8**（断言 `report.casExplored === true` 失败）。
- 逐字还原 ✓ `git diff --stat` 干净 ✓

### M4 守卫去掉 required 齐全检查
- 回显被改的行：把 `assertResultShape` 的函数体清空（required 齐全检查整体移除）。
- 挂掉的判据：**B5**（旧错误形状不再抛错，静默 0 发布）与 **B6**（缺 `materials` / `evidences` 不再响亮失败）。
- 逐字还原 ✓ `git diff --stat` 干净 ✓

## 非目标（本包明确不做）
- 不做自然收敛（seed 触发终态化）—— 属 A10b
- 不做端到端真跑（`reason === "drained"` / 证据 channel 非空）—— 属 A10b
- 不改 `loop-engine` 仓；不注册/不改任何协议（`worker.result.v1` 已冻结）
- 不实现 triage/synthesizer/debater；不实现 `anchor-check`
