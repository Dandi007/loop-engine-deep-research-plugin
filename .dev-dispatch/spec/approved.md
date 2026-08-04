# A7 —— plugin 装配：把链 A 的六个能力包接成可启动的 loop-engine plugin

> 上游依据：work folder `wf-dc0c15` 的 `spec.md`(rev7) §3、§1，`golden-order.md`（2026-08-04 16:50）。
> **本包是 `plan.md` 链 A 分解里缺失的一步**，由监督者在链 A 六包合入后补入。
> 前置已全部合入 main（`a4b14d0`，127/127 绿）：
> `src/{protocol,bus,tick,generate,ingest,mineru,export}.ts`。

---

## 0　本包为什么存在

链 A 的六个包（S1b/S2/S3/S4/N1/N3）**每一个都验到位了，但交付的全是库模块**：
`main` 上只有 7 个 `src/*.ts`，**没有 `workflows/`、`bin/`、`contracts/`，
`package.json` 也无 `main`/`bin`/`exports`**。

loop-engine 按 `plugin_id` + `plugin_version` + `manifest` 加载
（`loop-engine/src/plugin-worker.ts:392-401`）——**本仓当前没有任何可被它加载的东西**。

> ### 判据：一份按能力切分的 plan，若没有显式的「装配」包，
> ### 每个包都完成 ≠ 整体可运行。
>
> 能力包的 DoD 天然是「这段逻辑对不对」，**没有任何一个会失败于「它没被接上」**；
> 而每个包的 gate 都会**正确地**判定装配不在自己 scope 内。
> **⇒ 本包的 DoD 必须是「外部可启动」，不是「某模块行为正确」。**

---

## 1　⛔ 架构裁定：不得把 clue 状态放进 loop-engine 的 store

loop-engine 的原生 pipeline 模型用 **`store_dir` 文件态认领**
（`claim: {store_dir, from, to, by, staleMs, complete, bind}`，见
`loop-engine-dev-dispatch-plugin/workflows/deterministic/fleet.yaml.tpl`）。

⛔ **deep-research 不得使用它承载 clue 状态。**

`golden-order.md`（用户拍板，2026-08-04）：
> **数据持久化归宿是 agent-bus —— FS 可用作临时/工作面，但 bus 是 SSoT，
> 不存在第二份需要同步的真相。**

`spec.md §2.2`：clue 的**唯一写者是调度器**，状态迁移即 bus 上实体版本链的 revision。
S2 已实现「先 bus CAS 改卡、成功才 spawn」的认领原语并有变异守卫。

**⇒ loop-engine 在本设计里只提供三样：**
1. **周期驱动**（把 tick 反复叫起来）
2. **命名 lock**（`synthesizer` / `triage` 单例，`spec.md §3.6`）
3. **崩溃恢复**（引擎重启后继续 tick；卡的回收逻辑已在 S2 的回收步实现）

**把 clue 状态复制进 `store_dir` 会立刻制造「第二份需要同步的真相」，是本设计明确要消灭的东西。**

---

## 2　交付范围

| 交付 | 说明 |
|---|---|
| **可执行入口** | 让 `src/*.ts` 能被 bash harness 调起。**运行方式自选**（`tsc` 产出 `dist/` 后 `node`，或用已在 devDependencies 的 `vitest`/`vite-node`），但**必须在 `npm ci` 后的干净环境下可用** |
| `workflows/deep-research/fleet.yaml.tpl` | fleet 定义：`max_passes` + `pipelines[]` |
| `workflows/deep-research/tick/workflow.yaml` | 节点定义：`limits` / `harness` / `seed` |
| `workflows/deep-research/tick/templates/tick.md` | 可执行体（bash harness），调起 tick 入口 |
| `bin/deep-research-loop.sh` | 驱动脚本：渲染 tpl → 调 loop-engine CLI |
| `package.json` | 补 `exports`（或 `main`）与必要的 `scripts` |

**参考形状**（**不作为交付、不得照抄内容**，只看结构）：
`/data/code/self/loop-engine-dev-dispatch-plugin/{workflows,bin,package.json}`。

---

## 3　⛔ 本包不连真实 bus、不跑真实研究

- ⛔ **不得对真实 agent-bus 发起任何写入**（append-only、无 DELETE，不可回退）
- ⛔ **不得对真实 MinerU 发起转写**
- ⛔ **不得向真实 vault（`/data/vault`）写文件**
- **真实启动（连 bus 跑一个完整 tick）属 V1**，本包**不做、也不得声称做到**

> 本包证明的是「**接线存在且能解析**」，**不是**「它真的跑通了」。
> 这两件事必须在验收里被分开陈述——
> 本线已多次栽在「把没验过的东西记成验过了」上。

---

## 4　硬验收（逐条可机械核验）

> **本表已逐条比对 spec 全文的每个 ⛔ 与限定词，包括 §0、§3、§7、§8。**
> 前面的包**三次**因「限定词只在正文、没进验收表」被拒，
> 第三次那条恰恰藏在「环境」节里。

| # | 断言 | 怎么验 |
|---|---|---|
| **G1** | ⛔ `bin/deep-research-loop.sh --dry-run` **exit 0**，且**全程不发出任何网络请求** | 在 `npm ci` 后的干净仓内执行；断言 exit 0。网络面：脚本 `--dry-run` 分支内 `grep` 不得出现 `curl`/`wget`/`fetch` |
| **G2** | ⛔ 渲染后的 fleet **是合法 YAML** 且含 `max_passes` 与非空 `pipelines` | `--dry-run` 打印渲染结果；用 node 解析并断言字段 |
| **G3** | ⛔ 渲染后每个 `config_dir` **真实存在**且含 `workflow.yaml` | 逐个 `fs.existsSync` 断言 |
| **G4** | ⛔ `workflow.yaml` 里 `seed[].template` 指向的模板文件**真实存在** | 同上 |
| **G5** | ⛔ **不得出现 `claim.store_dir` 承载 clue 状态** | 渲染后的 fleet 中，**任何 pipeline 的 `claim` 块不得引用 clue/board 语义的 store**；`grep -riE "clue.*store_dir\|store_dir.*clue"` 零命中 |
| **G6** | ⛔ tick 入口**在干净环境下可被调起** | `npm ci` 后执行入口的 `--help`（或等价的无副作用调用），断言 exit 0 |
| **G7** | ⛔ tick 入口的无副作用调用**不触碰 bus** | 该调用期间对 `127.0.0.1:7490` 零请求（可用打桩/环境变量指向不可达地址并断言不因此失败） |
| **G8** | `package.json` 暴露入口 | 断言存在 `exports` 或 `main`，且其指向的路径真实存在 |
| **G9** | ⛔ 复用既有模块，**不重新实现** | `grep` 确认 tick 入口 import 了 `./tick`；且**未新增** `decideTick`/`decideTermination`/`runGenerate` 的第二份实现（`grep -c` 各为 1） |
| **G10** | ⛔ **不得触碰 `.dd-evidence/`** | `git diff --name-only <base>..HEAD -- .dd-evidence/` **必须为空** |
| **G11** | 运行证据写 `docs/dev-notes/<development_id>.md` | 该文件存在；仓根**无** `IMPLEMENTATION_SUMMARY.md` |
| **G12** | 全量测试与类型检查通过 | `npm run typecheck` 与 `npm test` 均 exit 0 |
| **G13** | 既有 127 条用例**一行未删** | `git diff` 中既有测试文件无 `it(` 净减少 |

---

## 5　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **U1** fleet 里某个 `config_dir` 改成不存在的路径 | **G3** |
| **U2** `workflow.yaml` 的 `seed[].template` 改成不存在的名字 | **G4** |
| **U3** 给某 pipeline 加一个承载 clue 状态的 `claim.store_dir` | **G5** |
| **U4** `package.json` 的 `exports` 指向不存在的文件 | **G8** |
| **U5** tick 入口改成自己重写一份 `decideTick` 而非 import | **G9** |
| **U6** `--dry-run` 分支里加一次真实网络请求 | **G1** |

> **只报「N/N 挂了」不算数。** 本线曾第一次变异跑出 10/10 差点签字，
> 去看挂的是哪几条才发现**核心那条断言全程存活**。
> **变异杀死的断言集合，必须与该变异所模拟的缺陷对得上。**
> **破坏后必须回显被改的那一行**，跑完逐字还原。

### 5.1 ⚠️ 打桩与命名纪律（本线学费换来的五条，逐条适用）

1. **打桩不得让两次读返回相同的值**——「读了一次」与「读了两次」若产出相同观测值，
   断言无法区分，**测的是 stub 的确定性而非被测代码的行为**。
2. **describe 块名不得枚举多个判据 ID**（如 `(G1/G2/G3)`）——块名污染块内每条用例全名，
   让基于测试名的自动归因**跨断言误配**，产生「变异 ✓」的假阳性。**一个 describe 一个判据。**
3. **安全性断言必须配活性断言**——「不发生坏事」可被「什么都不做」满足。
   G7「不触碰 bus」必须同时断言**该调用确实执行并成功返回**，否则「直接崩掉」也能通过。
4. ⛔ **凡本包必须实现的能力，验收行必须对纯数据/真实文件求值，
   不得只经打桩的依赖验证**——依赖注入会让核心逻辑**可以不存在而测试全绿**（N1 的教训）。
   G3/G4 即为此设：断言的是**磁盘上真实存在的文件**。
5. ⛔ **断言的作用域必须收窄到被测对象**——对「整份产物」断言某片段存在，
   无法区分它来自 A 还是来自 B（N3 的教训：导出件里 body 自带标记，
   使 header 的断言恒真）。G2/G3 应断言**渲染结果里的具体字段**，不是整个文件文本。

---

## 6　⛔ 派发面硬约束

### 6.1 `.dd-evidence/` 是 dd 保留路径，碰它即硬失败

机制（`attempt_controller.py:892-914`）：dd 对
`git log --raw {input_commit}..{work_head_commit} -- .dd-evidence/acceptance.json`
取输出，**非空即抛 `ACTOR_ACCEPTANCE_PATH_CHANGED`**，**且重试无用**。

> ⛔ **不得修改/删除/重建 `.dd-evidence/` 下任何文件。**
>
> ⛔ **仓内出现属于别的 development 的陈旧 `acceptance.json` 是正常的**——它随 H0 从 main 继承。
> **它不是本包的问题，也不该由本包修**：dd 会在本包 acceptance 阶段**自己生成新证据**，
> 该问题**会自行消解**。
> **若 reviewer 就此提出 finding，正确的回应是说明它不在本包 scope —— 而不是去动那个文件。**
> 上一条 development 正是「照着一条正确的 finding 做了一个被禁止的动作」而被 cancel。

### 6.2 运行证据写 `docs/dev-notes/<development_id>.md`

⛔ **不得新建或复用仓根 `IMPLEMENTATION_SUMMARY.md`**。
文件名必须带 `development_id`——**让路径携带归属**，结构上不可能变成无主债。

---

## 7　非目标

- **不实现 worker / role 定义**（属链 C）
- **不改** `src/protocol.ts`（协议已在 agent-bus 上不可逆注册）
- **不改** S1b/S2/S3/S4/N1/N3 已交付模块的既有导出签名；确需新增则**新增**
- **不做真实端到端运行**（属 V1，且阻断于「第一个研究题目」尚未给定）
- 不做 `SKILL.md` 重写与 `workflow.js` 退役（属链 B 的 R4，在本包之后）
- 不做 loop-engine 侧的 plugin 注册/发布（本包只产出仓内的可加载形态）

---

## 8　环境

- `setup_commands` 必须含 `npm ci`
- 现有 devDependencies：`typescript` / `vitest` / `@types/node`。
  **允许新增 devDependency**（若确需构建工具）；`vite-node` 随 `vitest` 已可用。
- ⛔ **node 不支持 `--experimental-strip-types`**：本机实测抛
  `ERR_NO_TYPESCRIPT: Node.js is not compiled with TypeScript support`（node v22.22.1）。
  **不要走这条路。**
- loop-engine CLI 位于 `/data/code/self/loop-engine/dist/cli.js`；
  其 ESM 需配套 extension-loader（见参考 plugin 的 `bin/dev-dispatch-loop.sh` 注释）。
  **本包的 `--dry-run` 不得依赖 loop-engine CLI 真实可执行**——只渲染与校验。
