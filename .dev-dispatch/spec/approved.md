# A9 —— 让这条流水线**真的跑起一个 tick**（V1 首跑挖出的三层缺陷）

> 上游依据：`wf-dc0c15` 的 `spec.md`(rev7) §3.2 / §3.4。
> 前置已合入 main：链 A 全部 + A7 + A8a–A8f（**21 个包**）。
> **本包的全部依据来自 2026-08-05 V1 首跑实测，不是推测。**

---

## 0　V1 首跑：一个 tick 都没跑起来

严格按计划**完全走 `bin/deep-research-loop.sh`**（只设该脚本自己读的三个 env）。
**板面零污染**（1 open / 0 evidence，无任何不可撤写入）。三层缺陷：

### 0.1 驱动用 `node` 跑 loop-engine，而它跑不了
```
Error [ERR_MODULE_NOT_FOUND]: Cannot find module '.../dist/engine'
```
`dist/engine.js` **存在**；`cli.js` 用的是 **extensionless import**
⇒ **Node ESM 不解析、bun 解析**（实测 `bun dist/cli.js --help` 正常输出用法）。
而 `bin/deep-research-loop.sh:72` **写死** `node "$LOOP_ENGINE_CLI" drain`。

### 0.2 换 bun 跑通驱动后：**0 个 tick**
```
{"reason":"drained","rounds":0,"ticksByLabel":{"tick":0}}
```

### 0.3 根因（架构级）：**tick 没有触发源**
fleet 的 tick 从文件触发存储 `$RUN_ROOT/stores/trigger` claim，
而 `RUN_ROOT` 带时间戳 ⇒ **每次跑都是全新空目录**；实测该目录**一个文件都没有**；
`fleet.yaml.tpl` 中**无任何 seed/trigger 投递**。
⇒ `claimableCount()` 恒为 0 ⇒ drain 立即判「已排空」。
⇒ **板上有 open 卡这件事，引擎完全看不见。**

⚠️ `workflow.yaml` 里那个 `seed` 是**被 claim 之后、pipeline 内部的节点种子**，
**不是**「谁来 claim 这条 pipeline」。**A7 的 G2 只验了「pipelines 非空」，
从没验过「一个 tick 能被 claim」。**

> ### 21 个包、254 条用例全绿，而这条流水线**从来没有跑过一次完整的自己**。
> 每个包都验了「我这一段对不对」，**没有任何一个包验「接起来能不能动」**。

---

## 1　交付

### 1.1 修驱动的运行方式（⛔ 不得静默回退 `node`）

- 新增 `LOOP_ENGINE_RUNNER`（可覆盖）；缺省解析 **`bun`**
- ⛔ **解析不到 ⇒ 响亮失败**（非零退出 + 错误文本点名 `bun` / `LOOP_ENGINE_RUNNER`）
- ⛔ **绝不回退 `node`**：`node` 会给出 `ERR_MODULE_NOT_FOUND: .../dist/engine` 这种
  **指向不存在文件、实则是解析器不兼容**的误导性错误（本 gate 首跑正因此误判为「构建残缺」）

### 1.2 触发源：驱动投首个触发（实测过的确切形态）

实测 `loop-store` 契约：
```
bun <loop-engine>/dist/lib/store-cli.js <store_dir> put '{"id":"...","status":"open","body":{...}}'
bun ... <store_dir> claim open done tick   → 返回该记录并置 done
落盘：<store_dir>/<id>.json + .events.jsonl
```
⇒ ⛔ **`bin/deep-research-loop.sh` 必须在 `drain` 之前，向 `TRIGGER_STORE_DIR`
投一条 `status: "open"` 的触发记录**，否则 drain 必然 0 tick。

### 1.3 自持续投 + 自然终止（`spec §3.4`）

⛔ tick 完成后，**当且仅当板面仍有非终态 clue**（`open` / `in_flight` / `proposed`）
时再投下一条触发；否则**不投** ⇒ drain 自然收敛退出。

为此：
- `tick-entry --run` 的 JSON 输出**新增一个布尔字段**（如 `hasPendingWork`），
  由板面状态确定性推出（⛔ 不得靠猜、不得靠计时）
- `tick.md` 依该字段决定是否 `loop-store put` 下一条触发
- ⛔ 触发 `id` 必须**每轮唯一**（否则 `put` 覆盖同一条、或 claim 已 done 的记录）

⚠️ **`trigger_store_dir` 当前没有传进 tick 的 payload**（fleet 里只在 `claim.store_dir`）
⇒ 必须像 `evidence_channel` 那样**一路注入到 tick.md**。

### 1.4 ⛔ 写入预算不变
沿用 `--max-writes`（默认 5）、v1 冻结 channel 拒写、证据 channel 无默认值。

---

## 2　硬验收

> ⛔ **F0 是本包唯一不可替代的一条。** 本线已用 21 个包、254 条全绿用例证明：
> **单元层全绿说明不了这条流水线能不能动。**

| # | 断言 | 怎么验 |
|---|---|---|
| **F0** | ⛔ **真的跑起至少一个 tick**：以真实 `bin/deep-research-loop.sh` 跑一次，drain 输出 `ticksByLabel.tick >= 1` | **端到端跑**，断言 JSON 字段；⛔ 不得用打桩替代 |
| **F1** | ⛔ 驱动用可解析的 runner，**不含写死的 `node <cli> drain`** | `grep` 断言脚本中无 `node "$LOOP_ENGINE_CLI"` |
| **F2** | ⛔ runner 解析不到 ⇒ 响亮失败且文本点名 | 置 `LOOP_ENGINE_RUNNER` 为不存在命令 ⇒ 非零退出 + 文本命中 |
| **F3** | ⛔ **绝不回退 `node`** | 同 F2 情形断言**未执行** `node`（安全性）；配 F0（活性） |
| **F4** | ⛔ drain 前触发存储**非空**（投了首个触发） | 跑后读 `$TRIGGER_STORE_DIR`，断言至少一条记录存在 |
| **F5** | ⛔ 触发记录形状 `{id, status:"open", body}` 且可被 `claim open done tick` 认领 | 对真实 store 求值 |
| **F6** | ⛔ `trigger_store_dir` 贯通到 tick.md（**四层各一条断言**） | `bin` → fleet → workflow → tick.md 逐层 grep |
| **F7** | ⛔ 板面有非终态 clue ⇒ `hasPendingWork === true` | 打桩板面，纯数据 |
| **F8** | ⛔ 板面全终态 ⇒ `hasPendingWork === false`（**与 F7 只差板面内容**，判别性） | 同上 |
| **F9** | ⛔ `hasPendingWork` 为真 ⇒ tick.md **投下一条触发**；为假 ⇒ **不投** | 两例，断言 store 记录数变化 |
| **F10** | ⛔ 每轮触发 `id` 唯一 | 连投两轮断言两条不同记录 |
| **F11** | ⛔ A8f 的 F1/F5、A8e 的 H6/H7/H14、A8d 的 P1/P2、A8c 的 N1/N2 仍成立 | 原用例仍在且仍通过 |
| **F12** | ⛔ `--selfcheck` 仍保留且无副作用 | exit 0，零网络请求 |
| **F13** | ⛔ 不得触碰 `.dd-evidence/` | actor 提交文件面不含 |
| **F14** | typecheck + 全量测试 | 均 exit 0 |
| **F15** | ⛔ 既有 **254** 条用例一条不删 | `git diff` 无 `it(`/`test(` 净减少 |
| **F16** | 证据写 `docs/dev-notes/<development_id>.md` | 存在；仓根**无** `IMPLEMENTATION_SUMMARY.md` |

### 2.1 ⛔ F0 的执行约束
- ⛔ **只允许对 `research:p02-smoke-1dce60` 做真机 F0**（它已是冒烟专用），
  ⛔ **不得写 `research:v1-*`**（那是 V1 的干净板面，由 gate 保留）
- 跑前跑后**记录消息数增量**，写进 dev-notes；⛔ 增量须 ≤ `--max-writes`
- ⚠️ `EVIDENCE_CHANNEL` 若指向不存在的 channel，收割会响亮失败 —— **F0 允许 0 张待收割卡**，
  只要 `ticksByLabel.tick >= 1` 即达成

---

## 3　变异自检

| 变异 | 必须杀死 |
|---|---|
| **W1** 驱动不投首个触发 | **F0 与 F4** |
| **W2** runner 解析不到时回退 `node` | **F2 与 F3** |
| **W3** `hasPendingWork` 恒为 `false` | **F7**（与 F8 构成判别对，只改一侧必挂一条） |
| **W4** `hasPendingWork` 恒为 `true` | **F8** |
| **W5** 续投时 `id` 用固定常量 | **F10** |
| **W6** 断掉 `trigger_store_dir` 贯通任一层 | **F6 中对应那一条**（四层四条独立断言） |

> **破坏后必须回显被改的那一行**，跑完逐字还原并 `git diff --stat` 确认干净。

### 3.1 ⚠️ 变异本身的三条纪律（本线各栽一次，全部由「回显 + 核对该挂的是否挂了」发现）
1. ⛔ **必须语义合法**：曾写 `return node` 而参数名是 `value` ⇒ 运行期错误炸掉整个模块，
   17 条挂 10 条 —— **看着像功率很强，实际什么都没归因**。
2. ⛔ **必须命中语义位置**：曾把正则打在**接口的类型声明**上，而测试运行器**不做类型检查**
   ⇒ 全绿 ⇒ **「没测到」被误读成「实现是对的」**。
3. ⛔ **改「次序」必须真的移动**：曾只在前面**加**一个 CAS、保留后置那个
   ⇒ 该挂的断言依然成立。**「多做一次」和「换个时机做」是两种不同的破坏。**

### 3.2 其余纪律（择要）
- `describe` 块名不得枚举多个判据 ID；**安全性断言必须配活性断言**（F3 配 F0、F7 配 F8）。
- **两个只差一项输入的用例，才构成判别性证据**（F7/F8、F9 两例）。
- ⛔ **一条不变量在某一层被守住，不构成它在别的层也被守住** —— **F0 正是为这条而设**。
- ⛔ **无声截断 / 静默零结果 = 假装完成**。

---

## 4　非目标

- ⛔ **不改 `loop-engine` 仓**（共享仓，别的线在动；本包只改调用方）
- ⛔ **不实现 triage / synthesizer / debater**（属 R2）；不实现 `anchor-check`
- ⛔ **不注册任何协议**
- ⛔ **不改 `--add-dir` 的语义**：它**不是安全边界**（Bash 不受目录限制），
  用户已拍板「接受 worker 可读全盘，安全性移到凭证下发管控」
- ⛔ 不得绕过 A8b 的 `realCas` 另写 CAS
- ⛔ **不得为了让 F0 通过而放宽任何既有守卫**（A8f 的 F5、A8e 的 H14 等）

---

## 5　⛔ 派发面硬约束

- `setup_commands` 含 `npm ci`（本仓用 npm）
- ⚠️ **`loop-engine` 的 `dist/` 需可用**：本机 `/data/code/self/loop-engine` 处于 detached HEAD、
  **落后 origin/main 49 个提交**且 `dist/` 残缺。
  ⛔ **不得修改该共享仓的 checkout**；测试若需真实 CLI，用 `LOOP_ENGINE_CLI` 指向
  自建 worktree 的构建产物（本 gate 已在 `/data/worktrees/loop-engine-v1build` 备好）。
- `.dd-evidence/` 是 dd 保留路径，actor 任何提交碰它都是硬失败；陈旧 `acceptance.json` 不该由本包修
- ⚠️ reviewer 若称「环境里没有某文件」可能是假阳性（其 harness 文件系统视图与宿主不同）
- ⛔ 测试不得触网（真实 bus / vault / MinerU）；⛔ 不得把真实 secret 值写进任何产物

---

## 6　环境（均为实测）

- `bun <loop-engine>/dist/cli.js drain <fleet> --label deep-research` **可用**；`node` 不可用
- `loop-store` 契约见 §1.2（`put` / `claim from to by` / `list`，落盘 `<id>.json`）
- `TRIGGER_STORE_DIR` 已由 `bin/deep-research-loop.sh` 导出为 `$RUN_ROOT/stores/trigger`
- ⛔ **读退出码时命令后不得接管道**（`cmd | tail; echo $?` 拿到的是 `tail` 的退出码，本线犯过 4 次）
