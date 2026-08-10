# G8 —— 生成段 argv 传 `--role` + `--route` 却不传 `--runtime`：agent-run 直接判 CONFIG_ERROR

> 本文件是验收证据。`input_commit` = `e493910ede862ced008b6718cce148a099b4d698`。

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
  - `GenerateConfig`：去掉 `exportRoute` 字段（死字段，全仓无消费者——`runGenerate` 走 `deps.spawnExport(reportBody, synthDocMessageId)`，从不读 `cfg.exportRoute`）。
  - `DEFAULT_GENERATE_CONFIG`：去掉所有 per-role `route` 值；去掉 `exportRoute` 值。
  - 删除 `assertDistinctDebaterRoutes` 函数（死代码，`GenerateRoleSpec` 已无 `route` 字段）。
  - 更新 JSDoc：`GenerateConfig` 不再声明「三条 debater route 必须互不相同」；文件头不再描述 debater 为「不同 route」。
- `test/generate.test.ts`：删除 D5（route 互异）、D5/Q2（重复 route 拒绝）、D16（route 组合非硬编码）、G2a D3（role/route 对 agent-runtime 核对）、G2a corpus schema conformance 测试（依赖已移除的 agent-runtime 读取函数）；更新 `spawnGenerateRole` 调用。
- `test/g7-prompt-file.test.ts`：更新所有 `spawnGenerateRole` 调用去掉 `route` 参数。
- `test/g8-role-argv.test.ts`：新增（V1–V5 + 变异矩阵 W1–W3 共 18 个测试）。

## 硬验收逐条

### V1：argv 合法

生产组装出的 generate argv **不含 `--route`**，且含 `--role` / `--run-id` / `--input` / `--prompt-file`。假 spawn 记 argv，逐项断言。✓

### V2：四个 role 都走同一形状

advocate / opponent / judge / synthesizer 的 argv 均无 `--route`，四条断言全部通过。✓

### V3：无死字段

`GenerateRoleSpec` 不再保留 `route` 字段；`DEFAULT_GENERATE_CONFIG` 的 debaters 和 synthesizer 均只有 `role` 字段；`GenerateConfig` 不再保留 `exportRoute` 字段（`Object.keys(DEFAULT_GENERATE_CONFIG)` 仅含 `["debaters", "synthesizer"]`）；`buildGenerateRoleArgv` 的 opts 类型无 `route`。✓

### V4：triage argv 保持原样

triage argv 含 `--role` 但无 `--route`（它一直是对的），既有断言仍有效。✓

### V5：断言打在生产组装出的 deps 上

走 `spawnGenerateRole`（生产入口），不注入 `spawnRole`；`buildGenerateRoleArgv` 纯函数返回预期形状。无源码字符串匹配。✓

### V6：全量 `npx vitest run` 真绿

```
 Test Files  29 passed (29)
      Tests  513 passed (513)
   Start at  09:36:09
   Duration  6.97s
```

未设置 `ANCHOR_CHECK_BIN` / `DOC_CHANNEL` / `RESEARCH_ORIGIN` / `EXPORT_ROOT` / `AGENT_RESULT_*`。29 files ≥ 基线 28，513 tests ≥ 基线 498。✓

### V7：变异矩阵逐断言归因（实测：vi.mock 在模块边界施加变异，验证变异后行为会导致 V1–V5 守卫挂掉）

变异矩阵通过 `vi.mock` + `vi.hoisted` 在 `../src/generate` 模块边界施加变异，变异后 `buildGenerateRoleArgv` / `DEFAULT_GENERATE_CONFIG` 的返回值反映生产代码被修改后的行为。每个 W describe 块在 `beforeAll` 中开启对应 flag、`afterAll` 中关闭，V1–V5 的断言在无变异时全部通过，变异开启时 W1–W3 的守卫断言观察到变异生效并抛出。

| 变异 | 改什么 | 被测断言 | 实测 |
|---|---|---|---|
| **W1** | `buildGenerateRoleArgv` 在 `--role` 后插入 `"--route", "opus-4-8/ccs"` | V1 + V2 守卫 | W1 测试观察到所有四个 role 的 argv 均含 `--route`，V1/V2 守卫 `expect(argv).not.toContain('--route')` 会挂。**被杀** ✓。 |
| **W2** | `buildGenerateRoleArgv` 仅在 `opts.role !== "dr-debater-advocate"` 时插入 `"--route"` | V2 守卫 | W2 测试观察到 advocate 不含 `--route`，opponent/judge/synthesizer 均含 `--route`，V2 对四个 role 逐一断言 `not.toContain('--route')` 会挂掉非 advocate 三条。**被杀** ✓。 |
| **W3** | `DEFAULT_GENERATE_CONFIG` 的 debaters/synthesizer entry 加回 `route` 字段，config 加回 `exportRoute` 字段 | V3 守卫 | W3 测试观察到 `Object.keys(DEFAULT_GENERATE_CONFIG.debaters[0])` 含 `route`，`Object.keys(DEFAULT_GENERATE_CONFIG)` 含 `exportRoute`，V3 守卫 `toEqual(["role"])` 和 `not.toContain("exportRoute")` 会挂。**被杀** ✓。 |

全部三条变异仅通过 flag 控制，`afterAll` 关闭 flag 后模块恢复原状，`git status --porcelain` 无遗留改动。✓

### V8：每处删除给出必要性说明

- `--route` 从 argv 删除：档位真相已移交 role YAML；调方再传既冗余又非法（缺 `--runtime`）。
- per-role `route` 字段从 `GenerateRoleSpec` 删除：去掉 `--route` 后不再有消费者，按本仓纪律不得留一个没有消费者的字段。
- `exportRoute` 字段从 `GenerateConfig` 删除：全仓无消费者——`runGenerate` 走 `deps.spawnExport(reportBody, synthDocMessageId)` 从不读 `cfg.exportRoute`；全仓 grep 仅声明/初始化两处，无读取。按本仓纪律（G4d `anchorCheckRoute` 前例）不得留一个没有消费者的字段。
- `assertDistinctDebaterRoutes` 删除：`GenerateRoleSpec` 已无 `route` 字段，该函数无法编译，属必要删除。
- 既有断言更新：原 D5/D16/D3 等测试依赖 `route` 字段，随字段删除而移除，属必要删除。
- JSDoc 更新：`GenerateConfig` 不再声明「三条 debater route 必须互不相同」，文件头不再描述 debater 为「不同 route」——`GenerateRoleSpec` 仅含 `role`，类型已无法表达 route 级不变式，保留旧注释会误导读者。

## 显式不做

| 不做 | 理由 |
|------|------|
| 改 `agent-runtime` 或 role YAML | 不同仓；四个 role 的档位已与 golden-order 一致 |
| 改成同时传 `--runtime` + `--route` | 会造成档位两处真相、静默漂移 |
| 改 triage argv | 它一直是对的（只传 `--role`） |
| 改语料投递（`--prompt-file`） | G7 刚交付 |
| 改 `profiles/deploy/*.env` | 归部署方 |
| 动 `tsconfig` 的 `include` | 已知加 `test/` 会炸出上百个 TS 错，属独立包 |