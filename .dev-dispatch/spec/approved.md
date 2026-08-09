# G4e —— 播种入口：一次没有播种的运行会**安静地成功退出**

> 派发方：`line-deep-research`。前置：G4d(v2) 已合入 main `3f6e8ce`。

---

## ⛔ 先读：前几包实付的学费 + 本包必须一并收掉的两条尾巴

### A. 测试必须驱动**生产**的组装，不能各自注入 stub
`runChannelWrite` 在 `opts.generateDeps` 存在时走注入分支、**完全跳过 `assembleGenerateDeps`**。
前面三个包都栽在这里（「验收项看着有、变异杀不掉」）。
**已交付的正确机制：`assembleGenerateDeps` 是导出函数**，用例可直接调用它拿生产 deps 再断言。
⛔ 凡涉及生产行为的验收项一律照此写。

### B. ⛔ 源码字符串匹配一律不算数
`expect(source).toContain("--seed")` / `readFileSync(测试文件).toContain(...)` 这类断言**不构成任何证据**。
本包所有验收项必须打在**行为**上（假 bus 记录 publish 调用、假子进程记 argv、进程退出码等）。

### C. `workflow.yaml` 新增的可选 pipeline input 必须带 `?`
既有正确写法 `"{{evidence_channel?}}"`；缺 `?` 会让值为空时模板按必填渲染、tick 节点报错，
**而 loop 照报 `drained` 且 exit 0**（曾致一个包在 dd acceptance 上判死）。
验收须在相关 env 均未设置的**干净环境**下跑全量。

### D. ⛔ 本包必须一并收掉的两条尾巴（G4d(v2) gate 记录的非阻断缺陷）

**D1 —— anchor-check 落盘失败当前完全不可见。**
`src/generate.ts` 落盘失败被 catch 后只写了 `anchorJsonWritten = false`，**该变量此后从未被使用**；
`renderReportHead(marker, anchorRate, anchorTail)` 只接 `anchorTail`（用于 `sums_ok=false` / `no-repo-root`）。
⇒ spec 要求的「落盘失败**不阻断导出、但必须可见**」只做到了前半句。
**本包必须让落盘失败在报告头部（或落盘件）可见，并配一条判别性用例**（令落盘抛错 ⇒ 断言头部出现该标记）。
⛔ 不得只是把变量删掉了事——那是把「不可见」变成「不存在」。

**D2 —— 删掉 `test/g4d-anchor-check.test.ts` 里那条零功率的 V10 用例。**
它 `readFileSync` 另一个测试文件再 `toContain("msg-nonexistent")`，是被明令禁止的源码字符串匹配。
它守护的属性已由 `test/g4c-generate-wiring.test.ts` 中真正的判别性用例覆盖
（驱动生产 `assembleGenerateDeps` + `rejects.toThrow(/cannot find doc message/)`），**故该 V10 用例是纯冗余**。
⇒ **删除它**，并在 dev-note 说明（零功率检查比没有更坏：它会让后来者以为这条被守着）。

---

## 0　现状：没有任何生产入口能把初始线索放上板

| 事实 | 证据 |
|---|---|
| `tick-entry` 只有四个子命令 | `src/tick-entry.ts:82-114`：`--help` / `--selfcheck` / `--inspect` / `--run`，**没有播种** |
| `publishClue` 存在但只被派生路径用 | `src/bus.ts:124` 定义；调用者只有 `harvest.ts:350`（从 worker 结果派生新 clue）与 `scripts/smoke-cas.ts`（测试夹具） |
| npm scripts 里也没有 | `tick` / `tick:help` / `tick:selfcheck` / `deep-research:dry-run` / `smoke:cas` |

### ⛔ 失败形态：安静地成功

板空 ⇒ `claimableCount()` 恒 0 ⇒ 循环立刻 drain、**exit 0**、看起来「跑完了」。
> 与本线反复出现的「空结果不像失败」同族：**一次没有播种的研究，从外面看和一次瞬间收敛的研究一模一样。**

---

## 1　要做什么

**新增一个显式的播种入口**，把「研究主问题 + 3–6 条初始线索」发到板 channel。

形状（**实现方可调整命名，但三件事必须齐**：显式子命令 / 幂等 / 响亮失败）：
```
tick-entry --seed <channel_id> --clue "<线索文本>" [--clue "<线索文本>" …] [--source <name> …]
```
或等价的 `bin/` 入口。每条线索发一条 `research.clue.v2`，`status: "open"`、`depth: 0`。

⛔ **复用 `src/bus.ts` 的 `publishClue`**，不要另写发布路径。

### 1.1 ⛔ 幂等：重复播种不得翻倍

`publishClue` 已收 idempotency key（`bus.ts:124`）。
⇒ 播种的 key 必须**由输入确定性派生**（如 `dr-seed:<channel>:<index>:<clue 文本 digest>`），
使**同一组线索重播两次 ⇒ bus 侧去重、板上仍是那几张卡**。

> **理由**：bus **append-only 无 DELETE**。播种是不可回退的写入，
> 而部署/重试场景下人一定会重跑一次。⛔ **靠「记得别跑两次」不是保障。**

### 1.2 ⛔ 不得隐式建 channel

channel 不存在时 bus 返回 **404**（派发方实测：`GET /v1/channels/<不存在>/messages` ⇒ `NOT_FOUND`）。
⇒ 播种入口遇到不存在的 channel **必须响亮失败并点名**，
⛔ **不得自动创建** —— 建 channel 是**不可回退的部署动作**，必须是人/部署方的显式决定，不是播种的副作用。

### 1.3 ⛔ 空线索集响亮失败

未给任何 `--clue` ⇒ 非零退出并点名。
⛔ 不得「播种 0 条并返回成功」——那正是 §0 描述的那种安静成功。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **X1** | ⭐ **从生产入口出发**，给定 N 条线索 ⇒ **真的发出 N 条 `research.clue.v2`**，且每条 payload 的文本**逐字**等于输入、`status === "open"`、`depth === 0` | 假 bus 记录 publish 调用；⛔ 只断言「函数被调用」不算数 |
| **X2** | ⛔ **幂等**：同一组线索**连播两次** ⇒ 板上仍是 N 张（idempotency key 由输入确定性派生，两次相同） | 断言两次的 key 序列逐字相同 |
| **X3** | ⛔ **channel 不存在 ⇒ 响亮失败并点名**，⛔ **不得自动创建**（断言「创建 channel 的调用次数 = 0」） | 判别性用例 |
| **X4** | ⛔ **零线索 ⇒ 非零退出并点名**，不得「播 0 条并成功」 | 正反两例 |
| **X5** | 入口在 `--help` / usage 里可见；npm script 或 `bin/` 有对应入口（部署方按文档能找到它） | 读文档到行号 |
| **X6** | 全量 `npx vitest run` 全绿，文件数/用例数不少于**基线（以 G4d 合入后的 main 实测为准，自己先跑一次记下来）** | 贴输出 |
| **X7** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **X8** | `src/`、`test/` 的每处删除给出必要性说明 | — |

> ⚠️ **本包不要求向真实 bus 播种**：真播是不可回退写入，归 Phase 6 由派发方在已核验的 channel 上做。
> ⛔ **不得为了「验证一下」往任何真实 channel 播种。**

---

## 3　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **Y1** | 让 idempotency key 含随机/时间成分（每次不同） | **X2 必须挂** |
| **Y2** | channel 不存在时自动创建再播 | **X3 必须挂** |
| **Y3** | 零线索时返回成功（播 0 条） | **X4 的失败侧必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 4　显式不做

| 不做 | 理由 |
|---|---|
| 向真实 bus 播种 | 不可回退；归 Phase 6，由派发方在已核验 channel 上做 |
| 创建 channel | **不可回退的部署动作**，必须是显式决定，不是播种副作用 |
| 改 `profiles/deploy/*.env` 的题目与 channel 取值 | 归 **D2** |
| 改收集段/生成段任何编排逻辑 | 已合入，本包只加入口 |
| 注册任何 bus 协议 | 不可逆，走公示流程 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 5　交付物落点

- 实现：`src/tick-entry.ts`（子命令）、`src/`（播种逻辑，复用 `bus.ts` 的 `publishClue`）、
  必要时 `bin/` 与 `package.json` 的 script
- 测试：`test/g4e-seed.test.ts`（X1–X5）
- 证据：`docs/dev-notes/dev_ledr_g4e_seed_01.md`（X1–X8 逐条 + §3 变异三行 + 还原证据）

> **dev-note 的 `input_commit` 记本次 implement attempt 的 input_commit**（该字段本来的语义）。
> 真正的要求是**正文描述交付物本身**；若中途 rework 改了实现，正文数字与结论同步更新。
> ⛔ **不要为对齐 commit hash 做额外提交。**
