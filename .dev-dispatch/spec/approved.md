# G8(v2) —— 生成段 argv 去掉 `--route`（agent-run 判 CONFIG_ERROR）

> 派发方：`line-deep-research`。前置：G7 已合入 main `4836cf6`。
>
> ⚠️ **这是重开包。上一个 development（`dev_ledr_g8_role_argv_01`，PR #48）跑了 5 个 attempt 被派发方取消，
> 两个原因都是我的 spec 缺陷，不是实现方的问题。见 §0.2。**
> **产品改动本身，上一轮 final review 已明确判定「correct and complete」。**

---

## 0.1　缺陷（Phase 6 真跑抓到）

G7 消除 `E2BIG` 后，生成段第一次真正启动 agent-run：

```
A8c: worker failed to start (agent-run) — exited with code 90.

派发方直接复现（--json，逐字）：
{"state":"failed","exit_code":90,"exit_reason":"config_error","runtime":"unknown","route":"unknown",
 "stderr_tail":"--role with --runtime or --route alone is not allowed; provide both --runtime and --route to override the role model"}
```

⇒ `buildGenerateRoleArgv` 给了 `--role` 与 `--route`，**却没有 `--runtime`** ⇒ agent-run 拒绝。
triage 的 argv 一直正常，正因为它**只传 `--role`、不传 `--route`**。

**修法：去掉 `--route`。** 派发方实测 `agent-runtime/profiles/roles/*.yaml`（已合入 main）：

| role | runtime | route |
|---|---|---|
| `dr-debater-advocate` | `opencode` | **`opus-4-8/ccs`** |
| `dr-debater-opponent` | `opencode` | **`gpt-5.6-sol/ccs`** |
| `dr-debater-judge` | `opencode` | **`ds-v4-pro/ccs`** |
| `dr-synthesizer` | `opencode` | **`opus-5/ccs`** |

⇒ role 自己已带全 runtime + route，且**与 golden-order 拍死的档位逐字一致**
（debater 三条互不相同中强档、synthesizer 强档）⇒ 调用方传 `--route` 既冗余又非法。

⛔ **不要改成同时传 `--runtime` + `--route`**：那会让档位有**两处真相**，一旦漂移即静默用错档，
而档位是 golden-order 拍死的。**让 role YAML 做唯一真相。**

⛔ **随之失去消费者的 `GenerateConfig` 里的 per-role `route` 字段必须删掉**
（本仓纪律：不得留没有消费者的字段；G4d 对 `anchorCheckRoute` 就是这么处理的）。
既有断言若断的是 argv 里的 route，随之更新（属必要删除，须给出说明）。

---

## 0.2　⛔ 上一轮我写错的两条，本节更正（照本节做，别照通用规则做）

### (a) ⛔ **`buildGenerateRoleArgv` 是导出的纯函数，测它不需要任何 mock**

上一轮我写了「断言必须打在生产组装出的 deps 上」。**那条规则是给前几包那种有状态 runtime 组装用的**
（G5/G6/G7 里 `runChannelWrite` 会在注入分支跳过生产装配，所以必须驱动生产组装）。
**把它套到一个纯函数上是错的** —— 它把实现方推向 `vi.mock`，而上一轮的 mock 工厂用
**手写重实现替换了 `spawnGenerateRole`**，导致连主断言也从不触及生产码（评审 attempt 4 blocker 原话）。

**本包的正确做法**：

```ts
import { buildGenerateRoleArgv } from "../src/generate";
const argv = buildGenerateRoleArgv({ /* 真实入参 */ });
expect(argv).not.toContain("--route");
expect(argv).toContain("--prompt-file");
```

⛔ **本包禁止 `vi.mock` 被测模块**（`src/generate.ts`）。纯函数直接调用、断言返回值。
⛔ 仍然禁止源码字符串匹配（`readFileSync` 源码再 `toContain`）—— 那既不是调用也不是断言行为。

### (b) ⛔ **不再要求你自报变异矩阵实测**

上一轮四个 attempt 全部栽在「自报变异矩阵」上，三次被评审判为编造。
**根因是这个要求本身**：变异要求「改产品码 → 跑测试 → 观察失败 → **还原** → 报告」，
还原之后**不留任何可核验的痕迹** ⇒ 报告与编造在证据上无法区分。
**一个输出无法与伪造相区分的检查，就是本仓一路在打的那种检查。**

⇒ **本包改为**：

1. 你只需为每条验收项给出**可达性声明**：**指名唯一那条会在该行为回归时失败的用例**，
   并用一两句说明**它为什么在缺少该行为时不可能通过**。这是一个**可被评审读代码核实**的声明。
2. ⛔ **不要写「实测/被杀 ✓」这类字样**，除非你真的做了并能贴出被改行与失败输出。
   **写不出就如实写「未实测，理由：见可达性声明」——这不扣分。**
3. **实测变异由派发方在 gate 执行**（本线每个包都是这么做的：G5 的 Q1–Q4、G6 的 S1–S2、G7 的 U1–U2
   全部由派发方亲手施加并复跑）。

---

## 1　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **V1** | ⭐ **argv 不含 `--route`**，且含 `--role` / `--run-id` / `--input` / `--prompt-file` | **直接调用 `buildGenerateRoleArgv`**，断言返回数组；⛔ 不得 mock 被测模块 |
| **V2** | ⛔ **四个 role 都覆盖**：advocate / opponent / judge / synthesizer 各一条断言 | 四条独立用例或参数化 |
| **V3** | ⛔ **无死字段**：`GenerateConfig` 不再保留没有消费者的 `route`；全仓 grep 无悬空引用 | grep + 读到行号 |
| **V4** | triage argv 保持原样（它一直是对的） | 既有断言仍有效 |
| **V5** | **可达性声明**：V1–V4 每条指名唯一会失败的用例 + 一两句「为什么缺该行为就不可能通过」 | dev-note；⛔ 不得写未做过的实测 |
| **V6** | 全量 `npx vitest run` **在干净环境下真绿**。基线：main `4836cf6` 实测 **28 files / 498 tests**，终值两项均不得低于基线 | ⛔ **必须实跑并贴完整尾部输出**（`Test Files` / `Tests` 两行 + 有无 FAIL 段）。⚠️ 上一轮出现过**贴上一个包的陈旧 `.dd-evidence`**，⛔ 必须是本次运行 |
| **V7** | `git status --porcelain` 为空 | 贴输出 |
| **V8** | 每处删除给出必要性说明 | — |

---

## 2　⛔ 前几包实付的学费（仍然适用的部分）

1. ⛔ **源码字符串匹配一律不构成证据**。
2. **dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit**，**不是 H0 提交**；
   ⛔ 不要为对齐 hash 做额外提交。
3. ⛔ **不得用「基线计数方式差异」解释测试数缺口** —— 同一条命令，口径可比。
4. **贴证据要贴本次运行的完整尾部**。

---

## 3　显式不做

| 不做 | 理由 |
|---|---|
| 改 `agent-runtime` 或 role YAML | 不同仓；四个 role 的档位已与 golden-order 一致 |
| 同时传 `--runtime` + `--route` | 档位两处真相、静默漂移（§0.1） |
| 改 triage argv | 它一直是对的 |
| 改语料投递（`--prompt-file`） | G7 刚交付 |
| `vi.mock` 被测模块 | §0.2(a)，上一轮正是死在这里 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 4　交付物落点

- 实现：`src/generate.ts`（`buildGenerateRoleArgv` + `GenerateConfig` 死字段清理 + 相关调用点）
- 测试：`test/g8-role-argv.test.ts`（V1–V4；**直接调用纯函数，零 mock**）
- 证据：`docs/dev-notes/dev_ledr_g8v2_role_argv_01.md`（V1–V8 逐条 + **§0.2(b) 的可达性声明** +
  本次运行的全量测试尾部 + `git status` 输出 + §0.1 那张四行档位表）
