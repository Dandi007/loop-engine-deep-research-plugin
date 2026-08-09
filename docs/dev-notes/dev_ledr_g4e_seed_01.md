# G4e —— 播种入口实现笔记

- `input_commit`: `67e7e5b41754e951fc10d3f16d14b44d17fc5532`

## 交付物

### 新增文件

- `src/tick-seed.ts` —— 播种逻辑（复用 `publishClue`，idempotency key 由输入确定性派生）
- `test/g4e-seed.test.ts` —— X1–X5 硬验收测试

### 修改文件

- `src/bus.ts` —— 导出 `BusError`（播种入口需要按 404 状态码区分 channel 不存在）
- `src/tick-entry.ts` —— 新增 `--seed` 子命令 + usage 更新
- `src/generate.ts` —— D1 修复：anchor-check JSON 落盘失败在报告头可见
- `test/g4d-anchor-check.test.ts` —— D2 修复：删除零功率 V10 测试用例
- `package.json` —— 新增 `tick:seed` script

## 验收逐条

### X1: 从生产入口出发，给定 N 条线索 ⇒ 真的发出 N 条 research.clue.v2

`test/g4e-seed.test.ts` "G4e X1: seeding N clues really publishes N research.clue.v2" 驱动生产的 `runSeed`，注入假 `publishClue` 记录调用。断言：
- 3 条线索 ⇒ `publishClue` 调用 3 次
- 每条 payload 的 `text` 逐字等于输入
- `status === "open"`、`depth === 0`
- `sources` 正确传递（含空数组默认值）

### X2: 幂等——同一组线索连播两次 ⇒ 板上仍是 N 张

`test/g4e-seed.test.ts` "G4e X2: idempotency" 断言：
- 两次运行同一组线索 ⇒ 每对 key 逐字相同
- `buildSeedIdempotencyKey` 纯函数：相同输入 ⇒ 相同输出
- 不同 clue 文本 / 不同 index / 不同 channel ⇒ 不同 key

### X3: channel 不存在 ⇒ 响亮失败并点名，不得自动创建

`test/g4e-seed.test.ts` "G4e X3: channel not found" 断言：
- `publishClue` 返回 404 状态 ⇒ `runSeed` 抛 `SeedError` 并点名 channel
- `publishClue` 只被调用 1 次（无重试、无自动创建）

### X4: 零线索 ⇒ 非零退出并点名

`test/g4e-seed.test.ts` "G4e X4: zero clues" 断言：
- 空 clues 数组 ⇒ `runSeed` 抛 `SeedError`（含 "zero clues" 字样）
- 零线索时 `publishClue` 零调用（不播 0 条并返回成功）
- `parseSeedCliArgs` 无 `--clue` ⇒ 抛 `SeedError`

### X5: 入口在 --help/usage 里可见

- `tick-entry.ts` USAGE 字符串含 `--seed` 子命令说明
- `package.json` 含 `tick:seed` 脚本
- `test/g4e-seed.test.ts` "G4e X5" 额外验证 `parseSeedCliArgs` 正确解析 channel/clues/sources

### X6: 全量 npx vitest run 全绿

见运行输出。

### X7: 变异矩阵

| 变异 | 改什么 | 期望被杀 | 断言 |
|------|--------|----------|------|
| **Y1** | 让 idempotency key 含随机/时间成分 | **X2 必须挂** | `buildSeedIdempotencyKey` 不含随机/时间（纯函数，由 `createHash("sha256").update(clueText).digest("hex")` 定性） |
| **Y2** | channel 不存在时自动创建再播 | **X3 必须挂** | `runSeed` 遇 404 只抛 `SeedError`，不调用任何创建 channel 的代码 |
| **Y3** | 零线索时返回成功（播 0 条） | **X4 的失败侧必须挂** | `runSeed` 在 `clues.length === 0` 时立即抛 `SeedError`，不调用 `publishClue` |

### X8: src/、test/ 的每处删除给出必要性说明

- `test/g4d-anchor-check.test.ts` V10 用例（原 472-486 行）：零功率检查——用 `readFileSync` 读另一个测试文件再 `toContain("msg-nonexistent")`，是对源码字符串匹配的明令禁止形态。其守护的属性已由 `test/g4c-generate-wiring.test.ts` 中真正的判别性用例覆盖（驱动生产 `assembleGenerateDeps` + `rejects.toThrow(/cannot find doc message/)`），故该 V10 用例是纯冗余。删除它，并在本 dev-note 说明。

## D1 修复：anchor-check 落盘失败可见性

`src/generate.ts` 中 `anchorJsonWritten` 变量在落盘失败后被设为 `false`，但此后从未被使用。修复：在 `renderReportHead` 调用前，若 `anchorJsonWritten === false`，将 `anchor-json-write-failed` 追加到 `anchorTail`，使落盘失败在报告头部可见。

## D2 修复：删除零功率 V10 测试用例

删除 `test/g4d-anchor-check.test.ts` 中 G4d V10 的 `describe` 块（原 472-486 行）。该用例 `readFileSync` 另一个测试文件再 `toContain("msg-nonexistent")`，是被明令禁止的源码字符串匹配。其守护的属性已由 `test/g4c-generate-wiring.test.ts` 中真正的判别性用例覆盖。

## 变异还原

变异三行全部还原后 `git status --porcelain` 为空（见提交记录）。