# G13(v2) —— 生成段部分失败后该 origin 永久卡死：按 **report 是否已存在** 恢复

> 派发方：`line-deep-research`。仓库：`loop-engine-deep-research-plugin`。基线：main `a86b78f`（G12 已合入）。
>
> ⚠️ **这是重开包。v1 的核心要求不可实现，是派发方（我）的缺陷，不是实现方的问题。**
> v1 要求「按 **(role, origin)** 查已有 doc 并复用」，但 **`research.doc.v2` 的载荷里没有 role**。
> 详见 §0.2。**v2 改用一个完全可从现有载荷推导的设计。**

---

## 0.1　生产实况（真跑抓到，证据逐字）

第一次成功的生成段真跑，四个 role 全部 `exit=0`，产出：

```
research:agent-harness.docs → 4 条 research.doc.v2（origin 均为 dr-agent-harness-20260810）
  doc_kind=argument 11809 | argument 8253 | argument 13985 | report 42637
```

但该 tick 仍 `exit 2`（当时成因是 G12 致 `EXPORT_ROOT` 未加载）⇒ `runGenerate` 未返回
⇒ one-shot 标记未写（`/tmp/deep-research-generated/` 实测空目录）。

环境修好后重跑，得逐字：

```
bus POST /v1/channels/research:agent-harness.docs/publish: 409
{"code":"IDEMPOTENCY_CONFLICT","message":"Same idempotency_key with different intent"}
```

**根因（定位到行号）**：

| 位置 | 事实 |
|---|---|
| `src/generate.ts:411-417` | doc 幂等键 = `dr-doc:${role}:${origin}`，**固定于 (role, origin)、与内容无关** |
| `src/tick-run.ts:1628-1637` | one-shot 标记在 `runGenerate` **成功返回之后**才写 |

⇒ 顺序是「**发布（不可逆、键固定）→ anchor-check → 导出 → 写标记**」。
发布之后、写标记之前的**任何**失败都留下「键已占用 + 无标记」；
重试必然重新 spawn（LLM 非确定性 ⇒ body 不同）⇒ 同键不同内容 ⇒ **409 ⇒ 永远走不完**。
唯一逃生口是换 `origin`，但那会让同一场研究出现两个溯源标识、污染 provenance，且 bus append-only 不可回退。
**等于没有恢复路径。**

## 0.2　⛔ v1 错在哪（派发方已实测，别再往那个方向做）

v1 要求「按 (role, origin) 查已有 doc 并复用」。**做不到**：

```
DocV2 载荷字段（实测）: ['body', 'digest', 'doc_kind', 'origin']        ← 没有 role
deriveDocKind: advocate / opponent / judge 三个 role 全部 → doc_kind = "argument"
```

⇒ 三条 argument 在载荷层面**互不可分**。

评审建议的备选「按已有幂等键 `dr-doc:${role}:${origin}` 查」**同样不可行**——派发方实测 bus 消息信封字段为：

```
message_id, channel_id, channel_seq, sender_agent_id, kind, payload,
entity_id, supersedes, reply_to_message_id, available_at, expires_at, created_at
```

**不含 `idempotency_key`**，读不回发布时用的键。

给 `research.doc.v2` 加 role 字段属**协议变更（不可逆注册动作）**，与本包不相称。

⛔ **不要**试图用 `channel_seq` 的先后顺序去反推是 advocate 还是 opponent —— 那是位置推断，脆弱且不可验证。

---

## 1　要做什么（v2 设计：只用可推导的信息）

在 `runGenerate` 开始派 role **之前**，读一次 doc channel，按 `origin` 过滤，然后：

| 已有状态 | 行为 |
|---|---|
| **存在 `doc_kind === "report"`（同 origin）** | ⭐ **跳过全部 spawn 与全部 publish**，复用该 report 的 `body`，直接走 **anchor-check + 导出** |
| **无 report，但存在 ≥1 条 `doc_kind === "argument"`（同 origin）** | ⛔ **响亮失败**：点名 `origin` 与已有 argument 条数，说明该 origin 处于「部分发布、无法安全恢复」状态。⛔ 不猜、不重发（重发必 409） |
| **该 origin 下无任何 doc** | 行为与今天**逐字一致**（四个 role 全 spawn 全 publish） |

### 为什么这样切

- **它解开真实死锁**：本次卡住的 origin **report 已存在**（42637 字节），复用即可走完导出与 anchor-check，
  **不改 origin、不重烧四个强档 LLM**。
- **report 由 `doc_kind` 唯一确定**，无需 role 判别 ⇒ 完全可从现有载荷推导，**不动协议**。
- **部分-argument 是真的有歧义**（不知道缺哪个 role），把它变成**响亮可诊断的失败**，
  比今天「撞 409 撞到天荒地老」严格更好。⛔ 不要为它编一个猜测式恢复。

### ⛔ 必须保住的既有语义

- ⛔ **`doc_kind` 仍由 role 推出**，绝不读 payload 决定发什么（`src/generate.ts:119-132` 既有纪律）。
- ⛔ **幂等键写法不变**（`dr-doc:${role}:${origin}`）。本包不改键。
- ⛔ **anchor-check 仍是软闸门**：失败/报缺陷都不得阻断导出；崩溃与真实 0% 必须可区分。
- ⛔ **不得吞 409**：复用是**发布前主动查**，不是**发布后吞异常**。
- ⛔ 复用分支里**不要重复计算随后被丢弃的量**（v1 attempt 1 的 minor：在复用分支重算了 anchorRate/anchorTail 却从不使用——
  已发布的 report body 自带其 head）。要么用上，要么不算。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **W1** | ⭐ **判别性**：doc channel 上已有该 origin 的 `report` ⇒ **零 spawn、零 publish**，且**导出被调用**、导出内容取自该 report 的 body | 假 bus 预置一条 report，断言 spawn 次数 `=== 0`、publish 次数 `=== 0`、导出入参 body 逐字等于预置值 |
| **W2** | ⛔ **anchor-check 在复用分支照常执行**（`anchor-check.json` 仍产出） | 断言其被调用 |
| **W3** | ⛔ **无 report 但有 argument** ⇒ **响亮失败**，错误信息**点名 origin 与 argument 条数**；⛔ 不得 spawn、不得 publish | 判别性用例；断言抛错且 spawn/publish 计数为 0 |
| **W4** | ⛔ **该 origin 下无任何 doc** ⇒ 行为与今天逐字一致（四个 role 全 spawn、四次 publish） | 回归断言 |
| **W5** | ⛔ **只按 origin 过滤**：channel 上存在**别的 origin** 的 report ⇒ 不得被误当成本 origin 的可复用产物 | 判别性用例（预置一条 `origin: "other"` 的 report，断言仍走正常全量路径） |
| **W6** | ⛔ **断言打在生产组装出的 deps 上**（`assembleGenerateDeps` 已导出）；⛔ 自建 runtime 注入的用例不算数；⛔ 源码字符串匹配不构成证据 | 照 G5/G6/G7/G10 已交付的做法；⚠️ v1 正是栽在「只有注入 mock 能满足、生产路径不能」 |
| **W7** | 全量 `npx vitest run` 干净环境真绿。基线：main `a86b78f` **派发方实测 513 tests**，终值不得低于基线 | ⛔ 贴本次运行完整尾部（`Test Files` / `Tests` 两行 + 有无 FAIL 段） |
| **W8** | **可达性声明**：W1–W5 每条指名唯一会失败的用例 + 一两句「为什么缺该行为就不可能通过」。⛔ 声明必须对**生产路径**成立，不能只对注入的 mock 成立（v1 的 major） | dev-note |
| **W9** | 工作树干净 | ⛔ 贴 `git status --porcelain \| wc -l` 的输出（应为 `0`）。⛔ 不要贴 `git status --porcelain` 本身——干净时它无输出，空块与遗漏不可区分 |

---

## 3　⛔ 关于变异自检：本包不要求你自报，也不要编造

**实测变异由派发方在 gate 亲手施加。** 你只需给 W8 的**可达性声明**（可被评审读代码核实）。
⛔ 不要写「实测 / 被杀 ✓」，除非你真做了并能贴出被改行与失败输出。
**写不出就如实写「未实测，理由：见可达性声明」——这不扣分。**

---

## 4　⛔ 派发方已付的学费（本包直接相关）

**判据必须先被证明「可满足」才能写进硬验收。** 本线已为此付过**四次**代价：

1. 要求为 bun 下**不可观测**的 EPIPE 写判别性用例；
2. 要求贴一个**成功时无输出**的命令的输出；
3. 要求某用例走一条**依赖 bus 而验收沙箱无 bus** 的路径；
4. **本包 v1**：要求按 (role, origin) 复用，而**载荷里根本没有 role**。

⇒ 本包 W1–W5 派发方已逐条确认可满足：`doc_kind` 与 `origin` 均在 `DocV2` 载荷内（实测字段
`['body','digest','doc_kind','origin']`），假 bus 预置消息即可驱动，**不依赖真实网络**。

其余：⛔ 源码字符串匹配不构成证据；⛔ 测试里重写一份被测逻辑再断言等于没测；
dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit，不是 H0 提交。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 给 `research.doc.v2` 加 role 字段 | 协议变更 = 不可逆注册动作，与本包不相称 |
| 用 `channel_seq` 顺序反推 role | 位置推断，脆弱且不可验证（§0.2） |
| 为「部分 argument」编猜测式恢复 | 真有歧义；响亮失败严格优于猜 |
| 改 doc 幂等键写法 | 键没问题，问题是发布前不查 |
| 吞掉 409 当成功 | 会让真冲突不可见 |
| 改 anchor-check 软闸门语义 / 改 origin / 改 profile 值 | 已拍死或归部署方 |
| 修 loop-engine 吞 tick 失败（G11） | 不同仓，独立发现 |

---

## 6　交付物落点

- 实现：`src/generate.ts`（开跑前查已有 doc 并按 §1 三分支处理）、必要时 `src/tick-run.ts`（deps 装配读 doc channel）
- 测试：`test/g13-generate-resume.test.ts`（W1–W6）
- 证据：`docs/dev-notes/dev_ledr_g13v2_generate_resume_01.md`（W1–W9 逐条 + §3 可达性声明 +
  本次运行的全量测试尾部 + `git status --porcelain | wc -l` 输出）
