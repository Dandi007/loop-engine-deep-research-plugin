# E0a —— 让回归基线真的能判"链路跑起来没有"

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`
**前序**：E0（`dev_dr_e0_20260811_2340`，PR #58）已交付凭证可配置、部署 profile、入口脚本与单测骨架。
**本包定位**：E0 的**收口**。E0 的入口脚本能跑、护栏有效，但**判不出"链路根本没跑起来"**——
本包补上这一刀，让 E0 真正成为可信的 regression 基线。

---

## 0　为什么必须有这个包（真机实测证据，非推断）

派发方 2026-08-11 23:56–23:57 在真机上跑了 E0 候选分支两次，逐字记录：

**第一次**（`/data/loop-engine/e0-runs/e0-supervisor-235640`）：

```
[deep-research-loop] TICK FAILURE: run_dir=… exit=2
  bus GET /v1/channels/board:agent-runs/messages?limit=100:
  404 {"code": "NOT_FOUND", "message": "Channel board:agent-runs not found"}
```
入口退出码 3。**原因**：`src/tick-run.ts:1489` 的 `runsChannelId` 缺省是 `board:agent-runs`，
harvest 与 triage 都要读它来判 worker 是否退出；而 E0 的 channel 预备只建了 profile 里声明的三条
research channel。⇒ 这是 E0 spec 的清单缺口。

**第二次**（派发方手工在测试总线建好 `board:agent-runs` 后重跑，
`/data/loop-engine/e0-runs/e0-supervisor-run2`）：

```
{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},…}
entry_exit_code=0
```
耗时约 2 秒；跑完后测试总线上**每一条 channel 的 head_seq 都还是 0**（index / evidence / docs /
board:agent-runs 全为 0）。**链路一个字节都没写，入口报成功。**

这正是 E0 spec §2.3.6 明文禁止的形状（"⛔ 不得出现链路没跑起来但退出 0；现状 G11 就踩过：
一轮 3 秒 drain、零 spawn、exit 0 且不报错"）。E0 的实现只把 `deep-research-loop.sh` 的退出码透传，
于是**只有链路报错时才判失败，链路空转时判成功**。

**空转的根因**：研究板是空板，没有任何初始线索，tick 无事可做即 drain 返回。
播种是 `tick-entry` 的独立入口（`--seed <channel_id> --clue "<文本>" [--clue …]`，
每条 `status=open`、`depth=0`，幂等键由输入确定性派生、重复播种不翻倍），
而 `bin/e0-regression.sh` 从未调用它。

## 1　交付内容（四项，全部在 `bin/e0-regression.sh` 与其单测周边）

### 1.1 channel 预备清单补齐

- 预备清单在 profile 声明的 `TICK_CHANNEL` / `EVIDENCE_CHANNEL` / `DOC_CHANNEL` 之外，
  **必须包含 `board:agent-runs`**（tick/harvest/triage 的 run 生命周期与 worker 结果都读它）。
- 该 channel 名不要在入口脚本里再写死一份字面量：与 `src/tick-run.ts:1489` 的缺省值同源，
  或由 profile 显式声明一个键（二选一，实现者定；⛔ 但不得出现"两处各写一份、可静默发散"的形状）。

### 1.2 入口自播种

- 入口在 channel 预备之后、跑 loop 之前，**若研究板上没有任何线索则播种**：
  调用既有的 `--seed` 入口投至少一条初始线索（内容与 profile 的 `RESEARCH_QUESTION` 相称）。
- 播种内容进 profile（受版本管理、可 diff），⛔ 不写死在脚本里。
- 幂等：重复执行入口不得让板面线索翻倍（`--seed` 的幂等键已由输入确定性派生，沿用即可）。
- 播种失败 ⇒ 响亮失败、非零退出，⛔ 不得继续往下跑一个必然空转的 loop。

### 1.3 终态判据改为实证断言（本包核心）

入口的退出码**不得再是 loop 退出码的透传**。跑完后必须做实证检查，**全部通过才允许退出 0**：

1. loop 自身退出码为 0；
2. 本次运行**确实产生了总线写入**——研究板（`TICK_CHANNEL`）与证据 channel 中，
   至少 `TICK_CHANNEL` 的 `head_seq` 相对本次运行开始前**严格增长**；
3. 板面达到了一个**可指认的终态**（`--run` 的 JSON 输出含 `termination`；
   `termination.state !== null` 即到终态。⛔ "没跑起来"与"跑到终态"必须靠这个字段区分，
   不得靠"没报错"推断）。

任意一条不成立 ⇒ **非零退出**，且错误信息点名是哪一条不成立、实测值是多少。
⛔ 尤其禁止"零写入 + 零轮次"被判成功。

### 1.4 生产总线读数进运行记录（Z2 的证据）

- 入口在**跑之前**与**跑之后**各读一次生产总线（`http://127.0.0.1:7490`）的 channel 列表，
  把 `sum(head_seq)` 两个读数写进运行记录。
- 两个读数不相等 ⇒ 判失败并非零退出（说明本次运行污染了生产总线，属最严重的失败）。
- 读生产总线用只读 GET，⛔ 不得写、不得因为读不到就跳过检查（读失败即失败）。
- ⛔ 读生产总线所需凭证只以文件路径形式出现，且**不得**因此放宽 §E0 的生产护栏
  （护栏管的是"往哪写"，本条是"只读地取证"，两者不冲突——实现时注意别让护栏误伤这个只读读数）。

## 2　同时修掉 E0 final review 已指出的问题（若 E0 的 rework 已修则跳过，不重复改）

- T-D 的 `expect(k, prof[k]).toBeTruthy()` 参数写反导致判别性为零（blocker）。
- T-A 的 unset 方向真读生产凭证文件，使 `npm test` 机器相关（major）。
- 单测执行会在 `/data/loop-engine/e0-runs` 下留空记录目录（note）。
- `EXPORT_ROOT` 与记录根同目录，导出件与 run 记录互相交织（note）。

## 3　验收判据

1. `npm ci && npm run typecheck && npm test` 全绿，且测试不依赖任何生产凭证文件的存在。
2. **判别性（本包核心，必须有对应测试）**：构造"loop 退出 0 但零总线写入 / 板面无终态"的情形
   ⇒ 入口**非零退出**且错误信息点名该情形。把这条断言删掉或改成只看 loop 退出码，测试必须变红。
3. 播种：空板情形下入口会播种并使 `TICK_CHANNEL` 的 `head_seq` 增长；重复执行不使线索翻倍。
4. `board:agent-runs` 在预备清单内，且该 channel 名在仓内只有一处真相源。
5. 运行记录包含生产总线跑前/跑后两个 `sum(head_seq)` 读数；两者不等时入口非零退出。
6. **Z1（真机）**：`bash bin/e0-regression.sh` 一次跑通到终态、退出 0，
   且该次运行的测试总线 `TICK_CHANNEL` head_seq 相对跑前严格增长。
7. **Z2（真机）**：该次运行前后生产总线 `sum(head_seq)` 零增长（由 §1.4 的读数在记录里自证）。
8. **Z3（真机）**：连续两次执行都到终态，各自独立 run id 与记录目录，板面线索不翻倍。

> 判据 6–8 由派发方在真机上执行验证，不要求 reviewer 自己跑。

## 4　⛔ 明确不做

与 E0 spec §4 完全一致（web/content 信源、ingest、anchor scheme、仲裁者、原子产物、E7 入口重写、
协议注册、工具白名单、生产 profile 一律不碰）。本包**只**收口 E0 的判据能力，不扩任何研究能力。

额外一条：⛔ 不得为了让判据 6 通过而降低研究链路的真实性
（例如塞假 evidence、跳过 spawn、把 termination 写死）——那是把闸门拆了而不是过闸门。

## 5　评审口径

- **REJECT 只用于 blocker 级**：判据不成立、判别性缺失、静默失败、凭证泄漏、越出 §1 范围。
  文风与偏好写成 non-blocking 建议。
- reviewer 只读，判据 1–5 由 acceptance 命令的执行结果作证，⛔ 不要求 reviewer 执行 shell。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`（引擎保留路径，写入即永久 wedge）。
