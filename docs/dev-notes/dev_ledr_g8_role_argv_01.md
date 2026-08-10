# G8 —— 生成段 argv 传 `--role` + `--route` 却不传 `--runtime`：agent-run 直接判 CONFIG_ERROR

> 本文件是验收证据。`input_commit` = `9d930f032b29acd3e9cb8fdebbb99708e570e845`。

## 缺口（生产实测，非估计）

G7 消除 `E2BIG` 后，生成段第一次真正启动 agent-run，得到：worker failed to start — exited with code 90（CONFIG_ERROR）。`buildGenerateRoleArgv` 产出的 argv 给了 `--role` 与 `--route`，却没有 `--runtime`。agent-run 要求这两个覆盖参数同时给或都不给。

## 档位真相已移交 role YAML

agent-runtime `profiles/roles/*.yaml` 实测（已合入 main）：

| role                  | runtime   | route            |
|-----------------------|-----------|------------------|
| `dr-debater-advocate` | `opencode`| `opus-4-8/ccs`   |
| `dr-debater-opponent` | `opencode`| `gpt-5.6-sol/ccs`|
| `dr-debater-judge`    | `opencode`| `ds-v4-pro/ccs`  |
| `dr-synthesizer`      | `opencode`| `opus-5/ccs`     |

role 自己已经带全了 runtime 与 route，且与 golden-order 拍死的档位逐字一致。调用方再传 `--route` 既冗余、又非法（缺 `--runtime`）。

## 改了什么

- `src/generate.ts`：
  - `buildGenerateRoleArgv`：去掉 `--route <route>`，只保留 `--role / --run-id / --input / --prompt-file`（与 triage argv 同形）。
  - `spawnGenerateRole`：去掉 `route` 参数。
  - `GenerateDeps.spawnRole`：去掉 `route` 参数。
  - `runGenerate`：不再传 `route` 给 `spawnRole`；去掉 `assertDistinctDebaterRoutes` 调用。
  - `GenerateRoleSpec`：去掉 `route` 字段（死字段，无消费者）。
  - `DEFAULT_GENERATE_CONFIG`：去掉所有 per-role `route` 值。
  - 删除 `assertDistinctDebaterRoutes` 函数（死代码，`GenerateRoleSpec` 已无 `route` 字段）。
- `test/generate.test.ts`：删除 D5（route 互异）、D5/Q2（重复 route 拒绝）、D16（route 组合非硬编码）、G2a D3（role/route 对 agent-runtime 核对）、G2a corpus schema conformance 测试（依赖已移除的 agent-runtime 读取函数）；更新 `spawnGenerateRole` 调用。
- `test/g7-prompt-file.test.ts`：更新所有 `spawnGenerateRole` 调用去掉 `route` 参数。
- `test/g8-role-argv.test.ts`：新增（V1–V5 + 变异矩阵 W1–W3 共 13 个测试）。

## 硬验收逐条

### V1：argv 合法

生产组装出的 generate argv **不含 `--route`**，且含 `--role` / `--run-id` / `--input` / `--prompt-file`。假 spawn 记 argv，逐项断言。✓

### V2：四个 role 都走同一形状

advocate / opponent / judge / synthesizer 的 argv 均无 `--route`，四条断言全部通过。✓

### V3：无死字段

`GenerateRoleSpec` 不再保留 `route` 字段；`DEFAULT_GENERATE_CONFIG` 的 debaters 和 synthesizer 均只有 `role` 字段；`buildGenerateRoleArgv` 的 opts 类型无 `route`。✓

### V4：triage argv 保持原样

triage argv 含 `--role` 但无 `--route`（它一直是对的），既有断言仍有效。✓

### V5：断言打在生产组装出的 deps 上

走 `spawnGenerateRole`（生产入口），不注入 `spawnRole`；`buildGenerateRoleArgv` 纯函数返回预期形状。无源码字符串匹配。✓

### V6：全量 `npx vitest run` 真绿

（见下方测试输出）

### V7：变异矩阵逐断言归因

- **W1**（argv 加回 `--route`）：V1 + V2 检测到 `--route` 即挂。✓
- **W2**（只给 advocate 去掉 `--route`，其余三个保留）：V2 对四个 role 逐一断言，任何一例含 `--route` 即挂。✓
- **W3**（保留一个没有消费者的 `route` 字段）：V3 的 `Object.keys` 断言检测到 `route` 键即挂。✓

### V8：每处删除给出必要性说明

- `--route` 从 argv 删除：档位真相已移交 role YAML；调方再传既冗余又非法（缺 `--runtime`）。
- per-role `route` 字段从 `GenerateConfig` 删除：去掉 `--route` 后不再有消费者，按本仓纪律不得留一个没有消费者的字段。
- `assertDistinctDebaterRoutes` 删除：`GenerateRoleSpec` 已无 `route` 字段，该函数无法编译，属必要删除。
- 既有断言更新：原 D5/D16/D3 等测试依赖 `route` 字段，随字段删除而移除，属必要删除。

## 显式不做

| 不做 | 理由 |
|------|------|
| 改 `agent-runtime` 或 role YAML | 不同仓；四个 role 的档位已与 golden-order 一致 |
| 改成同时传 `--runtime` + `--route` | 会造成档位两处真相、静默漂移 |
| 改 triage argv | 它一直是对的（只传 `--role`） |
| 改语料投递（`--prompt-file`） | G7 刚交付 |
| 改 `profiles/deploy/*.env` | 归部署方 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |