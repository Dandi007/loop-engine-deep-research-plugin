# E5 —— 收工仲裁者：零增长不再直接判收敛，改为触发 arbiter；熔断终态与仲裁终态分开标记

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = `main`）
**⚠️ 本包修订 canonical rev7 §3.4 终止条件**（spec §12.2 已注明），修法记录随包留档。

---

## 0　⛔ 地面真相（照抄，不得推测、不得由 fixture 反推）

### GT-1　现行终止判定：纯程序化，**已知违宪**

`src/tick.ts` 的 `decideTermination` 逐字（节选）：

```ts
  const capHit = count >= cfg.maxClues || maxDepth >= cfg.maxDepth;
  const drained = inFlight === 0 && open === 0 && proposed === 0;

  let state: TerminalState | null = null;
  if (capHit) {
    if (drained) {
      state = "capped";
    }
  } else if (
    zeroGrowthRounds >= cfg.zeroGrowthThreshold &&
    inFlight === 0 &&
    proposed === 0
  ) {
    // 条件 1：零增长达标且无在途/proposed。blocked>0 一律降级为 partial（§3.2）。
    state = blocked > 0 ? "partial" : "converged";
  }
```

宪法第一条的仲裁者原则（golden-order 2026-08-11 修宪逐字）：

> 每阶段设仲裁者（arbiter）：「做够了没」有判断余地，必须 agentic，由模型判；
> 程序化上限（线索数/轮数/时长）只作保底熔断的保险丝，不作正常收工判据。
> 保险丝烧断与仲裁者收工是两种终态，须分开记录。
> ⚠️ **此条使现行实现的纯程序化收敛判据（连续两轮零增长即判收敛）成为已知违宪项**

### GT-2　spec §12.2 对本包的要求（逐字）

> 收集阶段：coverage 连续零增长 ≥ 2 轮时**不再直接判收敛**，改为触发一次仲裁者（arbiter）调用
> （中档模型）。输入按宪法第十条渐进披露：任务板统计 + 线索标题清单 + 最近 N 轮新增 evidence 的
> claim 列表（**不塞全文**）。输出 = 结构化 verdict：`enough`（进入生成）或 `continue` + 理由
> （计数归零继续收集）。
>
> `maxClues` / `maxDepth` / `maxTicks` 降级为熔断线：熔断终态（capped）与仲裁收工（converged）
> 在报告头与运行记录**分开标记**。
>
> 硬验收：**R1** ⭐ 判别性——桩 arbiter 返回 `continue` ⇒ 不进入生成且零增长计数归零；
> 返回 `enough` ⇒ 进入生成。**R2** ⛔ arbiter 调用失败 ⇒ 响亮失败，不得静默回退为程序化判收敛
> （允许回退为「继续收集」，该次失败计入运行记录）。**R3** ⛔ 熔断终态与仲裁终态在导出头与
> 运行记录可区分。**R4** 回归：熔断线仍生效（触顶必停）。

### GT-3　arbiter role 已就位（agent-runtime `main`，E5-rt 已合入）

```yaml
role: dr-arbiter
version: 1
runtime: claude
route: glm-5.2/zhipu          # 中档
dispatch: { write: false, max_turns: 60, structured: true, mcp_allow: [] }
protocol:
  input:  { kind: deep-research.arbiter-input/v1, schema: schemas/arbiter-input.v1.json }
  output: { kind: dr-arbiter.result.v1,           schema: schemas/dr-arbiter-result.v1.json, accepts: [bare, fenced] }
```

**输入 schema**（`additionalProperties: false`，属性表逐字）：

```
question            string           （必填）
board_stats         object           （必填）：clues_total / clues_explored / clues_pending /
                                      clues_dropped / evidence_total / evidence_added_last_round /
                                      zero_growth_rounds / rounds_elapsed，全部 integer
clue_titles         array of { clue_id, title, status, depth }
recent_claims       array of { claim, clue_id, round }
recent_rounds       integer
```

⛔ **表里没有任何承载 quote / evidence 全文 / transcript 正文的字段**——宪法第十条，
本包组装输入时**不得**试图塞进去。

**输出 schema**：`required: ["verdict","rationale"]`；`verdict` 是硬 enum `["enough","continue"]`；
`rationale` 非空字符串。

⚠️ **`board_stats` 不在输出必填里，且 arbiter persona 已被改为不回显它**
（agent-runtime 包 E5-rt2：模型真跑时把这些计数吐成了对象，导致契约校验失败、结果发不上 bus）。
⇒ ⛔ **本包不得依赖输出里有 `board_stats`**；那些数字调度器自己就有。

⚠️ 协议注册**已由派发方完成**（测试总线 7495，用户 2026-08-14 拍板授权）。
⛔ 实现者不得在代码里注册协议。

### GT-4　可照抄的既有派发形态（`dr-triage`，同为「调度器塞 input、模型出结构化结果」）

`src/tick-run.ts` 逐字（节选）：

```
:209  export const TRIAGE_ROLE = "dr-triage";
:255  G7 —— 构造真实 triage agent-run 的完整 argv：
:256  `agent-run --role dr-triage --run-id <id> --input <file> --prompt-file <promptFile>`
:280  G7 —— 把 triage 语料写成 `--input` 载荷文件。
:301  /** 从 worker 结果读回 `dr-triage.result.v1` 的决策列表。 */
:341  `G2b: triage returned invalid action "…" — must be "keep" or "drop".
       Rejecting this decision loudly (not treating it as keep or drop).`
```

⇒ arbiter 的派发/回读/校验**照此办理**：非法 verdict 值必须**响亮拒绝**，
⛔ 不得当成 `enough` 或 `continue` 任一默认值。

### GT-4b　⭐⭐ 语料必须写进 **prompt file**，`--input` 只是类型化契约记录（派发方真机踩过）

派发方 2026-08-14 15:1x 真机取证：只传 `--input <payload>` 而 prompt 里不带语料时，
arbiter 回报的 rationale 逐字：

```
本次输入的 board digest 负载缺失——未提供 question、未提供 board_stats
（无 evidence/clue 计数、无 rounds_elapsed）、未提供 clue_titles、未提供 recent_claims，
故(1)(2)两项主判据均无材料可判。
```

⇒ **模型看不到 `--input` 文件的内容**。把同一份语料序列化进 `--prompt-file` 后重跑，
arbiter 立刻逐条引用真实数字与线索 id 作出判断（逐字节选）：

```
board_stats.zero_growth_rounds=2、rounds_elapsed=7、evidence_added_last_round=0。
判 continue 的依据落在第二顺位而非第一顺位：clue_titles 里 c4『仲裁者的输入从哪里来』
与 c5『熔断线的默认取值』仍为 [open d2]，clues_pending=2 也佐证这两条无 evidence 触及。
```

⇒ 本包必须**照 triage 的做法**：`serializeTriageCorpus` 那样把板面摘要序列化成文本写进
`--prompt-file`，`--input` 同时传（契约记录）。
⛔ 只传 `--input` 就派 arbiter = 拿不到数据的空判断，判据 11 必然失败。

> 旁证（arbiter 行为正确，非缺陷）：拿不到数据时它**拒绝判 `enough`** 并逐项点名缺失，
> 而不是硬编一个「看起来差不多了」——这正是本包要保住的反编造纪律。

### GT-5　⭐⭐ 本线反复验证过的最贵教训（⛔ 直接决定本包怎么写）

`dr-worker-content` 在**四次真跑**里吐出**四种互不相同**的字段布局，闸门被迫修了三次
（详见本仓 E1d 的 spec §0 与 `src/harvest.ts` 的 `anchorForEvidence`）；
arbiter 自己在**第一次真跑**就把 `board_stats` 吐成了对象。

**由此得出、本包必须遵守的原则**：
> ⛔ 调度器自己已经知道的事实，一律**不依赖模型回显**；模型的输出里，
> 只有「模型的判断」是不可替代的（此处 = `verdict` 与 `rationale`），其余一律以调度器侧为准。

---

## 1　交付清单

| # | 必须交付 | 关键约束 |
|---|---|---|
| **D1** | **零增长达标不再直接判 `converged`**：`zeroGrowthRounds >= threshold && inFlight===0 && proposed===0` 时，改为**触发一次 arbiter 调用** | ⛔ 熔断分支（`capHit`）行为逐字不变（GT-2 的 R4） |
| **D2** | **arbiter 输入按 GT-3 的 schema 组装**：板面统计 + 线索标题清单 + 最近 N 轮新增 evidence 的 **claim 列表** | ⛔ 不得塞 quote / evidence 全文 / transcript 正文（宪法第十条）；`recent_rounds`（N）由 profile 声明，⛔ 不写死 |
| **D3** | **verdict 分流**：`enough` ⇒ 进入生成（终态记为**仲裁收工**）；`continue` ⇒ **零增长计数归零**、继续收集，⛔ 本轮不得进入生成 | 非法 verdict 值 ⇒ **响亮拒绝**（照 GT-4 的 triage 纪律），⛔ 不得默认成任一值 |
| **D4** | **arbiter 调用失败 ⇒ 响亮失败**（点名失败原因），⛔ **不得静默回退为程序化判收敛** | 允许回退为「继续收集」，但该次失败**必须计入运行记录**（GT-2 的 R2）。⛔ 失败不得表现成一个看起来正常的收敛 |
| **D5** | **熔断终态与仲裁终态分开标记**：`capped`（保险丝烧断）与 `converged`（仲裁收工）在 **tick 输出、运行记录**里可区分 | ⛔ 两种结束不许长一个样（宪法第四条）。`blocked > 0 ⇒ partial` 的既有降级逐字保留 |
| **D6** | **arbiter 每次收工判定只调一次**，且调用留痕（run_id / verdict / 是否失败）进运行记录 | ⛔ 不得每个 tick 都调（那是白烧中档模型）；⛔ 不得静默重试掩盖失败 |
| **D7** | arbiter 的 role 名、输入/输出 kind 常量集中声明 | 照 `TRIAGE_ROLE` 的写法 |

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` **连跑两次都全绿**。
2. **⭐⭐ R1 判别性**：桩 arbiter 返回 `continue` ⇒ (a) 本轮**不进入生成**；
   (b) 零增长计数**归零**；(c) 继续收集。返回 `enough` ⇒ **进入生成**且终态标为**仲裁收工**。
   把 D1 改回「零增长即判 converged」⇒ 两条都变红。
3. **⭐⭐ R2 判别性**：桩 arbiter **调用失败**（进程非零退出 / 结果读不回 / verdict 非法值）⇒
   (a) **响亮失败**并点名原因；(b) ⛔ **不得**产出 `converged` 终态；
   (c) 该次失败出现在运行记录里。把失败处理改成「回退为程序化判收敛」⇒ 变红。
   三种失败形态**各配一条**。
4. **⭐ R3 判别性**：熔断到顶后排空 ⇒ 终态 `capped` 且运行记录标为**熔断**；
   arbiter 判 `enough` ⇒ 终态 `converged` 且标为**仲裁收工**；两者在输出里**可机械区分**。
   把两者标成同一个值 ⇒ 变红。
5. **⭐ R4 回归**：熔断线仍生效——`maxClues` / `maxDepth` 触顶后排空即停，行为与 base 逐字一致。
6. **⭐ D2 判别性（宪法第十条）**：组装出的 arbiter 输入**不含**任何 quote / evidence 全文字段，
   且能通过 GT-3 那份 `additionalProperties: false` 的输入 schema；
   往里加一个 evidence 全文字段 ⇒ 校验失败、测试变红。
7. **⭐ D6**：一次收工判定只发起**一次** arbiter 调用（断言 spawn 计数 === 1）；
   改成每 tick 都调 ⇒ 变红。
8. **⛔ 断言打在生产组装出的 deps 上**：必须驱动真实的 tick/入口路径；
   ⛔ 不得只断言纯函数、⛔ 不得绕过装配链直接传参、⛔ 源码字符串匹配不构成证据。
9. **回归**：`main` 上已有的一切行为逐字不变（E0 回归基线全套、E2b 活 URL 条目级拒发不连坐、
   E1 权威 digest / 去重 / content-clue 幂等 / 失败粒度下沉 / 串行化 / maxClues、
   E1b spool 与 allowed_root、E1c/E1d 锚点权威机制与 `anchorMismatches`、
   E1k2 密钥形态闸门与其合法摘要豁免）。
10. **Z1（真机，派发方执行）**：`bash bin/e0-regression.sh` 退出 0、`prod_bus_guard_wrote=false`、
    证据 channel head_seq > 0。
11. **⭐⭐ Z2（真机，派发方执行）**：一次真实运行中**至少一条 arbiter verdict 落运行记录**
    （spec §13.2 的 E5 痕迹点），且该 verdict 与最终终态一致
    （`enough` ⇒ 进入生成；`continue` ⇒ 继续收集且计数归零）。

> 判据 10–11 由派发方在真机上验证。

## 3　⛔ 明确不做

| 不做 | 理由 |
|---|---|
| 讨论/成文阶段的仲裁 | spec §12.2 明写：本期只做收集阶段一处仲裁 |
| 改 `agent-runtime` 仓（role/persona/schema） | E5-rt / E5-rt2 的范围 |
| 注册协议 / 建 channel | 注册已由派发方完成；⛔ 实现者不得在代码里注册 |
| 原子产物 / 引用过滤 | E4 |
| 驱动入口重写进 TS | E7 |
| 改 `decideTermination` 里 `proposed === 0` 这类板面判定的含义 | 本包改的是「零增长之后由谁拍板」，不是改板面语义 |

## 4　评审口径

- **REJECT 只用于 blocker 级**：判据不成立、判别性缺失或方向钉反、
  **arbiter 失败被静默回退成程序化收敛**（R2 是本包的命门）、
  熔断终态与仲裁终态没分开、输入塞了全文（违宪第十条）、越出 §1 范围。
- ⚠️ 本线累计因「测试绕开被测对象」被驳回 10 次以上。**判据 2–7 的测试必须真正驱动被测对象。**
- ⚠️ **⛔ 交付说明（markdown）里不得逐字写出任何凭证前缀字符串**（会触发控制面 secret sentinel
  使本 development 卡死，本线已因此报废过一个包）。
- ⚠️ reviewer 必须**对着 base 做 diff**，⛔ 不得把工作树里 `main` 的既有内容读成本包新增
  （事实卡 `m-3d8d88`）。
- reviewer 只读，判据 1–9 由 acceptance 命令的执行结果作证。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`。
