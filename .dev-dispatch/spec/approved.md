# G15 —— tick 失败在驱动层不可见：`deep-research-loop.sh` 恒 exit 0

> 派发方：`line-deep-research`。仓库：`loop-engine-deep-research-plugin`。基线：main `090f92d`。
> **Phase 6 收尾时受控实验抓到，证据全部实测逐字。**

---

## 0　生产实况（受控实验，可复现）

把 `TICK_CHANNEL` 指向一个**不存在的 channel**（只读不写，必然失败），跑完整 `bin/deep-research-loop.sh`：

**前提已单独坐实** —— 同参数直接调生产入口：

```
$ ./bin/tick-entry.sh --run research:definitely-does-not-exist-probe …
bus GET …/messages?limit=100: 404 {"code":"NOT_FOUND","message":"Channel … not found"}
exit=2
```

**而驱动脚本侧**：

```
loop 脚本            exit 0
round_end            {"round": 1, "ticked": ["tick"], "errors": 0}
pipeline_drained     {"round": 1}
trigger              {"status": "done", "claimed_by": "tick"}
```

## 0.1　⛔ 根因**不是** loop-engine 的缺陷（这条必须先说清，避免把修复派到错的地方）

派发方一路查到底，失败**有留痕**，且引擎行为**符合其成文契约**：

**(a) 失败被完整记录**，在 per-tick 的 lane run 目录（**不是** drain 的 `runs_root`）：

```
/data/loop-engine/runs/2026-08-10T132109-fb74a8a8/journal.jsonl
{"run_id":"tick~1","identity":"tick",
 "result":"[bash 非零退出 EXIT:2]\nbus GET …404 NOT_FOUND…"}

同目录 events.jsonl:  {"status":"EXIT:2"}  {"reason":"drained"}
同目录 STATUS.md:     # loop-engine [drained] · 已完成 1/64 · node_errors: 0
```

**(b) 引擎这样做是有意的、成文的** —— `loop-engine/src/adapters/bash.ts:64-65` 逐字：

> 归因边界(exec-failure spec)：叶子正常跑完——无论 OK 还是**干净非零退出(如测试 fail)**——
> 都给信封，result=stdout 是下游 judge 要读的**正常工作流数据**（"非零退出 + 有信封 = 正常数据投递"）。

`fatal` 只覆盖 `TIMEOUT` / `SIGNAL:` / `ERROR`（进程被杀或起不来）。
⇒ **在该契约下，bash 叶子无法上报「我失败了」；干净非零退出永远是数据。**

**(c) 于是链条内每一环都"正确"**：`reason=drained` ⇒ `fleet.ts` 的
`clean = reason==="halt"||reason==="drained"` 为真 ⇒ trigger 留在 `complete.success_status: done`
（不退回 `failure_status: open`）⇒ `resident.ts` 只统计 `w.tick()` 抛错 ⇒ `errors: 0` ⇒ 脚本 exit 0。

> ### ⛔ 因此：**不要改 loop-engine**
> 把「bash 叶子非零退出」改判成 `node_error` 会**破坏该成文契约**，波及所有依赖
> 「跑测试 → 非零退出 → 交下游 judge 读」的 workflow。**错配在本仓：`tick.md` 用非零退出表达失败，
> 而这不是引擎契约里的失败表达。**

## 0.2　后果

Phase 6 的驱动脚本跑了 **19+ 轮，每轮 `errors:0` / `drained` / `exit 0`**，而底下的 tick 一直在失败。
**最外层的成功信号在结构上不可能报告失败** —— 这是本线多个缺陷得以静默数小时的直接原因。

---

## 1　要做什么：驱动层去痕迹所在的地方读结果

`bin/deep-research-loop.sh` 在 drain 返回**之后**，自行判定本次 drain 里是否有 tick 非零退出，有则**响亮失败**。

**遍历路径（派发方已在真实数据上逐步实测通过）**：

1. drain 的输出/`drain.json` 里拿 **`drain_id`**；
2. 在 `/data/loop-engine/index.jsonl` 里找 `drain_id` 匹配**且带 `lane`** 的 `run.start` 条目 ⇒ 得每个 lane tick 的 **`run_dir`**；
3. 每个 `run_dir/journal.jsonl` 里 grep **`[bash 非零退出 EXIT:<n>]`**；
4. 命中 ⇒ 向 stderr 打印**该 run_dir、退出码、以及 journal 里记录的失败正文摘要**，并**以非零退出**结束脚本。

实测（真实探针数据，逐字）：

```
drain_id = 2026-08-10T132109-ff12b3d5-1786339269400-2035597
→ index.jsonl: run.start | lane tick | tick 1 | run_dir /data/loop-engine/runs/2026-08-10T132109-fb74a8a8
→ journal.jsonl 命中 1 条: [bash 非零退出 EXIT:2]
```

### ⛔ 必须保住 / 不得做

- ⛔ **不得改 `loop-engine`**（§0.1）。本包只动本仓。
- ⛔ **不得改 `tick.md` 的 `set -euo pipefail` 或它的非零退出语义** —— 那是对的，是驱动层没读。
- ⛔ **无 tick 失败时，脚本的既有行为与退出码逐字不变**（含 `--dry-run` 路径）。
- ⛔ **`index.jsonl` / `journal.jsonl` 不存在或不可读 ⇒ 响亮失败并点名**，⛔ 不得静默当成"没有失败"
  （那正是本包要消灭的形态）。
- ⛔ 不得吞掉 drain 自身的非零退出：drain 已非零时保持其退出码。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **Y1** | ⭐ **判别性**：tick 非零退出 ⇒ **脚本非零退出**，且 stderr **点名 run_dir 与退出码** | 用 stub 覆盖 `TICK_ENTRY`（`bin/deep-research-loop.sh:73` 支持 env 覆盖，派发方已确认）：stub 对 `--parse-trigger-body` 输出空串并 exit 0，对 `--run` exit 2。**完全离线，不碰 bus** |
| **Y2** | ⛔ **tick 成功时行为逐字不变**：stub 全部 exit 0 ⇒ 脚本 exit 0，且既有 stdout 摘要不变 | 回归断言 |
| **Y3** | ⛔ **多 tick 中任一失败即失败**，且报告**全部**失败的 run_dir（非只报第一个） | 构造两轮、第二轮失败 |
| **Y4** | ⛔ **痕迹不可读 ⇒ 响亮失败**：`index.jsonl` 缺失/无匹配条目 ⇒ 非零退出并点名，⛔ 不得静默通过 | 判别性用例 |
| **Y5** | ⛔ **不改 loop-engine**：`git diff` 只触及本仓 | 贴 `git diff --stat` |
| **Y6** | 全量 `npx vitest run` 干净环境真绿。基线：main `090f92d` **派发方实测 539 tests**，终值不得低于基线 | ⛔ 贴本次运行完整尾部（`Test Files` / `Tests` 两行 + 有无 FAIL 段） |
| **Y7** | **可达性声明**：Y1–Y4 每条指名唯一会失败的用例 + 一两句「为什么缺该行为就不可能通过」 | dev-note |
| **Y8** | 工作树干净 | ⛔ 贴 `git status --porcelain \| wc -l` 的输出（应为 `0`）。⛔ 不要贴 `git status --porcelain` 本身——干净时它无输出，空块与遗漏不可区分 |

---

## 3　⛔ 关于变异自检：本包不要求你自报，也不要编造

**实测变异由派发方在 gate 亲手施加。** 你只需给 Y7 的**可达性声明**（可被评审读代码核实）。
⛔ 不要写「实测 / 被杀 ✓」，除非你真做了并能贴出被改行与失败输出。
**写不出就如实写「未实测，理由：见可达性声明」——这不扣分。**

---

## 4　⛔ 派发方已付的学费

**判据必须先被证明「在验收环境里可满足」才能写进硬验收。** 本线已为此付过五次代价。
⇒ 本包 Y1–Y4 派发方已逐条确认可满足：`TICK_ENTRY` 可 env 覆盖（`bin/deep-research-loop.sh:73`），
stub 使全流程**离线可控**；`drain_id → index.jsonl(lane) → run_dir → journal.jsonl` 四步遍历
已在**真实探针数据**上逐步跑通（见 §1 实测块）。

其余：⛔ 源码字符串匹配不构成证据；⛔ 测试里重写一份被测逻辑再断言等于没测；
dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit，不是 H0 提交。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 改 `loop-engine` 任何文件 | §0.1：其行为符合成文契约，改判会波及所有依赖该契约的 workflow |
| 改 `tick.md` 的失败语义 | 它是对的 |
| 用 Envelope 让 bash 叶子"上报失败" | `fatal` 只覆盖 TIMEOUT/SIGNAL/ERROR，envelope 的 effects 只有 spawn/halt，表达不了失败 |
| 改 fleet 的 `complete.success_status/failure_status` | 那是 claim 状态路由，不是操作者可见信号；且改它会重演 workflow.yaml 注释里记载的 max_nodes 失败循环 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错 |

---

## 6　交付物落点

- 实现：`bin/deep-research-loop.sh`（drain 后的 tick 失败判定与响亮退出）
- 测试：`test/g15-drain-failure-visible.test.ts`（Y1–Y4）
- 证据：`docs/dev-notes/dev_ledr_g15_drain_failure_visible_01.md`（Y1–Y8 逐条 + §3 可达性声明 +
  本次运行的全量测试尾部 + `git status --porcelain | wc -l` 输出）
