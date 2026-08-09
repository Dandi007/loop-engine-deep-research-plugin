# 部署 —— 受版本管理的部署配置（D1）

本文档把「靠手工 env 搀扶」变成受版本管理的部署配置。部署 = 选一个 profile + 跑起来，
不再要求任何人记得把三个 env 敲对。

## 0　部署配置（profile，进 git / 可 diff / 可 review）

- `profiles/deploy/production.env` —— 生产：`TICK_CHANNEL` / `EVIDENCE_CHANNEL` /
  `ALLOWED_ROOT` / `MAX_WRITES` / `EXPORT_ROOT` 全部显式受管。
- `profiles/deploy/local.env` —— 本地/冒烟：故意不含 `EVIDENCE_CHANNEL`（证据 channel
  不随板 channel 推导，部署方须显式提供，否则下游响亮失败）。

选择入口（二选一）：

```bash
bin/deep-research-loop.sh --profile production
# 或
DEPLOY_PROFILE=production bin/deep-research-loop.sh
```

加载顺序：**显式 env > profile 文件 > 内置缺省**。`TICK_CHANNEL` 的**内置缺省已移除**
（bus append-only 无 DELETE，缺省写真实 channel 不可回退）——无 profile 且无显式
`TICK_CHANNEL` 时**响亮失败拒绝启动**。加载了哪个 profile 会打印到 stderr（可观测）。

## 1　四步部署 + 每步验证

### 步骤 1：各仓 `git pull`

```bash
git -C <repo> pull
```

**验证**：`git -C <repo> status --porcelain` 干净，且 `git -C <repo> rev-parse HEAD`
等于期望的部署提交。

### 步骤 2：依赖安装

```bash
npm ci
```

**验证**：命令 exit 0，且 `node -e "require('yaml')"`（或 `npm ls yaml`）能解析到 `yaml`
——否则接线回归文件 import `yaml` 时会在运行期 `Failed to load url yaml`。

### 步骤 3：⛔ 回归可执行性验证（不是只看 exit 0）

```bash
npm test
```

**验证**：**收集到的用例数 > 0 且全绿**。`exit 0` 是不够的——历史教训是「0 test collected」
与「测试全绿」在摘要上极像而语义相反。因此必须确认 vitest 输出的
`Test Files N passed` 与 `Tests M passed` 中 **M > 0** 且 **N/M 均为 passed**，
例如 `Test Files 19 passed / Tests 34x passed`。若 M == 0，即使 exit 0 也视为部署失败。

### 步骤 4：`--dry-run` 冒烟（零手工 env，只靠 profile）

```bash
bin/deep-research-loop.sh --profile production --dry-run
# 或
DEPLOY_PROFILE=production bin/deep-research-loop.sh --dry-run
```

**验证**：渲染出的 fleet 里 tick pipeline input 的 `tick_channel` / `evidence_channel` /
`allowed_root` / `max_writes` **全部非空且等于 profile 里的值**（`test/d1-deploy-config.test.ts` E3
自动断言同款）。stderr 打印 `loaded deploy profile: production` 即证明 profile 被正确加载。

## 2　导出落点（E6）

导出件落 `<EXPORT_ROOT>/DeepThought/<主题>/`，带 `source_message_id` 与终态标记，与旧产物区分。
`EXPORT_ROOT` 由 profile 配置（`src/export.ts` 以 `vaultRoot` 参数接入，不硬编码到源码）。
