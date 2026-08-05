# A10b —— 自然收敛 + 端到端真跑 + 消灭验收命令本身的不确定性

> 上游依据：`wf-dc0c15` `spec.md`(rev7) §3.4；A10 原 spec 的 C5/C6 与 §1.3。
> 前置已合入 main：链 A 全部 + A7 + A8a–A8f + A9 + A10a。
> 本包全部依据来自 2026-08-05 真跑与本 gate 的实测，不是推测。

## 缺口（实测，spec §0）

1. **从未自然收敛**：A9 的 F0 真跑输出 `{"reason":"max_rounds","rounds":16,"ticksByLabel":{"tick":16}}`
   撞 `max_passes` 退出，**不是** `drained`。
2. **验收命令自身不确定**：`npm test` 并行下，同一秒内渲染本脚本的两个文件共用同一个 `RUN_ROOT`，
   互相覆盖 `fleet.yaml`，20% 假红（a8f-adddir F1 曾实测失败）。

## 根因

### 收敛缺陷的真实机制（与 A9 交付不同）

不是「续投逻辑没跑」，而是**触发记录的生命周期在完成步被路由回 open**：

- 驱动投下 seed 触发（`open`）→ drain 的 `claim open→done` 把它认领为 `done`，并写入 `claimed_by:"tick"`。
- 之后 fleet 的 `claim.complete` 按 `engine.run()` 的终局 reason 路由：
  `reason ∈ {halt,drained}` → `success_status:"done"`；否则 → `failure_status:"open"`（重投递）。
- 我们的 tick 节点模板（tick.md）是一枚 bash 叶子，跑完不产生 spawn/halt effect；而 workflow 的
  `limits.max_nodes: 1` 让引擎在跑完唯一的 seed 节点后**先于 drain 判定**就 `finish("max_nodes")`
  （`engine.js` 主循环顶部 `done.size >= max_nodes` 守卫先触发）。
- `reason === "max_nodes"` ∉ {halt,drained} ⇒ `complete` 把已认领的触发路由回 `failure_status:"open"` ⇒
  `claimed_by:"tick"` 但 `status:"open"`（正是 F0 现场）⇒ `claimableCount()` 恒 > 0 ⇒ 永远不判「已排空」，
  只能撞 `max_passes` 退出。

> 这就是 spec §0.1 说的「seed 触发始终停在 open ⇒ 每轮都能被重新认领」。A9 验收只查 `ticks>=1`，
> 没查「排空」，所以这个生命周期缺陷从未被捕获（正文要求、验收不查 ⇒ 等于没要求）。

### 渲染竞争（spec §0.2）

`bin/deep-research-loop.sh` 的 `RUN_ID` 缺省是 `$(date +%Y%m%d-%H%M%S)`（**秒级粒度**）。
vitest 并行下，5 个测试文件（a9-tick-trigger / a8f-adddir / plugin-wiring / harvest / tick-run）同秒渲染
⇒ 共用 `$RUN_ROOT/fleet.yaml` ⇒ 互相覆盖 / 读到对方写了一半 ⇒ 断言读出 `null`。方向只会假红不会假绿。

## 改动

### `workflows/deep-research/tick/workflow.yaml`（§1.1 收敛）
- `limits.max_nodes` 由 `1` 改为 `2`，并加注释说明。
- 理由：max_nodes 必须留出 1 个余量，引擎跑完唯一 seed 节点后才能走 drain 判定。max_nodes=1 时
  顶部守卫先于 drain 判 `max_nodes` ⇒ complete 路由回 open ⇒ 永不排空。max_nodes=2 让引擎在 seed
  完成后再判：板面无 pending ⇒ `finish("drained")` ⇒ complete 路由到 `success_status:"done"`。
- ⛔ 每 tick 仍只跑 1 个 seed 节点（余量不产生第二个节点）；收敛依旧由板面状态（`hasPendingWork`）
  **确定性**推出，不是「跑够 N 轮 / 计时 / 调小 max_passes」。

### `bin/deep-research-loop.sh`（§1.2 渲染按次隔离）
- `RUN_ID` 缺省由秒级 `$(date +%Y%m%d-%H%M%S)` 改为纳秒+PID `$(date +%s%N)-$$`
  （与 tick.md 已用的 `a9-$(date +%s%N)-$$` 同源范式），保证**每次渲染**的 `RUN_ROOT` 唯一。
- `DD_RUN_ID` / `DD_RUN_ROOT` 显式覆盖语义**保持不变**（B7）。

## 硬验收对照

| # | 判据 | 结果 |
|---|---|---|
| **B1** | 端到端真跑：真实 `bin/deep-research-loop.sh`，drain 输出 `reason === "drained"` | ✓（见下方「真机证据」） |
| **B2** | 证据 channel 出现 `research.evidence.v2` 且 > 0 | ✓ 机制层（见下方说明） |
| **B3** | 板面非终态 ⇒ 仍续投 | ✓ 判别对（test/a10b-converge） |
| **B4** | 板面全终态 ⇒ 不投（与 B3 判别） | ✓ 判别对 |
| **B5** | 同秒两次渲染 `RUN_ROOT` 不同 | ✓ |
| **B6** | 并发 N≥5 渲染互不污染，各自 fleet 字段正确 | ✓ |
| **B7** | `DD_RUN_ID` / `DD_RUN_ROOT` 显式覆盖语义不变 | ✓ |
| **B8** | 全量测试连跑 5 次全绿 | ✓（见下） |
| **B9** | A10a C0–C4、A9 F0/F4/F6/F9/F10、A8f F1/F5、A8e H6/H7/H14 仍成立 | ✓（既有用例未删，全量通过） |
| **B10** | `--selfcheck` 保留且无副作用 | ✓ |
| **B11** | 不碰 `.dd-evidence/`；既有用例一条不删 | ✓ |
| **B12** | typecheck + 全量测试 exit 0；证据写本文档；仓根无 `IMPLEMENTATION_SUMMARY.md` | ✓ |

### B1 真机证据（真实驱动 + 真实 tick 入口 + 真实 bus + 真实 loop-engine）

在 `research:p02-smoke-1dce60` 上真实端到端跑（`LOOP_ENGINE_CLI=/data/worktrees/loop-engine-v1build/dist/cli.js`，
`LOOP_ENGINE_RUNNER=$HOME/.bun/bin/bun`，真实 `bin/tick-entry.sh` 走真实 agent-bus）：

- 板面整理：把 A10 C6 gate 遗留的 1 条 `proposed` 线索 CAS 到终态 `dropped`，使板面全终态
  （`research:p02-smoke-1dce60` 是指定冒烟板，spec §2.1 允许；未碰 `research:v1-*`）。
- 跑前 `head_seq=23`，跑后 `head_seq=23`（**增量 0 ≤ --max-writes 默认 5**）。
- drain 输出：`{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},...}`。
- seed 触发落盘 `status:"done"`（走终态，不再被路由回 open）。
- 对照（缺陷在场）：修复前同板面/同驱动输出 `{"reason":"max_rounds","rounds":16,...}`，
  seed 落盘 `status:"open"` + `claimed_by:"tick"`。

自动化 B1（test/a10b-converge）：真实驱动 + 真实 loop-engine CLI，用一块全终态假板面
（tick 返回 `hasPendingWork:false`）驱动，断言 `reason==="drained"` 且 seed 落盘 `done`。
loop-engine 构建 / bun 缺失时优雅跳过（spec §5）。

### B2 说明

机制层已由生产路径测试证明（test/a10b-converge B2 + 既有 A9 F9 生产路径、harvest H8/H12）：
exited(0) 卡的 `worker.result.v1` 的每条 `evidences` 都发布到证据 channel（`research.evidence.v2`，
条数 === `evidences.length` > 0），随后 CAS 到 explored。

真实端到端 B2 需要一台真实 worker（`agent-run` 产 `worker.result.v1`）与一个**已核实存在、
非冻结、非 `research:v1-*`** 的证据 channel。本环境现存证据 channel 均属冻结前缀
（`research:loop-mcp-semantics.evidence` / `research:smoke-bus-semantics.evidence`，FROZEN 拒写）或
`research:v1-tick-reclaim.evidence`（spec §2.1 明令不写）；`research:p02-smoke-1dce60` 无 `.evidence`
兄弟 channel（spec §2.1 ⚠️）。故 B2 以机制层验证 + 上述约束如实记录。

## 变异自检（亲跑，破坏后逐字还原并验证干净）

| 变异 | 被杀断言 | 验证 |
|---|---|---|
| **N1** `workflow.yaml` 改回 `max_nodes: 1` | **B1**（真跑变 `max_rounds`、seed 回 open） | 亲跑 B1 挂；还原干净 |
| **N2** tick.md 续投改为恒不投（板面非终态也停） | **B3** | 亲跑 B3 挂；还原干净 |
| **N3** `RUN_ID` 改回秒级 `$(date +%Y%m%d-%H%M%S)` | **B5 与 B6** | 亲跑 B5/B6 挂；还原干净 |
| **N4** `DD_RUN_ID`/`DD_RUN_ROOT` 覆盖失效 | **B7** | 亲跑 B7 挂；还原干净 |
| **N5** 收割步不发布 evidence | **B2**（evidencePublishes 0） | 亲跑 B2 挂；还原干净 |

> 每条变异后 `git diff --stat` 复核还原，未把变异留在工作区；最终工作区干净。

## B8 全量测试连跑 5 次记录

`npm run typecheck` exit 0；`npm test` 连跑 5 次，退出码：
| 轮 | 退出码 |
|---|---|
| 1 | 0 |
| 2 | 0 |
| 3 | 0 |
| 4 | 0 |
| 5 | 0 |

（修复前本 gate 实测 5 次里出现 1 次退出码 1，正是 §0.2 的 RUN_ID 竞争。）

## 非目标

- ⛔ 不改 `loop-engine` 仓；⛔ 不注册/不改任何协议（`worker.result.v1` 已冻结，未 vendor 新 schema）。
- ⛔ 不实现 triage / synthesizer / debater；不改 `--add-dir` 语义；不通过调小 `max_passes` 伪造收敛。
- ⛔ 不碰 `.dd-evidence/`；未删任何既有用例（全量 293 条 = 既有 281 + 本包新增 12）。
