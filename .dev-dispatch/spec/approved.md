# G4c-2 —— 收尾 G4c：一个缺失的 `?` 让每个 tick 都在报错，而外面看是一次干净的收敛

> 派发方：`line-deep-research`。
> **本包继承 G4c（`dev_ledr_g4c_generate_wiring_01`，PR #38）已完成的全部产物**，只补最后三件事。

---

## 0　为什么会有这个包（读完再动手）

G4c 跑了 5 个 attempt，attempt 5 的 **final review 判 APPROVE**，但 **dd 的 acceptance 阶段执行 `npm test` 得到 `exit_code 1`**，development 因此判 **FAILED**（`.dd-evidence/acceptance.json` 有逐字记录）。

> ### ⛔ 判据：**评审判过 ≠ 命令跑过。**
> attempt 5 的 final review 没有 finding，而同一份代码上 `npm test` 是红的。
> **只有真的把验收命令跑一遍，才知道它是不是绿的。**

**你继承的这条分支已经包含 G4c 的全部实现**（21 个 commit，皆在 main `f655317` 之上）。⛔ **不要重做已完成的部分**，逐条列在 §1。

---

## 1　⛔ 已完成、**不要碰**的部分

以下均已交付并被 review 确认，本包**不得重写、不得"顺手优化"**：

| 已完成 | 位置 |
|---|---|
| 生成段触发边（终态非 null + origin + 未生成过 ⇒ `runGenerate`），含有牙的可达性用例 | `src/tick-run.ts` 触发边、`test/g4c-generate-wiring.test.ts` U1 |
| 一次性保证：内存 Set + 跨进程文件标记，**标记在 `runGenerate` 成功之后才写**（失败不永久堵死重试） | `src/tick-run.ts` `hasGeneratedInAnyProcess` / `markGeneratedInAnyProcess` |
| 生产 `spawnRole` 读 **`dr-doc.result.v1`**（该 kind 才有 `body`；`worker.result.v1` 没有），每次重读 + 重试等待 spawn 落地 | `src/tick-inspect.ts` `readGenerateResult`、`src/tick-run.ts` `readBody` |
| 导出：`mkdirSync(dirname, {recursive:true})`、`source_message_id` 取自真实发布 id、`createdAt` 优先取 bus `created_at` | `src/tick-run.ts` `spawnExport` |
| `--origin` / `--doc-channel` 从 `bin/` → `fleet.yaml.tpl` → `workflow.yaml` → `tick.md` → `tick-entry` 的生产贯通 | 四个文件 |
| `writeDoc` 拒绝静默默认到板 channel（无 `--doc-channel` 即响亮失败） | `src/tick-run.ts` `writeDoc` |
| `lockSynthesizer` mkdir 互斥锁 | `src/tick-run.ts` |

---

## 2　要做的三件事

### 2.1 ⭐ F1（blocker）：`doc_channel` 缺 `?` 可选标记

`workflows/deep-research/tick/workflow.yaml:29` 当前是：

```yaml
      doc_channel: "{{doc_channel}}"
```

**同一文件紧邻两行的既有可选输入是**：

```yaml
      evidence_channel: "{{evidence_channel?}}"     # :20
      allowed_root: "{{allowed_root?}}"             # :21
```

⇒ `DOC_CHANNEL` 为空时（**当前所有 deploy profile 的默认值**，D2 尚未执行）模板按**必填**渲染，**tick 节点报错**。

**派发方实测的因果证据（决定性）**：

| 条件 | 结果 |
|---|---|
| `DOC_CHANNEL` 为空 | `test/a10b-convergence.test.ts` 的 **B2** 失败，连跑 3 次 **3/3 挂** |
| `DOC_CHANNEL=research:p02-smoke-1dce60.docs` | 同文件 **12/12 全绿** |
| attempt 3 产出 `36b651d`（本改动引入前）同一 worktree 同一时刻重跑 | **12/12 全绿** ⇒ 是本改动引入的回归 |

**⛔ 放大器比 bug 本身更严重**（本包真正要消灭的东西）：

```
/data/loop-engine/runs/2026-08-09T215954-f5c1c472/loop-events.jsonl
  {"kind":"round_end","detail":{"round":1,"ticked":["tick"],"errors":1}}
同目录 drain.json
  {"reason":"drained","rounds":1}          ← 且脚本 exit 0
```

⇒ **每个 tick 都在报错，而从外面看是一次干净的收敛。**

**要求**：让 `doc_channel` 与既有两个可选输入**同形**（可选、空值不报错）。
⛔ **不得**改成"给它编一个缺省 channel"——bus 写入 append-only 无 DELETE，doc 发错 channel 不可回退；
`writeDoc` 现有的「无 `--doc-channel` 即响亮失败」语义**必须原样保留**。

### 2.2 F2：`--origin` / `--doc-channel` 的生产贯通目前只有**字符串包含**断言

现状（G4c attempt 4 评审 minor，未修）：`test/g4c-generate-wiring.test.ts` 只用
`expect(source).toContain("--origin")` 对模板文件做字符串匹配 —— 这正是 spec 判定**不构成可达性证据**的形状，
且它对 §2.1 这类渲染层缺陷**零判别力**（`{{doc_channel}}` 写错成必填，字符串包含照样绿）。

**照本仓已有的正确形状写**：`test/g4a-question-wiring.test.ts:124-143 / 177-199` —— 渲染 `tick.md` +
**假 `tick-entry` 记录 argv**，断言 flag **及其值**真的出现在 argv 里。

### 2.3 F3：`createdAt` 仍可能落回系统时钟

`src/tick-run.ts` 的 `spawnExport`：`reportMsg?.created_at ?? new Date().toISOString()`。
而 `src/export.ts:11 / :22` 把「日期取自 bus `created_at`、**绝不取系统时钟**」写成硬不变量
（`deriveExportPath` 把该日期放进文件名，导出必须**同输入⇒同字节**可重生成）。

**要求**：回读不到该 message ⇒ **响亮失败**，⛔ 不得落回系统时钟。

---

## 3　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **F1** | ⭐ **全量 `npx vitest run` 真的全绿**，且**在 `DOC_CHANNEL` 未设置的干净环境下**（这是缺省部署形态） | ⛔ **必须在你自己的 workspace 里实跑并贴完整尾部输出**（`Test Files` / `Tests` 两行 + 有无 FAIL 段），不得只贴计数、不得只写结论 |
| **F2** | 基线：main `f655317` 实测 **21 files / 391 tests**；本包终值**文件数与用例数均不低于基线** | 贴两次实测输出 |
| **F3** | ⛔ **B2 判别性**：把 `workflow.yaml` 的 `doc_channel` 改回**无 `?`** ⇒ B2 **必须挂** | 变异 M1，见 §4 |
| **F4** | ⛔ `--origin` **与** `--doc-channel` 各有一条 **argv 记录**用例：渲染 `tick.md` + 假 `tick-entry`，断言 flag **及其值**出现在 argv | ⛔ 只断言模板文件里含该字符串**不算数** |
| **F5** | ⛔ **值缺省时不得出现该 flag**：`DOC_CHANNEL` / `RESEARCH_ORIGIN` 为空 ⇒ argv 里**没有**对应 flag（不是空串参数） | 正反两例 |
| **F6** | ⛔ `createdAt` 回读不到 message ⇒ **响亮失败**，不得落回系统时钟；grep 生产路径无 `new Date()` 兜底 | 判别性用例 + 读到行号 |
| **F7** | `writeDoc` 的「无 `--doc-channel` 即响亮失败」语义**未被削弱** | 既有断言保留且仍有效（读到行号） |
| **F8** | 变异矩阵（§4）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **F9** | `src/`、`test/`、`workflows/` 的每处删除给出必要性说明 | — |

---

## 4　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **M1** | `workflow.yaml` 的 `doc_channel` 去掉 `?`（= 回到 G4c attempt 5 的状态） | **F1 全量必须变红、B2 必须挂**；⛔ 杀不掉即判本包核心零功率 |
| **M2** | 让 `tick.md` 在 `doc_channel` 非空时**不**追加 `--doc-channel` | **F4 的 doc-channel 那条必须挂** |
| **M3** | 让 `tick.md` 在 `research_origin` 为空时也追加 `--origin ""` | **F5 必须挂** |
| **M4** | `createdAt` 恢复 `?? new Date().toISOString()` 兜底 | **F6 必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 重写 §1 列出的任何已完成部分 | 已交付并被 review 确认；本包只补三件事 |
| anchor-check 真实接线 | 归 **G4d** |
| 播种入口 | 归 **G4e** |
| 改 `profiles/deploy/*.env`（含新增 `DOC_CHANNEL` 取值） | 归 **D2**。本包**只保证 `DOC_CHANNEL` 为空时不炸**，不决定它该是什么值 |
| `lockSynthesizer` 的陈旧锁回收 | 已记为独立 finding，归后续包；本包不扩面 |
| 一次性标记改成 bus 侧/run-root 作用域 | 同上，独立 finding |
| 注册任何 bus 协议 | 不可逆，走公示流程（派发方处置） |
| 端到端真跑真 bus | 归 Phase 6 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 6　交付物落点

- 修复：`workflows/deep-research/tick/workflow.yaml`、`src/tick-run.ts`（仅 §2.3 那一处）
- 测试：`test/g4c2-assembly.test.ts`（F4/F5/F6）；B2 保持原样**不得修改**（它是 F1 的判据）
- 证据：`docs/dev-notes/dev_ledr_g4c2_fix_01.md`（F1–F9 逐条 + §4 变异四行 + 还原证据）

> **dev-note 的 `input_commit` 记本次 implement attempt 的 input_commit**（该字段本来的语义）。
> 真正的要求是**正文描述交付物本身**：测试文件数/用例数、变异矩阵各行**实测**结果、最终代码行为必须与交付一致；
> 若中途 rework 改了实现，正文数字与结论同步更新。
> ⛔ **不要为对齐 commit hash 做额外提交。**
> ⛔ **不得用「基线计数方式差异」解释测试数缺口** —— 基线与终值是同一条 `npx vitest run`，口径可比。
