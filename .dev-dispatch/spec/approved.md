# G4a(v2) —— `--question` 生产贯通：第五次「组件支持、生产不传」

> 派发方：`line-deep-research`（deep-research V2 收尾线）。**这是一个已核实的生产接线缺陷，不是加功能。**
> 前置已合入 main `501db99`。
>
> ⚠️ **这是重开包。上一个 development（`dev_ledr_g4a_question_wiring_01`，PR #33）被派发方主动取消，
> 原因是我在 spec 里写了一条自指、逻辑上不可满足的要求，导致无限 rework。功能实现当时已被评审判定正确。
> 详见 §6 —— 那一节写明了「上一轮已被验证正确的做法」，请照它做，别重新发明。**

---

## 0　已核实的现状（全部 grep 到行号，不是推断）

| 位置 | 事实 |
|---|---|
| `src/tick-run.ts:1279` | `parseRunCliArgs` **确实解析** `--question` |
| `src/tick-entry.ts:41,50` | usage 里**确实写了** `--question <研究主问题>` |
| `src/tick-run.ts:674-678` | triage 分支：`deps.readQuestion` 不存在 ⇒ **抛 `MissingTriageQuestionError`** |
| `workflows/deep-research/tick/templates/tick.md:26,28,30,32` | **四个分支一个都没带 `--question`** |
| `bin/deep-research-loop.sh` | `grep -n question` **零命中** |
| `workflows/deep-research/fleet.yaml.tpl` | `grep -n question` **零命中** |

⇒ **CLI 支持它、引擎依赖它、生产从不传它。**

### 后果：收集段会在第一个 triage 决策上响亮失败

`tick-run.ts:242` 的错误消息原文：
> `G2b: triage decision present but no question source wired (provide readQuestion / --question). Refusing to dispatch a triage with an empty question.`

⚠️ **G2b 把响亮失败做对了**（不静默用空 question 派发），但它意味着
**V2 端到端一旦跑到 triage 就停**。本包是 Phase 6 的必要前置。

---

## 1　要做什么

**把「研究主问题」从部署配置一路贯通到 `tick-entry --run --question`。**

```
bin/deep-research-loop.sh  (export)
  → workflows/deep-research/fleet.yaml.tpl  (pipeline input 占位符)
    → workflows/deep-research/tick/workflow.yaml  (payload)
      → workflows/deep-research/tick/templates/tick.md  ({{…}} 变量)
        → "$tick_entry" --run <channel> … --question "<研究主问题>"
```

`MAX_WRITES` 已经走通同一条链（`bin:101`、`fleet.yaml.tpl:12`、`tick.md:19`、`tick.md:26/28/30/32`）——**读它们，照它们的形状接。**

### 1.1 ⛔ 无内置缺省，未配置即响亮失败

与 `TICK_CHANNEL`（D1 已确立）、`EVIDENCE_CHANNEL`（设计如此）对齐：
**研究主问题不得有内置缺省值**，未由 profile 或显式 env 提供 ⇒ **响亮失败拒绝启动**，理由写进错误消息。

> **判据**：一个编出来的缺省问题会让整场研究跑偏，而 bus 写入 append-only 不可回退。
> ⛔ **尤其不得**从 channel 名、topic slug 或任何其它字段**推导**出问题字符串。

### 1.2 ⛔ 不得把 `tick.md` 的分支数再翻一倍

`tick.md:25-33` 现在是 `evidence_channel × allowed_root` 的 **4 分支组合树**，再加一个可选参数会变 8，下一个变 16。
⇒ **改成增量拼 argv**（数组累加后一次调用）。
⚠️ `set -euo pipefail` 下注意数组展开与空值；**`run_output` 的捕获与后续 `hasPendingWork` 判定逐字不变**（A9 续投逻辑，本包不碰）。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **Q1** | 从生产入口渲染：只设 profile/env、跑 `--dry-run`，fleet 的 tick pipeline input 里**有 question 字段且等于配置值** | 解析渲染出的 YAML |
| **Q2** | ⛔ **真正的贯通断言**：渲染出的 `tick.md` + **假 `tick-entry` 记录 argv**，断言 `--question` **及其值**真的出现在 argv 里 | 照 `test/a10c-writebudget.test.ts` 里 `--max-writes` 那条的做法。⛔ 只断言「fleet input 里有 question」**不算数**——那是 Q1，两者必须都有 |
| **Q3** | ⛔ **无内置缺省**：不设任何相关 env 且无 profile ⇒ **非零退出且错误消息点名该变量**；且**不得**出现被推导/编造的问题字符串 | 正反两例 |
| **Q4** | ⛔ **组合矩阵**：`evidence_channel` / `allowed_root` / `question` 三者「有/无」的**全部 8 种组合**下，argv 都只含该有的参数、不含不该有的 | 参数化用例；同时证明 §1.2 的重构没漏分支 |
| **Q5** | ⭐ **可达性判据说明**（不是额外用例）：证据必须是「从生产入口到达 `tick-entry`」，**「模块支持」「渲染里有值」都不构成可达性证据** | 见 Q2 |
| **Q6** | 全量 `npx vitest run` 全绿，文件数/用例数**不少于基线 19 / 348** | 贴输出 |
| **Q7** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **Q8** | `src/`、`test/`、`workflows/` 的每一处删除给出必要性说明（本包要重写 `tick.md` 的分支树，属必要） | — |

> ⭐ **本包的存在理由是 Q2**：`--question` 已被 CLI 解析、被 usage 记录、被引擎依赖，**唯独没有人传它**。
> ⛔ 任何只验「CLI 支持」「input 里有值」的检查都复现不了这个缺陷。

---

## 3　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **P1** | 生产 `tick.md` 里去掉 `--question` 传参（其余不动） | **Q2 必须挂**；⛔ **Q1 应当仍绿** —— 这正是本包要证明的：Q1 单独存在时是零功率的 |
| **P2** | 给研究主问题编一个内置缺省值 | **Q3 的失败侧必须挂** |
| **P3** | 只在 `evidence_channel` 与 `allowed_root` 都有的那一支传 `--question`，其余支不传 | **Q4 必须挂**（「组合分支漏一支」的真实形态） |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 4　显式不做

| 不做 | 理由 |
|---|---|
| 终态贯通（生产 `--run` 计算 `decideTermination`、跨 tick 计数器） | 归 **G4b** |
| 接生成段（`decideGenerate` → `runGenerate`） | 归 **G4c** |
| 接导出 / anchor-check | 归 **G4d** |
| 播种入口 | 归 **G4e** |
| 改 `profiles/deploy/*.env` 的 channel 取值 | 归 **D2**（那两个 channel 当前在 bus 上不存在，由派发方处置）。本包**只加该变量的键** |
| 注册任何 bus 协议 | 不可逆，走公示流程 |
| 改 `agent-runtime` | 不同仓 |
| 动 A9 续投逻辑 / `hasPendingWork` 判定 | 本包只加一个参数的贯通，不碰控制流 |
| 端到端真跑真 bus | 归 Phase 6 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 5　⛔ 关于 dev-note 的要求（**上一轮我把这条写错了，以本节为准**）

**上一轮 spec 的原话**是「dev-note 的 `input_commit` 必须等于最终交付 commit」。
**这条要求是自指的、逻辑上不可满足**：note 本身就是交付 commit 的一部分，
note 里不可能记录包含它自己的那个 commit 的 hash。每更新一次 note 就产生一个新 commit，note 又「过期」。
上一轮 continuous review 据此连续 REJECT，而它自己的评语写着
「The functional wiring is correct and complete against §1/§2」。**这是我的 spec 缺陷，不是实现方的问题。**

**更正后的唯一判据**：

1. dev-note 的 `input_commit` 字段记录**本次 implement attempt 的 input_commit**（dd 交给你的那个）——
   这本来就是该字段的语义，**不要去追交付 commit**。
2. 真正要保证的是：**note 的正文描述交付物本身** —— 测试文件数/用例数、变异矩阵各行的实测结果、
   最终代码的行为，必须与最终交付一致。**若中途 rework 改了实现，note 正文的数字与结论必须同步更新。**
3. ⛔ **不要为对齐 commit hash 做任何额外提交。**

> 这条的来历：派发方在 D1 上实测到「note 停在 attempt 1，写 347 tests 而实际 348、变异按 14 用例测而实际 15、
> rework 修的四件事一个字没记」。**真正的病是「证据文档描述的不是交付物」，不是 hash 对不上。**

---

## 6　上一轮已被评审判定正确的做法（照做，别重新发明）

上一个 development 的实现被 continuous review 逐条确认「correct and complete against §1/§2」。
以下是它的形状，**请照此实现**（代码不在本 H0 里，需要你自己写）：

- **`bin/deep-research-loop.sh`**：在 `TICK_CHANNEL` 响亮失败块之后，加
  `export RESEARCH_QUESTION="${RESEARCH_QUESTION:-}"` + 空值响亮失败（exit 3，错误消息点名 `RESEARCH_QUESTION`
  并说明「编造或推导的缺省会让整场研究跑偏，且 bus 写入不可回退」）。
- **`fleet.yaml.tpl`**：pipeline input 加 `research_question: ${RESEARCH_QUESTION}`（与 `max_writes` 同级）。
- **`tick/workflow.yaml`**：把该字段接进 payload。
- **`tick.md`**：加 `research_question="{{research_question}}"`；把 4 分支组合树换成
  ```bash
  tick_args=("$tick_entry" --run "$tick_channel")
  [ -n "$evidence_channel" ] && tick_args+=(--evidence-channel "$evidence_channel")
  [ -n "$allowed_root" ]     && tick_args+=(--allowed-root "$allowed_root")
  tick_args+=(--max-writes "$max_writes")
  [ -n "$research_question" ] && tick_args+=(--question "$research_question")
  run_output="$("${tick_args[@]}")"
  ```
  ⚠️ 注意 `set -e` 下 `[ … ] && …` 作为**语句**在条件为假时返回非零会终止脚本 —— 上一轮用的是 `if` 块，**照 `if` 块写**。
- **`profiles/deploy/{production,local}.env`**：**只加该变量的键**，channel 取值一字不改。
- **`test/g4a-question-wiring.test.ts`**：Q1–Q4，其中 **Q2 用假 `tick-entry` 记 argv** 做可达性断言，
  并含 8 种组合的参数化矩阵。

---

## 7　交付物落点

- 实现：`bin/deep-research-loop.sh`、`workflows/deep-research/fleet.yaml.tpl`、
  `workflows/deep-research/tick/workflow.yaml`、`workflows/deep-research/tick/templates/tick.md`
- 配置：`profiles/deploy/*.env`（只加键）
- 测试：`test/g4a-question-wiring.test.ts`（Q1–Q4）
- 证据：`docs/dev-notes/dev_ledr_g4a2_question_wiring_01.md`（Q1–Q8 逐条 + §3 变异矩阵三行 + 还原证据），
  **按 §5 的更正后要求写**。
