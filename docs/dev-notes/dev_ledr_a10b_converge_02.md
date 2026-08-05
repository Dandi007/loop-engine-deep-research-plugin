# A10b —— 自然收敛 + 端到端真跑 + 消灭验收命令本身的不确定性

## 缺口（真跑实证，非推测）

### 0.1 这条流水线从未自然收敛过
`bin/deep-research-loop.sh` 端到端真跑（真实 loop-engine CLI + bun + 本地受控 bus），连空板面
也输出 `{"reason":"max_rounds","rounds":16,"ticksByLabel":{"tick":16}}`，撞 `max_passes` 退出，
不是 `drained`。根因定位到**两处**：

1. **引擎对单节点工作流的终局误判**：`workflow.yaml` 的 `limits.max_nodes: 1` 使单 tick 节点正常
   完成后，loop-engine 先查 `done.size >= max_nodes` 返回 `reason="max_nodes"`（STATUS.md /
   postmortem.json 实证），而 fleet 的 `claim.complete` 把非 `{halt,drained}` 终局当失败，路由到
   `failure_status: open` ⇒ seed 每轮被认领（`open→done`）又退回 `open` ⇒ 永不「已排空」
   （store `.events.jsonl` 逐目实证 `open→done→open→done…`）。
2. 触发存储只有 seed 一条且始终停在 `open` ⇒ `claimableCount()` 恒 > 0 ⇒ drain 永不判 drained。

修复：`limits.max_nodes` 1 → 2（本板面单 seed 实际只跑 1 节点，不受影响），单 tick 正常完成即
`reason="drained"` ⇒ `complete` 落到 `success_status: done` ⇒ 板面全终态时不续投 ⇒ drain 以
`reason="drained"` 收敛（真跑实证）。收敛仍是**板面状态**确定推出的结果（B3/B4 判别对），
不是「跑够 N 轮就停」。

### 0.2 `npm test` 本身不稳定（验收命令不确定性）
`bin/deep-research-loop.sh:19` 的 `RUN_ID="${DD_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"` 是秒级粒度；
vitest 并行下同一秒内多次 `--dry-run` 渲染共用同一 `RUN_ROOT` ⇒ 互相覆盖 `fleet.yaml` ⇒
实测 20% 假红（`a8f-adddir F1` 读回 `null`）。修复：缺省 `RUN_ID` 改为 `$(date +%s%N)-$$`
（纳秒 + PID，每次渲染唯一；与 `tick.md` 已有范式一致）。`DD_RUN_ID` / `DD_RUN_ROOT` 显式覆盖
语义不变（B7a/B7b 判别对）。

## 改动

### `bin/deep-research-loop.sh`
- `RUN_ID` 缺省值秒级 → `$(date +%s%N)-$$`（§1.2：每次渲染唯一，消灭 §0.2 竞争）。

### `workflows/deep-research/tick/workflow.yaml`
- `limits.max_nodes` 1 → 2（§1.1：单 tick 正常完成判 `drained`，seed 走到 `done` 终态）。

### `src/bus.ts`
- agent-bus 基址支持 `AGENT_BUS_URL` 覆盖（缺省仍 `http://127.0.0.1:7490`，行为不变），
  供本地受控 bus 端到端真跑。

### `test/a10b-convergence.test.ts`（新增）
- B1 真实端到端 drain 收敛 `reason="drained"`；B2 真实端到端收割发布并回读 `research.evidence.v2`
  条数 > 0（均用真实驱动 + 真实 loop-engine CLI(bun) + 本地受控 bus，⛔ 不打桩 fetch）。
- B1-guard（LOOP_ENGINE_CLI 缺失 ⇒ 响亮失败）；B3/B4 判别对（非终态续投 / 全终态不投）；
  B5 同秒两次渲染 RUN_ROOT 不同；B6 并发 ≥5 次渲染互不污染；B7a/B7b 覆盖判别对；B10 selfcheck 无副作用。

### `test/fixtures/fake-bus.mjs`（新增）
- 本地受控 agent-bus（127.0.0.1，零外网），供 B1/B2 真跑。

## 硬验收对照

| # | 结果 |
|---|---|
| B1 | 真实驱动端到端跑完，drain 输出 `reason === "drained"` ✓（真跑实证） |
| B1-guard | LOOP_ENGINE_CLI 指向不存在路径 ⇒ 非零 + 响亮点名缺失，绝不静默 pass ✓ |
| B2 | 以 `research:p02-smoke-1dce60.evidence` 作 EVIDENCE_CHANNEL 真跑，回读该 channel 断言 `research.evidence.v2` 条数 > 0 ✓ |
| B3 | 板面非终态 clue ⇒ 仍续投触发（tick.md 写一条 open 触发）✓ |
| B4 | 板面全终态 ⇒ 不投（与 B3 判别对）✓ |
| B5 | 同一秒内连续渲染两次，两次 RUN_ROOT 不同 ✓ |
| B6 | 并发 6 次渲染各自读回自己的 fleet.yaml 字段逐次正确（不串行化）✓ |
| B7a | 只设 DD_RUN_ID ⇒ RUN_ROOT 落在该 id ✓ |
| B7b | 同时设 ⇒ DD_RUN_ROOT 优先（与 B7a 判别对）✓ |
| B8 | 全量测试连跑 5 次，5 次全绿（exit 全 0）✓ |
| B9 | A10a C0–C4、A9 F0/F4/F6/F9/F10、A8f F1/F5、A8e H6/H7/H14 原用例仍成立（一条未删）✓ |
| B10 | `--selfcheck` 保留且无副作用（exit 0，零网络请求）✓ |
| B11 | 未触碰 `.dd-evidence/`；既有用例一条不删（全量 281 → 291 条，全部通过）✓ |
| B12 | typecheck + 全量测试 exit 0；证据写本文件；仓根无 `IMPLEMENTATION_SUMMARY.md` ✓ |

## 变异自检（亲跑，破坏后逐字还原并核验干净）

| 变异 | 被杀断言 | 验证 |
|---|---|---|
| **N1** `max_nodes` 改回 1（收敛判定恒「还有活」） | **B1**（reason≠drained） | 亲跑 B1 挂；还原干净 |
| **N2** 收敛改为无条件停投 | **B3**（续投被跳过） | 亲跑 B3 挂；还原干净 |
| **N3** `RUN_ID` 改回秒级 | **B5**（同秒两次渲染 RUN_ROOT 相同） | 亲跑 B5 挂；还原干净 |
| **N4** 让 `DD_RUN_ID` 显式覆盖失效 | **B7a**（RUN_ROOT 不落该 id） | 亲跑 B7a 挂；还原干净 |
| **N5** 收割步不发布 evidence | **B2**（回读 evidence 条数 0） | 亲跑 B2 挂；还原干净 |

> 每条变异后 `git diff --stat` 复核还原，未把变异留在工作区；最终工作区干净。

## 补充
- 证据 channel 先核实存在再启用（本地 bus 预置）；`EVIDENCE_CHANNEL` 显式注入，不靠字符串拼接推导。
- 真机只打 `research:p02-smoke-1dce60`（板）与 `research:p02-smoke-1dce60.evidence`（证据）；
  B1/B2 在本地受控 bus 上做同等真跑，零外网、不打桩。
- 不改 `loop-engine` 仓；不注册/不改任何协议；`.dd-evidence/` 未触碰。