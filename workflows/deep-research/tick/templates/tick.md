set -euo pipefail
# A7 —— tick 节点可执行体（bash harness）。
# 证明「接线存在且能解析」：调起 tick 入口做一次无副作用自检（不触真实 bus，V1）。
# tick_entry 由 fleet 的 pipeline input 注入（loop-engine 渲染时替换）。
tick_entry="{{tick_entry}}"
RESULT="$("$tick_entry" --selfcheck)"
echo "$RESULT"
