# C3 —— 哨兵静默失效必须响亮终态：drain 死亡后驱动读 registry 产出 sentinel_lost

> input_commit: `63b046d0425ac8b3b691a3f7cb18c69144b42f81`

## 背景（真机实据）

C5 冷启动 run `b34f64d729b4` 在推进 8 个 tick 后，drain 进程于 tick8 dispatch 后死亡；
此后约 6 小时该 run 静默停在 `drain.json status="running"`、`outstanding=1`，无 run.end、
无 sentinel_lost 终态、无告警，而 board 上仍有未收割 in_flight/open 卡 —— 违反 C3 不变量
（存在未收割卡时 loop 不得静默退出）。哨兵记了（heartbeat/outstanding），但「响亮」缺位。

## 修复落点

- `scripts/check-drain-failures.mjs`：新增哨兵终态判定（判别核心）。
- `bin/deep-research-loop.sh`：drain 进程**任何**退出/死亡路径后都执行哨兵判定
  （含 SIGKILL 无摘要路径），不再「drain 非零即裸退」跳过 registry 读取。

## 判定规则（判别性规格，不可放宽）

- drain 未写 `run.end`，或 `drain.json.status` 非终态（仍 `running`）且 `outstanding > 0`
  ⇒ 响亮终态：非零退出 + `sentinel_lost` + `outstanding=<n>` + drain_id + 未收割计数/seq。
- drain 正常写 `run.end` 且 `outstanding == 0` ⇒ 维持 exit 0。
- 补充信号：`loop-events.jsonl` 轮次未闭合（round_start > round_end，死于轮中）。
- 兜底定位：drain 被杀死无摘要时，按 `RUNTIME_FLEET`（本驱动自己的 fleet）在 index.jsonl
  找 drain 自身 run.start（其 fleet 字段 == RUNTIME_FLEET，tick 子 run 的 fleet 指向
  workflow 而非 fleet.yaml，天然区分）且无 run.end —— 精确命中本 drain，不误判并发 drain。
- 机器可读稳定 token：`sentinel_lost` 与 `outstanding=<n>`（巡检/看门狗直接抓取）。

## 硬验收逐条

| # | 判据 | 结果 |
|---|---|---|
| **C3-1a** | drain.json running+outstanding>0 且 drain 自身 run.start 无 run.end ⇒ 非零退出 + sentinel_lost + outstanding 点名 | PASS. `test/c3-sentinel-loud.test.ts` > "drain.json running+outstanding>0 且 drain 自身 run.start 无 run.end" — 假 CLI 输出摘要并 exit 0，构造死亡 registry（drain.json running+outstanding=1 + index.jsonl 的 drain run.start 无 run.end），断言脚本 exit 3 且 stderr 含 `sentinel_lost`、`outstanding=1`、drain_id。修复前该用例 exit 0（红）。 |
| **C3-1b** | 判别独立信号：仅 index.jsonl 的 drain run.start 无 run.end（无 drain.json）也判定 sentinel_lost | PASS. 同文件 > "仅 index.jsonl 的 drain 自身 run.start 无 run.end" — 不建 drain.json，仅 index.jsonl 的 drain run.start 无 run.end，断言 exit 非零 + `sentinel_lost` + `outstanding=1`。修复前 exit 0（红）。 |
| **C3-1c** | loop-events.jsonl 轮次未闭合（死于轮中）也是 sentinel_lost 信号 | PASS. 同文件 > "loop-events.jsonl 轮次未闭合" — drain.json 终态 done + outstanding 0 但 loop-events 只有 round_start 无 round_end，断言 exit 非零 + `sentinel_lost`。修复前 exit 0（红）。 |
| **C3-2a** | 反向断言：正常 drain（run.end + outstanding==0）⇒ exit 0，无 sentinel_lost（防误报） | PASS. 同文件 > "drain.json 终态 + run.end 配对完整 + outstanding 0" — 断言 exit 0 且 stderr 不含 `sentinel_lost`。修复前后均绿（反向护栏）。 |
| **C3-2b** | drain.json 缺失 + drain run.start 有 run.end ⇒ exit 0（无 drain.json 不误报） | PASS. 同文件 > "drain.json 缺失 + drain 自身 run.start 有 run.end" — 断言 exit 0 且无 `sentinel_lost`。 |
| **C3-3** | 真实驱动：SIGKILL 掉 drain 子进程（死亡无摘要路径）⇒ 驱动读 registry 响亮 sentinel_lost | PASS. 同文件 > "真实驱动 drain 子进程并 SIGKILL" — spawn 生产脚本，假 CLI 登记 registry 后睡死，测试 SIGKILL 该子进程（drain 无摘要），驱动按 RUNTIME_FLEET 定位 registry，断言 exit 非零 + `sentinel_lost` + `outstanding=1`。修复前该用例 exit 137 但无 sentinel_lost（红）。 |
| **回归** | 既有 840 测试与 smoke:cas 不回退 | PASS. 见下方全量测试尾部。 |
| **Y5** | 不改 loop-engine 基座本体 | PASS. `git diff --stat` 仅触及本仓 `bin/deep-research-loop.sh` 与 `scripts/check-drain-failures.mjs`（+ 新测试/文档）。未触及 loop-engine 任何文件。 |
| **Y8** | 工作树干净 | 见下方 git status。 |

## 可达性声明（判别性证明）

| 判据 | 唯一会失败的用例 | 为什么缺该行为就不可能通过 |
|---|---|---|
| C3-1a | `test/c3-sentinel-loud.test.ts` > "drain.json running+outstanding>0…" | 若驱动不读 registry（原实现静默 exit 0），`expect(res.code).toBe(3)` 与 `expect(res.err).toContain("sentinel_lost")` 失败。实测修复前该用例 exit 0（红）。 |
| C3-1b | 同文件 > "仅 index.jsonl 的 drain 自身 run.start 无 run.end" | 若不按 index.jsonl 的 run.end 配对判定，该用例 exit 0，`expect(res.code).not.toBe(0)` 失败。实测修复前红。 |
| C3-1c | 同文件 > "loop-events.jsonl 轮次未闭合" | 若不读 loop-events.jsonl 轮次配对，该用例 exit 0，`expect(res.code).not.toBe(0)` 失败。实测修复前红。 |
| C3-2a/b | 同文件 > 两条反向用例 | 若把「无 drain.json」或「run.end 已写」误判为 sentinel_lost，exit 非零，`expect(res.code).toBe(0)` 失败 —— 防误报护栏。 |
| C3-3 | 同文件 > "真实驱动 drain 子进程并 SIGKILL" | 若 drain 被杀（无摘要）后不读 registry（空摘要即 exit 0 或裸退 137），stderr 无 `sentinel_lost`，`expect(err).toContain("sentinel_lost")` 失败。实测修复前红。 |

RED→GREEN 实测：`git stash push -- bin/deep-research-loop.sh scripts/check-drain-failures.mjs`
（回到修复前）后 `npx vitest run test/c3-sentinel-loud.test.ts` 结果
`Tests  4 failed | 2 passed (6)`（C3-1a/b/c 与 C3-3 全红，反向 C3-2 全绿）；
`git stash pop` 恢复修复后同命令 `Tests  6 passed (6)` 全绿。

## 全量测试尾部

见 attempt 验收运行 `npm test` 尾部（新增后总用例数 = 840 + 6 = 846）。

## git status

```
$ git status --porcelain | wc -l
0
```
