# G1 —— 写入预算的「缺省值」这一层没有牙：只有一条正则在守，缺省正是生产真正吃到的那个数（加测试）

development_id: `dev_ledr_g1_default_budget_02`
attempt: `implement`（initial）
input_commit: `3bf10f2ff2df6b029941cf407800abc90ce962ea`

## 结论先行

本包**不改任何生产代码行为，只加测试**。把「缺省预算可用」从一条文本断言升级为
**行为断言**，并让变异矩阵能杀掉「缺省被调小」。全量 305 tests / 17 files 全绿
（基线 303 + 本包新增 2）。

## 根因（spec §0）

`bin/deep-research-loop.sh:51` 的缺省预算 `${MAX_WRITES:-64}` 只有一条**源码正则文本断言**
在守（`A10c D3 > bin/deep-research-loop.sh exports MAX_WRITES ...`，`toMatch(/MAX_WRITES:-64/)`），
而那条本应证明「default flows from bin」的端到端用例却**显式传入了** `MAX_WRITES: "64"`（透传，
不是缺省）。生产链路不设 `MAX_WRITES`，生产吃到的恰是那个没被任何行为断言守住的缺省值。
把缺省从 64 改成 5 的变异实测里，唯一挂的那条就是文本断言（`1 failed / 302 passed`）。

## 新增（test/a10c-writebudget.test.ts，仅新增、原有 8 条一行未删）

### `MIN_VIABLE_BUDGET = 13`（带依据）
一张真实卡的写入需求 = evidences + proposed_clues + 1（CAS open→explored）。
三次真实 worker 产出实测 6 / 9 / 10 条 evidence（wf-dc0c15 findings）。取观测上界
10 evidence + 2 clue + 1 CAS = 13。

### D1 —— 缺省值的行为断言（本包存在理由）
从**删除了 `MAX_WRITES` 的子环境**跑 `bin/deep-research-loop.sh --dry-run`，断言渲染出的
`pipelines[label="tick"].input.max_writes` 是有限正整数（非 Infinity、非 0、非字符串）且
`>= MIN_VIABLE_BUDGET`。并用 `expect(childEnv).not.toHaveProperty("MAX_WRITES")` **自证**
子环境真的不含 `MAX_WRITES`（否则会重蹈「声称删了、实际没删 ⇒ 恒绿」的错）。

### D2 —— 缺省值与收割行为接上
取 **D1 那条路径实际渲染出的值**（`renderedDefaultMaxWrites()`，不得写字面量 64）作为预算，
跑一次 10 evidence + 2 proposed_clue（needed = 13）的收割，断言：
`skipped === false`、`evidencePublished === 10`、`cluesPublished === 2`、`casExplored === true`。

## 硬验收（spec §2 逐条）

| # | 判据 | 证据 |
|---|---|---|
| D1 | 存在用例：不含 `MAX_WRITES` 的子环境跑 `--dry-run`，渲染值有限且 `>= MIN_VIABLE_BUDGET` | `test/a10c-writebudget.test.ts` `G1 D1: default budget ...` describe；实跑通过 |
| D1b | 用例自证子环境不含 `MAX_WRITES` | `expect(childEnv).not.toHaveProperty("MAX_WRITES")` 在 D1 用例内 |
| D2 | 用例用 D1 路径得到的值（非字面量）跑 10ev+2clue 收割，四项断言齐全 | `G1 D2: ...` describe；预算来自 `renderedDefaultMaxWrites()`，无 `64` 字面量参与 |
| D3 | `test/a10c-writebudget.test.ts` 原有 8 条断言一行未删 | 该文件 diff 只有新增（见下） |
| D4 | 全量 `npx vitest run` 全绿，文件数与用例数 ≥ 17 / 303 | `17 files / 305 tests` 全绿 |
| D5 | 变异矩阵三行齐全，逐断言归因 | 见下 |
| D6 | 每次变异回显被改行；全部还原后 `git status --porcelain` 为空 | 见下 |
| D7 | 变异矩阵与 D1–D6 证据落本文件，三列齐全 | 本文件 |

### D3 —— 只增不删
`git diff test/a10c-writebudget.test.ts` 仅新增：`MIN_VIABLE_BUDGET` 常量 + `renderedDefaultMaxWrites()`
helper + `G1 D1` / `G1 D2` 两个 describe。原有 A10c 8 条断言（含文本断言）一行未删。

## 变异矩阵（spec §3，逐断言归因）

### P1 —— `workflows/deep-research/tick/templates/tick.md` 四条 `--run` 分支去掉 `--max-writes`
改后该文件 `max-writes` 出现次数 1（原 4）。
被杀的断言（`test/a10c-writebudget.test.ts`）：
- `A10c D3 ... > tick.md passes --max-writes to tick-entry --run (all four branches)` ✗（`expect(line).toMatch(/--max-writes .../)`）
- `A10c D3 end-to-end ... > rendered tick.md passes the injected max_writes value into tick-entry argv` ✗

结果：`2 failed / 8 passed`。还原后行恢复。

### P2 —— `src/tick-run.ts` `DEFAULT_MAX_WRITES` 64 → 5
改后回显：`export const DEFAULT_MAX_WRITES = 5;`
被杀的断言（`test/tick-run.test.ts`）：
- `M10 ... > DEFAULT_MAX_WRITES is 64 (A10c: enough to harvest a real card, finite)` ✗（`expect(DEFAULT_MAX_WRITES).toBe(64)`）
- `M11 ... > parseRunCliArgs(['research:p02-smoke-1dce60']) parses channel + default max-writes` ✗

结果：`2 failed / 41 passed`。还原后行恢复。

### P3 —— `bin/deep-research-loop.sh` `${MAX_WRITES:-64}` → `${MAX_WRITES:-5}` ⛔ 本包存在理由
改后回显：`51:export MAX_WRITES="${MAX_WRITES:-5}"`
被杀的断言（`test/a10c-writebudget.test.ts`）：
- **G1 D1 ...（本包新增）** ✗ —— `expected 5 to be greater than or equal to 13`（查值域）
- **G1 D2 ...（本包新增）** ✗ —— `expected true to be false`（`report.skipped` 变 true，查行为）
- `A10c D3 ... > bin/deep-research-loop.sh exports MAX_WRITES ...` ✗（既有文本断言）

结果：`3 failed / 7 passed`。还原后行恢复。

⛔ **P3 的 D1 与 D2 各自独立挂掉**（一条查值域、一条查行为），不是同一条断言的两种写法；
也不只是文本断言挂掉。本包功率成立。

### D6 —— 还原干净
P1/P2/P3 每次改后已回显被改行；全部还原后 `git status --porcelain` 仅剩本包应提交的
`test/a10c-writebudget.test.ts`（bin / tick.md / src/tick-run.ts 均还原，无残留）。

## 验证命令
- `npm run typecheck`：exit 0。
- `npm test`：`Test Files 17 passed (17)` / `Tests 305 passed (305)`。

## 非目标（未触碰，越界即超出 scope）
- 未改 `src/` 或 `bin/` 任何**行为**（缺省值 64 是对的）；未改 `package.json` / `package-lock.json`；
- 未删/未改写 A10c 现有断言；未动 `tsconfig` 的 `include`；未碰任何 `schemas/*.json`；
- `node_modules/` 仅本地安装用于验证，不写入交付。
