# E0c10 —— 回归基线的收尾包（交付清单式，⛔ 不用「不得回退」措辞）

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = `main`，含 E0 / E0c1 / E0c2f / E0c3b）

> **为什么重开**：前一版 `dev_dr_e0c9_20260813_1710` 的 blocker 连续三轮停在 2 条不动（6 → 3 → 2 → 2），
> 且一个 development 到第 7 轮会因 `spawn E2BIG` 死掉（GT-24），故换实现者重开。
>
> **⚠️ 本 spec 的写法与前几版不同**：前几版把已被作废包做过的东西写成
> 「⛔ 不得回退 / 必须原样保留」，但那些代码**从未进入 main**，实现者从 base 出发时它们根本不存在
> ——等于什么都没要求（`MAX_CLUES` 因此连丢 5 次）。
> **本 spec 一律写成「必须交付」，每条自带验收判据。**

---

## 0　⛔ 地面真相（真机取证，照抄，不得推测、不得由 fixture 反推）

### GT-A　tick 会被引擎级 `node_timeout` 杀掉，且**与板面规模无关**

`workflows/deep-research/tick/workflow.yaml:9` 现值逐字：

```yaml
limits: { max_nodes: 64, wall_clock: 60, node_timeout: 30, max_retries: 0, concurrency: 1 }
```

派发方真机取证（同一交付背靠背两跑，一次零超时、一次两次超时 ⇒ **超时是间歇性的**）：

```
2026-08-13 05:27 跑：drain #2 两个 tick 双双
  journal: {"identity":"tick","result":"[外部调用失败 status=TIMEOUT]\n","error":"exec"}
  events:  ["start","spawn","dispatch","done","exec_failed","stop"]   时长 39.9s 与 30.5s
  ⚠️ 此时 index head_seq=2 —— 板上只有种子那一条线索
2026-08-13 03:46 另一次：同类 tick 死于 TIMEOUT，单次 **904.2 秒**
```

⇒ 30 秒对一个合法地要做 bus I/O + spawn + 等结果的 tick 就是太紧；**实测最大单 tick 耗时 = 904.2 秒**。

### GT-B　`node_timeout` 必须大于一次**合法等待**的预算

`src/tick-run.ts` 的 `DEFAULT_AGENT_RESULT_TIMEOUT_MS = 900_000`（15 分钟）。
若引擎闸刀 ≤ 900 秒，一次合法的 readResult/readBody 等待就会被腰斩。

### GT-C　固定 attempt 次数上限会把「研究这次慢」变成「基线失败」

真机：worker 全部 `exit=0`（221s / 36s），只是这轮研究产出少；
12 次 attempt × 约 2.5 分钟先烧完，而墙钟预算 2400 秒**还没用掉** ⇒ `HIT ATTEMPT LIMIT` exit 4。

### GT-D　「run 退出却没产出 result」不得毙掉 tick，但**也不得静默成功**

真机：`E0c5 §1.2: run … (generate) exited without producing a dr-doc.result.v1 after 3159ms
— refusing to wait the full timeout` ⇒ 当时的实现让**整个 tick 非零退出**，一个失败的 generate worker
就毙掉整条基线（背靠背两跑：exit 0 / exit 5）。
另一面：让 `readBody` 返回空串、上层当成正常 body，则是**把局部失败静默折叠成成功**。

## 1　交付清单（⛔ 全部都要真的存在于本次交付里）

| # | 必须交付 | 关键约束 |
|---|---|---|
| D1 | `workflows/.../tick/workflow.yaml` 的 `limits.node_timeout` 抬到 **≥ 1800** | 注释写清 `1800 / 904.2 ≈ 2.0×` 与「> `DEFAULT_AGENT_RESULT_TIMEOUT_MS`(900s)」两条理由（GT-A/GT-B）。同 map 内的 `wall_clock` 若与之同单位，必须一并复核并说明 |
| D2 | 入口收尾**以墙钟为主**：墙钟没用完就继续退避重试 | ⛔ 次数上限不得先于墙钟决定成败（GT-C） |
| D3 | `DRAIN_MAX_ATTEMPTS` 作为**真正的失控兜底** | 撞上必须**终止循环并非零退出**（⛔ 不是只 echo 一行）；profile 三值自洽、注释写清 `墙钟 ÷ (最短drain+退避)` 的算式 |
| D4 | 「run 已 exited 无 result」⇒ **记录诊断并继续本轮 tick** | 诊断含 `run_id` / `role` / **已等时长**；⛔ tick 不得非零退出；⛔ 该 doc/clue 必须被标成失败，不得静默当成功（GT-D）。**triage 与 generate 两条路径都要** |
| D5 | `MAX_CLUES` 由 profile 声明（回归 profile 取 **24**）并经 `fleet.yaml.tpl → workflow.yaml → tick.md → --max-clues` **真正接线** | ⛔ 只在 profile 写个键、装配链不传，视为未交付 |
| D6 | `timings` 分阶段埋点，**覆盖整个 tick**（含 generate 段） | 用于 D1 的依据；⛔ 数字必须可溯源到具体字段 |
| D7 | `scripts/check-drain-failures.mjs` 能识别**被引擎杀掉**的 tick | 即 `result="[外部调用失败 status=TIMEOUT]"`、`error="exec"`；⛔ 不只认 `[bash 非零退出 EXIT:n]` |

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` **连跑两次都全绿**（抖动一次即视为未交付）。
   ⚠️ 前一版有测试导致 `tsc --noEmit` 失败——`tsconfig` 的 include 含 `test`，测试文件同样要过 strict 检查。
2. **⭐⭐ D2/D3 判别性（本包最难的一条，前一版连续三轮没做出来）**：
   必须**真的执行 `bin/e0-regression.sh`**，构造
   **「墙钟预算充足（`DRAIN_WALL_CLOCK_SECONDS` 很大）但 `DRAIN_MAX_ATTEMPTS` 已用尽」** ⇒ 入口**必须继续跑**；
   把上限逻辑改回「次数优先」⇒ 该测试变红。
   ⛔ 前一版的反例（`DRAIN_WALL_CLOCK_SECONDS=0` 配 `DRAIN_MAX_ATTEMPTS=2`）构造的是**相反**情形，不算数。
   另配一条：**墙钟与次数都用尽** ⇒ 入口**非零退出**且点名撞的是哪个上限（D3 的兜底真能终止）。
3. **⭐ D1 判别性**：断言 `limits.node_timeout ≥ 904.2 × 声明的余量倍数`，
   ⛔ 不得断言与某个源码常量（如 `DEFAULT_AGENT_RESULT_TIMEOUT_MS/1000`）对齐；调回任一小于 904.2 的值 ⇒ 变红。
4. **⭐ D4 判别性**：triage 与 generate **各一条**——构造「run 已 exited 但无 result」⇒
   tick **仍以 0 退出**、其余决策照常、诊断（含已等时长）出现在输出里、该 doc/clue 被标成失败；
   把处理改回抛异常/非零退出 ⇒ 变红。**测试必须驱动真实的轮询读取路径**，
   ⛔ 不得只 new 一个异常再自己 catch、⛔ 不得只断言纯谓词函数。
   另配反向一条：**bus 不可达** ⇒ tick 仍必须非零退出。
5. **⭐ D5 判别性**：断言装配链真的把 `max_clues` 传到了 tick（从 profile 到 `--max-clues`），
   ⛔ 不得在测试里直接给 `runChannelWrite` 传参绕过装配链；把 `fleet.yaml.tpl` 的注入删掉 ⇒ 变红。
6. **⭐ D7 判别性**：journal 里是 `result="[外部调用失败 status=TIMEOUT]"`、`error="exec"` ⇒
   检查器必须非零退出并点名 run_dir；换回只认 `[bash 非零退出 EXIT:n]` ⇒ 变红。
7. **⭐ D6**：`timings` 覆盖整个 tick（含 generate 段），且交付里指明 D1 的依据取自哪个字段。
8. **回归**：`main` 上已有的行为逐字不变（跨 drain 循环与退避、GT-6 三分类、终态取真值、续投门、
   失败轮回显、进度行与板面构成、per-run 板、种子带 sources、head_seq 只从列表端点取、
   生产总线真实全量求和与护栏、运行记录归档、`TRIAGE_THRESHOLD` 可配且缺省 3、假 bus 端口由内核分配）。
9. **Z1（真机）**：`bash bin/e0-regression.sh` 在**交付 profile 自己声明的预算内**跑到非 null 终态、
   **退出 0**，`board:agent-runs` head_seq 严格增长，证据 channel head_seq > 0。
10. **Z2（真机）**：运行前后生产总线 `sum(head_seq)` 零增长（派发方独立复算）。
11. **Z3（真机）**：**连续两次**执行都退出 0、各自独立 run id 与独立研究板。

> 判据 9–11 由派发方在真机上验证（一跑约 40–50 分钟）。

## 3　⛔ 明确不做

web/content 接线（E2b）、ingest（E1）、anchor scheme（E3）、收工仲裁者（E5）、原子产物（E4）、
驱动脚本重写进 TS 入口（E7）、协议注册、`recipes/*` 工具白名单、生产 profile `agent-harness.env`。

## 4　运行环境前提（派发方已就位）

测试总线 `http://127.0.0.1:7495`（独立 SQLite，与生产 7490 零共享）：三个 agent 已注册、
token 落 `/data/agent-bus-test/tokens/`；`board:agent-runs` 已建；协议已供给齐全（14 个 kind）。
⛔ 实现者不得在代码里自动注册 protocol。

## 5　评审口径

- **REJECT 只用于 blocker 级**：交付清单缺项、判据不成立、判别性缺失或方向钉反、
  自造契约 / 编造实测数字、越出 §1 范围。文风与偏好写成 non-blocking 建议。
- ⚠️ 本线累计因「测试绕开被测对象」被驳回 **10 次以上**（读脚本文本比字节偏移、把 fetch/spawn 全 mock 到亚毫秒、
  只 new 一个异常再自己 catch、只断言纯谓词、在测试里绕过装配链直接传参……）。
  **判据 2–6 的测试必须真正驱动被测对象**。
- reviewer 只读，判据 1–8 由 acceptance 命令的执行结果作证。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`。
