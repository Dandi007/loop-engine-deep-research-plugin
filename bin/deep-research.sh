#!/usr/bin/env bash
set -euo pipefail

# C2 —— Deep Research 统一调用面（single entry）的 bash 包装。
# 一个入口、三条调用面（MCP tool / skill / CLI 都指向它），路由 light/heavy 两层。
# 与 bin/tick-entry.sh 同款包装：在干净环境下用 vite-node 调起 src/deep-research-entry.ts。
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLUGIN_ROOT"
exec node "$PLUGIN_ROOT/node_modules/.bin/vite-node" "$PLUGIN_ROOT/src/deep-research-entry.ts" -- "$@"