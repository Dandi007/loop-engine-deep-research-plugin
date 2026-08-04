# A8d —— 把缺省 worker 从占位进程换成真实 `agent-run`

## 缺口

A8c 的 spawn 是判别性接线（CAS 成功 → 真正拉起子进程），但缺省命令链是
`bin/worker-launcher.sh` → `bin/worker-placeholder.sh`（`sleep`; `exit 0`），
`TICK_WORKER_RUNNER` 部署方未设置。占位进程不经 `agent-run` ⇒ 永不发
`agent.run.started/exited` ⇒ 下一 tick 回收步查不到 started ⇒ 把刚派出的卡收回 `open`，
dispatch ↔ reclaim 有界震荡，每 tick 写一条不可删消息。

本包落地：生产缺省 = 真实 `agent-run`，回收步从此有事实可依。

## 改动

### src/tick-run.ts（核心）
- 新增 `WorkerInputPayload` + `buildWorkerInput`：构造 `deep-research.worker-input/v1`
  载荷（`clue_id` / `clue_text` / `depth` / `sources`，可选 `allowed_root`）。
  ⛔ 不含 `attempt_id` / `development_id` / `spec_commit` / `run_id`（spec §1.2）。
- 新增 `resolveAgentRunBin`：`AGENT_RUN_BIN` 覆盖，否则按 PATH 解析；
  ⛔ 解析不到 ⇒ 抛 `AgentRunUnresolvedError`（点名 `agent-run`），绝不静默回退占位（P8/P9）。
- 新增 `buildAgentRunArgv`：`agent-run --role <role> --run-id <runId> --input <path> -- "<clue_text>"`
  （P1/P2/P3/P6/P7）。
- 新增 `writeWorkerInputFile`：把载荷写成 `--input` 指向的 JSON 文件（P4/P5）。
- 新增 `spawnAgentRunWorker`：写载荷 → 按 spec argv 启动 `agent-run` 子进程。
- `WriteDeps.spawnWorker` 签名加宽为 `(clueId, role, runId, input)`（spec §1.3），
  `runWrite` dispatch 分支把 `decision.text/depth/sources` 组装成载荷传给 spawn。
- `defaultWorkerCmd()` 改为返回 `resolveAgentRunBin()`（不再是 `worker-launcher.sh`）。
- `runChannelWrite` 缺省 spawn = 真实 `agent-run`（不再退化为占位 launcher）。

### src/tick.ts / src/tick-inspect.ts
- `BoardCard` 增加 `text`；`dispatch` Decision 增加 `text/depth/sources`；
  `decideTick` 派发时带上 clue 文本/深度/sources，`assembleBoard` 填 `card.text`。

### bin/deep-research-loop.sh
- 去掉 `TICK_WORKER_CMD`→占位 launcher 的默认；改为若 `$HOME/.local/bin/agent-run`
  存在则导出 `AGENT_RUN_BIN`（解析不到时由 `resolveAgentRunBin` 响亮失败，绝不回退占位）。

## 硬验收（P1–P18）

| 判据 | 实现/测试 |
|---|---|
| P1 缺省 argv[0]=agent-run | `runDefaultSpawnWithText` 读回缺省 spawn 的 argv[0]，断言以 `agent-run` 结尾 |
| P2 含 `--run-id`=runId | `buildAgentRunArgv` 相邻对断言 |
| P3 含 `--role`=role | 同上 |
| P4 含 `--input <path>` 且载荷合法 | `writeWorkerInputFile` + 读文件断言 `clue_id`/`clue_text` 非空 |
| P5 载荷不含四键 | 读文件断言四键均不存在（否定式） |
| P6 `--` 后位置 prompt=clue 文本 | `buildAgentRunArgv` 断言 |
| P7 缺省链路无 `worker-placeholder` | 缺省 spawn 的 argv[0]+args 均不含 |
| P8 解析不到 ⇒ 响亮失败点名 `agent-run` | `resolveAgentRunBin` 抛 `AgentRunUnresolvedError` |
| P9 解析不到绝不回退、无 spawned:true 无进程 | `runChannelWrite` 断言 spawned:false + 无 marker |
| P10 `AGENT_RUN_BIN` 覆盖生效 | argv[0] = 桩 |
| P11 `spawnWorker` 加宽且 clue 文本真到 prompt | 两条只差 clue 文本的卡 ⇒ prompt 不同（判别性主路径） |
| P12 A8c N1/N2 接线判别仍在 | 原用例未删、仍通过 |
| P13 `--selfcheck` 保留无副作用 | plugin-wiring 原用例通过 |
| P14 `--max-writes` 默认 5 / v1 冻结拒写 | M10/M11/M12 原用例通过 |
| P15 不碰 `.dd-evidence/` | 提交文件面不含 |
| P16 typecheck + 全量测试 exit 0 | 已验证 |
| P17 既有 196 条用例不减 | 196 → 208（净增 12） |
| P18 dev-note 存在、仓根无 `IMPLEMENTATION_SUMMARY.md` | 本文件 |

## 变异自检（亲跑，破坏后还原并验证干净）

| 变异 | 被杀断言 | 验证 |
|---|---|---|
| W1 缺省命令改回占位 | P1、P7 | 亲跑 9 条挂，P1/P7 在列；还原后 `git diff --stat` 干净 |
| W2 argv 去掉 `--run-id` | P2 | 亲跑 P2 挂；还原干净 |
| W4 载荷加回 `run_id` | P5 | 亲跑 P5 挂；还原干净 |
| W6 prompt 恒为常量 | P11（主路径） | 亲跑 P11/P6 挂；还原干净 |

> W3（去掉 `--input`）→ P4 于 `buildAgentRunArgv` 相邻对断言必挂；W5（回退占位）→ P8/P9 已覆盖。
> 每条变异后 `git diff --stat` 复核还原，未把变异留在工作区。

## 非目标（spec §6）

- 不做真机 `--run`（`worker.result.v1` 未在 bus 注册，端到端属 V1）。
- 不注册任何协议、不实现收割（A8e）、不实现 `dr-worker-web`。
- 不改 `src/protocol.ts` 既有导出签名；`spawnWorker` 属本条要求加宽而改。
- 不外写真实 secret / 不触碰真实 vault / MinerU / bus。