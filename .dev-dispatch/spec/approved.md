# G2b —— triage 接线：把 `spawnTriage()` 从 no-op 接到真实 `dr-triage` role

> 上游依据：`wf-dc0c15` `spec.md`(rev7) §2.2 / §3.1 / §3.2 第 4 步 / §3.4、`golden-order.md` Q6。
> 前置已合入本仓 main `b48157f`（G2a：生成段接线）；`agent-runtime` main `efa7579` 已有 `dr-triage` role。
> **本包是 G2a 的姊妹包**：G2a 接生成段，本包接收集段的 triage。**照 G2a 已合入的 `src/generate.ts` 的既有形状做**，别另发明一套。

---

## 0　现状：`spawnTriage()` 在运行壳里是 no-op

`src/tick.ts` 已能产出 `{ kind: "triage" }` 决策并调 `deps.spawnTriage()`，
但 `src/tick-run.ts:471-473` 写着：

```ts
case "triage":
  // 本包不处理 triage 的 spawn 副作用；triage 决策不写卡，跳过。
  skipped += 1;
  break;
```

⇒ **triage 从未真的被派发过，proposed 卡永远不会被裁走。**

### ⛔ 这不只是「探索面变窄」，它会让终态语义失真

`spec` §3.4 的**正常收敛**条件是 `zeroGrowthRounds ≥ 2` **且** 在途 = 0 **且** `proposed = 0`。
proposed 永不被裁走 ⇒ **`proposed = 0` 永不成立 ⇒ 永远走不到「正常收敛」，只能撞 `maxClues`/`maxDepth` 触顶终止。**
而 §3.4 硬约束「**终态必须区分**：因触顶而停 ≠ 收敛」——
⇒ 现状下**每一次研究的终态都会被标成触顶**，报告的完备性主张随之失真。**本包是 plan §0 终态口径的必要项。**

---

## 1　⛔ 三条必须照做的既有事实（G2a 用三轮 review 换来的，别再踩）

### 1.1 `--input` **只校验、不注入 prompt** —— 语料必须走位置参数

| 位置 | 事实 |
|---|---|
| `agent-runtime/src/dispatch.ts:1107-1108` | `prompt = personaContent + "\n\n" + prompt` —— prompt **只**由 persona + **位置参数**构成 |
| `agent-runtime/src/dispatch.ts:922` | `--input` 只做 `validateJsonSchema(...)`，**校验完就扔** |
| 本仓 `src/generate.ts`（G2a 已合入） | `argv` 以 `"--", serializeCorpusToPositional(corpus)` 结尾 —— **照抄这个形状** |

⇒ 板面快照必须序列化进**位置参数**。**只把它写进 `--input` 文件不算接上。**

### 1.2 ⛔ **跨仓契约必须被断言**（G2a attempt 2 的 blocker，就栽在这）

G2a 曾把 `terminal_marker` 当字符串发，而 `agent-runtime` 的
`synthesizer-input.v1.json` 声明它是 object —— **两边各自按自己那份文档都是对的，错误只在交界处显形**。

⇒ **本包必须有一条断言：引擎组装的 triage 语料，能通过 `agent-runtime/profiles/roles/schemas/triage-input.v1.json`。**
参照 G2a 已合入的 `test/generate.test.ts:507,518` 的做法（含 `AGENT_RUNTIME_PROFILES` env + 回退 + 可用性守卫，**不得硬编码绝对主机路径导致换机器整套变红**）。

### 1.3 ⛔ **不得有「静默零 spawn 的假成功」**

G2a attempt 2 的 major：`spawnProcess` 可选 + `if` 守卫 ⇒ 构造完 argv 静默丢弃却仍返回成功。
⇒ 本包的 spawn 依赖**必填且无条件调用**（照 G2a 已合入的 `src/generate.ts:266,297-298`）。
⇒ 临时 payload 文件在 `finally` 里清理（照 `src/generate.ts:300-302`）。

---

## 2　要做什么

### 2.1 `spawnTriage` 的生产实现

把 `tick-run.ts` 的 `case "triage"` 从 `skipped += 1` 换成真实派发：
`agent-run --role dr-triage --run-id <id> --input <file> -- <序列化的板面快照>`。

**板面快照**（形状必须对齐 `triage-input.v1.json`，见 §1.2）：
```jsonc
{ "question": "<研究主问题>",
  "proposed_clues": [ { "clue_id", "clue_text", "depth"?, "sources"? } ],
  "explored_summaries": [ "<已探索线索的一句话>" ]   // 可选
}
```

### 2.2 收割 `dr-triage.result.v1` 并逐条 CAS

对返回的每条 `{clue_id, action, rationale}`：

| action | 动作 |
|---|---|
| `keep` | CAS `proposed → open` |
| `drop` | CAS `proposed → dropped` |

`rationale` 写进该卡的 `clue.rationale`（版本链留痕，`spec` §2.2）。
⛔ **clue 的唯一写者仍是调度器**——是引擎按 decision 去 CAS，不是 role 直接改卡。

### 2.3 ⛔ 两条必须由引擎侧兜住的校验

**(a) `action` 值域**：`dr-triage-result.v1.json` 里写了 `enum: ["keep","drop"]`，
但 **bus 注册时 `openSchema()` 会把顶层 properties 下一层的 `enum` 剥掉** ⇒ **注册态是裸 `string`，bus 拦不住非法值**。
⇒ **引擎在消费侧必须自己校验值域**；非 `keep`/`drop` ⇒ **响亮拒绝该条**（不静默当 keep、也不当 drop）。

**(b) `clue_id` 越界**：decision 里的 `clue_id` **不在本轮 proposed 集合内** ⇒ **丢弃该条并响亮记录**。
理由：「查得到 ≠ 有权改」。⛔ 不得静默跳过，也不得据此去改一张不该动的卡。

### 2.4 写入预算

triage 的 CAS 写入**计入 `--max-writes` 预算**（与收割一致）；预算不足时**整批跳过并响亮报告**，不做半批。

---

## 3　硬验收（gate 逐条核，缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **T1** | ⛔ **从生产入口出发 + 假 agent-run 记 argv**，断言某条 `clue_text` 的字面**出现在位置参数**（`--` 之后）中 | 只断言 `--input` 被传了**不算数** |
| **T2** | ⛔ **跨仓契约断言**：引擎组装的快照能通过 `agent-runtime/.../triage-input.v1.json` | 路径解析走 env + 回退 + 可用性守卫，**不得硬编码绝对路径** |
| **T3** | `keep` ⇒ CAS `proposed→open`、`drop` ⇒ CAS `proposed→dropped`，且 `rationale` 落到卡上 | 各一条用例 |
| **T4** | ⛔ **非法 `action`（如 `"maybe"`）被响亮拒绝**，既不当 keep 也不当 drop | 判别性用例；这是 §2.3(a) 的唯一执行点 |
| **T5** | ⛔ **越界 `clue_id`（不在本轮 proposed 集合）被丢弃且响亮记录**，且**不改任何卡** | 断言「CAS 调用次数 = 0」 |
| **T6** | 预算不足时**整批跳过并响亮报告**，不做半批 | 正反两例 |
| **T7** | ⛔ **spawn 依赖必填且无条件调用**（无静默零-spawn 假成功）；临时文件在 `finally` 清理 | 读代码到行号 |
| **T8** | 全量 `npx vitest run` 全绿，**文件数与用例数不少于基线 17 / 319** | 贴输出 |
| **T9** | 变异矩阵（§4）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | 贴证据 |
| **T10** | `tests/` 与 `src/` 的每一处删除都给出必要性说明（本包要改 `tick-run.ts` 的 no-op 分支，属必要） | — |

> ⚠️ **本包不要求端到端真跑真 bus**：`dr-triage.result.v1` **尚未注册**（注册在异议窗口后由派发方执行），真发会 422。
> 验收全部落在「接线可判别」上。⛔ **不得为让真跑通过而去注册协议。**

---

## 4　变异矩阵（逐断言归因，不得只报 N/N）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **N1** | 生产路径去掉位置参数里的快照（只留 `--input`） | **T1 必须挂**。⛔ 杀不掉即判 T1 零功率、必须重写 |
| **N2** | 去掉 `action` 值域校验（非法值按 `keep` 处理） | **T4 必须挂** |
| **N3** | 去掉 `clue_id` 越界检查（照单 CAS） | **T5 必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 注册任何 bus 协议 | 不可逆，走公示流程，由派发方在异议窗口后执行 |
| 改 `agent-runtime` | 不同仓。若发现 role/schema 需改，**停下在 review 说明，不跨仓改** |
| 动生成段（`src/generate.ts` 的编排逻辑） | 归 G2a，已合入。本包只在需要复用其既有 helper 时**读它、照它的形状写**，不改它的行为 |
| 改 `bin/deep-research-loop.sh` 的部署配置 | 归 D1 包 |
| 端到端真跑真 bus | 协议未注册，真发必 422；留 Phase 6 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 6　交付物落点

- 实现：`src/tick-run.ts`（triage 分支的生产派发 + 收割 + CAS + 两条校验）、必要时 `src/tick.ts` 的类型扩展
- 测试：`test/tick-run.test.ts` 或新增 `test/g2b-triage-wiring.test.ts`（T1–T7）
- 证据：`docs/dev-notes/dev_ledr_g2b_triage_wiring_01.md`（T1–T10 逐条 + §4 变异矩阵三行 + 还原证据）
