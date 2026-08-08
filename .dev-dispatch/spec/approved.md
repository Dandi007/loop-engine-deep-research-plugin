# G1 —— 写入预算的「缺省值」这一层没有牙：只有一条正则在守，而缺省正是生产真正吃到的那个数

> 上游依据：`wf-dc0c15` `spec.md`(rev7) §3.2、`plan.md` §6（测试功率纪律六条）。
> 前置已合入 main：链 A 全部（S1–S4 / N1 / N3 / A7 / A8a–A8f / A9 / A10a–A10c），gate commit `9c15103`。
> **本包不改任何生产代码行为，只加测试。** 若实现过程中发现必须改 `src/` 或 `bin/` 的行为，
> 那说明本 spec 判断错了 —— **停下并在 review 里说明，不要顺手改**。

---

## 0　实测：把 `bin` 的缺省预算从 64 改成 5，303 条用例里只有一条正则挂掉

2026-08-09，在 main（`9c15103`）上做变异实测。

**先撞到的前置问题**：该 checkout 里 `npx vitest run` 报
`Error: Failed to load url yaml`、**`0 test` collected**。
`yaml` 在 `devDependencies` 里声明了（`^2.4.0`）但 `node_modules/yaml` 不存在，
而 **5 个接线回归文件都 import 它**（`a10c-writebudget` / `a10b-convergence` /
`a8f-adddir` / `a9-tick-trigger` / `plugin-wiring`）。
`npm install` 之后基线为 **303 passed / 17 files**。

> ⚠️ **这条依赖缺口不归本包**，归部署包（D1）。本包只在 acceptance 里要求依赖已安装。

**变异 P3**：`bin/deep-research-loop.sh:51`
`export MAX_WRITES="${MAX_WRITES:-64}"` → `${MAX_WRITES:-5}`（改后已回显该行）。

全量复跑，**逐断言归因**：

| 断言 | P3 下 | 性质 |
|---|---|---|
| `A10c D3 > bin/deep-research-loop.sh exports MAX_WRITES with a default sufficient for a real card` | ❌ 挂 | `expect(src).toMatch(/MAX_WRITES:-64/)` —— **源码正则文本匹配** |
| `A10c D3 end-to-end > driver dry-run renders max_writes=64 into the fleet input (default flows from bin)` | ✅ **存活** | ⛔ 它自己传了 `env: { ...process.env, MAX_WRITES: "64" }` |
| `A10c D3 end-to-end > rendered tick.md passes the injected max_writes value into tick-entry argv` | ✅ 存活 | 注入 `max_writes: "64"`，测的是模板透传 |
| 其余 300 条 | ✅ 存活 | — |

**结果：1 failed / 302 passed，唯一挂的那条是文本断言。**

### 0.1 根因：唯一那条名字里写着「default flows from bin」的用例，把 default 覆盖掉了

```ts
const out = execFileSync("bash", [BIN, "--dry-run"], {
  cwd: ROOT, encoding: "utf8",
  env: { ...process.env, MAX_WRITES: "64" },   // ⛔ 显式传入了它声称要测的那个缺省
});
expect(input?.max_writes).toBe(64);
```

⇒ 它证明的是「传 64 进去会渲染出 64」（**透传**），
**不是**「不传时 bin 自己给出的缺省是多少」。
而**生产链路不设 `MAX_WRITES`**（`bin/deep-research-loop.sh` 是 `/deep-research` 的入口，
没有任何上游导出该变量），**生产吃到的恰恰就是那个没被任何行为断言守住的缺省值**。

### 0.2 这命中本线三条已付过学费的判据

1. **一个永远绿的检查等于没有检查** —— 那条端到端用例对「缺省是多少」恒绿。
2. **grep / 正则只能证伪不能证实** —— 验「X 仍然生效」的正确形状是破坏 X 看该挂的挂没挂，
   而不是 grep X 还在不在。文本断言会被任何无害重构（改 shell 变量名、换 `:-` 写法）误杀，
   也会被任何"保留字面量但实际不生效"的改动放过。
3. **重言式** —— 与 A10b 那条 `expect(code).toBe(0)`（而 `runRealE2E` 硬编码 `code: 0`）同族。

> **本包要立的通用判据**：
> **当一条用例的名字里出现 default / 缺省 / 自动，先去看它的 env 或入参里有没有把那个 default 显式传进去。传了 ⇒ 它测的是透传，不是缺省。**

---

## 1　要做什么

**把「缺省预算可用」从文本断言升级为行为断言，并让变异矩阵能杀掉缺省被调小。**

### 1.1 新增 `MIN_VIABLE_BUDGET` 常量与其依据

在 `test/` 侧（不进 `src/`）定义：

```ts
// 一张真实卡的写入需求 = evidences + proposed_clues + 1(CAS open→explored)。
// 三次真实 worker 产出实测：6 / 9 / 10 条 evidence（wf-dc0c15 findings）。
// 取观测上界 10 evidence + 2 clue + 1 CAS = 13。
const MIN_VIABLE_BUDGET = 13;
```

⚠️ **这个数必须带上述依据注释**。无依据的魔数会在下一次 review 被正当地打回。

### 1.2 D1 —— 缺省值的行为断言（本包的存在理由）

新增用例：从**删除了 `MAX_WRITES` 的子环境**跑 `bin/deep-research-loop.sh --dry-run`，
断言渲染出的 `pipelines[label="tick"].input.max_writes`：

- 是有限正整数（**不是 `Infinity`、不是 `0`、不是字符串**）
- **`>= MIN_VIABLE_BUDGET`**

⛔ **该用例必须自证「子环境里真的没有 `MAX_WRITES`」**——把构造出的 env 对象断言一次
（`expect(childEnv).not.toHaveProperty("MAX_WRITES")`），
否则本包会重蹈它要修的那个错：**一个声称删除了变量、实际没删的用例，同样恒绿**。

### 1.3 D2 —— 缺省值与收割行为必须接上

新增用例：**取 D1 那条路径实际渲染出的 `max_writes` 值**（⛔ 不得写字面量 `64`），
用它作为预算跑一次收割，卡的 worker 产出为 **10 条 evidence + 2 条 proposed_clue**（needed = 13）：

- `skipped === false`
- `evidencePublished === 10`、`cluesPublished === 2`、`casExplored === true`

⇒ 缺省若被调小到 13 以下，**D1 与 D2 会各自独立地挂**（一条查值域、一条查行为）。
这正是「两条独立的杀伤路径」，而不是同一条断言的两种写法。

### 1.4 D3 —— 既有断言一行不删

`test/a10c-writebudget.test.ts` 现有 8 条断言（含那条文本断言）**全部保留**。
文本断言不删的理由：它对「字面量被整段删掉」仍有证伪力；本包补的是它证实不了的那一半。

---

## 2　硬验收（gate 逐条核，缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| D1 | 存在一条用例，从**不含 `MAX_WRITES`** 的子环境跑 `--dry-run`，断言渲染值有限且 `>= MIN_VIABLE_BUDGET` | 读用例源码到行号；并**实际跑一次** |
| D1b | 该用例**自证**子环境不含 `MAX_WRITES` | 断言语句必须存在，grep 到行号 |
| D2 | 存在一条用例，使用 **D1 路径得到的值**（非字面量）跑 10ev+2clue 的收割，四项断言齐全 | 读源码确认无 `64` 字面量参与预算；实际跑一次 |
| D3 | `test/a10c-writebudget.test.ts` 原有 8 条断言一行未删 | `git diff` 该文件只有新增 |
| D4 | 全量 `npx vitest run` 全绿，且**文件数与用例数均不少于基线 17 / 303** | 贴出实际输出 |
| D5 | 变异矩阵三行齐全（见 §3），**逐断言归因**，不得只报 N/N | 见 §3 表格要求 |
| D6 | 每次变异**回显被改的那一行**；全部还原后 `git status --porcelain` **为空** | 贴出回显与 status 输出 |

---

## 3　变异矩阵（必须逐断言归因）

| 变异 | 改什么 | 期望被杀的断言（**点名，不许只写条数**） |
|---|---|---|
| **P1** | `workflows/deep-research/tick/templates/tick.md` 四条 `--run` 分支去掉 `--max-writes` | A10c D3 的四层文本断言 + 「rendered tick.md passes … into tick-entry argv」端到端断言 |
| **P2** | `src/tick-run.ts` 的 `DEFAULT_MAX_WRITES` 由 64 改回 5 | `M10: DEFAULT_MAX_WRITES is 64` + `parseRunCliArgs … default max-writes` |
| **P3** | `bin/deep-research-loop.sh` 的 `${MAX_WRITES:-64}` 改成 `${MAX_WRITES:-5}` | **本包新增的 D1 与 D2 两条必须都挂**（这是本包存在的理由）；A10c 那条文本断言也会挂 |

⛔ **P3 若只挂掉 A10c 那条文本断言、而本包新增的两条没挂，本包即为零功率，必须打回重做。**

**纪律（`wf-dc0c15/plan.md` §6，逐条适用）**：
1. 变异功率**逐断言归因**，不能只报「N/N 挂了」——曾经 10/10 差点签字，去看挂的是哪几条才发现核心那条全程存活；
2. **破坏后必须回显被改的那一行**，不能只信脚本说改了——曾有正则命中注释行而非真代码，脚本打印 `patched: True`、测试全绿；
3. 零功率的检查比没有检查更坏；
4. 一个永远红或永远绿的检查等于没有检查，**绿路径必须验**；
5. gate 校 spec 读 `.dev-dispatch/spec/approved.md`；
6. 纯文档包不编造变异自检——**本包不是纯文档包，有真实行为断言**。

---

## 4　显式不做（越界即为超出 scope）

| 不做 | 理由 |
|---|---|
| 修 `yaml` 依赖缺失 / 改 `package.json` | 属部署面，归 D1 包。本包只要求跑测试前依赖已装 |
| 改 `src/` 或 `bin/` 的**行为** | 本包只加测试。缺省值 64 是对的，不要动它 |
| 删除或改写 A10c 现有断言 | D3 要求一行不删 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |
| 碰任何 `schemas/*.json` | 协议注册即终身冻结，改了会让部署期 `register-bus-protocols` 炸 `ProtocolConflict` |

---

## 5　背景：为什么这件事值得单独一个包

`--max-writes` 这条链路，本线已经栽过一次：**CLI 支持该参数、生产模板不传** ⇒
任何 worker 产出 ≥5 条 evidence 的卡在生产里永远收割不了，卡恒 `in_flight`、永不 `drained`。
那是本线「接线」缺陷的第四次同形复现，由 A10c 修掉。

**本包修的是同一条链路上剩下的最后一格**：A10c 把值从 `bin` 一路接到了 `tick-entry`，
但**没有人守住「不传时 bin 给的是几」**——而生产恰恰从不传。
换句话说：接线已经通了，**通的那根线的起点电压没有仪表**。
