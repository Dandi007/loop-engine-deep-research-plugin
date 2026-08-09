# D1 —— 部署固化：把「靠手工 env 搀扶」变成受版本管理的部署配置

> 上游依据：`wf-dc0c15` `spec.md`(rev7) §5.5、`wf-ecf9fc` `plan.md` §7、`golden-order.md`「2026-08-09 02:10」拍板（导出落点）。
> 前置已合入 main `1e6708a`（G1 / G2a / G2b 全部完成；G3 由 A8f 覆盖）。
> **本包是 Phase 6 端到端验收的最后一块前置**：plan §0 的 DoD 里写着「全程无人工介入、**零手工 env 搀扶**（部署配置受版本管理）」。

---

## 0　现状：三处「能跑但靠手工搀扶」

`bin/deep-research-loop.sh` 实测（本包基线 `1e6708a`）：

| 行 | 现状 | 问题 |
|---|---|---|
| `:32` | `export TICK_CHANNEL="${TICK_CHANNEL:-research:p02-smoke-1dce60}"` | ⛔ **缺省仍是 smoke channel**。生产不显式设它就会往冒烟板写——而 **bus append-only 无 DELETE，写错不可回退** |
| `:41` | `export EVIDENCE_CHANNEL="${EVIDENCE_CHANNEL:-}"` | 无默认值（**设计如此**：真实 channel 名不可由板名推导，静默推导会错写进 append-only bus）。但**生产配置必须有一个受管的显式值**，不能靠人记得 export |
| `:46` | `export ALLOWED_ROOT="${ALLOWED_ROOT:-}"` | 同上：`code-local` worker 没有它会响亮失败（A8f 的 `MissingAllowedRootError`），但生产得有受管值 |

⇒ **「部署」目前等于「有人记得把三个 env 敲对」。** 本包把它变成受版本管理的配置文件。

## 0.1 ⛔ 另一处已实测的部署面缺口：**依赖装没装，不在部署步骤里**

G1 期实测（本 session 亲历）：生产 checkout 里 `yaml` 在 `devDependencies` 声明了但**没装**，
而 **5 个接线回归文件都 import 它** ⇒ `npx vitest run` 报
`Error: Failed to load url yaml`、**`0 test` collected**。

> ⛔ **「0 test collected」与「测试全绿」在摘要上极像，语义完全相反。**
> 而这个 checkout **就是生产运行位** ⇒ **「部署完成」与「回归可执行」是两件事**，当时它们不相等。

⇒ 部署步骤必须包含依赖安装，且必须有一条**验证回归确实可执行**的检查（不是只看 `exit 0`，要看**收集到的用例数 > 0**）。

---

## 1　要做什么

### 1.1 受版本管理的部署配置（profile 形式，进 repo）

新增 `profiles/deploy/<name>.env`（或等价形式，**实现方可选形状，但必须进 git、可 diff、可 review**），
至少覆盖：`TICK_CHANNEL` / `EVIDENCE_CHANNEL` / `ALLOWED_ROOT` / `MAX_WRITES` / 导出落点根。

`bin/deep-research-loop.sh` 增加一个**显式的 profile 选择入口**（如 `--profile <name>` 或 `DEPLOY_PROFILE`），
加载顺序必须是：**显式 env > profile 文件 > 内置缺省**，且**加载了哪个 profile 要打印出来**（可观测）。

### 1.2 ⛔ 把 smoke channel 缺省改成「响亮失败」

`TICK_CHANNEL` 的**内置缺省不得再是 `research:p02-smoke-1dce60`**。
未经 profile 或显式 env 指定时 ⇒ **响亮失败并拒绝启动**，理由写进错误消息。

> **判据**：bus 是 append-only 无 DELETE 的。**一个「默认写到某个真实 channel」的缺省值，其代价是不可回退的**。
> 与 `EVIDENCE_CHANNEL` 无默认值同一条道理——那条**设计如此**是对的，本条要向它对齐。
> ⚠️ 但**不得反过来给 `EVIDENCE_CHANNEL` 编一个缺省**：它保持「无默认 + 响亮失败」。

### 1.3 导出落点写死 `DeepThought/<主题>/`

按 2026-08-09 用户拍板：导出件落 `DeepThought/<主题>/`，带 `source_message_id` + 终态标记以与旧产物区分。
`src/export.ts` 已有 `deriveExportPath` / `renderExportContent` / `source_message_id` 注释，**读它、按它的既有形状接，不要重写**。
落点根走 §1.1 的配置，**不得硬编码到源码里**。

### 1.4 部署步骤文档化 + 可执行验证

`docs/deploy.md`（或等价）写明生产部署步骤，且**每一步都要有对应的验证命令**：
1. 各仓 `git pull`
2. **依赖安装**（`npm ci`）
3. ⛔ **回归可执行性验证**：跑一次测试并断言**收集到的用例数 > 0 且全绿**（§0.1 的教训）
4. `--dry-run` 冒烟：**零手工 env**，只靠 profile，渲染出的 fleet input 里 `tick_channel` / `evidence_channel` / `allowed_root` / `max_writes` 全部非空且等于 profile 值

---

## 2　硬验收

| # | 判据 | 怎么验 |
|---|---|---|
| **E1** | ⛔ **不设任何相关 env 时，`TICK_CHANNEL` 不再回落到 smoke channel** —— 无 profile 且无显式 env ⇒ **响亮失败拒绝启动** | 正反两例：无 profile ⇒ 非零退出且错误消息点名；有 profile ⇒ 正常渲染 |
| **E2** | ⛔ **`grep -rn "research:p02-smoke-1dce60" bin/ src/` 零命中**（smoke channel 字面从生产路径消失） | grep |
| **E3** | **从 profile 出发的端到端渲染断言**：`--dry-run` 在**只设 `DEPLOY_PROFILE`、不设其它 env** 的子环境下跑，渲染出的 tick input 里 `tick_channel`/`evidence_channel`/`allowed_root`/`max_writes` **全部等于 profile 里的值** | ⛔ 用例必须**自证子环境里没有那些 env**（照 G1 的 D1b 写法：`expect(childEnv).not.toHaveProperty(...)`） |
| **E4** | 加载优先级：**显式 env > profile > 内置缺省**，三层各一例 | 三条断言 |
| **E5** | ⛔ **`EVIDENCE_CHANNEL` 仍保持「无默认 + 响亮失败」**，本包不得给它编缺省 | 反例：profile 里不给它 ⇒ 仍响亮失败 |
| **E6** | 导出落点走配置、**源码里不硬编码 vault 路径**；导出件含 `source_message_id` 与终态标记 | grep + 用例 |
| **E7** | `docs/deploy.md` 四步齐全，且**第 3 步是「用例数 > 0 且全绿」而不是只看 exit 0** | 读文档到行号 |
| **E8** | 全量 `npx vitest run` **连跑 3 次全绿**，且文件数/用例数不少于基线 **18 / 333** | 贴三次输出 |
| **E9** | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | — |
| **E10** | `src/`、`test/` 的每一处删除给出必要性说明 | — |

> ⚠️ **E8 要求连跑 3 次**，理由：派发方在 G2a 合入后于生产 checkout 观察到**一次未能复现的失败**（1 failed / 318 passed），随后 9 次全绿，**未留下失败用例名**。
> 故本包用「连跑 3 次」作为最低观察量，**若期间复现，请把失败用例名与完整输出贴进 dev-note**（这比修好它更重要——目前它连症状都没被记录）。

---

## 3　变异矩阵（逐断言归因）

| 变异 | 改什么 | 期望被杀 |
|---|---|---|
| **Q1** | 把 `TICK_CHANNEL` 的内置缺省改回 `research:p02-smoke-1dce60` | **E1 的失败侧 + E2 必须挂** |
| **Q2** | 让 profile 加载覆盖显式 env（把优先级颠倒） | **E4 必须挂** |
| **Q3** | 给 `EVIDENCE_CHANNEL` 编一个缺省值 | **E5 必须挂** |

**纪律**（`wf-dc0c15/plan.md` §6）：逐断言归因 / 破坏后回显被改行 / 零功率检查比没有更坏 /
永远红绿等于没检查 / gate 校 spec 读 `.dev-dispatch/spec/approved.md` / 纯文档包不编造变异自检。

---

## 4　显式不做

| 不做 | 理由 |
|---|---|
| 注册任何 bus 协议 | 不可逆，走公示流程，由派发方在异议窗口后执行 |
| 端到端真跑真研究 | 归 Phase 6；本包只做 `--dry-run` 层的配置贯通 |
| 改 `agent-runtime` | 不同仓 |
| 改生成段/收集段的编排逻辑 | 归 G2a/G2b，已合入 |
| 修那个未复现的 flake | **本包只要求「连跑 3 次并如实记录」**；没有症状就动手修，等于凭猜改代码 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 5　交付物落点

- 实现：`profiles/deploy/*.env`（新增）、`bin/deep-research-loop.sh`（profile 加载 + 缺省改响亮失败）、
  `src/export.ts`（落点走配置，若需要）
- 文档：`docs/deploy.md`
- 测试：`test/d1-deploy-config.test.ts`（E1–E7）
- 证据：`docs/dev-notes/dev_ledr_d1_deploy_config_01.md`（E1–E10 逐条 + §3 变异矩阵三行 + 三次连跑输出）
