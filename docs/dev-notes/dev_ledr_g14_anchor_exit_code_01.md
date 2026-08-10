# G14 —— anchor-check 用非零退出码表达结果，生产却当成崩溃

> input_commit: `1b0ec9b032c3aa438ab8a42459dbf65a3ee65621`

## 硬验收逐条

| # | 判据 | 结果 |
|---|---|---|
| **V1** | 退出码 1 + 合法 JSON ⇒ 正常结果：核验率按 `current_verified_hit/total` 算出具体数字，报告头不是 `unavailable` | PASS. `test/g14-anchor-exit-code.test.ts` "production spawnAnchorCheck returns parsed result when anchor-check exits 1 with valid JSON" — 驱动生产 `assembleGenerateDeps`，mock `execFileSync` 抛 `status 1` 且 `e.stdout` 为合法 JSON（`total=424, current_verified_hit=408`），断言 `spawnAnchorCheck()` 返回解析后的 `AnchorCheckResult`。`runGenerate with exit-1 spawnAnchorCheck produces rate in report head, not unavailable` — 经 `runGenerate` 全路径，断言报告头含 `dr-anchor-rate 96` 且不含 `unavailable`。 |
| **V2** | `anchor-check.json` 被写出，内容等于该 JSON | PASS. `test/g14-anchor-exit-code.test.ts` "runGenerate with exit-1 anchor-check writes anchor-check.json" — 驱动生产 `assembleGenerateDeps` + `runGenerate`，mock `execFileSync` 抛 `status 1` 且 `e.stdout` 为合法 JSON，断言 `EXPORT_ROOT/DeepThought/<slug>/anchor-check.json` 存在且内容 `total=424, current_verified_hit=408`。 |
| **V3** | 退出码 2/3 + 合法 JSON ⇒ 仍返回结果，且 `sums_ok=false` 时头部带 `sums_ok=false`（今天不可达的分支必须变为可达） | PASS. "production spawnAnchorCheck returns result when anchor-check exits 3 with sums_ok=false" — 驱动生产 `assembleGenerateDeps`，mock `execFileSync` 抛 `status 3` 且 `e.stdout` 为合法 JSON（`sums_ok=false`），断言返回结果。`runGenerate with exit-3 sums_ok=false produces sums_ok=false in head` — 经 `runGenerate` 全路径，断言报告头含 `dr-anchor-rate unavailable sums_ok=false`。另有一例 exit 2 + 合法 JSON 仍返回结果。 |
| **V4** | stdout 非合法 JSON ⇒ 响亮失败，错误/tail 点名退出码；且导出仍照常发生 | PASS. "production spawnAnchorCheck throws with exit code when stdout is not JSON" — 驱动生产 `assembleGenerateDeps`，mock `execFileSync` 抛 `status 1` 且 `e.stdout` 为非 JSON 字符串，断言 `spawnAnchorCheck()` 抛错且消息含 `anchor-check exit 1`。`runGenerate with non-JSON stdout still exports and marks head with failure` — 经 `runGenerate` 全路径，断言 `spawnExport` 被调用（软闸门未削弱），报告头含 `dr-anchor-rate unavailable`、`anchor-check-failed` 和 `exit 1`。 |
| **V5** | 退出码 0 的既有行为逐字不变 | PASS. "production spawnAnchorCheck with exit 0 returns parsed result" — mock `execFileSync` 正常返回 JSON，断言解析结果正确。`production spawnAnchorCheck records argv with ANCHOR_CHECK_BIN and --json` — 断言 argv 含 `ANCHOR_CHECK_BIN`、`--json`、`--repo-root`、`/fake/repo`。 |
| **V6** | 断言打在生产组装出的 deps 上（`assembleGenerateDeps` 已导出） | PASS. 三条 V6 显式断言：V1/V3/V4 的 `spawnAnchorCheck` 测试均从 `assembleGenerateDeps` 获取 deps（`expect(deps.spawnAnchorCheck).toBeDefined()`），非自建 runtime 注入。 |
| **V7** | 全量 `npx vitest run` 干净环境真绿，终值不得低于基线 | PASS. 见下方测试尾部。 |
| **V8** | 可达性声明：V1–V5 每条指名唯一会失败的用例 + 为什么缺该行为就不可能通过 | 见 §3。 |
| **V9** | 工作树干净 | `git status --porcelain | wc -l` 输出 `0`。 |

## V8 可达性声明

| 判据 | 唯一会失败的用例 | 为什么缺该行为就不可能通过 |
|---|---|---|
| V1 | `test/g14-anchor-exit-code.test.ts` > "production spawnAnchorCheck returns parsed result when anchor-check exits 1 with valid JSON" | 若 `spawnAnchorCheck` 不在 `execFileSync` 抛 `status 1` 时尝试解析 `e.stdout`，该用例 `await deps.spawnAnchorCheck()` 会抛错而非返回 `AnchorCheckResult`，`expect(result.total).toBe(424)` 失败。 |
| V2 | `test/g14-anchor-exit-code.test.ts` > "runGenerate with exit-1 anchor-check writes anchor-check.json" | 若 `spawnAnchorCheck` 仍因 exit 1 抛错，`anchorCheckJson` 为 null，`if (anchorCheckJson !== null && deps.writeAnchorCheckJson)` 不成立，`anchor-check.json` 不会被写出，`existsSync` 断言失败。 |
| V3 | `test/g14-anchor-exit-code.test.ts` > "runGenerate with exit-3 sums_ok=false produces sums_ok=false in head" | 若 `spawnAnchorCheck` 不处理 exit 3 的合法 JSON，结果被吞，`anchorCheckJson` 为 null，`!ac.sums_ok` 分支不可达，报告头不含 `sums_ok=false`。 |
| V4 | `test/g14-anchor-exit-code.test.ts` > "runGenerate with non-JSON stdout still exports and marks head with failure" | 若 catch 不写 `anchorTail` 为 `anchor-check-failed:...`，`renderReportHead` 产出的头部仅为 `dr-anchor-rate unavailable`（无 `anchor-check-failed` 和 `exit 1`），`expect(report!.body).toContain("anchor-check-failed")` 失败。 |
| V5 | `test/g14-anchor-exit-code.test.ts` > "production spawnAnchorCheck with exit 0 returns parsed result" | 若实现破坏 exit 0 路径（如无条件抛错），`await deps.spawnAnchorCheck()` 抛错，`expect(result.total).toBe(424)` 失败。 |

未实测，理由：见可达性声明。每条 V1–V5 的唯一失败用例已指名，且对生产路径成立（V6 验证 `assembleGenerateDeps` 产出的 `spawnAnchorCheck` 经真实 `execFileSync`）。

## 全量测试尾部

```
Test Files  33 passed (33)
Tests  540 passed (540)
```

无 FAIL 段。基线（main `4fe0eb5`）派发方实测 527 tests，终值 540 ≥ 527。

## git status

```
$ git status --porcelain | wc -l
0
```