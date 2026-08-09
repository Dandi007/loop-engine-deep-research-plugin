# D1 —— 部署固化：把「靠手工 env 搀扶」变成受版本管理的部署配置

development_id: `dev_ledr_d1_deploy_config_01`
attempt: `implement`（initial）
input_commit: `9f2f307b6e9d1076a6fe4e5d29da7c790a416c2c`

## 结论先行

新增受版本管理的部署 profile（`profiles/deploy/*.env`），`bin/deep-research-loop.sh`
获得显式 profile 选择入口（`--profile <name>` / `DEPLOY_PROFILE`），`TICK_CHANNEL` 的
内置缺省改为**响亮失败拒绝启动**（不再回落 smoke channel），导出落点改走 `DeepThought/<主题>/`，
新增 `docs/deploy.md` 四步部署文档，新增 `test/d1-deploy-config.test.ts`（14 条，E1–E7）。
全量 `19 files / 347 tests` 连跑 3 次全绿（基线 18/333 之上）。

## 产品改动

- **`bin/deep-research-loop.sh`**：
  - 参数解析新增 `--profile <name>`；`DEPLOY_PROFILE` 亦可选择（`--profile` 优先）。
  - profile 加载：`profiles/deploy/<name>.env`，**只填环境里尚未显式设置的变量**
    （显式 env > profile），加载了哪个 profile 打印到 stderr（可观测）。
  - `TICK_CHANNEL` 内置缺省改为空 + 响亮失败（点名 TICK_CHANNEL + 理由，exit 3）。
  - 新增 `export EXPORT_ROOT="${EXPORT_ROOT:-}"`（导出落点根走配置）。
- **`profiles/deploy/production.env`**：生产配置，覆盖 `TICK_CHANNEL` / `EVIDENCE_CHANNEL` /
  `ALLOWED_ROOT` / `MAX_WRITES` / `EXPORT_ROOT`。
- **`profiles/deploy/local.env`**：本地/冒烟，**故意不含 `EVIDENCE_CHANNEL`**（E5 反例）。
- **`src/export.ts`**：`deriveExportPath` 落点改 `<vaultRoot>/DeepThought/<topic-slug>/`，
  保持纯函数 + 执行壳既有形状；vaultRoot 仍为参数（不硬编码）。
- **`docs/deploy.md`**：四步部署 + 每步验证命令。
- **`test/d1-deploy-config.test.ts`**（新增 14 条）：E1–E7。

### 既有测试的必要改动（非删除；E10）

`TICK_CHANNEL` 改为「无 profile 且无显式 env ⇒ 响亮失败」后，所有**裸跑**
`bin/deep-research-loop.sh` 的既有用例都必须显式提供 `TICK_CHANNEL`（否则会在入口被
响亮失败拦下，测不到它们本来要测的东西）。改动方式**仅在 execFile 的 env 里补一个
测试 channel**，不删任何断言：

- `test/plugin-wiring.test.ts`：`dryRun()` 与 A8e 渲染调用补 `TICK_CHANNEL`。
- `test/a9-tick-trigger.test.ts`：F2/F4/F5 的 `runDriver` 补 `TICK_CHANNEL`；F6 渲染补。
- `test/a10c-writebudget.test.ts`：`renderedDefaultMaxWrites()`、两处渲染补 `TICK_CHANNEL`。
- `test/a8f-adddir.test.ts`：F1 渲染补 `TICK_CHANNEL`。
- `test/a10b-convergence.test.ts`：`renderFleet` 与 B6 并发渲染补 `TICK_CHANNEL`；
  `runRealE2E` 显式给 `TICK_CHANNEL=research:p02-smoke-1dce60`（真实 E2E 的测试板 channel，
  在 fake bus 上只是字符串，非生产 smoke 板；D1 前由脚本缺省值提供同款语义）。
- `test/export.test.ts`：F9 落点断言由 `研究报告` 更新为 `DeepThought/<slug>`。

**E10 —— src/、test/ 的删除**：本包在 `src/` 与 `test/` **未删除任何断言或函数**；
全部为新增或上述「补 env / 改落点断言」的等价改写。

## 硬验收（spec §2 逐条）

| # | 判据 | 证据 |
|---|---|---|
| E1 | 无 profile 且无显式 env ⇒ `TICK_CHANNEL` 响亮失败；有 profile ⇒ 正常渲染 | `E1: ... loud failure` 两例；手动 `env -i ... --dry-run` exit 3 点名 TICK_CHANNEL |
| E2 | `grep -rn "research:p02-smoke-1dce60" bin/ src/` 零命中 | 实测 `ZERO HITS`；`E2: ... absent from bin/ and src/` 通过 |
| E3 | 只设 `DEPLOY_PROFILE` 的子环境 `--dry-run`，tick input 四项全等于 profile | `E3` 用例：`expect(childEnv).not.toHaveProperty(...)` 自证 + 四项断言 |
| E4 | 显式 env > profile > 内置缺省，三层各一例 | `E4` 三条断言 |
| E5 | `EVIDENCE_CHANNEL` 仍「无默认 + 响亮失败」 | `E5` 三条断言（脚本空缺省 + profile 不给则渲染为空 + tick-run 有 `MissingEvidenceChannelError`） |
| E6 | 导出落点走配置、源码不硬编码 vault 路径；导出件含 `source_message_id` 与终态标记 | `E6` 两条断言 |
| E7 | `docs/deploy.md` 四步齐全，第 3 步是「用例数 > 0 且全绿」 | `E7` 两条断言 + 读 `docs/deploy.md` |
| E8 | 全量 `npx vitest run` 连跑 3 次全绿，文件数/用例数 ≥ 18/333 | 三次输出：`19 files / 347 tests`（见下） |
| E9 | 变异矩阵（§3）逐断言归因、回显被改行、全部还原后 `git status --porcelain` 为空 | 见下变异矩阵；还原后 `git status --porcelain` 仅剩本包应提交文件 |
| E10 | `src/`、`test/` 每一处删除给出必要性说明 | 本包在 src/test **无删除**（见上「既有测试的必要改动」） |

### E8 —— 连跑 3 次输出

```
===== RUN 1 =====
 Test Files  19 passed (19)
      Tests  347 passed (347)
===== RUN 2 =====
 Test Files  19 passed (19)
      Tests  347 passed (347)
===== RUN 3 =====
 Test Files  19 passed (19)
      Tests  347 passed (347)
```

三次全绿，期间未复现那一次未记录的失败（无失败用例名可贴，本包按要求只如实记录）。

## 变异矩阵（spec §3，逐断言归因）

| 变异 | 改什么 | 被杀断言 | 实测 |
|---|---|---|---|
| **Q1** | 把 `TICK_CHANNEL` 内置缺省改回 `research:p02-smoke-1dce60`（`export TICK_CHANNEL="${TICK_CHANNEL:-research:p02-smoke-1dce60}"` 且响亮失败不再触发） | **E1 失败侧**：`no profile and no explicit TICK_CHANNEL ⇒ non-zero exit naming TICK_CHANNEL`（`expect(res.code).not.toBe(0)` 挂）**+ E2**：`research:p02-smoke-1dce60 absent from bin/ and src/`（`not.toContain` 挂） | `2 failed / 12 passed` |
| **Q2** | 颠倒优先级：profile 无条件覆盖显式 env（`if true; then export ...`，删掉 `-z "${!_key+x}"` 守卫） | **E4**：`explicit env beats profile`（期望 `research:explicit-wins.index`，实得 profile 值） | `1 failed / 13 passed` |
| **Q3** | 给 `EVIDENCE_CHANNEL` 编缺省（`export EVIDENCE_CHANNEL="${EVIDENCE_CHANNEL:-research:derived.evidence}"`） | **E5**：`script still exports EVIDENCE_CHANNEL with an empty default`（`toMatch` 挂）+ `profile without EVIDENCE_CHANNEL renders evidence_channel empty`（`toBe("")` 挂） | `2 failed / 12 passed` |

每次变异已回显被改行（见上「改什么」列）；**全部还原后** `git status --porcelain` 只剩
本包应提交的 9 个文件（bin / src/export.ts / 5 个既有测试 / export.test.ts 的改动 +
docs/deploy.md、profiles/deploy/、test/d1-deploy-config.test.ts 的新增），无残留。

## 验证命令

- `npm run typecheck` → exit 0。
- `npm test` → 连跑 3 次 `19 files / 347 tests` 全绿。
- `.dev-dispatch/**` 全程字节未变；`.dd-evidence/` 未动。

## 非目标（未触碰）

- 未注册任何 bus 协议；未做端到端真跑真研究（只 `--dry-run` 贯通）；未改 `agent-runtime`；
- 未改生成/收集段编排逻辑；未修那个未复现的 flake（按要求只「连跑 3 次并如实记录」）；
- 未动 `tsconfig` 的 `include`。
