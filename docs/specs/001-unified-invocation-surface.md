# 001 — 统一调用面（single entry，light/heavy 路由）

**Status:** Active
**Scope:** Deep Research 的调用面收敛

## 目标

一个应用声明派生出三条调用面（programmable MCP tool / 人可调用 skill / CLI），
三者都指向**同一个入口** `bin/deep-research.sh`。入口按显式、文档化的 scale 阈值，
把一次研究请求路由到 light tier（session-level `workflow.js`）或 heavy tier（V2 全编排）。
legacy 双系统并存（两个并行入口）被消除。

## 路由规则（确定性，不交模型裁量）

- scale = 研究请求声明的源数（fan-out `--sources <n>`）。
- `sources < 4` → **light tier**（session-level `workflow.js`）。
- `sources >= 4` → **heavy tier**（V2 全编排，loop-engine）。
- `--tier light|heavy` 显式覆盖自动判定（不变更阈值本身）。

阈值常量唯一真相源：`src/invocation.ts:HEAVY_TIER_MIN_SOURCES`。

## heavy tier —— 一条命令，零手工步骤

`bin/deep-research.sh "<topic>" --sources <n>`（heavy 分支）自动完成：

1. profile 选择（缺省 `agent-harness`，`--profile` / `DEEP_RESEARCH_PROFILE` 覆盖）；
2. per-topic research channel 派生与 create-or-reuse（`src/invocation.ts:deriveTopicChannels`
   派生，`src/bus.ts:ensureChannel` 复用/创建）；
3. C1 preflight 闸门（`src/preflight.ts:runPreflight`）——非 PASS 即拒绝启动（fail-closed）。

## legacy direct-run 降级

`bin/deep-research-loop.sh` 降级为内部实现细节（heavy tier 的 loop 落地），
不再是第二个面向用户的入口；对外统一走 `bin/deep-research.sh`。

## 验收

`test/c2-invocation.test.ts` 钉死：(a) 同一入口按 scale 规则路由 light/heavy；
(b) heavy 路径零手工输入完成 profile+channel 预备；(c) preflight 非绿拒绝 heavy 启动；
(d) legacy direct-run 不再是用户入口。至少一条测试驱动真实 CLI 入口，不 mock 掉路由/preflight。