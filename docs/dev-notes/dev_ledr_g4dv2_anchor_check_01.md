# G4d(v2) —— anchor-check 确定性接线：核验率的来源自己必须是机械的

development_id: `dev_ledr_g4dv2_anchor_check_01`
attempt: `implement`（initial，attempt_01KZKQHHCQN0X3GECEGXZS68ZJ）
input_commit: `af09c7d63da40764adc10c93872f9f546b0978df`

## 结论先行

`spawnAnchorCheck` 从占位 `AnchorCheckNotWiredError` 换成真实确定性子进程调用：
经 `ANCHOR_CHECK_BIN` 环境变量指向 katana 仓的校验器，以 `--corpus <tmpfile> --repo-root <ALLOWED_ROOT> --json` 调用。
`GenerateConfig.anchorCheckRoute` 字段移除，不再经 route/agent-run 派发。
核验率 = `current_verified_hit / total * 100`（百分数），分母是 `total`（不得用 `current_parsed`）。
`total === 0` ⇒ `unavailable`（非 100%）。`sums_ok === false` ⇒ `unavailable` 且点名 `sums_ok=false`。
`ANCHOR_CHECK_BIN` 未配置 ⇒ `unavailable`（非 0%）。
`--json` 完整输出落盘到导出件同目录 `anchor-check.json`（复用 `export.ts` 的 `slugify`）。
`defects = total - current_verified_hit`。
新增 `test/g4d-anchor-check.test.ts`（22 条，V1–V11）。
全量 **23 files / 432 tests** 全绿（基线 22/411 之上）。

```
$ unset ANCHOR_CHECK_BIN; unset DOC_CHANNEL; unset RESEARCH_ORIGIN; unset EXPORT_ROOT; npx vitest run

 RUN  v2.1.9 /data/loop-engine/development-mcp/attempt-context-v1/attempts/dev_ledr_g4dv2_anchor_check_01/attempt_01KZKQHHCQN0X3GECEGXZS68ZJ/implement/workspace-repo

 ✓ test/g2b-triage-wiring.test.ts (14 tests) 23ms
 ✓ test/ingest.test.ts (24 tests) 74ms
 ✓ test/harvest.test.ts (41 tests) 37ms
 ✓ test/g4d-anchor-check.test.ts (22 tests) 48ms
 ✓ test/generate.test.ts (34 tests) 177ms
 ✓ test/g4c-generate-wiring.test.ts (19 tests) 257ms
 ✓ test/a8f-adddir.test.ts (16 tests) 654ms
 ✓ test/tick-run.test.ts (43 tests) 663ms
 ✓ test/tick.test.ts (26 tests) 35ms
 ✓ test/s3.test.ts (19 tests) 17ms
 ✓ test/cas.test.ts (5 tests) 10ms
 ✓ test/tick-inspect.test.ts (11 tests) 30ms
 ✓ test/export.test.ts (13 tests) 24ms
 ✓ test/mineru.test.ts (9 tests) 36ms
 ✓ test/a10c-writebudget.test.ts (10 tests) 987ms
 ✓ test/a9-tick-trigger.test.ts (16 tests) 1927ms
 ✓ test/bus.test.ts (10 tests) 17ms
 ✓ test/protocol.test.ts (11 tests) 9ms
 ✓ test/g4a-question-wiring.test.ts (15 tests) 1263ms
 ✓ test/d1-deploy-config.test.ts (15 tests) 1817ms
 ✓ test/g4b-termination-wiring.test.ts (28 tests) 3200ms
 ✓ test/plugin-wiring.test.ts (19 tests) 3812ms
 ✓ test/a10b-convergence.test.ts (12 tests) 5634ms

 Test Files  23 passed (23)
      Tests  432 passed (432)
   Start at  01:11:15
   Duration  6.60s

⛔ 无 FAIL 段。
```

⛔ 本跑在 ANCHOR_CHECK_BIN / DOC_CHANNEL / RESEARCH_ORIGIN / EXPORT_ROOT 均未设置的干净环境下执行，无 FAIL 段。

## 硬验收逐条

| # | 判据 | 结果 |
|---|------|------|
| **V1** | 不再经 route：`spawnAnchorCheck` 是子进程调用，`anchorCheckRoute` 已移除 | PASS。`GenerateConfig` 无 `anchorCheckRoute`；`spawnAnchorCheck()` 无参数；`test/g4d-anchor-check.test.ts` V1 断言 argv 含 `--json`、`--repo-root` |
| **V2** | 核验率分母是 `total`。`total=10/current_parsed=1/current_verified_hit=1` ⇒ 10% | PASS。`runGenerate` 行 `ac.current_verified_hit / ac.total * 100`；`test/g4d-anchor-check.test.ts` V2 判别性断言 `dr-anchor-rate 10`（非 100） |
| **V3** | `total===0` ⇒ `null`（unavailable） | PASS。`runGenerate` 行 `if (ac.total === 0)` 跳过赋值；`test/g4d-anchor-check.test.ts` V3 断言 unavailable 且非 100/非 0 |
| **V4** | `sums_ok===false` ⇒ `null` 且点名 `sums_ok=false` | PASS。`renderReportHead` 第三参数 `anchorSumsOkFalse` 控制；`test/g4d-anchor-check.test.ts` V4 断言 `dr-anchor-rate unavailable sums_ok=false` 且与裸 unavailable 可区分 |
| **V5** | `ANCHOR_CHECK_BIN` 未配置 ⇒ unavailable | PASS。`assembleGenerateDeps` 的 `spawnAnchorCheck` 读 `process.env.ANCHOR_CHECK_BIN`，未配置即抛；`test/g4d-anchor-check.test.ts` V5 正反两例 |
| **V6** | 软闸门不变：<90% 仍导出但标在头部 | PASS。`test/g4d-anchor-check.test.ts` V6 正反两例（50% 与 95% 均导出，头部标注） |
| **V7** | `--repo-root` 真的被传（`ALLOWED_ROOT`）；非零退出/不可解析 ⇒ unavailable | PASS。`assembleGenerateDeps` 的 `spawnAnchorCheck` 传 `allowedRoot` 给 `--repo-root`；`test/g4d-anchor-check.test.ts` V7 判别性断言 argv 含 `--repo-root` + 失败传播一例 |
| **V8** | 落盘：`--json` 全文写到导出件同目录；目录推导复用 `export.ts` | PASS。`writeAnchorCheckJson` 用 `slugify(opts.question)` 推导目录，写 `anchor-check.json`；`test/g4d-anchor-check.test.ts` V8 正反两例 + 读完行号证明复用 |
| **V9** | 仓内没有自写校验器 | PASS。`git ls-files` 无 `anchor-check*.py`；`test/g4d-anchor-check.test.ts` V9 断言 |
| **V10** | `createdAt` 判别性用例存在且有牙；零功率源码匹配已删除 | PASS。旧 U6 `new Date()` 源码匹配已删除；新 U6 驱动生产 `spawnExport` 令 doc channel 无 `sourceMessageId` ⇒ 响亮失败 `cannot find doc message` |
| **V11** | 核验率单位无歧义（百分数），与既有同字段用例一致 | PASS。`renderReportHead` 输出 `dr-anchor-rate 100` / `0` / `95`（百分数，无 `%` 符号、无 `0.95`）；`test/g4d-anchor-check.test.ts` V11 断言 |
| **V12** | 全量 `npx vitest run` 在干净环境下真绿 | PASS。**23 files / 432 tests**，均 ≥ 基线 22/411 |
| **V13** | 变异矩阵逐断言归因，全部还原后 `git status --porcelain` 为空 | 见 §变异矩阵 |
| **V14** | 每处删除给出必要性说明 | 见 §删除说明 |

## 产品改动

- **`src/export.ts`**：`slugify` 从 `function` 改为 `export function`，供 `tick-run.ts` 的 `writeAnchorCheckJson` 复用目录推导。

- **`src/generate.ts`**：
  - `GenerateConfig` 移除 `anchorCheckRoute` 字段。`DEFAULT_GENERATE_CONFIG` 移除 `anchorCheckRoute: "anchor-check"`。
  - 新增 `AnchorCheckResult` 接口（`total`/`current_parsed`/`current_verified_hit`/`current_failed`/`old_format`/`unparseable`/`discarded`/`sums_ok`/`loud_failures`）。
  - `GenerateDeps.spawnAnchorCheck` 签名改为 `() => Promise<AnchorCheckResult>`（不再收 route 参数）。
  - `GenerateDeps` 新增可选 `writeAnchorCheckJson?(json: string): Promise<void>`。
  - `renderReportHead` 加第三参数 `anchorSumsOkFalse?: boolean`：为 true 时 `unavailable` 后追加 ` sums_ok=false`。
  - `runGenerate` 中 anchor-check 段重写：调用 `spawnAnchorCheck()` 后计算 `anchorRate = (ac.current_verified_hit / ac.total) * 100`；`total === 0` ⇒ 保持 `null`；`sums_ok === false` ⇒ 保持 `null` 且设 `anchorSumsOkFalse = true`；调用 `writeAnchorCheckJson`（软闸门，catch 吞错）。

- **`src/tick-run.ts`**：
  - 移除 `AnchorCheckNotWiredError` 类（不再需要）。
  - 导入新增 `AnchorCheckResult`（from `./generate`）和 `slugify`（from `./export`）。
  - `assembleGenerateDeps` 的 `spawnAnchorCheck`：读 `ANCHOR_CHECK_BIN`，未配置 ⇒ 抛；读 `opts.allowedRoot` 作为 `--repo-root`；将 evidences 序列化成临时 JSON 文件作为 `--corpus`；`execFileSync` 调用校验器并解析 JSON 输出；`finally` 清理临时文件。
  - `assembleGenerateDeps` 新增 `writeAnchorCheckJson`：取 `EXPORT_ROOT`，用 `slugify(opts.question)` 推导目录，`mkdir -p` 后写 `anchor-check.json`。

- **`test/g4c-generate-wiring.test.ts`**：
  - 移除 `AnchorCheckNotWiredError` 导入。
  - U6：删除零功率源码字符串匹配测试（`new Date()` 匹配），替换为判别性测试：驱动生产 `spawnExport`，令 doc channel 不存在 `sourceMessageId`，断言抛出 `cannot find doc message`。
  - U7：重写为「anchor-check 抛出 ⇒ head 显示 unavailable」和「生产 `assembleGenerateDeps` 的 `spawnAnchorCheck` 在 `ANCHOR_CHECK_BIN` 未设置时抛出」。
  - 所有 `spawnAnchorCheck` mock 改用 `AnchorCheckResult` 形状。

- **`test/generate.test.ts`**：
  - 导入 `AnchorCheckResult` 类型，新增 `anchorResult()` helper。
  - 所有 `spawnAnchorCheck` mock 改用 `anchorResult()` 或 `anchorResult({...})` 覆盖。

- **`test/g4d-anchor-check.test.ts`**（新增，22 条）：
  - V1: 无 route 参数 + argv 含 `--json`/`--repo-root`
  - V2: 分母是 `total`（判别性：total=10/parsed=1/hit=1 ⇒ 10%，非 100%）
  - V3: `total===0` ⇒ unavailable（非 100%）
  - V4: `sums_ok===false` ⇒ unavailable + `sums_ok=false` 可区分
  - V5: `ANCHOR_CHECK_BIN` 未配置 ⇒ unavailable（非 0%）；生产 `assembleGenerateDeps` 驱动
  - V6: 软闸门不变（50% 与 95% 均导出）
  - V7: `--repo-root` 在 argv；失败传播 ⇒ unavailable
  - V8: 落盘到导出目录 + 复用 `export.ts` 的 `slugify`；落盘失败不阻断导出
  - V9: `git ls-files` 无自写校验器
  - V10: `createdAt` 判别性测试存在（`g4c-generate-wiring.test.ts` U6）
  - V11: 核验率单位是百分数

## 变异矩阵

| 变异 | 改什么 | 预期被杀 | 实测 |
|------|--------|----------|------|
| **W1** | 核验率分母从 `total` 改成 `current_parsed` | V2 | 被杀。改 `runGenerate` 行 `ac.current_verified_hit / ac.total` → `ac.current_verified_hit / ac.current_parsed`，V2 判别性断言 `dr-anchor-rate 10` 变成 `dr-anchor-rate 100`，测试失败。还原。 |
| **W2** | `total===0` 返回 `verificationRate: 1` | V3 | 被杀。改 `runGenerate` 中 `total===0` 分支赋值 `anchorRate = 100`，V3 断言 `dr-anchor-rate unavailable` 变成 `dr-anchor-rate 100`，测试失败。还原。 |
| **W3** | 忽略 `sums_ok`，照常折算核验率 | V4 | 被杀。移除 `else if (!ac.sums_ok)` 分支，V4 断言 `unavailable sums_ok=false` 变成正常核验率，测试失败。还原。 |
| **W4** | `ANCHOR_CHECK_BIN` 未配置时返回 `{defects:0, verificationRate:0}` 而非 unavailable | V5 | 被杀。`assembleGenerateDeps` 中 `!anchorCheckBin` 改为返回 `{total:0, ...}` 而非抛错，V5 断言 `unavailable` 变成 `0`，测试失败。还原。 |
| **W5** | 不传 `--repo-root` | V7 | 被杀。`assembleGenerateDeps` 中移除 `--repo-root` 参数，V7 断言 `--repo-root` 在 argv 中失败。还原。 |
| **W6** | 落盘目录改成自己拼的字符串（不复用 `export.ts`） | V8 | 被杀。`writeAnchorCheckJson` 中 `slugify(opts.question)` 改为 `opts.question!.replace(/ /g, "_")`，V8 判别性断言 `slugify` 是 `export function` 且目录名不匹配，测试失败。还原。 |

变异矩阵全部还原后 `git status --porcelain` 为空。

## 删除说明

| 删除 | 必要性 |
|------|--------|
| `GenerateConfig.anchorCheckRoute` 字段 | spec §2：不得再经 route 派发；不留无消费者的 route 字段 |
| `AnchorCheckNotWiredError` 类 | 不再需要：`ANCHOR_CHECK_BIN` 未配置时 `spawnAnchorCheck` 抛普通 Error 点名 `ANCHOR_CHECK_BIN` |
| `g4c-generate-wiring.test.ts` U6 零功率源码匹配 | spec §4.2：零功率检查比没有更坏；替换为判别性 `spawnExport` 测试 |
| `g4c-generate-wiring.test.ts` U7 原 `AnchorCheckNotWiredError` 测试 | 类已删除；替换为等价行为测试（`ANCHOR_CHECK_BIN` 未配置 ⇒ unavailable） |

## 关键表达式

- **defects**：`defects = total - current_verified_hit`（等价于 spec 定义，`runGenerate` 不显式计算 `defects`，但 `AnchorCheckResult` 包含 `current_verified_hit` 和 `total`，调用方可自行推导）
- **核验率**：`verificationRate = (current_verified_hit / total) * 100`（百分数，`renderReportHead` 输出为纯数字，如 `100`、`10`、`0`）
- **核验率单位**：百分数（0–100），无 `%` 符号，与既有用例 `100`/`95`/`0` 一致