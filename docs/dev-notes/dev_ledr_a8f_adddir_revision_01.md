# A8f —— `--add-dir` + `revision`：让 worker 真的读得到东西

## 缺口

引擎派出的 `dr-worker-code-local` 在空工作区之外什么都读不到：`role.fs` 只有模板变量校验、
生产 argv 不含 `--add-dir`、`allowed_root` 从没被填过 ⇒ 产出零证据，且不报错、不崩溃。
顺带修掉 worker 撞权限墙：`git -C <root> rev-parse HEAD` 在只读模式被拒（`"This command requires approval"`），
白烧回合——正解是引擎自己跑 `git rev-parse` 把 `revision` 填进 payload。

## 改动

### `src/tick-run.ts`
- `CODE_LOCAL_ROLE = "dr-worker-code-local"`：唯一需要 `allowed_root` 的 role。
- `MissingAllowedRootError`：`code-local` dispatch 而 `allowed_root` 未配置 ⇒ 当场响亮失败
  （错误文本点名 `allowed-root`），零 spawn，绝不静默产出零证据（§1.2 / F5）。
- `resolveRevision(allowedRoot)`：在 `allowed_root` 下跑 `git -C <root> rev-parse HEAD`；
  失败（非 git 目录等）⇒ 返回 `undefined`（**省略**可选字段），⛔ 绝不返回空串，
  ⛔ 也不因 git 失败阻断派发（`revision` 可选，persona 有 Read 回退）。
  用 `execFileSync` 读退出码，命令后不接管道（spec §6）。
- `WorkerInputPayload` 新增可选 `revision?: string`；`buildWorkerInput` 新增可选 `revision?` 参数。
- `buildAgentRunArgv` 新增可选 `allowedRoot?`：有值时在 `--role/--run-id` 之后追加相邻对
  `["--add-dir", <allowed_root>]`（F2）；无值时**不**含 `--add-dir`（F10）。
- `spawnAgentRunWorker` 新增可选 `allowedRoot?`，透传给 argv。
- `runWrite` dispatch 的 catch：`MissingAllowedRootError` 与 `AgentRunUnresolvedError` 同族
  —— 属配置错误，**响亮传播**，不回滚、不静默 spawned:false。
- `runChannelWrite`：
  - `RunWriteOptions` 新增 `allowedRoot?`。
  - 缺省 spawn dep：`code-local` 无 `allowedRoot` ⇒ 抛 `MissingAllowedRootError`（F5）；
    否则在生产调用点把 `allowedRoot` 与 `resolveRevision(allowedRoot)` 经 `buildWorkerInput`
    真实传入（F3 / F4），并透传 `allowedRoot` 给 `--add-dir`（F2）。
  - 其余 role（wiki / feishu / code-remote）不因 `allowed_root` 缺失被阻断（F7）。
- `parseRunCliArgs` 新增 `--allowed-root <path>`（缺失值 ⇒ 响亮报错）。

### 生产装配链路（F1 四层）
- `bin/deep-research-loop.sh`：`export ALLOWED_ROOT="${ALLOWED_ROOT:-}"`（⛔ 无派生默认值）。
- `workflows/deep-research/fleet.yaml.tpl`：input 增 `allowed_root: ${ALLOWED_ROOT}`。
- `workflows/deep-research/tick/workflow.yaml`：seed payload 增 `allowed_root: "{{allowed_root}}"`。
- `workflows/deep-research/tick/templates/tick.md`：非空 `allowed_root` 时把
  `--allowed-root "$allowed_root"` 传给 `--run`。

### `src/tick-entry.ts`
- 用法文本补充 `--allowed-root <path>`。

## 非目标（照抄 spec §4，务必写明）

⛔ **本包不用 `--add-dir` 做安全隔离**。用户已拍板「接受 worker 可读全盘，安全性移到凭证下发管控」：
`--add-dir` 做不到安全边界（Bash 不受目录限制），**唯一作用是「让 worker 读得到」**，
不是「限制 worker 只能读」。不得把它描述成安全边界。

## 验收（F1–F17）

- F1 生产链路四层各一条断言 + 渲染后 input.allowed_root === 显式值。
- F2 argv 相邻对 `["--add-dir", <root>]`；F3 载荷 `allowed_root === 配置值`；
  F4 真实 git 目录下载荷 `revision === git rev-parse HEAD`。
- F5 `code-local` 无 root ⇒ 响亮失败（点名 allowed-root）+ 零 spawn；F6 有 root ⇒ spawn 1 次。
- F7 wiki / feishu / code-remote 不因缺 root 被阻断。
- F8 非 git 目录 ⇒ 载荷**省略** `revision` 仍 spawn；F9 绝不填空串；F10 无 root 时 argv 无 `--add-dir`。
- F11/F12 A8e（H6/H7/H14）与 A8d（P1/P2）、A8c（N1/N2）原用例仍通过。
- F13 `--selfcheck` 保留且无副作用；F14 不碰 `.dd-evidence/`；F15 typecheck + 全量测试 exit 0；
  F16 既有 238 条用例一条不删（净增不减）；F17 证据写本 dev-note，仓根无 `IMPLEMENTATION_SUMMARY.md`。
