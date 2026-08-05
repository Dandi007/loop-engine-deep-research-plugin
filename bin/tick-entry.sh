#!/usr/bin/env bash
set -euo pipefail

# A7 —— tick 入口的 bash 包装：在干净环境下用 vite-node 调起 src/tick-entry.ts。
# 供 workflow 的 bash harness 复用；--help / --selfcheck 均为无副作用调用（不触 bus）。
PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PLUGIN_ROOT"
exec node "$PLUGIN_ROOT/node_modules/.bin/vite-node" "$PLUGIN_ROOT/src/tick-entry.ts" -- "$@"
