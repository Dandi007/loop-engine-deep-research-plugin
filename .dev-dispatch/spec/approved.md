# S1b(v2) —— CAS 认领原语硬化 + 测试功率补齐 + 冒烟真跑

> **本包是 `dev_ledr_s1b_cas_hardening_01` 的重派。** 上一条 development 的 attempt 2
> 产品代码**已被 gate 逐条验证为正确**（四条变异逐断言归因全对），
> 唯一死因是冒烟脚本从未真跑、gate 首跑即 400。
>
> **参考实现（不作为交付，但强烈建议照搬其正确部分）**：
> 分支 `loopdev/dev_ledr_s1b_cas_hardening_01/attempt-context-v1`，commit `473dbe3`。
> 其 `src/bus.ts`、`test/bus.test.ts`、`test/cas.test.ts` 的做法已通过 gate 的执行级验证；
> **需要改的只有 `scripts/smoke-cas.ts` 的 entity_id 语义，外加本 spec 新增的 A9 / A10。**

> 上游依据：work folder `wf-dc0c15` 的 `spec.md`(rev7) §3.2 / §2.2，`plan.md` §2「链 A · S1」。
> 本包收口 S1 的剩余 DoD，并修掉 S1 首版落地时带进来的四处缺陷。

## 1　背景与本包存在的理由

`src/bus.ts` + `src/protocol.ts` 于 commit `b8c4a3a` 落地，是 deep-research 调度层与 agent-bus
之间**唯一的读写面**。其中 `claimClue()` 是**线索认领的互斥原语**——整个调度器「先 CAS 改卡、
再 spawn job」的正确性完全压在它身上。

该 commit 未经任何第二方评审。本包把它送进评审，并修掉复核中查出的四处缺陷。

**为什么这四处必须现在修**：本项目发生过真实事故——两条线各自认为持有同一个槽、**无人拿到 409**。
根因就是认领原语的前置条件求值出了问题。同类缺陷在 deep-research 上的后果是**两个 worker 领走
同一条线索**，而 agent-bus 是 append-only 无 DELETE 的，写进去的重复证据清不掉。

## 2　要修的四处缺陷（全部实测于 `b8c4a3a`）

### D1　冲突判定靠字符串匹配，会误判

`src/bus.ts:189-197`：

```ts
} catch (err: any) {
  const msg = err.message ?? "";
  if (msg.includes("409")) {
    return { success: false, error: "conflict" };
  }
```

而错误消息由 `busFetch`（`src/bus.ts:34-38`）拼成，**含响应体前 200 字节**：

```ts
throw new Error(`bus ${method} ${path}: ${resp.status} ${body.slice(0, 200)}`);
```

⇒ 响应体里**任何位置**出现 `409` 三个字符（message_id、channel_seq、时间戳、被回显的
payload 正文）都会让一次**非冲突的失败**被判成 `conflict`。

对互斥原语而言这是**把失败判成"别人抢先了"**——调度器会据此放弃认领并去处理别的线索，
而真正的故障（比如 payload 不合法）被永久掩盖。

**要求**：错误分类必须依据 **HTTP 数值状态码**，不得依赖对错误文本的子串匹配。

### D2　`getEntity` 把一切异常压成"卡不存在"

`src/bus.ts:86-93`：

```ts
try {
  const resp = await busFetch(`/v1/entities/${entityId}`);
  return await resp.json();
} catch {
  return null;
}
```

catch-all ⇒ **403（无 channel 读权限）、500（bus 故障）、网络不可达**全部返回 `null`，
`claimClue` 于是返回 `error: "entity_not_found"`。

调度器读到"这张卡不存在"会当成正常状态推进；实际是基建挂了。

> 本线已在**「静默降级」**上栽过八次，最狠的一次是一个 `rc=0`、输出 125KB 的错误命令
> 被读成正常空结果。**判据：不报错、退出码为 0、还给你一个看起来合理的返回值的错误，
> 比报错的危险得多。**

**要求**：`claimClue` 必须能把「卡真的不存在」与「读取失败」区分开，且后者**不得**
被表达成一个看起来正常的状态。

### D3　`afterSeq` 用 falsy 判断，`0` 会被丢掉

`src/bus.ts:77`：

```ts
if (opts.afterSeq) params.set("after_seq", String(opts.afterSeq));
```

`afterSeq === 0` 为 falsy ⇒ 参数不发 ⇒ 服务端按默认行为**返回最早 100 条**。

> 这正是本线踩过的实测坑：`GET /v1/channels/<id>/messages` 默认 `limit=100` 且返回
> **最早**的 100 条。本线曾因此得出「chat 消息数 = 0」的错误结论。
> **凡是恰好返回 100 条的，先怀疑截断。**

**要求**：显式传入的 `afterSeq`（含 `0`）必须原样进 query string。

### D4　⛔ `test/cas.test.ts` 对产品代码零功率

**整个文件不 import `src/bus.ts`。** 它在测试文件内部（`test/cas.test.ts:24-48`）
自己重写了一份 `casClaim()` 副本，四条断言全部打在这份副本上。

后果：`src/bus.ts` 的 `claimClue` / `casUpdateClue` **一行都没有被测到**。
D1/D2/D3 三处缺陷能在 15/15 全绿的情况下存在，正是因为这个。

更糟的是那条自称「常驻断言」的用例（`test/cas.test.ts:93-102`）：

```ts
const head = headOpen;
const status = head.payload.status;
const supersedes = head.message_id;
expect(status).toBe("open");
expect(supersedes).toBe("msg_001");
```

它断言的是**同一个文件里五行之前刚定义的字面量常量**。
**两个操作数同源 ⇒ 结构上不可能失败。** 它在代码里长得像检查，语义上是恒等式。

> **零功率的检查比没有检查更坏**——它制造一个「看起来被验证过」的空位。
> 判据：**它的缺席会不会被读成证据？** 会，就不能留。

**要求**：CAS 测试必须**导入并调用 `src/bus.ts` 的真实导出**，靠打桩 `fetch` 构造场景。
「同源读」判据要么用真实调用路径验证，要么删掉——**不允许保留一个恒真断言冒充它**。

## 3　交付范围

| 允许改 | 说明 |
|---|---|
| `src/bus.ts` | 修 D1 / D2 / D3 |
| `test/cas.test.ts` | 按 D4 重写为对 `src/bus.ts` 的真测试 |
| `test/bus.test.ts` | 可新建，放 D1–D3 的针对性用例 |
| `scripts/smoke-cas.ts`（新建） | 真机冒烟脚本，见 §5 |
| `package.json` | 允许新增 script 条目；**允许新增 devDependency**（见下） |
| `vitest.smoke.config.ts` | 允许新建，用于让 `smoke:cas` 只收 `scripts/smoke-cas.ts` |

> **上一版本 spec 把 `package.json` 锁成「仅允许新增 script 条目」，导致实现方无权引入
> 跑得起来的 runner —— 我一边要求交付可执行脚本、一边禁止它引入依赖。该边界已放开。
> 这张表的立法意图是保护下面两个冻结件，不是禁止新增配置。**

**不得改**：`src/protocol.ts`（协议类型已按 `research.*.v2` 注册态定稿，改它等于改已冻结契约）、
`test/protocol.test.ts` 的既有 11 条用例。

## 4　硬验收（逐条可机械核验）

| # | 断言 | 怎么验 |
|---|---|---|
| **A1** | 冲突/非冲突分类依据数值状态码 | `grep -nE 'includes\("?4[0-9]{2}' src/bus.ts` **零命中**；错误对象带数值字段（如 `status: number`） |
| **A2** | 响应体含 `409` 字样但 HTTP 200 的 publish → **判为成功** | 打桩 fetch 返回 `{ok:true, status:200, json:()=>({message_id:"msg_409abc"})}`，断言 `casUpdateClue` 返回 `success:true` |
| **A3** | `getEntity` 遇 HTTP 500 时，`claimClue` 的结果**不是** `entity_not_found` | 打桩 fetch 返回 500，断言 error 值可与真·404 区分 |
| **A4** | `getMessages(ch, {afterSeq: 0})` 把 `after_seq=0` 带进 URL | 打桩 fetch 捕获入参 URL，断言含 `after_seq=0` |
| **A5** | CAS 测试**导入 `src/bus.ts`** | `grep -n 'from "\.\./src/bus"' test/cas.test.ts` 命中；且文件内**不再定义**本地 `casClaim` 副本（`grep -c 'function casClaim' test/cas.test.ts` == 0） |
| **A6** | 同源读判据由**真实调用路径**验证 | 打桩：首次 `getEntity` 返回 status=open 的 head，断言发出的 publish 请求里 `supersedes` **恰等于该 head 的 `message_id`** —— 即前置条件与 supersedes 出自同一次读 |
| **A7** | `test/protocol.test.ts` 的 11 条用例**一行未删** | `git diff -- test/protocol.test.ts` 为空 |
| **A8** | 全量测试通过 | `npm test` exit 0 |
| **A9** | 400/422 分支的数值分类也有判别性测试 | 构造 **HTTP 500 且响应体文本含 `"422"`** 的桩：数值版应 rethrow，字符串版会返回 `invalid_payload`。断言 rethrow |
| **A10** | 不留恒真断言 | 删除或改写 `test/cas.test.ts` 里 `A2: publish returns 200 with body containing 409 → success` —— 它在新旧两版实现下都通过（旧版的 `includes("409")` 只在 catch 分支，HTTP 200 不进 catch），是**恒真**的。真守卫是 `test/bus.test.ts` 的 A1 |

## 5　真机冒烟（⛔ 本次必须真跑，且只跑一次）

### 5.1 上一次派发死在这里 —— 请先读

上一版 `scripts/smoke-cas.ts` 通过了 implementer、continuous review、final review 三关，
**gate 第一次真跑就 400 失败**：

```
bus POST /v1/channels/research:p02-smoke-1dce60/publish: 400
{"code":"VALIDATION_ERROR","message":"Invalid entity_id format"}
```

根因：脚本自造 `const ENTITY = "smoke-1dce60"` 并在**创建**时当 entity_id 传入。

> **agent-bus 的 `entity_id` 是首版消息自身的 `message_id`，由服务端回赋，创建时不可指定。**
> 实测：publish 不带 `entity_id` → 响应体 `entity_id == message_id`（`msg_01KZ6C66378JW7W91708EBG5T9`）。
> `casUpdateClue` 在**修订**时传 `entity_id + supersedes` 是正确的 —— 产品代码无需改动，
> 错的是冒烟脚本把「修订语义」用在了「创建」上。

**正确形状**：步骤① publish **不传** `entity_id`，从响应体读回它，再传给步骤②③。

### 5.2 本次的硬要求：实现期必须真跑一次

上一版把冒烟设为「只在 gate 执行」，结果它在被合入前**从未接触过现实**，
而 gate 拒绝是终态 ⇒ 一次失败就报废整条 development。**本次改为实现期必须真跑。**

`scripts/smoke-cas.ts` 对测试 channel `research:p02-smoke-1dce60` 依次：
① publish 一条 `research.clue.v2`（status=open，**不传 entity_id**），从响应读回 `entity_id`
② `claimClue(该 entity_id)` → 断言 `success === true`
③ 再次 `claimClue` 同一 entity → 断言 `error === "conflict"`（**必须断言到 error 值，不能只断言 !success**）
④ 打印三步的 `message_id` / `channel_seq`

**幂等键必须是固定确定性常量**（不得用 `Date.now()` 派生）。这是「不要反复运行」这句散文
背后**唯一的机械保障**：重跑会 bus 侧去重，写不进新消息。

⛔ **agent-bus append-only、无 DELETE 路由，写入不可回退。** 本线曾写进 5.3MB 清不掉的垃圾。
**总写入量硬上限 3 条消息；不得循环、不得批量、不得改 channel。**

⛔ **仍然不得接进 `acceptance_commands`**（那会在每次 attempt 上重复触发）。
只经 `npm run smoke:cas` 显式调用，且 `scripts/` 不得被 `npm test` 的默认 include 匹配到。

**交付时请在 IMPLEMENTATION_SUMMARY 或 commit message 里贴出你那一次真跑的实际输出**
（三步的 message_id 与 channel_seq）。gate 会再跑一次：
**届时应命中 `deduplicated: true`、channel 消息数不再增加** —— 这同时证明脚本可用与幂等守卫有效。

## 6　变异自检（必须逐断言归因）

| 变异 | 必须杀死 | 上一版实测 |
|---|---|---|
| M1 把 409 分支的数值判定改回 `msg.includes("409")` | 「非 409 失败但响应体含 409 不得判为 conflict」那条 | ✅ 已有守卫 |
| **M1b** 把 400/422 分支也改回 `msg.includes(...)` | **A9** | ❌ **零功率，无任何断言挂掉** |
| M2 把 `getEntity` 的错误区分改回 catch-all `return null` | **A3** | ✅ 已有守卫 |
| M3 把 `afterSeq` 判断改回 falsy（`if (opts.afterSeq)`） | **A4** | ✅ 已有守卫 |
| M4 把 `casUpdateClue` 的 `supersedes` 改成来自第二次独立读的 head | **A6** | ✅ 已有守卫 |

> ⚠️ **M1 的目标断言不是 `A2`。** `A2`（publish 返回 200 且响应体含 `409` → success）
> 在新旧两版实现下**都通过** —— 旧版的 `includes("409")` 只在 catch 分支里，HTTP 200 不进 catch。
> 它是**恒真**的，已由 **A10** 要求删除/改写。M1 的真守卫在 `test/bus.test.ts`。

> **只报「N/N 挂了」不算数。** 本线曾第一次变异跑出 10/10 差点签字，去看挂的是哪几条才发现
> **核心那条断言全程存活**——而它才是那个包存在的理由。
> **变异杀死的断言集合，必须与该变异所模拟的缺陷对得上。**
>
> 且**破坏后必须回显被改的那一行**，不能只信脚本说改了——曾有正则命中注释行而非真代码，
> 脚本打印 `patched: True`、测试全绿。

## 7　非目标

- 不实现调度 tick（S2）、覆盖度与终止条件（S3）——那是后续包
- 不改 `research.*.v2` 协议 schema（已在 agent-bus 上**不可逆注册**）
- 不接 MinerU、不做导出

## 8　环境

- `setup_commands` 必须含 `npm ci`（本仓 `vitest` 走 devDependencies，不装则 `vitest: not found`）
- `tsconfig.json` 的 `include` 已包含 `test/`，`npm run typecheck` 会覆盖测试文件
- agent-bus：`http://127.0.0.1:7490`，token 在 `/data/agent-bus/tokens/`，Bearer 认证
