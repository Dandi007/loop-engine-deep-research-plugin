# E2b —— 接线两个新 worker + 收掉 source token 不一致 + 活 URL 证据机械拒发

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`
**前序**：E2a 已合入 `agent-runtime` main（`32b20a1`）——`dr-worker-web`、`dr-worker-content`
两个 role 与 `sonnet-5/native-ronny` 路由**已经存在且真机验证可用**。
本包是调度器侧的接线：让这两个 role 真的被派得到。

---

## 0　这个包要解决什么

`src/tick.ts` 现状（`main`）：

```ts
SOURCE_ENUM   = ["code-local","code-remote","wiki","feishu","web-search"]
SOURCE_TO_ROLE= { code-local, code-remote, wiki, feishu }          ← 无 web、无 content
WEB_SOURCE    = "web"                                              ← 与枚举里的 "web-search" 对不上
isWebSource(s)= s.includes("web")                                  ← 查的是 "web"
```

后果两条：

1. **两个新 role 派不到**：`sources: ["web-search"]` 的线索无 role 可映射 ⇒ 走 blocked。
   研究在结构上仍然出不了本地仓库。
2. **报错指错原因**（spec.md §4.4）：真来一条 `web-search` 线索，命中的是
   `UNMAPPED_SOURCE_RATIONALE`（"no mapped worker role"）而不是 `WEB_BLOCK_RATIONALE`
   （"dr-worker-web not implemented"）——因为 `WEB_SOURCE` 是 `"web"`，枚举里却是 `"web-search"`。
   这条不一致在接入 web 时必须一并收掉。

第三件事来自真机实测（见 §3）：**web worker 会把活 URL 当证据出处交差**，必须在发布路径上机械拦住。

## 1　交付内容

### 1.1 接线两个新 role

- `SOURCE_ENUM` 增加 `"content"`（`"web-search"` 已在枚举内，不动）。
- `SOURCE_TO_ROLE` 增加两条映射：
  `"web-search" → "dr-worker-web"`、`"content" → "dr-worker-content"`。
- ⛔ 既有四条映射逐字不变。

### 1.2 统一 source token，删掉已失效的死路径

- `WEB_SOURCE` / `isWebSource()` / `WEB_BLOCK_RATIONALE` 这套「web 无 role 所以 blocked」的判定，
  在 `dr-worker-web` 接上之后**已经失效**：web 线索现在有 role、应当被正常派发。
  ⇒ **删除该死路径**，⛔ 不要留一个永远不会命中的分支。
- 统一到 `"web-search"` 一个 token：仓内不得再有 `"web"` 这个裸 token 参与 source 判定。
- ⛔ `INVALID_SOURCES_RATIONALE`（枚举外）与 `UNMAPPED_SOURCE_RATIONALE`（枚举内无 role）
  两条路径**必须保留且行为不变**——新增 role 不等于放宽这两道判定。

### 1.3 ⭐ 活 URL 证据机械拒发（本包最重要的一条）

**真机实证（派发方 2026-08-12，E2a 验收时）**：`dr-worker-web` 实跑返回的结果里，
`materials` 填对了（URI 正确、digest 如实留空），**但它同时吐了一条 evidence**：

```json
{ "source": "web", "locator": "https://ziglang.org/download/", "revision": "",
  "digest": "", "quote": "0.16.0 — 2026-04-13", "claim": "…" }
```

即：**引文直接摘自实时页面，出处是一个活 URL，没有任何可回查的快照**。
E2a 的 persona 里白纸黑字写了「只报材料、不搬正文」，模型照样越界。
按宪法第十一条（闸门归代码，persona 只作纵深防御），这道闸必须机械化在发布路径上。

**要求**：在 evidence 发布链路（`src/harvest.ts` 的 anchor 组装 / 发布前校验处）加确定性校验：

- `source` 为 web 类时，`revision` 必须是**内容指纹形态**（十六进制、长度符合 sha256 语义）；
  ⛔ 空串、日期、URL、"latest" 一类一律拒发。
- `locator` ⛔ 不得是裸 `http://` / `https://` URL 而 `revision` 为空的组合
  （那正是"直接引用活页面"的形状）。
- 命中 ⇒ **该条 evidence 不发布**，并把拒发原因写进运行记录（点名 clue_id 与失败的判据）；
  ⛔ 整张卡的其余 evidence 不连坐（与既有的失败粒度纪律同构）。
- ⛔ 拒发记录里不得回抄 quote 全文（避免把未经核验的内容再落一遍）。

> 说明：现有 `anchorForEvidence` 已经会对 `revision` 为空抛错，但那是**整卡抛错**、
> 且只挡住"空"这一种形状。本条要的是**条目级、按形态**的拒发。

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` 全绿。
2. **W1 ⭐ 判别性**：`sources: ["web-search"]` 的 clue ⇒ 派给 `dr-worker-web`，**不再走 blocked 分支**。
   把该映射删掉 ⇒ 测试变红。
3. **W7 ⭐ 判别性**：`sources: ["content"]` 的 clue ⇒ 派给 `dr-worker-content`，
   且 spawn 参数里带 `allowed_root`（content worker 要读 spool 文件）。
4. **W5 回归 ⛔**：枚举外的 source 仍走 blocked 且 rationale 为 `INVALID_SOURCES_RATIONALE`；
   枚举内但无映射 role 的 source 仍走 blocked 且 rationale 为 `UNMAPPED_SOURCE_RATIONALE`。
   ⛔ 新增 role 不得放宽这两条。
5. **W6 回归 ⛔**：既有四个 worker 的映射与派发行为逐字不变。
6. **§1.2**：仓内不再存在 `WEB_SOURCE` / `isWebSource` / `WEB_BLOCK_RATIONALE` 这套死路径，
   且不再有裸 `"web"` token 参与 source 判定。
7. **⭐ 判别性（§1.3，本包核心）**：构造一条 `source=web`、`locator` 为 `https://…`、
   `revision` 为空（或为非指纹形态字符串）的 worker evidence ⇒
   **该条不出现在 bus 上**，运行记录含拒发条目；**同一张卡里另一条合规 evidence 照常发布**。
   把这道校验删掉 ⇒ 测试必须变红。
8. **回归**：`code://` 路径的 evidence 发布行为逐字不变。
9. **真机（派发方执行）**：一条 `sources:["web-search"]` 的线索被真实派给 `dr-worker-web`
   并产生 `agent.run.exited` 痕迹；其回报的活 URL evidence 被拒发且运行记录可指认。

## 3　⛔ 明确不做

| 不做 | 理由 |
|---|---|
| ingest / MinerU / 转写 / digest 权威计算 | E1 的范围；本包只拒发不合规 evidence，不负责生产合规的 |
| 校验 `web://` 的 digest 是否真的存在于 `research:content` | E3（锚点核验）的范围；本包只查**形态**，不查存在性 |
| 扩 anchor-check 的 scheme | E3 |
| 改 agent-runtime 的 role / route / persona | E2a 已合入，本包不碰另一个仓 |
| 收工仲裁者、原子产物、入口重写 | E5 / E4 / E7 |
| 注册任何新的 protocol / message kind | 协议注册不可逆，需另行拍板 |
| 动 `bin/e0-regression.sh` 与 E0/E0b 的交付物 | 并行包，避免撞车 |

## 4　评审口径

- **REJECT 只用于 blocker 级**：判据不成立、判别性缺失、放宽了 W5/W6 的既有判定、
  §1.3 的闸门可被绕过、越出 §1 范围的改动。文风与偏好写成 non-blocking 建议。
- ⚠️ 特别核对：§1.3 的校验是否**条目级**（一条不合规不得连坐整卡），
  以及删除死路径时**有没有顺手放宽** `UNMAPPED_SOURCE_RATIONALE` 那条判定。
- reviewer 只读，判据 1–8 由 acceptance 命令的执行结果作证，⛔ 不要求 reviewer 执行 shell。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`（引擎保留路径，写入即永久 wedge）。
