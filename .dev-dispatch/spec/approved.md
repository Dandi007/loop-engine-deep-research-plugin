# E1d —— content 锚点的判定必须取自**卡片自身**，而不是 worker 回传的任何字段

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E1c 的 `main`）
**⛔ 改动面极小：只换「哪个信号触发 content 锚点路径」，不重做 E1c 的任何机制。**

---

## 0　⛔ 地面真相（派发方真机取证，照抄，不得推测、不得由 fixture 反推）

### GT-1　⭐⭐⭐ `dr-worker-content` 在**四次真跑**里吐出了**四种互不相同**的字段布局

同一个 role、同类输入，派发方 2026-08-14 02:40–07:20 四次真机取证，逐字：

```
第一次（board:agent-runs seq 733）
  source   = "content"
  locator  = "web://http://127.0.0.1:50287/e1-material.png"
  revision = "63ac13ab…"（完整 64 位）
  range    = "L9"

第二次（seq 751）
  source   = "content"
  locator  = "63ac13abaabf5726.md"          ← spool 的本地文件名
  revision = "63ac13abaabf5726"             ← 截断成 16 位
  range    = "9"                            ← 无 L 前缀

第三次（E1b Z2，16 条证据）
  source   = "content"
  locator  = "http://127.0.0.1:50287/e1-material2.png"   ← 裸 URI
  revision = "9bee527f…"（完整 64 位）
  range    = "L3:1-43"                      ← 行:字符起-字符止

第四次（E1c Z2，10 条证据，run 27dd238b-1375-4b2d-acdf-8c2063e446f8）
  source   = "web://http://127.0.0.1:50287/e1-material4.png"   ← ⭐ 整个 URI 跑进了 source
  locator  = "L3"                                              ← ⭐ 行号跑进了 locator
  revision = "b9eba8944c549188e11213dc85c85f32b4900bd5d9230f0724c3d99a161fb04d"
  range    = "L3"
```

### GT-2　E1c 的闸门钉在 `source` 上，被第四种形态绕过

E1c 交付的 `src/harvest.ts` 逐字：

```ts
export function anchorForEvidence(
  item: WorkerEvidenceItem,
  authority?: ContentAnchorAuthority | null,
): string {
  const source = item.source;
  // E1c D1：闸门钉在 source 语义字段上（⛔ 不嗅探 locator 前缀）。
  if ((source ?? "").trim() === CONTENT_SOURCE) {
    if (!authority) { throw new Error("E1c D1: content evidence requires the dispatcher-side authority …"); }
    return contentAnchor(authority, item.range);
  }
  const locator = item.locator;
  const revision = item.revision;
  …
  return composeAnchor(source, locator, revision, item.range);
}
```

第四种形态的 `source` 不是 `"content"` ⇒ **不命中** ⇒ 落回通用模板
`${source}://${locator}@${revision}#${range}` ⇒ 真机上 10 条证据**全部**被发成（逐字）：

```
web://http://127.0.0.1:50287/e1-material4.png://L3@b9eba8944c549188e11213dc85c85f32b4900bd5d9230f0724c3d99a161fb04d#L3
web://http://127.0.0.1:50287/e1-material4.png://L7@b9eba894…#L7
web://http://127.0.0.1:50287/e1-material4.png://L9@b9eba894…#L9
…（10 条，scheme 分布 {'web': 10}，digest 全部是权威的 64 位值）
```

URI 段被污染成 `…e1-material4.png://L3`。

> 说明：digest 之所以是对的，是因为 clue text 里带着它、worker 照抄了一份——
> **这是巧合，不是保证**（第二次它就截断成了 16 位）。

### GT-3　⭐⭐ 由此得出的、本包要落实的**唯一正确原则**

**⛔ 任何由 worker 回传的字段（`source` / `locator` / `revision`）都不得参与闸门判定，
也不得作为锚点的数据源。**

调度器**自己就知道**这张卡是不是 content 卡：是它把一条 `sources:["content"]` 的 clue
经 triage → dispatch 派给 `dr-worker-content` 的，`authority`（uri + digest）也是它从
自己 propose 的 content-clue 与自己 spool 的 transcript 里拿到的。

⇒ **判定必须取自卡片自身（clue 的 `sources` / 该 harvest 卡的 authority 是否存在），
worker 只提供 `quote` 与 `range`。** 这才是宪法第十一条「闸门归代码，persona 只作纵深防御」。

⚠️ 本包是本线**第三次**修这同一处闸门（E1b 钉 `locator` 前缀 → 被绕过；
E1c 钉 `source` 字段 → 被绕过）。**再钉在任何 worker 可控的字段上都会被第五种形态绕过。**

---

## 1　交付清单

| # | 必须交付 | 关键约束 |
|---|---|---|
| **D1** | **content 锚点路径的触发信号改为卡片侧事实**：该 harvest 卡是 content 卡（其 clue 的 `sources` 含 `content` / 该卡持有 `ContentAnchorAuthority`）⇒ **一律**走 `contentAnchor(authority, range)` | ⛔ 判定不得读 `item.source` / `item.locator` / `item.revision`（GT-3）。⛔ `code://` 路径逐字不变 |
| **D2** | content 卡上，**worker 回传的 `source`/`locator`/`revision` 与权威值不一致时仍记入 `anchorMismatches`**（E1c 已有该机制，本包只需覆盖新的 `source` 维度） | ⛔ 不得因此拒发证据；⛔ 记录里不得回抄 quote 全文 |
| **D3** | **content 卡缺 `authority` ⇒ 响亮失败**（E1c 已有，⛔ 保留且判据要覆盖） | ⛔ 不得回退成用 worker 字段兜底 |
| **D4** | `range` 归一覆盖第四种形态（`"L3"`，已带 L 前缀 ⇒ 原样保留） | E1c 已交付归一逻辑，本包只需判据覆盖 |

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` **连跑两次都全绿**。
2. **⭐⭐⭐ D1 判别性（本包核心）**：设该 content 卡的权威值为
   `uri=http://127.0.0.1:50287/e1-material4.png`、
   `digest=b9eba8944c549188e11213dc85c85f32b4900bd5d9230f0724c3d99a161fb04d`。
   把 GT-1 那**四条逐字的真实 worker 回报**（含第四种：
   `source="web://http://127.0.0.1:50287/e1-material4.png"`、`locator="L3"`、`range="L3"`）
   分别喂进**生产收割路径**，**四条都必须**产出：

   ```
   web://http://127.0.0.1:50287/e1-material4.png@b9eba8944c549188e11213dc85c85f32b4900bd5d9230f0724c3d99a161fb04d#L3
   ```

   （前三条按各自的 range 归一后结尾分别为 `#L9`、`#L9`、`#L3:1-43`；uri 与 digest 段**四条完全相同**。）

   ⛔ 断言里出现 `.png://`、`content://`、`.md`、16 位截断 digest，任一即为方向钉反。
   把触发信号改回读 `item.source` ⇒ **第四条必须变红**。
3. **⭐ D2 判别性**：喂第四条 ⇒ 证据**照常发布**且 anchor 是权威形态，
   **同时** `anchorMismatches` 里有一条含 clue_id 与两侧值（⛔ 不含 quote 全文）；
   删掉该记录 ⇒ 变红。另配：喂一条三字段全与权威一致的 ⇒ **不产生** mismatch 记录。
4. **⭐ D3 判别性**：content 卡但 `authority` 缺失 ⇒ **响亮失败**；
   改成用 worker 字段兜底 ⇒ 变红。
5. **⭐ 回归**：`source="code"` 的 evidence ⇒ `code://src/dispatch.ts@efebe27#L1287` 逐字不变。
6. **⛔ 断言打在生产组装出的 deps 上**；⛔ 源码字符串匹配不构成证据；
   ⛔ 不得在测试里绕过装配链直接给 `anchorForEvidence` 传参——**必须驱动 `harvestCard`
   并检查 `publishEvidence` 实际收到的 anchor**。
7. **回归**：`main` 上已有的一切行为逐字不变（E0 回归基线全套、E2b 活 URL 条目级拒发不连坐、
   E1 权威 digest / 去重 / content-clue 幂等 / 失败粒度下沉 / 串行化 / maxClues、
   E1b spool 与 allowed_root、E1c 的 authority 机制 / anchorMismatches / range 归一 /
   D5 blocked 断言 / D6 spool 根进运行记录）。
8. **Z1（真机，派发方执行）**：`bash bin/e0-regression.sh` 仍退出 0、`prod_bus_guard_wrote=false`。
9. **⭐⭐ Z2（真机，派发方执行）**：真派一条 content clue ⇒ 发到证据 channel 上的 anchor
   **逐字**为 `web://<uri>@<64位digest>#<range>`，且 `<uri>` 段**不含任何** worker 拼进来的残渣。

> 判据 8–9 由派发方在真机上验证。⚠️ 本线前两次（E1b / E1c）都栽在判据 9 上，
> 每次都是 worker 换了一种字段布局。**D1 若仍读任何 worker 字段，第三次还会栽。**

## 3　⛔ 明确不做

| 不做 | 理由 |
|---|---|
| 重做 E1c 的 `ContentAnchorAuthority` / `contentAnchor` / `anchorMismatches` / range 归一 | 已交付且判据 7 要求逐字保住；本包只换触发信号 |
| 改 `agent-runtime` 的 persona 去「教 worker 填对字段」 | persona 只作纵深防御；GT-1 证明它不可靠。⛔ 本包不碰另一个仓 |
| anchor-check 认 `web://`（核验侧） | **E3** |
| 收工仲裁者 / 原子产物 / 驱动入口重写 | E5 / E4 / E7 |
| 注册 protocol / 建 channel | 不可逆，拍板级 |

## 4　评审口径

- **REJECT 只用于 blocker 级**：判定仍读 worker 字段、判据 2 的第四条不成立、
  判别性缺失或方向钉反、越出 §1 范围、改坏判据 7 的既有行为。
- ⚠️ 本线累计因「测试绕开被测对象」被驳回 10 次以上，且**本处闸门已被绕过两次**。
  **判据 2–5 的测试必须驱动 `harvestCard` 并检查实际发布出去的 anchor。**
- ⚠️ §0 的四组字段布局**都是真机跑出来的**，⛔ 不得改造它们去迁就实现。
- reviewer 只读，判据 1–7 由 acceptance 命令的执行结果作证。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`。
