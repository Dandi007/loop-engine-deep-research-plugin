# G12 —— deploy profile 的**最后一个键被生产加载器静默丢弃**

> 派发方：`line-deep-research`。仓库：`loop-engine-deep-research-plugin`。基线：main `f7a6158`。
> **Phase 6 终态验收时抓到，证据全部实测逐字。**

---

## 0　生产实况

`bin/deep-research-loop.sh` 加载 deploy profile 的实现：

```bash
  while IFS= read -r _line; do
    case "$_line" in
      ''|\#*) continue ;;
      *=*)
        _key="${_line%%=*}"
        _val="${_line#*=}"
        if [ -z "${!_key+x}" ]; then
          export "$_key=$_val"
        fi
        ;;
    esac
  done < "$PROFILE_FILE"
```

而 `profiles/deploy/agent-harness.env` **没有结尾换行**（派发方实测）：

```
$ tail -c 3 profiles/deploy/agent-harness.env | xxd
00000000: 756c 74                                  ult          # = "ult"，无 \n
$ tail -1 profiles/deploy/agent-harness.env
EXPORT_ROOT=/data/vault                                          # 紧接文件结束
```

⇒ `while IFS= read -r _line` 在**读到没有结尾换行的最后一行时返回非零**，循环体**不执行**
⇒ **`EXPORT_ROOT` 从未被 profile 加载过。**

### ⛔ 后果（已实际发生）

生成段跑到导出步时逐字得到：

```
G4c: EXPORT_ROOT is not configured. Refusing to silently skip the export.
```

即：**四个 debater/synthesizer agent 全部成功、report 已发布到 bus，但导出件永远产不出来。**
而 `bin/deep-research-loop.sh` 走 loop-engine，**tick 的非零退出会被吞掉**（本线记为 G11：
`errors: 0` / `drained` / `exit 0`，exit code 与 stderr 无处留痕）⇒ **这个丢键在生产上完全不可见。**

> **这不是「最后一行恰好是 EXPORT_ROOT」的巧合问题**：任何 deploy profile 的**最后一个键**
> 都会被丢，且**换研究、加新键时会静默换一个键被丢**。

---

## 1　要做什么（两处，缺一不可）

### 1.1 加载器加末行兜底（根因）

```bash
  while IFS= read -r _line || [ -n "$_line" ]; do
```

`|| [ -n "$_line" ]`：`read` 因 EOF 返回非零、但 `$_line` 仍持有最后一行内容时，循环体照常执行。
⛔ **这是根因修复，必须做** —— 只给文件补换行等于把坑留给下一个 profile。

### 1.2 给现有 profile 补结尾换行（纵深防御）

`profiles/deploy/agent-harness.env` 末尾补一个 `\n`。
⛔ **只做 1.2 不做 1.1 判不通过。**

### ⛔ 不要顺手做的事

- ⛔ **不要给 profile 里的值加引号**。该 `.env` 是 **dotenv 风格**，加载器用 `${_line%%=*}` / `${_line#*=}` 逐行取值，
  **不是 `source`**。`RESEARCH_QUESTION=agent harness`（含空格、无引号）在该解析器下是**正确的**；
  若改成 `RESEARCH_QUESTION="agent harness"`，值会**连字面引号一起**被取走而坏掉。
  （派发方走过这个弯路：用 `set -a; . file` 加载时该键为空，差点误判成 profile 缺陷。）
- ⛔ 不要改 profile 里任何键的**值**。
- ⛔ 不要改 `G4c: EXPORT_ROOT is not configured` 那条响亮失败——**它是对的**，正是它暴露了本缺陷。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **Z1** | ⭐ **判别性**：构造一个**无结尾换行**的临时 profile，其最后一行是某个键 ⇒ 加载后该键**有值** | 驱动真实加载逻辑（见 Z4），断言该键等于期望值 |
| **Z2** | ⛔ **含空格且无引号的值不被破坏**：`RESEARCH_QUESTION=agent harness` ⇒ 值逐字为 `agent harness`（不含引号、不截断） | 断言字符串相等 |
| **Z3** | **显式 env 优先语义不变**：已显式设置的键不被 profile 覆盖（`[ -z "${!_key+x}" ]` 那条） | 正反两例 |
| **Z4** | ⛔ **断言打在真实加载路径上**：直接执行 `bin/deep-research-loop.sh --dry-run --profile <临时 profile>` 并检查渲染出的 `fleet.yaml`，或以等价方式驱动 bin 中那段真实代码。⛔ **在测试里重写一份加载逻辑再断言不算数**；⛔ **源码字符串匹配不构成证据** | 说明你用的驱动方式 |
| **Z5** | `profiles/deploy/agent-harness.env` 以换行结尾 | `tail -c 1 <file> \| xxd` 输出应为 `0a` |
| **Z6** | 全量 `npx vitest run` 在干净环境真绿。基线：main `f7a6158` **派发方实测 30 files / 509 tests**，终值两项均不得低于基线 | ⛔ 贴本次运行的完整尾部（`Test Files` / `Tests` 两行 + 有无 FAIL 段） |
| **Z7** | **可达性声明**：Z1–Z3 每条**指名唯一那条会在该行为回归时失败的用例**，一两句说明为什么缺该行为就不可能通过 | dev-note |
| **Z8** | 工作树干净 | ⛔ 贴 `git status --porcelain \| wc -l` 的输出（应为 `0`）。⛔ **不要贴 `git status --porcelain` 本身**——干净时它无输出，空块与遗漏不可区分 |

---

## 3　⛔ 关于变异自检：本包不要求你自报，也不要编造

**实测变异由派发方在 gate 亲手施加**（本线每个包都是这么做的）。
你只需给 Z7 的**可达性声明** —— 一个可被评审读代码核实的声明。
⛔ 不要写「实测 / 被杀 ✓」这类字样，除非你真做了并能贴出被改行与失败输出。
**写不出就如实写「未实测，理由：见可达性声明」——这不扣分。**

---

## 4　⛔ 派发方已付的学费（本包直接相关）

1. **判据必须先被证明「在验收环境里可满足」**。本线已为此付过三次代价：
   要求为 bun 下不可观测的 EPIPE 写判别性用例；要求贴一个成功时无输出的命令的输出；
   要求某用例走一条依赖 bus 的路径而验收沙箱无 bus。
   ⇒ 本包的 Z1–Z5 派发方均已确认可满足（末行兜底、dotenv 取值、`--dry-run` 渲染均实测过）。
2. ⛔ **源码字符串匹配一律不构成证据**；⛔ **在测试里重写一份被测逻辑再断言等于没测**。
3. **dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit**，不是 H0 提交。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 给 profile 的值加引号 | §1 已说明：该解析器下会把引号并入值 |
| 改任何键的值 | 归部署方，且与本缺陷无关 |
| 改 `G4c` 的响亮失败 | 它是对的，正是它暴露了本缺陷 |
| 修 loop-engine 吞掉 tick 失败（G11） | 不同仓，独立发现，本包不碰 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |

---

## 6　交付物落点

- 实现：`bin/deep-research-loop.sh`（末行兜底）、`profiles/deploy/agent-harness.env`（补结尾换行）
- 测试：`test/g12-profile-last-line.test.ts`（Z1–Z4）
- 证据：`docs/dev-notes/dev_ledr_g12_profile_last_line_01.md`（Z1–Z8 逐条 + §3 可达性声明 +
  本次运行的全量测试尾部 + `git status --porcelain | wc -l` 输出 + `tail -c 1 | xxd` 输出）
