# G14 —— anchor-check 用非零退出码表达**结果**，生产却当成崩溃：核验率与 `anchor-check.json` 双双丢失

> 派发方：`line-deep-research`。仓库：`loop-engine-deep-research-plugin`。基线：main `4fe0eb5`。
> **Phase 6 权威轮真跑抓到，证据全部实测逐字。**

---

## 0　生产实况

配置齐全的权威轮（`TICK_EXIT=0`，四个 role 全成功，导出件已落盘 51 081 字节）产出的报告头部：

```
<!-- dr-anchor-rate unavailable -->
```

且 `<EXPORT_ROOT>/DeepThought/agent-harness/` 下**只有 `.md`，没有 `anchor-check.json`**。

### 派发方实测：anchor-check 本身完全正常

```
$ /data/.../anchor-check.py --corpus <424 条语料> --repo-root /data/code/self/agent-runtime --json
{"total":424,"current_parsed":424,"current_verified_hit":408,"current_failed":16,
 "old_format":0,"unparseable":0,"discarded":0,"sums_ok":true,"loud_failures":[]}
$ echo $?
1                                  ← ⭐ 退出码 1，但 stdout 是完全有效的 JSON（198 字节）
wall=1.13s                         ← 远未触及 timeout: 30000
```

**核验率 = 408 / 424 = 96.23%**（≥ 90%，软闸门本应通过）。

### 退出码是**有意设计的结果语义**，不是崩溃信号

`anchor-check.py:226-237` 自带注释：

```
0  → 无响亮失败 且 无现行格式未命中
1  → 有现行格式引文未命中（校验失败）
2  → 有响亮失败（缺 repo-root / fetcher 取不到 / 形态不合理）
3  → 三类计数之和与输入条数不符（静默丢弃）
```

## 0.1　根因（定位到行号）

`src/tick-run.ts:1354-1362`：

```ts
const stdout = execFileSync(anchorCheckBin, [...], { encoding:"utf8", stdio:["ignore","pipe","pipe"], timeout:30000 });
return JSON.parse(stdout) as AnchorCheckResult;
```

`execFileSync` **对任何非零退出都抛错**。派发方直接复现：

```
THROW -> Command failed: … | status 1 | e.stdout 长度 198     ← 有效 JSON 就在 e.stdout 里，被丢弃
```

`src/generate.ts:458-463` 的 catch：

```ts
} catch (e) {
    if (e instanceof MissingAnchorCheckRepoRootError) { anchorTail = "no-repo-root"; }
    // 失败不得阻断导出；anchorRate 保持 null → 头部标 unavailable。
}
```

⇒ **除 `no-repo-root` 外，真实错误被整个吞掉**，`unavailable` 无法区分「崩溃 / 超时 / 退出码非零 / JSON 解析失败」。

### ⛔ 后果（三条，权威轮全部实测到）

1. `anchorRate` 恒 null ⇒ 报告头标 `unavailable` 而非 **96.23%** ⇒ **软闸门拿不到真实核验率**；
2. `anchorCheckJson` 恒 null ⇒ `if (anchorCheckJson !== null …)` 不成立 ⇒ **`anchor-check.json` 永不写出**；
3. catch 不留 tail ⇒ **不可诊断**。

> ### ⛔ 触发条件是「**任何一条 anchor 未命中**」
> 只有 100% 全命中的语料才能拿到退出码 0。**任何真实研究都会撞上。**

### ⛔ 连带死码（同一根因）

`src/generate.ts:452-454` 有分支：

```ts
} else if (!ac.sums_ok) { anchorTail = "sums_ok=false"; }
```

**该分支今天永远走不到** —— `sums_ok=false` ⇒ 工具 exit 3 ⇒ `execFileSync` 抛错 ⇒ 直接进 catch。

---

## 1　要做什么

`spawnAnchorCheck` 改为**按「stdout 能否解析成合法 JSON」判定成败，而不是按退出码**：

| 情况 | 行为 |
|---|---|
| 退出码 **0 或 1**，stdout 是合法 JSON | ⭐ **正常返回该结果**（1 = 有引文未命中，是**正常结果**，核验率照常计算） |
| 退出码 **2 或 3**，stdout 是合法 JSON | **仍返回该结果**（交由 `generate.ts` 既有分支处理：`total===0` / `!sums_ok`），并让失败原因可见（见下） |
| stdout **不是**合法 JSON（含超时、二进制缺失、真崩溃） | ⛔ **抛错**，且错误信息**点名退出码与 stderr 尾部** |

实现要点：`execFileSync` 抛出的错误对象上带 **`e.stdout`**（派发方实测：`status 1`、`e.stdout` 长度 198）。
捕获后优先尝试解析 `e.stdout`；解析成功即视为拿到结果。

### 同时修掉静默吞异常（`src/generate.ts` 的 catch）

⛔ **不得再无声吞掉**：非 `MissingAnchorCheckRepoRootError` 的失败也必须写进 `anchorTail`
（例如 `anchor-check-failed:<原因简述>`），使 `unavailable` 的成因**在报告头上可诊断**。
⛔ 仍保持软闸门语义：**anchor-check 失败不得阻断导出**。

### ⛔ 必须保住的既有语义

- ⛔ 软闸门：核验率 < 90% **仍导出**，只是标在头部（golden-order 拍死）。
- ⛔ `total === 0` ⇒ `unavailable`，**不得**当成「全部核验通过」。
- ⛔ 核验率分母必须是 `total`，⛔ 不得用 `current_parsed`。
- ⛔ 崩溃与真实 0% 必须可区分。

---

## 2　硬验收（缺一不可）

| # | 判据 | 怎么验 |
|---|---|---|
| **V1** | ⭐ **退出码 1 + 合法 JSON ⇒ 正常结果**：核验率按 `current_verified_hit/total` 算出具体数字，报告头**不是** `unavailable` | 用一个**假二进制**（shell 脚本：打印固定 JSON 后 `exit 1`）驱动生产 `spawnAnchorCheck`；⛔ 这是本包的存在理由 |
| **V2** | ⭐ **`anchor-check.json` 被写出**，内容等于该 JSON | 断言写入路径与内容 |
| **V3** | ⛔ **退出码 2/3 + 合法 JSON ⇒ 仍返回结果**，且 `sums_ok=false` 时头部带 `sums_ok=false`（今天不可达的分支必须变为可达） | 假二进制 exit 3 且 `sums_ok:false` |
| **V4** | ⛔ **stdout 非合法 JSON ⇒ 响亮失败**，错误/tail **点名退出码**；且**导出仍照常发生**（软闸门不得被削弱） | 假二进制打印非 JSON 后非零退出；断言导出被调用 |
| **V5** | ⛔ **退出码 0 的既有行为逐字不变** | 回归断言 |
| **V6** | ⛔ **断言打在生产组装出的 deps 上**（`assembleGenerateDeps` 已导出）；⛔ 自建 runtime 注入不算数；⛔ 源码字符串匹配不构成证据 | 照 G5/G6/G7/G10 已交付做法 |
| **V7** | 全量 `npx vitest run` 干净环境真绿。基线：main `4fe0eb5` **派发方实测 527 tests**，终值不得低于基线 | ⛔ 贴本次运行完整尾部（`Test Files` / `Tests` 两行 + 有无 FAIL 段） |
| **V8** | **可达性声明**：V1–V5 每条指名唯一会失败的用例 + 一两句「为什么缺该行为就不可能通过」。⛔ 必须对**生产路径**成立 | dev-note |
| **V9** | 工作树干净 | ⛔ 贴 `git status --porcelain \| wc -l` 的输出（应为 `0`）。⛔ 不要贴 `git status --porcelain` 本身——干净时它无输出，空块与遗漏不可区分 |

---

## 3　⛔ 关于变异自检：本包不要求你自报，也不要编造

**实测变异由派发方在 gate 亲手施加。** 你只需给 V8 的**可达性声明**（可被评审读代码核实）。
⛔ 不要写「实测 / 被杀 ✓」，除非你真做了并能贴出被改行与失败输出。
**写不出就如实写「未实测，理由：见可达性声明」——这不扣分。**

---

## 4　⛔ 派发方已付的学费

**判据必须先被证明「可满足」才能写进硬验收。** 本线已为此付过五次代价
（不可观测的 EPIPE；成功时无输出的命令；依赖 bus 而沙箱无 bus 的路径；载荷里根本没有的 role 字段；
以及本包的前身——把退出码当崩溃）。

⇒ 本包 V1–V5 派发方已确认可满足：用**一个几行的 shell 假二进制**（`echo '<json>'; exit N`）
即可驱动生产 `spawnAnchorCheck` 的全部分支，**不依赖网络、不依赖真实语料**。
派发方已用 `node -e` 实测 `execFileSync` 在 `status 1` 时抛错且 `e.stdout` 长度 198（有效 JSON）。

其余：⛔ 源码字符串匹配不构成证据；⛔ 测试里重写一份被测逻辑再断言等于没测；
dev-note 的 `input_commit` 记 dd 交给你的那个 attempt 的 input_commit，不是 H0 提交。

---

## 5　显式不做

| 不做 | 理由 |
|---|---|
| 改 `anchor-check.py` 的退出码 | 不同仓；且其退出码语义是**有意设计且自带文档**的，错的是消费方 |
| 改软闸门阈值或「<90% 仍导出」 | golden-order 拍死 |
| 改核验率公式（分母 `total`） | 既有纪律 |
| 把 anchor-check 失败改成阻断导出 | 违反软闸门 |
| 改 `timeout: 30000` | 实测 1.13 s，与本缺陷无关；⛔ 不要顺手动 |
| 修 loop-engine 吞 tick 失败（G11）/ 生成段恢复（G13v2） | 独立发现，各自独立推进 |

---

## 6　交付物落点

- 实现：`src/tick-run.ts`（`spawnAnchorCheck` 按 stdout 可解析性判定）、`src/generate.ts`（catch 不再静默吞）
- 测试：`test/g14-anchor-exit-code.test.ts`（V1–V6）
- 证据：`docs/dev-notes/dev_ledr_g14_anchor_exit_code_01.md`（V1–V9 逐条 + §3 可达性声明 +
  本次运行的全量测试尾部 + `git status --porcelain | wc -l` 输出）
