#!/usr/bin/env bash
set -euo pipefail

# E0 —— 「真机端到端回归基线」唯一入口命令。
# 一条命令把现状链路在 **测试总线**（127.0.0.1:7495）上从头跑到终态：
#   导出 AGENT_BUS_URL / AGENT_BUS_TOKEN_FILE → 生产护栏 → channel 预备 → 跑 loop → 归档运行记录。
# 用法：
#   bash bin/e0-regression.sh                 # 缺省即可跑（profile e0-regression）
#   bash bin/e0-regression.sh --run <id>      # 可选覆盖 run id（缺省自动生成）
#   bash bin/e0-regression.sh --profile <p>   # 可选覆盖 profile（缺省 e0-regression）
#
# 退出码：0 = 链路跑到终态；非零 = 没跑到终态（含生产护栏拒绝、loop 失败）。绝不以 0 掩盖未跑完。

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── 参数：--run <id>（可选覆盖 run id）/ --profile <name>（可选覆盖 profile）。──
PROFILE="e0-regression"
RUN_ID="${DD_RUN_ID:-}"
_args=("$@")
for ((_i=0; _i<${#_args[@]}; _i++)); do
  case "${_args[$_i]}" in
    --run)
      _i=$((_i+1))
      if [ -z "${_args[$_i]:-}" ] || [[ "${_args[$_i]}" == --* ]]; then
        echo "[e0-regression] --run requires an operand (usage: --run <run-id>)" >&2
        exit 3
      fi
      RUN_ID="${_args[$_i]}"
      ;;
    --profile)
      _i=$((_i+1))
      if [ -z "${_args[$_i]:-}" ] || [[ "${_args[$_i]}" == --* ]]; then
        echo "[e0-regression] --profile requires an operand (usage: --profile <name>)" >&2
        exit 3
      fi
      PROFILE="${_args[$_i]}"
      ;;
    -h|--help)
      echo "usage: bash bin/e0-regression.sh [--run <id>] [--profile <name>]"
      exit 0
      ;;
  esac
done
if [ -z "$RUN_ID" ]; then
  RUN_ID="e0-$(date +%s%N)-$$"
fi

# ── 测试总线默认（可由显式 env 覆盖；覆盖后的**最终生效值**在护栏里复核）。──
export AGENT_BUS_URL="${AGENT_BUS_URL:-http://127.0.0.1:7495}"
export AGENT_BUS_TOKEN_FILE="${AGENT_BUS_TOKEN_FILE:-/data/agent-bus-test/tokens/uther-tui.token}"

# ── 加载 profile（显式 env 优先，绝不覆盖已显式给的 env）。──
PROFILE_FILE="$PLUGIN_ROOT/profiles/deploy/$PROFILE.env"
if [ ! -f "$PROFILE_FILE" ]; then
  echo "[e0-regression] unknown deploy profile '$PROFILE': $PROFILE_FILE not found" >&2
  exit 3
fi
while IFS= read -r _line || [ -n "$_line" ]; do
  case "$_line" in
    ''|\#*) continue ;;
    *=*)
      _key="${_line%%=*}"
      _val="${_line#*=}"
      if [ -z "${!_key+x}" ]; then
        export "$_key=$_val"
      fi
      ;;
  esac
done < "$PROFILE_FILE"
echo "[e0-regression] loaded deploy profile: $PROFILE ($PROFILE_FILE)" >&2

# ── 生产总线护栏：必须在任何 bus 写入之前发生。──
#   §2.3.3 —— 检查最终生效的 AGENT_BUS_URL / AGENT_BUS_TOKEN_FILE：
#   指向生产实例（端口 7490，或 token 落在 /data/agent-bus/ 下）⇒ 拒绝启动并非零退出。
if [[ "$AGENT_BUS_URL" == *":7490"* ]]; then
  echo "[e0-regression] REFUSING to start: AGENT_BUS_URL=$AGENT_BUS_URL targets the production agent-bus (port 7490). Set AGENT_BUS_URL to the test instance (default http://127.0.0.1:7495)." >&2
  exit 3
fi
if [[ "$AGENT_BUS_TOKEN_FILE" == /data/agent-bus/* ]]; then
  echo "[e0-regression] REFUSING to start: AGENT_BUS_TOKEN_FILE=$AGENT_BUS_TOKEN_FILE is under /data/agent-bus/ (production token directory). Use a test token path (default /data/agent-bus-test/tokens/uther-tui.token)." >&2
  exit 3
fi

# ── 归档根（仓外，不得落进仓内污染工作区）。──
E0_RECORD_ROOT="${E0_RECORD_ROOT:-/data/loop-engine/e0-runs}"
RECORD_DIR="$E0_RECORD_ROOT/$RUN_ID"
mkdir -p "$RECORD_DIR"

# ── channel 预备：profile 声明的 channel 若在测试总线上不存在则创建，已存在则原样使用。
#   创建与复核都走测试总线的 HTTP API（POST /v1/channels；GET /v1/channels/<id>）。
TOKEN="$(cat "$AGENT_BUS_TOKEN_FILE")"
_has_channel() {
  local ch="$1"
  local code
  code="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    "$AGENT_BUS_URL/v1/channels/$ch")"
  [ "$code" = "200" ]
}
_ensure_channel() {
  local ch="$1"
  if _has_channel "$ch"; then
    echo "[e0-regression] channel exists, using as-is: $ch" >&2
    return 0
  fi
  echo "[e0-regression] creating channel: $ch" >&2
  curl -s -X POST "$AGENT_BUS_URL/v1/channels" \
    -H "Authorization: Bearer $TOKEN" \
    -H 'Content-Type: application/json' \
    -d "{\"channel_id\":\"$ch\"}" >/dev/null
  if ! _has_channel "$ch"; then
    echo "[e0-regression] failed to create/verify channel: $ch" >&2
    return 1
  fi
}

_ensure_channel "$TICK_CHANNEL"
_ensure_channel "$EVIDENCE_CHANNEL"
_ensure_channel "$DOC_CHANNEL"

# ── 把 run 上下文导出，供 loop-engine run 目录与 idempotency key 落到本次记录目录下。──
export DD_RUN_ID="$RUN_ID"
export DD_RUN_ROOT="$RECORD_DIR/loop-run"

echo "[e0-regression] run_id=$RUN_ID"
echo "[e0-regression] record_dir=$RECORD_DIR"

# ── 跑现状链路到终态；完整 stdout/stderr 落盘，退出码单独记录。──
set +e
bash "$PLUGIN_ROOT/bin/deep-research-loop.sh" --profile "$PROFILE" \
  > "$RECORD_DIR/run.stdout.log" 2> "$RECORD_DIR/run.stderr.log"
LOOP_EXIT=$?
set -e

# ── 运行记录归档（§2.3.5）：入口命令 stdout/stderr、最终 exit code、profile 与 channel 名、
#    可据以回查的 loop-engine run 目录路径。⛔ 记录目录在仓外。──
{
  echo "run_id=$RUN_ID"
  echo "profile=$PROFILE"
  echo "tick_channel=$TICK_CHANNEL"
  echo "evidence_channel=$EVIDENCE_CHANNEL"
  echo "doc_channel=$DOC_CHANNEL"
  echo "loop_run_root=$RECORD_DIR/loop-run"
  echo "entry_exit_code=$LOOP_EXIT"
  echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$RECORD_DIR/run.meta"
cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt"

echo "[e0-regression] run record written: $RECORD_DIR (exit=$LOOP_EXIT)"

# 终态可判：0 = 跑到终态；非零 = 没跑到终态。绝不以 0 掩盖未跑完。
exit "$LOOP_EXIT"
