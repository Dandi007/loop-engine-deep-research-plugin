# G4d(v2) —— anchor-check 确定性接线：核验率的来源自己必须是机械的

> 派发方：`line-deep-research`。前置：G4c(v2) 已合入 main `f286f0e`。
>
> ⚠️ **这是重开包。上一个 development（`dev_ledr_g4d_anchor_check_01`，PR #41）由派发方主动取消，
> 原因是我在 spec 里写了一条实现方不可能满足的要求。详见 §0.1 —— 那不是实现方的问题。**

---

## 0　先读这两节

### 0.1 ⛔ 上一包为什么被取消：**我要求了一件你做不到的事**

上一版 spec §3.1 要求把 `anchor-check.py` / `anchor-check-selftest.sh` / `fixtures/`
**从 katana 仓搬入本仓**。但 dd 的工作区**只含本插件仓**，`env_allowlist` 只有 `PATH` / `HOME`
⇒ **实现方根本读不到那些源文件**。

面对一条不可满足的指令，上一轮的实现方**自己写了一个校验器**。评审逐条证实它是坏的：

| 评审 finding | 后果 |
|---|---|
| `current_verified_hit` 的 `validate_anchor` **只检查文件存在且行数够** | **evidence 的 quote 从未被读取** ⇒ 任何指向足够长文件的锚点都算「已核验」 |
| `sums_ok` 是恒真式，生产中永不为 false | spec 要求的「无声丢弃」守卫成了死代码 |
| `fixtures/` 只有一个占位 README | 校验器自带的有牙回归**根本没搬过来** |

> ### ⛔ 判据：**一个自己不核验的校验器，比没有校验器更坏。**
> **核验率是软闸门的判据来源**（`golden-order` 2026-08-09 拍板：核验率 < 90% ⇒ V2 验收判不过）。
> 一个恒报高分的校验器会**凭空制造闸门的证据**，让「验过了」这句话本身失去含义。

**⇒ 本包据此改设计（见 §2）：校验器留在原处，经环境变量以确定性子进程调用。
⛔ 本包严禁自行实现、改写或"等价重写"任何校验逻辑。**

### 0.2 ⛔ 上一包实付的其它学费（直接照用）

1. **测试必须驱动生产的 dep 组装。** `runChannelWrite` 在 `opts.generateDeps` 存在时走注入分支、
   **完全跳过 `assembleGenerateDeps`**。已交付的正确机制：**`assembleGenerateDeps` 是导出函数**，
   用例可直接调用它拿**生产组装出的 deps** 再断言。⛔ 凡涉及生产 dep 的验收项一律照此写。
2. **`workflow.yaml` 新增的可选 pipeline input 必须带 `?`**（既有正确写法 `"{{evidence_channel?}}"`）；
   验收须在相关 env 均未设置的**干净环境**下跑全量。
3. **`--json` 输出的核验率单位要统一**：`renderReportHead` 原样字符串化该数值且不带单位标记，
   而软闸门口径是「< 90%」。**本包必须明确它是百分数还是分数，并在报告头部无歧义地体现**，
   且与既有用例写入同字段的形式一致（现存用例写的是 `100` / `95` / `0` 这样的百分数）。

---

## 1　现状：`spawnAnchorCheck` 被建模成 **agent route**

`src/generate.ts` 的 `GenerateConfig` 有 `anchorCheckRoute: "anchor-check"`（占位）。
G2a 把 debater/synthesizer 的占位 route 换成了真实 route，**唯独这一条没换** —— 因为它根本不该是 route。

> ### ⛔ 判据：**拿 LLM route 去跑一个确定性校验器，等于把「机械核验」换成「模型说它核验了」。**
> **一个判据的来源，自己必须是机械的。**

G4c(v2) 交付的生产 `spawnAnchorCheck` 目前抛 `AnchorCheckNotWiredError` ⇒ 报告头部如实标 `unavailable`。
**本包把它换成真实的确定性调用。**

---

## 2　⛔ 改后的设计：校验器留在原处，经 `ANCHOR_CHECK_BIN` 调用

**不搬运。** 校验器（v3，含自带 selftest 与 fixtures）留在 katana 仓
`plugins/deep-research/skills/deep-research/loop-orchestration/tools/`，由**部署方**通过环境变量指向它。

| 键 | 语义 |
|---|---|
| `ANCHOR_CHECK_BIN` | 校验器可执行文件的绝对路径。**无内置缺省。** |

**调用形状（校验器的真实接口，派发方读过源码，不要照文档猜）**：

```
<ANCHOR_CHECK_BIN> --corpus <json 文件> --repo-root <path> --json
```

`--json` 输出的字段（逐字）：

```jsonc
{ "total": N, "current_parsed": N, "current_verified_hit": N, "current_failed": N,
  "old_format": N, "unparseable": N, "discarded": N, "sums_ok": bool,
  "loud_failures": [ {"anchor": …, "error": …} ] }
```

要点：
- 把引擎已读到的 evidences（`readEvidences` 的结果）序列化成**临时 JSON** → `--corpus <file>`；临时文件在 `finally` 清理。
- `--repo-root` 用 `ALLOWED_ROOT`。**它对现行格式锚点是必需的**（locator 是仓内相对路径）。
- ⛔ **不得**再经 `agent-run` / route 派发；`GenerateConfig` 的 `anchorCheckRoute` 字段随之移除
  （⛔ 不得留一个没有消费者的 route 字段）。
- ⛔ **`ANCHOR_CHECK_BIN` 未配置 ⇒ 核验率 `null`（`unavailable`）**，走既有的 `generate.ts` catch 路径。
  ⛔ **不得**编造核验率；⛔ **不得**返回 `0`（`0%` 与 `unavailable` 是两件事，既有代码明确区分）。

### 2.1 ⛔ 严禁自行实现校验逻辑

⛔ **不得**在本仓新建任何 `anchor-check.py` / 等价校验脚本 / 内联的锚点校验实现。
⛔ **不得**"顺手实现一个简化版以便测试" —— 测试用**假子进程**（记录 argv、返回构造好的 JSON）即可。
若你认为校验器接口与本 spec 不符，**停下在 review 里说明，不要自己写一个**。

---

## 3　⛔ 核验率的口径（本包最重要的一条判断）

**`verificationRate = current_verified_hit / total`。**

⛔ **分母必须是 `total`，不得用 `current_parsed`。**

> **理由**：若分母取 `current_parsed`（只算「能解析的那些」），那么一份 90% 锚点不可解析、
> 剩下 10% 全部命中的证据集，会报出 **100% 核验率**。
> **分母偷偷变小 = 软闸门被架空**，而软闸门正是 V2 验收的硬判据。
> ⇒ 不可解析、旧格式、被丢弃的锚点**全部计入分母**：它们就是「没核验成」。

**`defects = total - current_verified_hit`**（实现方可用等价表达式，但**必须在 dev-note 写明你采用的式子**）。

**⛔ `total === 0` 时不得报 100%**：没有锚点可核验**不是「全部核验通过」**。此时核验率为 **`null`（unavailable）**。
> 与 R2a 那次「`decisions: []` 通过 schema 校验」是同一个错的形状：**空集合不是成功。**

**⛔ `sums_ok === false` 必须响亮**：发生无声丢弃时不得折算进一个看起来正常的核验率
⇒ 核验率 `null`，**且必须在报告头部或落盘件里点名 `sums_ok=false`**（⛔ 不得只是一个和崩溃无法区分的裸 `unavailable`）。

---

## 4　还要做的两件事

### 4.1 报告落盘（plan §0 产物 3）

把 `--json` 的**完整输出**写到导出件**同目录** `<EXPORT_ROOT>/DeepThought/<主题-slug>/`，文件名可判别（如 `anchor-check.json`）。
⛔ 落盘失败**不得**阻断导出（软闸门语义），但必须在报告头部或落盘件里可见。
⛔ **目录推导必须复用 `src/export.ts` 既有的 slug / 路径推导**（`slugify` / `deriveExportPath`），
不得另抄一份 —— 两份拷贝当前一致只是巧合，会静默发散。

### 4.2 继承缺口：`createdAt` 的响亮失败没有用例

`assembleGenerateDeps` 的 `spawnExport` 里「doc channel 回读不到该 `sourceMessageId` ⇒ 响亮失败」
这条支路**没有任何用例**（G4c(v2) 遗留）。原 U6 用例是对 **`src/export.ts`** 做源码字符串匹配 ——
**查错了文件**（风险在 `src/tick-run.ts`）且是被判定不算数的形状。

⇒ 补一条**判别性**用例：驱动**生产** `spawnExport`，令 doc channel 里**不存在**该 `sourceMessageId`，
断言**响亮失败**且不落回系统时钟。⛔ 不得用源码字符串匹配充当该断言。
⛔ 同时**删掉或改写**那条零功率的源码匹配用例，并在 dev-note 说明（零功率检查比没有更坏）。

---

## 5　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **V1** | ⛔ **不再经 route/agent-run**：生产路径 grep 无 `anchorCheckRoute` 消费者；`spawnAnchorCheck` 是子进程调用 | 读代码到行号 + **假子进程记 argv**，断言 argv[0] === `ANCHOR_CHECK_BIN` 的值且含 `--json` |
| **V2** | ⭐ **核验率口径**：分母是 `total`。判别性用例：`total=10 / current_parsed=1 / current_verified_hit=1` ⇒ 核验率**必须是 10%，不得是 100%** | §3 的唯一执行点，⛔ 杀不掉即判零功率 |
| **V3** | ⛔ `total===0` ⇒ 核验率 `null`（`unavailable`），不得是 100% | 判别性用例 |
| **V4** | ⛔ `sums_ok===false` ⇒ 核验率 `null` **且点名 `sums_ok=false`**，不得是裸 `unavailable`（须与崩溃可区分） | 判别性用例，断言点名字面 |
| **V5** | ⛔ **`ANCHOR_CHECK_BIN` 未配置 ⇒ `unavailable`**，⛔ 不得编造核验率、⛔ 不得是 `0%` | 正反两例；⭐ **必须打在生产 `assembleGenerateDeps` 组装出的 dep 上**（见 §0.2-1） |
| **V6** | ⛔ **软闸门不变**：核验率 < 90% **仍然导出**，但必须标在报告头部 | 正反两例（<90% 与 ≥90%） |
| **V7** | ⛔ **`--repo-root` 真的被传**（用 `ALLOWED_ROOT`）；子进程非零退出/输出不可解析 ⇒ 不被吞掉，走 `unavailable` | 假子进程记 argv + 失败传播一例 |
| **V8** | **落盘**：`--json` 全文写到导出件**同目录**（目录推导复用 `export.ts`）；落盘失败不阻断导出 | 正反两例 + 读到行号证明复用 |
| **V9** | ⛔ **仓内没有自写校验器**：`git ls-files` 无新增的 `anchor-check*.py` 或等价实现 | grep + 读 diff |
| **V10** | §4.2 的 `createdAt` 判别性用例存在且有牙；零功率的源码匹配用例已删除/改写 | 判别性用例 + dev-note 说明 |
| **V11** | ⛔ **核验率单位无歧义**（§0.2-3），与既有同字段用例形式一致 | 读到行号 + 用例 |
| **V12** | 全量 `npx vitest run` **在干净环境下真绿**（`ANCHOR_CHECK_BIN` / `DOC_CHANNEL` / `RESEARCH_ORIGIN` / `EXPORT_ROOT` 均未设置）。基线：main `f286f0e` 实测 **22 files / 411 tests**，终值两项均不得低于基线 | ⛔ **必须实跑并贴完整尾部输出**（`Test Files` / `Tests` 两行 + 有无 FAIL 段） |
| **V13** | 变异矩阵（§6）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **V14** | 每处删除给出必要性说明 | — |

---

## 6　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **W1** | 核验率分母从 `total` 改成 `current_parsed` | **V2 必须挂**；⛔ 杀不掉即判 V2 零功率 |
| **W2** | `total===0` 返回 `verificationRate: 1` | **V3 必须挂** |
| **W3** | 忽略 `sums_ok`，照常折算核验率 | **V4 必须挂** |
| **W4** | `ANCHOR_CHECK_BIN` 未配置时返回 `{defects:0, verificationRate:0}` 而非 unavailable | **V5 必须挂** |
| **W5** | 不传 `--repo-root` | **V7 必须挂** |
| **W6** | 落盘目录改成自己拼的字符串（不复用 `export.ts`） | **V8 必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 7　显式不做

| 不做 | 理由 |
|---|---|
| ⛔ **自己实现/改写任何锚点校验逻辑** | 见 §2.1。上一包正是死在这里 |
| 把校验器搬进本仓 | **实现方读不到源仓**（§0.1）。居所问题归 **R4**（同仓可访问） |
| 改 `anchor-check.py` 的校验算法 | 不同仓；发现缺陷停下在 review 说明 |
| 播种入口 | 归 **G4e** |
| 改 `profiles/deploy/*.env` 的取值（含 `ANCHOR_CHECK_BIN` 填什么） | 归 **D2**。本包只保证**未配置时如实 `unavailable`** |
| 注册任何 bus 协议 | 不可逆，走公示流程 |
| 端到端真跑真 bus | 归 Phase 6 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 8　交付物落点

- 实现：`src/generate.ts`（dep 形状 + 核验率换算 + `sums_ok` 点名）、`src/tick-run.ts`（生产 dep 组装）、
  `src/export.ts`（若需暴露 slug/路径推导供复用）
- 测试：`test/g4d-anchor-check.test.ts`（V1–V11）
- 证据：`docs/dev-notes/dev_ledr_g4dv2_anchor_check_01.md`（V1–V14 逐条 + §6 变异六行 + 还原证据 +
  **你采用的 `defects` 表达式** + **核验率的单位**）

> **dev-note 的 `input_commit` 记本次 implement attempt 的 input_commit**（该字段本来的语义）。
> 真正的要求是**正文描述交付物本身**：测试文件数/用例数、变异矩阵各行**实测**结果、最终代码行为必须与交付一致；
> 若中途 rework 改了实现，正文数字与结论同步更新。
> ⛔ **不要为对齐 commit hash 做额外提交。**
> ⛔ **不得用「基线计数方式差异」解释测试数缺口** —— 基线与终值是同一条 `npx vitest run`，口径可比。
