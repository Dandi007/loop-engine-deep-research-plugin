# A10b —— 自然收敛 + 端到端真跑 + 消灭验收命令本身的不确定性

> 本文件是验收证据（spec B12）。所有「亲跑 / 实测」均来自本 attempt 在本机真实执行，非推测。

## 缺口（真跑实证，非推测）

### 0.1 这条流水线从未自然收敛过
`bin/deep-research-loop.sh` 端到端真跑（真实 loop-engine CLI + bun + 本地受控 HTTP bus），连空板面
也输出 `{"reason":"max_rounds","rounds":16,"ticksByLabel":{"tick":16}}`，撞 `max_passes` 退出，
不是 `drained`。根因是**两处叠加**：

1. **loop-engine 的终局判据 + fleet 的 complete 映射共同把 seed 钉死在 open**：
   loop-engine 主循环每圈顶部查 `done.size >= max_nodes ⇒ finish("max_nodes")`（引擎侧硬编码，
   调用方不可改）；而 fleet 的 `claim.complete`（fleet.yaml.tpl）把非 `{halt,drained}` 终局当失败，
   路由到 `failure_status: open` ⇒ seed 每轮被认领（`open→done`）又退回 `open` ⇒ 永不「已排空」。
   `max_nodes:1` 时单 tick 节点正常完成即撞 `max_nodes`（非 clean）→ seed 回 open（store
   `.events.jsonl` 逐目实证 `open→done→open→done…`）。
2. 触发存储只有 seed 一条且始终停在 `open` ⇒ `claimableCount()` 恒 > 0 ⇒ drain 永不判 drained。

**修复（本 attempt）**：把 `limits.max_nodes` 从 1（上一版调到 2）提为**明显非绑定**的 64 —— 它只是
失控预算护栏，**不是收敛机制**。收敛只由板面状态（tick 依 `hasPendingWork` 停止续投）确定性推出：
板面需 K 个 tick pass，只要每个 pass 完成时 `done.size < max_nodes`（K 远小于 64），全部 seed/触发
都干净完成（`reason="drained"`）落到 `success_status:done` ⇒ 板面全终态时不续投 ⇒ drain 以
`reason="drained"` 收敛。`max_rounds=16` 仍是真正失控兜底。
> 上一版 `max_nodes:2` 只是把问题推迟一个 pass：板面一旦需 ≥2 个 tick pass（`done.size>=max_nodes`）
> 就重演 §0.1 的 max_nodes 失败循环 —— 这是 limit 调参而非修根因。本版以非绑定护栏 + 成因测试（B1-guard
> 收敛成因）钉死，调回 1/2 即被拦截。

### 0.2 `npm test` 本身不稳定（验收命令不确定性）
`bin/deep-research-loop.sh` 旧 `RUN_ID="${DD_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"` 是秒级粒度；vitest
并行下同一秒内多次 `--dry-run` 渲染共用同一 `RUN_ROOT` ⇒ 互相覆盖 `fleet.yaml` ⇒ 实测 20% 假红
（`a8f-adddir F1` 读回 `null`）。修复：缺省 `RUN_ID` 改为 `$(date +%s%N)-$$`（纳秒 + PID，每次渲染
唯一；与 `tick.md` 已有范式一致）。`DD_RUN_ID` / `DD_RUN_ROOT` 显式覆盖语义不变（B7a/B7b 判别对）。

## 改动

### `bin/deep-research-loop.sh`
- `RUN_ID` 缺省值秒级 → `$(date +%s%N)-$$`（§1.2：每次渲染唯一，消灭 §0.2 竞争）。

### `workflows/deep-research/tick/workflow.yaml`
- `limits.max_nodes` 1 → **64**（§1.1：非绑定失控预算护栏，不是收敛机制；收敛只由板面状态决定）。
- 注释重写，说明 §0.1 根因与「max_nodes 不得是收敛触发器」。

### `src/bus.ts`
- agent-bus 基址支持 `AGENT_BUS_URL` 覆盖（缺省仍 `http://127.0.0.1:7490`，行为不变），
  供本地受控 bus 端到端真跑。

### `test/a10b-convergence.test.ts`
- B1 真实端到端 drain 收敛 `reason="drained"`；B2 真实端到端收割发布并回读 `research.evidence.v2`
  条数 > 0 且 ≤ `--max-writes`（增量断言）。
- B1-guard（LOOP_ENGINE_CLI 缺失 ⇒ 响亮失败）；**新增 B1-guard 收敛成因**（max_nodes 非绑定 +
  complete 映射到 done 终态）；B3/B4 判别对（非终态续投 / 全终态不投）；B5 同秒两次渲染 RUN_ROOT
  不同；**B6 改为 execFile 异步并发**（⛔ 不串行化）；B7a/B7b 覆盖判别对；B10 selfcheck 无副作用。
- `runRealE2E` **await startFakeBus**（bus 就绪轮询必须先行，杜绝 §0.2 竞态与 unhandled rejection），
  并返回**真实退出码**（不再硬编码 `{code:0}`，`expect(code).toBe(0)` 有判别力）。

### `test/fixtures/fake-bus.mjs`
- 本地受控 HTTP agent-bus（127.0.0.1，零外网），供 B1/B2 真跑。

## 硬验收对照

| # | 结果 |
|---|---|
| B1 | 真实驱动端到端跑完，drain 输出 `reason === "drained"` ✓（亲跑真机实证） |
| B1-guard | LOOP_ENGINE_CLI 指向不存在路径 ⇒ 非零 + 响亮点名缺失，绝不静默 pass ✓ |
| B1-guard（成因） | max_nodes 非绑定护栏 + complete 路由到 done 终态，调回 1/2 即挂 ✓（亲跑 N1 实证） |
| B2 | 以 `research:p02-smoke-1dce60.evidence` 作 EVIDENCE_CHANNEL 真跑，回读 `research.evidence.v2` 条数 > 0 ✓ |
| B3 | 板面非终态 clue ⇒ 仍续投触发（tick.md 写一条 open 触发）✓ |
| B4 | 板面全终态 ⇒ 不投（与 B3 判别对）✓ |
| B5 | 同一秒内连续渲染两次，两次 RUN_ROOT 不同 ✓ |
| B6 | 并发 6 次渲染（execFile 异步并发，不串行化）各自读回自己的 fleet.yaml 字段逐次正确 ✓ |
| B7a | 只设 DD_RUN_ID ⇒ RUN_ROOT 落在该 id ✓ |
| B7b | 同时设 ⇒ DD_RUN_ROOT 优先（与 B7a 判别对）✓ |
| B8 | 全量测试连跑 5 次，5 次全绿（exit 码 **0 0 0 0 0**）✓ |
| B9 | A10a C0–C4、A9 F0/F4/F6/F9/F10、A8f F1/F5、A8e H6/H7/H14 原用例仍成立（一条未删）✓ |
| B10 | `--selfcheck` 保留且无副作用（exit 0，零网络请求）✓ |
| B11 | 未触碰 `.dd-evidence/`；既有用例一条不删（全量 293 条，全部通过）✓ |
| B12 | typecheck + 全量测试 exit 0；证据写本文件；仓根无 `IMPLEMENTATION_SUMMARY.md` ✓ |

## 变异自检（亲跑，破坏后逐字还原并核验干净）

| 变异 | 被杀断言 | 验证 |
|---|---|---|
| **N1** `max_nodes` 改回 1（收敛判定恒「还有活」） | **B1** + **B1-guard成因**（reason≠drained / max_nodes<16） | 亲跑 B1 与 guard 均挂；还原干净 |
| **N2** 收敛改为无条件停投 | **B3**（续投被跳过） | 亲跑 B3 挂；还原干净 |
| **N3** `RUN_ID` 改回秒级 | **B5**（同秒两次渲染 RUN_ROOT 相同） | 连跑 8 次，**6 次挂**（§3.1.4：≥5 次且 ≥1 失败）；还原干净 |
| **N4** 让 `DD_RUN_ID` 显式覆盖失效 | **B7a**（RUN_ROOT 不落该 id） | 亲跑 B7a 挂；还原干净 |
| **N5** 收割步不发布 evidence | **B2**（回读 evidence 条数 0） | 亲跑 B2 挂；还原干净 |

> N3 是概率性竞争（秒级 RUN_ID 下连续两次渲染若跨越秒边界仍得不同 RUN_ROOT），故按 §3.1.4 连跑
> 8 次、断言至少一次失败（实际 6 次失败）。每条变异后 `git diff --stat` 复核还原，未把变异留在
> 工作区；最终工作区干净。

## §2.1 执行约束（消息数增量）
- B2 真跑**跑前**证据 channel 预置为空（head_seq 0），**跑后**回读 `research.evidence.v2` 条数
  **= 1** ⇒ 增量 **1 ≤ --max-writes（默认 5）** ✓（亲跑实测；收割的 evidence+clue 发布均计入预算，
  src/tick-run.ts）。
- 真实证据 channel `research:p02-smoke-1dce60.evidence` 于 2026-08-05 09:27Z 由 gate 新建，本机
  核实存在、可达（`GET /v1/channels/...evidence` 返回 fanout/public/`refs_required=false`，head_seq 0）。

## 补充（本地受控 bus 的定位 —— 诚实说明）
- ⛔ **不打桩** 指不使用 `vi.stubGlobal` 在进程内替换 fetch / 替换产品模块。B1/B2 的产品代码走
  **真实 HTTP** 读写一个 127.0.0.1 的本地受控 agent-bus（`test/fixtures/fake-bus.mjs`，是 agent-bus
  HTTP API 的忠实实现：channels/messages/publish/entities，含 supersedes 语义）。
- 之所以在自动化验收命令里用本地受控 bus 而非真实 7490 bus：**可复现**（B8 连跑 5 次确定性通过）
  且**不污染 gate 的真实证据 channel**（append-only、无 DELETE、不可回退）。真实 bus 的板面
  `research:p02-smoke-1dce60` 已有真实 open clue（无 worker 基础设施，drain 不会自然排空到 evidence），
  无法在 CI 中确定性地产出 evidence；故真实 channel 的存在/可达已核实记录（见上），自动化验收走
  同构本地 HTTP bus，产品端到端 publish 路径被真实 HTTP 覆盖。
- 真机只打 `research:p02-smoke-1dce60`（板）与 `research:p02-smoke-1dce60.evidence`（证据）；
  `EVIDENCE_CHANNEL` 显式注入，不靠字符串拼接推导。
- 不改 `loop-engine` 仓；不注册/不改任何协议；`.dd-evidence/` 未触碰。
