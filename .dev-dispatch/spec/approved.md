# E1 —— ingest 接进 tick：权威 digest + 转写 + 自动 propose content-clue（交付清单式）

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E2b 的 `main`，`51f598c`）

> **本 spec 的写法**：每条都写成「**必须交付**」并自带验收判据。
> ⛔ 不用「不得回退 / 必须原样保留」措辞——凡不在 base 上的东西，说「保留」等于什么都没要求。

---

## 0　⛔ 地面真相（派发方 2026-08-14 在 base `51f598c` 上真机取证，照抄，不得推测、不得由 fixture 反推）

### GT-1　`src/ingest.ts` 有 230 行实现 + 23 个测试，但**生产侧零调用者**

```
$ grep -rn "fetchMaterial\|IngestDeps\|transcribeBatch\|transcribeMaterial" src test
src/ingest.ts:45:export interface IngestDeps {
src/ingest.ts:49:  fetchMaterial(uri: string): Promise<FetchedMaterial>;
src/ingest.ts:190:export async function transcribeMaterial(
src/ingest.ts:224:export async function transcribeBatch(
test/ingest.test.ts:…            ← 唯一消费者是测试
```

全仓引用 `./ingest` 的生产文件只有 `src/mineru.ts`，且只取两个纯函数
（`classifyExtension` / `stripExtension`）。**转写链路从未被任何 tick 路径调用过。**

### GT-2　harvest 明写「materials 不发布」

`src/harvest.ts:375` 逐字：

```ts
  // materials 是 worker 的输入/产出清单，本收割步只读取校验形状，不发布（§1）。
```

### GT-3　⭐ 现行 digest 语义：**拿 worker 上报的 digest 当去重键，先查后取，从不重算**

`src/ingest.ts:195-213` 逐字：

```ts
  const existing = await deps.readExistingTranscript(input.digest);   // ← 用的是 worker 报的值
  if (existing) {
    return existing;
  }
  try {
    const material = await deps.fetchMaterial(input.uri);
    assertWithinSizeLimit(material.bytes.byteLength);
    classifyExtension(material.filename);
    const mdContent = await serialize(() =>
      deps.transcribe(material.filename, material.bytes),
    );
    const doc: DocV2 = {
      doc_kind: "transcript",
      digest: input.digest,                                            // ← 发布的也是 worker 报的值
      body: mdContent,
      origin: input.uri,
    };
```

### GT-4　现行失败粒度：转写失败 ⇒ **把父 clue 标 blocked** 并整体抛错

`src/ingest.ts:214-217` 逐字：

```ts
  } catch (err) {
    await deps.markBlocked(input.clueId);      // input.clueId = 归属的父 clue
    throw err;
```

### GT-5　E2b 已把 `dr-worker-content` 接上，但**没有任何东西会生产 content-clue**

base 上 `src/tick-run.ts:190` 有 `export const CONTENT_ROLE = "dr-worker-content"`，
`SOURCE_TO_ROLE` 有 `"content" → "dr-worker-content"`，需要 `allowed_root` 的守卫也在。
但全仓**没有一处发布 `sources:["content"]` 的 clue** ⇒ 这条 role 目前**结构上永远派不到**。

### GT-6　⭐⭐ MinerU：**CPU 端点活着，GPU 端点挂了**

派发方 2026-08-14 00:56–00:57 真机探测，逐字：

```
# CPU 127.0.0.1:8090 —— 真 PNG（/data/vault/spec-review-h1-current.png）
POST /file_parse  files=@… backend=pipeline return_md=true
{"task_id":"1aa7e3f0-…","status":"completed","backend":"pipeline",
 "file_names":["spec-review-h1-current"],"version":"3.1.6",
 "results":{"spec-review-…                       ← 契约与 mineru.ts 逐字吻合

# CPU 对坏字节的响亮失败（非静默降级）
{"status":"failed","error":"Failed to load file probe.png: cannot identify image file …"}

# GPU 172.22.62.133:8090
curl -m 20 http://172.22.62.133:8090/docs          → HTTP/1.1 502 Bad Gateway（经本机代理 7897）
curl -m 25 --noproxy '*' …                          → exit 52 Empty reply from server，code 000
（TCP 连得上，但服务不应答）
```

`src/mineru.ts:20-22` 的硬路由是「图片 → CPU，其余（pdf/office）→ GPU」。
⇒ **本包一切真机验证只能走图片（CPU）路径**；pdf/office 路径在这台机器上此刻不可用。
⛔ 这是环境事实，**不是**改 `mineru.ts` 路由的理由（§3 明确不做）。
⚠️ Node 的 `fetch`（undici）默认不读 `http_proxy`，所以插件里走 GPU 会直接空回，
不会像 curl 那样被代理接管——这条差异不要搞混。

### GT-7　测试总线已就位（派发方已建，⛔ 实现者不得在代码里自动建 channel / 注册协议）

```
http://127.0.0.1:7495   research:content  head_seq=0   ← 派发方 2026-08-14 00:58 新建
protocols（14 个）含 research.doc.v2 / research.clue.v2 / research.evidence.v2 / worker.result.v1
```

---

## 1　交付清单（⛔ 全部都要真的存在于本次交付里）

| # | 必须交付 | 关键约束 |
|---|---|---|
| **D1** | **权威 digest**：ingest 对**取回的字节**算 sha256，作为唯一去重键与发布键 | ⛔ 不得再拿 worker 上报的 `digest` 当键（GT-3）。顺序必须变成「**先 fetch，后算，再查重**」；worker 报的 `digest` 降级为可选提示，**可以完全忽略** |
| **D2** | **全局去重**：算出的 digest 命中 `research:content` 上已有 `doc(transcript)` ⇒ **复用，不打 MinerU** | 省掉的是贵的那步（MinerU）；同 URI 第二次仍要 fetch 一次是**显式接受的代价** |
| **D3** | **接线**：harvest 收割一张卡时，对该卡 worker 结果里的**每条 material** 调 ingest | 取代 GT-2 那句「只读取校验形状，不发布」。⛔ `materials` 为空数组 ⇒ 行为与 base 逐字一致（不调 ingest、不改板面、不多写一次 bus） |
| **D4** | **回路闭合**：转写成功（含 D2 的复用路径以外的新转写）⇒ 自动 propose 一条 content-clue | 载荷必须是：`sources:["content"]`、`parent` = 原 clue id、`depth` = **parent 的 depth（⛔ 不 +1）**、`text` 携带 transcript 的 digest 与 origin URI、`status:"proposed"` |
| **D5** | **content-clue 幂等**：走 D2 复用路径（digest 已存在）时 ⇒ **不重复 propose** | ⛔ 同一块板上同一 digest 只应出现一条 content-clue |
| **D6** | **失败粒度下沉到 material**：转写/取材失败 ⇒ **该 material 的 content-clue 出生即 `blocked` 落板**（`rationale` 含 MinerU/取材错误详情） | ⛔ **父 clue 不连坐**：照常 `explored`，其已收割 evidence 照常发布（取代 GT-4 的 `markBlocked(父 clueId)` + 整体抛错）。⛔ 不得为此放宽 `CLUE_TRANSITIONS`（`proposed → blocked` 不在表里；这里是**首条消息直接以 blocked 落板**，不是状态迁移） |
| **D7** | **串行化**：N 条 material 同时到达，任一时刻在飞 MinerU 调用 = 1 | 复用 base 已有的 `createMutex` 语义，⛔ 不另写一份 |
| **D8** | **生产侧 `fetchMaterial` 实现**（base 上只有接口，无实现，GT-1） | http(s) 下载；4MB 护栏用 base 已有的 `assertWithinSizeLimit`；⛔ 失败必须响亮（不得取回空字节当成功） |
| **D9** | **`maxClues` 封顶对 content-clue 同样生效** | content-clue 也是 clue，必须走同一个 `boardClueCount.value` 实时累加；⛔ 不得开后门绕过封顶 |

---

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` **连跑两次都全绿**（抖动一次即视为未交付）。
   ⚠️ `tsconfig` 的 include 含 `test`，测试文件同样要过 strict 检查。
2. **⭐⭐ D1 判别性**：桩 fetch 返回一段已知字节，worker 上报的 `digest` **故意填成一个不同的假值** ⇒
   发布出去的 `doc.digest` **等于对那段字节算的 sha256**、⛔ 不等于 worker 报的假值；
   把键改回 `input.digest` ⇒ 该测试变红。
3. **⭐⭐ D2 判别性（GPU 成本护城河）**：同一段字节第二次出现、**且两次上报的 digest 不同** ⇒
   `transcribe` 桩的调用计数 **=== 0**（第二次），并复用已有 doc；
   把查重改回用上报值 ⇒ 该测试变红（因为假 digest 查不中）。
4. **⭐ D3 判别性**：一条 material ⇒ ingest 被调用一次、`research:content` 上出现对应
   `doc(transcript)`（`doc_kind==="transcript"`、`origin` = 源 URI）。
   另配回归一条：`materials: []` ⇒ ingest **零调用**、bus 写入次数与 base 逐字一致。
5. **⭐⭐ D6 判别性（本包最容易做歪的一条）**：桩 transcribe 抛错 ⇒
   (a) 板上出现该 material 的 content-clue，`status==="blocked"`，`rationale` 含错误详情；
   (b) **父 clue 仍走到 `explored`**；(c) 该卡**已收割的 evidence 照常发布**。
   把处理改回 `markBlocked(父 clueId)` + 整体抛错 ⇒ 三条断言中至少一条变红。
6. **⭐ D4 判别性**：转写成功 ⇒ propose 的 clue 载荷逐字满足
   `sources:["content"]` / `parent`=原 clue / `depth`===parent.depth / `text` 同时含 digest 与 URI；
   把 `depth` 改成 `parent.depth + 1` ⇒ 变红。
7. **⭐ D5**：同 digest 第二次 ⇒ content-clue 发布次数为 0（板上仍只有一条）。
8. **⭐ D7**：N 条 material 并发提交 ⇒ 用桩记录「进入/离开 transcribe」的重叠，断言峰值并发 === 1。
9. **⭐ D9**：`boardClueCount` 已顶到 `maxClues` ⇒ content-clue **不得**被发布出去，
   且该情形有可观测的报告（与既有 clue 封顶同构）；把封顶判定绕过 ⇒ 变红。
10. **⛔ 断言打在生产组装出的 deps 上**（照仓内既有 G5/G10/G13 做法）；
    ⛔ **源码字符串匹配 / 读文件文本比对不构成证据**；
    ⛔ 不得在测试里绕过装配链直接给内层函数传参。
11. **回归**：`main` 上已有的一切行为逐字不变（E0 回归基线全套：跨 drain 循环与退避、GT-6 三分类、
    终态取真值、续投门、失败轮回显、进度行与板面构成、per-run 板、种子带 sources、
    head_seq 只从列表端点取、按 run 身份判定的生产总线守卫、运行记录归档、
    `TRIAGE_THRESHOLD`/`MAX_CLUES` 可配且真接线、`node_timeout`/`wall_clock`=1810、
    「run 退出无 result ⇒ 记录并继续」、假 bus 端口由内核分配；
    E2b 全套：两条新 role 映射、四条既有映射、`INVALID_SOURCES_RATIONALE` 与
    `UNMAPPED_SOURCE_RATIONALE` 两条判定、活 URL evidence 条目级拒发不连坐）。
12. **回归**：`code://` 路径的 evidence 发布行为逐字不变。
13. **Z1（真机，派发方执行）**：`bash bin/e0-regression.sh` 仍在 profile 声明预算内跑到非 null 终态、
    **退出 0**，且本次运行没往生产总线写（`prod_bus_guard_wrote=false`）。
14. **Z2（真机，派发方执行）**：拿一份**图片**材料（GT-6：本机只有 CPU 路径可用）真打 MinerU ⇒
    `research:content`（测试总线 7495）上出现 `doc(transcript)`，其 `digest` 与派发方对同一字节
    独立算出的 sha256 **逐字相等**，且板上出现对应的 content-clue。

> 判据 13–14 由派发方在真机上验证。

## 3　⛔ 明确不做

| 不做 | 理由 |
|---|---|
| **transcript spool 成本地文件 + 派 `dr-worker-content` 真跑** | **拆到 E1b**（本包只负责把 content-clue 生产出来落板；派发与 spool 下一包做）。本包不因此被判「回路没闭合」 |
| 改 `src/mineru.ts` 的任何既有语义（4MB 护栏、扩展名硬路由、串行化、同步 `/file_parse`） | GT-6 的 GPU 不可用是环境问题，⛔ 不得改路由绕过 |
| anchor scheme 扩到 `web://`（核验侧） | E3 |
| 收工仲裁者 / 原子产物 / 驱动入口重写进 TS | E5 / E4 / E7 |
| 注册任何新 protocol / message kind、建任何 channel | 协议注册不可逆，是拍板级动作；测试总线的 channel 派发方已建（GT-7） |
| `recipes/*` 工具白名单、生产 profile `agent-harness.env` | 已拍板豁免 |
| 改 agent-runtime 仓 | 本包只动 plugin 仓 |

## 4　运行环境前提（派发方已就位）

- 测试总线 `http://127.0.0.1:7495`（独立 SQLite，与生产 7490 零共享）：协议 14 个齐全、
  三个 agent 已注册、token 落 `/data/agent-bus-test/tokens/`、`board:agent-runs` 与
  **`research:content`（head_seq=0）** 已建。
- MinerU：**只有 CPU `127.0.0.1:8090` 可用**（version 3.1.6，实测 completed）；
  GPU `172.22.62.133:8090` 此刻不应答（GT-6）。
- ⚠️ 生产总线 `127.0.0.1:7490` 始终有其它开发线在写，⛔ 不得假设它安静，⛔ 一个字节不许写。

## 5　评审口径

- **REJECT 只用于 blocker 级**：交付清单缺项、判据不成立、判别性缺失或方向钉反、
  自造契约 / 编造实测数字、越出 §1 范围、改坏 §2.11–12 列出的既有行为。
  文风与偏好写成 non-blocking 建议。
- ⚠️ 本线累计因「测试绕开被测对象」被驳回 **10 次以上**（读脚本文本比字节偏移、把 fetch/spawn 全 mock
  到亚毫秒、只 new 一个异常再自己 catch、只断言纯谓词、在测试里绕过装配链直接传参、
  引用一个别的指标冒充实测数字……）。**判据 2–9 的测试必须真正驱动被测对象。**
- ⚠️ 特别核对 D6：失败粒度是否**真的下沉到 material**（父 clue 不连坐、evidence 不作废），
  以及有没有**顺手放宽 `CLUE_TRANSITIONS`**。
- reviewer 只读，判据 1–12 由 acceptance 命令的执行结果作证。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`。
