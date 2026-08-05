set -euo pipefail
# A8c —— tick 节点可执行体（bash harness），已从 --selfcheck 切到真实 tick 入口（spec §1.3）。
# 真实入口：--run <channel> 执行 CAS + spawn + 收割（接线判别，spec §1.2）。
# tick_entry / tick_channel / evidence_channel / allowed_root 由 fleet 的 pipeline input 注入（loop-engine 渲染时替换）。
# ⛔ A8e——收割步的 evidence channel 也随装配系统一路注入，`--run` 带上 `--evidence-channel`
#    （spec §1.4：显式传入、无默认、无字符串推导）；缺失时收割决策会响亮失败而非卡死 tick。
# ⛔ A8f——code-local 所需 `--allowed-root` 也随装配系统一路注入；缺失时 code-local dispatch 会响亮失败
#    （spec §1.2 / F5），其余 role 不因它缺失被阻断。
# ⛔ A9——trigger 续投所需的 trigger_store_dir / loop_store_cli / loop_engine_runner 随装配系统一路注入；
#    tick 完成后当且仅当板面仍有非终态 clue（hasPendingWork=true）才投下一条触发（spec §1.3 / F9）。
# ⛔ --selfcheck 仍保留（A7 G6/G7 需要它做无副作用自检）：未注入 tick_channel 时退化为 --selfcheck。
tick_entry="{{tick_entry}}"
tick_channel="{{tick_channel}}"
evidence_channel="{{evidence_channel}}"
allowed_root="{{allowed_root}}"
trigger_store_dir="{{trigger_store_dir}}"
loop_store_cli="{{loop_store_cli}}"
loop_engine_runner="{{loop_engine_runner}}"

run_output=""
if [ -n "$tick_channel" ]; then
  if [ -n "$evidence_channel" ] && [ -n "$allowed_root" ]; then
    run_output="$("$tick_entry" --run "$tick_channel" --evidence-channel "$evidence_channel" --allowed-root "$allowed_root")"
  elif [ -n "$evidence_channel" ]; then
    run_output="$("$tick_entry" --run "$tick_channel" --evidence-channel "$evidence_channel")"
  elif [ -n "$allowed_root" ]; then
    run_output="$("$tick_entry" --run "$tick_channel" --allowed-root "$allowed_root")"
  else
    run_output="$("$tick_entry" --run "$tick_channel")"
  fi
  printf '%s\n' "$run_output"
  # A9 —— 板面仍有非终态 clue（hasPendingWork=true）⇒ 投下一条触发（id 每轮唯一，否则 put 覆盖）；
  #      否则不投 ⇒ drain 自然收敛退出。触发 id 用 纳秒时间戳 + PID，保证每轮唯一。
  if [ -n "$trigger_store_dir" ] && [ -n "$loop_store_cli" ] && [ -n "$loop_engine_runner" ]; then
    if printf '%s' "$run_output" | grep -q '"hasPendingWork": *true'; then
      next_id="a9-$(date +%s%N)-$$"
      "$loop_engine_runner" "$loop_store_cli" "$trigger_store_dir" put \
        "{\"id\":\"${next_id}\",\"status\":\"open\",\"body\":{\"tick\":true}}"
    fi
  fi
else
  "$tick_entry" --selfcheck
fi
