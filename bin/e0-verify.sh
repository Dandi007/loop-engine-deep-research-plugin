#!/usr/bin/env bash
set -euo pipefail

# E0 —— 实证判据分离（blocker 2 / Z1 / Z2 / 终态 判别逻辑单独成脚本，供 bin/e0-regression.sh 调用，
#      也让单测能脱离重活直接判）。
# 输入：四次 e0-metrics snapshot 的 JSON 文件（均为单行 JSON，实取自列表端点），外加 loop 的
#       完整 stdout（run.stdout.log，供从中真解析 termination.state）：
#   <before-run>  跑前 测试/运行总线快照
#   <after-run>   跑后 测试/运行总线快照
#   <before-prod> 跑前 生产总线快照
#   <after-prod>  跑后 生产总线快照
#   <run-stdout>  loop 的 stdout 归档（run.stdout.log），从中取末轮 termination.state
# 判据：
#   Z1 —— after-run.tick_head_seq 必须**严格大于** before-run.tick_head_seq
#         （loop 真写了总线；否则"loop 退出 0 但零写入/板面无终态"被放过）。
#   Z2 —— after-prod.sum 必须 **≤** before-prod.sum（生产总线零增长；增长即污染，点名）。
#   终态 —— 从 run.stdout.log 真解析末轮 termination.state，必须是**非 null** 的真实终态；
#          loop 退出 0 但板面无终态（state === null / 无 termination JSON）⇒ 非零退出（判据 4，
#          §3 禁止把终态断言放宽成"没报错就算过"）。
# 退出码：0 = 全部判据成立；非零 = 至少一条判据被违反（stderr 点名是 Z1 / Z2 / 终态 哪条）。

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -ne 5 ]; then
  echo "usage: bash bin/e0-verify.sh <before-run.json> <after-run.json> <before-prod.json> <after-prod.json> <run-stdout.log>" >&2
  exit 2
fi
BEFORE_RUN="$1"
AFTER_RUN="$2"
BEFORE_PROD="$3"
AFTER_PROD="$4"
RUN_STDOUT="$5"

# 从单行 JSON 快照里取字段。⛔ 一律用 node JSON.parse，⛔ 不用 sed 贪婪正则抽值。
_read_field() {
  local file="$1"
  local key="$2"
  node -e '
    let s=""; process.stdin.on("data",d=>s+=d);
    process.stdin.on("end",()=>{ const j=JSON.parse(s); process.stdout.write(String(j[process.argv[1]])); });
  ' "$key" < "$file"
}

br_tick=$(_read_field "$BEFORE_RUN" tick_head_seq)
ar_tick=$(_read_field "$AFTER_RUN" tick_head_seq)
bp_sum=$(_read_field "$BEFORE_PROD" sum)
ap_sum=$(_read_field "$AFTER_PROD" sum)
br_ch=$(_read_field "$BEFORE_RUN" tick_channel)

FAIL=""
if [ "$ar_tick" -le "$br_tick" ]; then
  echo "[e0-verify] FAIL Z1: TICK_CHANNEL '$br_ch' head_seq did not grow (before=$br_tick after=$ar_tick); the loop wrote nothing to the tick board" >&2
  FAIL=1
fi
if [ "$ap_sum" -gt "$bp_sum" ]; then
  echo "[e0-verify] FAIL Z2: production bus sum(head_seq) grew (before=$bp_sum after=$ap_sum): production was polluted by this run" >&2
  FAIL=1
fi
# 终态断言（判据 4）：run.stdout.log 是 loop 的 stdout 归档，从中真解析末轮 termination.state。
# ⛔ 不得放宽成"loop 没报错就算过"——loop 退出 0 但板面无终态也必须非零退出。
TERM_STATE=""
if ! TERM_STATE="$(node "$PLUGIN_ROOT/scripts/e0-terminal-state.mjs" < "$RUN_STDOUT")"; then
  echo "[e0-verify] FAIL TERMINAL: loop output contains no termination JSON; the board has no terminal state (loop exit 0 is not enough)" >&2
  FAIL=1
elif [ -z "$TERM_STATE" ] || [ "$TERM_STATE" = "null" ]; then
  echo "[e0-verify] FAIL TERMINAL: loop reached no terminal state (termination.state is null); hasPendingWork false but the board is not terminal" >&2
  FAIL=1
fi
if [ -n "$FAIL" ]; then
  exit 3
fi
echo "[e0-verify] PASS: tick head_seq grew ($br_tick -> $ar_tick); production sum(head_seq) unchanged ($bp_sum -> $ap_sum); terminal state=$TERM_STATE" >&2
exit 0
