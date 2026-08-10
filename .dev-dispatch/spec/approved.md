# G7 —— 语料走位置参数，撞上 Linux 单参数 128 KB 上限：真实规模下生成段必 `spawn E2BIG`

> 派发方：`line-deep-research`。前置：G6 已合入 main `5911882`。
> **Phase 6 真跑当场抓到，证据全部实测。**

---

## 0　生产实况

研究「agent harness」跑到终态（**64 线索：53 explored / 11 dropped，`termination.state = "capped"`**，
证据 channel **424 条**）后，生成段每次触发都失败：

```
$ ./bin/tick-entry.sh --run research:agent-harness.index … --origin dr-agent-harness-20260810 …
spawn E2BIG
```

### 实测数字（不是估计）

| 量 | 实测 |
|---|---|
| 证据语料序列化后 | **262 001 字节（256 KB）** |
| `getconf ARG_MAX` | **2 097 152（2 MB）** |
| Linux **单个参数**上限 `MAX_ARG_STRLEN` | **131 072（128 KB）** = `PAGE_SIZE × 32` |

⇒ **总量没超 `ARG_MAX`，撞的是「单参数 128 KB」这条**：语料作为**一个** positional 参数是它的 **2 倍**。

> ⛔ **不要按 `ARG_MAX` 去推**（我第一反应也是它，被实测否掉了）：
> 256 KB < 2 MB，看 `ARG_MAX` 会得出「没超」的错误结论。**真正的天花板是单参数 128 KB。**

### ⛔ 这不是冗余代码，是设计约束

`src/generate.ts:246-247` 逐字：

> `--input` **只作 schema 守卫（校验完就扔、从不注入 prompt）**，⛔ **语料正文必须走位置参数**。

⇒ 语料**只能**经 positional 到达 agent 的任务文本，`--input` 到不了 prompt。
⇒ **128 KB 就是这条投递机制对语料体量的硬天花板**，而真实研究在 424 条证据处已是它的 2 倍。
**删掉 positional 不是修复**——那样 agent 收不到语料。

---

## 1　修法：改用 `--prompt-file`（agent-run 已支持，派发方读过源码）

`agent-runtime/src/cli.ts:122-123` 与 `src/dispatch.ts:1097-1098` 逐字：

```
--prompt-file <path>    Read prompt from file
...
if (args.promptFile) { prompt = readFileSync(args.promptFile, "utf-8").trim(); }
```

⇒ **`--prompt-file` 的内容直接成为 prompt**（与 `--input` 的「校验完就扔」根本不同）。
⇒ 走文件投递**完全没有 argv 长度上限**。

**要做的**：把 `buildGenerateRoleArgv` 与 `buildTriageArgv` 里那个装序列化语料的**位置参数**，
换成 `--prompt-file <path>`，文件内容 = 原本要放进位置参数的**同一段序列化文本**（⛔ 逐字相同，不得趁机改格式）。

- `--input` 的 schema 守卫语义**保留不变**（它有独立作用）。
- 载荷文件寿命照既有做法：用后即删（`finally` 清理），⛔ 不得泄漏到 `/tmp`。
- ⛔ **两条路径都要改**：triage 现在语料小、尚未撞限，但**机制完全相同**，
  板面一大就会以同样方式失败。**只改生成段等于把同一个坑留给下一次真跑**（G6 刚付过这个学费）。

⚠️ **不要用「多个位置参数分块」的方案**：`agent-runtime/src/cli.ts:70` 是
`args.prompt = argv.slice(i + 1).join(" ")` —— **用空格拼接**，分块会在每个边界插入空格、破坏 JSON。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **T1** | ⭐ **超限语料能跑通**：构造 **> 128 KB**（如 300 KB）的语料 ⇒ 生产 argv 中**没有任何单个参数 ≥ 131072 字节**，且语料**逐字**出现在 `--prompt-file` 指向的文件里 | 假 spawn 记 argv + 读文件比对；⛔ 这是本包的存在理由 |
| **T2** | ⛔ **两条路径都改**：generate 与 triage 的 argv **都**用 `--prompt-file`，**都**无超限位置参数 | 分别断言；⛔ 只改一条不算完成 |
| **T3** | ⛔ **语料内容逐字不变**：`--prompt-file` 文件内容 === 原 `serializeCorpusToPositional` 的输出 | 断言字符串相等 |
| **T4** | `--input` 的 schema 守卫仍在（既有语义不得削弱） | 读到行号 + 既有断言仍有效 |
| **T5** | ⛔ **载荷文件用后即删**：spawn 后（无论成功失败）临时文件不残留 | 正反两例（含 spawn 抛错的路径） |
| **T6** | ⛔ **断言打在生产组装出的 deps 上**（注入分支会跳过生产装配；⛔ 自建 runtime 注入的用例不算数；⛔ 源码字符串匹配一律不构成证据） | 照 G5/G6 已交付的做法 |
| **T7** | 全量 `npx vitest run` **在干净环境下真绿**（`ANCHOR_CHECK_BIN`/`DOC_CHANNEL`/`RESEARCH_ORIGIN`/`EXPORT_ROOT`/`AGENT_RESULT_*` 均未设置）。基线：main `5911882` 实测 **27 files / 487 tests**，终值两项均不得低于基线 | ⛔ **必须实跑并贴完整尾部输出** |
| **T8** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **T9** | 每处删除给出必要性说明（本包要删「语料进位置参数」那一处，属必要——它正是缺陷本身） | — |

---

## 3　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **U1** | generate argv 改回「语料进位置参数」 | **T1 + T2 的 generate 侧必须挂**；⛔ 杀不掉即判 T1 零功率 |
| **U2** | triage argv 改回「语料进位置参数」 | **T2 的 triage 侧必须挂** |
| **U3** | 写进 `--prompt-file` 的内容做任意改写（如 `JSON.stringify(JSON.parse(x))`） | **T3 必须挂** |
| **U4** | spawn 抛错路径不删临时文件 | **T5 的失败侧必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 4　⛔ 前几包实付的学费（直接照用）

1. **测试必须驱动生产组装**；⛔ **源码字符串匹配一律不构成证据**。
2. **变异矩阵各行必须是实测**：某行杀不掉就如实写「未被杀」并说明，⛔ **不得编造失败现象**
   （本线已两次出现 dev-note 报告结构上不可能发生的击杀，均被评审逐条推翻）。
3. **dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit**，**不是 H0 提交**；
   ⛔ 不要为对齐 hash 做额外提交；⛔ 不得用「基线计数方式差异」解释测试数缺口。
4. **贴测试证据要贴完整尾部**（`Test Files` / `Tests` 两行 + 有无 FAIL 段）。
5. **修好一条路径时，必须查同一形状是否还存在于别处**（G6 的 S1 变异就是为这条设的回归守卫）。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 改 `agent-runtime` | 不同仓；`--prompt-file` **已存在**，本包只是改用它 |
| 裁剪/抽样语料以塞进 128 KB | ⛔ 那是静默丢证据 —— 本线一路在打的正是这个 |
| 多位置参数分块 | `cli.ts:70` 用空格 `join`，会破坏 JSON（见 §1 警告） |
| 改 `--input` 的 schema 守卫语义 | 有独立作用，不得削弱 |
| 改语料的**内容/结构** | 本包只改**投递方式**，⛔ 内容逐字不变（T3） |
| 改 `profiles/deploy/*.env` | 归部署方 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 6　交付物落点

- 实现：`src/generate.ts`（`buildGenerateRoleArgv` + `spawnGenerateRole`）、
  `src/tick-run.ts`（`buildTriageArgv` + `spawnTriageRole`）
- 测试：`test/g7-prompt-file.test.ts`（T1–T6）
- 证据：`docs/dev-notes/dev_ledr_g7_prompt_file_01.md`（T1–T9 逐条 + §3 变异四行**实测** + 还原证据 +
  **你构造的超限语料实际字节数**）
