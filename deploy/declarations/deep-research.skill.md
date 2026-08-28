---
name: deep-research
description: Launch deep research through one entry that routes to a light session-level workflow or the heavy full V2 orchestration by a documented scale threshold.
---

# Deep Research (unified skill)

一个 skill，一个入口：`bin/deep-research.sh`。人用这一个 skill 就能到达两层，
不必回退到任何第二入口。

```bash
bin/deep-research.sh "<研究主题>" --sources <n>
# 或显式指定层：
bin/deep-research.sh "<研究主题>" --tier light   # session-level workflow.js
bin/deep-research.sh "<研究主题>" --tier heavy   # full V2 orchestration
```

## 路由（documented scale threshold）

- `sources < 4` → **light tier**（session-level `workflow.js`，单会话轻量研究）。
- `sources >= 4` → **heavy tier**（V2 全编排，loop-engine 多轮调度）。

## light tier —— 既有引擎，本入口只路由

light tier 的 session-level `workflow.js` 是部署方落地的**既有实现**，本入口只加路由、
不重新实现。非 dry-run 的 light 调用需经环境变量 `DEEP_RESEARCH_SESSION_WORKFLOW` 指向
既有 workflow.js 的落地路径（`--topic` / `--sources` 会被原样转发）；未配置时入口响亮失败
（`outcome=refused`，exit 2），不会伪造「研究完成」。

## heavy tier —— 一条命令，零手工步骤

heavy 路径自动完成 profile 选择（缺省 `agent-harness`）与 channel 预备（per-topic
create-or-reuse），并在起 loop 前运行 C1 preflight 闸门——非 PASS 即拒绝启动（fail-closed）。

## 三条调用面

- **MCP tool**（agent 可调用）：`deploy/declarations/deep-research.mcp-tool.json`
- **skill**（人可调用）：本文件
- **CLI**：`bin/deep-research.sh`

`bin/deep-research-loop.sh` 已被降级为内部实现细节（heavy tier 的 loop 落地），
**不是**第二个面向用户的入口。