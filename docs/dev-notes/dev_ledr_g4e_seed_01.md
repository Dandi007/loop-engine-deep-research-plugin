# G4e —— 播种入口实现笔记

- `input_commit`: `0efb9d1da74aa58649d4e60971173b6b478ab914`

## 交付物

### 新增文件

- `src/tick-seed.ts` —— 播种逻辑（复用 `publishClue`，idempotency key 由输入确定性派生）
- `test/g4e-seed.test.ts` —— X1–X5 硬验收测试

### 修改文件

- `src/bus.ts` —— 导出 `BusError`（播种入口需要按 404 状态码区分 channel 不存在）
- `src/tick-entry.ts` —— 新增 `--seed` 子命令 + usage 更新；导出 `main` 函数供测试驱动 CLI 级别退出码
- `src/generate.ts` —— D1 修复：anchor-check JSON 落盘失败在报告头可见；`renderReportHead` 在 `anchorRate` 非 null 时也追加 `anchorTail`
- `test/g4d-anchor-check.test.ts` —— D2 修复：删除零功率 V10 测试用例；D1 修复：替换零功率 V13 为判别性用例
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

`test/g4e-seed.test.ts` "G4e X4: --seed CLI branch exits non-zero on loud failure" 驱动生产 `main()` 函数，断言：
- `main(["--seed", "research:test"])` → exit code 2（零 clues 在 CLI 层映射为 loud failure）
- `main(["--seed"])` → exit code 2（缺失 channel 在 CLI 层映射为 loud failure）
- 这两条断言守卫 `src/tick-entry.ts:151-162` 的 try/catch → exit code 2 映射，改变该 return 会让测试变红

### X5: 入口在 --help/usage 里可见

- `tick-entry.ts` USAGE 字符串含 `--seed` 子命令说明
- `package.json` 含 `tick:seed` 脚本

`test/g4e-seed.test.ts` "G4e X5: --seed visible in --help and npm scripts" 行为性验证：
- `main(["--help"])` stdout 输出包含 `--seed`（驱动真实 USAGE 字符串）
- `main(["-h"])` stdout 输出包含 `--seed`（覆盖 -h 别名）
- `readFileSync("package.json")` 解析后断言 `pkg.scripts` 具有 `tick:seed` 属性

### X6: 全量 npx vitest run 全绿

24 个测试文件，452 个用例，全部通过。
无失败、无跳过。

### X7: 变异矩阵

| 变异 | 改什么 | 被杀断言 |
|------|--------|----------|
| **Y1** | 让 idempotency key 含随机/时间成分（每次不同） | `test/g4e-seed.test.ts` "G4e X2: idempotency — same clues twice ⇒ same keys" → "two runs of same clues produce identical key sequences" 断言两次 key 序列逐字相同；"idempotency key is deterministic from input" 断言 `buildSeedIdempotencyKey("ch", 0, "hello") === buildSeedIdempotencyKey("ch", 0, "hello")` |
| **Y2** | channel 不存在时自动创建再播 | `test/g4e-seed.test.ts` "G4e X3: channel not found ⇒ loud failure, no channel creation" → "publishClue is called exactly once before throwing (no automatic creation)" 断言 `publishClue` 仅调用 1 次（无自动创建） |
| **Y3** | 零线索时返回成功（播 0 条） | `test/g4e-seed.test.ts` "G4e X4: zero clues ⇒ non-zero exit, not 'published 0 and success'" → "zero clues does not call publishClue" 断言 `publishClue` 零调用；"main --seed with zero clues returns exit code 2" 断言 CLI 层 exit code === 2 |

### X8: src/、test/ 的每处删除给出必要性说明

- `test/g4d-anchor-check.test.ts` V10 用例（原 472-486 行）：零功率检查——用 `readFileSync` 读另一个测试文件再 `toContain("msg-nonexistent")`，是对源码字符串匹配的明令禁止形态。其守护的属性已由 `test/g4c-generate-wiring.test.ts` 中真正的判别性用例覆盖（驱动生产 `assembleGenerateDeps` + `rejects.toThrow(/cannot find doc message/)`），故该 V10 用例是纯冗余。删除它，并在本 dev-note 说明。

## D1 修复：anchor-check 落盘失败可见性

`src/generate.ts` 中 `anchorJsonWritten` 变量在落盘失败后被设为 `false`，但此后的 `renderReportHead` 只在 `anchorRate === null` 时追加 `anchorTail`，导致 valid anchor rate 时写入失败不可见。

修复两处：
1. `renderReportHead`：`anchorRate` 非 null 时也追加 `anchorTail`（`${anchorRate} ${anchorTail}`），使 `anchor-json-write-failed` 在报告头部可见
2. `test/g4d-anchor-check.test.ts` V13：替换为零功率的旧用例，新用例 `writeAnchorCheckJson` 抛错 → 断言 `report.body` 包含 `anchor-json-write-failed`（按 V12 模式读 `writeDoc` 调用记录）

## D2 修复：删除零功率 V10 测试用例

删除 `test/g4d-anchor-check.test.ts` 中 G4d V10 的 `describe` 块（原 472-486 行）。该用例 `readFileSync` 另一个测试文件再 `toContain("msg-nonexistent")`，是被明令禁止的源码字符串匹配。其守护的属性已由 `test/g4c-generate-wiring.test.ts` 中真正的判别性用例覆盖。

## 变异还原

变异三行全部还原后 `git status --porcelain` 为空（见提交记录）。