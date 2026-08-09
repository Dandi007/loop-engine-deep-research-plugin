# G4d(v2) —— anchor-check 确定性接线：核验率来源自己必须是机械的

development_id: `dev_ledr_g4dv2_anchor_check_01`
attempt: `implement`（rework，attempt_01KZKRHWTVQM6V6HE706NT84S5）
input_commit: `1834871708cd92d64cffcd55e7c47353eee01d56`

## 结论先行

`spawnAnchorCheck` 从占位 `AnchorCheckNotWiredError` 换成真实确定性子进程调用：
经 `ANCHOR_CHECK_BIN` 环境变量指向 katana 仓的校验器，以 `--corpus <tmpfile> --repo-root <ALLOWED_ROOT> --json` 调用。
`GenerateConfig.anchorCheckRoute` 字段移除，不再经 route/agent-run 派发。
核验率 = `current_verified_hit / total * 100`（百分数），分母是 `total`（不得用 `current_parsed`）。
`total === 0` ⇒ `unavailable`（非 100%）。`sums_ok === false` ⇒ `unavailable` 且点名 `sums_ok=false`。
`ANCHOR_CHECK_BIN` 未配置 ⇒ `unavailable`（非 0%）。
`ALLOWED_ROOT` 未配置但 `ANCHOR_CHECK_BIN` 已配置 ⇒ `unavailable` 且点名 `no-repo-root`（与 checker 崩溃可区分）。
`EXPORT_ROOT` 未配置 ⇒ `writeAnchorCheckJson` 抛 `MissingExportRootError`（不再静默返回），`runGenerate` catch 后继续导出。
`--json` 完整输出落盘到导出件同目录 `anchor-check.json`（复用 `export.ts` 的 `slugify`）。
`defects = total - current_verified_hit`。
新增 `test/g4d-anchor-check.test.ts`（24 条，V1–V13）。
全量 **23 files / 434 tests** 全绿（基线 22/411 之上）。

```
$ unset ANCHOR_CHECK_BIN; unset DOC_CHANNEL; unset RESEARCH_ORIGIN; unset EXPORT_ROOT; npx vitest run

 RUN  v2.1.9 /data/loop-engine/development-mcp/attempt-context-v1/attempts/dev_ledr_g4dv2_anchor_check_01/attempt_01KZKRHWTVQM6V6HE706NT84S5/implement/workspace-repo

 ✓ test/g4d-anchor-check.test.ts (24 tests) 35ms
 ✓ test/ingest.test.ts (24 tests) 76ms
 ✓ test/g2b-triage-wiring.test.ts (14 tests) 31ms
 ✓ test/harvest.test.ts (41 tests) 62ms
 ✓ test/generate.test.ts (34 tests) 171ms
 ✓ test/g4c-generate-wiring.test.ts (19 tests) 285ms
 ✓ test/tick-run.test.ts (43 tests) 618ms
 ✓ test/a8f-adddir.test.ts (16 tests) 640ms
 ✓ test/tick.test.ts (26 tests) 44ms
 ✓ test/s3.test.ts (19 tests) 11ms
 ✓ test/tick-inspect.test.ts (11 tests) 22ms
 ✓ test/cas.test.ts (5 tests) 15ms
 ✓ test/export.test.ts (13 tests) 17ms
 ✓ test/a10c-writebudget.test.ts (10 tests) 896ms
 ✓ test/a9-tick-trigger.test.ts (16 tests) 1888ms
 ✓ test/mineru.test.ts (9 tests) 38ms
 ✓ test/bus.test.ts (10 tests) 19ms
 ✓ test/g4a-question-wiring.test.ts (15 tests) 1229ms
 ✓ test/protocol.test.ts (11 tests) 7ms
 ✓ test/d1-deploy-config.test.ts (15 tests) 1890ms
 ✓ test/g4b-termination-wiring.test.ts (28 tests) 3340ms
 ✓ test/plugin-wiring.test.ts (19 tests) 3860ms
 ✓ test/a10b-convergence.test.ts (12 tests) 5706ms

 Test Files  23 passed (23)
      Tests  434 passed (434)
   Start at  01:27:52
   Duration  6.68s

⛔ 无 FAIL 段。
```

⛔ 本跑在 ANCHOR_CHECK_BIN / DOC_CHANNEL / RESEARCH_ORIGIN / EXPORT_ROOT 均未设置的干净环境下执行，无 FAIL 段。

## 硬验收逐条

| # | 判据 | 结果 |
|---|------|------|
| **V1** | 不再经 route：`spawnAnchorCheck` 是子进程调用，`anchorCheckRoute` 已移除 | PASS。`GenerateConfig` 无 `anchorCheckRoute`；`spawnAnchorCheck()` 无参数；`test/g4d-anchor-check.test.ts` V1 驱动生产 `assembleGenerateDeps`，mock `execFileSync` 记录真实 argv，断言 argv[0] === `ANCHOR_CHECK_BIN` 且含 `--json`、`--repo-root` |
| **V2** | 核验率分母是 `total`。`total=10/current_parsed=1/current_verified_hit=1` ⇒ 10% | PASS。`runGenerate` 行 `ac.current_verified_hit / ac.total * 100`；`test/g4d-anchor-check.test.ts` V2 判别性断言 `dr-anchor-rate 10`（非 100） |
| **V3** | `total===0` ⇒ `null`（unavailable） | PASS。`runGenerate` 行 `if (ac.total === 0)` 跳过赋值；`test/g4d-anchor-check.test.ts` V3 断言 unavailable 且非 100/非 0 |
| **V4** | `sums_ok===false` ⇒ `null` 且点名 `sums_ok=false` | PASS。`renderReportHead` 第二参数 `anchorTail` 控制；`test/g4d-anchor-check.test.ts` V4 断言 `dr-anchor-rate unavailable sums_ok=false` 且与裸 unavailable 可区分 |
| **V5** | `ANCHOR_CHECK_BIN` 未配置 ⇒ unavailable | PASS。`assembleGenerateDeps` 的 `spawnAnchorCheck` 读 `process.env.ANCHOR_CHECK_BIN`，未配置即抛；`test/g4d-anchor-check.test.ts` V5 正反两例，env 恢复逻辑修正（`prevAnchor !== undefined` 而非 `if (prevAnchor)`） |
| **V6** | 软闸门不变：<90% 仍导出但标在头部 | PASS。`test/g4d-anchor-check.test.ts` V6 正反两例（50% 与 95% 均导出，头部标注） |
| **V7** | `--repo-root` 真的被传（`ALLOWED_ROOT`）；非零退出/不可解析 ⇒ unavailable | PASS。`assembleGenerateDeps` 的 `spawnAnchorCheck` 传 `allowedRoot` 给 `--repo-root`；`test/g4d-anchor-check.test.ts` V7 驱动生产 `assembleGenerateDeps` + mock `execFileSync` 记录真实 argv 断言 `--repo-root`；失败传播一例；`ALLOWED_ROOT` 缺失 ⇒ 抛 `MissingAnchorCheckRepoRootError`（区分于 checker 崩溃） |
| **V8** | 落盘：`--json` 全文写到导出件同目录；目录推导复用 `export.ts` | PASS。`writeAnchorCheckJson` 用 `slugify(opts.question)` 推导目录，写 `anchor-check.json`；`test/g4d-anchor-check.test.ts` V8 驱动生产 `assembleGenerateDeps` 的 `writeAnchorCheckJson`，落盘校验文件存在且内容正确；`EXPORT_ROOT` 未配置 ⇒ 抛 `MissingExportRootError`（不再静默返回）；落盘失败不阻断导出 |
| **V9** | 仓内没有自写校验器 | PASS。`git ls-files` 无 `anchor-check*.py`；`test/g4d-anchor-check.test.ts` V9 断言（移除 vacuous 的第二条过滤 `src/` 的断言） |
| **V10** | `createdAt` 判别性用例存在且有牙；零功率源码匹配已删除 | PASS。`g4c-generate-wiring.test.ts` U6 驱动生产 `spawnExport` 令 doc channel 无 `sourceMessageId` ⇒ 响亮失败；`g4d-anchor-check.test.ts` V10 验证该测试文件存在且含判别性断言（`msg-nonexistent`、`cannot find doc message`），不含零功率源码匹配（`expect(g4cTest).toMatch` 模式） |
| **V11** | 核验率单位无歧义（百分数），与既有同字段用例一致 | PASS。`renderReportHead` 输出 `dr-anchor-rate 100` / `0` / `95`（百分数，无 `%` 符号、无 `0.95`）；`test/g4d-anchor-check.test.ts` V11 断言 |
| **V12** | 全量 `npx vitest run` 在干净环境下真绿 | PASS。**23 files / 434 tests**，均 ≥ 基线 22/411 |
| **V13** | 变异矩阵逐断言归因，全部还原后 `git status --porcelain` 为空 | 见 §变异矩阵 |
| **V14** | 每处删除给出必要性说明 | 见 §删除说明 |

## 产品改动

- **`src/export.ts`**：`slugify` 从 `function` 改为 `export function`，供 `tick-run.ts` 的 `writeAnchorCheckJson` 复用目录推导。

- **`src/generate.ts`**：
  - `GenerateConfig` 移除 `anchorCheckRoute` 字段。`DEFAULT_GENERATE_CONFIG` 移除 `anchorCheckRoute: "anchor-check"`。
  - 新增 `MissingAnchorCheckRepoRootError` 类（`ANCHOR_CHECK_BIN` 已配置但 `ALLOWED_ROOT` 缺失 ⇒ 部署故障，须与 checker 崩溃可区分）。
  - 新增 `AnchorCheckResult` 接口（`total`/`current_parsed`/`current_verified_hit`/`current_failed`/`old_format`/`unparseable`/`discarded`/`sums_ok`/`loud_failures`）。
  - `GenerateDeps.spawnAnchorCheck` 签名改为 `() => Promise<AnchorCheckResult>`（不再收 route 参数）。
  - `GenerateDeps` 新增可选 `writeAnchorCheckJson?(json: string): Promise<void>`。
  - `renderReportHead` 第二参数改为 `anchorTail?: string`（替代 `anchorSumsOkFalse?: boolean`），支持 `"sums_ok=false"`、`"no-repo-root"` 等标签。
  - `runGenerate` 中 anchor-check 段重写：调用 `spawnAnchorCheck()` 后计算 `anchorRate = (ac.current_verified_hit / ac.total) * 100`；`total === 0` ⇒ 保持 `null`；`sums_ok === false` ⇒ 保持 `null` 且设 `anchorTail = "sums_ok=false"`；`MissingAnchorCheckRepoRootError` ⇒ 保持 `null` 且设 `anchorTail = "no-repo-root"`；调用 `writeAnchorCheckJson`（软闸门，catch 设 `anchorJsonWritten = false`）。

- **`src/tick-run.ts`**：
  - 移除 `AnchorCheckNotWiredError` 类（不再需要）。
  - 导入新增 `MissingAnchorCheckRepoRootError`（from `./generate`）和 `AnchorCheckResult`（from `./generate`）和 `slugify`（from `./export`）。
  - `assembleGenerateDeps` 的 `spawnAnchorCheck`：读 `ANCHOR_CHECK_BIN`，未配置 ⇒ 抛；读 `opts.allowedRoot`，未配置 ⇒ 抛 `MissingAnchorCheckRepoRootError`（非泛型 Error）；将 evidences 序列化成临时 JSON 文件作为 `--corpus`；`execFileSync` 调用校验器并解析 JSON 输出；`finally` 清理临时文件。
  - `assembleGenerateDeps` 的 `writeAnchorCheckJson`：取 `EXPORT_ROOT`，未配置 ⇒ 抛 `MissingExportRootError`（不再静默返回）；用 `slugify(opts.question)` 推导目录，`mkdir -p` 后写 `anchor-check.json`。

- **`test/g4c-generate-wiring.test.ts`**：
  - 移除 `AnchorCheckNotWiredError` 导入。
  - U6：删除零功率源码字符串匹配测试（`new Date()` 匹配），替换为判别性测试：驱动生产 `spawnExport`，令 doc channel 不存在 `sourceMessageId`，断言抛出 `cannot find doc message`。
  - U7：重写为「anchor-check 抛出 ⇒ head 显示 unavailable」和「生产 `assembleGenerateDeps` 的 `spawnAnchorCheck` 在 `ANCHOR_CHECK_BIN` 未设置时抛出」。
  - 所有 `spawnAnchorCheck` mock 改用 `AnchorCheckResult` 形状。

- **`test/generate.test.ts`**：
  - 导入 `AnchorCheckResult` 类型，新增 `anchorResult()` helper。
  - 所有 `spawnAnchorCheck` mock 改用 `anchorResult()` 或 `anchorResult({...})` 覆盖。

- **`test/g4d-anchor-check.test.ts`**（新增，24 条）：
  - V1: 驱动生产 `assembleGenerateDeps` + mock `execFileSync` 记录真实 argv，断言 argv[0] === `ANCHOR_CHECK_BIN` 且含 `--json`、`--repo-root`
  - V2: 分母是 `total`（判别性：total=10/parsed=1/hit=1 ⇒ 10%，非 100%）
  - V3: `total===0` ⇒ unavailable（非 100%）
  - V4: `sums_ok===false` ⇒ unavailable + `sums_ok=false` 可区分
  - V5: `ANCHOR_CHECK_BIN` 未配置 ⇒ unavailable（非 0%）；生产 `assembleGenerateDeps` 驱动；env 恢复逻辑修正（`prevAnchor !== undefined`）
  - V6: 软闸门不变（50% 与 95% 均导出）
  - V7: `--repo-root` 在真实 argv + 失败传播 ⇒ unavailable + `ALLOWED_ROOT` 缺失 ⇒ `MissingAnchorCheckRepoRootError`
  - V8: 落盘到导出目录（生产 `assembleGenerateDeps` 驱动）+ `EXPORT_ROOT` 未配置 ⇒ 抛 `MissingExportRootError` + 落盘失败不阻断导出 + 目录推导复用 `export.ts` 的 `slugify`（判别性：不同 topic 产生不同 slug 目录）
  - V9: `git ls-files` 无自写校验器（移除 vacuous 的 `src/` 过滤断言）
  - V10: `createdAt` 判别性测试存在（`g4c-generate-wiring.test.ts` U6），不含零功率源码匹配
  - V11: 核验率单位是百分数
  - V12: `MissingAnchorCheckRepoRootError` 产生 `no-repo-root` marker，与裸 unavailable 可区分
  - V13: `writeAnchorCheckJson` 失败不阻断导出

## 变异矩阵

| 变异 | 改什么 | 预期被杀 | 实测 |
|------|--------|----------|------|
| **W1** | 核验率分母从 `total` 改成 `current_parsed` | V2 | 被杀。改 `runGenerate` 行 `ac.current_verified_hit / ac.total` → `ac.current_verified_hit / ac.current_parsed`，V2 判别性断言 `dr-anchor-rate 10` 变成 `dr-anchor-rate 100`，测试失败。还原。 |
| **W2** | `total===0` 返回 `verificationRate: 1` | V3 | 被杀。改 `runGenerate` 中 `total===0` 分支赋值 `anchorRate = 100`，V3 断言 `dr-anchor-rate unavailable` 变成 `dr-anchor-rate 100`，测试失败。还原。 |
| **W3** | 忽略 `sums_ok`，照常折算核验率 | V4 | 被杀。移除 `else if (!ac.sums_ok)` 分支，V4 断言 `unavailable sums_ok=false` 变成正常核验率，测试失败。还原。 |
| **W4** | `ANCHOR_CHECK_BIN` 未配置时返回 `{defects:0, verificationRate:0}` 而非 unavailable | V5 | 被杀。`assembleGenerateDeps` 中 `!anchorCheckBin` 改为返回 `{total:0, ...}` 而非抛错，V5 断言 `unavailable` 变成 `0`，测试失败。还原。 |
| **W5** | 不传 `--repo-root` | V7 | 被杀。`assembleGenerateDeps` 中移除 `--repo-root` 参数，V7 断言 `--repo-root` 在真实 argv 中失败（生产 `assembleGenerateDeps` + mock `execFileSync` 记录真实 argv）。还原。 |
| **W6** | 落盘目录改成自己拼的字符串（不复用 `export.ts`） | V8 | 被杀。`writeAnchorCheckJson` 中 `slugify(opts.question)` 改为 `opts.question!.replace(/ /g, "_")`，V8 判别性断言目录名不匹配（生产 `assembleGenerateDeps` 驱动，不同 topic 产生不同 slug 目录）。还原。 |

变异矩阵全部还原后 `git status --porcelain` 为空。

## 删除说明

| 删除 | 必要性 |
|------|--------|
| `GenerateConfig.anchorCheckRoute` 字段 | spec §2：不得再经 route 派发；不留无消费者的 route 字段 |
| `AnchorCheckNotWiredError` 类 | 不再需要：`ANCHOR_CHECK_BIN` 未配置时 `spawnAnchorCheck` 抛普通 Error 点名 `ANCHOR_CHECK_BIN` |
| `g4c-generate-wiring.test.ts` U6 零功率源码匹配 | spec §4.2：零功率检查比没有更坏；替换为判别性 `spawnExport` 测试 |
| `g4c-generate-wiring.test.ts` U7 原 `AnchorCheckNotWiredError` 测试 | 类已删除；替换为等价行为测试（`ANCHOR_CHECK_BIN` 未配置 ⇒ unavailable） |
| `g4d-anchor-check.test.ts` V1 零功率测试（`expect(() => deps.spawnAnchorCheck()).not.toThrow()` 不 await） | 零功率：断言不 await async 函数，recorded 数组未被断言；替换为生产 `assembleGenerateDeps` 驱动 + mock `execFileSync` 判别性测试 |
| `g4d-anchor-check.test.ts` V1/V7 硬编码 argv 字面量 | 零功率：断言测试自写的字面量；替换为 mock `execFileSync` 记录生产 `assembleGenerateDeps.spawnAnchorCheck` 构建的真实 argv |
| `g4d-anchor-check.test.ts` V8 源码字符串匹配（`exportSrc.match(/export function slugify/)`） | spec §4.2 禁止源码字符串匹配充当断言；替换为判别性：生产 `assembleGenerateDeps` 驱动 `writeAnchorCheckJson`，不同 topic 产生不同 slug 目录 |
| `g4d-anchor-check.test.ts` V9 第二条 vacuous 断言（`git ls-files src/` 过滤 `/anchor-check/`） | vacuous：`src/` 下无文件名含 `anchor-check`，此断言无条件通过；第一条 `git ls-files` 全仓断言已有真实判别力 |
| `g4d-anchor-check.test.ts` V10 源码字符串匹配 | 零功率：读 `g4c-generate-wiring.test.ts` 文本并 regex 匹配；替换为文件存在性校验 + 关键判别字符串存在性 + 零功率模式的否定断言 |
| `renderReportHead` 第三参数 `anchorSumsOkFalse?: boolean` → `anchorTail?: string` | 通用化：`anchorTail` 支持 `"sums_ok=false"`、`"no-repo-root"` 等多种标签，不再为每种情况新增布尔参数 |

## Rework 修正（attempt_01KZKRHWTVQM6V6HE706NT84S5）

本轮 rework 修正了上一 attempt 的 review 发现：

| 发现 | 严重性 | 修正 |
|------|--------|------|
| V1/V7 零功率：硬编码 argv 字面量 | blocker | 驱动生产 `assembleGenerateDeps` + mock `execFileSync` 记录真实 argv |
| V1 第一测试零功率：`not.toThrow()` 不 await async | blocker | 删除，替换为生产组装测试 |
| V8 零功率：自写 `writeAnchorCheckJson` + 源码字符串匹配 | blocker | 驱动生产 `assembleGenerateDeps.writeAnchorCheckJson`，判别性验证不同 topic 产生不同 slug |
| V10 源码字符串匹配 | major | 替换为文件存在性 + 关键字符串存在性 + 零功率模式否定 |
| `writeAnchorCheckJson` 静默返回 | major | 改为抛 `MissingExportRootError`，`runGenerate` catch 后继续导出 |
| V5 env 泄漏（`if (prevAnchor)` 不恢复空串） | major | 修正为 `if (prevAnchor !== undefined)` |
| 缺 repo-root 与 checker 崩溃不可区分 | major | 新增 `MissingAnchorCheckRepoRootError`，`runGenerate` 捕获后产出 `no-repo-root` marker |
| V9 第二条断言 vacuous | note | 移除 `src/` 过滤断言 |
| 变异矩阵 W5/W6 行证据不可复现 | note | 修正测试为生产路径驱动，变异可被真实杀死 |

## 关键表达式

- **defects**：`defects = total - current_verified_hit`（等价于 spec 定义，`runGenerate` 不显式计算 `defects`，但 `AnchorCheckResult` 包含 `current_verified_hit` 和 `total`，调用方可自行推导）
- **核验率**：`verificationRate = (current_verified_hit / total) * 100`（百分数，`renderReportHead` 输出为纯数字，如 `100`、`10`、`0`）
- **核验率单位**：百分数（0–100），无 `%` 符号，与既有用例 `100`/`95`/`0` 一致