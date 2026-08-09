# 部署 —— 受版本管理的部署配置（D1 / D2）

本文档把「靠手工 env 搀扶」变成受版本管理的部署配置。部署 = 选一个 profile + 跑起来，
不再要求任何人记得把三个 env 敲对。

## 0　部署配置（profile，进 git / 可 diff / 可 review）

- `profiles/deploy/agent-harness.env` —— 「agent harness」研究：`TICK_CHANNEL` /
  `EVIDENCE_CHANNEL` / `ALLOWED_ROOT` / `MAX_WRITES` / `EXPORT_ROOT` / `RESEARCH_QUESTION` /
  `DOC_CHANNEL` / `ANCHOR_CHECK_BIN` 全部显式受管。channel 由派发方于 2026-08-09 07:51Z
  在生产 bus 上显式创建并复核（GET head_seq=0 msgs=0）。
- `profiles/deploy/local.env` —— 本地/冒烟：故意不含 `EVIDENCE_CHANNEL`（证据 channel
  不随板 channel 推导，部署方须显式提供，否则下游响亮失败）。`TICK_CHANNEL` 标注为未核验，
  真跑前须先在生产 bus 上显式创建该 channel。

选择入口（二选一）：

```bash
bin/deep-research-loop.sh --profile agent-harness
# 或
DEPLOY_PROFILE=agent-harness bin/deep-research-loop.sh
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
bin/deep-research-loop.sh --profile agent-harness --dry-run
# 或
DEPLOY_PROFILE=agent-harness bin/deep-research-loop.sh --dry-run
```

**验证**：渲染出的 fleet 里 tick pipeline input 的 `tick_channel` / `evidence_channel` /
`allowed_root` / `max_writes` / `research_question` **全部非空且等于 profile 里的值**
（`test/d1-deploy-config.test.ts` E3 与 `test/d2-profile.test.ts` Z5 自动断言同款）。
stderr 打印 `loaded deploy profile: agent-harness` 即证明 profile 被正确加载。

## 2　导出落点（E6）

导出件落 `<EXPORT_ROOT>/DeepThought/<主题>/`，带 `source_message_id` 与终态标记，与旧产物区分。
`EXPORT_ROOT` 由 profile 配置（`src/export.ts` 以 `vaultRoot` 参数接入，不硬编码到源码）。

## 3　换研究时怎么做

⛔ profile 是**按研究**的——不存在一个通用的 `production` profile。每换一个新研究题目，
须执行以下步骤：

### 步骤 1：由部署方在 bus 上显式创建一对新 channel

```bash
# ⛔ 必须由部署方在 bus 上显式创建，不得由代码自动创建（bus append-only 无 DELETE，写错不可回退）。
curl -X POST 'https://<bus-host>/v1/channels' -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"channel_id":"research:<topic>.index"}'
curl -X POST 'https://<bus-host>/v1/channels' -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"channel_id":"research:<topic>.evidence"}'
curl -X POST 'https://<bus-host>/v1/channels' -H 'Authorization: Bearer <token>' \
  -H 'Content-Type: application/json' \
  -d '{"channel_id":"research:<topic>.docs"}'
```

**验证**：每条创建后 GET 复核：

```bash
curl -s 'https://<bus-host>/v1/channels/research:<topic>.index/messages' | jq '.head_seq, .messages | length'
# 期望：head_seq=0, messages 数组长度=0
```

### 步骤 2：新增一个 `<topic>.env` profile

```bash
cp profiles/deploy/agent-harness.env profiles/deploy/<topic>.env
```

编辑该文件：修改 `TICK_CHANNEL` / `EVIDENCE_CHANNEL` / `DOC_CHANNEL` 为刚创建并复核的
channel 名，`RESEARCH_QUESTION` 改为新研究题目，`ANCHOR_CHECK_BIN` 保持原路径不变。

### 步骤 3：用新 profile 起研究

```bash
bin/deep-research-loop.sh --profile <topic> --dry-run   # 先 dry-run 验证
bin/deep-research-loop.sh --profile <topic>              # 通过后真跑
```

⛔ **不得**复用旧 channel 名——一次核验、一次研究，不是永真。换研究意味着旧 channel 名
已与新研究题目无关，继续使用会向错误 channel 写入不可回退的数据。