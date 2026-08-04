# A8d —— 把缺省 worker 从占位进程换成**真实 `agent-run`**

> 上游依据：`wf-dc0c15` 的 `spec.md`(rev7) §3.2 第 3 步、§4.1、§4.2。
> 前置已合入 main：链 A 全部 + A7 + A8a + A8b + **A8c**（真实 spawn + 接线判别 N1/N2）。
> 跨仓前置已合入：**A1c**（`agent-run --run-id`）。
> 跨仓并行在飞：**R1c**（worker 输入契约 `deep-research.worker-input/v1`）。

---

## 0　本包关掉的缺口：A8c 交付的是**接线**，不是**真 worker**

A8c 让 tick 真的 spawn 了一个子进程（N1/N2 判别性接线已由变异 V1 验证），
但缺省命令链是
`bin/worker-launcher.sh` → **`bin/worker-placeholder.sh`（`sleep`; `exit 0`）**，
`TICK_WORKER_RUNNER` 是留给部署方的注入口，**当前无人设置**。

⚠️ **这不是 A8c 的过错** —— 我在 A8c 的 spec §7 里明写了「真机验证只到 CAS + spawn 被调用为止」。
**缺口在我的 spec，本包补上。**

### 0.1 ⛔ 占位 worker 造成的实测危害（已在真实总线上观察到）

占位进程**不经 `agent-run`** ⇒ 永不发 `agent.run.started/exited`
⇒ 下一 tick 的回收步查不到 started ⇒ **把刚派出去的卡收回 `open`**。

**实测**：A8c 的 dev-note 记载第二次 `--run` 得到「reclaim 回 open，writes 1，spawns 空」；
gate 独立查真实总线，`research:p02-smoke-1dce60` 现为 `open:1, blocked:1`、**无 in_flight**。
⇒ **dispatch ↔ reclaim 有界震荡，每 tick 写 1 条不可删消息**（bus append-only 无 DELETE）。

**本包落地即消除该震荡**：真实 `agent-run` 会发 started/exited，回收步从此有事实可依。

---

## 1　交付

### 1.1 缺省命令 = 真实 `agent-run`

```
agent-run --role <role> --run-id <runId> --input <payload.json> -- "<clue_text>"
```

逐项理由（**均已实测**，不是照抄文档）：

| 参数 | 为什么必须 |
|---|---|
| `--role <role>` | role 携带 persona / schema / 权限（`spec §4.2`） |
| `--run-id <runId>` | **A1c 新增**。不给则 `agent-run` 自派 UUID ⇒ 与卡里的 run_id 对不上 ⇒ 回收步恒真 ⇒ 回到 A8c 前的死结 |
| `--input <path>` | `dispatch.ts:795` **强制**：role 声明了 `protocol.input` 而不给 `--input` ⇒ `CONTRACT_ERROR` |
| `-- "<clue_text>"` | 位置 prompt = 要调查的问题本身 |

### 1.2 `--input` 的载荷

按 **R1c** 定义的 `deep-research.worker-input/v1`：

```json
{ "clue_id": "<卡的 entity_id>", "clue_text": "<ClueV2.text>",
  "allowed_root": "<可选>", "depth": 0, "sources": ["code-local"] }
```

⛔ **不得含** `attempt_id` / `development_id` / `spec_commit` / `run_id`
（`run_id` 由 `--run-id` 单独传递；放进 input 会成为第二真相源）。

⚠️ **R1c 可能尚未合入** ⇒ 本包**不依赖 agent-runtime 仓的任何文件**，
只按上述形状构造 JSON。**字段形状由 R1c 的硬验收 T3–T6 钉死，不会再变。**

### 1.3 ⛔ `spawnWorker` 的签名必须加宽

现签名 `spawnWorker(clueId, role, runId)` —— **没有 clue 文本**，
而 `--input` 与 prompt 都需要它。必须把 clue 文本（及 depth/sources）传下去。

⛔ **不得**为了省事让 launcher 反过来读 bus 取 clue 文本
——那会让 worker 启动路径多一个网络依赖，且与「先 CAS 成功才 spawn」的顺序无关地引入失败点。

### 1.4 ⛔ `agent-run` 不可解析时必须**响亮失败**

实测其位置为 `/home/uther/.local/bin/agent-run`（在交互 shell 的 PATH 上，
**子进程未必继承**）。

- 允许 `AGENT_RUN_BIN` 覆盖；否则按 PATH 解析
- ⛔ **解析不到 ⇒ 当场响亮失败（非零退出 + 点名 `agent-run`）**，
  ⛔ **绝不静默回退到占位 worker**

> **判据：与「解析不到 secret 不得塞空串」同源。** 静默回退会让调度器看到
> `spawned: true`、卡进 `in_flight`，而实际什么都没跑 —— **正是 A8c 前三次落空的形态。**

### 1.5 占位 worker 的去留

`bin/worker-placeholder.sh` **只保留给测试用**，⛔ **不得再是生产缺省**。
（保留即可，本包不要求删除；但**缺省链路上不许再出现它**。）

---

## 2　⛔ 写入不可回退

agent-bus **append-only、无 DELETE**。

- ⛔ 沿用 A8b/A8c 的 `--max-writes`（默认 5）、channel 无默认值、v1 冻结 channel 拒写
- ⛔ **本包不做真机 `--run`**（理由见 §6）

---

## 3　硬验收（逐条可机械核验）

> **本表已逐条比对 spec 全文的每个 ⛔ 与限定词，含 §0/§1/§2/§6/§7。**
> 本线**三次**因「限定词只在正文、没进验收表」被拒。

| # | 断言 | 怎么验 |
|---|---|---|
| **P1** | ⛔ **生产缺省 argv[0] 解析到真实 `agent-run`**（不是 `bash`、不是占位） | 断言缺省命令解析结果以 `agent-run` 结尾 |
| **P2** | ⛔ **缺省 argv 含 `--run-id` 且其值 === 本次 runId** | 捕获 spawn 的 argv 数组，断言相邻对 `["--run-id", runId]` |
| **P3** | ⛔ **缺省 argv 含 `--role` 且其值 === 映射出的 role** | 同上 |
| **P4** | ⛔ **缺省 argv 含 `--input <path>`，且该文件内容是合法载荷** | 读该文件，断言 `clue_id`/`clue_text` 非空 |
| **P5** | ⛔ **载荷不含** `attempt_id`/`development_id`/`spec_commit`/`run_id` | 读该文件断言四个键均不存在（**否定式**） |
| **P6** | ⛔ **argv 含位置 prompt 且 === clue 文本** | 断言 `--` 之后那一项 |
| **P7** | ⛔ **`bin/worker-placeholder.sh` 不在缺省链路上** | 断言缺省 argv[0] 与全部 args 均不含 `worker-placeholder` |
| **P8** | ⛔ **`agent-run` 解析不到 ⇒ 响亮失败**（非零退出/抛错，错误文本点名 `agent-run`） | 把 `AGENT_RUN_BIN` 指到不存在路径 + 清空 PATH ⇒ 断言抛错且文本含 `agent-run` |
| **P9** | ⛔ **解析不到时绝不回退占位** | 同 P8 情形下断言**未启动任何进程**、**未产生 `spawned: true`**（安全性）；配 P1「正常时确实解析到」（活性） |
| **P10** | ⛔ `AGENT_RUN_BIN` 覆盖生效 | 指向一个可执行桩 ⇒ 断言 argv[0] 是该桩 |
| **P11** | ⛔ `spawnWorker` 已加宽且**真的把 clue 文本传到了 argv**（不是取到了但没用） | 构造两条**只差 clue 文本**的卡 ⇒ 断言两次 argv 的 prompt 不同（**判别性**） |
| **P12** | ⛔ A8c 的 N1/N2 接线判别**仍成立** | 原用例仍在且仍通过 |
| **P13** | ⛔ `--selfcheck` 仍保留且仍无副作用 | exit 0 且零网络请求 |
| **P14** | ⛔ `--max-writes` 默认 5 仍生效；v1 冻结 channel 仍拒写、零请求 | 沿用既有用例 |
| **P15** | ⛔ 不得触碰 `.dd-evidence/` | **actor 提交**文件面不含 |
| **P16** | typecheck + 全量测试 | 均 exit 0 |
| **P17** | ⛔ 既有 **196** 条用例**一条不删** | `git diff` 无 `it(`/`test(` 净减少 |
| **P18** | 证据写 `docs/dev-notes/<development_id>.md` | 存在；仓根**无** `IMPLEMENTATION_SUMMARY.md` |

---

## 4　变异自检（必须逐断言归因）

| 变异 | 必须杀死 |
|---|---|
| **W1** 缺省命令改回占位 `worker-placeholder.sh` | **P1 与 P7** |
| **W2** argv 里去掉 `--run-id` | **P2** |
| **W3** argv 里去掉 `--input` | **P4** |
| **W4** 载荷里加回 `run_id` | **P5** |
| **W5** `agent-run` 解析不到时回退占位而非报错 | **P8 与 P9** |
| **W6** prompt 恒为常量（不随 clue 文本变） | **P11**（fallback 链只变异 `b` 证明不了任何事 —— 这条必须变异**主路径**） |

> **只报「N/N 挂了」不算数。** 本线曾第一次变异跑出 10/10 差点签字，
> 去看挂的是哪几条才发现核心那条断言全程存活。
> **破坏后必须回显被改的那一行**，跑完逐字还原。
>
> ⚠️ **变异后的还原必须被验证，不能假设它跑了**：本 gate 曾因命令超时把变异留在工作区，
> 下一次「基线」带着变异跑。**每次还原后 `git diff --stat` 确认干净。**

### 4.1 ⚠️ 本线学费换来的十条纪律

1. 打桩不得让两次读返回相同的值。
2. `describe` 块名**不得枚举多个判据 ID**（一个 describe 一个判据）。
3. **安全性断言必须配活性断言**（P9 的「不回退」必须配 P1 的「正常时确实解析到」）。
4. 凡本包必须实现的能力，验收行须对**纯数据 / 真实文件**求值。
5. 断言的作用域必须收窄到被测对象。
6. `a ?? b` 的 fallback 链，**只变异 `b` 什么也证明不了**（见 W6）。
7. **两个只差一项输入的用例，才构成判别性证据**（P11 正是这条）。
8. **一条不变量在某一层被守住，不构成它在别的层也被守住。**
9. ⛔ **凡「注入 dep」的验收，必须额外验证生产路径注入的是真实现** ——
   **本包就是为补这一条而存在**：A8c 的注入面全对，缺省实现是占位。
10. ⛔ **「形式满足、实质落空」连挂 3 次 ⇒ 先怀疑判据不可满足**，而不是继续加严验收。
    （A8c 前三次落空的真因是 `--run-id` 当时不存在，结解不开。）

---

## 5　⛔ 派发面硬约束

- `setup_commands` 含 `npm ci`（**本仓用 npm，有 `package-lock.json`**；agent-runtime 那个仓用 bun，别混）
- `.dd-evidence/` 是 dd 保留路径，**actor 任何提交碰它都是硬失败**（重试无用）。
  ⛔ 仓内属于别的 development 的陈旧 `acceptance.json` **是正常的**，随 H0 从 main 继承，
  **不是本包的问题、也不该由本包修** —— dd 会自行生成新证据、自行消解。
  **若 reviewer 就此提 finding，正确回应是说明不在 scope，而不是去动那个文件。**
- ⚠️ **若 reviewer 声称「这个环境里没有某文件」，可能是假阳性**：
  R1a 曾被断言 `/usr/local/bin/lark-cli` 不存在，而生产环境三重实测**它存在且可执行**
  （其 harness 文件系统视图与宿主不同）。**不要为「修」一个不存在的问题而改坏已正确的值。**
  ⇒ **本包尤其相关**：`agent-run` 在 `/home/uther/.local/bin/agent-run`，
  reviewer 的 harness 里**很可能看不到它**。**这不构成把缺省改回占位的理由**（那正是 W1 变异）。

---

## 6　非目标

- ⛔ **不做真机 `--run`**：`worker.result.v1` **仍未在 bus 注册**，
  真实 worker 一产出就会 422 ⇒ `CONTRACT_ERROR` ⇒ 卡被重试后 `blocked`。
  **真机端到端属 V1，须等注册完成。**（这是本包唯一不做真机验证的理由，**不是偷懒**。）
- ⛔ **不注册任何协议**（注册不可逆，另有两条前置义务）
- ⛔ **不实现收割**（读 `worker.result.v1` → 转 `research.evidence.v2` → 回写，属 **A8e**）
- ⛔ 不实现 `dr-worker-web`（`spec §4.3` 机制未定）
- 不做 triage / synthesizer / debater 的派发（属 R2 之后）
- 不改 `src/protocol.ts`；不改既有导出签名，确需新增则**新增**
- ⛔ **不得绕过 A8b 的 `realCas` 另写 CAS**

---

## 7　环境

- `setup_commands`: `npm ci`；校验 `npm run typecheck` + `npm test`
- 缺省 `agent-run` 实测位置 `/home/uther/.local/bin/agent-run`（`--help` 中已含 `--run-id`）
- ⛔ **不得把任何真实 secret 值写进代码 / 测试 / dev-notes**
- ⛔ **测试不得写真实 vault、真实 MinerU、真实 bus**
