# dev_ledr_g8v2_role_argv_01

- **input_commit**: `0afb589e19cf22d90482973fd39d4325dc3158b8`

## V1 — argv 不含 `--route`

`buildGenerateRoleArgv` 不再拼接 `--route` 及其值。直接调用纯函数，断言返回数组不含 `--route`。

```ts
import { buildGenerateRoleArgv } from "../src/generate";
const argv = buildGenerateRoleArgv({
  agentRunBin: "/fake/agent-run",
  role: "dr-debater-advocate",
  runId: "run-1",
  inputPath: "/tmp/input.json",
  promptFile: "/tmp/prompt.txt",
});
expect(argv).not.toContain("--route");
expect(argv).toContain("--role");
expect(argv).toContain("--run-id");
expect(argv).toContain("--input");
expect(argv).toContain("--prompt-file");
```

- **可达性声明**：`test/g8-role-argv.test.ts` 中的 `G8 V1: argv does not contain --route` 用例。该用例直接调用 `buildGenerateRoleArgv` 纯函数，断言 `argv` 不含 `--route`。若有人在 argv 中恢复 `--route` 拼接，该用例会因 `not.toContain("--route")` 失败——因为数组里会出现 `"--route"` 这个字符串。

## V2 — 四个 role 全覆盖

advocate / opponent / judge / synthesizer 各一条独立用例（参数化循环）。

- **可达性声明**：`test/g8-role-argv.test.ts` 中 `G8 V2: all four roles covered` 的四个参数化用例。每个用例断言对应 role 的 argv 不含 `--route` 且含必要标志。若任何 role 的 argv 被错误修改（如缺少 `--prompt-file`），对应用例的 `toContain` 断言会失败。

## V3 — 无死字段

`GenerateRoleSpec` 删除了 `route: string` 字段。全仓 grep 无悬空引用：

- `src/generate.ts:25` — `GenerateRoleSpec` 现仅含 `role: string`
- `DEFAULT_GENERATE_CONFIG` 中 debater 与 synthesizer 均不再写 `route`
- `assertDistinctDebaterRoles` 改为校验 role 名互不重复（不再校验 route）
- `buildGenerateRoleArgv` 不再接收 `route` 参数
- `spawnGenerateRole` 不再接收 `route` 参数
- `GenerateDeps.spawnRole` 签名不再含 `route`
- 已删除的 `route` 字段无任何消费者

**必要性说明**：`route` 字段的唯一消费者是 `buildGenerateRoleArgv`（拼进 `--route` flag）。去掉 `--route` 后，`route` 失去所有消费者，成为死字段。依本仓纪律（G4d 对 `anchorCheckRoute` 亦如此），死字段必须删除，避免两处真相（role YAML 与 GenerateConfig 的 route 值可能漂移）。

## V4 — triage argv 保持原样

triage argv 未改动。`src/tick-run.ts` 中的 `buildTriageArgv` 不变，`test/g7-prompt-file.test.ts` 中 T2/T3/T4/T6-b 的 triage 断言全部通过（11 tests passed）。

## V5 — 可达性声明

见 V1–V4 各条。

## V6 — 全量测试

```text
 Test Files  29 passed (29)
      Tests  501 passed (501)
   Start at  10:26:11
   Duration  7.11s (transform 1.34s, setup 0ms, collect 4.30s, tests 23.14s, environment 9ms, prepare 5.35s)
```

基线 main `4836cf6` 实测 28 files / 498 tests。本次 29 files / 501 tests，两项均不低于基线。

## V7 — git status

```text
（见下方 commit 前 git status 输出）
```

## V8 — 删除必要性说明

| 删除项 | 必要性 |
|---|---|
| `GenerateRoleSpec.route` | 失去消费者（`buildGenerateRoleArgv` 不再拼 `--route`），死字段，留之即两处真相 |
| `DEFAULT_GENERATE_CONFIG` 中各 role 的 `route` 值 | 同上，role YAML 已是唯一真相 |
| `assertDistinctDebaterRoutes` → `assertDistinctDebaterRoles` | 原函数校验 route 互不重复，route 字段删除后，改为校验 role 名互不重复 |
| `buildGenerateRoleArgv` 的 `route` 参数及 `--route` flag | 根因：传入 `--route` 而不传 `--runtime` 导致 agent-run 报 CONFIG_ERROR（spec §0.1） |
| `spawnGenerateRole` 的 `route` 参数 | 逐层传递的死参数，必须随调用链删除 |
| `GenerateDeps.spawnRole` 的 `route` 参数 | 同上 |
| `test/generate.test.ts` 中 G2a D3 测试段 | 该段读取 `cfg.debaters[].route` / `cfg.synthesizer.route`，route 字段已删除，无可测试 |
| `test/generate.test.ts` 中 `agentRoleRoute` 函数 | 唯一调用者（D3 测试段）已删除 |
| `test/generate.test.ts` 中 `yaml` import | 唯一使用者（`agentRoleRoute`）已删除 |
| `src/tick-run.ts` 中 `spawnGenerateRole` import | tick-run.ts 不再直接调用 `spawnGenerateRole`（由 `runGenerate` 内部通过 `spawnRole` 间接调用） |
| `test/g7-prompt-file.test.ts` 中 `buildGenerateRoleArgv` import | 该文件不直接调用 `buildGenerateRoleArgv`，仅通过 `spawnGenerateRole` 间接调用 |

## §0.1 四行档位表

| role | runtime | route |
|---|---|---|
| `dr-debater-advocate` | `opencode` | `opus-4-8/ccs` |
| `dr-debater-opponent` | `opencode` | `gpt-5.6-sol/ccs` |
| `dr-debater-judge` | `opencode` | `ds-v4-pro/ccs` |
| `dr-synthesizer` | `opencode` | `opus-5/ccs` |

role YAML 已自带 runtime + route，与 golden-order 拍死的档位逐字一致。调用方传 `--route` 既冗余又非法。