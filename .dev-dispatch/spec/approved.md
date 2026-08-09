# G4d —— anchor-check 确定性接线：核验率的来源自己必须是机械的

> 派发方：`line-deep-research`。前置：G4c(v2)（生成段接进生产）已合入 main `f286f0e`。

---

## ⛔ 先读：上一包（G4c(v2)）实付的学费，本包直接照用

**1. 测试必须驱动生产的 dep 组装，不能各自注入 stub。**
`runChannelWrite` 在 `opts.generateDeps` 存在时走注入分支、**完全跳过 `assembleGenerateDeps`**。
上一包因此连续三轮出现「验收项看着有、变异杀不掉」（U1/U5/U7 全中此病）。
**已交付的正确机制：`assembleGenerateDeps` 现在是导出函数**（`src/tick-run.ts`），
用例可直接调用它拿到**生产组装出的 deps** 再断言。⛔ 本包凡涉及生产 dep 的验收项，一律照此写。

**2. `workflow.yaml` 新增的可选 pipeline input 必须带 `?`。**
上一包死于 `doc_channel: "{{doc_channel}}"` 缺 `?`：值为空时模板按必填渲染 ⇒ tick 节点报错，
而 loop 照报 `drained`、exit 0。既有正确写法：`"{{evidence_channel?}}"` / `"{{allowed_root?}}"`。
**验收必须在相关 env 均未设置的干净环境下跑全量。**

**3. 继承的未决缺口（本包一并补上）**：
`spawnExport` 里「回读不到 doc message ⇒ 响亮失败」这条支路**没有任何用例**；
而原 U6 用例是对 `src/export.ts` 做源码字符串匹配（**查错了文件**，风险在 `tick-run.ts`），属零功率。
⇒ 本包须补一条**判别性**用例：驱动生产 `spawnExport`，令 doc channel 里**不存在**该 `sourceMessageId`，
断言**响亮失败**且不落回系统时钟。**⛔ 不得用源码字符串匹配充当该断言。**

---

## 0　现状：两处

### 0.1 `spawnAnchorCheck` 被建模成 **agent route**，这是占位残留

`src/generate.ts:36/48`：
```ts
anchorCheckRoute: string;
// DEFAULT_GENERATE_CONFIG
anchorCheckRoute: "anchor-check",
```
G2a 把 debater/synthesizer 的占位 route 换成了真实 route，**唯独这一条没换** —— 因为它根本不该是 route。

> ### ⛔ 判据：**拿 LLM route 去跑一个确定性校验器，等于把「机械核验」换成「模型说它核验了」。**
> 而**核验率是软闸门的判据来源**（`golden-order` 2026-08-09 拍板：核验率 < 90% ⇒ V2 验收判不过）。
> **一个判据的来源，自己必须是机械的。**

### 0.2 校验器本体不在本仓

`anchor-check.py`（v3，N2b 已迭代）目前在 katana 仓
`plugins/deep-research/skills/deep-research/loop-orchestration/tools/`，
同目录还有 `anchor-check-selftest.sh` 与 `fixtures/`。
而**唯一的消费者**是本仓 `src/generate.ts:418`。

⇒ **居所随消费者走**：本包把三者引入本仓 `tools/`（派发方 2026-08-09 拍板；plan §6 写的旧居所是「katana workflow 还是消费者」时定的，前提已变）。
⛔ katana 侧的删除**不在本包**（归 R4，不同仓）。

---

## 1　校验器的真实接口（读过源码，别照文档猜）

```
anchor-check.py --corpus <json 文件|bus:<channel>> [--repo-root <path>] --json
```

`--json` 输出（`anchor-check.py:199-209` 逐字）：
```jsonc
{ "total": N, "current_parsed": N, "current_verified_hit": N, "current_failed": N,
  "old_format": N, "unparseable": N, "discarded": N, "sums_ok": bool,
  "loud_failures": [ {"anchor": …, "error": …} ] }
```

⚠️ **它不输出 `verificationRate`** —— 而 `GenerateDeps.spawnAnchorCheck` 要求返回
`{ defects: number, verificationRate: number }`。**这个换算由本包定义，且必须按 §2 的口径。**

其它已读到的事实：
- `--repo-root` 对**现行格式**锚点是必需的（locator 是仓内相对路径，不含仓名）；缺失时校验器**响亮失败，绝不猜**。引擎侧已有 `ALLOWED_ROOT`（`--allowed-root` 已贯通），用它。
- `sums_ok` 为 `false` 表示**发生了无声丢弃**（`discarded > 0` 或三类计数之和对不上）。

---

## 2　⛔ 核验率的口径（本包最重要的一条判断）

**`verificationRate = current_verified_hit / total`。**

⛔ **分母必须是 `total`，不得用 `current_parsed`。**

> **理由**：若分母取 `current_parsed`（只算「能解析的那些」），那么一份 90% 锚点不可解析、
> 剩下 10% 全部命中的证据集，会报出 **100% 核验率**。
> **分母偷偷变小 = 软闸门被架空**，而软闸门正是 V2 验收的硬判据。
> ⇒ 不可解析、旧格式、被丢弃的锚点**全部计入分母**：它们就是「没核验成」。

**`defects = current_failed + unparseable + old_format + discarded + len(loud_failures)`**
（即 `total - current_verified_hit` 再加上 loud_failures 的重复计入部分 —— **实现方按上式直算即可，但必须在 dev-note 里写明你采用的表达式**）。

**⛔ `total === 0` 时不得报 100%**：没有锚点可核验**不是「全部核验通过」**。
此时核验率应为 **`null`（unavailable）**，与「崩溃」走同一条既有路径（`generate.ts:414-421` 的 catch ⇒ 头部标 `unavailable`）。
> 与 R2a 那次「`decisions: []` 通过 schema 校验」是同一个错的形状：**空集合不是成功。**

**⛔ `sums_ok === false` 必须响亮**：发生无声丢弃时不得把它折算进一个看起来正常的核验率，
应视同校验失败（核验率 `null` + 在报告与落盘件里点名 `sums_ok=false`）。

---

## 3　要做什么

1. **引入校验器**：`tools/anchor-check.py`、`tools/anchor-check-selftest.sh`、`tools/fixtures/`（三者一并，selftest 是它自己的有牙回归，别只搬主文件）。
2. **`spawnAnchorCheck` 改成确定性子进程调用**：
   - 把引擎已读到的 evidences（`readEvidences` 的结果）序列化成临时 JSON → `--corpus <file>`；
   - `--repo-root` 用 `ALLOWED_ROOT`；`--json` 取结构化输出；临时文件在 `finally` 清理。
   - ⛔ **不得**再经 `agent-run` / route 派发。`GenerateConfig` 的 `anchorCheckRoute` 字段随之移除或改名为不含「route」语义的形状（**实现方可选，但不得留一个没有消费者的 route 字段**）。
3. **报告落盘**（plan §0 产物 3）：把 `--json` 的完整输出写到导出件同目录
   `<EXPORT_ROOT>/DeepThought/<主题-slug>/`，文件名可判别（如 `anchor-check.json`）。
   ⛔ 落盘失败**不得**阻断导出（软闸门语义），但必须在报告头部或落盘件里可见。
4. **报告头部**沿用既有 `renderReportHead(marker, anchorRate)`（`generate.ts:116`），不重造。

---

## 4　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **V1** | ⛔ **不再经 route/agent-run**：生产路径 grep 无 `anchorCheckRoute` 的派发消费者；`spawnAnchorCheck` 实现是子进程调用 `tools/anchor-check.py` | 读代码到行号 + 假 spawn 记 argv，断言 argv[0] 指向 `tools/anchor-check.py` 且带 `--json` |
| **V2** | ⭐ **核验率口径**：分母是 `total`。判别性用例：构造 `total=10 / current_parsed=1 / current_verified_hit=1`（9 条不可解析）⇒ 核验率**必须是 10%，不得是 100%** | 这条是 §2 的唯一执行点，⛔ 杀不掉即判零功率 |
| **V3** | ⛔ **`total===0` ⇒ 核验率 `null`（unavailable），不得是 100%** | 判别性用例 |
| **V4** | ⛔ **`sums_ok===false` ⇒ 视同失败**（核验率 `null` + 可见地点名），不得折算成正常数字 | 判别性用例 |
| **V5** | ⛔ **软闸门不变**：核验率 < 90% **仍然导出**，但必须标在报告头部；校验器崩溃 ⇒ 头部 `unavailable`（与真实 0% 可区分） | 正反两例（<90% 与 ≥90%）+ 崩溃一例 |
| **V6** | **落盘**：`anchor-check` 的 `--json` 全文写到导出件同目录；落盘失败不阻断导出 | 正反两例 |
| **V7** | ⛔ **`--repo-root` 真的被传**（用 `ALLOWED_ROOT`）；缺失时校验器自己响亮失败的行为未被吞掉 | 假 spawn 记 argv + 一例失败传播 |
| **V8** | **校验器自带的 selftest 可跑且通过**：`tools/anchor-check-selftest.sh` exit 0 | 贴输出。⛔ 只搬主文件不搬 selftest 与 fixtures 不算完成 |
| **V9** | 全量 `npx vitest run` 全绿，文件数/用例数不少于**基线（以 G4c 合入后的 main 实测为准，自己先跑一次记下来）** | 贴输出 |
| **V10** | 变异矩阵（§5）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **V11** | `src/`、`test/` 的每处删除给出必要性说明 | — |

---

## 5　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **W1** | 把核验率分母从 `total` 改成 `current_parsed` | **V2 必须挂**；⛔ 杀不掉即判 V2 零功率 |
| **W2** | 让 `total===0` 返回 `verificationRate: 1`（100%） | **V3 必须挂** |
| **W3** | 忽略 `sums_ok`，照常折算核验率 | **V4 必须挂** |
| **W4** | 不传 `--repo-root` | **V7 必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 6　显式不做

| 不做 | 理由 |
|---|---|
| 删 katana 侧的 `loop-orchestration/tools/` | 不同仓，归 **R4** |
| 改 `anchor-check.py` 的校验算法 | 它是 v3、已有 selftest；本包只搬运 + 接线 + 定义换算口径。**若发现算法缺陷，停下在 review 说明，不顺手改** |
| 播种入口 | 归 **G4e** |
| 改 `profiles/deploy/*.env` 的题目与 channel 取值 | 归 **D2** |
| 注册任何 bus 协议 | 不可逆，走公示流程 |
| 端到端真跑真 bus | 归 Phase 6 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 7　交付物落点

- 引入：`tools/anchor-check.py`、`tools/anchor-check-selftest.sh`、`tools/fixtures/`
- 实现：`src/generate.ts`（dep 形状 + 核验率换算）、`src/tick-run.ts`（deps 组装，若需要）
- 测试：`test/g4d-anchor-check.test.ts`（V1–V7）
- 证据：`docs/dev-notes/dev_ledr_g4d_anchor_check_01.md`（V1–V11 逐条 + §5 变异四行 + selftest 输出 + **你采用的 defects 表达式**）

> **dev-note 的 `input_commit` 记本次 implement attempt 的 input_commit**（该字段本来的语义）。
> 真正的要求是**正文描述交付物本身**；若中途 rework 改了实现，正文数字与结论同步更新。
> ⛔ **不要为对齐 commit hash 做额外提交。**
