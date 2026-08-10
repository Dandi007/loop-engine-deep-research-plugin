# G7 —— 语料走位置参数，撞上 Linux 单参数 128 KB 上限：真实规模下生成段必 `spawn E2BIG`

> 本文件是验收证据。`input_commit` = `cf5dd6440c93d031773563d7137842f19886fe74`。

## 缺口（生产实测，非估计）

研究「agent harness」跑到终态（64 线索：53 explored / 11 dropped，`termination.state = "capped"`，证据 channel 424 条）后，生成段每次触发都 `spawn E2BIG`。证据语料序列化后 **262 001 字节（256 KB）** > Linux 单参数上限 `MAX_ARG_STRLEN` = **131 072（128 KB）**。总量未超 `ARG_MAX`（2 MB），撞的是单参数 128 KB 天花板。

## 改了什么

- `src/generate.ts`：`buildGenerateRoleArgv` 把语料位置参数改为 `--prompt-file <path>`；`spawnGenerateRole` 写语料到临时文件并走 `--prompt-file` 投递，`--input` 的 schema 守卫语义保留不变，两个临时文件（`--input` + `--prompt-file`）在 `finally` 中清理。
- `src/tick-run.ts`：`buildTriageArgv` 把语料位置参数改为 `--prompt-file <path>`；`spawnTriageRole` 同样走 `--prompt-file` 投递，`finally` 清理两个临时文件。
- `test/g7-prompt-file.test.ts`：新增 11 个测试（T1–T6）。

## 硬验收逐条

### T1：超限语料能跑通（generate 侧）

构造 **181 177 字节（~177 KB）** 的 debater 语料（850 条 evidence），经 `spawnGenerateRole` 生产入口派发：
- 假 spawn 记录 argv，遍历每个参数，**没有任何单个参数 ≥ 131 072 字节**。✓
- `--prompt-file` 指向的文件内容逐字 = `serializeCorpusToPositional` 输出。✓
- 文件内容包含首尾 evidence 的 anchor（`code://repo@abc123:src/foo0.ts#L0`、`code://repo@abc123:src/foo849.ts#L849`）。✓
- argv 中无 `--` 位置参数分隔符。✓

### T2：两条路径都改

- **generate 侧**：argv 包含 `--prompt-file`，无 `--` 位置参数分隔符。✓
- **triage 侧**：使用 850 条 `proposed_clues` 的超限语料（150 692 字节 > 128 KB），argv 包含 `--prompt-file`，无 `--` 位置参数分隔符。遍历 argv 中每个参数，**没有任何单个参数 ≥ 131 072 字节**。`--prompt-file` 文件内容逐字 = `serializeTriageCorpusToPositional` 输出。✓

### T3：语料内容逐字不变

- **generate 侧**：`--prompt-file` 文件内容 === `serializeCorpusToPositional(corpus)` 输出。✓
- **triage 侧**：`--prompt-file` 文件内容 === `serializeTriageCorpusToPositional(corpus)` 输出。✓

### T4：`--input` 的 schema 守卫仍在

- **generate 侧**：argv 包含 `--input`，值为 `/tmp/payload.json`（writeInputFile 写出的路径）。✓
- **triage 侧**：argv 包含 `--input`，值为 `/tmp/i.json`（writeInputFile 写出的路径）。✓

### T5：载荷文件用后即删（正反两例）

- **成功路径**：spawn 成功返回后，`--input` 文件与 `--prompt-file` 文件均不存在。✓
- **失败路径**：`spawnProcess` 抛错 `"spawn boom"`，异常被传播，但 `finally` 仍清理——两个文件均不存在。✓

### T6：断言打在生产组装出的 deps 上

- **T6-a**（generate 侧）：走 `spawnGenerateRole`（生产入口），不注入 `spawnRole`。✓
- **T6-b**（triage 侧）：走 `spawnTriageRole`（生产入口），不注入 `spawnTriage`。✓
- 无源码字符串匹配；无自建 runtime 注入替代。✓

### T7：全量 `npx vitest run` 真绿

```
 Test Files  28 passed (28)
      Tests  498 passed (498)
   Start at  08:38:08
   Duration  7.04s
```

未设置 `ANCHOR_CHECK_BIN` / `DOC_CHANNEL` / `RESEARCH_ORIGIN` / `EXPORT_ROOT` / `AGENT_RESULT_*`。28 files ≥ 基线 27，498 tests ≥ 基线 487。✓

### T8：变异矩阵（逐断言归因，亲跑实测）

| 变异 | 改什么 | 被测断言 | 实测 |
|---|---|---|---|
| **U1** | generate argv 改回「语料进位置参数」：`buildGenerateRoleArgv` 移除 `--prompt-file`，改为 `opts.corpus` 作为位置参数 | T1 + T2 的 generate 侧 | 5 个测试挂：T1（`ENOENT`：`--prompt-file` 不在 argv 中，`argv.indexOf("--prompt-file")` 返回 -1，`readFileSync(argv[-1 + 1])` 即 `readFileSync("/fake/agent-run")` → ENOENT）、T2 generate 侧（`expected argv to include '--prompt-file'`）、T3 generate 侧（同上 ENOENT）、T5 成功路径（`promptFilePath` 为 `/fake/agent-run`，`existsSync` 返回 false）、T6-a（`expected argv to include '--prompt-file'`）。**被杀** ✓。还原：`buildGenerateRoleArgv` 恢复 `--prompt-file`，`spawnGenerateRole` 调用恢复 `promptFile`。 |
| **U2** | triage argv 改回「语料进位置参数」：`buildTriageArgv` 移除 `--prompt-file`，改为 `opts.corpus` 作为位置参数 | T2 的 triage 侧 | 3 个测试挂：T2 triage 侧（`expected argv to include '--prompt-file'`）、T3 triage 侧（ENOENT：`readFileSync("/fake/agent-run")`）、T6-b（`expected argv to include '--prompt-file'`）。**被杀** ✓。还原：`buildTriageArgv` 恢复 `--prompt-file`，`spawnTriageRole` 调用恢复 `promptFile`。 |
| **U3** | 写进 `--prompt-file` 的内容改写：`spawnGenerateRole` 里 `writeFileSync(promptFile, serialized + "\n// mutated", "utf8")` | T3 | T3 generate 侧挂：`expected capturedPromptContent to be serialized` —— 实际内容多了 `\n// mutated` 后缀。**被杀** ✓。还原：`writeFileSync(promptFile, serialized, "utf8")`。 |
| **U4** | spawn 抛错路径不删临时文件：`spawnGenerateRole` 的 `finally` 移除 `rmSync(promptFile, ...)` | T5 的失败侧 | T5 失败侧挂：`spawnProcess` 抛错后 `promptFilePath` 仍存在（`existsSync` 返回 true），`expected false to be true`。**被杀** ✓。还原：`finally` 恢复 `rmSync(promptFile, { force: true })`。 |

每条变异后 `git diff` 复核还原，最终 `git status --porcelain` 为空。✓

### T9：每处删除给出必要性说明

未删除任何代码。仅将语料投递方式从位置参数改为 `--prompt-file` 文件投递，`--input` 的 schema 守卫语义保留不变。`spawnGenerateRole` 和 `spawnTriageRole` 中新增的 `writeFileSync(promptFile, ...)` 与 `rmSync(promptFile, ...)` 是 G7 的投递机制本身，非删除。✓

## 构造的超限语料实际字节数

| 语料类型 | 构造方式 | 实测字节数 |
|---|---|---|
| generate 侧（debater 语料） | 850 条 evidence，每条含 clue_id / anchor / quote（3x repeat）/ claim | **181 177 字节（~177 KB）** |
| triage 侧（triage 语料） | 850 条 proposed_clues，每条含 clue_id / clue_text（5x repeat）/ depth=1 / sources=["wiki"] | **150 692 字节（~147 KB）** |

两者均 > 128 KB（131 072 字节），均能通过 `--prompt-file` 正常投递，argv 中无任何单个参数 ≥ 131 072 字节。

## 改动文件清单

- `src/generate.ts`：`buildGenerateRoleArgv` 改 `--prompt-file`；`spawnGenerateRole` 写语料文件 + `finally` 清理
- `src/tick-run.ts`：`buildTriageArgv` 改 `--prompt-file`；`spawnTriageRole` 写语料文件 + `finally` 清理
- `test/g7-prompt-file.test.ts`：新增 11 个测试（T1–T6）
- `docs/dev-notes/dev_ledr_g7_prompt_file_01.md`：本文件