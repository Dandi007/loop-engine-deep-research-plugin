# E1c —— 把 content 锚点的闸门从「看 worker 的字符串前缀」改成「看 source」，并补齐 E1b 的三处交付缺口

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E1b 的 `main`）
**⛔ 改动面必须小：本包只收口，不重做 E1b。**

---

## 0　⛔ 地面真相（派发方 2026-08-14 04:16 在 E1b 交付分支上真机取证，照抄，不得推测）

### GT-1　⭐⭐ D4 的闸门被实现成**看 worker 有没有自己加 scheme**，畸形锚点仍可达

E1b 交付的 `src/harvest.ts:127-141` 逐字：

```ts
export function composeAnchor(
  source: string,
  locator: string,
  revision: string,
  range?: string,
): string {
  if (locator.startsWith("web://")) {
    const base = `${locator}@${revision}`;
    return range ? `${base}#${range}` : base;
  }
  const base = `${source}://${locator}@${revision}`;
  return range ? `${base}#${range}` : base;
}
```

派发方把三种 evidence 喂进**生产的** `anchorForEvidence`，逐字输出：

```
worker 带 scheme  (source=content, locator="web://http://127.0.0.1:50287/e1-material.png")
  → web://http://127.0.0.1:50287/e1-material.png@63ac13ab#L9          ✅ 期望形态

worker 不带 scheme (source=content, locator="http://127.0.0.1:50287/e1-material.png")
  → content://http://127.0.0.1:50287/e1-material.png@63ac13ab#L9      ❌ D4 明令禁止的畸形值

code 回归         (source=code,    locator="src/dispatch.ts")
  → code://src/dispatch.ts@efebe27#L1287                              ✅ 未破坏
```

⇒ **判定依据落在 LLM 输出的字符串形态上**：worker 只要漏掉 `web://` 前缀，
就会往**没有 DELETE 的 append-only bus** 上发一个 E3 永远核验不了的锚点。

E1b 自己的注释里写的是对的（逐字）：

```
 * content worker 的输出形态由 persona 决定，
 * 本包管不着 worker，必须在**收割侧兜住**
```

**但实现做的正好相反：把闸门交回给了 persona 的输出格式。**
按宪法第十一条（闸门归代码，persona 只作纵深防御），这道判定必须钉在
**`source` 这个语义字段**上，⛔ 不得钉在 worker 吐出来的字符串前缀上。

### GT-1b　⭐⭐⭐ **worker 回报的 anchor 三件套根本不可信**（本包最重要的一条，2026-08-14 06:12 真机取证）

派发方用**同一份 input**（同一 `clue_text`、同一 spool）在真机上跑了**两次** `dr-worker-content`，
它回报的 `worker.result.v1` **形态完全不同**，逐字：

```
第一次（测试总线 board:agent-runs seq 733）
  "source":   "content"
  "locator":  "web://http://127.0.0.1:50287/e1-material.png"
  "revision": "63ac13abaabf5726e675d8fbb5ccda36a960767ba5b860448e701ada88f5e43b"   ← 完整 sha256
  "range":    "L9"

第二次（seq 751，E1b-rt2 验收时）
  "source":   "content"
  "locator":  "63ac13abaabf5726.md"          ← spool 的**本地文件名**，不是源 URI
  "revision": "63ac13abaabf5726"             ← **截断**成 16 位（文件名前缀），不是 sha256
  "range":    "9"                            ← 没有 L 前缀
```

```
第三次（E1b 的 Z2 真机验收，走**完整生产链**：material → ingest → transcript → content-clue
        → triage → dispatch → dr-worker-content(exit 0, 255s) → harvest，共发布 16 条证据）
  "source":   "content"
  "locator":  "http://127.0.0.1:50287/e1-material2.png"    ← **裸 URI**，没有 scheme
  "revision": "9bee527fe5f6e5ddef93194f3ede333b964ff9b50c8db013aef1dc6659fe1675"  ← 完整 sha256
  "range":    "L3:1-43"                                    ← 行:字符起-字符止，又一种形态
```

**三次真跑、三种形态。** `quote` 每次都逐字来自 transcript（内容是对的），
**但锚点三件套是 LLM 每次现编的**。

第三次的后果是实锤的：E1b 交付的 `locator.startsWith("web://")` 判定**没命中**，
16 条证据**全部**以畸形 scheme 发到了证据 channel 上，逐字：

```
content://http://127.0.0.1:50287/e1-material2.png@9bee527f…#L3:1-43
content://http://127.0.0.1:50287/e1-material2.png@9bee527f…#L7:12-308
…（16 条，scheme 分布 {'content': 16}，`web://` 零条）
```

把第二次代进 E1b 交付的拼装 ⇒

```
content://63ac13abaabf5726.md@63ac13abaabf5726#9
```

**scheme、locator、digest、range 四项全错**，而且：
- E2b 的活 URL 拒发闸只看 `source === "web"`，`source=content` **拦不住**；
- E1b 的 `locator.startsWith("web://")` 判定**也拦不住**（这个 locator 不带 scheme）。

⇒ ⛔⛔ **本包不得靠「加工 worker 回报的字段」来达成 D4。**
调度器**自己就知道**权威值：content-clue 是它 propose 的、transcript 是它按 digest 从
`research:content` 取回并 spool 的。**`<uri>` 与 `<digest>` 必须取自调度器侧的 clue 元数据**，
worker 只提供 `range` 与 `quote`。这才是「闸门归代码，persona 只作纵深防御」（宪法第十一条）。

### GT-2　E1b final review 的三条 minor（派发方复核后认定为交付缺口，非风格建议）

逐字引述 reviewer：

```
test/a8f-adddir.test.ts:456-482
  D5 acceptance (criterion 6) asks for 'clue lands blocked, rationale names the digest, zero spawn'.
  The production-path test asserts zero spawn, spawned:false and writes >= 2, but never asserts the
  CAS target status is 'blocked' nor that the published rationale names the digest.

test/harvest.test.ts:98-124
  D4 acceptance (criterion 4) is phrased as 'the anchor published to the bus is literally
  web://<uri>@<digest>#<range>'. The tests assert on anchorForEvidence/composeAnchor directly;
  no test drives harvestCard and inspects the anchor captured by publishEvidence.

src/tick-run.ts:202-211
  ROLES_REQUIRING_ALLOWED_ROOT is no longer referenced anywhere after the content branch stopped
  consulting it, and its doc comment still states that dr-worker-content requires --allowed-root —
  which now contradicts D2. Dead constant with a misleading contract note.
```

### GT-3　D7 的「运行记录」那半没交付

派发方 spec E1b D7 要求 spool 落位「写进 profile **与运行记录**」。
profile 侧已交付（`profiles/deploy/*.env` 各加了声明），
但 reviewer 逐字指出：

```
the effective spool root is not echoed into RunWriteOutcome or the tick JSON,
so a run record does not show where the transcript landed.
```

### GT-4　运行环境（派发方已就位）

测试总线 `http://127.0.0.1:7495`：协议齐全，`research:content` 上已有一条真 transcript
（`digest=63ac13abaabf5726e675d8fbb5ccda36a960767ba5b860448e701ada88f5e43b`，
`origin=http://127.0.0.1:50287/e1-material.png`）。
`dr-worker-content` 的 runtime/route 由 **E1b-rt** 修（agent-runtime 仓），本包不碰另一个仓。

---

## 1　交付清单

| # | 必须交付 | 关键约束 |
|---|---|---|
| **D1** | ⭐⭐ **content 证据的 `<uri>` 与 `<digest>` 一律取自调度器侧的 clue 元数据**（该 content-clue 携带的 origin URI 与权威 digest），拼成 `web://<uri>@<digest>#<range>`；worker 回报的 `locator` / `revision` **只作交叉核对，不作数据源** | ⛔ 判定不得依赖 `locator.startsWith(...)` 之类的字符串前缀嗅探（GT-1b：worker 每次现编，两次形态完全不同）。⛔ `code://` 路径逐字不变（code worker 的 locator/revision 仍是权威来源——那是它从真仓里读的） |
| **D2** | **worker 回报的 `locator`/`revision` 与调度器侧权威值不一致时，必须留下可观测的记录**（点名 clue_id 与两侧的值），但**以调度器侧的值为准继续发布** | ⛔ 不得静默丢弃这个不一致（那是持续观察 worker 行为的唯一窗口）；⛔ 也不得因此拒发整条证据——`quote` 是对的，锚点由调度器补正即可。⛔ 拒发记录/不一致记录里不得回抄 quote 全文 |
| **D2b** | **`range` 形态归一**：worker 可能回 `"L9"` 也可能回 `"9"`（GT-1b），最终 anchor 里必须是统一形态 | 与 `code://` 现行的 `#L<a>[-L<b>]` 同构；⛔ 不得把两种形态原样透传下去 |
| **D3** | 补齐 D5 的两半断言：CAS 目标状态是 `blocked`、发布的 rationale **点名 digest**（GT-2） | 测试必须走生产装配链 |
| **D4** | 补齐 D4 的端到端断言：驱动 `harvestCard`，检查 **`publishEvidence` 实际收到的** anchor（GT-2） | ⛔ 只断言 `composeAnchor`/`anchorForEvidence` 不算 |
| **D5** | 清掉 `ROLES_REQUIRING_ALLOWED_ROOT` 这个死常量及其**与现行契约矛盾**的注释（GT-2） | 若它对 `dr-worker-code-local` 仍有意义，则**改对注释并保留引用点**；⛔ 不得留一个没人引用又说错话的常量 |
| **D6** | spool 根落进**运行记录**（tick 的 JSON 输出 / `RunWriteOutcome`），使人能看出 transcript 落在哪（GT-3） | ⛔ 只写 profile 不算 |

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` **连跑两次都全绿**（抖动一次即视为未交付）。
2. **⭐⭐⭐ D1 判别性（本包核心）**：设该 content-clue 的调度器侧权威值为
   `uri=http://127.0.0.1:50287/e1-material.png`、
   `digest=63ac13abaabf5726e675d8fbb5ccda36a960767ba5b860448e701ada88f5e43b`。
   把 GT-1b 那**两条逐字的真实 worker 回报**分别喂进生产收割路径，**两条都必须**产出**同一个** anchor：

   ```
   web://http://127.0.0.1:50287/e1-material.png@63ac13abaabf5726e675d8fbb5ccda36a960767ba5b860448e701ada88f5e43b#L9
   ```

   - 输入 A：`locator="web://http://127.0.0.1:50287/e1-material.png"`、`revision=<完整 sha256>`、`range="L9"`
   - 输入 B：`locator="63ac13abaabf5726.md"`、`revision="63ac13abaabf5726"`、`range="9"`
   - 输入 C：`locator="http://127.0.0.1:50287/e1-material.png"`（裸 URI 无 scheme）、
     `revision=<完整 sha256>`、`range="L3:1-43"` ⇒ anchor 结尾为 `#L3:1-43`（range 原样保留，只归一 `L` 前缀）

   ⛔ 断言里出现 `content://`、出现 `.md`、出现截断的 16 位 digest，任一即为方向钉反。
   把 `<uri>@<digest>` 改回取 worker 的 `locator`/`revision` ⇒ **输入 B 与输入 C 都必须变红**。
3. **⭐ D2 判别性**：喂输入 B（worker 值与权威值不一致）⇒ 证据**照常发布**且 anchor 是权威形态，
   **同时**产出一条可观测的不一致记录（含 clue_id 与两侧的值，⛔ 不含 quote 全文）；
   删掉该记录 ⇒ 变红。另配一条：喂输入 A（两侧一致）⇒ **不产生**不一致记录。
3b. **⭐ D2b 判别性**：`range="9"` 与 `range="L9"` ⇒ anchor 结尾**都**是 `#L9`；
   把归一去掉 ⇒ 其中一条变红。
4. **⭐ D3 判别性**：transcript 取不到 ⇒ 驱动生产路径断言
   (a) CAS 目标状态 `=== "blocked"`；(b) 发布的 rationale **含该 digest**；(c) spawn 次数 0。
   任一断言删掉 ⇒ 变红。
5. **⭐ D4 判别性**：驱动 `harvestCard`，从 `publishEvidence` 的**捕获参数**里取 anchor 断言
   （⛔ 不是从 `composeAnchor` 的返回值）；把 D1 的修复撤回 ⇒ 变红。
6. **⭐ D6**：tick 的 JSON 输出里能看到本次生效的 spool 根；把该字段删掉 ⇒ 变红。
7. **⛔ 断言打在生产组装出的 deps 上**；⛔ 源码字符串匹配 / 读文件文本比对不构成证据；
   ⛔ 不得在测试里绕过装配链直接给内层函数传参。
8. **回归**：`main` 上已有的一切行为逐字不变（E0 回归基线全套、E2b 的两条新 role 映射与活 URL
   evidence 条目级拒发不连坐、E1 的权威 digest / 全局去重 / content-clue 幂等 / 失败粒度下沉 /
   串行化 / `maxClues` 对 content-clue 生效、E1b 的 spool 落地 / content `allowed_root` = spool 根 /
   code-local `allowed_root` 与 `revision` 不变 / clue text 携带 `web://<uri>@<digest>` / 写预算预留 2 次）。
9. **Z1（真机，派发方执行）**：`bash bin/e0-regression.sh` 仍在 profile 声明预算内跑到非 null 终态、
   退出 0、`prod_bus_guard_wrote=false`。
10. **Z2（真机，派发方执行）**：一条真的 content clue 被派给 `dr-worker-content`，worker exit 0，
    其证据被发布到证据 channel 且 `anchor` 逐字为 `web://<uri>@<digest>#<range>`。

> 判据 9–10 由派发方在真机上验证。

## 3　⛔ 明确不做

| 不做 | 理由 |
|---|---|
| 重做 E1b 的 spool / clue text / allowed_root / 写预算 | 那些已交付且判据 8 要求逐字保住；本包只收口 |
| 改 `agent-runtime` 仓 | E1b-rt 的范围 |
| anchor-check 认 `web://`（核验侧） | **E3**。本包只保证锚点**被拼成**正确形态 |
| 收工仲裁者 / 原子产物 / 驱动入口重写进 TS | E5 / E4 / E7 |
| 注册 protocol / 建 channel、改 `mineru.ts` 语义、`recipes/*` 白名单 | 不可逆 / 已拍板豁免 |

## 4　评审口径

- **REJECT 只用于 blocker 级**：判据不成立、判别性缺失或方向钉反（尤其判据 2 第二条）、
  闸门仍可被 worker 的字符串形态绕过、越出 §1 范围、改坏判据 8 列出的既有行为。
- ⚠️ 本线累计因「测试绕开被测对象」被驳回 10 次以上。**判据 2–6 的测试必须真正驱动被测对象。**
- reviewer 只读，判据 1–8 由 acceptance 命令的执行结果作证。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`。
