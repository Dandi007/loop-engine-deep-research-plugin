# E1k2 —— 证据发布前的凭证形态扫描闸门

> ⚠️ **本文刻意不逐字写出任何凭证前缀字符串。** 本 development 的上一版
> （`dev_dr_e1k_20260814_0930`）就是因为在交付文本里逐字写出这些形态，触发了控制面的
> secret sentinel，导致 approved 产物发不出去、连续失败 15 次卡死报废。
> 规则的**描述式**清单见下；可执行的权威定义在 `src/secret-scan.ts` 的 `LITERAL_RULES`
> 与 `HIGH_ENTROPY_RUN_SOURCE`（代码与测试里当然可以有——那是被测对象本身）。

## 交付了什么

| # | 交付 | 落点 |
|---|---|---|
| D1 | 纯函数扫描器：给字段文本 ⇒ 命中的 pattern 名列表（⛔ 无 IO、⛔ 不用模型判断） | `src/secret-scan.ts` `scanSecretPatterns` |
| D2 | 五类规则（云访问密钥 id / 代码托管个人访问令牌 / 聊天机器人令牌 / PEM 私钥块起始行 / 高熵串），各有可点名的 pattern 名 | 同上 `LITERAL_RULES` + `highEntropyRuns` |
| D3 | ⭐⭐ 高熵规则对**合法内容摘要形态**豁免 | 同上 `isExemptDigestShape` |
| D4 | 接进 `publishEvidence` **之前**，扫 `quote` / `claim` / `anchor` 三字段 | `src/harvest.ts` `harvestCard`（两条发布路径各一道，同一道闸） |
| D5 | 拦截记录含 `clue_id` / pattern 名 / 字段名，⛔ 不含命中内容、⛔ 不回抄 `quote` | `SecretPatternRejection` |
| D6 | 计数进 `HarvestReport`，与既有 `evidenceRejections` 并列同构 | `HarvestReport.secretRejections` |

## ⭐⭐⭐ 本包的全部难点：高熵规则不得误伤合法摘要

上一版把「≥40 字符连续 hex/base64」当成**无条件**命中。**本线研究的对象本身就是代码仓**，
引用带摘要的行极其常见，于是真机上代码里的 git sha 常量行、含 `evidence_bundle_digest`
的摘要行、lockfile 的 `integrity` 哈希行**全部被拦**，板面在长（index 10 / docs 4）而
证据 channel `head_seq` 停在 **0**——整轮零证据。同一份代码另一次跑发了 134 条证据
（那次轨迹碰巧没引到长 hex），所以这个缺陷是**间歇性的、看运气的**，比稳定失败更危险。

⇒ 高熵规则**保留**（⛔ 不得整条删除），但对内容摘要形态豁免：

- **(a) 裸摘要**：纯十六进制且长度落在标准摘要长度（md5/sha1/sha224/sha256/sha384/sha512）
  或 git 短/全 sha 的 7–40 区间。
- **(b) 带算法名前缀的摘要值**：形如「算法名 + 分隔符 + 编码值」。
  ⛔ **不是「见到算法名前缀就放行」**——还要求编码值长度**恰好**等于该算法摘要字节数的
  hex/base64 编码长度。否则豁免就是一条可直接利用的后门：把任意长串挂在一个算法名
  后面即可绕过（spec 判据 3）。
- **(c) 与位置无关**：判定落在每一个候选串与它的左邻上，**不看字段名、不看字段内位置**。
  上一版只豁免「锚点结构位」上的 digest，真机上 `quote` 正文里的合法摘要照样被拦（GT-3）。

⛔ 豁免**只对高熵规则生效**。前四类字面形态在任何字段、任何位置都照拦不误，
包括紧挨着一个合法摘要的位置。

### 为什么候选串的字符集不含短横与下划线

高熵候选串的字符集是 base64 标准字母表与 hex 的并集，**刻意排除** `-` 与 `_`：
这两个字符正是「算法名前缀 / 令牌前缀」与「值」之间的分隔符。排除之后，候选串恰好是
**待判定的那个值本身**，前缀留在左邻文本里供 (b) 检查；顺带也让带下划线/短横前缀的
两类令牌只命中它们自己的规则，pattern 名不会互相污染。

## 拦截记录为什么只记形态

证据 channel 是 append-only、没有 DELETE，发出去不可撤回——这正是本闸门存在的理由。
如果拦截记录回抄命中的串或 `quote` 全文，就等于把凭证从证据 channel 搬进运行记录，
两边都是留痕介质，闸门等于没做。故 `SecretPatternRejection` 只有
`clueId` / `index` / 固定 `reason` / `hits`（字段名 + pattern 名）/ `fields` / `patterns`。
这与 E2b 的 `EvidenceRejection`「不回抄 quote」是同一条纪律。

## 失败粒度：条目级，不连坐

命中 ⇒ 该条 evidence 不发布（`continue`），同卡其余 evidence 与 clue 照常发布，
整卡照常 CAS 到 `explored`。复用 E2b 交付、真机实证过的条目级拒发纪律。
闸门不额外消耗写预算（被拦的条目走 `continue`，不 `consume`）。

## 判别性怎么钉的

`test/e1k2-secret-scan.test.ts` 的判据 2–6 全部驱动**生产收割路径**
（`harvestCard` / `runWrite` / `runChannelWrite`），断言 `publishEvidence`
**实际收到 / 未收到**哪些 evidence——⛔ 不只断言纯函数、⛔ 不绕过装配链、
⛔ 不做源码字符串匹配。三条变异各自把对应判据打红：

| 变异 | 变红的判据 |
|---|---|
| 去掉 D3 豁免 | 判据 2（三条真实语料全部被误伤，含生产装配那条） |
| 摘掉发布前的闸门 | 判据 3 / 4 / 5（凭证形态照常上 bus） |
| 把豁免放宽成「整字段豁免」 | 判据 3 的「紧挨着合法摘要」四条 |

判据 2 的反半边由 `highEntropyRuns`（= 无豁免的高熵规则本体）作证：三条语料在无豁免
版本下**确实**都有 ≥40 的候选串会命中，而生产扫描器一个 pattern 都不报——证明豁免
真在起作用，⛔ 不是「这三条本来就命不中」。
