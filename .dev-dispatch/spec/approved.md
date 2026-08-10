# G13 —— 生成段一旦部分失败，该 origin **永久卡死**：doc 幂等键已占用、one-shot 标记未写

> 派发方：`line-deep-research`。仓库：`loop-engine-deep-research-plugin`。前置：G12 已合入。
> **Phase 6 终态验收时真跑抓到，证据全部实测逐字。**

---

## 0　生产实况

第一次成功的生成段真跑（四个 role 全部 `exit=0`）产出：

```
research:agent-harness.docs  →  4 条 research.doc.v2
  argument 11809 | argument 8253 | argument 13985 | report 42637
  全部 origin = dr-agent-harness-20260810
```

**但该 tick 仍以 exit 2 结束**（当时的成因是 G12 导致 `EXPORT_ROOT` 未加载，
`G4c: EXPORT_ROOT is not configured. Refusing to silently skip the export.`）。

⇒ `runGenerate` **未返回** ⇒ one-shot 标记**未写**（`/tmp/deep-research-generated/` 实测为空目录）。

重跑（G12 绕过后、环境齐全）得到逐字：

```
bus POST /v1/channels/research:agent-harness.docs/publish: 409
{"code":"IDEMPOTENCY_CONFLICT","message":"Same idempotency_key with different intent"}
```

## 0.1　根因（定位到行号，非推断）

| 位置 | 事实 |
|---|---|
| `src/generate.ts:411-417` | doc 幂等键 = **`dr-doc:${role}:${origin}`** —— 固定于 (role, origin)，与内容无关 |
| `src/tick-run.ts:1628-1637` | one-shot 标记在 **`await runGenerate(...)` 成功返回之后**才 `writeFileSync` |

⇒ 顺序是「**发布（不可逆、键固定）→ 导出 → 写标记**」。
⇒ 发布之后、写标记之前的**任何**失败，都会留下「键已占用 + 无标记」的状态。
⇒ 重试必然重新 spawn 四个 agent（LLM 非确定性 ⇒ body 不同）⇒ **同键不同内容 ⇒ 409 ⇒ 永远走不完**。

> ### ⛔ 这不是「这次恰好 EXPORT_ROOT 没配」的偶然
> 发布之后还有 **anchor-check、导出落盘、report head 渲染** 等多个可失败步骤。
> 其中任何一个失败一次，**该 origin 就被永久锁死**。
> 唯一逃生口是换 `origin` —— 但那会让同一场研究出现两个溯源标识，**污染报告的 provenance**，
> 且 bus append-only 不可回退。**等于没有恢复路径。**

---

## 1　要做什么：让生成段**可恢复**（复用已发布的 doc，而不是重新生成）

在 `runGenerate` 派 role 之前，**先按 (role, origin) 查该 doc 是否已在 doc channel 上**：

- **已存在** ⇒ **直接复用其 body**，⛔ **不 spawn、不重新 publish**；
- **不存在** ⇒ 走现有路径（spawn → publish）。

这样：
- 本次卡死的 origin 能**在不改 origin、不重烧四个 agent** 的前提下走完导出与 anchor-check；
- 之后任何一次部分失败都能**幂等重试**；
- 顺带省掉「每次重试重烧四个 LLM」的真实成本（本线实测单轮四个 role 约 6 分钟 + 强档 token）。

### ⛔ 必须保住的既有语义

- ⛔ **`doc_kind` 仍由 role 推出**，绝不读 payload（`src/generate.ts:119-132` 的既有纪律）。
- ⛔ **幂等键写法不变**（`dr-doc:${role}:${origin}`）—— 本包不改键，只在发布前先查。
- ⛔ **synthesizer 的单例 lock 语义不变**（拿锁后必跑，除非其 doc 已存在而被复用）。
- ⛔ **anchor-check 仍是软闸门**：失败/报缺陷都不得阻断导出。
- ⛔ 不得把 409 吞掉当成成功 —— 复用是**发布前主动查**，不是**发布后吞异常**。
  （吞异常会让「真的冲突」与「已存在同内容」不可区分，正是本线一路在打的形态。）

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **W1** | ⭐ **判别性**：doc channel 上已存在某 role 的 doc（同 origin）⇒ `runGenerate` **不 spawn 该 role**、**不再 publish**，且**复用其 body** | 假 bus 预置一条 doc，断言 spawn 次数与 publish 次数；⛔ 这是本包的存在理由 |
| **W2** | ⛔ **全部已存在** ⇒ 零 spawn、零 publish，但**导出与 anchor-check 照常执行** | 断言导出被调用（这正是当前卡死场景的解法） |
| **W3** | ⛔ **部分已存在**（如三条 argument 在、report 不在）⇒ 只 spawn 缺失的那个 role | 断言 spawn 的 role 集合 |
| **W4** | ⛔ **都不存在** ⇒ 行为与今天逐字一致（四个 role 全 spawn 全 publish） | 回归断言 |
| **W5** | ⛔ **不得吞 409**：publish 真的返回 409 时仍**响亮失败**并点名 role/origin | 判别性用例；与 W1 的「先查后复用」必须可区分 |
| **W6** | ⛔ **断言打在生产组装出的 deps 上**（`assembleGenerateDeps` 已导出）；⛔ 自建 runtime 注入不算数；⛔ 源码字符串匹配不构成证据 | 照 G5/G6/G7/G10 已交付的做法 |
| **W7** | 全量 `npx vitest run` 干净环境真绿。基线：G12 合入后的 main **派发方实测 513 tests**，终值不得低于基线 | ⛔ 贴本次运行完整尾部（`Test Files` / `Tests` 两行 + 有无 FAIL 段） |
| **W8** | **可达性声明**：W1–W5 每条指名唯一会失败的用例 + 一两句「为什么缺该行为就不可能通过」 | dev-note |
| **W9** | 工作树干净 | ⛔ 贴 `git status --porcelain \| wc -l` 的输出（应为 `0`）。⛔ 不要贴 `git status --porcelain` 本身——干净时它无输出，空块与遗漏不可区分 |

---

## 3　⛔ 关于变异自检：本包不要求你自报，也不要编造

**实测变异由派发方在 gate 亲手施加。** 你只需给 W8 的**可达性声明**（可被评审读代码核实）。
⛔ 不要写「实测 / 被杀 ✓」，除非你真做了并能贴出被改行与失败输出。
**写不出就如实写「未实测，理由：见可达性声明」——这不扣分。**

---

## 4　⛔ 派发方已付的学费

1. **判据必须先被证明「在验收环境里可满足」**。本线已为此付过三次代价（要求为不可观测的 EPIPE 写用例、
   要求贴一个成功时无输出的命令的输出、要求某用例走一条依赖 bus 而验收沙箱无 bus 的路径）。
   ⇒ 本包 W1–W5 全部可用**假 bus 预置消息**驱动，**不依赖真实网络**，派发方已确认可满足。
2. ⛔ **源码字符串匹配一律不构成证据**；⛔ 在测试里重写一份被测逻辑再断言等于没测。
3. **dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit**，不是 H0 提交。
4. **修好一条路径时，必须查同一形状是否还在别处**（triage / worker 的收割路径是否有同类「不可重试」问题，
   本包不改但请在 dev-note 说明你查过的结论）。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 改 doc 幂等键的写法 | 键本身没问题；问题是发布前不查 |
| 改 `origin` 或任何 profile 值 | 换 origin 会污染 provenance，正是本包要避免的 |
| 吞掉 409 当成功 | §1 已说明：会让真冲突不可见 |
| 改 anchor-check 的软闸门语义 | 已拍死 |
| 修 loop-engine 吞 tick 失败（G11） | 不同仓，独立发现 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错 |

---

## 6　交付物落点

- 实现：`src/generate.ts`（发布前按 (role, origin) 查已有 doc 并复用）、必要时 `src/tick-run.ts`（deps 装配读 doc channel）
- 测试：`test/g13-generate-resume.test.ts`（W1–W6）
- 证据：`docs/dev-notes/dev_ledr_g13_generate_resume_01.md`（W1–W9 逐条 + §3 可达性声明 +
  本次运行的全量测试尾部 + `git status --porcelain | wc -l` 输出 + §4.4 的同形排查结论）
