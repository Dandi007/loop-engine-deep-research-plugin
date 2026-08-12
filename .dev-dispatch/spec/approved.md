# E0c2 —— 回归基线：终止语义域

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E0c1 的 `main`）
**为什么是小包**：前一版把板面域与终止语义域一起做（14 文件 / 1120 insertions），
final review **连续两次跑满 3000 秒硬超时**（`exit 93 / reason=timeout`）、零 verdict。
本线顺利过审的包是 4 文件 523 行与 11 文件 391 行。
⇒ 本包**只做终止语义域**。**⛔ 请保持改动面小**，顺手改动会把包撑大到审不完。

**前序**：E0c1 已交付板面与凭证域（head_seq 只从列表端点取、生产总线真实全量求和、
per-run 独立研究板、种子带 `--source code-local`、生产护栏、运行记录归档）。
⛔ **这些行为本包逐字不改**。

---

## 0　⛔ 地面真相（真机取证，照抄，不得推测、不得由 fixture 反推）

本目标此前多轮被驳回，主因是**实现者为观察不到的产物发明契约、再写 fixture 满足它**。
以下各条全部实测。

### GT-1　驱动 stdout 只有三行，⛔ 不含 termination

`bin/deep-research-loop.sh` 的完整 stdout（真机实录）：

```
{"id":"a9-…","status":"open","body":{"seed":true}}
[deep-research-loop] mode=deep-research run_root=/data/loop-engine/e0-runs/<run>/loop-run
{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"…","drain_id":"…"}
```

第三行是 drain 摘要。⛔ `termination` **不在这里**。

### GT-2　`termination` 在 tick 自己的 stdout 里，经 journal 落盘为**嵌套转义字符串**

tick `--run` 打印的完整 JSON（派发方直接调 `vite-node src/tick-entry.ts -- --run …` 实测，逐字）：

```json
{ "channelId": "research:…index", "messageCount": 0, "decisions": [], "writes": 0,
  "skipped": 0, "spawns": [], "harvestReports": [], "triageReports": [],
  "hasPendingWork": false,
  "termination": { "state": null, "coverage": 0, "zeroGrowthRounds": 1, "capHit": false } }
```

它由 loop-engine 收进 `<run_dir>/journal.jsonl`，每行形如
`{"run_id":"tick~1","identity":"tick","result":"<tick 的完整 stdout，转义字符串>","effects":[],…}`。
⛔ `termination` **不是** journal 行的顶层键，必须先取 `result` 再解析其中的 JSON。
取证路径（沿用仓内 `scripts/check-drain-failures.mjs` 同一条）：
`drain 摘要.drain_id → index.jsonl → run_dir → journal.jsonl → 最后一轮 tick 的 result → termination.state`。

### GT-3　⭐ 单次 drain 不是「跑完一次研究」的单位

真机实录（派发方 2026-08-12 06:20 在含 per-run 板与带 sources 种子的候选上跑）：

```
驱动 stdout 第三行：{"reason":"max_rounds","rounds":16,"ticksByLabel":{"tick":16}}
drain.json：       墙钟 18.2 秒
loop-events.jsonl：16 个 round_start，第 1→16 轮共 17.1 秒（约 1.1 秒/轮）
板面：index head_seq=2（seed + CAS 到 in_flight）  evidence=0
board:agent-runs：3 → 4（确实派出过 worker）
```

同一时刻那个 worker 的 run 记录：`dr-worker-code-local exit 0 duration_seconds=158.162`。

⇒ **worker 要 158 秒，loop 把 16 轮全烧完只用 17 秒**——第一个 worker 还没返回，
drain 就 `max_rounds` 退出了。

**证明流水线本身没问题**：派发方在 worker 跑完后对同一块板**手工补跑一个 tick**：

```
decisions=[harvest]  writes=10
harvestReports=[{evidencePublished: 7, cluesPublished: 2, casExplored: true}]
```

evidence 真发出来了、新 clue 也提出来了（BFS 扩展）。**缺的只是「等」。**
（旁证：V2 生产那次跑出 64 条线索 / 55KB 报告，说明生产形态下驱动脚本本来就被**反复调用**。）

### GT-4　续投门与终态判据差一拍

- `src/tick.ts` 的 `decideTermination`：只有 `zeroGrowthRounds >= cfg.zeroGrowthThreshold`
  （缺省 **2**）且 `inFlight === 0 && proposed === 0` 时，`state` 才非 null。
- `workflows/deep-research/tick/templates/tick.md`：**续投门是 `hasPendingWork`**。

板面排空的那一刻 `hasPendingWork` 立即为 false ⇒ 不再续投 ⇒ drain 退出，
而此时 `zeroGrowthRounds` 往往才 1 ⇒ 攒不到 2。
**佐证**：派发方遍历 `/data/loop-engine/runs/` 全部历史，从未出现过一次非 null 的 `termination.state`。

> ⚠️ 注意 GT-3 与 GT-4 是**两个不同的**缺陷：GT-4 只在**最后排空那一刻**咬人；
> GT-3 是全程性的（有真实研究时板面持续产出新工作，loop 会一直续投，
> 但单次 drain 的 16 轮在十几秒内就烧完了）。两条都要修。

### GT-5　⭐ loop-engine 的 bash 叶子实际用 **zsh** 执行 ⇒ `tick.md` 现有的 bash 数组语法必挂

`loop-engine/src/lib/exec.ts:382-384` 逐字：

```ts
export function runScript(script: string, opts: ExecOpts): Promise<ExecResult> {
  return run("zsh", ["-c", script], opts);
}
```

非沙箱 bash 叶子（tick 走的就是这条）**恒用 `zsh -c`**，与宿主 shell 无关。
而 `workflows/deep-research/tick/templates/tick.md:79` 是 bash-only 语法：

```bash
IFS=$'\t' read -r -a prev_arr <<< "$prev_line"
```

zsh 的 `read` 没有 `-a`（zsh 用 `-A`）⇒ 真机实录（派发方 2026-08-12 12:48 在 E0c1 候选上跑
`bash bin/e0-regression.sh`，逐字）：

```
[deep-research-loop] TICK FAILURE: run_dir=/data/loop-engine/runs/2026-08-12T124847-4475528a exit=1
[deep-research-loop]   journal: {"run_id":"tick~1","identity":"tick",
  "result":"[bash 非零退出 EXIT:1]\nzsh:read:83: bad option: -a","effects":[]}
drain 摘要：{"reason":"drained","rounds":2,"ticksByLabel":{"tick":2}}
```

该分支只在 `prev_line` 非空（= 有 G4b 续投 body，即**第二轮起**）才走到，所以
**第一轮永远正常、第二轮起必死**——续投链从来就没真正跑通过。
这与 GT-4 叠加，正是"历史上从未出现过非 null `termination.state`"的直接原因之一。

⇒ 本包 §1.2 既然要重写这段续投判定（改用真 JSON 解析），**必须同时让它在 zsh 下真能跑**。
⛔ 不得只在单测里用 bash 跑通就算数：单测里的 shell 与真机的 `zsh -c` 不是同一个。
判别性要求见 §2 判据 9。

## 1　交付内容（只此三项）

### 1.1 终态取真值
按 GT-2 的路径读 `termination.state`。
读取链路任一步失败（拿不到 drain 摘要 / 无 `drain_id` / 找不到 run_dir / 无 journal /
没有 `identity=="tick"` 的条目 / `result` 解析失败）⇒ **响亮失败并点名是哪一步**；
⛔ 不得回退成「用 drain 摘要的 reason 凑合」，⛔ 不得把「读不到」当成任一方向的默认值。

### 1.2 续投门对齐终态判据（GT-4）
`tick.md` 的续投条件从 `hasPendingWork == true`
改为 `hasPendingWork == true  或  (termination.state 仍为 null 且未触顶)`。
- 触顶（`capHit`）时按既有语义走（`capped` 需等在途排空），⛔ 不得因本改动绕过熔断。
- 拿到非 null 终态后**必须停止续投**，⛔ 不得无限空转。
- 判定必须用**真 JSON 解析**读 `run_output`（现状是 `grep -q '"hasPendingWork": *true'` 正则，一并改掉）。
- ⭐ **改完的这段必须在 `zsh -c` 下真能跑**（GT-5）：`tick.md` 由 loop-engine 用 `zsh -c` 执行，
  现有的 `read -r -a` 从第二轮起必死。⛔ 不得引入任何 bash-only 语法
  （`read -a`、`mapfile`/`readarray`、`declare -A`、`${arr[@]:1}` 之外的 bashism 等）；
  能不用数组就不用（把解析放进已有的 Node/TS 侧更稳）。

### 1.3 入口反复 drain 直到终态（GT-3）
`bin/e0-regression.sh` 从「调一次 `deep-research-loop.sh`」改为循环：

```
重复：
  跑一次 deep-research-loop.sh（一次 drain）
  按 §1.1 读本次的 termination.state
  非 null            ⇒ 成功收尾，退出循环
  撞墙钟或次数上限    ⇒ 失败收尾（响亮，非零退出，点名撞的是哪个上限、实测值多少）
  否则               ⇒ 退避后再来一轮
```

- **退避**时长与**墙钟上限**、**drain 次数上限**三者都由 profile 声明，⛔ 不写死在脚本里。
  退避量级要与 worker 真实耗时相称（实测 `dr-worker-code-local` ≈ 158 秒），⛔ 不得零间隔空转。
- 每轮 drain 在 stdout 打一行进度（第几轮 / 本轮 drain reason / 当前 `termination.state` /
  板面 head_seq），并把每轮的 `runs_root`/reason/终态追加进运行记录，⛔ 不得只留最后一轮。
- ⛔ 不得靠改 `max_passes`（单次 drain 的轮次上限）来"解决"——那只是放慢烧轮次的速度，
  worker 该等还是要等；本包要的是**跨 drain 的循环与退避**。

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` 全绿。
2. **⭐ 判别性**：`termination.state` 为 `null` ⇒ 入口非零退出；
   把终态判据换成「用 drain 摘要的 reason」⇒ 测试变红。
3. **⭐ 判别性**：journal 里没有 `identity=="tick"` 的条目 ⇒ 响亮失败并点名该步，
   ⛔ 不得当作任一方向的默认值。
4. **⭐ 判别性（GT-4）**：构造「板面已排空但 `termination.state` 仍为 null 且未触顶」⇒ **仍然续投**；
   把续投门改回只看 `hasPendingWork` ⇒ 测试变红。
5. **⭐ 判别性（GT-3）**：构造「第一次 drain 后仍 null、第二次后非 null」⇒
   入口**继续跑第二轮并最终退出 0**；改回只跑一次 drain ⇒ 测试变红。
6. **⭐ 判别性（上限）**：`termination.state` 永远为 null ⇒ 撞到 profile 声明的上限时非零退出，
   且点名撞的是哪个上限。⛔ 不得无限循环（测试须能在有限时间内跑完）。
7. **⭐ 判别性（GT-5 / zsh）**：`tick.md` 里被本包改动的那段，必须有一条测试**用 `zsh -c` 真跑**
   （不是 bash、不是 `sh`）并断言它在"有续投 body"的第二轮上成功；
   把其中任一处换成 bash-only 语法（如 `read -r -a`）⇒ 该测试变红。
   ⛔ 不得用"在 bash 下跑通"替代这条。
8. **回归 ⛔**：E0c1 的全部行为逐字不变（head_seq 取法、真实求和、per-run 板、种子带 sources、
   生产护栏、运行记录归档）。⛔ 本包只加终止语义，不得顺手改动或放宽上述任何一条。
9. **Z1（真机）**：`bash bin/e0-regression.sh` 跑到**非 null 终态**、退出 0，
   `board:agent-runs` head_seq 相对跑前严格增长，**且证据 channel head_seq > 0**（真收割到 evidence）。
10. **Z2（真机）**：运行前后生产总线 `sum(head_seq)` 零增长（派发方独立复算）。
11. **Z3（真机）**：连续两次执行都退出 0、各自独立 run id 与独立研究板、两次都满足判据 9。

> 判据 9–11 由派发方在真机上验证。⚠️ 真机跑通预计需**若干分钟到几十分钟**
> （单个 code-local worker ≈ 158 秒，一次研究要多轮）——这是正常的；
> ⛔ 不得为求快把研究范围缩到秒级，那会让基线失去回归意义。

## 3　⛔ 明确不做

web/content 接线（E2b）、ingest（E1）、anchor scheme（E3）、收工仲裁者（E5）、
原子产物（E4）、驱动脚本重写进 TS 入口（E7）、协议注册、`recipes/*` 工具白名单、
生产 profile `agent-harness.env`。

额外：⛔ 不得为了让判据过而放宽判据本身（把终态断言改回看 drain reason、
把 Z1 的 evidence 判据删掉、伪造 worker 派发等）。判据的严格性就是本包的交付物。

## 4　运行环境前提（派发方已就位，⛔ 实现者不需要做也不得与之冲突）

测试总线 `http://127.0.0.1:7495`（独立 SQLite，与生产 7490 零共享）：
三个 agent 已注册、token 落 `/data/agent-bus-test/tokens/`；`board:agent-runs` 已建；
协议已用 `agent-run register-bus-protocols` 供给齐全（14 个 kind，含
`research.clue.v2` 与 `agent.run.{started,exited}.{v1,v2}`——缺后者时 worker 会以
`CONTRACT_ERROR`(exit 91) 死在发生命周期事件那步）。
⛔ 实现者不得在代码里自动注册 protocol：协议注册不可逆，是拍板级动作。

## 5　评审口径

- **REJECT 只用于 blocker 级**：判据不成立、判别性缺失、自造契约（见 §0）、
  放宽或删除 E0c1 已有行为、无限循环、把撞上限伪装成成功、越出 §1 范围。
  文风与偏好写成 non-blocking 建议。
- ⚠️ 逐处核对：**每一处从落盘产物里取字段的代码，取的字段在真实产物里到底存不存在**
  （尤其 journal 行的 `termination` 是嵌套在 `result` 字符串里的，不是顶层键）。
- reviewer 只读，判据 1–7 由 acceptance 命令的执行结果作证，⛔ 不要求 reviewer 执行 shell。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`（引擎保留路径，写入即永久 wedge）。
