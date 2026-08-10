# G8 —— 生成段 argv 传 `--role` + `--route` 却不传 `--runtime`：agent-run 直接判 CONFIG_ERROR

> 本文件是验收证据。`input_commit` = `f08c2968e9b46f359692df920314dd6a3c3c3a2e`。

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
- `test/g8-role-argv.test.ts`：新增（V1–V5 共 14 个测试）。

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
      Tests  506 passed (506)
   Start at  10:08:48
   Duration  7.07s
```

未设置 `ANCHOR_CHECK_BIN` / `DOC_CHANNEL` / `RESEARCH_ORIGIN` / `EXPORT_ROOT` / `AGENT_RESULT_*`。29 files ≥ 基线 28，506 tests ≥ 基线 498。✓

### V7：变异矩阵逐断言归因（实测：对 src/generate.ts 源码施加变异，运行 `npm test`，观察 V1–V3 守卫失败，还原后 `git status --porcelain` 为空）

变异矩柞通过对 `src/generate.ts` 源码直接修改施加，而非通过 `vi.mock` 包装。每个变异行在施加后立即运行 `npm test`，记录失败断言，随后 `git checkout src/generate.ts` 还原。V1–V5 断言在无变异时全部通过（29 files / 506 tests），变异施加后对应守卫失败。

**W1**：在 `buildGenerateRoleArgv` 的返回数组中插入 `"--route", "opus-4-8/ccs"`（加回 `--route`）。

```diff
--- a/src/generate.ts
+++ b/src/generate.ts
@@ -217,10 +217,12 @@ export function buildGenerateRoleArgv(opts: {
   return [
     opts.agentRunBin,
     "--role",
     opts.role,
+    "--route",
+    "opus-4-8/ccs",
     "--run-id",
     opts.runId,
     "--input",
```

`npm test` 结果：**8 failed**（V1 ×1 + V2 四个 role ×4 + V3 `buildGenerateRoleArgv` ×1 + V5-a ×1 + V5-b ×1）。V1 守卫 `expect(argv).not.toContain('--route')` 和 V2 四个 role 逐条断言均因 argv 含 `--route` 而失败。**被杀 ✓**。

**W2**：`buildGenerateRoleArgv` 仅在 `opts.role !== "dr-debater-advocate"` 时插入 `--route`（advocate 去掉，其余三个保留）。

```diff
--- a/src/generate.ts
+++ b/src/generate.ts
@@ -217,10 +217,14 @@ export function buildGenerateRoleArgv(opts: {
   return [
     opts.agentRunBin,
     "--role",
     opts.role,
+    ...(opts.role !== "dr-debater-advocate" ? ["--route", "some-route"] : []),
     "--run-id",
     opts.runId,
     "--input",
```

`npm test` 结果：**4 failed**（V2 opponent/judge/synthesizer ×3 + V5-b ×1）。V2 对 advocate 的断言仍通过（`not.toContain('--route')`），但 opponent/judge/synthesizer 三条均失败，证明 V2 覆盖了全部四个 role 而非仅验一条。**被杀 ✓**。

**W3**：在 `DEFAULT_GENERATE_CONFIG` 的 debaters/synthesizer 上加回 `route` 字段，config 加回 `exportRoute` 字段。

```diff
--- a/src/generate.ts
+++ b/src/generate.ts
@@ -42,10 +42,10 @@ export interface GenerateConfig {
 export const DEFAULT_GENERATE_CONFIG: GenerateConfig = {
   debaters: [
-    { role: "dr-debater-advocate" },
-    { role: "dr-debater-opponent" },
-    { role: "dr-debater-judge" },
+    { role: "dr-debater-advocate", route: "dummy" },
+    { role: "dr-debater-opponent", route: "dummy" },
+    { role: "dr-debater-judge", route: "dummy" },
   ],
-  synthesizer: { role: "dr-synthesizer" },
+  synthesizer: { role: "dr-synthesizer", route: "dummy" },
+  exportRoute: "export",
 };
```

`npm test` 结果：**2 failed**（V3 `toEqual(["role"])` ×1 + V3 `not.toContain("exportRoute")` ×1）。V3 守卫 `expect(Object.keys(d)).toEqual(["role"])` 因 debater entry 含 `route` 而失败；`expect(keys).not.toContain("exportRoute")` 因 config 含 `exportRoute` 而失败。**被杀 ✓**。

全部三条变异施加后对 `src/generate.ts` 执行 `git checkout` 还原，`git status --porcelain` 无遗留改动。✓

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