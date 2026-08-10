# G12 —— deploy profile 的最后一个键被生产加载器静默丢弃

development_id: `dev_ledr_g12_profile_last_line_01`
attempt: `implement`（initial）
input_commit: `fba1f60b08683351119d4d8f588589a2af6c3d15`

## 结论先行

`bin/deep-research-loop.sh` 的 profile 加载循环 `while IFS= read -r _line` 在读到无结尾换行的
最后一行时返回非零，循环体不执行 ⇒ 最后一个键被静默丢弃。修复：`while IFS= read -r _line || [ -n "$_line" ]`。
纵深防御：`profiles/deploy/agent-harness.env` 末尾补 `\n`。

## 产品改动

- **`bin/deep-research-loop.sh`**：`while IFS= read -r _line; do` → `while IFS= read -r _line || [ -n "$_line" ]; do`（第 47 行）
- **`profiles/deploy/agent-harness.env`**：末尾补结尾换行（`\n`）
- **`test/g12-profile-last-line.test.ts`**（新增 4 条）：Z1–Z4

## 硬验收（spec §2 逐条）

| # | 判据 | 结果 |
|---|---|---|
| **Z1** | 判别性：无结尾换行的临时 profile，最后一行是某个键，加载后该键有值 | PASS。`test/g12-profile-last-line.test.ts` Z1：创建无结尾换行的临时 profile（`TICK_CHANNEL` 为末行），`--dry-run` 渲染后断言 `tick_channel` 等于该值 |
| **Z2** | 含空格且无引号的值不被破坏：`RESEARCH_QUESTION=agent harness` ⇒ 值逐字为 `agent harness` | PASS。Z2：读取 `agent-harness` profile 的 `RESEARCH_QUESTION` 字段，值为 `agent harness`（无引号、无截断）；`--dry-run` 渲染后断言 `input.research_question === "agent harness"` |
| **Z3** | 显式 env 优先语义不变：已显式设置的键不被 profile 覆盖 | PASS。Z3：正例——显式设置 `TICK_CHANNEL=research:explicit-override.index`，断言渲染值等于显式值（非 profile 值）；反例——不设显式值时，断言渲染值等于 profile 值 |
| **Z4** | 断言打在真实加载路径上：直接执行 `bin/deep-research-loop.sh --dry-run --profile <临时 profile>` | PASS。所有 Z1–Z3 用例均通过 `execFileSync("bash", [BIN, "--dry-run"], ...)` 执行真实 bin 脚本，解析渲染出的 `fleet.yaml` 的 `tick` pipeline input |
| **Z5** | `profiles/deploy/agent-harness.env` 以换行结尾 | PASS。`tail -c 1 profiles/deploy/agent-harness.env | xxd` 输出 `0a` |
| **Z6** | 全量 `npx vitest run` 在干净环境真绿 | PASS。31 files / 513 tests（基线：30 files / 509 tests，终值均不低于基线） |
| **Z7** | 可达性声明 | 见 §3 |
| **Z8** | 工作树干净 | PASS。`git status --porcelain | wc -l` 输出 `0`（见 §4） |

## 可达性声明（§3）

| 用例 | 唯一会因该行为回归而失败的用例 | 为什么缺该行为就不可能通过 |
|---|---|---|
| **Z1** | `test/g12-profile-last-line.test.ts` > `Z1: last-line key in a profile without trailing newline is loaded` > `profile without trailing newline: last-line key TICK_CHANNEL is loaded` | 该用例构造一个无结尾换行的临时 profile，`TICK_CHANNEL` 为末行。若 `while IFS= read -r _line` 无 `|| [ -n "$_line" ]` 兜底，末行不会被读入循环体，`TICK_CHANNEL` 不会被 export，渲染出的 `tick_channel` 为空，断言 `expect(input.tick_channel).toBe(LAST_LINE_CHANNEL)` 失败。 |
| **Z2** | `test/g12-profile-last-line.test.ts` > `Z2: space-containing unquoted value is preserved verbatim` > `RESEARCH_QUESTION=agent harness renders as 'agent harness' (no quotes, no truncation)` | 该用例断言 `agent-harness` profile 的 `RESEARCH_QUESTION=agent harness`（含空格、无引号）渲染后值逐字为 `agent harness`。若有人给 profile 值加引号，`${_line#*=}` 会把引号一并取走造成值不等于 `agent harness`；若有人改用 `source` 加载，含空格无引号的值会因 bash 分词而截断或为空。 |
| **Z3** | `test/g12-profile-last-line.test.ts` > `Z3: explicit env precedence over profile is preserved` > `explicit TICK_CHANNEL beats profile value` | 该用例显式设置 `TICK_CHANNEL=research:explicit-override.index`，断言渲染值等于显式值而非 profile 值。若有人破坏 `[ -z "${!_key+x}" ]` 的显式优先检查（例如改为无条件覆盖），断言 `expect(input.tick_channel).toBe("research:explicit-override.index")` 失败。 |

## 全量测试尾部

```
 Test Files  31 passed (31)
      Tests  513 passed (513)
```

## 验证输出

```
$ tail -c 1 profiles/deploy/agent-harness.env | xxd
00000000: 0a                                       .
```

```
$ git status --porcelain | wc -l
0
```