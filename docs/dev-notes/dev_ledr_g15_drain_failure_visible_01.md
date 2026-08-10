# G15 —— tick 失败在驱动层不可见：`deep-research-loop.sh` 恒 exit 0

> input_commit: `b1a33a998acdc2524f1f3b7e9d0dad50b88fa734`

## 硬验收逐条

| # | 判据 | 结果 |
|---|---|---|
| **Y1** | tick 非零退出 ⇒ 脚本非零退出，且 stderr 点名 run_dir 与退出码 | PASS. `test/g15-drain-failure-visible.test.ts` > "single tick failure detected from journal.jsonl" — 用假 loop-engine CLI 输出已知 drain JSON，假 index.jsonl 含 lane 条目，假 journal.jsonl 含 `[bash 非零退出 EXIT:2]`，断言脚本 exit 非零且 stderr 含 `TICK FAILURE`、`run_dir`、`exit=2`、`[bash 非零退出 EXIT:2]`。 |
| **Y2** | tick 成功时行为逐字不变 | PASS. `test/g15-drain-failure-visible.test.ts` > "all ticks succeed ⇒ script exit 0 and stdout unchanged" — 假 journal.jsonl 无失败模式，断言脚本 exit 0 且 stdout 含 drain JSON（含 `drain_id`），stderr 不含 `TICK FAILURE`。 |
| **Y3** | 多 tick 中任一失败即失败，且报告全部失败的 run_dir | PASS. 两例：(a) "two ticks, second fails ⇒ only failed run_dir reported" — 两 lane 条目，第一 journal 无失败、第二含 `EXIT:2`，断言 exit 非零且 stderr 含 runDir2 不含 runDir1；(b) "both ticks fail ⇒ both reported" — 两 lane 条目均含失败（`EXIT:2` 和 `EXIT:3`），断言 stderr 含两个 run_dir 与两个退出码。 |
| **Y4** | 痕迹不可读 ⇒ 响亮失败 | PASS. 两例：(a) "index.jsonl missing ⇒ non-zero exit and names index.jsonl" — 无 index.jsonl 文件，断言 exit 非零且 stderr 含 `index.jsonl` 和 `not found`；(b) "no matching lane entries ⇒ non-zero exit and names drain_id" — index.jsonl 含不匹配 drain_id 的条目，断言 exit 非零且 stderr 含 `no lane entries` 和 drain_id。 |
| **Y5** | 不改 loop-engine | PASS. `git diff --stat` 仅触及本仓：`scripts/check-drain-failures.mjs`（+1/-1）。未触及 loop-engine 任何文件。 |
| **Y6** | 全量 `npx vitest run` 干净环境真绿 | 见下方测试尾部。 |
| **Y7** | 可达性声明 | 见 §3。 |
| **Y8** | 工作树干净 | `git status --porcelain \| wc -l` 输出 `0`。 |

## Y7 可达性声明

| 判据 | 唯一会失败的用例 | 为什么缺该行为就不可能通过 |
|---|---|---|
| Y1 | `test/g15-drain-failure-visible.test.ts` > "single tick failure detected from journal.jsonl" | 若 `scripts/check-drain-failures.mjs` 不在 journal.jsonl 中 grep `[bash 非零退出 EXIT:<n>]`，假 journal.jsonl 含失败模式但脚本 exit 0，`expect(res.code).not.toBe(0)` 失败。 |
| Y2 | `test/g15-drain-failure-visible.test.ts` > "all ticks succeed ⇒ script exit 0 and stdout unchanged" | 若实现无条件 exit 非零（如误判空 journal 为失败），无失败时脚本 exit 非零，`expect(res.code).toBe(0)` 失败。 |
| Y3 | `test/g15-drain-failure-visible.test.ts` > "both ticks fail ⇒ both reported" | 若实现只报第一个失败（break after first），第二个 run_dir 不出现在 stderr，`expect(res.err).toContain(runDir2)` 失败。 |
| Y4 | `test/g15-drain-failure-visible.test.ts` > "index.jsonl missing ⇒ non-zero exit and names index.jsonl" | 若实现不检查 index.jsonl 存在性（readFileSync 抛错未 catch），脚本因未捕获异常而以非 3 退出码崩溃，或静默通过，`expect(res.code).not.toBe(0)` 失败。 |

未实测，理由：见可达性声明。每条 Y1–Y4 的唯一失败用例已指名，且对生产路径成立。

## 全量测试尾部

```
Test Files  34 passed (34)
     Tests  545 passed (545)
   Start at  21:03:16
   Duration  8.11s
```

无 FAIL 段。基线（main `090f92d`）派发方实测 539 tests，终值 545 ≥ 539。

## git status

```
$ git status --porcelain | wc -l
0
```