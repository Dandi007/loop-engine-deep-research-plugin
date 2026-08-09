# G6 —— 结果等待预算 30 秒，而真实 agent 要 43–390 秒：两条生产路径都会超时失败

> 派发方：`line-deep-research`。前置：G5 已合入 main `0b619e8`。
> **这是 Phase 6 真跑实测出的生产缺陷，数值全部取自生产 bus，非估计。**

---

## 0　实测数据（生产 `board:agent-runs`，2026-08-09 19:35Z–22:05Z）

把每条结果消息与同 `run_id` 的 `agent.run.started.*` 配对，得到**真实端到端耗时**：

| agent 类 | 样本 | 最小 | 中位 | 最大 |
|---|---|---|---|---|
| **`dr-triage`**（`dr-triage.result.v1`） | **37** | **43s** | **175s** | **390s** |
| **`dr-worker-code-local`**（`worker.result.v1`） | **5** | **160s** | **207s** | **258s** |

**而现行等待预算是 30 次 × 1 秒 = 30 秒** —— **低于观测到的最小值（43s）。**

生产实证（G5 合入后手工跑一次 tick，逐字）：

```
G5: timed out waiting for triage result for run 32ba1229-baa1-4614-870f-9b2f6f9da94f
    — no dr-triage.result.v1 found on board:agent-runs after 30 retries
```

⇒ G5 的响亮失败**工作正常**（这是进步：此前是静默丢弃）。**但预算本身是错的，研究仍无法推进。**

### ⛔ 同一预算也用在生成段，且生成段更慢

`src/tick-run.ts` 的生成段 `readBody`（G4c(v2) 交付）用的是**同一形状的 30 × 1s**。
debater / synthesizer 是与 triage 同量级或更慢的 LLM 调用
⇒ **生成段会以完全相同的方式超时**，plan §0 的产物 1（report）与 2（导出件）仍然产不出。
**本包必须同时修这两条路径**，只修 triage 等于把同一个坑留给下一次真跑。

---

## 1　要做什么

把两处结果等待改成**按时间预算**（而非写死的重试次数），并可由部署方覆盖：

| 键 | 语义 | 缺省 |
|---|---|---|
| `AGENT_RESULT_TIMEOUT_MS` | 等待 `dr-triage.result.v1` / `dr-doc.result.v1` 出现在 `board:agent-runs` 的总预算 | **900000（15 分钟）** |
| `AGENT_RESULT_POLL_MS` | 轮询间隔 | **3000（3 秒）** |

**缺省取值的依据（必须在 dev-note 复述）**：观测最大值 390s；900s ≈ **2.3×** 最大值，
且覆盖 triage 与 worker 两个分布的全部样本。轮询 1s 在 15 分钟预算下会产生 900 次无谓请求，3s 足够。

⛔ **不得**把预算写死成另一个魔数就完事：**必须可由部署方覆盖**，因为不同档位的模型耗时差一个数量级
（本线实测 pro 档 implement 墙钟 355–667s，flash 档曾因 429 风暴到 1896s）。

⛔ **超时仍必须响亮失败并点名 runId**（G5 已交付的语义，不得削弱）。
⛔ **「读不到」与「真的返回空结果」必须继续可区分**（G5 的 P3，不得回退）。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **R1** | ⭐ **两条路径都用新预算**：triage 的 `readResult` **与** 生成段的 `readBody` 都按 `AGENT_RESULT_TIMEOUT_MS` / `AGENT_RESULT_POLL_MS` 等待 | 分别断言；⛔ 只改 triage 不算完成 |
| **R2** | ⛔ **可覆盖**：设 `AGENT_RESULT_TIMEOUT_MS` 为一个极小值 ⇒ 等待很快超时；不设 ⇒ 用 900000 缺省 | 正反两例，**打在生产组装出的 deps 上** |
| **R3** | ⛔ **超时仍响亮并点名 runId**（G5 语义保留） | 判别性用例 |
| **R4** | ⛔ **空结果 ≠ 读不到**（G5 的 P3 保留且仍有效） | 判别性用例 |
| **R5** | ⛔ **不得靠真实等待把用例拖慢**：用例必须注入可控时钟/间隔（或用极小的 `AGENT_RESULT_POLL_MS`），全量测试时长不得显著增加 | 贴测试总时长；基线约 17s |
| **R6** | ⛔ **断言打在生产组装出的 deps 上**（`runChannelWrite` 在注入分支下跳过生产装配；⛔ 自建 runtime 注入的用例不算数；⛔ 源码字符串匹配一律不构成证据） | 照 G5 已交付的 P6 做法 |
| **R7** | 全量 `npx vitest run` **在干净环境下真绿**（`ANCHOR_CHECK_BIN`/`DOC_CHANNEL`/`RESEARCH_ORIGIN`/`EXPORT_ROOT`/`AGENT_RESULT_*` 均未设置）。基线：main `0b619e8` 实测 **26 files / 472 tests**，终值两项均不得低于基线 | ⛔ **必须实跑并贴完整尾部输出** |
| **R8** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **R9** | 每处删除给出必要性说明 | — |

---

## 3　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **S1** | 生成段 `readBody` 保留 30×1s（只改 triage） | **R1 的生成段那条必须挂** |
| **S2** | 忽略 `AGENT_RESULT_TIMEOUT_MS`，恒用缺省 | **R2 必须挂** |
| **S3** | 超时返回 `[]`/`null` 而非抛错 | **R3 必须挂** |
| **S4** | 把「结果为空数组」也当成读不到继续等 | **R4 必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 4　⛔ 前几包实付的学费（直接照用）

1. **测试必须驱动生产组装**；⛔ **源码字符串匹配一律不构成证据**。
2. **变异矩阵各行必须是实测**：若某行杀不掉，如实写「未被杀」并说明，⛔ **不得编造失败现象**
   （本线已两次出现 dev-note 报告结构上不可能发生的击杀，均被评审逐条推翻）。
3. **dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit**，**不是 H0 提交**；
   ⛔ 不要为对齐 hash 做额外提交；⛔ 不得用「基线计数方式差异」解释测试数缺口。
4. **贴测试证据要贴完整尾部**（`Test Files` / `Tests` 两行 + 有无 FAIL 段），不得只贴计数或只写结论。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 改 G5 的 `readTriageResult` / 响亮失败语义 | 已交付且被断言保护；本包只改**等待预算**与**可配置性** |
| 改 worker 收割路径 | 生产实测正常 |
| 改 `profiles/deploy/*.env`（含 `AGENT_RESULT_*` 取值） | 归部署方；本包只保证**缺省合理且可覆盖** |
| 改模型档位 | 已拍死在 golden-order |
| 注册任何 bus 协议 | 已完成 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 6　交付物落点

- 实现：`src/tick-run.ts`（triage `readResult` + 生成段 `readBody` 的等待预算与可配置性）
- 测试：`test/g6-result-timeout.test.ts`（R1–R6）
- 证据：`docs/dev-notes/dev_ledr_g6_result_timeout_01.md`（R1–R9 逐条 + §3 变异四行**实测** + 还原证据 +
  **你采用的缺省值与依据**（须复述 §0 的实测分布）+ 全量测试时长对比）
