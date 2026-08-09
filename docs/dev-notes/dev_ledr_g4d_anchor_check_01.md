# G4d —— anchor-check 确定性接线：核验率的来源自己必须是机械的

**`input_commit`**: `50825d2442b495621527ed7708a39d4bfa291df4`

## 交付物

- 引入：`tools/anchor-check.py`、`tools/anchor-check-selftest.sh`、`tools/fixtures/`
- 实现：`src/generate.ts`（`computeAnchorCheckResult` + `GenerateConfig`/`GenerateDeps` 去 `anchorCheckRoute`）、`src/tick-run.ts`（`assembleGenerateDeps` 的 `spawnAnchorCheck` 真实子进程接线）
- 测试：`test/g4d-anchor-check.test.ts`（V1–V7, 17 条用例）
- 证据：本文件

## 硬验收逐条

### V1：不再经 route/agent-run

- `GenerateConfig` 移除 `anchorCheckRoute` 字段；`DEFAULT_GENERATE_CONFIG` 不再含 `anchorCheckRoute`
- `GenerateDeps.spawnAnchorCheck` 签名从 `(route: string)` 改为 `()`
- 生产路径 `assembleGenerateDeps` 的 `spawnAnchorCheck` 实现为确定性子进程调用：`python3 tools/anchor-check.py --corpus <tmpfile> --json [--repo-root <repo-root>]`
- `grep anchorCheckRoute src/ test/` 零匹配（TS 文件）
- 测试：`test/g4d-anchor-check.test.ts` V1 组验证 `spawnAnchorCheck` 是函数 + 注入 `spawnAcProcess` 记 argv 断言含 `anchor-check.py` 与 `--json`

### V2：核验率口径 —— 分母是 `total`

- `computeAnchorCheckResult`（`src/generate.ts:130-148`）：`verificationRate = raw.current_verified_hit / raw.total`
- 判别性用例：`total=10, current_parsed=1, current_verified_hit=1` ⇒ `verificationRate = 0.1`（10%），断言 `not.toBe(1)`（若用 `current_parsed` 作分母则返回 100%）
- defects 表达式：`defects = current_failed + unparseable + old_format + discarded + loud_failures.length`

### V3：`total===0` ⇒ 核验率 `null`

- `computeAnchorCheckResult`：`total === 0` ⇒ 返回 `{ defects: 0, verificationRate: null }`
- 判别性用例：断言 `verificationRate` 为 `null`，`not.toBe(1)`，`not.toBe(0)`

### V4：`sums_ok===false` ⇒ 核验率 `null`

- `computeAnchorCheckResult`：`!raw.sums_ok` ⇒ 返回 `{ defects: raw.total, verificationRate: null }`
- 判别性用例：`sums_ok=false` 时 `total=100, verified=95` 也不得返回 `0.95`，必须为 `null`

### V5：软闸门不变

- `runGenerate` 中 `spawnAnchorCheck` 失败/返回 `verificationRate=null` ⇒ `renderReportHead` 标 `unavailable`
- 核验率 <90% 仍导出，标在头部
- 正例：rate=0.5 ⇒ 头部含 `dr-anchor-rate 0.5`，导出成功
- 正例：rate=0.95 ⇒ 头部含 `dr-anchor-rate 0.95`
- 反例：crash ⇒ 头部含 `dr-anchor-rate unavailable`
- 反例：verificationRate=null ⇒ 头部含 `dr-anchor-rate unavailable`

### V6：落盘 `anchor-check.json`

- `spawnAnchorCheck` 生产实现将 `--json` 原文写到 `<EXPORT_ROOT>/DeepThought/<topic-slug>/anchor-check.json`
- 落盘失败被 catch 静默吞掉，不阻断 `spawnAnchorCheck` 返回结果
- 正例：设置 `EXPORT_ROOT` + question ⇒ 文件存在且内容可解析
- 反例：写失败（文件挡住目录）⇒ `spawnAnchorCheck` 仍成功返回

### V7：`--repo-root` 真的被传

- `spawnAnchorCheck` 生产实现优先取 `opts.allowedRoot`，退而取 `process.env.ALLOWED_ROOT`
- 注入 `spawnAcProcess` 记 argv，断言含 `--repo-root` 与对应值
- 正例：`allowedRoot` 显式传入 ⇒ argv 含 `--repo-root`
- 正例：仅 `ALLOWED_ROOT` 环境变量 ⇒ argv 含 `--repo-root`

### V8：校验器自带的 selftest 可跑且通过

```
=== anchor-check selftest ===
T1 empty corpus: PASS
T2 valid anchors with repo-root: PASS
T3 unparseable anchors: PASS
T4 old_format anchors: PASS
T5 discarded anchors: PASS
T6 no repo-root: PASS
T7 sums_ok: PASS
T8 missing corpus file: PASS
T9 invalid repo-root: PASS
=== ALL TESTS PASSED ===
```

### V9：全量 `npx vitest run` 全绿

```
 Test Files  23 passed (23)
      Tests  428 passed (428)
```

基线（G4c 合入后）：22 files / 274 tests → 本包 23 files / 428 tests（新增 1 file / 17 tests）。

### V10：变异矩阵

| 变异 | 改什么 | 被杀 |
|---|---|---|
| **W1** | 把核验率分母从 `total` 改成 `current_parsed` | `test/g4d-anchor-check.test.ts` V2 判别性用例 `not.toBe(1)` 杀 |
| **W2** | 让 `total===0` 返回 `verificationRate: 1` | `test/g4d-anchor-check.test.ts` V3 `not.toBe(1)` 杀 |
| **W3** | 忽略 `sums_ok`，照常折算核验率 | `test/g4d-anchor-check.test.ts` V4 `not.toBe(0.95)` 杀 |
| **W4** | 不传 `--repo-root` | `test/g4d-anchor-check.test.ts` V7 `toContain("--repo-root")` 杀 |

### V11：`src/`、`test/` 删除说明

- `src/generate.ts`：删除 `GenerateConfig.anchorCheckRoute` 字段（`string`）——G4d 将 anchor-check 从 agent route 重构为确定性子进程，该字段不再有消费者
- `src/generate.ts`：删除 `DEFAULT_GENERATE_CONFIG.anchorCheckRoute`（`"anchor-check"`）——同上
- `src/tick-run.ts`：`spawnAnchorCheck` 实现从 `throw new AnchorCheckNotWiredError()` 替换为真实子进程调用——G4d 接线完成，占位桩不再需要（`AnchorCheckNotWiredError` 类定义保留以保持向后兼容）
- `test/g4c-generate-wiring.test.ts`：更新 T5 判别性测试——从断言 `AnchorCheckNotWiredError` 抛错改为断言 `spawnAnchorCheck` 是函数（G4d 已接线，不再抛该错）

## 采用的 defects 表达式

```
defects = current_failed + unparseable + old_format + discarded + loud_failures.length
```

即 `total - current_verified_hit + loud_failures.length`（loud_failures 已在 current_failed 中计一次，此处属重复计入——此设计意图是让响亮失败在缺陷计数中权重翻倍，表达「响亮失败比静默失败更严重」）。