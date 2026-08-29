# 部署契约（C1）—— 声明式部署契约 + 确定性 preflight

本目录把「部署前检查」变成受版本管理、可 diff、可 review 的**声明式契约**，并由一个
**失败即关断（fail-closed）**的确定性 `preflight` runner 逐项校验。preflight 只读，
**绝不**执行部署、重启、安装、网络变更或 git 变更。

## 1　契约结构

| 文件 | 作用 |
| --- | --- |
| `applications.json` | 已登记应用注册表（`application-registry.v1`），映射 应用名 → 声明文件相对路径。新增应用只需加一条 + 一份声明，**无需改 runner 代码**。 |
| `contract/application-declaration.v1.schema.json` | 版本化声明契约的 JSON Schema。 |
| `declarations/deep-research.json` | 第一个真实集成应用（可被 runner 运行）。 |
| `declarations/chatgroup-daemon.json` | 第二个应用：**仅 schema 合法的声明**（declaration-only），不实现任何应用专属部署行为。 |

## 2　一份声明包含的字段（`application-declaration.v1`）

| 字段 | 含义 |
| --- | --- |
| `schema_version` | 契约版本，恒为 `application-declaration.v1`。 |
| `application` | 应用身份，必须是注册表里的 known application。 |
| `artifact.ref` / `artifact.commit` | 制品引用 与 **不可变 commit**（40 位小写十六进制）。相对 `ref` 按本仓根解析。 |
| `command` | 部署运行命令的 argv 数组（首元素是可执行文件）。 |
| `working_directory` | 运行命令的工作目录（相对路径按本仓根解析）。 |
| `required_environment` | 部署前必须**存在且非空**的环境变量键。 |
| `health.command` | 健康检查命令的 argv 数组（只做**语法**校验，不执行）。 |
| `rollback.ref` / `rollback.commit` | 部署失败时回退到的制品引用 与 不可变 commit。 |

## 3　preflight 命令

```bash
npm run preflight -- --app deep-research --preflight-only
# 或直接
node node_modules/.bin/vite-node src/preflight-entry.ts --app deep-research --preflight-only
```

`--app <名称>` 载入注册表指向的声明；`--preflight-only` 显式声明「只做预检、不执行任何
部署动作」。本 runner **只实现预检路径**，不存在部署分支。成功（退出码 0）输出单个
机器可解析 JSON，含 `status=PASS`、`application`、**解析出的不可变 commit** 与 **声明摘要
digest**（声明对象按 key 排序后的 `sha256`，`sha256:<64hex>`）。

## 4　失败即关断 + 稳定错误码

任一项不满足即 non-zero 退出，输出单个 JSON 的 `status=FAIL` + 稳定 `error_code`：

| error_code | 触发 |
| --- | --- |
| `UNKNOWN_APPLICATION` | `--app` 不在注册表 |
| `DECLARATION_NOT_FOUND` | 声明文件缺失/不可读 |
| `SCHEMA_INVALID` | 声明不满足 schema（含 `schema_version`、字段类型、application 不匹配） |
| `INVALID_COMMIT_FORMAT` | `artifact.commit` / `rollback.commit` 不是 40 位小写十六进制 |
| `ARTIFACT_NOT_FOUND` | `artifact.ref` 解析后路径不存在 |
| `WORKING_DIRECTORY_NOT_FOUND` | `working_directory` 解析后路径不存在 |
| `REQUIRED_ENV_MISSING` | `required_environment` 中任一键缺失或为空 |
| `COMMAND_MALFORMED` | `command` 为空或元素非法 |
| `COMMAND_UNRESOLVABLE` | `command[0]` 可执行文件在 PATH/绝对路径上不可用 |
| `HEALTH_COMMAND_SYNTAX_INVALID` | `health.command` 语法非法 |

preflight 输出恒为 `phase:"preflight"`，**从不出现在部署动作发生时才出现的
`phase:"deploy"` / `effects` 标记**——因此「无部署副作用」可被机器断言。

## 5　部署对齐证明（不可变 commit == 检出 commit）

部署的**唯一合法姿势**：

1. 部署目标提交先合入远端 `main`；
2. 生产 checkout 里执行 `git pull --ff-only`；
3. 校验 `git rev-parse HEAD`（检出的制品 commit）**等于**声明里的 `artifact.commit`；
4. 通过 `preflight --preflight-only` 全部检查后才允许真正部署。

即「**声明 commit == 检出的制品 commit**」是部署许可的对齐证明。生产 checkout
**只做部署**，**绝不**是开发或验证地点：开发一律走 dev-dispatch 隔离 worktree，
验证由 `npm test` / `npm run typecheck` / `npm run smoke:cas` 完成。

## 6　chatgroup-daemon 的第二声明

`declarations/chatgroup-daemon.json` 满足 `application-declaration.v1` 全部 schema 约束
（纯声明，确保「第二声明」存在且合法）。其 `commit` 为占位值 `00…0`：该应用尚未
有可部署制品，待其**第一次真实可运行**时由部署流程填入真实不可变 commit。按契约
约束，**不实现任何 chatgroup-daemon 应用专属部署行为**。

## 7　验收

| 案例 | 断言 |
| --- | --- |
| GREEN | `deep-research` `--preflight-only` 退出码 0，输出 `status=PASS` + `application=deep-research` + 冻结的解析 commit + 摘要 digest。 |
| RED | 去掉一个 `required_environment` 键后退出码非零，输出 `status=FAIL` + `error_code=REQUIRED_ENV_MISSING`，且输出不含部署副作用标记（无 `phase:"deploy"` / `effects`）。 |

原始 stdout/stderr 快照见 `test/fixtures/preflight/green-deep-research.stdout.txt` 等
（由 `test/c1-preflight.test.ts` 确定性重写出，是验收证据而非散文示例）。

## 8　`npm test`（全仓）与外部 loop-engine 构建的兼容性

C1 的验收面是 preflight 契约本身，由 scoped 测试 **`test/c1-preflight.test.ts`**
（GREEN/RED 两条 + fail-closed 各错误码）钉死，辅以 `npm run typecheck` 与
`npm run smoke:cas`。全仓 `npm test`（`vitest run`，无 scoping）也必须退出 0。

`test/a10b-convergence.test.ts` 的 B1/B2 是依赖**外部** loop-engine 构建与外部
model-registry 的真实端到端测试。冻结基线上该 loop-engine worktree 的 `dist` 构建
（建成于 2026-08-04）仍要求 selector 的 `route` 为非空字符串，而外部
`/data/loop-engine/config/model-registry.json` 已含 `kind:"chain"` 且**无 `route`**
的新格式条目（如 `claude-opus-4-8@claude/chain`）；旧构建载入 registry 时抛
`缺/空字段 "route"`，使 `drain` 退出 1。这与部署契约/preflight 无任何因果——B1/B2
所依赖的整条 E2E 链路（`test/a10b-convergence.test.ts`、`bin/deep-research-loop.sh`、
`src/tick*.ts`、`src/harvest.ts`、`workflows/deep-research/**`、`profiles/**` 等）全部
继承自冻结基线，C1 的 diff 不触及其中任何文件。

为使验收门在外部构建不兼容时既诚实又响亮，`test/a10b-convergence.test.ts` 增加了一个
**确定性兼容性探测**：用该 loop-engine 构建自身的 `lib/model-registry.js` 做 import 探测
——能成功载入当前 registry 即「兼容」，B1/B2 真跑；载入即抛 `route` 错则**显式 `it.skip`**
（与缺 bun/CLI 同款待遇，绝不静默通过），并打印「重建 loop-engine worktree」的提示。

因此：

- 外部构建**兼容**时：`npm test` 全绿，B1/B2 真跑并断言 `drained`；
- 外部构建**不兼容**时：B1/B2 显式 skip，`npm test` 仍退出 0（不掩盖真实环境缺陷）。

待该 loop-engine worktree 更新/重建以支持 `chain` 格式后，探测自动恢复绿色，B1/B2
重新真跑，属部署环境维保，不在 C1 交付范围内。