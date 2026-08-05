# A10 —— 收割静默丢证据 + 自然收敛（V1 首跑实测三缺陷）

> 上游依据：`wf-dc0c15` `spec.md`(rev7) §3.2 / §3.4；**全部依据来自 2026-08-05 V1/F0 真跑实测。**
> 前置已合入 main：链 A 全部 + A7 + A8a–A8f + **A9**（22 个包）。

---

## 0　实测：6 条证据被静默丢弃，卡被置成终态

F0 真跑（A9 gate）时间线（UTC）：

| 时间 | 事件 |
|---|---|
| 02:46:50 | 卡 → `in_flight`，run `4b8b0f91-e189-4094-b358-e1b5a8d58e39` |
| **02:56:13** | **`worker.result.v1` 发布：`evidences` 6 条、`proposed_clues` 2 条** |
| **03:20:38** | **tick 把该卡 CAS 到 `explored`** |
| 至今 | **证据 channel 0 条** |

### 0.1 根因（本 gate 用真实总线数据复现，非推断）

`src/harvest.ts:245-246`：
```js
const evItems   = result.evidence ?? [];               // ⛔ 字段名错
const clueItems = result.proposed_clues?.items ?? [];  // ⛔ 形状错
```

**注册在案（已永久冻结）的 `worker.result.v1`**：
```
required: ['evidences', 'proposed_clues', 'materials']
evidences.type: array
```
**真实 payload 实测**：`evidences: list(6)`、`proposed_clues: list(2)`、`materials: list(0)`

⇒ 两处均取到 `undefined` ⇒ `evItems=[] / clueItems=[]`
⇒ `needed = 0+0+1 = 1` ≤ 预算 ⇒ **顺利通过预算检查、一条不发、CAS 到 `explored`**。

### 0.2 ⛔ 它是怎么骗过 270 条用例的：**夹具与代码共享同一个错误模型**

`test/harvest.test.ts` 实测：
```js
evidence: [ ... ]                                  // 单数，与代码一致
proposed_clues: { items: [{clue:"new idea 1"}] }   // {items}，与代码一致
```

⇒ **夹具和代码彼此自洽、共同偏离现实。**

> ### 判据：单元测试**无法**发现「夹具与代码共享同一个错误模型」——
> ### 它们互相印证，一起偏离现实。**只有真实数据能发现。**
>
> 而**权威形状几小时前就被注册在总线上、机器可读**。真相一直可查，夹具却是手写的。
> 猜测成因：`evidences.items` 是 **JSON Schema 的关键字**（描述数组元素形状），
> 被当成了运行期 payload 结构。

### 0.3 第二个缺陷：`no_result` 仍写终态（**我在 A8e spec 里写错的**）

`src/harvest.ts:231-241`：`!result` ⇒ `skipped:true, skippedReason:"no_result", **casExplored: true**`。
而预算不足那条是 `casExplored: false`（正确）。

⛔ **我在 A8e spec §1 写的原话是错的**：
> 「该 run 无 worker.result ⇒ 无产物可收割；仍 CAS 到 explored（无产出即无事）」

**把「没找到结果」当成了「worker 确实没产出」。**

### 0.4 第三个缺陷：不收敛

F0：`{"reason":"max_rounds","rounds":16,"ticksByLabel":{"tick":16}}` ——
撞 `max_passes` 而非自然 `drained`。
（A9 的续投逻辑本身正确：触发存储自始至终只有 seed 一条 ⇒ 从未续投；
成因是 seed 触发始终停在 `open`、每轮可被重新认领。）
⛔ **我的 A9 spec §1.3 正文要求「自然终止」，验收表却只有 `tick >= 1`** —— 又一次「正文要求、验收不查」。

---

## 1　交付

1. **修字段/形状**：`result.evidences`（复数、数组）、`result.proposed_clues`（数组）、`materials` 同理。
2. ⛔ **`no_result` 不得写终态**：找不到 `worker.result` ⇒ **留在 `in_flight`**（下一 tick 重试）
   并**响亮报告**；⛔ 绝不 CAS 到 `explored`。
   「worker 确实无产出」只能由**明确证据**确立（`evidences` 为**空数组**且结果存在），该情形才可置终态。
3. **自然收敛**：seed 触发被消费后须走到终态，使板面全终态时 drain 以 `reason === "drained"` 退出。

---

## 2　硬验收

> ⛔ **C0/C1/C2 三条必须用真实数据或注册 schema 求值，不得手写夹具形状。**

| # | 断言 | 怎么验 |
|---|---|---|
| **C0** | ⛔ **夹具形状由「注册在案的 schema」或**真实总线产物**导出**，不得手写 | 测试从 `profiles/roles/schemas/worker-result.v1.json` 或固化的真实产物 fixture 读取字段名；**新增一条断言：夹具的顶层键集合 === schema 的 `required` 集合** |
| **C1** | ⛔ 喂**真实产物形状**（`evidences`/`proposed_clues`/`materials` 均为数组）⇒ **发布 N 条 evidence** | 断言 publish 次数 === evidences 长度 |
| **C2** | ⛔ **旧错误形状**（`evidence` / `{items}`）⇒ **不得被当成有效产物静默通过** | 喂旧形状 ⇒ 断言**响亮失败或零 CAS**，⛔ 不得「0 发布 + CAS explored」 |
| **C3** | ⛔ `no_result` ⇒ **零 publish、零 CAS、卡留 `in_flight`**、报告含原因 | 打桩 readWorkerResult 返回 null |
| **C4** | ⛔ 结果存在但 `evidences` 为**空数组** ⇒ 允许 CAS `explored`（与 C3 只差一项，判别性） | 两例对照 |
| **C5** | ⛔ 端到端：真实 `bin/deep-research-loop.sh` 跑完 **`reason === "drained"`** | 真跑断言 JSON 字段，⛔ 不得打桩 |
| **C6** | ⛔ 端到端：跑完**证据 channel 真的出现 `research.evidence.v2`** | 真跑后读 channel 断言条数 > 0 |
| **C7** | ⛔ A9 的 F0（`tick >= 1`）、A8f 的 F1/F5、A8e 的 H6/H7/H14 仍成立 | 原用例仍在且通过 |
| **C8** | ⛔ 不得触碰 `.dd-evidence/`；既有 **270** 条用例一条不删 | `git diff` |
| **C9** | typecheck + 全量测试 exit 0；证据写 dev-notes | — |

### 2.1 ⛔ C5/C6 的执行约束
- 真机只允许打 `research:p02-smoke-1dce60`（板 channel）与一个**已核实存在**的证据 channel
- ⛔ **不得写 `research:v1-*`**（V1 的干净板面，gate 保留）
- 跑前跑后记录消息数增量，写进 dev-notes

---

## 3　变异自检

| 变异 | 必须杀死 |
|---|---|
| **M1** 把 `result.evidences` 改回 `result.evidence` | **C1**（且 C0 应使夹具无法与之共谋） |
| **M2** `no_result` 分支改回 `casExplored: true` | **C3** |
| **M3** 空 `evidences` 数组也留 `in_flight` | **C4** |
| **M4** 收敛判定恒为「还有活」 | **C5** |
| **M5** 夹具改成手写旧形状 | **C0** |

> **破坏后必须回显被改的那一行**，跑完逐字还原并 `git diff --stat` 确认干净。

### 3.1 ⚠️ 变异纪律（本线各栽一次）
1. ⛔ **必须语义合法**（曾写错变量名 ⇒ 运行期错误炸整个模块，17 条挂 10 条，什么都没归因）。
2. ⛔ **必须命中语义位置**（曾把正则打在**类型声明**上，而运行器不做类型检查 ⇒ 全绿被误读成「实现对」）。
3. ⛔ **改次序必须真移动**（曾只在前面**加**一次 CAS、保留后置那次 ⇒ 该挂的没挂）。

---

## 4　非目标
- ⛔ 不改 `loop-engine` 仓（共享仓）；⛔ 不注册/不改任何协议（`worker.result.v1` 已冻结）
- ⛔ 不实现 triage/synthesizer/debater（属 R2）；不实现 `anchor-check`
- ⛔ **不得为让 C5/C6 通过而放宽任何既有守卫**

## 5　⛔ 派发面
- `setup_commands`: `npm ci`（本仓用 npm）
- ⚠️ `LOOP_ENGINE_CLI` 需指向可用构建；本机 `/data/code/self/loop-engine` 落后 49 个提交且 `dist/` 残缺，
  ⛔ **不得改该共享仓**；可用 `/data/worktrees/loop-engine-v1build/dist/cli.js`
- ⛔ **必须用 `bun` 跑 loop-engine CLI**（`node` 因 extensionless import 报 `ERR_MODULE_NOT_FOUND`）
- ⛔ 读退出码时命令后不得接管道；⛔ 对会增长的 channel 做存在性判断须先取 `head_seq` 再用 `after_seq` 倒查
- `.dd-evidence/` 是保留路径；陈旧 `acceptance.json` 不该由本包修
