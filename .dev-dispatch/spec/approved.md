# A10b —— 自然收敛 + 端到端真跑 + 消灭验收命令本身的不确定性

> 上游依据：`wf-dc0c15` `spec.md`(rev7) §3.4；A10 原 spec 的 **C5/C6** 与 §1.3。
> 前置须已合入 main：链 A 全部 + A7 + A8a–A8f + A9 + **A10a**。
> **本包全部依据来自 2026-08-05 的真跑与本 gate 的实测，不是推测。**

---

## 0　两个实测事实

### 0.1 这条流水线**从未自然收敛过**

A9 的 F0 真跑输出：
```json
{"reason":"max_rounds","rounds":16,"ticksByLabel":{"tick":16}}
```
撞 `max_passes` 退出，**不是** `drained`。

根因（A9 交付本身是对的，问题在触发记录的生命周期）：
触发存储自始至终**只有 seed 一条**，且它**始终停在 `open`** ⇒ 每轮都能被重新认领
⇒ `claimableCount()` 恒 > 0 ⇒ 永远不会判「已排空」。
A9 的条件续投逻辑从未被执行过（它只在 `hasPendingWork=true` 时**追加**，而问题在于旧的那条没被消费掉）。

> ⛔ **这条缺陷是我自己放进来的**：A9 spec 正文 §1.3 白纸黑字要求「自然终止」，
> **而验收表只有 `ticksByLabel.tick >= 1`**。
> **正文要求、验收不查 ⇒ 等于没要求。** 本包不得重犯：§1 的每一条都必须在 §2 有对应断言。

### 0.2 ⛔ `npm test` 本身是不稳定的 —— 而它是**验收命令**

本 gate 在 `main`（A10a 之前）连跑 5 次：

| 轮 | 退出码 |
|---|---|
| 1 | 0 |
| **2** | **1** |
| 3 | 0 |
| 4 | 0 |
| 5 | 0 |

失败那次：
```
FAIL test/a8f-adddir.test.ts > F1: ALLOWED_ROOT wired end-to-end through the production assembly
  → expected null to be '/data/code/self/agent-runtime'
Tests  1 failed | 269 passed (270)
```

**根因（已定位到确切那一行）**：`bin/deep-research-loop.sh:19`
```sh
RUN_ID="${DD_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"      # ⛔ 秒级粒度
RUN_ROOT="${DD_RUN_ROOT:-$PLUGIN_ROOT/.runtime/$MODE/$RUN_ID}"
RUNTIME_FLEET="$RUN_ROOT/fleet.yaml"
```
而**有 5 个测试文件都会调这个渲染**：
`a9-tick-trigger` / `a8f-adddir` / `plugin-wiring` / `harvest` / `tick-run`。
vitest 并行跑 ⇒ **同一秒内渲染的两个文件共用同一个 `RUN_ROOT`**
⇒ 互相覆盖 / 读到对方写了一半的 `fleet.yaml` ⇒ 断言读出 `null`。

> ### ⛔ 判据：**验收命令自己不确定，等于没有验收。**
> 20% 的假失败率意味着：一次绿不能证明包是对的，一次红不能证明包是错的。
> 更坏的是**方向**——本缺陷只会假红不会假绿，所以它不会放过坏包，
> **但它会随机烧掉好包的 attempt 预算**，而失败现场看起来像「实现真的错了」。
>
> 同族记录（本 folder 已有多条）：**「工具自己静默失效并报告成功」的镜像版**——
> 这次是工具自己随机失败并报告实现有错。

---

## 1　交付

### 1.1 自然收敛（对应 A10 原 C5）

⛔ seed 触发被 claim 并执行完后**必须走到终态**，使得：
- 板面仍有非终态 clue ⇒ A9 的续投逻辑投出新触发 ⇒ 继续跑
- 板面全终态 ⇒ **不投** ⇒ 触发存储无可认领记录 ⇒ drain 以 **`reason === "drained"`** 退出

⛔ **不得**用「跑够 N 轮就停」「计时」「把 `max_passes` 调小」来伪造收敛 ——
收敛必须是**板面状态**确定性推出的结果。

### 1.2 ⛔ 渲染产物按次隔离（消灭 §0.2 的竞争）

⛔ `RUN_ID` 的缺省值必须**每次渲染唯一**，不得只到秒。
（本仓已有现成范式：`tick.md` 里 A9 用的 `$(date +%s%N)-$$`。）
⛔ 不得靠「测试串行执行」来回避（那是把并行度当成正确性的前提，且会拖慢验收）。
⛔ `DD_RUN_ID` / `DD_RUN_ROOT` 的显式覆盖语义**保持不变**（既有用例依赖它）。

### 1.3 ⛔ 写入预算不变
沿用 `--max-writes`（默认 5）、v1 冻结 channel 拒写、证据 channel 无默认值。

---

## 2　硬验收

> ⛔ **B1 与 B5 是本包不可替代的两条。** 前者证明「真的会自己停」，后者证明「验收本身可信」。

| # | 断言 | 怎么验 |
|---|---|---|
| **B1** | ⛔ **端到端真跑**：真实 `bin/deep-research-loop.sh` 跑完，drain 输出 **`reason === "drained"`** | 端到端跑，断言 JSON 字段；⛔ 不得打桩、⛔ 不得靠调小 `max_passes` |
| **B1-guard** | ⛔ **依赖缺失时 B1 不得静默通过** | 把 `LOOP_ENGINE_CLI` 指向不存在的路径 ⇒ 该用例**必须不是 pass**（响亮失败或 `it.skip` 显式标记）。⛔ 裸 `return` 不合格：上一轮实测「指向不存在路径仍 ✓」，与真跑通过完全同形 ⇒ 零功率却看起来被验证过 |
| **B2** | ⛔ 端到端：以 **`research:p02-smoke-1dce60.evidence`** 作 `EVIDENCE_CHANNEL` 真跑，跑完**回读该 channel**断言出现 `research.evidence.v2` 且条数 > 0 | 真跑后读 channel 断言；⛔ 不得用 `vi.stubGlobal` 打桩 fetch 替代 |
| **B3** | ⛔ 板面有非终态 clue ⇒ **仍继续投触发**（不能为了收敛而提前停） | 打桩板面，断言触发存储记录数增加 |
| **B4** | ⛔ 板面全终态 ⇒ **不投**（与 B3 只差板面内容，**判别对**） | 同上，断言记录数不变 |
| **B5** | ⛔ **同一秒内连续渲染两次，两次的 `RUN_ROOT` 必须不同** | 直接对渲染求值两次，断言路径不相等 |
| **B6** | ⛔ **并发渲染不互相污染**：并发跑 N(≥5) 次渲染，每次读回自己的 `fleet.yaml`，字段值须逐次正确 | 并发求值，⛔ 不得串行化 |
| **B7a** | ⛔ **只设 `DD_RUN_ID`、不设 `DD_RUN_ROOT`** ⇒ `RUN_ROOT` 必须落在该 id 上 | ⛔ 本条必须能被「让 `DD_RUN_ID` 覆盖失效」这一变异杀死（上一轮两例都设了 `DD_RUN_ROOT`，而它在 `bin/deep-research-loop.sh:25` 优先级更高 ⇒ 第 24 行 `DD_RUN_ID` 那一支从不决定 `RUN_ROOT` ⇒ N4 杀不掉任何用例，判据零功率） |
| **B7b** | ⛔ 同时设两者 ⇒ `DD_RUN_ROOT` 优先（与 B7a 构成判别对） | 显式传值断言落点 |
| **B8** | ⛔ **全量测试连跑 5 次，5 次全绿** | 跑 5 次记录 5 个退出码，全 0；⛔ **读退出码时命令后不得接管道** |
| **B9** | ⛔ A10a 的 C0–C4、A9 的 F0/F4/F6/F9/F10、A8f 的 F1/F5、A8e 的 H6/H7/H14 仍成立 | 原用例仍在且仍通过 |
| **B10** | ⛔ `--selfcheck` 仍保留且无副作用 | exit 0，零网络请求 |
| **B11** | ⛔ 不得触碰 `.dd-evidence/`；既有用例**一条不删** | `git diff` 无 `it(`/`test(` 净减少 |
| **B12** | typecheck + 全量测试 exit 0；证据写 `docs/dev-notes/<development_id>.md` | 仓根**无** `IMPLEMENTATION_SUMMARY.md` |

### 2.1 ⛔ B1/B2 的执行约束
- ⛔ **真机只允许打 `research:p02-smoke-1dce60`**（板）与 **`research:p02-smoke-1dce60.evidence`**（证据）。
  ⚠️ 后者是本 gate 于 2026-08-05 09:27Z **专为包级验收新建**的：fanout / public /
  `refs_required=false` / 未冻结 / 建时为空。**上一版 spec 要求「真实证据 channel 端到端」却把
  所有当时存在的 channel 全部排除（冻结前缀 / v1 保留 / 无 `.evidence` 兄弟），B2 按那个写法
  不可能完成 —— 那是 spec 作者的错。本版补上该前置条件，故 B2 不再放宽。**
  ⛔ **不得写 `research:v1-*`**（V1 的干净板面，由 gate 保留）
- 跑前跑后**记录消息数增量**写进 dev-notes；⛔ 增量须 ≤ `--max-writes`
- ⚠️ 证据 channel 必须**先核实存在**再用。**本版起 `research:p02-smoke-1dce60.evidence` 已存在**
  （2026-08-05 09:27Z 建），⛔ 但仍**不得靠字符串拼接推导 channel 名** —— 必须显式注入
  `EVIDENCE_CHANNEL`（A9 正是因此把默认值留空；「板名 + .evidence」在别的板上不成立）

---

## 3　变异自检

| 变异 | 必须杀死 |
|---|---|
| **N1** 收敛判定恒为「还有活」（永不收敛） | **B1** |
| **N2** 收敛判定恒为「没活了」（提前停） | **B3**（与 B4 构成判别对） |
| **N3** `RUN_ID` 改回秒级 | **B5 与 B6** |
| **N4** 让 `DD_RUN_ID` 显式覆盖失效 | **B7a**（⛔ 上一轮此变异杀不掉任何用例，因两例都设了 `DD_RUN_ROOT`）|
| **N5** 收割步不发布 evidence | **B2** |

> **破坏后必须回显被改的那一行**，跑完逐字还原并 `git diff --stat` 确认干净。

### 3.1 ⚠️ 变异纪律（本线每条各栽过一次，全部由「回显 + 核对该挂的是否真挂了」发现）
1. ⛔ **必须语义合法**：曾写 `return node` 而参数名是 `value` ⇒ 运行期错误炸掉整个模块，
   17 条挂 10 条 —— **看着功率很强，实际什么都没归因**。
2. ⛔ **必须命中语义位置**：曾把正则打在**接口的类型声明**上，而测试运行器**不做类型检查**
   ⇒ 全绿 ⇒ **「没测到」被误读成「实现是对的」**。
3. ⛔ **改「次序」必须真的移动**：曾只在前面**加**一个 CAS、保留后置那个
   ⇒ 该挂的断言依然成立。**「多做一次」和「换个时机做」是两种不同的破坏。**
4. ⛔ **N3 的特殊要求**：`RUN_ID` 竞争是**概率性**的，单跑一次可能假绿。
   变异后**必须连跑 ≥5 次**并断言至少一次失败，否则不算杀死。

### 3.2 其余纪律
- `describe` 块名不得枚举多个判据 ID；**安全性断言必须配活性断言**（B4 配 B3）。
- **两个只差一项输入的用例，才构成判别性证据**（B3/B4、B5 的两次渲染）。
- ⛔ **一条不变量在某一层被守住，不构成它在别的层也被守住**。
- ⛔ **无声截断 / 静默零结果 = 假装完成**。

---

## 4　非目标

- ⛔ **不改 `loop-engine` 仓**（共享仓，别的线在动；本包只改调用方）
- ⛔ **不注册 / 不修改任何协议**（`worker.result.v1` 已永久冻结）
- ⛔ **不实现 triage / synthesizer / debater**（属 R2）；不实现 `anchor-check`
- ⛔ **不改 `--add-dir` 的语义**：它**不是安全边界**（Bash 不受目录限制），
  用户已拍板「接受 worker 可读全盘，安全性移到凭证下发管控」
- ⛔ **不得为了让 B1/B2 通过而放宽任何既有守卫**（A10a 的 C2/C3、A8f 的 F5、A8e 的 H14 等）
- ⛔ **不得通过调小 `max_passes` 或缩短板面来「制造」收敛**

---

## 5　⛔ 派发面硬约束

- `setup_commands` 含 `npm ci`（本仓用 npm）
- ⚠️ **`loop-engine` 的 `dist/` 需可用**：本机 `/data/code/self/loop-engine` 处于 detached HEAD、
  落后 origin/main 且 `dist/` 残缺。⛔ **不得修改该共享仓的 checkout**；
  测试若需真实 CLI，用 `LOOP_ENGINE_CLI` 指向自建 worktree 的构建产物
  （`/data/worktrees/loop-engine-v1build` 已备好）。
- ⛔ **必须用 `bun` 跑 loop-engine CLI**：`cli.js` 用 extensionless import，
  `node` 会报 `ERR_MODULE_NOT_FOUND: .../dist/engine` —— **指向一个存在的文件、
  实则是解析器不兼容的误导性错误**（本线曾据此误判为「构建残缺」）。
- `.dd-evidence/` 是 dd 保留路径，actor 任何提交碰它都是硬失败；
  陈旧 `acceptance.json` 随 main 继承而来，**不该由本包修**。
- ⚠️ reviewer 若称「环境里没有某文件」可能是假阳性（其 harness 文件系统视图与宿主不同）。
- ⛔ 测试不得触网（真实 vault / MinerU）；⛔ 不得把真实 secret 值写进任何产物。

---

## 6　环境（均为本 gate 实测）

- `bun <loop-engine>/dist/cli.js drain <fleet> --label deep-research` **可用**；`node` 不可用
- `loop-store` 契约：`put '{"id","status":"open","body"}'` / `claim open done tick`，
  落盘 `<store_dir>/<id>.json` + `.events.jsonl`
- `TRIGGER_STORE_DIR` 已由 `bin/deep-research-loop.sh` 导出为 `$RUN_ROOT/stores/trigger`
- ⛔ **读退出码时命令后不得接管道**（`cmd | tail; echo $?` 拿到的是 `tail` 的退出码，本线犯过 5 次）
- ⛔ **对会增长的 channel 做存在性判断，必须先取 `head_seq` 再用 `after_seq` 从尾部倒查**：
  `limit=N` 返回的是**最早** N 条，`since_seq`/`from_seq`/`offset` **均被静默忽略**（本线犯过 2 次）
