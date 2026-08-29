# C3 失败语义响亮化：哨兵静默失效必须响亮终态（判别性 spec）

## 背景（真机实据，2026-08-29 生死判定结论）

C5 冷启动 run `b34f64d729b4`（题目「loop-engine 的 sentinel 哨兵失效与 drain 收敛语义如何区分」）在 loop 推进 8 个 tick（coverage 0→7）后，drain 进程于 2026-08-29T11:51:06Z 在第 8 个 tick 的 `tick~1` 节点 dispatch 后死亡（tick8 run_dir `2026-08-29T115106-62cefac7` 的 events.jsonl 停在 `dispatch`，无 done/stop/journal.jsonl）。

loop-engine 基座的 drain 哨兵（drain-registry + 心跳续租）已正确记录死亡现场：

```
/data/loop-engine/runs/2026-08-29T105108-56a3e21e/drain.json
{ "contract_version": 2, "status": "running", "outstanding": 1,
  "last_heartbeat": 1787975466089, "pid": 3165154, ... }
```

此后约 6 小时，该 run 静默停在 `status="running"`，无 run.end（index.jsonl 该 drain 共 9 条 run.start、0 条 run.end）、无 sentinel_lost 终态、无告警；而 board 上仍存在未收割卡：`research:agent-harness-b34f64d729b4.index` 的 seq58 in_flight(run_id=3e463ad8)、seq56/57/60/61 open，docs head_seq=0（无报告）。

这违反 C3 不变量（条10/P5）：**存在未收割 in_flight 卡或 open 卡时 loop 不得静默退出，必须响亮终态或继续推进**。哨兵记了（heartbeat/outstanding），但「响亮」缺位——判定为 C3 缺陷「哨兵静默失效不响亮」。

## 修复对象与层

- 修复落在 deep-research 插件冷启动驱动层：`bin/deep-research-loop.sh` + `scripts/check-drain-failures.mjs`（该层是消费 loop-engine 基座哨兵 registry 的驱动面）。
- 铁律：不得 DR 专属 hack。哨兵判定读取的是 loop-engine 基座**已导出**的 drain registry（`drain.json` 的 `status/outstanding/last_heartbeat` + `index.jsonl` 的 `run.start/run.end` 配对 + `loop-events.jsonl`），chatgroup/dd/未来新域可用同一 registry 读取件继承同一失败语义。

## 判别性规格（不可放宽）

1. 冷启动驱动在 drain 进程**任何**退出/死亡路径后，必须读取 drain registry 判定哨兵终态。
2. 判定规则（判别核心）：
   - 若 drain 未写 `run.end`，或 `drain.json.status` 非终态（仍 `running`）且 `outstanding > 0`（存在未收割 in_flight/open 卡）⇒ 必须产出**响亮终态**：非零退出码 + 单一点名终态（含 drain_id、outstanding 数值、未收割 in_flight/open 计数/seq），绝不静默 exit 0，绝不把「带活儿猝死」伪装成 done。
   - 若 drain 正常写 `run.end` 且 `outstanding == 0` ⇒ 维持 exit 0。
3. 响亮终态必须可机器判读：stderr/终态记录含稳定 token（如 `sentinel_lost` 与 `outstanding=<n>`），供巡检/看门狗直接抓取。

## 判别测试（真跑 tick 判别，必须真跑）

新增测试必须**真实驱动一次 tick/drain** 走到「存在未收割 in_flight/open 卡（outstanding>0）时 drain 死亡」的场景（允许用 SIGKILL 子进程或构造未写 run.end 的 drain registry 状态），并断言：
- 驱动产出响亮 sentinel_lost 终态（非零退出码成立，且终态文本同时点名 `sentinel_lost` 与 `outstanding`）。
- 判别性：该测试在修复前必须红（当前实现静默 exit 0 / 不检查 registry），修复后必须绿；禁止「exit 0 也算过」，必须断言非零退出与 sentinel_lost 命名**同时成立**。
- 同时保留反向断言：正常 run.end + outstanding==0 ⇒ exit 0（防误报）。

## 验收

```dd-acceptance
npm ci
npm run typecheck
npm test
npm run smoke:cas
```

- 四命令全绿，且判别测试在 `npm test` 中真实执行（Tests M passed 且 M>0）。
- 新增/改动不得使既有 840 测试与 smoke:cas 回退。

## 边界

- 不碰生产主 checkout `/data/code/self/loop-engine-deep-research-plugin`；所有 git/install/test 仅在独立 worktree。
- 不修改 loop-engine 基座本体（基座哨兵 heartbeat/outstanding 已具备，本单只消费）；若发现基座 registry 导出不足，先记录精确缺失并以环境/有效断言分类，不得静默绕过。