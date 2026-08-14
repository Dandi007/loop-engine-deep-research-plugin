# E1k —— 证据发布前的密钥形态扫描闸门（补交付：spec §13.1 的 K1/K2 从未落地）

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = 含 E1d 的 `main`，`fb524b9`）
**⛔ 改动面小：只在既有拒发链路上加一道确定性扫描。**

---

## 0　⛔ 地面真相（派发方 2026-08-14 09:2x 在 `origin/main` 上真机取证，照抄）

### GT-1　⭐ 这道闸门**从未交付**

canonical spec §13.1 明写它属于「E1 增补」，但派发方写 E1 的 spec 时把范围收窄到 ingest，
**漏了它**（派发方的责任，不是实现者的）。对 `origin/main` 全量核查，逐字：

```
$ for f in $(git ls-tree -r --name-only origin/main -- src | grep '\.ts$'); do
    n=$(git show origin/main:$f | grep -cE "AKIA|ghp_|xoxb-|BEGIN .* PRIVATE KEY"); [ "$n" -gt 0 ] && echo "$f: $n"; done
(无输出)
```

⇒ 证据正文可以带着任何形态的密钥被发到**没有 DELETE 的 append-only bus** 上，且不可撤回。

### GT-2　⭐ 可直接复用的既有机制（⛔ 不要另造一套）

`origin/main` 的 `src/harvest.ts` 逐字：

```
443:export function webEvidenceRejectionReason(item: WorkerEvidenceItem): string | null {
485:export interface EvidenceRejection {
490:  /** 拒发原因（与 webEvidenceRejectionReason 返回值一致，点名失败的判据）。 */
517: * ⛔ 不回抄 `quote` 全文（与 `EvidenceRejection` 同纪律：不把未经核验的内容再落一遍）。
```

E2b 已交付**条目级拒发 + 不连坐 + 不回抄 quote** 的完整纪律（活 URL evidence 那条闸门），
真机实证过：一张卡里两条被拒、同卡的 proposed_clue 照常发布、证据 channel head_seq 保持 0。

### GT-3　spec §13.1 的原文（照抄，本包的判据来源）

> - harvest 发布链路（`publishEvidence` 之前）加确定性扫描：对 evidence 的 quote / claim / anchor
>   字段跑密钥形态 regex 集——`AKIA[0-9A-Z]{16}`、`ghp_[A-Za-z0-9]{36}`、`xoxb-`、
>   `-----BEGIN .* PRIVATE KEY-----`、≥40 字符连续 base64/hex 高熵串。
> - 命中 ⇒ 该条 evidence **不发布**，标失败并写运行记录（宪法第四条现形；记录只含命中的
>   pattern 名与字段名，⛔ 不含命中内容本身——防止把密钥再抄进日志）。整卡其余 evidence
>   不连坐（与转写失败粒度下沉同构）。
> - 扫描器为纯函数 + 正反向单测；⛔ 不用模型判断（宪法第二条）。persona 的自扫描纪律保留作
>   纵深防御，但机械闸门才是判据（宪法第十一条：闸门归代码）。
> - 硬验收：**K1** ⭐ 判别性——预置一条 quote 含 `AKIA` 形态的 evidence ⇒ 不出现在 bus，
>   运行记录含拦截条目。**K2** 回归——正常 evidence 发布行为逐字不变。

### GT-4　⛔ 高熵串那条的现实陷阱（派发方实测，务必处理）

本线的**合法** anchor 里天然含有 **64 位十六进制 sha256**，逐字实例：

```
web://http://127.0.0.1:50287/e1-material5.png@fc246f0aff9b5c82971135989a5ff0f770210c488466534d16b6220652c1cb9b#L1
code://src/dispatch.ts@efebe270bf1e1fe88af4b9d47fc155ed068645ab#L1287
```

「≥40 字符连续 hex」这条规则会**命中每一条合法证据**，把整条链路判死。
⇒ 高熵规则**必须**排除掉「作为 anchor 的 digest / commit sha 出现在其结构位置上」的情形。
⛔ 不得因此把高熵规则整条删掉（那是把闸门砍了）；也⛔ 不得简单地对 `anchor` 字段整体豁免
（真密钥若被塞进 anchor 的 locator 段同样要拦）。

---

## 1　交付清单

| # | 必须交付 | 关键约束 |
|---|---|---|
| **D1** | **纯函数扫描器**：对给定字段文本返回命中的 pattern 名列表（无命中则空） | ⛔ 纯函数、无 IO、⛔ 不用模型判断（宪法第二条）。规则集至少含 GT-3 列出的五类 |
| **D2** | **接进 `publishEvidence` 之前**：对 evidence 的 `quote` / `claim` / `anchor` 三个字段扫描 | 命中 ⇒ **该条不发布**；⛔ 整卡其余 evidence 与 clue **不连坐**（复用 GT-2 的既有纪律） |
| **D3** | **拦截记录进运行记录**：含 `clue_id`、命中的 **pattern 名**、命中的**字段名** | ⛔ **不得含命中内容本身**，⛔ 不得回抄 `quote` 全文（GT-3 / GT-2 同纪律） |
| **D4** | **高熵规则不得误伤合法 anchor**（GT-4） | 排除「结构位置上的 digest / commit sha」；⛔ 不得整条删除高熵规则，⛔ 不得对 `anchor` 字段整体豁免 |
| **D5** | 计数进 `HarvestReport`，与既有 `evidenceRejections` 同构或并列 | ⛔ 静默拦截即未交付 |

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` **连跑两次都全绿**。
2. **⭐⭐ K1 判别性**：一张卡两条 evidence，其一 `quote` 含 `AKIA` 形态
   （如 `AKIAIOSFODNN7EXAMPLE`）⇒
   (a) 该条**不出现在证据 channel 上**；(b) **同卡另一条照常发布**；
   (c) 运行记录含拦截条目且含 pattern 名与字段名；
   (d) ⛔ 该记录**不含** `AKIA…` 这个串本身、也不含 quote 全文。
   把扫描删掉 ⇒ (a) 变红；把记录改成回抄命中内容 ⇒ (d) 变红。
3. **⭐ 五类规则各一条正向用例**：`AKIA[0-9A-Z]{16}` / `ghp_[A-Za-z0-9]{36}` / `xoxb-` /
   `-----BEGIN RSA PRIVATE KEY-----` / ≥40 字符高熵串，**各自**都能被拦下并点名对应 pattern。
4. **⭐⭐ D4 判别性（本包最容易做歪的一条）**：把 GT-4 那两条**逐字的**合法 anchor
   （`web://…@fc246f0aff9b5c82971135989a5ff0f770210c488466534d16b6220652c1cb9b#L1` 与
   `code://src/dispatch.ts@efebe270bf1e1fe88af4b9d47fc155ed068645ab#L1287`）
   配正常 quote/claim 喂进发布路径 ⇒ **必须照常发布、零拦截**；
   把高熵规则的排除逻辑去掉 ⇒ 该用例**变红**（证明排除是真起作用的，不是摆设）。
   **反向**：把一个 `ghp_` 真形态塞进 anchor 的 locator 段 ⇒ **仍要被拦下**
   （⛔ 证明不是对 anchor 字段整体豁免）。
5. **⭐ K2 回归**：不含任何密钥形态的正常 evidence，发布行为与 base **逐字不变**
   （条数、幂等键 `dr-evidence:<run_id>:<index>`、预算消耗、发布顺序）。
6. **⛔ 断言打在生产组装出的 deps 上**：必须驱动 `harvestCard`，
   检查 `publishEvidence` **实际收到/未收到**哪些 evidence；
   ⛔ 不得只断言纯函数、⛔ 不得绕过装配链直接传参、⛔ 源码字符串匹配不构成证据。
7. **回归**：`main` 上已有的一切行为逐字不变（E0 回归基线全套、E2b 活 URL 条目级拒发不连坐、
   E1 权威 digest / 去重 / content-clue 幂等 / 失败粒度下沉 / 串行化 / maxClues、
   E1b spool 与 allowed_root、E1c/E1d 的锚点权威机制与 `anchorMismatches`）。
8. **Z1（真机，派发方执行）**：`bash bin/e0-regression.sh` 仍退出 0、`prod_bus_guard_wrote=false`，
   且**证据照常发布**（⛔ 本包不得把正常链路误伤成零证据）。

> 判据 8 由派发方在真机上验证。

## 3　⛔ 明确不做

| 不做 | 理由 |
|---|---|
| 用模型判断是否是密钥 | 宪法第二条：闸门必须确定性 |
| 改 persona 的自扫描纪律 | 保留作纵深防御，但机械闸门才是判据；⛔ 本包不碰 agent-runtime 仓 |
| 对 clue / doc / transcript 也做扫描 | 本包只管 evidence 发布链路（spec §13.1 的范围）；扩面另议 |
| anchor-check 认 `web://`（核验侧） | **E3**（并行包，katana 仓） |
| 收工仲裁者 / 原子产物 / 驱动入口重写 | E5 / E4 / E7 |
| 注册 protocol / 建 channel | 不可逆，拍板级 |

## 4　评审口径

- **REJECT 只用于 blocker 级**：闸门可被绕过、拦截记录回抄了命中内容、判据 4 不成立
  （高熵规则误伤合法 anchor，或对 anchor 整体豁免）、连坐了同卡其余证据、
  判别性缺失或方向钉反、越出 §1 范围。
- ⚠️ 本线累计因「测试绕开被测对象」被驳回 10 次以上。**判据 2–5 的测试必须驱动 `harvestCard`。**
- ⚠️ §0 的 anchor 样本**都是真机跑出来的**，⛔ 不得改造它们去迁就实现。
- reviewer 只读，判据 1–7 由 acceptance 命令的执行结果作证。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`。
