#!/usr/bin/env bash
set -euo pipefail

# E0 —— 实证判据分离（blocker 2 / Z1 / Z2 判别逻辑单独成脚本，供 bin/e0-regression.sh 调用，
#      也让单测能脱离重活直接判）。
# 输入：四次 e0-metrics snapshot 的 JSON 文件（均为单行 JSON，实取自列表端点）：
#   <before-run>  跑前 测试/运行总线快照
#   <after-run>   跑后 测试/运行总线快照
#   <before-prod> 跑前 生产总线快照
#   <after-prod>  跑后 生产总线快照
# 判据：
#   Z1 —— after-run.tick_head_seq 必须**严格大于** before-run.tick_head_seq
#         （loop 真写了总线；否则"loop 退出 0 但零写入/板面无终态"被放过）。
#   Z2 —— after-prod.sum 必须 **≤** before-prod.sum（生产总线零增长；增长即污染，点名）。
# 退出码：0 = 全部判据成立；非零 = 至少一条判据被违反（stderr 点名是 Z1 还是 Z2）。

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ "$#" -ne 4 ]; then
  echo "usage: bash bin/e0-verify.sh <before-run.json> <after-run.json> <before-prod.json> <after-prod.json>" >&2
  exit 2
fi
BEFORE_RUN="$1"
AFTER_RUN="$2"
BEFORE_PROD="$3"
AFTER_PROD="$4"

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
  echo "[e0-verify] FAIL Z1: TICK_CHANNEL '$br_ch' head_seq did not grow (before=$br_tick after=$ar_tick); loop wrote nothing or board has no terminal state" >&2
  FAIL=1
fi
if [ "$ap_sum" -gt "$bp_sum" ]; then
  echo "[e0-verify] FAIL Z2: production bus sum(head_seq) grew (before=$bp_sum after=$ap_sum): production was polluted by this run" >&2
  FAIL=1
fi
if [ -n "$FAIL" ]; then
  exit 3
fi
echo "[e0-verify] PASS: tick head_seq grew ($br_tick -> $ar_tick); production sum(head_seq) unchanged ($bp_sum -> $ap_sum)" >&2
exit 0
