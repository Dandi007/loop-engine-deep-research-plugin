# E1k2 —— 证据发布前的密钥形态扫描闸门（⛔ 高熵规则不得误伤合法摘要）

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`（base = `main`）
**⛔ 改动面小：只在既有拒发链路上加一道确定性扫描。**

> **⚠️ 本 spec 刻意不逐字写出任何凭证前缀字符串。**
> 上一版（`dev_dr_e1k_20260814_0930`）因 spec 正文里逐字写了这些形态，
> 触发 dev-dispatch 自己的 **`SECRET_SENTINEL_DETECTED`**，控制面无法发布 approved 产物、
> 连续失败 15 次卡死。**实现者请从下方的「规则清单（描述式）」推出正则，
> ⛔ 不要把凭证前缀原样抄进任何 markdown 交付说明里。**

---

## 0　⛔ 地面真相（派发方真机取证，照抄，不得推测）

### GT-1　这道闸门至今未交付

canonical spec §13.1 把它列为「E1 增补」，派发方写 E1 时把范围收窄到 ingest，漏了它。
`main` 上全 `src/` 无任何凭证形态扫描实现。

⇒ 证据正文可以带着凭证形态被发到**没有 DELETE 的 append-only bus** 上，不可撤回。

### GT-2　⭐⭐⭐ 上一版的致命缺陷：高熵规则**误伤合法摘要**，把整轮研究打成零证据

上一版交付后，派发方把**典型代码研究场景**的 quote 喂进它生产装配出的扫描器，逐字：

```
⛔拦截  代码里的 git sha 常量行           patterns=["high-entropy-string"]
⛔拦截  含 evidence_bundle_digest 的摘要行   patterns=["high-entropy-string"]
⛔拦截  lockfile 的 integrity 哈希行        patterns=["high-entropy-string"]
  放行  普通中文结论
  放行  普通英文代码行
```

真机后果（E0 回归基线复跑，`research:e0-dbd660737c8bd238.*`）逐字：

```
research:e0-dbd660737c8bd238.index     head_seq= 10
research:e0-dbd660737c8bd238.docs      head_seq= 4
research:e0-dbd660737c8bd238.evidence  head_seq= 0     ← ⛔ 零证据
```

板面在长（2→4→6→8→10）、doc 也在产，**唯独证据一条都发不出去**。
同一份代码的另一次跑发了 134 条证据——**只是那次轨迹碰巧没引到长 hex**，
所以这个缺陷是**间歇性的、看运气的**，更危险。

⇒ **本线研究的对象本身就是代码仓，引用带摘要的行极其常见。**
「≥40 字符连续 hex/base64」这条规则在这个语境下**默认命中合法内容**。

### GT-3　⛔ 派发方上一版 spec 的错（本包要纠正的）

上一版只要求排除「**锚点结构位**上的 digest / commit sha」，
**没有覆盖 `quote` 正文里出现的合法摘要**。实现照做了，判据也过了，
但真机上就是零证据。⇒ 判据必须按**真实语料**设计，不能只覆盖锚点。

### GT-4　可直接复用的既有机制（⛔ 不要另造一套）

`main` 的 `src/harvest.ts` 已有 E2b 交付的**条目级拒发 + 不连坐 + 不回抄 quote** 纪律
（`EvidenceRejection` / `webEvidenceRejectionReason`，活 URL evidence 那条闸门），
真机实证过：同卡两条被拒、其余照常发布、拒发记录只写形态与原因。

---

## 1　交付清单

| # | 必须交付 | 关键约束 |
|---|---|---|
| **D1** | **纯函数扫描器**：对给定字段文本返回命中的 pattern 名列表 | ⛔ 纯函数、无 IO、⛔ 不用模型判断（宪法第二条） |
| **D2** | **规则清单（描述式，实现者据此写正则）**：<br>① AWS access key id：四字母大写前缀 + 16 位大写字母数字<br>② GitHub personal access token：`ghp` 下划线前缀 + 36 位字母数字<br>③ Slack bot token：`xoxb` 短横前缀<br>④ PEM 私钥块起始行（`-----BEGIN … PRIVATE KEY-----` 形态）<br>⑤ 高熵串：≥40 字符连续 base64/hex，**且不属 D3 的豁免形态** | 五类都要有；pattern 名要能在记录里点名区分 |
| **D3** | ⭐⭐ **高熵规则的豁免：合法「内容摘要」形态一律不算命中** | 至少覆盖：<br>(a) **标准摘要长度的纯十六进制串**（md5/sha1/sha256/sha512 等常见长度，含 git 的 7–40 位短/全 sha）；<br>(b) 带**算法名前缀**的摘要值（`sha256:` / `sha512-` / `sha1-` 这类形态）；<br>(c) 上述形态出现在**任何字段的任何位置**——⛔ 不限于锚点结构位（GT-3 的教训）。<br>⛔ 不得整条删除高熵规则；⛔ 不得对某个字段整体豁免 |
| **D4** | **接进 `publishEvidence` 之前**：扫 evidence 的 `quote` / `claim` / `anchor` 三字段 | 命中 ⇒ 该条不发布；⛔ 整卡其余 evidence 与 clue **不连坐**（复用 GT-4 纪律） |
| **D5** | **拦截记录进运行记录**：含 `clue_id`、命中的 **pattern 名**、命中的**字段名** | ⛔ **不得含命中内容本身**、⛔ 不得回抄 `quote` 全文 |
| **D6** | 计数进 `HarvestReport`，与既有 `evidenceRejections` 同构或并列 | ⛔ 静默拦截即未交付。⛔ 一轮里出现拦截时，运行记录必须能解释「为何证据数少了」 |

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` **连跑两次都全绿**。
2. **⭐⭐⭐ D3 判别性（本包核心，上一版就栽在这）**：把下列**真实语料**配正常 anchor 喂进
   **生产收割路径**，⇒ **全部照常发布、零拦截**：
   - 一行源码，内容为把某个 40 位十六进制 git sha 赋给常量；
   - 一行 JSON，键名含 `digest`，值是带 `sha256:` 前缀的 64 位十六进制；
   - 一行 lockfile 片段，键名为 `integrity`，值是带 `sha512-` 前缀的 base64。
   把 D3 的豁免逻辑去掉 ⇒ 这三条**全部变红**（证明豁免真在起作用）。
3. **⭐⭐ D3 反向（豁免不得开成后门）**：把 ①②③④ 四类凭证形态**分别**塞进
   `quote` / `claim` / `anchor` 的**任意位置**（包括紧挨着一个合法摘要）⇒ **仍必须被拦下**
   并点名对应 pattern；把豁免放宽成「整字段豁免」⇒ 变红。
4. **⭐ 五类规则各一条正向用例**：①②③④⑤ 各自都能被拦下并点名对应 pattern。
   ⑤ 用一段**不属于 D3 豁免形态**的高熵串（例如非标准长度、且无算法名前缀）。
5. **⭐⭐ K1 判别性**：一张卡两条 evidence，其一含①形态 ⇒
   (a) 该条**不出现在证据 channel 上**；(b) **同卡另一条照常发布**；
   (c) 运行记录含拦截条目且含 pattern 名与字段名；
   (d) ⛔ 该记录**不含**命中的那个串本身、也不含 quote 全文。
6. **⭐ K2 回归**：不含任何凭证形态的正常 evidence，发布行为与 base **逐字不变**
   （条数、幂等键、预算消耗、发布顺序）。
7. **⛔ 断言打在生产组装出的 deps 上**：必须驱动 `harvestCard`，
   检查 `publishEvidence` **实际收到/未收到**哪些 evidence；
   ⛔ 不得只断言纯函数、⛔ 不得绕过装配链直接传参、⛔ 源码字符串匹配不构成证据。
8. **回归**：`main` 上已有的一切行为逐字不变（E0 回归基线全套、E2b 活 URL 条目级拒发不连坐、
   E1 权威 digest / 去重 / content-clue 幂等 / 失败粒度下沉 / 串行化 / maxClues、
   E1b spool 与 allowed_root、E1c/E1d 的锚点权威机制与 `anchorMismatches`）。
9. **⭐⭐ Z1（真机，派发方执行）**：`bash bin/e0-regression.sh` 退出 0、
   `prod_bus_guard_wrote=false`，**且证据 channel head_seq 明显大于 0**
   （⛔ 零证据即判不过——这正是上一版真机失败的形态）。

> 判据 9 由派发方在真机上验证。

## 3　⛔ 明确不做

| 不做 | 理由 |
|---|---|
| 用模型判断是否是凭证 | 宪法第二条：闸门必须确定性 |
| 改 persona 的自扫描纪律 | 保留作纵深防御；⛔ 本包不碰 agent-runtime 仓 |
| 对 clue / doc / transcript 也做扫描 | 本包只管 evidence 发布链路 |
| anchor-check 相关（核验侧） | E3 已合入 |
| 收工仲裁者 / 原子产物 / 驱动入口重写 | E5 / E4 / E7 |
| 注册 protocol / 建 channel | 不可逆，拍板级 |

## 4　评审口径

- **REJECT 只用于 blocker 级**：闸门可被绕过、拦截记录回抄了命中内容、
  **判据 2 不成立（高熵规则仍误伤合法摘要）**、判据 3 不成立（豁免开成后门）、
  连坐了同卡其余证据、判别性缺失或方向钉反、越出 §1 范围。
- ⚠️ 本线累计因「测试绕开被测对象」被驳回 10 次以上。**判据 2–6 的测试必须驱动 `harvestCard`。**
- ⚠️ **⛔ 交付说明（IMPLEMENTATION_SUMMARY 等 markdown）里不得逐字写出凭证前缀字符串**，
  否则会触发控制面的 secret sentinel 使本 development 卡死（上一版即因此报废）。
  代码与测试里当然可以有（那是被测对象本身）。
- reviewer 只读，判据 1–8 由 acceptance 命令的执行结果作证。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`。
