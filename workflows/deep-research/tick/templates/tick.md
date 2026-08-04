set -euo pipefail
# A8c —— tick 节点可执行体（bash harness），已从 --selfcheck 切到真实 tick 入口（spec §1.3）。
# 真实入口：--run <channel> 执行 CAS + spawn（接线判别，spec §1.2）。
# tick_entry / tick_channel 由 fleet 的 pipeline input 注入（loop-engine 渲染时替换）。
# ⛔ --selfcheck 仍保留（A7 G6/G7 需要它做无副作用自检）：未注入 tick_channel 时退化为 --selfcheck。
tick_entry="{{tick_entry}}"
tick_channel="{{tick_channel}}"
if [ -n "$tick_channel" ]; then
  "$tick_entry" --run "$tick_channel"
else
  "$tick_entry" --selfcheck
fi
