# dev_ledr_a8a_tick_inspect_01 —— A8a tick 接真实 agent-bus（只读侧，零写入）

## 产品改动

给 `src/tick-entry.ts` 增加**一个只读模式** `--inspect <channel_id>`：读真实 agent-bus channel →
解析 → 跑已交付决策 → 打印 JSON → **exit 0**（终态任何值都 exit 0，本模式是观察不是判决）。

- **新增 `src/tick-inspect.ts`**（读侧核心，纯逻辑与 IO 分离）：
  - `assembleBoard(messages)` —— **纯函数**：把原始消息数组组装成 `BoardState` / `TerminationInput`。
    按 `entity_id` 取 `channel_seq` 最大的那条作为**版本链 head**（H1）；`research.*.v1` 消息
    **显式跳过并计数**（`skippedV1`，不静默丢弃，H2）；`research.evidence.v2` 收集 `clue_id`
    为覆盖集合（coverage = 集合大小，H4）。
  - `readChannelMessages(channelId)` —— 用 `src/bus.ts` 的 `getMessages` **分页**读（`after_seq`
    翻到取空，H3），并带**无前进守卫**防异常后端死循环。全程只发 GET（H6）。
  - `computeInspect(channelId, messages)` —— 组装 + 调 `./tick` 的 `decideTick` /
    `decideTermination`（H5，不重新实现）。
  - `runInspect(channelId, write?)` —— 完整只读跑一次：分页读 → 决策 → 打印 JSON → 返回 0。
- **修改 `src/tick-entry.ts`**：新增 `--inspect <channel_id>` 分支，委托给 `runInspect`；
  仍从 `./tick` import `decideTick`/`decideTermination`（H5 grep 通过）。`--help`/`--selfcheck`
  保持无副作用（A7 G6/G7 既有断言不被破坏，tick-entry 本体不 import `./bus`、无 `fetch`、无 `7490`）。
- **新增 `test/tick-inspect.test.ts`**：H1–H7 / H10，一个 describe 一个判据（spec §5.1）。
- **新增 `docs/dev-notes/dev_ledr_a8a_tick_inspect_01.md`**（本文件）：运行证据（H8/H9/H12）。

⛔ **零写入**：`--inspect` 代码路径只 import `./bus` 的 `getMessages`（只读 GET），
不 import `./mineru`、不 import `./export`（H7），不触碰 vault，不创建 channel（H6 安全+活性配对断言）。

## 硬验收映射

| # | 断言 | 覆盖 |
|---|---|---|
| H1 | 版本链按 head 取 | `H1: version chain taken by head`（同 entity 3 条 → 1 卡 status=explored） |
| H2 | v1 显式跳过并计数 | `H2: v1 messages explicitly skipped and counted`（v1×2+v2×1 → skippedV1=2） |
| H3 | 分页读到取空 | `H3: paginated read until empty`（100/20/0 → 3 次读取，2/3 次带 after_seq） |
| H4 | coverage = evidence.clue_id 集合大小 | `H4: coverage is unique clue_id set size`（同 clue_id 2 条 → coverage 1） |
| H5 | 不重新实现决策逻辑 | `H5: no decision reimplementation`（全仓 decideTick/decideTermination 定义各恰 1 份） |
| H6 | 全程只发 GET 且至少一次请求 | `H6: inspect issues only GET and at least one request` |
| H7 | 不触碰 MinerU / vault | `H7: inspect path does not touch MinerU or vault/export` |
| H8 | 真实语料实跑 exit 0 | 下方真实运行输出（`research:p02-smoke-1dce60`） |
| H9 | 真跑零写入 | 跑前 5 条 / 跑后 5 条（消息数不变） |
| H10 | 终态任何值都 exit 0 | `H10: terminal state any value → exit 0`（capped / null 均 exit 0） |
| H11 | 不得触碰 `.dd-evidence/` | git diff 校验为空 |
| H12 | 证据写 `docs/dev-notes/<id>.md`，仓根无 `IMPLEMENTATION_SUMMARY.md` | 本文件存在；仓根无该文件 |
| H13 | typecheck + 全量测试 exit 0 | `npm run typecheck` / `npm test` 均绿 |
| H14 | 既有用例一行未删 | git diff 无 `it(` 净减少（141 基线全保留） |

## 变异自检归因

| 变异 | 被杀断言 |
|---|---|
| V1m 版本链取首条而非 head | H1 |
| V2m v1 静默丢弃（不计数） | H2 |
| V3m 去掉分页（只读第一页） | H3 |
| V4m coverage 数 evidence 条数而非集合大小 | H4 |
| V5m `--inspect` 里插一次 POST | H6 |
| V6m 终态为 capped 时 exit 1 | H10 |

## 真实运行证据（H8 / H9）

前置命令（仅查询，非写入）读 `research:p02-smoke-1dce60`，跑 `--inspect` 后复查消息数：

```
$ node node_modules/.bin/vite-node src/tick-entry.ts -- --inspect "research:p02-smoke-1dce60"
{
  "channelId": "research:p02-smoke-1dce60",
  "messageCount": 5,
  "skippedV1": 0,
  "clueEntities": 2,
  "statusDistribution": {
    "open": 1,
    "in_flight": 1
  },
  "coverage": 1,
  "decisions": [
    { "kind": "reclaim", "clueId": "msg_01KZ6FT90ZH11S18KH3FQZ4CE3", "to": "open", "retries": 0 },
    { "kind": "dispatch", "clueId": "msg_01KZ6AF6P3SN4B43BYHQAJ8TTW" }
  ],
  "termination": { "state": null, "coverage": 1, "zeroGrowthRounds": 0, "capHit": false }
}
$ echo $?    # exit 0
```

- **H9 零写入核验**：该 channel 消息数 **跑前 = 5，跑后 = 5**（不变），证明 `--inspect` 未发起任何写入。
- 输出说明：5 条消息中 clue.v2×3（其中 2 条属同一 entity `msg_01KZ6FT90ZH11S…` 的版本链，按 head
  折叠成 1 张卡），因此 `clueEntities=2`（statusDistribution: open×1 + in_flight×1）；
  1 条 evidence（clue_id `test_clue_001`）→ coverage=1；终态 `null`（观察态），exit 0。

## 验收

- `npm run typecheck` —— exit 0
- `npm test` —— 141 条既有用例 + 新增 11 条（tick-inspect）全绿（152 条）
- `--inspect` 对 `research:p02-smoke-1dce60` 真跑 exit 0，且零写入（5→5）
- 未触碰 `.dd-evidence/`
