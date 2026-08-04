# A8b —— tick 写侧：真实 `runs` + CAS 认领/回收（**不含 spawn**）

> 上游依据：`spec.md`(rev7) §3.1 / §3.2 第 2–3 步；`golden-order.md`（bus 为 SSoT）。
> 前置已合入 main：链 A 七包 + **A8a**（`src/tick-inspect.ts` 的 `--inspect` 只读模式）。

---

## 0　本包为什么存在（A8a gate 披露的缺口）

A8a 的 `src/tick-inspect.ts` 把 **`runs: {}` 硬编码为空**。

后果：回收步在空 `runs` 下，**每一张 `in_flight` 卡都必然被判成
「无对应 `agent.run.started` → 回收」**——**对任何输入都给同样的输出，判别力为零**。

A8a 只读，所以只是输出误导。**但把它带进写侧是破坏性的**：
会**CAS 掉真正在飞的卡、抹掉活 worker 的认领**。

> **判据（A8a gate 已记）：一个恒定输出不能被读成验证。**
> 本包的核心就是给这段逻辑**制造可区分的输入**。

---

## 1　交付

### 1.1 真实 `runs`：分页读 `board:agent-runs`

`decideTick` 的 `BoardState.runs` 必须由**真实读取**填充，不得硬编码。

- 分页读 `board:agent-runs`（`after_seq` 翻到取空——默认 `limit=100` 且返回**最早** 100 条）
- 识别 `agent.run.started.*` / `agent.run.exited.*`，按 `run_id` 归集
- ⛔ **`run_id` 关联回 clue 的方式**：P0.5 探针已确认
  **`agent.run.*` 不带能关联回 clue 的字段** ⇒ 退路是**引擎在 CAS 时把 `run_id` 写进卡**
  （`clue.v2` 已有 `run_id` 字段）。本包按该退路：**以卡上的 `run_id` 去 runs 表里查**。

### 1.2 写侧执行：CAS 认领与回收

新增 `--run <clue_channel>` 模式，执行 `spec.md §3.2` 第 2–3 步的**写动作**：

| 决策 | 执行 |
|---|---|
| `reclaim` | CAS 该卡到目标 status（`open` / `explored` / `blocked`） |
| `dispatch` | CAS `open → in_flight` 并**把 `run_id` 写进卡** |
| `block` | CAS 到 `blocked` |

⛔ **本包不 spawn**：`dispatch` 决策在 CAS 成功后**只记录待 spawn**，
**spawn 的实际执行属 A8c**（依赖链 C 的 role 存在）。
⇒ 因此 `--run` 必须接受一个**注入的 spawn dep**，本包传入一个**显式的 no-op 并记录**，
**不得假装 spawn 成功**。

⛔ **CAS 顺序不变**（S2 已守）：**先 CAS 成功、才算认领**；CAS 失败（409）**跳过该卡**。

---

## 2　⛔ 写入是不可回退的

agent-bus **append-only、无 DELETE 路由**。本线曾写进 5.3MB 清不掉的垃圾。

- ⛔ `--run` **只允许对显式传入的 channel 操作**，不得有默认值
- ⛔ **单次运行的写入上限必须可配置且默认很小**（建议 `--max-writes`，默认 **5**），
  超限**立即停止并响亮报错**
- ⛔ **真机验证只允许在测试 channel 上做**：`research:p02-smoke-1dce60`
- ⛔ **不得触碰** `research:loop-mcp-semantics.*` / `research:smoke-bus-semantics.*`
  （**v1 冻结只读**，`spec.md §8`）

---

## 3　硬验收（逐条可机械核验）

> **本表已逐条比对 spec 全文的每个 ⛔ 与限定词，含 §0/§1/§2/§6/§7。**
> 本线**三次**因「限定词只在正文、没进验收表」被拒；第三次那条藏在「环境」节。

| # | 断言 | 怎么验 |
|---|---|---|
| **M1** | ⛔ **判别性**：同一张 `in_flight` 卡，**有** 对应 `agent.run.started` ⇒ **不产生 reclaim 决策** | 纯数据：卡 `run_id="r1"` + runs 含 `r1: {started:true}` ⇒ 决策里无该卡的 reclaim |
| **M2** | ⛔ **判别性**：**无**对应 started ⇒ **产生 reclaim 到 `open`** | 同上但 runs 为 `{}` ⇒ 有该卡 reclaim→open。**M1 与 M2 的输入必须只差 runs 一项** |
| **M3** | `exited` 且 `exit_code === 0` ⇒ reclaim 到 `explored` | 纯数据 |
| **M4** | `exited` 且 `exit_code !== 0`、重试 < 2 ⇒ 回 `open` 且重试 +1 | 纯数据 |
| **M5** | `exited` 且 `exit_code !== 0`、重试 = 2 ⇒ `blocked` | 纯数据 |
| **M6** | ⛔ `runs` **由分页读取填充**，非硬编码 | 打桩三页 100/20/0 ⇒ 3 次读取，第 2/3 次带 `after_seq=`；且 `grep` 源码中 **无 `runs: {}` 字面量**用于生产路径 |
| **M7** | ⛔ `dispatch` CAS 成功时**把 `run_id` 写进卡** | 捕获 publish body，断言 payload 含非空 `run_id` |
| **M8** | ⛔ CAS 失败（409）⇒ **跳过该卡**，不重试、不 spawn | 打桩 CAS 返回 conflict ⇒ 该卡无后续动作 |
| **M9** | ⛔ **本包不 spawn**：注入的 spawn dep 是 no-op 且被记录 | 断言 spawn dep 调用次数 === 0，且返回结构里有「待 spawn」记录（**安全性+活性配对**） |
| **M10** | ⛔ `--max-writes` 生效，默认 **5** | 构造 7 个写决策 ⇒ 第 6 个起被拒且**响亮报错**（非静默截断） |
| **M11** | ⛔ channel **无默认值**，必须显式传 | 不传 channel ⇒ exit ≠ 0 并提示 |
| **M12** | ⛔ 拒绝对 v1 冻结 channel 写 | 传 `research:loop-mcp-semantics.index` ⇒ 拒绝并报错，**零请求发出** |
| **M13** | 真机验证：对 `research:p02-smoke-1dce60` 跑一次 `--run` | 跑前/跑后消息数写进 `docs/dev-notes/<development_id>.md`，**增量 ≤ 5** |
| **M14** | ⛔ 不得触碰 `.dd-evidence/` | `git diff --name-only <base>..HEAD -- .dd-evidence/` **为空** |
| **M15** | typecheck + 全量测试 | 均 exit 0 |
| **M16** | 既有 152 条用例**一行未删** | `git diff` 中既有测试文件无 `it(` 净减少 |

---

## 4　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **X1** `runs` 改回硬编码 `{}` | **M1**（M2 仍会过——**这正是本包存在的理由**） |
| **X2** 去掉分页（只读第一页） | **M6** |
| **X3** `dispatch` 时不写 `run_id` 进卡 | **M7** |
| **X4** CAS 失败时不跳过、继续动作 | **M8** |
| **X5** 去掉 `--max-writes` 上限 | **M10** |
| **X6** 允许对 v1 channel 写 | **M12** |

> ⚠️ **X1 是本包的核心判据**：A8a 的实现在 X1 下**所有断言都通过**，
> 本包必须让 **M1 挂掉**。若 X1 杀不到 M1，本包等于没做。
>
> **只报「N/N 挂了」不算数。** 本线曾第一次变异跑出 10/10 差点签字，
> 去看挂的是哪几条才发现核心那条断言全程存活。
> **破坏后必须回显被改的那一行**，跑完逐字还原。

### 4.1 ⚠️ 本线学费换来的七条纪律

1. **打桩不得让两次读返回相同的值**——否则「读一次」与「读两次」观测相同。**M6 尤其注意**。
2. **`describe` 块名不得枚举多个判据 ID**——会让自动归因跨断言误配，产生假阳性 ✓。
   **一个 describe 一个判据。**
3. **安全性断言必须配活性断言**——「不发生坏事」可被「什么都不做」满足（见 M9）。
4. **凡本包必须实现的能力，验收行须对纯数据求值**——依赖注入会让核心逻辑
   **可以不存在而测试全绿**。M1–M5 即为此设。
5. **断言的作用域必须收窄到被测对象**——观测面比被测面大，会有别的来源替它满足断言。
6. **断言里有 fallback 链（`a ?? b`）时，只变异 `b` 什么也证明不了。**
7. ⛔ **两个只差一项输入的用例，才构成判别性证据**（M1/M2 必须只差 `runs`）。

---

## 5　⛔ 派发面硬约束

`.dd-evidence/` 是 dd 保留路径，**任何提交碰它都是硬失败**
（`attempt_controller.py:892-914`，**重试无用**）。
⛔ 仓内属于别的 development 的陈旧 `acceptance.json` **是正常的**，随 H0 从 main 继承，
**不是本包的问题、也不该由本包修**——dd 会在本包 acceptance 阶段自己生成新证据，**会自行消解**。
**若 reviewer 就此提 finding，正确回应是说明不在 scope，而不是去动那个文件。**

运行证据写 `docs/dev-notes/<development_id>.md`；⛔ 不得复用仓根 `IMPLEMENTATION_SUMMARY.md`。

---

## 6　非目标

- ⛔ **不实现 spawn**（属 A8c，依赖链 C 的 role）
- 不做覆盖度/终止的写侧动作（S3 已算，本包不改）
- 不做生成阶段编排（S4 已交付）
- 不把 tick 节点模板从 `--selfcheck` 切过来（属 A8c）
- **不改** `src/protocol.ts`；不改既有导出签名，确需新增则**新增**

---

## 7　环境

- `setup_commands` 含 `npm ci`（**本仓用 npm，有 `package-lock.json`**；
  ⚠️ 注意 `agent-runtime` 那个仓用 bun，别混）
- agent-bus `http://127.0.0.1:7490`，Bearer，token 在 `/data/agent-bus/tokens/`
- ⛔ `GET /v1/channels/<id>/messages` 默认 `limit=100` 且返回**最早** 100 条 ⇒ **必须分页**
- `research:content` channel **已于 2026-08-05 建立**（fanout/public，当前 0 条）
- 测试 channel `research:p02-smoke-1dce60` 当前 **5 条**
