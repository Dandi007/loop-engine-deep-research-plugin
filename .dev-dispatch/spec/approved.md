# E0 —— 真机端到端回归基线（deep-research V3）

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（本 spec 的全部改动只在该仓）
**上位文档**：work folder `wf-f54be7` 的 `spec.md` §13.5、`constitution-draft.md`（十三条）
**开发包顺序**：E0 是 V3 第一个包，其后每个包合入都要重跑 E0 作 regression

---

## 0　这个包要解决什么

现状：本仓的研究链路（`bin/deep-research-loop.sh` → `loop-engine drain` → tick → worker/triage/generate → 导出）
**只能打生产 agent-bus（127.0.0.1:7490）**，因为 `src/bus.ts:13` 把凭证路径写死成
`/data/agent-bus/tokens/uther-tui.token`。后果有两条，都必须在本包解决：

1. **任何一次跑通验证都会往生产总线写数据**——总线 append-only 无 DELETE，写错不可回退。
   宪法第五条要求测试数据只碰测试环境。
2. **没有一条可重复的命令能把链路从头跑到终态**，于是"改完有没有跑坏"这件事没有基线。
   宪法第十三条要求交付必须过真机端到端，且验收要能指认具体某次运行的记录。

本包交付的是**基线本身**：一条命令、打测试总线、跑完现状链路到终态、留下可指认的运行记录。
**本包不新增任何研究能力**（web 信源、ingest、原子产物等一律不碰，那是 E1–E4）。

## 1　运行环境（已由派发方在真机上就位，实现者不需要创建）

| 对象 | 值 | 说明 |
|---|---|---|
| 测试总线 HTTP | `http://127.0.0.1:7495` | systemd user unit `agent-bus-test.service`，独立 SQLite（`/data/agent-bus-test`）、独立 token，与生产 7490 零共享 |
| 测试总线 token 目录 | `/data/agent-bus-test/tokens/` | 本包的 profile 从这里取凭证文件路径；⛔ token 内容不得进仓、不得进任何产物 |
| 生产总线 HTTP | `http://127.0.0.1:7490` | ⛔ 本包交付物在任何路径下都不得写它 |
| loop-engine CLI | `/data/code/self/loop-engine/dist/cli.js` | 现状链路已依赖，不改 |

## 2　交付内容（四项，全部在目标仓内）

### 2.1 `src/bus.ts`：凭证路径可配置

- 现状第 13 行 `const TOKEN_PATH = "/data/agent-bus/tokens/uther-tui.token";` 改为可被环境变量覆盖。
- **变量名必须是 `AGENT_BUS_TOKEN_FILE`**——与 `agent-runtime` 的 `src/agent-bus.ts:56` 同名同义
  （那边已是 `process.env.AGENT_BUS_TOKEN_FILE || DEFAULT_TOKEN_FILE`）。同一台机器上两个进程读同一个变量，
  才可能让 tick 与它 spawn 出来的 `agent-run` 落在同一条总线上。
- **未设置该变量时行为逐字不变**（仍读 `/data/agent-bus/tokens/uther-tui.token`）。
- 读取失败（文件不存在/为空）时必须响亮失败并点名该变量与解析到的路径，
  ⛔ 不得回退到默认路径、不得返回空 token 继续跑（宪法第四条：失败必须现形）。

### 2.2 `profiles/deploy/e0-regression.env`：回归基线的部署配置

新增受版本管理的 profile，供 `--profile e0-regression` 加载。要求：

- 全部 channel 名带 `e0` 与 run 语义的前缀，且**与生产 profile（`agent-harness.env`）的 channel 名无交集**。
- `EXPORT_ROOT` 指向仓外的运行时目录（不得写进 vault 的 `DeepThought/`，那是生产成果落点）。
- `ALLOWED_ROOT` 指向一个体量小、必然存在的本地仓，使一轮 code-local 收割能在数分钟内结束。
- `RESEARCH_QUESTION` / `RESEARCH_ORIGIN` / `DOC_CHANNEL` / `TICK_CHANNEL` / `EVIDENCE_CHANNEL` /
  `ANCHOR_CHECK_BIN` 全部显式给出（现状这些无内置缺省，缺一个就是启动即失败或生成段静默不执行——
  见仓内 `profiles/deploy/agent-harness.env` 的逐条注释）。
- ⛔ profile 里不得出现任何 token 值，只出现 token **文件路径**。

### 2.3 `bin/e0-regression.sh`：唯一入口命令

一条命令把现状链路在测试总线上从头跑到终态。要求：

1. **无参数即可运行**（可接受可选参数覆盖 run id 之类，但缺省必须能跑）。
2. 自己导出 `AGENT_BUS_URL` 与 `AGENT_BUS_TOKEN_FILE` 指向测试实例，
   并保证这两个变量**被 tick spawn 出来的子进程继承**（`src/tick-run.ts:1133` 是 `{...process.env, ...spec.env}`，
   因此在入口 export 即可，不需要改 spawn 代码）。
3. **生产总线护栏**：启动前检查最终生效的 `AGENT_BUS_URL`，若指向生产实例（端口 7490 或
   `AGENT_BUS_TOKEN_FILE` 落在 `/data/agent-bus/` 下）⇒ **拒绝启动并非零退出**，
   错误信息点名是哪一项触发。该检查必须在任何 bus 写入之前发生。
4. **channel 预备**：profile 声明的 channel 若在测试总线上不存在则创建；已存在则原样使用。
   创建与复核都走测试总线的 HTTP API。
5. **运行记录归档**：单次运行结束后，把可指认的运行记录落到一个确定路径下的
   `<run_id>/` 目录（run id 打印到 stdout），至少包含：入口命令的完整 stdout/stderr、
   最终 exit code、本次使用的 profile 名与 channel 名、以及可据以回查的 loop-engine run 目录路径。
   ⛔ 运行记录目录不得落在仓内（不得产生未跟踪文件污染工作区）。
6. **终态可判**：脚本的退出码必须区分"跑到终态"与"没跑到终态"；
   ⛔ 不得出现"链路没跑起来但退出 0"（现状 G11 就踩过：一轮 3 秒 drain、零 spawn、exit 0 且不报错）。
7. **可重入**：同一命令重复执行不得因残留状态失败；重复执行产生的是新 run id 与新记录目录，
   幂等键仍然生效、不产生重复的总线数据。

### 2.4 单元测试（`test/` 下，与既有 vitest 套件同风格）

至少覆盖以下四条，每条都要有**判别性**（把被测行为改坏后测试必须变红）：

- **T-A**：设了 `AGENT_BUS_TOKEN_FILE` ⇒ 读的是该路径；不设 ⇒ 读默认路径（两个方向都要断言）。
- **T-B**：凭证文件不存在/为空 ⇒ 抛错且错误信息含变量名与解析到的路径；⛔ 不静默降级。
- **T-C**：护栏——`AGENT_BUS_URL` 指向 7490（或 token 路径落在生产目录）⇒ 入口拒绝启动、非零退出、
  且**没有发生任何 bus 写入**。
- **T-D**：profile 文件被 `--profile e0-regression` 加载后，§2.2 列出的每个键都非空。

## 3　验收判据（逐条可机械判定）

1. `npm ci && npm run typecheck && npm test` 全绿（dd 的 acceptance 命令即此三条）。
2. `src/bus.ts` 中不再存在写死的凭证路径字面量作为唯一取值路径；
   `AGENT_BUS_TOKEN_FILE` 未设时的默认值与改动前逐字相同。
3. `profiles/deploy/e0-regression.env` 存在，且其 channel 名与 `profiles/deploy/agent-harness.env` 的
   channel 名集合交集为空。
4. `bin/e0-regression.sh` 存在且可执行；无参数运行路径存在。
5. T-A / T-B / T-C / T-D 四条测试存在且通过。
6. **仓内不得出现任何 token 明文**（凭证只以文件路径形式出现）。
7. **Z1（真机）**：在真机上执行 `bash bin/e0-regression.sh` 一次，链路跑到终态，退出码为 0，
   运行记录目录按 §2.3.5 生成且内容齐备。
8. **Z2（真机）**：该次运行前后，生产总线（7490）的 `head_seq` 零增长。
   实现者需在运行记录里留下跑前/跑后两次读数以支撑该判据。
9. **Z3（真机）**：同一条命令连续执行两次都能跑到终态，第二次产生独立的 run id 与记录目录。

> 判据 7–9 由派发方在真机上执行验证（host verify），不要求 reviewer 自己跑。
> 实现者需保证这三条**可被一条命令复现**。

## 4　⛔ 明确不做

| 不做 | 理由 |
|---|---|
| 新增 web / content 信源、`dr-worker-web` role | E2 的范围 |
| 改 ingest 语义、digest 归属、MinerU 接线 | E1 的范围 |
| 扩 anchor-check 的 scheme | E3 的范围 |
| 收工仲裁者、改终止条件 | E5 的范围 |
| 原子产物切分、引用过滤 | E4 的范围 |
| 把 199 行的 `bin/deep-research-loop.sh` 重写进 TS 入口 | E7 的范围；本包只在其之上加一层薄入口 |
| 注册任何新的 bus protocol / message kind | 现行 v2 松 schema 够用；协议注册是不可逆动作，需另行拍板 |
| 改 `recipes/*` 的工具白名单、按 role 裁剪工具面 | 已拍板豁免（V-4，better-to-have backlog） |
| 迁移或改动生产 profile `agent-harness.env` | 生产配置不在本包范围 |

## 5　评审口径（reviewer 必读）

- **REJECT 只用于 blocker 级问题**：判据不成立、护栏失效、静默失败、凭证泄漏、越出 §2 范围的改动。
  文风、命名偏好、"还可以更好"一类意见写成 non-blocking 建议，⛔ 不得据此 REJECT。
  （历史教训：spec 不设严重度下限时，MERGED 在构造上不可达。）
- reviewer 是只读角色，判据 1 与 5 由 acceptance 命令的实际执行结果作证，
  ⛔ 不要求 reviewer 自行执行 shell 来取证。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`（引擎保留路径，写入即永久 wedge）。
