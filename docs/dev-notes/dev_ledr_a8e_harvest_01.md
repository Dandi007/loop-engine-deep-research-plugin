# A8e —— 收割：把 `worker.result.v1` 转成 evidence 与新 clue 写回研究板

## 缺口

`agent-run` 在 worker 退出后自己校验并发布 `worker.result.v1` 到 `board:agent-runs`，
幂等键 `agent-run:<run_id>:result`。但研究需要的是 `research.evidence.v2` 落到证据 channel、
新线索落到板上（板的唯一写者 = 调度器）。这一步转换与回写无人负责——本包在 tick 的
回收步（第 2 步）内补上收割：`exited(exit_code=0) → CAS 到 explored` 之前。

## 改动

### 新增 `src/harvest.ts`
- 确定性映射纯函数：
  - `composeAnchor`：`<source>://<locator>@<revision>#<range>`；range 缺省时**省略 `#` 段**
    （H3/H4）。
  - `evidenceFromWorker`：`clue_id ← 卡的 entity_id`（引擎已知，worker 不产出；H5 判别性），
    `anchor / quote / claim` 映射自 worker evidence；四必填字段校验非空（H2）。
  - `clueFromWorker`：`text ← clue`；`status = proposed`（深度内）或 `blocked`（depth+1 >
    maxDepth，带非空 rationale，**不静默丢弃**，H11）；`depth ← 父卡 + 1`；`sources ← 继承父卡`；
    `parent ← 父卡 entity_id`（H10）。
- `harvestCard`：读结果 → 预算判定 → 发布 evidence + 新 clue → 返回报告。
  幂等键 `dr-evidence:<run_id>:<index>` / `dr-clue:<run_id>:<index>`（H8/H9，index 为稳定序号）。
  板上 clue 数达 `maxClues` ⇒ 不新增 clue、evidence 照发、显式报告跳过条数（H12）。
  剩余预算不足整卡 ⇒ **零 publish、零 CAS**、响亮报告（H13）。
  ⛔ 本函数**不执行 CAS**——CAS 由上层在发布全部成功后才执行（§1.1，H6/H7）。
- `MissingEvidenceChannelError`：证据 channel 无默认值，缺失/未接线 ⇒ 响亮报错、零请求（H14）。
- `OVER_MAX_DEPTH_RATIONALE`：超 maxDepth 落 blocked 的明确 rationale。

### `src/tick.ts`
- `Decision` 新增 `harvest` 分支（携带 `runId / text / depth / sources`）。
- `decideTick`：`exited(0)` 的 in_flight 卡改发 `harvest` 决策（取代原先的 reclaim→explored）。

### `src/tick-run.ts`
- `WriteDeps` 新增可选 `harvest?: HarvestDeps`（未接线时遇 harvest ⇒ `MissingEvidenceChannelError`）。
- `runWrite` 新增 `harvest` 分支：evidence channel 缺失/冻结先拒（H14/H16），调 `harvestCard`，
  `casExplored` 时最后 CAS 到 explored（H6/H7）。
- `RunWriteOptions` 新增 `evidenceChannelId / maxDepth / maxClues`（证据 channel 显式传入，无默认、无推导）。
- `runChannelWrite` 组装真实收割依赖：`readWorkerResult` 读 `board:agent-runs`，
  `publishEvidence / publishClue` 走 `bus`。
- `parseRunCliArgs` 支持 `--evidence-channel <id>`。

### `src/tick-inspect.ts`
- 新增 `readWorkerResult(runId)`：分页读 `board:agent-runs`，按 `run_id` 取 worker.result.v1。

### `src/tick-entry.ts`
- `--run` 用法补充 `--evidence-channel`，接线透传。

## 硬验收（H1–H23）

| 判据 | 实现/测试 |
|---|---|
| H1 每条 evidence 各发一条 evidence.v2 | `test/harvest.test.ts` 端到端断言 publish 数与 kind |
| H2 四必填字段齐全非空 | `evidenceFromWorker` + 断言 |
| H3 anchor 形如 `<source>://<locator>@<revision>#<range>` | `composeAnchor` |
| H4 无 range 时不带 `#`（独立用例） | `composeAnchor` |
| H5 clue_id 取卡 entity_id（判别性） | worker 带假 clue_id ⇒ 断言用卡的 id |
| H6 CAS 发生在所有 publish 之后 | 调用序列断言最后一个为 explored CAS |
| H7 publish 中途抛错 ⇒ 零 CAS（配 H6） | 第 2 条 evidence 抛错 ⇒ 断言零 CAS |
| H8 幂等键 `dr-evidence|dr-clue:<run_id>:<index>` | 捕获键断言 |
| H9 幂等键无时间戳/随机（判别性） | 同输入跑两次键集合相等 |
| H10 proposed / depth+1 / sources 继承 / parent | `clueFromWorker` 断言四项 |
| H11 超 maxDepth ⇒ blocked 且 rationale 非空 | 独立用例，确有一条可发布 clue |
| H12 达 maxClues ⇒ 不新增 clue、evidence 照发、报告跳过数 | `runWrite` 断言 |
| H13 预算不足 ⇒ 零 publish 零 CAS、响亮报告 | `runWrite` + `harvestCard` 预算边界 |
| H14 证据 channel 无默认、缺失响亮报错、零请求 | 单元层 + **生产 `runChannelWrite` 路径**（缺省 evidenceChannelId ⇒ 抛错、零 publish） |
| H15 无 `.board`→`.evidence` 推导 | 源码 grep 断言 |
| H16 v1 冻结 channel 拒写、零请求 | `FrozenChannelError` + 未调用 readWorkerResult |
| H17 A8c N1/N2、A8d P1/P2 仍成立 | 原用例未删、仍通过 |
| H18 `--selfcheck` 保留且无副作用 | plugin-wiring 原用例 |
| H19 `reason` 未落库且写进 dev-notes | payload 无 `reason`；本文件下节说明 |
| H20 不碰 `.dd-evidence/` | 提交文件面不含 |
| H21 typecheck + 全量测试 | 已验证 exit 0 |
| H22 既有用例一条不删 | 208 → 237（净增 29） |
| H23 dev-notes 存在、仓根无 `IMPLEMENTATION_SUMMARY.md` | 本文件 |

## ⛔ 关于 worker 的 `reason`：本包不落库（H19）

worker 的 `proposed_clues.items` 只有 `{clue, reason}`，缺 `status / depth / sources / parent`。
其中 `reason` 的潜在消费者是 triage，而 **triage 尚未实现（属 R2）**。

> 判据（本线自己记的）：一个字段若说不出具体的消费者与消费方式，它就不该存在。
> `reason` 当前无消费者；`clue.v2` 的 `rationale` 注册描述是「dropped / blocked 的理由」，
> 用它装提案理由是语义挪用；`additionalProperties: true` 允许塞自造字段，但「允许塞」不是「该塞」。
> ⇒ **本包不造这个字段**；R2 实现 triage 时若确需，届时带着消费者一起加。**非沉默丢弃，是显式决策。**

## 变异自检（亲跑，破坏后还原并验证干净）

| 变异 | 被杀断言 | 验证 |
|---|---|---|
| U8 anchor 无 range 时仍拼空 `#` | H4 | 亲跑 H4 挂；还原干净 |
| U5 达 maxClues 时连 evidence 也不发 | H12 | 亲跑 H12 挂；还原干净 |

> U1（CAS 提前）→ H6/H7；U2（clue_id 用 worker 值）→ H5；U3（幂等键掺 Date.now）→ H9；
> U4（超 maxDepth 静默丢弃）→ H11；U6（预算不足半发）→ H13；U7（证据 channel 字符串推导）→ H14/H15。
> 每条变异后 `git diff --stat` 复核还原，未把变异留在工作区。

## Rework（attempt 2，处理 final review rf-attempt_01KZ7CM1GNH7V8YZ4QVRY9H8AB 五条 finding）

### blocker：evidence channel 未接进生产装配链 ⇒ tick 卡死
`--run` 要求 `--evidence-channel`，但原装配链只透传 `TICK_ENTRY / TICK_CHANNEL`，
一旦出现 `exited(0)` 卡（正是本包要处理的）`decideTick` 发 `harvest`，`runWrite`
抛 `MissingEvidenceChannelError`，tick 永久卡在 in_flight（同时回归 A8b/A8c/A8d 的
`--run` 路径）。修复：把 evidence channel 沿装配链一路透传——

- `bin/deep-research-loop.sh` 导出 `EVIDENCE_CHANNEL`（**无派生默认值**：部署方必须显式配置到
  已核实存在的证据 channel；**运行时不做 `.board`→`.evidence` 推导**，H15）。
- `workflows/deep-research/fleet.yaml.tpl` 增加 `evidence_channel: ${EVIDENCE_CHANNEL}` input。
- `workflows/deep-research/tick/workflow.yaml` seed payload 携带 `evidence_channel`。
- `workflows/deep-research/tick/templates/tick.md`：非空 evidence_channel 时
  `--run "$tick_channel" --evidence-channel "$evidence_channel"`。
- 新增接线判别测试（plugin-wiring，镜像 N9 的 tick_channel 判别）证明
  fleet → workflow → template 端到端带上非空 evidence_channel（测试显式注入 EVIDENCE_CHANNEL）。

### major：H14/H13 落到 `--run` 生产路径（spec §4.1 纪律 8）
新增生产路径用例：构造真实 in_flight 卡 + `exited(0)` run + `worker.result.v1`，
`decideTick` 发 `harvest` 决策；**不传 evidenceChannelId** 调 `runChannelWrite`
（生产装配层 evidenceChannelId=""）⇒ 响亮抛 `MissingEvidenceChannelError` 且**零 publish**
（不发 evidence / clue / CAS 任何写请求）。

### minor：anchor 缺组件不再静默塞空串
`anchorForEvidence` 原先对缺失 source/locator/revision 回退空串，产出退化锚 `"://@"`，
非空故能骗过 `assertEvidenceComplete`，随后被不可回退地发布到无 DELETE 的 append-only bus。
现改为缺任一组件（含空串）⇒ **响亮抛错**，与「解析不到 secret 不得塞空串」纪律同源。

### minor：maxClues 封顶改为随发布递增的运行计数
原实现 `atMaxClues` 只按 pre-tick 快照（`assembled.clueEntities`）判一次，多张 harvest 卡
会把板面冲到 maxClues 之上。现 `harvestCard` 用 `boardClueCount` 运行计数，每发一条新 clue 就 +1，
逐条校验封顶；预算所需写数也按「本卡实际最多可发条数」计算。新增判别用例
（boardClueCount=62、maxClues=64、卡带 5 条 ⇒ 只发 2 条、跳 3 条、板不超 64）。

### note：readWorkerResult 复用已读消息列表
`runChannelWrite` 现在只对 `board:agent-runs` 分页读一次，同一份 `runsMessages`
既喂 `buildRunsFromMessages`（runs 归集）又喂 `findWorkerResult`（每张卡的 worker.result 查询），
消除「每张 harvest 卡把整个 channel 再分页一遍」的 O(cards × channel) 读放大。

## Rework（attempt 3，处理 final review rf-attempt_01KZ7DKP322DDYPAP7S5BT1561 三条 finding）

### major：maxClues 封顶必须跨多张 harvest 卡累计（attempt 2 复现）
attempt 2 的修复把 `boardClueCount` 复制成本地计数并只递增本地，**从不写回**，
且 `runWrite` 把同一 `deps.harvest` 传给每张卡、`runChannelWrite` 只从 `assembled.clueEntities`
设一次 `boardClueCount`——所以多张卡在同一 tick 仍各按陈旧的 pre-tick 快照重算 headroom，
板面可超 maxClues（boardClueCount=63、maxClues=64、两张 exited(0) 卡各带 1 条 clue ⇒
卡 A 发 1 条（64）、卡 B 再按旧 63 发 1 条（65））。
修复：`HarvestDeps.boardClueCount` 改为**共享可变计数 `{ value }`**。`harvestCard` 取的是对
共享对象的引用，每发一条新 clue 就 `boardClueCount.value += 1` 写回；`runChannelWrite` 组装
`{ value: assembled.clueEntities }`，而 `runWrite` 对每张 harvest 卡都用同一 `deps.harvest`
对象 ⇒ 计数在卡间**累计**。新增判别用例（两张卡、共享计数从 63 停在 64，第二张一条不发）。

### minor：装配层默认值不得由板 channel 名派生（spec §1.4 / H15）
attempt 2 把 `.board`→`.evidence` 命名假设从运行时代码搬进装配脚本：
`EVIDENCE_CHANNEL` 缺省 `research:p02-smoke-1dce60.evidence` = 板 channel `TICK_CHANNEL`
（`research:p02-smoke-1dce60`）追加 `.evidence`。实测该板 channel「无任何后缀」，没有 `.evidence`
兄弟——正是 spec §1.4 禁派生、要显式传入的原因；且发布 append-only 无 DELETE、不可回退。
修复：`bin/deep-research-loop.sh` 的 `EVIDENCE_CHANNEL` **不再给派生默认值**（缺省留空），
部署方必须显式配置到**已核实存在**的证据 channel；缺失时 `--run` 遇到 harvest 决策会响亮失败
（§1.4 / H13/H14）。运行时「无默认、响亮失败」纪律不变；修掉的是部署默认的具体取值。

### note：H15 必须仓库级 grep（不能只读 src/harvest.ts 的宽松代理）
原 H15 只读 `src/harvest.ts` 并断言 `not.toMatch(/replace\(/)`，检测不到加在
`src/tick-run.ts` / `src/tick-entry.ts` / shell / workflow 装配层里的派生——finding 2 的
派生默认值实证就住在 `bin/deep-research-loop.sh`。修复：H15 扫描 `src/`、`bin/`、`workflows/`、
`scripts/` 全部代码文件，对 replace / 字符串拼接 / 模板字面量这几类「由板 channel 名推导
evidence channel」的**代码形态**逐一断言不存在（只匹配代码、不匹配文档注释里的「`.board`→`.evidence`」字样）。

## 非目标（spec §5）

- 不做真机 `--run`（端到端属 V1）。
- 不实现 triage / synthesizer / debater（R2）、不实现 `dr-worker-web`、不注册协议。
- 不绕过 A8b 的 `realCas` 另写 CAS；不实现 coverage / 终止判定（后续包）。
- 不外写真实 secret / 不触碰真实 vault / MinerU / bus（测试零触网）。