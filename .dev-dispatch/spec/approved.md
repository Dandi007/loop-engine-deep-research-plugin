# E0b —— 回归基线收口（接 E0a 被驳回的两处 blocker）

**目标仓**：`Dandi007/loop-engine-deep-research-plugin`
**前序**：E0 已合入 main（`95a4ea8`）。E0a（PR #59）在 human gate 被**驳回**——
单测全绿但产物在真机上**根本跑不起来**。本包重做 E0a 的目标，并把两处根因写死在判据里。

---

## 0　E0a 被驳回的两处 blocker（真机取证，逐字可复现）

### blocker 1：读了一个真实 API 不存在的字段 ⇒ 入口永远跑不到 loop

E0a 的 `_head_seq()` 从 `GET /v1/channels/<id>` 的响应里取 `head_seq`。
**真实 agent-bus 的单 channel 响应里没有这个字段。** 派发方 2026-08-12 实测两个端点的字段集：

```
GET /v1/channels/<id>   →  channel_id, closed_at, created_at, default_lease_ms,
                            delivery_mode, max_attempts, metadata, owner_agent_id,
                            refs_required, visibility            ← 无 head_seq
GET /v1/channels        →  channel_id, closed_at, created_at, delivery_mode,
                            head_seq, owner_agent_id, visibility ← head_seq 只在这里
```

真机运行的实际结果（E0a 候选，`bash bin/e0-regression.sh`）：

```
[e0-regression] FAIL: could not read head_seq for channel 'research:e0-regression.index'
                on test bus (body={"channel_id": …, "delivery_mode": "fanout", …})
[e0-regression] FAIL: could not read research board head_seq before run
entry exit=3
```

⇒ 入口在跑 loop **之前**就退出，Z1 在结构上不可达。

**单测为什么是绿的**：`test/fixtures/e0a-fake-bus.mjs:44` 自己造了一个
`GET /v1/channels/<id> → {head_seq: N}` 的端点。**fixture 描述的契约现实中不存在**，
于是测试验证的是一个虚构的 bus。这正是宪法第十三条要防的形状：mock 全绿 ≠ 真机能跑。

### blocker 2：`_prod_sum` 不是求和 ⇒ Z2 判据是空的

```bash
sed -n 's/.*"head_seq"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | awk '{s+=$1} END{print s+0}'
```

bus 返回的是**单行 JSON**，`sed` 的贪婪 `.*` 使每行只捕获**最后一个** `head_seq`。
实测：生产总线上该实现算出 **3**，真实 `sum(head_seq)` 是 **9788**。

判别性证据（离线构造，不写生产总线）：两个 channel 的 head_seq 从 `10/20` 涨到 `9999/8888`
（相当于写入 18857 条），**候选读数前后恒为 `5 == 5`** ⇒ 判过。
即：**往生产总线写爆也照样通过 Z2**。

## 1　交付内容

沿用 E0a 已经做对的整体结构（空板自播种、`bin/e0-verify.sh` 的实证判据分离、
`board:agent-runs` 进预备清单、生产总线跑前跑后读数进运行记录），**只把上面两处做对**：

### 1.1 head_seq 一律从**列表端点**取

- 取某 channel 的 `head_seq`：读 `GET /v1/channels`，在列表里按 `channel_id` 找到那一项再取 `head_seq`。
  ⛔ 不得依赖 `GET /v1/channels/<id>` 返回 `head_seq`。
- 找不到该 channel、或该项没有 `head_seq` 字段 ⇒ **响亮失败并点名 channel 与实际拿到的字段集**，
  ⛔ 不得当作 0 继续（把"读不到"和"确实是 0"混为一谈，会让 Z1 的增长判据失效）。

### 1.2 求和必须是真的求和

- `sum(head_seq)` 必须对**所有** channel 求和。
- ⛔ 不得用「贪婪正则 + 逐行」的方式从 JSON 里抽多值。用能真正解析 JSON 的方式
  （仓内已依赖 Node，`node -e` 直接 `JSON.parse` 即可；⛔ 不新增第三方依赖）。
- 同一条纪律适用于 §1.1 的按名取值与从 loop 输出里取 `termination.state`：
  **凡是从 JSON 里取值，一律解析，不得用正则贪婪匹配**（`bin/e0-regression.sh` 里现有三处 `sed -n` 抽取都要按此改）。

### 1.3 fixture 必须与真实契约一致

- 测试用的假 bus，其响应字段集必须与真实 agent-bus **对得上**：
  单 channel GET **不返回** `head_seq`；列表 GET 返回 `head_seq`。
- **新增一条判别性测试**：假 bus 的单 channel GET 若返回 `head_seq`，或列表 GET 若不返回 `head_seq`，
  ⇒ 测试必须变红。换句话说，**把 fixture 改回 E0a 那个虚构契约，测试套件必须报错**。
  这条是本包存在的理由之一——防止再用虚构 API 骗过验收。

## 2　验收判据

1. `npm ci && npm run typecheck && npm test` 全绿。
2. **⭐ 判别性（blocker 2）**：构造「生产总线跑前跑后有 channel 的 head_seq 增长」的情形
   ⇒ 入口必须**非零退出**并点名污染。把求和换回 E0a 的贪婪 sed 实现 ⇒ 该测试必须变红。
3. **⭐ 判别性（blocker 1）**：假 bus 的单 channel GET 返回 `head_seq` ⇒ 测试变红（§1.3）。
4. **⭐ 判别性（沿用 E0a 目标）**：loop 退出 0 但零总线写入 / 板面无终态 ⇒ 入口非零退出。
5. 空板自播种生效且幂等：重复执行不使板面线索翻倍。
6. `board:agent-runs` 在 channel 预备清单内，且该名字在仓内只有一处真相源。
7. 仓内不得出现任何 token 明文。
8. **Z1（真机）**：`bash bin/e0-regression.sh` 跑到终态、退出 0，
   且测试总线上 `TICK_CHANNEL` 的 head_seq 相对跑前**严格增长**。
9. **Z2（真机）**：该次运行前后生产总线 `sum(head_seq)` 零增长，两个读数**都出现在运行记录里**
   且**是真实的全量和**（派发方会用独立实现交叉核对这两个数字）。
10. **Z3（真机）**：连续两次执行都到终态，各自独立 run id 与记录目录，板面线索不翻倍。

> 判据 8–10 由派发方在真机上执行验证。**派发方会用与实现无关的独立脚本复算 Z2 的两个读数**——
> 数字对不上即判不过，所以不要试图用「读起来像那么回事」的近似实现。

## 3　⛔ 明确不做

与 E0 spec §4 一致（web/content 信源、ingest、anchor scheme、仲裁者、原子产物、E7 入口重写、
协议注册、工具白名单、生产 profile 一律不碰）。

额外：⛔ 不得为了让判据过而放宽判据本身（例如把 Z2 改成"只比较某一个 channel"、
把终态断言改成"没报错就算过"）。判据的严格性是本包的交付物。

## 4　评审口径

- **REJECT 只用于 blocker 级**：判据不成立、判别性缺失、用正则从 JSON 抽多值、
  fixture 与真实契约不符、静默失败、凭证泄漏、越出 §1 范围。
  文风与偏好写成 non-blocking 建议。
- ⚠️ **对 reviewer 的特别提醒**：E0a 正是**带着两处这类缺陷通过了 continuous 与 final 两道 review**
  才被人工闸门拦下的。审这个包时请特别核对：**每一处从 HTTP 响应里取字段的代码，
  取的字段在真实 API 里到底存不存在**；以及**每一处从 JSON 抽值的方式在多值场景下是否成立**。
- reviewer 只读，判据 1–7 由 acceptance 命令的执行结果作证，⛔ 不要求 reviewer 执行 shell。
- ⛔ 实现者不得写 `.dd-evidence/**` 与 `.dev-dispatch/**`（引擎保留路径，写入即永久 wedge）。
