# D2 —— 把部署 profile 换成**真实且已核验**的一组，并修掉一句不实注释

> 派发方：`line-deep-research`。前置：G4e 已合入 main `e5a628b`。

---

## ⛔ 先读：前几包实付的学费

- **A. 测试必须驱动生产**：`assembleGenerateDeps` 是导出函数，用例可直接调它拿生产 deps。
  ⛔ **源码字符串匹配（`expect(source).toContain(...)` / `readFileSync(测试文件)`）一律不构成证据。**
- **B. `workflow.yaml` 新增的可选 pipeline input 必须带 `?`**（既有写法 `"{{evidence_channel?}}"`）；
  缺 `?` 会让值为空时按必填渲染、tick 节点报错，**而 loop 照报 `drained` 且 exit 0**。
- **C. 验收须在相关 env 均未设置的干净环境下跑全量**，并**贴完整尾部输出**（`Test Files` / `Tests` 两行 + 有无 FAIL 段）。
- **D. dev-note 的 `input_commit` 记本次 implement attempt 的 input_commit**（dd 交给你的那个，**不是 H0 提交**）。
  ⛔ 不要为对齐 hash 做额外提交。
> **这是 Phase 6 开跑前的最后一块前置**：当前 `--profile production` 会**在不存在的 channel 上跑一个错的研究**。

---

## 0　现状：production profile 三处都不对

`profiles/deploy/production.env` 当前内容与实测对照：

| 行 | 现值 | 实测 |
|---|---|---|
| `TICK_CHANNEL` | `research:v1-deep-research.index` | ⛔ **bus 上不存在**（派发方实测 `GET /v1/channels/research:v1-deep-research.index/messages` ⇒ **404 NOT_FOUND**） |
| `EVIDENCE_CHANNEL` | `research:v1-deep-research.evidence` | ⛔ **同样不存在** |
| `RESEARCH_QUESTION` | `光伏并网系统的谐波特性与治理策略研究` | ⛔ **不是拍板的题目**。golden-order 2026-08-09 02:20 拍板题目是 **「agent harness」**。这是 G4a(v2) 按 spec 允许填的**占位值** |

而该文件**自己的注释**写着：

> `# ⛔ 以下 bus channel 必须是**已核实存在**的真实 channel（bus append-only 无 DELETE，写错不可回退）。`

⇒ **这句「已核实存在」是一句未兑现的断言** —— 核验没有发生过。

> ### ⛔ 判据：**配置文件里的一句「已核实」，会让后来者停止核验。**
> 这与本线记过的「报告一个检查的结论时，措辞的强度必须等于检查的强度」是同一条，
> 只是发生在配置注释里 —— 而配置正是最容易被照单全收的地方。

---

## 1　派发方已完成的核验（**你无法自己复核，这是事实输入**）

⚠️ **dd workspace 的 `env_allowlist` 只有 `PATH` / `HOME`，没有 bus token** ⇒
**你连不上 agent-bus，无法自己验证 channel 是否存在。**

派发方于 **2026-08-09 07:51Z** 在生产 bus 上**显式创建并复核**了这一对 channel：

```
POST /v1/channels {"channel_id":"research:agent-harness.index",    …}  → 200   （2026-08-09 07:51Z）
POST /v1/channels {"channel_id":"research:agent-harness.evidence", …}  → 200   （2026-08-09 07:51Z）
POST /v1/channels {"channel_id":"research:agent-harness.docs",     …}  → 200   （2026-08-09 18:31Z）
复核（2026-08-09 18:31Z，三条同时）：
  GET /v1/channels/research:agent-harness.index/messages     → 200 head_seq=0 msgs=0
  GET /v1/channels/research:agent-harness.evidence/messages  → 200 head_seq=0 msgs=0
  GET /v1/channels/research:agent-harness.docs/messages      → 200 head_seq=0 msgs=0
```

⇒ **这两个名字是已核验的事实输入，照抄即可。**
⛔ **不得自己发明 channel 名**；⛔ **不得尝试联网核验**（连不上，会白耗一轮）；
⛔ **不得在注释里写任何你没有亲自做过的核验**（见 §0 判据）。

---

## 2　要做什么

### 2.1 `production.env` → `agent-harness.env`（**用 `git mv` 保历史**）

「**每研究一对 channel**」（plan §7-1 拍板）意味着**不存在一个通用的 `production` profile** ——
profile 是**按研究**的。⇒ 把 `production.env` 重命名为 `agent-harness.env` 并改成真实值：

| 键 | 值 |
|---|---|
| `TICK_CHANNEL` | `research:agent-harness.index` |
| `EVIDENCE_CHANNEL` | `research:agent-harness.evidence` |
| `RESEARCH_QUESTION` | `agent harness`（**拍板题目，逐字**） |
| `ALLOWED_ROOT` | 保持现值 `/data/code/self/agent-runtime` |
| `MAX_WRITES` | 保持现值 `96` |
| `EXPORT_ROOT` | 保持现值 `/data/vault`（⛔ 必须是 vault 根、不含 `DeepThought` 段，否则双重嵌套 —— 该注释保留） |
| **`DOC_CHANNEL`**（G4c 新增，本包首次赋真值） | `research:agent-harness.docs`（**已核验存在**，见 §1） |
| **`ANCHOR_CHECK_BIN`**（G4d 新增，本包首次赋真值） | `/data/code/self/katana/plugins/deep-research/skills/deep-research/loop-orchestration/tools/anchor-check.py`（⛔ 绝对路径；派发方 2026-08-09 实测该文件存在、240 行、可执行位已置） |

> ⚠️ **`RESEARCH_ORIGIN` 不要在 profile 里写死**：`bin/deep-research-loop.sh` 已由 `RESEARCH_QUESTION` 确定性派生
> （`dr-$(sha256sum | cut -c1-16)`）。写死会让同题目的两次研究撞上同一 origin。

### 2.2 ⛔ 修掉那句不实注释

把「以下 bus channel 必须是**已核实存在**的真实 channel」改成**与事实相符**的表述：
写明这一对 channel 由派发方于 2026-08-09 07:51Z 创建并复核（head_seq=0），
以及**后续换研究时必须重新核验**（不是「一次核验、永远为真」）。

### 2.3 `local.env` 一并对齐

`local.env` 的 `TICK_CHANNEL=research:v1-deep-research.local.index` 同样**未经核验**。
⇒ 要么改成一个明确标注「本地/未核验、真跑前须先建」的值，要么去掉该键让它响亮失败。
**实现方二选一，但⛔ 不得留下一个「看起来像已配置好」的未核验值。**

### 2.4 旧名字必须从仓里消失

`grep -rn "research:v1-deep-research" profiles/ bin/ src/ test/ docs/` ⇒ **零命中**。

### 2.5 `docs/deploy.md` 同步

profile 名从 `production` 改为 `agent-harness`，示例命令一并更新；
补一节「**换研究时怎么做**」：新建一对 channel（**由部署方在 bus 上显式创建**，⛔ 不由代码自动创建）→ 新增一个 `<topic>.env` → 用 `--profile <topic>` 起。

---

## 3　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **Z1** | `profiles/deploy/agent-harness.env` 存在且六个键取值**逐字**等于 §2.1 的表 | 读文件到行号 |
| **Z2** | ⛔ **`grep -rn "research:v1-deep-research" profiles/ bin/ src/ test/ docs/` 零命中** | grep |
| **Z3** | ⛔ **`RESEARCH_QUESTION` 逐字等于 `agent harness`**（拍板题目），不得是占位或改写 | 断言字面相等 |
| **Z4** | ⛔ **仓内任何 profile 都不再声称一个未做过的核验**：`grep -rn "已核实存在" profiles/` 若仍命中，其上下文必须是 §2.2 那种「谁、何时、怎么验的」具体表述 | 读到行号并逐句核 |
| **Z5** | `--profile agent-harness --dry-run` 在**只设 `DEPLOY_PROFILE`** 的子环境下，渲染出的 tick input 五项（`tick_channel`/`evidence_channel`/`allowed_root`/`max_writes`/`research_question`）**全部等于 profile 值** | 用例须**自证子环境无那些 env**（照 D1 的 E3 写法） |
| **Z6** | ⛔ **`local.env` 不留未核验的「看起来已配好」的值**（§2.3 二选一，并在 dev-note 说明选了哪个、为什么） | 读文件 + 说明 |
| **Z7** | `git mv` 保历史：`git log --follow profiles/deploy/agent-harness.env` 能看到 `production.env` 时期的提交 | 贴输出 |
| **Z8** | `docs/deploy.md` 的 profile 名与示例已更新，且有「换研究时怎么做」一节，其中**建 channel 是部署方的显式动作**（⛔ 不由代码自动创建） | 读到行号 |
| **Z9** | 全量 `npx vitest run` 全绿，文件数/用例数不少于**基线（以 G4e 合入后的 main 实测为准，自己先跑一次记下来）**。⚠️ `test/d1-deploy-config.test.ts` 等用例硬编码了 `DEPLOY_PROFILE = "production"`，**必须随之更新**——这是本包在结构上迫使的改动，属必要 | 贴输出 + 逐处说明 |
| **Z10** | 变异矩阵（§4）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **Z11** | 每处删除给出必要性说明 | — |

---

## 4　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **V1** | 把 `RESEARCH_QUESTION` 改回占位题目 | **Z3 必须挂** |
| **V2** | 把 `TICK_CHANNEL` 改回 `research:v1-deep-research.index` | **Z2 + Z5 必须挂** |
| **V3** | 让 profile 加载不再把 `research_question` 送进渲染（只留在文件里） | **Z5 必须挂**（这条验的是「值到达渲染」，不是「文件里有」） |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| **创建任何 bus channel** | ⛔ **不可回退的部署动作**，已由派发方完成（§1）。代码/测试**一律不得**创建 channel |
| 向真实 bus 播种或真跑 | 归 Phase 6，由派发方做 |
| 注册任何 bus 协议 | 不可逆，走公示流程 |
| 改收集段/生成段/播种的任何逻辑 | 已合入；本包只动部署配置与文档 |
| 改 `agent-runtime` / katana | 不同仓 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 6　交付物落点

- 配置：`profiles/deploy/agent-harness.env`（由 `production.env` `git mv` 而来）、`profiles/deploy/local.env`
- 文档：`docs/deploy.md`
- 测试：`test/d1-deploy-config.test.ts` 等的 profile 名更新 + 新增 Z1–Z6 的用例（可新建 `test/d2-profile.test.ts`）
- 证据：`docs/dev-notes/dev_ledr_d2_profile_01.md`（Z1–Z11 逐条 + §4 变异三行 + 还原证据 + §2.3 的选择说明）

> **dev-note 的 `input_commit` 记本次 implement attempt 的 input_commit**（该字段本来的语义）。
> 真正的要求是**正文描述交付物本身**；若中途 rework 改了实现，正文数字与结论同步更新。
> ⛔ **不要为对齐 commit hash 做额外提交。**
