# G8 —— 生成段 argv 传 `--role` + `--route` 却不传 `--runtime`：agent-run 直接判 CONFIG_ERROR

> 派发方：`line-deep-research`。前置：G7 已合入 main `4836cf6`。
> **Phase 6 真跑当场抓到，是生成段 argv 第一次被真正执行时暴露的。**

---

## 0　生产实况

G7 消除 `E2BIG` 后，生成段第一次真正启动 agent-run，得到：

```
A8c: worker failed to start (/home/uther/.local/bin/agent-run) — exited with code 90.
```

派发方直接复现（`--json`，逐字）：

```json
{"state":"failed","exit_code":90,"exit_reason":"config_error","runtime":"unknown","route":"unknown",
 "stderr_tail":"--role with --runtime or --route alone is not allowed; provide both --runtime and --route to override the role model"}
AGENT_RUN_ERROR code=CONFIG_ERROR detail=--role with --runtime or --route alone is not allowed; …
```

⇒ **`buildGenerateRoleArgv` 产出的 argv 是非法的**：它给了 `--role` 与 `--route`，**却没有 `--runtime`**。
agent-run 要求这两个覆盖参数**同时给或都不给**。

> ### ⛔ 为什么直到现在才暴露
> 生成段的 argv **此前从未被真正执行过**：先是 `runGenerate` 零调用者（G4c(v2) 才接线），
> 接着被 triage 读回缺陷卡住（G5），再被 30 秒等待预算挡住（G6），再被 `E2BIG` 挡住（G7）。
> **每修好一层，下一层才第一次有机会失败。**
> triage 的 argv 一直正常，正因为它**只传 `--role`、不传 `--route`**。

---

## 1　修法：**去掉 `--route`**，档位以 role YAML 为唯一真相

派发方实测 `agent-runtime/profiles/roles/*.yaml`（**已合入 main**，非推断）：

| role | `runtime` | `route` |
|---|---|---|
| `dr-debater-advocate` | `opencode` | **`opus-4-8/ccs`** |
| `dr-debater-opponent` | `opencode` | **`gpt-5.6-sol/ccs`** |
| `dr-debater-judge` | `opencode` | **`ds-v4-pro/ccs`** |
| `dr-synthesizer` | `opencode` | **`opus-5/ccs`** |

⇒ **role 自己已经带全了 runtime 与 route**，且**与 golden-order 拍死的档位逐字一致**
（debater 三条互不相同的中强档；synthesizer 强档）。

⇒ 调用方再传 `--route` **既冗余、又非法**（缺 `--runtime`）。

**要做的**：从 `buildGenerateRoleArgv` 去掉 `--route <route>`，只保留
`--role / --run-id / --input / --prompt-file`（与已正常工作的 triage argv 同形）。

⛔ **不要改成「同时传 `--runtime` 与 `--route`」**：那会把档位变成**两处真相**
（引擎 config 与 role YAML），一旦漂移就是静默用错档——而档位是 golden-order 拍死的东西。
**让 role YAML 做唯一真相。**

### 1.1 ⛔ 随之而来的死字段必须清理

`GenerateConfig` 里那几个 per-role 的 `route` 字段在去掉 `--route` 后**不再有消费者**。
按本仓既有纪律（**不得留一个没有消费者的字段**，G4d 对 `anchorCheckRoute` 就是这么处理的）：
**删掉它们**，并在 dev-note 写明「档位真相已移交 role YAML，并附上表四行实测值」。
既有断言若断的是 argv 里的 route，**随之更新**（属必要删除，须给出说明）。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **V1** | ⭐ **argv 合法**：生产组装出的 generate argv **不含 `--route`**，且含 `--role` / `--run-id` / `--input` / `--prompt-file` | 假 spawn 记 argv，逐项断言；⛔ 这是本包的存在理由 |
| **V2** | ⛔ **四个 role 都走同一形状**：advocate / opponent / judge / synthesizer 的 argv 均无 `--route` | 四条断言 |
| **V3** | ⛔ **无死字段**：`GenerateConfig` 不再保留没有消费者的 `route` 字段；全仓 grep 无悬空引用 | grep + 读到行号 |
| **V4** | triage argv 保持原样（本包不碰，它一直是对的） | 既有断言仍有效 |
| **V5** | ⛔ **断言打在生产组装出的 deps 上**（⛔ 自建 runtime 注入不算数；⛔ 源码字符串匹配不构成证据） | 照 G5/G6/G7 已交付的做法 |
| **V6** | 全量 `npx vitest run` **在干净环境下真绿**。基线：main `4836cf6` 实测 **28 files / 498 tests**，终值两项均不得低于基线 | ⛔ **必须实跑并贴完整尾部输出** |
| **V7** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **V8** | 每处删除给出必要性说明（本包要删 `--route` 与死字段，属必要） | — |

---

## 3　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **W1** | argv 加回 `--route <route>` | **V1 + V2 必须挂**；⛔ 杀不掉即判 V1 零功率 |
| **W2** | 只给 advocate 去掉 `--route`，其余三个保留 | **V2 必须挂**（证明四条都被覆盖，不是只验一条） |
| **W3** | 保留一个没有消费者的 `route` 字段 | **V3 必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 4　⛔ 前几包实付的学费（直接照用）

1. **测试必须驱动生产组装**；⛔ **源码字符串匹配一律不构成证据**。
2. **变异矩阵各行必须是实测**；⛔ **不得编造失败现象**（本线已两次被评审推翻）。
3. **dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit**，**不是 H0 提交**；
   ⛔ 不要为对齐 hash 做额外提交；⛔ 不得用「基线计数方式差异」解释测试数缺口。
4. **贴测试证据要贴完整尾部**（`Test Files` / `Tests` 两行 + 有无 FAIL 段）。
5. **修好一条路径时，必须查同一形状是否还在别处**（本包已查：triage argv 不传 `--route`，无需改）。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 改 `agent-runtime` 或 role YAML | 不同仓；四个 role 的档位**已与 golden-order 一致**，不得改动 |
| 改成同时传 `--runtime` + `--route` | 会造成档位两处真相、静默漂移（见 §1） |
| 改 triage argv | 它一直是对的（只传 `--role`） |
| 改语料投递（`--prompt-file`） | G7 刚交付 |
| 改 `profiles/deploy/*.env` | 归部署方 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 6　交付物落点

- 实现：`src/generate.ts`（`buildGenerateRoleArgv` + `GenerateConfig` 死字段清理 + 相关调用点）
- 测试：`test/g8-role-argv.test.ts`（V1–V5）
- 证据：`docs/dev-notes/dev_ledr_g8_role_argv_01.md`（V1–V8 逐条 + §3 变异三行**实测** + 还原证据 +
  **§1 那张四行档位表**，写明档位真相已移交 role YAML）
