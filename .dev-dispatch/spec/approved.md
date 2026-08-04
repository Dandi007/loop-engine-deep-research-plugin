# A8e —— 收割：把 `worker.result.v1` 转成 evidence 与新 clue 写回研究板

> 上游依据：`wf-dc0c15` 的 `spec.md`(rev7) §2.2 / §2.6 / §3.1 / §3.2 / §5.2。
> 前置已合入 main：链 A 全部 + A7 + A8a + A8b + A8c + **A8d**（缺省 worker = 真实 `agent-run`）。
> 跨仓前置已合入：A1c（`--run-id`）、R1c（输入契约）、**R1d**（深化 `openSchema`）。
> 跨仓前置动作：**`worker.result.v1` 已注册**（公示 thread `msg_01KZ7B86B0755WDEY7MYTH2Q7R`）。

---

## 0　缺口：worker 产出停在 `board:agent-runs`，没人搬进研究板

**实测**（`src/dispatch.ts:1450-1470` + `src/agent-bus.ts:31`）：
`agent-run` 在 worker 退出后**自己**校验并发布 `worker.result.v1`，
目标是 `BUS_CHANNEL = "board:agent-runs"`，幂等键 `agent-run:<run_id>:result`。

⇒ **原料已经在总线上、按 `run_id` 索引**，且落在引擎（A8b `readAgentRuns`）**已经在分页读的那个 channel** 上。

但研究需要的是：
- `research.evidence.v2` 发到**证据 channel**
- 新线索发到**板**（`spec §1` 图注：**板的唯一写者 = 调度器**）

**这一步转换与回写无人负责。** `spec.md §3.2` 的 tick 七步里**没有收割步**，
而第 5 步却直接读 evidence 算 coverage —— **本包补上这一步。**

---

## 1　交付：tick 的收割步

位置：**回收步（第 2 步）之内**，`exited(exit_code=0) → CAS 到 explored` **之前**。

对每张 `status=in_flight` 且其 `run_id` 在 `board:agent-runs` 上有 `exited(exit_code=0)` 的卡：

```
1. 按 run_id 找该 run 的 worker.result.v1
2. 逐条 evidence → research.evidence.v2 → 发到证据 channel
3. 逐条 proposed_clue → research.clue.v2(status=proposed) → 发到板
4. 全部发完之后，才 CAS 该卡 → explored
```

### 1.1 ⛔ 次序不可颠倒：先发完，才 CAS

⛔ **CAS 到 `explored` 必须是最后一步。** 中途崩溃 ⇒ 卡仍是 `in_flight`
⇒ 下一 tick 重新收割（幂等键保证不重复）。
**若先 CAS 再发，崩溃即永久丢失该 run 的全部证据**，而 bus 无 DELETE、无法补救。

### 1.2 ⛔ 幂等键必须让重放安全

- evidence：`dr-evidence:<run_id>:<index>`
- 新 clue：`dr-clue:<run_id>:<index>`

实测幂等语义：同键 + **相同** payload ⇒ 200 `deduplicated:true`；
同键 + **不同** payload ⇒ **409 `IDEMPOTENCY_CONFLICT`**（响的，不是哑的）。
⇒ index 必须是**产物内的稳定序号**，不得用时间戳/随机数。

### 1.3 evidence 的映射（确定性）

`research.evidence.v2` 的注册 schema 实测为
`required: [clue_id, anchor, quote, claim]`、`additionalProperties: true`、`entity_role: leaf`。

```
clue_id ← 卡的 entity_id（引擎已知，worker 不产出）
anchor  ← <source>://<locator>@<revision>#<range>      (spec §5.2；range 缺省时省略 #段)
quote   ← evidence.quote
claim   ← evidence.claim
```

⚠️ 该映射的**纯函数版本 R1b 已在 `agent-runtime` 的 `src/worker-evidence.ts` 写好并测过**
（`composeAnchor`，Q9/Q10 覆盖）。**它在另一个仓；本包照抄一份，不跨仓耦合。**

### 1.4 ⛔ 证据 channel 必须显式传入，无默认值、不得字符串推导

**实测真实 channel 命名并不遵循 `spec §2.6`：**

| 实际存在 | spec §2.6 说的 |
|---|---|
| `research:loop-mcp-semantics.index` / `.evidence` | `research:<topic>.board` / `.evidence` |
| `research:p02-smoke-1dce60`（**无任何后缀**） | — |

⇒ ⛔ **不得实现「把 `.board` 换成 `.evidence`」之类的推导**——在真实 channel 上会静默推不出来。
⇒ 沿用 A8b 纪律：**channel 无默认值，缺失即响亮报错。**

### 1.5 proposed_clue 的映射，以及本包主动丢弃的一个字段

`research.clue.v2` 实测 `required: [text, status, depth, sources]`。
而 worker 的 `proposed_clues.items` 只有 `{clue, reason}`。缺的三项由引擎补：

| 字段 | 取值 | 理由 |
|---|---|---|
| `text` | ← `clue` | — |
| `status` | `proposed` | 等 triage 裁 keep/drop（`spec §3.1`） |
| `depth` | 父卡 `depth + 1` | `spec §3.4` |
| `sources` | **继承父卡的 `sources`** | worker 不产出该字段；继承是唯一有依据的取值 |
| `parent` | 父卡 entity_id | `spec §3.1` |

⛔ **worker 的 `reason` 本包不落库**：`clue.v2` 的 `rationale` 注册描述是
**「dropped / blocked 的理由」**，用它装提案理由是语义挪用；而 `additionalProperties: true`
允许我塞自造字段——**但「允许塞」不是「该塞」**。

> **判据（本线自己记的）：一个字段若说不出具体的消费者与消费方式，它就不该存在。**
> `reason` 当前的潜在消费者是 triage，而 **triage 尚未实现（属 R2）**。
> ⇒ **本包不造这个字段**；R2 实现 triage 时若确需，届时**带着消费者一起加**。
> ⛔ 本条须写进 dev-notes，**不得沉默丢弃**。

### 1.6 ⛔ depth 与 maxClues 的边界

- `depth + 1 > maxDepth(3)` ⇒ 该新 clue 以 **`status: blocked`** 落库，
  `rationale` 填明「超过 maxDepth」（`spec §3.1` 状态图有该边）。
  ⛔ **不得静默丢弃**——静默丢弃会让「研究到底了」和「被截断了」同形。
- 板上 clue 总数已达 `maxClues(64)` ⇒ **不再新增 clue，但 evidence 照发**，
  并在结果里**显式报告被跳过的条数**（⛔ 无声截断 = 假装覆盖完整）。

### 1.7 ⛔ 写入预算：宁可整卡留到下一 tick，也不半发

evidence + 新 clue 的发布**均计入 `--max-writes`**。

⛔ **若剩余预算不足以发完某一张卡的全部产物，则本 tick 跳过该卡整体**
（不发、不 CAS，留在 `in_flight`），并**响亮报告**跳过了哪张卡、还差多少预算。
⇒ 配合 §1.1 的「CAS 最后」与 §1.2 的幂等键，重放安全。

---

## 2　⛔ 写入不可回退

agent-bus **append-only、无 DELETE**。⛔ v1 冻结 channel 拒写
（`research:loop-mcp-semantics.*`、`research:smoke-bus-semantics.*`）。
⛔ **本包不做真机 `--run`**（理由见 §5）。

---

## 3　硬验收（逐条可机械核验）

> **本表已逐条比对 spec 全文的每个 ⛔ 与限定词，含 §0/§1/§2/§5/§6。**

| # | 断言 | 怎么验 |
|---|---|---|
| **H1** | ⛔ exited(0) 且有 `worker.result.v1` ⇒ 每条 evidence 各发出一条 `research.evidence.v2` | 打桩 HTTP，断言 publish 次数与 kind |
| **H2** | ⛔ 发出的 payload **四个必填字段齐全且非空** | 断言 `clue_id`/`anchor`/`quote`/`claim` |
| **H3** | ⛔ `anchor` 形如 `<source>://<locator>@<revision>#<range>` | 断言含 `://` 与 `@`；有 range 时含 `#` |
| **H4** | ⛔ `range` 缺省时 anchor **不带 `#`**（不得留空 `#`） | 独立用例（**与 H3 分开**） |
| **H5** | ⛔ `clue_id` 取自**卡的 entity_id**，不是 worker 产出 | 构造 worker 产物里带一个假 `clue_id` ⇒ 断言发出的是卡的 id（**判别性**） |
| **H6** | ⛔ **CAS 到 explored 发生在所有 publish 之后** | 断言调用顺序（记录调用序列，断言最后一个是 CAS） |
| **H7** | ⛔ publish 中途抛错 ⇒ **不发生 CAS**，卡仍 `in_flight` | 打桩第 2 条 publish 抛错 ⇒ 断言零 CAS（安全性）；配 H6（活性） |
| **H8** | ⛔ 幂等键为 `dr-evidence:<run_id>:<index>` / `dr-clue:<run_id>:<index>` | 断言捕获到的 `idempotency_key` |
| **H9** | ⛔ 幂等键**不含时间戳/随机数**（同一输入两次运行产生相同键） | 跑两次断言键集合相等（**判别性**） |
| **H10** | ⛔ proposed_clue ⇒ `status=proposed`、`depth=父+1`、`sources` **继承父卡**、`parent`=父卡 id | 断言四项 |
| **H11** | ⛔ `depth+1 > maxDepth` ⇒ 该 clue **以 `blocked` 落库且 rationale 非空**，**不得静默丢弃** | 独立用例，断言确有一条 publish 且 status=blocked |
| **H12** | ⛔ 板上 clue 数达 `maxClues` ⇒ 不新增 clue，**但 evidence 照发**，且**结果显式报告跳过条数** | 断言 evidence publish 次数 > 0、clue publish 次数 = 0、结果字段含跳过数 |
| **H13** | ⛔ 预算不足以发完整张卡 ⇒ **该卡零 publish、零 CAS**，且**响亮报告** | 断言零写入 + 结果含该卡标识（**不得半发**） |
| **H14** | ⛔ 证据 channel **无默认值**，缺失即响亮报错 | 不传 ⇒ 抛错，**零网络请求** |
| **H15** | ⛔ **不得存在 `.board`→`.evidence` 之类的字符串推导** | `git grep` 断言无此推导；且 H14 已使其无处可用 |
| **H16** | ⛔ v1 冻结 channel 拒写、零请求 | 沿用既有用例 |
| **H17** | ⛔ **A8c 的 N1/N2 接线判别、A8d 的 P1/P2 仍成立** | 原用例仍在且仍通过 |
| **H18** | ⛔ `--selfcheck` 仍保留且仍无副作用 | exit 0 且零网络请求 |
| **H19** | ⛔ `reason` 未被落库、且该决定写进 dev-notes | 断言 payload 无 `reason`；grep dev-notes 命中该说明 |
| **H20** | ⛔ 不得触碰 `.dd-evidence/` | **actor 提交**文件面不含 |
| **H21** | typecheck + 全量测试 | 均 exit 0 |
| **H22** | ⛔ 既有用例**一条不删** | `git diff` 无 `it(`/`test(` 净减少 |
| **H23** | 证据写 `docs/dev-notes/<development_id>.md` | 存在；仓根**无** `IMPLEMENTATION_SUMMARY.md` |

---

## 4　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **U1** 把 CAS 挪到 publish 之前 | **H6 与 H7** |
| **U2** `clue_id` 改用 worker 产物里的值 | **H5** |
| **U3** 幂等键掺入 `Date.now()` | **H9** |
| **U4** 超 maxDepth 时静默丢弃而非 `blocked` | **H11** |
| **U5** 达 maxClues 时连 evidence 也不发 | **H12** |
| **U6** 预算不足时改为半发 | **H13** |
| **U7** 给证据 channel 加一个字符串推导的默认值 | **H14 与 H15** |
| **U8** anchor 在无 range 时仍拼一个空 `#` | **H4** |

> **只报「N/N 挂了」不算数。破坏后必须回显被改的那一行**，跑完逐字还原。
> ⚠️ **变异后的还原必须被验证**（`git diff --stat` 确认干净）——
> 本 gate 曾因命令超时把变异留在工作区，下一次「基线」带着变异跑。

### 4.1 ⚠️ 本线学费换来的十一条纪律

1. 打桩不得让两次读返回相同的值。
2. `describe` 块名**不得枚举多个判据 ID**（一个 describe 一个判据）。
3. **安全性断言必须配活性断言**（H7「不 CAS」配 H6「确实 CAS」）。
4. 凡本包必须实现的能力，验收行须对**纯数据 / 真实文件**求值。
5. 断言的作用域必须收窄到被测对象。
6. `a ?? b` 的 fallback 链，只变异 `b` 什么也证明不了。
7. **两个只差一项输入的用例，才构成判别性证据**（H5/H9 正是这条）。
8. ⛔ **一条不变量在某一层被守住，不构成它在别的层也被守住** ——
   **A8d 正因此被终审拒**：`agent-run` 解析失败在单元层响亮，而生产 `--run` 路径上被
   `runWrite` 的裸 `catch` 吞掉、exit 0。**本包凡「响亮失败」类判据（H13/H14），
   验收必须落在 `--run` 的生产路径上，不得只验单元层。**
9. ⛔ **凡「注入 dep」的验收，必须额外验证生产缺省路径注入的是真实现。**
10. ⛔ **无声截断 = 假装覆盖完整**（H12/H13 的报告要求）。
11. ⛔ **资源生命周期必须覆盖被拉起进程的存活期** ——
    **A8d 的 blocker 即此**：`--input` 临时文件在子进程仍在运行时就被 `finally` 删掉。
    本包若引入任何临时资源，**须证明它活得比消费者久**。

---

## 5　非目标

- ⛔ **不做真机 `--run`**：真机端到端属 **V1**，须在本包合入后、由 gate 统一发起。
- ⛔ 不实现 triage / synthesizer / debater（属 R2）
- ⛔ 不实现 `dr-worker-web`（`spec §4.3` 机制未定）
- ⛔ 不注册任何协议
- ⛔ 不改 `src/protocol.ts` 既有导出签名，确需新增则**新增**
- ⛔ **不得绕过 A8b 的 `realCas` 另写 CAS**
- 不实现 coverage / 终止判定（`spec §3.2` 第 5–7 步，属后续包）

---

## 6　⛔ 派发面硬约束

- `setup_commands` 含 `npm ci`（**本仓用 npm，有 `package-lock.json`**；agent-runtime 那个仓用 bun，别混）
- `.dd-evidence/` 是 dd 保留路径，**actor 任何提交碰它都是硬失败**（重试无用）。
  ⛔ 仓内属于别的 development 的陈旧 `acceptance.json` **是正常的**，随 H0 从 main 继承，
  **不是本包的问题、也不该由本包修**。**若 reviewer 就此提 finding，正确回应是说明不在 scope。**
- ⚠️ **若 reviewer 声称「这个环境里没有某文件」，可能是假阳性**（其 harness 文件系统视图与宿主不同）。
- ⛔ **测试不得触网**（不得连真实 bus / 真实 vault / 真实 MinerU）
- ⛔ **不得把任何真实 secret 值写进代码 / 测试 / dev-notes**

---

## 7　环境（均为实测）

- `worker.result.v1` 发布在 **`board:agent-runs`**，幂等键 `agent-run:<run_id>:result`，
  payload 为 worker 结构化产出 **加上 `run_id`**
- `research.evidence.v2` 注册在案：`required [clue_id, anchor, quote, claim]`、
  `additionalProperties: true`、`entity_role: leaf`
- `research.clue.v2` 注册在案：`required [text, status, depth, sources]`、`entity_role: root`
- ⛔ `GET /v1/channels/<id>/messages` 默认 `limit=100` 且返回**最早**的 ⇒ **必须分页**
  （A8b 的 `readAgentRuns` 已分页，复用它）
- 幂等语义：同键同 payload ⇒ 200 `deduplicated:true`；同键异 payload ⇒ **409**
