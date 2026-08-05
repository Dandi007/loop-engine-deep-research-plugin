# A9 —— 让这条流水线**真的跑起一个 tick**

> 上游依据：`wf-dc0c15` 的 `spec.md`(rev7) §3.2 / §3.4。前置已合入 main：链 A 全部 + A7 + A8a–A8f。
> 本包全部依据来自 2026-08-05 V1 首跑实测，不是推测。

## 缺口

V1 首跑严格走 `bin/deep-research-loop.sh` 却 **0 个 tick**，三层缺陷：
1. **驱动用 `node` 跑 loop-engine**：`dist/cli.js` 用 extensionless import，node ESM 不解析，
   bun 解析 ⇒ `ERR_MODULE_NOT_FOUND: .../dist/engine` 这类「指向不存在文件、实则是解析器不兼容」的误导错误；
   `bin/deep-research-loop.sh:72` 写死 `node "$LOOP_ENGINE_CLI" drain`。
2. **换了 bun 仍 0 tick**：`{"reason":"drained","rounds":0,"ticksByLabel":{"tick":0}}`。
3. **根因（架构级）**：tick 从文件触发存储 `$RUN_ROOT/stores/trigger` claim，而 `RUN_ROOT` 带时间戳
   ⇒ 每次全新空目录；`fleet.yaml.tpl` 无任何 seed/trigger 投递 ⇒ `claimableCount()` 恒 0 ⇒ 0 tick。

## 改动

### `bin/deep-research-loop.sh`（1.1 驱动运行器 + 1.2 首个触发）
- 新增 `LOOP_ENGINE_RUNNER`（可覆盖）；缺省解析 **bun**（PATH 或 `$HOME/.bun/bin/bun`）。
  ⛔ 解析不到 ⇒ **响亮失败**（非零退出 + 文本点名 `runner` / `bun` / `refusing to fall back to node`）；
  ⛔ **绝不回退 node**（F1/F2/F3）。
- 新增 `LOOP_STORE_CLI`：从 `LOOP_ENGINE_CLI` 同 dist 根派生（`<dist>/lib/store-cli.js`），可覆盖。
- **drain 之前**向 `TRIGGER_STORE_DIR` 投下第一条 `status:"open"` 触发
  （实测契约 `put '{"id":"...","status":"open","body":{...}}'`），否则 drain 必然 0 tick（F4/F5）。
- drain 改为 `"$LOOP_ENGINE_RUNNER" "$LOOP_ENGINE_CLI" drain ...`（不再是 `node`）。
- ⛔ `LOOP_ENGINE_CLI` / `LOOP_STORE_CLI` / `LOOP_ENGINE_RUNNER` 的**派生与导出**放在 render 之前，
  保证 dry-run（G1/G2）能渲染；文件存在性校验只在非 dry-run 的真实跑里做。

### `workflows/deep-research/fleet.yaml.tpl` + `tick/workflow.yaml` + `tick/templates/tick.md`（1.3 贯通）
- fleet input 增 `trigger_store_dir: ${TRIGGER_STORE_DIR}`、`loop_store_cli: ${LOOP_STORE_CLI}`、
  `loop_engine_runner: ${LOOP_ENGINE_RUNNER}`（F6 bin → fleet → workflow → tick.md 四层）。
- workflow seed payload 注入三者。
- tick.md 执行 `--run` 后读取 JSON 的 `hasPendingWork`：为真 ⇒ `loop-store put` 下一条触发
  （`id` 用 `a9-$(date +%s%N)-$$` 保证**每轮唯一**，否则 put 覆盖）；为假 ⇒ 不投 ⇒ drain 自然收敛（F9/F10）。
- **（评审 minor）** tick.md 的续投守卫由「任一注入为空 ⇒ 静默不投」改为
  「hasPendingWork=true 而注入缺失 ⇒ **响亮失败**（非零退出 + 点名缺项）」，杜绝配置破损退化成假「板被排空」。

### `src/tick.ts`（1.3 纯判定）
- 新增 `PENDING_CLUE_STATUSES = ["proposed","open","in_flight"]` 与纯函数
  `hasPendingWork(state)`：板面是否有非终态 clue，由板面状态**确定性**推出（F7/F8 判别对）。

### `src/tick-run.ts` / `src/tick-entry.ts`
- `RunWriteOutcome` 新增 `hasPendingWork: boolean`，在 `runChannelWrite` 用 `hasPendingWork(state)` 填出。
- **（评审 note）** `hasPendingWork` 改由**写后板面**判定：用成功 CAS 的写后 status 重建板面
  （`applyCasOutcomes`），避免「本 tick 把最后非终态卡推到终态却仍报 true、多投一条」。
- 用法文本补充说明 `hasPendingWork`。

### 测试 `test/a9-tick-trigger.test.ts`（新增 13 条）
- F7/F8：`hasPendingWork` 判别对（只差板面内容）。
- F1/F2/F3：脚本无 `node "$LOOP_ENGINE_CLI"`；不可解析 runner ⇒ 非零 + 点名 + 不执行 node。
- F4/F5：假 runner 记录 argv，断言 drain 前 put 了 `{id,status:"open",body}` 触发且 drain 用 runner。
- F6：`trigger_store_dir` 四层贯通 + 渲染后 input 非空。
- F9/F10：tick.md 依 `hasPendingWork` 决定是否 put；连投两轮 id 唯一。

## 非目标（照抄 spec §4）

⛔ 不改 `loop-engine` 仓；⛔ 不实现 triage / synthesizer / debater；⛔ 不注册协议；
⛔ 不改 `--add-dir` 语义（非安全边界）；⛔ 不得绕过 A8b 的 `realCas`；
⛔ 不得为了让 F0 通过而放宽任何既有守卫（A8f F5 / A8e H14）。

## 验收（F0–F16）

- **F0 真机端到端（本包已实际执行，不再 defer 到 gate）**：以真实 `bin/deep-research-loop.sh`
  在 `research:p02-smoke-1dce60` 上跑，drain 输出 **`ticksByLabel.tick = 16`（≥1）**，
  round_end 全为 `errors:0`（16/16 个 tick 都真实执行了 tick 节点、输出 hasPendingWork 并续投）。
  跑前跑后消息数增量：**head_seq 11 → 14（净增 3 ≤ --max-writes 默认 5）**（记录见下方
  「F0 消息数增量约束」）。`LOOP_ENGINE_CLI=/data/worktrees/loop-engine-v1build/dist/cli.js`
  （spec §5 备好的构建）、`LOOP_ENGINE_RUNNER=$HOME/.bun/bin/bun`。
- F1 无 `node "$LOOP_ENGINE_CLI"`；F2/F3 不可解析 ⇒ 响亮失败且不回退 node。
- F4/F5 drain 前触发存储非空、形状 `{id,status:"open",body}` 且可被 `claim open done tick` 认领。
- F6 `trigger_store_dir` 四层贯通；F7/F8 `hasPendingWork` 判别对；F9 依字段决定续投；F10 id 唯一。
- F11 既有 A8f F1/F5、A8e H6/H7/H14、A8d P1/P2、A8c N1/N2 原用例仍通过。
- F12 `--selfcheck` 保留且无副作用；F13 不碰 `.dd-evidence/`；F14 typecheck + 全量测试 exit 0。
- F15 既有 **254** 条用例一条不删（本次净增 13 条）。
- F16 证据写本 dev-note，仓根无 `IMPLEMENTATION_SUMMARY.md`。

### F0 消息数增量约束

真机 F0 在 `research:p02-smoke-1dce60` 上实际执行：**跑前 head_seq=11（11 条），
跑后 head_seq=14（14 条），净增 3 条，≤ `--max-writes` 默认 5**。
`EVIDENCE_CHANNEL` 未配置（留空，spec §1.4 无默认值）⇒ 无收割决策、0 张待收割卡；
F0 达成（`ticksByLabel.tick = 16 >= 1`）。

### 关键修复（评审 finding 落地）

- **tick.md 入口可执行（blocker）**：生产值由 `bash "$PLUGIN_ROOT/bin/tick-entry.sh"`
  改为**裸可执行路径** `$PLUGIN_ROOT/bin/tick-entry.sh`（bin/deep-research-loop.sh:25），
  并把 `bin/tick-entry.sh` 置为可执行；避免 `tick_entry="bash "…""` 被引成单个词而无法解析。
- **workflow 可选占位符（blocker，F0 实测暴露）**：`EVIDENCE_CHANNEL`/`ALLOWED_ROOT` 缺省为空
  ⇒ 注入值为 `null` ⇒ workflow.yaml 里必填 `{{evidence_channel}}`/`{{allowed_root}}` 填充即抛
  「模板填充缺值」⇒ tick 节点根本无法起跑（正是 F0 该抓的缺陷类）。改为可选 `{{evidence_channel?}}`
  /`{{allowed_root?}}`（缺省渲成空串，tick.md 依非空分支决策）。
- **续投静默空守卫（minor）**：tick.md 原为「任一注入为空 ⇒ 静默不投、exit 0」⇒ 配置破损退化成
  「板被排空」假象。改为 hasPendingWork=true 而注入缺失时**响亮失败**（非零退出 + 点名缺项）。
- **hasPendingWork 用写后板面（note）**：`runChannelWrite` 原来用写前快照 `state` 判 hasPendingWork，
  一个把最后非终态卡推到终态的 tick 仍报 true、多投一条。现用成功 CAS 的写后 status 重建板面再判定
  （`applyCasOutcomes`，src/tick-run.ts）。
