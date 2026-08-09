# G4a —— `--question` 生产贯通：第五次「组件支持、生产不传」

> 派发方：`line-deep-research`（deep-research V2 收尾线）。**这是一个已核实的生产接线缺陷，不是加功能。**
> 前置已合入 main `501db99`（G1 / G2a / G2b / D1 全部完成）。

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

⚠️ **G2b 把响亮失败做对了**（不静默用空 question 派发），所以这不是隐性错误 ——
但它意味着 **V2 端到端一旦跑到 triage 就停**。本包是 Phase 6 的必要前置。

---

## 1　要做什么

**把「研究主问题」从部署配置一路贯通到 `tick-entry --run --question`。**

链路（照 `MAX_WRITES` 已经走通的那条形状做，**别另发明**）：

```
bin/deep-research-loop.sh  (export)
  → workflows/deep-research/fleet.yaml.tpl  (pipeline input 占位符)
    → workflows/deep-research/tick/templates/tick.md  ({{…}} 变量)
      → "$tick_entry" --run <channel> … --question "<研究主问题>"
```

`MAX_WRITES` 的四段落点分别在 `bin:101`、`fleet.yaml.tpl:12`、`tick.md:19`、`tick.md:26/28/30/32` ——
**读它们，照它们的形状接。**

### 1.1 ⛔ 无内置缺省，未配置即响亮失败

与 `TICK_CHANNEL`（D1 已确立）、`EVIDENCE_CHANNEL`（设计如此）对齐：
**研究主问题不得有内置缺省值**，未由 profile 或显式 env 提供 ⇒ **响亮失败拒绝启动**，理由写进错误消息。

> **判据**：一个编出来的缺省问题会让整场研究跑偏，而 bus 写入 append-only 不可回退。
> ⛔ **尤其不得**从 channel 名、topic slug 或任何其它字段**推导**出一个问题字符串 ——
> 那正是 `EVIDENCE_CHANNEL` 当初拒绝做的事（静默推导会写进错 channel，本条是同一条道理）。

### 1.2 ⛔ 不得把 `tick.md` 的分支数再翻一倍

`tick.md:25-33` 现在是 `evidence_channel × allowed_root` 的 **4 分支组合树**。
再加一个可选参数会变 8 分支，下一个变 16。

⇒ **改成增量拼 argv**（数组累加后一次调用），而不是继续展开组合分支。
⚠️ 注意 `set -euo pipefail` 下的数组展开与空值处理；**保持 `run_output` 的捕获与后续
`hasPendingWork` 判定逐字不变**（那是 A9 的续投逻辑，本包不碰）。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **Q1** | 从生产入口渲染：只设 profile/env、跑 `--dry-run`，fleet 的 tick pipeline input 里**有 question 字段且等于配置值** | 解析渲染出的 YAML |
| **Q2** | ⛔ **真正的贯通断言**：渲染出的 `tick.md` + **假 `tick-entry` 记录 argv**，断言 `--question` **及其值**真的出现在 argv 里 | 照 `test/a10c-writebudget.test.ts` 里 `--max-writes` 那条的做法（**读它，照它写**）。⛔ 只断言「fleet input 里有 question」**不算数**——那正是 Q1，两者必须都有 |
| **Q3** | ⛔ **无内置缺省**：不设任何相关 env 且无 profile ⇒ **非零退出且错误消息点名该变量**；⛔ 且**不得**出现任何被推导/编造的问题字符串 | 正反两例 |
| **Q4** | ⛔ **组合矩阵**：`evidence_channel` / `allowed_root` / `question` 三者「有/无」的**全部 8 种组合**下，argv 都只包含该有的参数、不包含不该有的 | 参数化用例；这条同时证明 §1.2 的重构没有漏分支 |
| **Q5** | ⭐ **可达性断言**：从**生产入口**出发（不是从单元函数出发），证明 question 到达 `tick-entry`。**「模块支持」「渲染里有值」都不构成可达性证据** | 见 Q2；本条是判据说明，不是额外用例 |
| **Q6** | 全量 `npx vitest run` 全绿，文件数/用例数**不少于基线 19 / 348** | 贴输出 |
| **Q7** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **Q8** | `src/`、`test/`、`workflows/` 的每一处删除给出必要性说明（本包要重写 `tick.md` 的分支树，属必要） | — |

> ⭐ **本包的存在理由是 Q2**：`--question` 已经被 CLI 解析、被 usage 记录、被引擎依赖，
> **唯独没有人传它**。⛔ 任何只验「CLI 支持」「input 里有值」的检查都复现不了这个缺陷。

---

## 3　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **P1** | 生产 `tick.md` 里去掉 `--question` 传参（其余不动） | **Q2 必须挂**；⛔ **Q1 应当仍绿** —— 这正是本包要证明的：Q1 单独存在时是零功率的 |
| **P2** | 给研究主问题编一个内置缺省值 | **Q3 的失败侧必须挂** |
| **P3** | 只在 `evidence_channel` 与 `allowed_root` 都有的那一支传 `--question`，其余支不传 | **Q4 必须挂**（这是「组合分支漏一支」的真实形态） |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 4　显式不做（越界即超出 scope）

| 不做 | 理由 |
|---|---|
| **接生成段**（`runGenerate` 进生产、收敛触发） | 归 **G4b**。派发方已核实生成段整段从生产不可达，那是独立一包 |
| **接导出**（`src/export.ts` 进生产、消费 `EXPORT_ROOT`） | 归 **G4c** |
| 改 `profiles/deploy/*.env` 的 channel 取值 | 归 **D2**（那两个 channel 当前在 bus 上不存在，由派发方处置） |
| 注册任何 bus 协议 | 不可逆，走公示流程，由派发方在异议窗口后执行 |
| 改 `agent-runtime` | 不同仓 |
| 动 A9 的续投逻辑 / `hasPendingWork` 判定 | 本包只加一个参数的贯通，不碰控制流 |
| 端到端真跑真 bus | 归 Phase 6 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 5　交付物落点

- 实现：`bin/deep-research-loop.sh`、`workflows/deep-research/fleet.yaml.tpl`、
  `workflows/deep-research/tick/templates/tick.md`（分支树 → 增量 argv）
- 配置：`profiles/deploy/*.env` **只加该变量的键**（取值可用占位说明，⛔ 不改 channel 取值）
- 测试：`test/g4a-question-wiring.test.ts`（Q1–Q4）
- 证据：`docs/dev-notes/dev_ledr_g4a_question_wiring_01.md`（Q1–Q8 逐条 + §3 变异矩阵三行 + 还原证据）

> ⚠️ **dev-note 的 `input_commit` 必须等于最终交付 commit**。若中途 rework，**note 必须同步更新**
> ——派发方在 D1 上实测到「note 停留在 attempt 1、数字与交付物对不上」，gate 会核对这一项。
