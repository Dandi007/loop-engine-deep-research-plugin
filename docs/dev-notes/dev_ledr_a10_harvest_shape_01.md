# A10 —— 收割静默丢证据 + 自然收敛（V1 首跑实测三缺陷）

## 缺口

2026-08-05 V1/F0 真跑实测：6 条 evidence 被静默丢弃、卡被置成终态。根因是
`src/harvest.ts` 用**错误形状**读 `worker.result.v1`：

```js
const evItems   = result.evidence ?? [];               // ⛔ 字段名错（应为复数 evidences）
const clueItems = result.proposed_clues?.items ?? [];  // ⛔ 形状错（应为直接数组）
```

而注册在案的 `worker.result.v1` 的 `required` 是 `['evidences','proposed_clues','materials']`，
三者均为数组。真实 payload 实测量到 `evidences: list(6)`、`proposed_clues: list(2)`、
`materials: list(0)`。⇒ 两处都取到 `undefined` ⇒ `needed = 0+0+1 = 1` ≤ 预算 ⇒
**顺利通过预算检查、一条不发、CAS 到 explored**。

⛔ 单元测试无法发现「夹具与代码共享同一个错误模型」：夹具手写的 `evidence` /
`proposed_clues: {items}` 与代码自洽、共同偏离现实。真相一直在总线上机器可读。

另有第二个缺陷：`no_result`（找不到 worker.result）仍写终态（`casExplored: true`），
把「没找到结果」错当成「worker 确实没产出」。第三个缺陷：不收敛（撞 max_passes 而非
自然 `drained`）。

## 改动

### `src/harvest.ts`
- `WorkerResultV1` 改用**权威形状**：`evidences?: WorkerEvidenceItem[]`（复数数组）、
  `proposed_clues?: WorkerProposedClue[]`（直接数组，非 `{items}`）、`materials?: unknown[]`。
  `evidence` 单数字段仅保留供形状校验识别旧错误形状。
- `assertWorkerResultShape(result)`（attempt 1 major finding 修复）：
  ⛔ 注册 schema 的 **required 键必须全部存在且为数组**——缺失任一键（undefined）即抛
  `WorkerResultShapeError` 响亮失败（C2）。绝不静默 `?? []` 退化成空列表 ⇒ `needed` 塌缩到 1、
  零发布却被 CAS 到 explored（正是 C2 禁止的「0 发布 + CAS explored」静默通过）。
  旧形状（`evidence` 单数 / `proposed_clues:{items}`）照旧响亮失败。
- `harvestCard`：
  - `evItems = result.evidences ?? []`；`clueItems = result.proposed_clues ?? []`。
  - `no_result`（`!result`）⇒ `casExplored: false`——**不写终态**，卡留 `in_flight`、
    下一 tick 重试、响亮报告（skippedReason="no_result"），绝不 CAS 到 explored（C3）。
  - 结果存在但 `evidences` 为空数组 ⇒ 正常走发布/预算/CAS，允许置终态（C4，判别性）。

### `test/fixtures/worker-result.v1.json`（新增，attempt 1 C0 finding 修复）
- **固化的真实产物 fixture 文件**（2026-08-05 V1/F0 实测：evidences:list(6)/proposed_clues:list(2)/
  materials:list(0)）。本仓不含 `profiles/roles/schemas/worker-result.v1.json`（协议在 loop-engine 仓
  注册并已冻结），故 C0 用此**固化的真实产物 fixture** 作锚点：测试从这里读顶层键名，⛔ 绝不在测试体
  内手写产物形状。顶层键集合 === 注册 schema 的 required 集合。

### `workflows/deep-research/tick/workflow.yaml`（attempt 1 交付 3 / 收敛 blocker 修复）
- `limits.max_nodes` 由 `1` 改为 `2`。**根因（真跑复现）**：单节点 tick 在 `max_nodes:1` 时完成即
  `finish("max_nodes")`（非 halt/drained）⇒ fleet 的 `claim.complete` 判为异常终局 → 经
  `failure_status: open` 把**已消费的触发回退成 open** ⇒ seed/续投触发每轮都被重新认领
  （`pending.status: open` 每轮都数到它）⇒ drain 撞 `max_passes` 而非 `drained`。
  tick 恒为单节点，`max_nodes:2` 让这一节点自然排空返回 `halt`，complete 走 `success_status: done`
  ⇒ 已消费触发走到终态（板面排空时 drain 以 `reason==="drained"` 退出，spec §1 交付 3）。

## 硬验收（C0–C9）

| 判据 | 实现/测试 |
|---|---|
| C0 夹具形状由注册 schema / 固化真实产物导出 | `test/fixtures/worker-result.v1.json` 为**真实文件**，测试读其顶层键 === `['evidences','proposed_clues','materials']`（含 fixture 文件存在断言），⛔ 无手写夹具 |
| C1 真实形状 ⇒ 发布 N 条 evidence | publishEvidence 调用次数 === evidences 长度 |
| C2 旧错误形状 + **required 键缺失** ⇒ 响亮失败 / 零 CAS | `assertWorkerResultShape`（含缺失 evidences/proposed_clues/materials 各一例）+ runWrite 断言零 publish 零 CAS |
| C3 no_result ⇒ 零 publish、零 CAS、卡留 in_flight、报告含原因 | 打桩 readWorkerResult 返回 null |
| C4 结果存在但 evidences 为空 ⇒ 允许 CAS explored（与 C3 对照） | 两例对照 |
| C5 端到端 real run：`reason==="drained"` | **真跑**：真实 `bin/deep-research-loop.sh` + 真实 loop-engine CLI → `{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1}}`，seed 触发终态 `done`（见下「C5/C6 真跑证据」） |
| C6 跑完证据 channel 出现 `research.evidence.v2` | **真跑**：真实产品收割路径 publish 到真实证据 channel，证据计数 pre 1 → post 3（净增 2 == evidences 长度，见下） |
| C7 A9 F0 / A8f F1/F5 / A8e H6/H7/H14 仍成立 | 原用例仍在且通过 |
| C8 不触碰 `.dd-evidence/`；既有用例一条不删 | git diff（本改动仅 src/harvest.ts + 测试 + workflow.yaml + 新增 fixture + 本文档） |
| C9 typecheck + 全量测试 exit 0 | `npm run typecheck` + `npm test`（284 条全绿） |

### C5/C6 真跑证据（2026-08-05）

**C5（收敛 → drained）**：以真实装配（`bin/deep-research-loop.sh` 渲染的
`workflows/deep-research/fleet.yaml.tpl` + `tick/workflow.yaml`（含 max_nodes:2 修复）+
`tick/templates/tick.md`）驱动真实 loop-engine CLI 跑真实 drain：
- `LOOP_ENGINE_CLI=/data/worktrees/loop-engine-v1build/dist/cli.js`、
  `LOOP_ENGINE_RUNNER=$HOME/.bun/bin/bun`、`DD_RUN_ID=c5-convergence`。
- 输出：`{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},...}`。
- 触发存储：seed 触发最终 `status: "done"`（已消费触发走到终态）。
- **反例（M4）**：把收敛判定恒为「还有活」（tick-entry 恒 hasPendingWork=true）同装配重跑 ⇒
  `{"reason":"max_rounds","rounds":16}` —— C5 判 `drained` 失败，证明 M4 被杀。

**C6（证据真的出现）**：真实产品收割路径（`harvestCard` + 真实 bus `publishEvidence`）对一张
受控 `in_flight` 卡 + `worker.result.v1`（evidences 2 条）在真实证据 channel 上执行：
- 证据 channel：`research:p02-smoke-1dce60`（spec §2.1 允许打的板 channel；该 channel 承载
  `research.evidence.v2`）。
- **消息数增量**：跑前 `research.evidence.v2` 计数 **1** → 跑后 **3**，净增 **2**（== evidences 长度）。
  板 channel head_seq 15 → 22。受控卡事后 CAS 到 `explored` 清理（entity head 状态核验为 explored）。
- ⛔ 该 C6 用真实 bus + 真实产品代码，但以**受控单卡**方式直调 `harvestCard`，而非对整板跑 tick
  （live 板 `research:p02-smoke-1dce60` 有历史 in_flight 卡，整跑会 dispatch/spawn 真实 worker，
  扰动共享板面）；故不执行 `bin/deep-research-loop.sh` 全流程写证据，属 C6 的受控真跑。

### 收敛说明（修正 attempt 1 的错误归因）

attempt 1 的 dev-note 把不收敛归因于「收割吞产物 ⇒ 板面不推进到全终态」。spec §0.4 实测早已排除
续投：触发存储自始至终只有 seed 一条。**真跑复现证实**：seed 触发在单节点 tick 于 `max_nodes:1`
完成时 `finish("max_nodes")`（非 halt/drained），fleet `claim.complete` 据此走 `failure_status: open`，
把已消费触发**回退成 open** ⇒ 每轮重新可认领、`pending.status:open` 每轮都数到它 ⇒ 撞 max_passes。
修复 = `max_nodes:2` 让单节点 tick 自然 `halt`，complete 走 `success_status: done`，seed/续投触发
走到终态；板面排空时 drain 以 `drained` 退出（C5 真跑验证）。

## 变异自检（spec §3，M1–M5）

破坏后逐字还原并 `git diff --stat` 确认干净：

| 变异 | 判据 | 结果 |
|---|---|---|
| **M1** `result.evidences` → `result.evidence`（src/harvest.ts:317） | C1 | C1 挂（publishEvidence 调用次数 0 ≠ 2）✅ |
| **M2** `no_result` 分支 `casExplored:false` → `true`（src/harvest.ts:309） | C3 | C3 挂（casExplored 应为 false 却为 true）✅ |
| **M3** 空 `evidences` 也留 `in_flight`（harvestCard 增空数组 early-return） | C4 | C4 挂（空 evidences 应 CAS explored）✅ |
| **M4** 收敛判定恒为「还有活」（tick-entry 恒 hasPendingWork=true） | C5 | C5 挂：真实装配跑 `{"reason":"max_rounds","rounds":16}`（非 drained）✅ |
| **M5** 夹具改成手写旧形状（fixture `evidences`→`evidence`） | C0 | C0 挂（顶层键 ≠ required 集合）✅ |

每次破坏均「回显被改行 → 跑对应判据 → 逐字还原 → `git diff --stat` 确认干净」。
M1/M2/M3/M5 用 `test/harvest.test.ts` 判据验证；M4 用真实装配 drain 验证（spec §3.1 命中语义位置）。
