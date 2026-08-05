# A8f —— 让 worker 真的读得到东西：`--add-dir` + `revision`（V1 前最后一个包）

> 上游依据：`wf-dc0c15` 的 `spec.md`(rev7) §4.1 / §4.2 / §5.2。
> 前置已合入 main：链 A 全部 + A7 + A8a–A8e；跨仓 A1c / R1c / R1d / **R1e**（`revision` 已入输入契约）。
> `worker.result.v1` **已注册**。

---

## 0　缺口：引擎派出的 worker **什么都读不到**，且不报错

**grep 级实测，三条独立事实：**

| # | 事实 | 证据 |
|---|---|---|
| 1 | `role.fs` **全仓无实际消费者** | `src/roles.ts:201`（拷进 ResolvedRole）与 `:338-339`（**仅模板变量校验**）；**`dispatch.ts` 从不读它** |
| 2 | 生产 argv **不含 `--add-dir`** | `buildAgentRunArgv` 入参只有 `agentRunBin/role/runId/inputPath/clueText` |
| 3 | `allowed_root` **从没被填过** | 生产调用点 `src/tick-run.ts` 只传 4 个参数，`buildWorkerInput` 的 `allowedRoot?` 无人提供 |

⇒ `fs.read: ["{{allowed_root}}"]` **纯声明式，既不授予也不限制任何东西**；
真正授予目录访问的只有 CLI 的 **`--add-dir`**。

⇒ **引擎派出的 `dr-worker-code-local` 在空工作区（`/data/agent-runtime/runs/<id>/workdir`）之外
什么都读不到 ⇒ 产出零证据，且不报错、不崩溃。**

> ### ⚠️ 这个缺口是本 gate 自己的手工测试掩盖掉的
> 三次真跑都有 evidence，**只因为命令行手工加了 `--add-dir /data/code/self/agent-runtime`**
> —— **生产路径不传这个参数**。
>
> **判据：一次手工跑，如果加了生产路径不会传的参数，
> 它就不是对生产路径的测试 —— 它是对「我以为的生产路径」的测试。**

### 0.1 顺带修掉 worker 撞权限墙

真跑 tool_result 原文：`git -C <root> rev-parse HEAD` → **`"This command requires approval"`，连续 4 次**
（只读模式无 permission bypass，**无人可批准**）⇒ 白烧 4 个回合才退回读 `.git` 文件。

⛔ 给权限这条路封死：`agent-runtime` 的 `dispatch.ts:1082` 拒绝非 `--write` 角色使用 `--permission`。
⇒ **正解：引擎自己跑 `git rev-parse` 把 `revision` 填进 payload**
（R1e 已把可选 `revision` 加进 `deep-research.worker-input/v1`）。
这既省掉白费回合，又让 anchor 的 `revision` 从**模型自述**变成**引擎权威** —— 移除一整类错误。

---

## 1　交付

### 1.1 `allowed_root` 配置与贯通

沿用 `EVIDENCE_CHANNEL` 的既有模式，**同一条链路**：
`bin/deep-research-loop.sh`（`ALLOWED_ROOT`）→ `fleet.yaml.tpl` → `tick/workflow.yaml`
→ `tick.md` → `tick-entry --run ... --allowed-root <path>`。

⛔ **不得派生默认值**（同 §1.4 判据：猜根目录与猜 channel 同样危险）。

### 1.2 ⛔ `code-local` 无 `allowed_root` ⇒ **响亮失败**，不得静默零证据

⛔ 当一个 dispatch 决策映射到 **`dr-worker-code-local`** 而 `allowed_root` 未配置：
**当场响亮失败**（非零退出 / 抛错，错误文本点名 `allowed-root`），
⛔ **不得照常 spawn**（那会产出零证据且看起来正常 —— 本包存在的理由）。

⚠️ 其余三个 role（`wiki` / `feishu` / `code-remote`）**不需要** `allowed_root`，
⛔ **不得因它缺失而阻断它们**。

### 1.3 载荷与 argv

- `buildWorkerInput(...)` 的 `allowedRoot` **在生产调用点真实传入**
- argv 增加 **`--add-dir <allowed_root>`**（仅当有值时）
- `revision`：引擎在 `allowed_root` 执行 `git rev-parse HEAD`
  - 成功 ⇒ 填进 payload 的 `revision`
  - ⛔ **失败（非 git 目录等）⇒ 省略该字段**，⛔ **绝不填空串**
    （空串会通过下游的「非空」检查 —— 与 A8e 的 `"://@"` 退化 anchor 同族）
  - ⛔ **不得因 git 失败而阻断派发**（`revision` 是可选字段，persona 有 Read 回退路径）

---

## 2　硬验收（逐条可机械核验）

> ⛔ **本表最重要的是 F1–F4：走完整生产入口的用例。**
> 本线**连续三个包**（A8c / A8d / A8e）栽在同一处：**规定了组件行为，没规定它被接进生产链路**。
> ⛔ **凡「生产必须提供 X」，验收必须有一条从 `bin/*.sh` 或模板出发、跑到 X 被消费处的用例；
> 「不传时会报错」不构成「生产真的传了」。**

| # | 断言 | 怎么验 |
|---|---|---|
| **F1** | ⛔ **生产链路贯通**：`bin/deep-research-loop.sh` 的 `ALLOWED_ROOT` 经 fleet → workflow → `tick.md` 到达 `--allowed-root` | 渲染后逐层 grep 命中，**四层各一条断言** |
| **F2** | ⛔ **生产默认 argv 含 `--add-dir <allowed_root>`** | 走 `runChannelWrite`（生产路径）捕获 argv，断言相邻对 `["--add-dir", <root>]` |
| **F3** | ⛔ **生产路径写出的载荷文件含 `allowed_root`，值 === 配置值** | **读那个文件**断言内容（**不得只匹配文件名**） |
| **F4** | ⛔ **生产路径写出的载荷含 `revision`，值 === `git rev-parse HEAD`** | 用真实 git 目录做夹具，**读文件**断言等于实际 sha |
| **F5** | ⛔ `code-local` + 无 `allowed_root` ⇒ **响亮失败**（非零/抛错，文本含 `allowed-root`），**零 spawn** | 走 `runChannelWrite` ⇒ 断言抛错且 spawn 调用 0 次（安全性） |
| **F6** | ⛔ 有 `allowed_root` 时**确实 spawn**（活性，配 F5） | 断言 spawn 1 次 |
| **F7** | ⛔ `wiki`/`feishu`/`code-remote` **不因缺 `allowed_root` 被阻断** | 三条各一例，断言仍正常 spawn |
| **F8** | ⛔ 非 git 目录 ⇒ 载荷**省略** `revision`（**该键不存在**），且**仍正常 spawn** | 读载荷断言 `"revision" not in payload`（**否定式**） |
| **F9** | ⛔ **绝不填空串** | 断言载荷中不存在 `revision === ""`（与 F8 分开：**缺键**与**空值**是两种失败） |
| **F10** | ⛔ 无 `allowed_root` 时 argv **不含** `--add-dir` | 否定式断言 |
| **F11** | ⛔ A8e 的收割判据仍成立（H6/H7/H14 生产路径用例） | 原用例仍在且仍通过 |
| **F12** | ⛔ A8d 的 P1/P2、A8c 的 N1/N2 仍成立 | 原用例仍在且仍通过 |
| **F13** | ⛔ `--selfcheck` 仍保留且仍无副作用 | exit 0，零网络请求 |
| **F14** | ⛔ 不得触碰 `.dd-evidence/` | actor 提交文件面不含 |
| **F15** | typecheck + 全量测试 | 均 exit 0 |
| **F16** | ⛔ 既有 **238** 条用例**一条不删** | `git diff` 无 `it(`/`test(` 净减少 |
| **F17** | 证据写 `docs/dev-notes/<development_id>.md` | 存在；仓根**无** `IMPLEMENTATION_SUMMARY.md` |

---

## 3　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **G1** argv 里去掉 `--add-dir` | **F2** |
| **G2** 载荷里不填 `allowed_root` | **F3** |
| **G3** 载荷里不填 `revision` | **F4** |
| **G4** `revision` 取不到时填空串而非省略 | **F8 与 F9** |
| **G5** `code-local` 无 root 时照常 spawn（不报错） | **F5** |
| **G6** 对 `wiki` 也要求 `allowed_root` | **F7** |
| **G7** 断掉生产链路任一层（如 `tick.md` 不传 `--allowed-root`） | **F1 中对应那一条**（**四层四条独立断言**，断一层只挂一条） |

> **只报「N/N 挂了」不算数。破坏后必须回显被改的那一行**，跑完逐字还原，
> 并 `git diff --stat` 确认还原干净。

### 3.1 ⚠️ 变异本身的三条纪律（本线本轮各栽一次）

1. ⛔ **变异必须语义合法**：曾写 `return node` 而参数名是 `value` ⇒ 运行期错误炸掉整个模块，
   17 条挂 10 条 —— **看着像功率很强，实际什么都没归因**。
2. ⛔ **必须命中语义位置**：曾把正则打在**接口的类型声明**（`clue_id: string`）上，
   而测试运行器**不做类型检查** ⇒ 全绿 ⇒ **「没测到」被误读成「实现是对的」**。
3. ⛔ **改「次序」必须真的移动**：曾只在前面**加**一个 CAS、保留后置那个
   ⇒ 「最后一次 CAS 在所有 publish 之后」**依然成立**、该挂的没挂。
   **「多做一次」和「换个时机做」是两种不同的破坏。**

### 3.2 ⚠️ 其余通用纪律（择要）

- `describe` 块名**不得枚举多个判据 ID**（一个 describe 一个判据）。
- **安全性断言必须配活性断言**（F5 配 F6）。
- 凡本包必须实现的能力，验收行须对**真实文件 / 真实 git 目录**求值。
- **两个只差一项输入的用例，才构成判别性证据。**
- ⛔ **一条不变量在某一层被守住，不构成它在别的层也被守住** —— **F1–F4 正是为这条而设**。
- ⛔ **无声截断 / 静默零结果 = 假装完成**（F5 的存在理由）。

---

## 4　非目标

- ⛔ **不做真机 `--run`**（V1 由 gate 在本包合入后统一发起）
- ⛔ **不做文件系统隔离**：用户 2026-08-05 已拍板
  「**接受 worker 可读全盘，安全性移到凭证下发管控**」
  ⇒ ⛔ **本包不得试图用 `--add-dir` 实现安全隔离**（它做不到：Bash 不受目录限制，实测
  worker 曾在工作区外成功执行 `sha256sum <绝对路径>`）。
  **`--add-dir` 在本包的唯一作用是「让 worker 读得到」，不是「限制 worker 只能读」。**
  ⛔ **dev-notes 必须写明这一点**，不得把它描述成安全边界。
- ⛔ 不注册任何协议；不改 `worker-result.v1.json`
- ⛔ 不实现 `anchor-check`；不做 triage/synthesizer/debater（属 R2）
- ⛔ 不得绕过 A8b 的 `realCas` 另写 CAS
- 不改既有导出签名，确需新增则**新增**

---

## 5　⛔ 派发面硬约束

- `setup_commands` 含 `npm ci`（**本仓用 npm**；agent-runtime 那个仓用 bun，别混）
- `.dd-evidence/` 是 dd 保留路径，**actor 任何提交碰它都是硬失败**。
  ⛔ 陈旧 `acceptance.json` 随 H0 从 main 继承，**不是本包的问题、不该由本包修**。
- ⚠️ **若 reviewer 声称「这个环境里没有某文件」，可能是假阳性**
  （`/usr/local/bin/lark-cli` 曾被误报不存在，实测存在且可执行；
  `agent-run` 在 `/home/uther/.local/bin/agent-run`，reviewer 的 harness 里很可能看不到）。
- ⛔ **测试不得触网**（不得连真实 bus / vault / MinerU）
- ⛔ **不得把任何真实 secret 值写进代码 / 测试 / dev-notes**

---

## 6　环境（均为实测）

- `git -C <path> rev-parse HEAD` 对**主 checkout** 与 **worktree（detached）** 均可用；
  非 git 目录返回非零并输出 `fatal: not a git repository`
- ⛔ **读退出码时命令后不得接管道**（`cmd | tail; echo $?` 拿到的是 `tail` 的退出码
  —— 本线本轮因此把真实失败读成通过，犯过 4 次）
- `EVIDENCE_CHANNEL` / `TICK_CHANNEL` 的贯通链路已由 A8e/A8c 建立，**本包沿用同一条**
