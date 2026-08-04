#!/usr/bin/env bash
set -euo pipefail

# A7 —— deep-research loop 驱动脚本。
# 渲染 workflows/deep-research/fleet.yaml.tpl → 调 loop-engine CLI。
# --dry-run 只渲染并打印渲染结果（spec G1/G2）：不依赖 loop-engine CLI 可执行，
# 不发任何网络请求（spec §8）。
#
# 架构裁定（spec §1）：loop-engine 在本设计只提供 周期驱动 / 命名 lock / 崩溃恢复。
# clue 状态不落 loop-engine 的 store_dir —— claim 的 store 只承载周期 trigger 记录，
# 不引用 clue/board 语义（spec G5）。

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

DRY_RUN=""
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

MODE="deep-research"
RUN_ID="${DD_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
RUN_ROOT="${DD_RUN_ROOT:-$PLUGIN_ROOT/.runtime/$MODE/$RUN_ID}"
RUNTIME_FLEET="$RUN_ROOT/fleet.yaml"

export PLUGIN_ROOT RUN_ROOT RUNTIME_FLEET MODE
export TRIGGER_STORE_DIR="$RUN_ROOT/stores/trigger"
export TICK_ENTRY="${TICK_ENTRY:-bash \"$PLUGIN_ROOT/bin/tick-entry.sh\"}"
# A8c——tick 的 clue 板 channel：从 pipeline input namespace 注入 tick.md 供 `--run` 使用。
# ⛔ spec §2 只允许在 research:p02-smoke-1dce60 上做真机写入验证；可用 TICK_CHANNEL 覆盖。
export TICK_CHANNEL="${TICK_CHANNEL:-research:p02-smoke-1dce60}"
# A8c（评审 blocker）——生产 spawn 的落地命令：**必须**指向一个真实存在的 worker launcher，
# 而不是让缺省退化成 `bash <role>`（role 作为脚本路径不存在 ⇒ 退出 127，从未拉起 worker）。
# 本脚本显式导出 TICK_WORKER_CMD 指向随包提供的 worker-launcher.sh；部署方可覆盖。
export TICK_WORKER_CMD="${TICK_WORKER_CMD:-$PLUGIN_ROOT/bin/worker-launcher.sh}"
export DD_CLAIM_STALE_MS="${DD_CLAIM_STALE_MS:-1800000}"

mkdir -p "$TRIGGER_STORE_DIR" "$(dirname "$RUNTIME_FLEET")"

render() {
  node "$PLUGIN_ROOT/scripts/render-template.mjs" \
    "$PLUGIN_ROOT/workflows/$MODE/fleet.yaml.tpl" "$RUNTIME_FLEET"
}

if [ -n "$DRY_RUN" ]; then
  render
  cat "$RUNTIME_FLEET"
  exit 0
fi

LOOP_ENGINE_CLI="${LOOP_ENGINE_CLI:-/data/code/self/loop-engine/dist/cli.js}"
if [ ! -f "$LOOP_ENGINE_CLI" ]; then
  echo "[deep-research-loop] missing LOOP_ENGINE_CLI: $LOOP_ENGINE_CLI (build loop-engine first)" >&2
  exit 3
fi

render
echo "[deep-research-loop] mode=$MODE run_root=$RUN_ROOT"
node "$LOOP_ENGINE_CLI" drain "$RUNTIME_FLEET" --label "$MODE"
