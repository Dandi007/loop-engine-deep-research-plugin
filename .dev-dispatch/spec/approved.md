# A10a —— 只做一件事：**止住证据被静默丢弃**

> 上游依据：`wf-dc0c15` `spec.md`(rev7) §3.2。依据全部来自 2026-08-05 F0 真跑实测。
> 前置已合入 main：链 A 全部 + A7 + A8a–A8f + A9（22 个包）。
> **本包是 A10 拆分后的前半**（A10 两次 attempt 均正确实现了核心修法、均倒在周边工作上
> ⇒ 判定为**包过大**，而非实现能力问题。后半「自然收敛 + 端到端真跑」另开 A10b）。

---

## 0　实测缺陷：6 条证据被静默丢弃，卡被置成终态

F0 真跑：worker 产出 `worker.result.v1`（`evidences` 6 条）于 **02:56:13** 发布上总线；
tick 于 **03:20:38** 把该卡 CAS 到 `explored`；**证据 channel 至今 0 条**。

### 0.1 根因（本 gate 用真实总线数据复现过，非推断）
`src/harvest.ts`：
```js
const evItems   = result.evidence ?? [];               // ⛔ 字段名错（真实是 evidences）
const clueItems = result.proposed_clues?.items ?? [];  // ⛔ 形状错（真实是裸数组）
```
**注册在案、已永久冻结的 `worker.result.v1`**：`required: ['evidences','proposed_clues','materials']`、
`evidences.type: array`。真实 payload：三者**均为数组**。

⇒ 两处取到 `undefined` ⇒ `needed = 0+0+1 = 1` ≤ 预算 ⇒ **一条不发** ⇒ **CAS `explored`**。

### 0.2 ⛔ 它怎么骗过 270 条用例：**夹具与代码共享同一个错误模型**
`test/harvest.test.ts` 夹具写的是 `evidence: [...]`、`proposed_clues: {items:[...]}`
—— **与代码的错误读法完全一致**，于是彼此印证、一起偏离现实。

> ### 判据：单元测试**无法**发现「夹具与代码共享同一个错误模型」。
> ### 只有**从权威源导出夹具**或用**真实产物**才能发现。
> 而权威形状当时**已注册在总线上、机器可读**。真相可查，夹具却是手写的。
> 成因推测：`evidences.items` 是 **JSON Schema 关键字**（描述数组元素），被当成了运行期结构。

### 0.3 第二个缺陷：`no_result` 仍写终态（**我在 A8e spec 里写错的**）
原文：「该 run 无 worker.result ⇒ 仍 CAS 到 explored（无产出即无事）」
—— **把「没找到结果」当成了「worker 确实没产出」**。

---

## 1　交付（**只此三项，不含收敛、不含真跑**）

1. **字段/形状修正**：读 `result.evidences`（数组）、`result.proposed_clues`（数组）、`result.materials`（数组）。
2. ⛔ **`no_result` 不得写终态**：找不到 `worker.result` ⇒ 留 `in_flight`、响亮报告、`casExplored: false`。
   **「worker 确实无产出」只能由明确证据确立**：结果存在且 `evidences` 为**空数组** ⇒ 该情形才可置终态。
3. ⛔ **形状守卫必须查 required 键齐全**（不只是拒已知的单数 `evidence`）：
   缺 `evidences`/`proposed_clues`/`materials` 任一 ⇒ **响亮失败**，⛔ 不得当作「空产物」静默通过。

---

## 2　硬验收（**全部可在单元层求值，无需真跑**）

| # | 断言 | 怎么验 |
|---|---|---|
| **B1** | ⛔ **夹具字段名从 `profiles/roles/schemas/worker-result.v1.json` 读出**，不得手写 | 测试代码 `readFileSync` 该 schema 取 `required` 与 `properties` 键 |
| **B2** | ⛔ **夹具顶层键集合 === schema 的 `required` 集合**（精确相等） | 断言集合相等，⛔ 非「包含」 |
| **B3** | ⛔ 真实形状（三者均数组）⇒ **publish 次数 === `evidences.length`** | 打桩 publish 计数 |
| **B4** | ⛔ `proposed_clues` 为裸数组时**被正确读取**（非 `.items`） | 断言 clue publish 次数 === 数组长度 |
| **B5** | ⛔ 旧错误形状（`evidence` / `{items}`）⇒ **响亮失败**，⛔ 不得「0 发布 + CAS explored」 | 断言抛错或 `casExplored === false` 且 publish 0 |
| **B6** | ⛔ 缺 `materials` 键 ⇒ **响亮失败**（守卫查 required 齐全） | 独立用例 |
| **B7** | ⛔ `no_result` ⇒ 零 publish、**`casExplored === false`**、报告含 `skippedReason:"no_result"` | 打桩返回 null |
| **B8** | ⛔ 结果存在且 `evidences` 为**空数组** ⇒ **允许 `casExplored === true`**（与 B7 只差一项，判别性） | 两例对照 |
| **B9** | ⛔ A9 的 F0、A8f 的 F1/F5、A8e 的 H6/H7/H14 仍成立 | 原用例仍在且通过 |
| **B10** | ⛔ 不得触碰 `.dd-evidence/`；既有 **270** 条用例一条不删 | `git diff` |
| **B11** | typecheck + 全量测试 exit 0；证据写 `docs/dev-notes/<development_id>.md` | 仓根无 `IMPLEMENTATION_SUMMARY.md` |

---

## 3　变异自检（⛔ 必须做，dev-notes 必须有该节）

| 变异 | 必须杀死 |
|---|---|
| **M1** `result.evidences` 改回 `result.evidence` | **B3**（且 B1/B2 应使夹具无法与之共谋） |
| **M2** `no_result` 分支改回 `casExplored: true` | **B7** |
| **M3** 空 `evidences` 数组也留 `in_flight` | **B8** |
| **M4** 守卫去掉 required 齐全检查 | **B6** |

> ⛔ **每个变异必须：回显被改的那一行 → 记录挂掉的判据 → 逐字还原 → `git diff --stat` 确认干净。**
> **只报「N 条挂了」不算数。**

### 3.1 ⚠️ 变异纪律（本线各栽一次，全部由「回显 + 核对该挂的是否挂了」发现）
1. ⛔ **必须语义合法**：曾写错变量名 ⇒ 运行期错误炸整个模块，17 条挂 10 条，**什么都没归因**。
2. ⛔ **必须命中语义位置**：曾把正则打在**接口类型声明**上，而测试运行器**不做类型检查** ⇒ 全绿被误读成「实现对」。
3. ⛔ **改次序必须真移动**：曾只在前面**加**一次 CAS、保留后置那次 ⇒ 该挂的断言依然成立。

---

## 4　非目标（⛔ 本包**明确不做**，避免重蹈 A10 过大之覆）
- ⛔ **不做自然收敛**（seed 触发终态化）—— 属 **A10b**
- ⛔ **不做端到端真跑**（`reason === "drained"` / 证据 channel 非空）—— 属 **A10b**
- ⛔ 不改 `loop-engine` 仓；不注册/不改任何协议（`worker.result.v1` 已冻结）
- ⛔ 不实现 triage/synthesizer/debater；不实现 `anchor-check`

## 5　⛔ 派发面
- `setup_commands`: `npm ci`（本仓用 npm）
- `.dd-evidence/` 是保留路径，actor 碰它即硬失败；陈旧 `acceptance.json` **不该由本包修**
- ⚠️ reviewer 若称「环境里没有某文件」可能是假阳性（其 harness 文件系统视图与宿主不同）
- ⛔ 测试不得触网；⛔ 不得把真实 secret 值写进任何产物
