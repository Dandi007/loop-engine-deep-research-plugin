# E1b —— transcript spool 落地 + 三处 content 契约对齐（交付清单式）

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E1 的 `main`，`cae3654`）

> 本 spec 每条都写成「**必须交付**」并自带验收判据。
> ⛔ 不用「不得回退 / 必须原样保留」措辞。

---

## 0　⛔ 地面真相（派发方 2026-08-14 02:36–03:10 真机取证，照抄，不得推测、不得由 fixture 反推）

### GT-1　⭐ content worker 拿到的 `allowed_root` 是**代码仓根**，而 transcript 根本不在那儿

`src/tick-run.ts:1724-1743` 逐字：

```ts
        const allowedRoot = opts.allowedRoot;
        if ((ROLES_REQUIRING_ALLOWED_ROOT as readonly string[]).includes(role) && !allowedRoot) {
          throw new MissingAllowedRootError(role);
        }
        const augmented = buildWorkerInput(
          input.clue_id, input.clue_text, input.depth, input.sources,
          allowedRoot,
          allowedRoot ? resolveRevision(allowedRoot) : undefined,   // = git rev-parse HEAD
        );
```

`opts.allowedRoot` 来自入口的 `--allowed-root`（回归基线传的是 `/data/code/self/agent-runtime`）。
⇒ `dr-worker-content` 与 `dr-worker-code-local` **拿到同一个代码仓根**，
既读不到 transcript，又白拿了整个代码仓的读权限。

### GT-2　⭐ 全仓**没有任何一处把 transcript 落成本地文件**

```
$ grep -rn "spool" src test
src/tick-run.ts:189,195   ← 只有注释提到 spool
src/tick-run.ts:370       ← 只有错误文案提到 spool
test/a8f-adddir.test.ts:350 ← 只有注释
```

**零实现**。`research:content` 上的 transcript 从未被写到磁盘上过。

### GT-3　⭐⭐ clue text 的格式与 worker persona 的期望**对不上**

E1 交付的 `src/ingest.ts:220` 逐字：

```ts
  return `transcript digest=${digest} origin=${originUri}`;
```

而 `agent-runtime` 的 `profiles/roles/personas/dr-worker-content.md` 逐字：

```
- anchor URI format: web://<uri>@<digest>#<range>
- The `uri` and `digest` are carried by the clue text (`web://<uri>@<digest>`).
  Reuse them as-is; never invent, guess, or reconstruct an anchor yourself.
```

两边说的不是一回事。

### GT-4　⭐⭐ content 证据的锚点会被拼成**双 scheme 畸形值**

`src/harvest.ts` 逐字：

```ts
export function composeAnchor(source, locator, revision, range?): string {
  const base = `${source}://${locator}@${revision}`;
  return range ? `${base}#${range}` : base;
}
export function anchorForEvidence(item: WorkerEvidenceItem): string {
  …
  return composeAnchor(source, locator, revision, item.range);
}
```

派发方 2026-08-14 02:40 真跑 `dr-worker-content`（claude runtime，读 spool 里一份真 transcript），
它发回 bus 的 `worker.result.v1`（测试总线 `board:agent-runs` seq 733）逐字：

```json
{"claim":"H1 工程基建组以「支撑大规模分布式机器人的部署与运营——端云一体全自动 AI Infra 闭环」为北极星方向。",
 "locator":"web://http://127.0.0.1:50287/e1-material.png",
 "quote":"H1 工程基建组围绕「支撑大规模分布式机器人的部署与运营——端云一体全自动 AI Infra 闭环」北极星，完成了从分散脚本到",
 "range":"L9",
 "revision":"63ac13abaabf5726e675d8fbb5ccda36a960767ba5b860448e701ada88f5e43b",
 "source":"content"}
```

代进 `composeAnchor` ⇒

```
content://web://http://127.0.0.1:50287/e1-material.png@63ac13ab…#L9
```

而 spec §5.1 要求的形态是 `web://<uri>@<digest>#<range>`。
⇒ **E3 的 `web://` 核验器永远匹配不上这个锚点。**

### GT-5　写预算对新 transcript **少算一次**（E1 final review 的 non-blocking note，派发方已接受并转为本包交付）

一份新 transcript 实际耗 **2 次 bus 写**（`publishDoc` 到 `research:content` ＋ content-clue 落板），
但 `harvest.ts` 的 `needed` 只预留 1 ⇒ `--max-writes` 可被超出「每份新转写 1 次」。

### GT-6　运行环境（派发方已就位）

测试总线 `http://127.0.0.1:7495`：协议齐全、`research:content` 已建且已有 1 条真 transcript
（`digest=63ac13abaabf5726e675d8fbb5ccda36a960767ba5b860448e701ada88f5e43b`，
`origin=http://127.0.0.1:50287/e1-material.png`，body 1008 字节）。
MinerU 只有 CPU `127.0.0.1:8090` 可用（GPU 不应答）。

⚠️ **并行包**：`dr-worker-content` 的 runtime/route 正由 **E1b-rt**（agent-runtime 仓）修
（该 role 现为 `runtime: opencode`，而 `agent-run` 的 `--add-dir` 只支持 claude/kimi ⇒ 现状下
`allowed_root` 是空操作）。⛔ 本包**不碰 agent-runtime 仓**，只管 plugin 侧把 spool 与契约做对。

---

## 1　交付清单（⛔ 全部都要真的存在于本次交付里）

| # | 必须交付 | 关键约束 |
|---|---|---|
| **D1** | **transcript spool**：派发一条 `sources:["content"]` 的 clue 前，按 clue 携带的 digest 从 `research:content` 读到 transcript，落成**本地文件** | 文件名可由 digest 派生；spool 根目录由 **profile 声明**（⛔ 不写死绝对路径） |
| **D2** | **content 角色的 `allowed_root` = spool 根**，⛔ 不是 `--allowed-root` 那个代码仓根 | `dr-worker-code-local` 的 `allowed_root` 与 `revision` 行为**逐字不变**（仍是代码仓根 + `git rev-parse HEAD`）。⛔ content 的 `revision` 不得再取代码仓的 HEAD（那与 transcript 无关） |
| **D3** | **clue text 统一成 persona 期望的形态**：携带 `web://<uri>@<digest>`（GT-3） | ⛔ 两处都要改到位：`contentClueText` 的产出，以及派发时喂给 worker 的 `clue_text` |
| **D4** | **锚点拼装修掉双 scheme**（GT-4）：content 证据最终落到 bus 上的 `anchor` 必须是 `web://<uri>@<digest>#<range>` | ⛔ `code://` 路径的拼装逐字不变；⛔ 不得靠「让 worker 少填一层」来绕（worker 的输出形态由 persona 决定，本包管不着，必须在收割侧兜住） |
| **D5** | **transcript 取不到 ⇒ 该 clue 出生即/转为 `blocked`**（rationale 点名 digest 与失败原因），⛔ 零 spawn | ⛔ 不得静默跳过、⛔ 不得派一个必然产出零证据的 worker（与既有 `MissingAllowedRootError` 的响亮纪律同构） |
| **D6** | **写预算对新 transcript 预留 2 次**（GT-5） | ⛔ 复用路径（不新发 doc）仍只算它实际要写的次数，不得一律 +1 |
| **D7** | **spool 清理边界明确**：spool 目录归属本 run，⛔ 不得落在 vault 根、⛔ 不得与 `.dd-evidence/**`、`.dev-dispatch/**` 冲突 | 落位写进 profile 与运行记录 |

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` **连跑两次都全绿**（抖动一次即视为未交付）。
   ⚠️ `tsconfig` 的 include 含 `test`，测试文件同样要过 strict 检查。
2. **⭐⭐ D1/D2 判别性**：一条 `sources:["content"]` 的 clue 走**生产装配链**派发 ⇒
   (a) spool 根下真的出现了内容**逐字等于** `research:content` 上那份 transcript body 的文件；
   (b) spawn 参数与 worker input 里的 `allowed_root` **等于 spool 根**、⛔ 不等于 `--allowed-root`；
   把 D2 改回传 `opts.allowedRoot` ⇒ 变红。
   ⛔ 测试必须驱动真实派发路径，不得在测试里直接给内层函数传参绕过装配链。
3. **⭐ D2 回归判别性**：同一 tick 里一条 `sources:["code-local"]` 的 clue ⇒
   其 `allowed_root` 仍是 `--allowed-root`、`revision` 仍是该仓 `git rev-parse HEAD`；
   把两条 role 的 allowed_root 混成同一个 ⇒ 变红。
4. **⭐⭐ D4 判别性（本包最容易做歪的一条）**：把 GT-4 那条**逐字的** worker evidence
   （`source:"content"`、`locator:"web://http://127.0.0.1:50287/e1-material.png"`、
   `revision:"63ac13ab…"`、`range:"L9"`）喂进收割路径 ⇒
   发到 bus 上的 `anchor` **逐字等于** `web://http://127.0.0.1:50287/e1-material.png@63ac13ab…#L9`；
   ⛔ 断言里不得出现 `content://`；把修复撤回 ⇒ 变红。
   另配回归一条：`source:"code"` 的 evidence 拼出的 anchor 与 base 逐字一致。
5. **⭐ D3 判别性**：propose 出来的 content-clue 的 `text` 含 `web://<uri>@<digest>`；
   派发该 clue 时喂给 worker 的 `clue_text` 同样含它；改回 `transcript digest=… origin=…` ⇒ 变红。
6. **⭐ D5 判别性**：`research:content` 上查不到该 digest ⇒ 该 clue 落 `blocked`、rationale 点名 digest、
   **spawn 次数为 0**；改成「照常派发」⇒ 变红。
7. **⭐ D6 判别性**：预算恰好只剩 1 ⇒ 一份**新** transcript 的 harvest **不会**把预算写超
   （整卡按既有纪律跳过并响亮报告）；把预留改回 1 ⇒ 变红。
8. **⛔ 断言打在生产组装出的 deps 上**；⛔ 源码字符串匹配 / 读文件文本比对不构成证据。
9. **回归**：`main` 上已有的一切行为逐字不变（E0 回归基线全套 + E2b 的两条新 role 映射与
   活 URL evidence 条目级拒发不连坐 + E1 的权威 digest / 全局去重 / content-clue 幂等 /
   失败粒度下沉 / 串行化 / `maxClues` 对 content-clue 生效）。
10. **Z1（真机，派发方执行）**：`bash bin/e0-regression.sh` 仍在 profile 声明预算内跑到非 null 终态、
    退出 0、`prod_bus_guard_wrote=false`。
11. **Z2（真机，派发方执行）**：一条真的 content clue 被派给 `dr-worker-content`，worker exit 0，
    其回报的证据被发布到证据 channel，且 `anchor` 逐字为 `web://<uri>@<digest>#<range>`。
    ⚠️ 本条依赖并行包 **E1b-rt** 先合入（GT-6），派发方负责排序。

> 判据 10–11 由派发方在真机上验证。

## 3　⛔ 明确不做

| 不做 | 理由 |
|---|---|
| 改 `agent-runtime` 仓（role runtime/route、persona、schema） | **E1b-rt** 的范围，并行包，避免撞车 |
| anchor-check 认 `web://`（核验侧） | **E3**。本包只保证锚点**被拼成**正确形态，不负责核验它 |
| 改 `src/mineru.ts` 的既有语义 | 环境问题不是改路由的理由 |
| 收工仲裁者 / 原子产物 / 驱动入口重写进 TS | E5 / E4 / E7 |
| 注册 protocol / message kind、建 channel | 不可逆，拍板级；测试总线 channel 派发方已建 |
| `recipes/*` 工具白名单、生产 profile `agent-harness.env` | 已拍板豁免 |

## 4　评审口径

- **REJECT 只用于 blocker 级**：交付清单缺项、判据不成立、判别性缺失或方向钉反、
  自造契约 / 编造实测数字、越出 §1 范围、改坏 §2.9 列出的既有行为。
  文风与偏好写成 non-blocking 建议。
- ⚠️ 本线累计因「测试绕开被测对象」被驳回 **10 次以上**（读脚本文本比字节偏移、把 fetch/spawn 全 mock
  到亚毫秒、只 new 一个异常再自己 catch、只断言纯谓词、在测试里绕过装配链直接传参、
  只把桩的返回值再断言一遍……）。**判据 2–7 的测试必须真正驱动被测对象。**
- ⚠️ 特别核对 D4：断言里出现 `content://` 即为方向钉反。
- reviewer 只读，判据 1–9 由 acceptance 命令的执行结果作证。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`。
