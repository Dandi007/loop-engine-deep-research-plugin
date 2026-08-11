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

# §2.3.5 —— 归档入口命令自身的 stdout/stderr（profile-load、channel 预备等诊断行）。
# 从入口一开始就把脚本自身的 stdout/stderr tee 进一个临时缓冲（同时回显到原终端），
# 到记录目录就绪后由 EXIT trap 整体落入 run.entry.log；连同 loop 的 run.stdout.log /
# run.stderr.log 共同构成「入口命令的完整 stdout/stderr」。护栏拒绝（exit 3）或更早的
# 用法错误不建记录目录，缓冲随 trap 清理，不在仓内/记录根留下脏目录。
ENTRY_TMP="$(mktemp)"
exec 1> >(tee -a "$ENTRY_TMP")
exec 2> >(tee -a "$ENTRY_TMP" >&2)
# 记录持久化：先关掉 teed 的 fd1/fd2 让 tee 子进程收到 EOF、刷出缓冲并退出，再整体写入
# run.entry.log；若 run.meta 尚未写出（loop 前的早期失败），补写一份含最终退出码的最小记录。
_persist_record() {
  local ec=$?
  if [ -n "${RECORD_DIR:-}" ] && [ -d "$RECORD_DIR" ]; then
    exec 1>&- 2>&- 2>/dev/null || true
    wait 2>/dev/null || true
    cat "$ENTRY_TMP" > "$RECORD_DIR/run.entry.log" 2>/dev/null || true
    if [ ! -f "$RECORD_DIR/run.meta" ]; then
      {
        echo "run_id=$RUN_ID"
        echo "profile=$PROFILE"
        echo "tick_channel=${TICK_CHANNEL:-}"
        echo "evidence_channel=${EVIDENCE_CHANNEL:-}"
        echo "doc_channel=${DOC_CHANNEL:-}"
        echo "loop_run_root=$RECORD_DIR/loop-run"
        echo "entry_exit_code=$ec"
        echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      } > "$RECORD_DIR/run.meta" 2>/dev/null || true
      cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt" 2>/dev/null || true
    fi
  fi
}
# EXIT trap 按注册逆序执行（LIFO）：先注册 rm、后注册 persist ⇒ persist 先跑、rm 后跑。
trap 'rm -f "$ENTRY_TMP"' EXIT
trap '_persist_record' EXIT

# ── 测试总线默认（可由显式 env 覆盖；覆盖后的**最终生效值**在护栏里复核）。──
export AGENT_BUS_URL="${AGENT_BUS_URL:-http://127.0.0.1:7495}"
export AGENT_BUS_TOKEN_FILE="${AGENT_BUS_TOKEN_FILE:-/data/agent-bus-test/tokens/uther-tui.token}"

# ── 生产总线只读采样（Z2）：跑前跑后各读一次 sum(head_seq)，证明本次运行零污染。
#    ⛔ 只读，绝不写生产；护栏只约束运行用的 AGENT_BUS_URL，生产采样是独立只读 URL。
#    ⛔ 一律从 **列表端点** GET /v1/channels 取 head_seq（真实 API 的单 channel GET 没有该字段）。
export E0_PROD_BUS_URL="${E0_PROD_BUS_URL:-http://127.0.0.1:7490}"
export E0_PROD_BUS_TOKEN_FILE="${E0_PROD_BUS_TOKEN_FILE:-/data/agent-bus/tokens/uther-tui.token}"

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
# §1 —— 预备清单含系统板 board:agent-runs（该名字在仓内只有一处真相源：本变量）。
BOARD_AGENT_RUNS_CHANNEL="board:agent-runs"
_ensure_channel "$BOARD_AGENT_RUNS_CHANNEL"

# ── 空板自播种（§1.1 / 判据 5）：新建的 TICK_CHANNEL 若为空则投 research.clue.v2 种子线索，
#    让现状链路有卡可认领、head_seq 可增长 ⇒ Z1（判据 8）在结构上可达。
#    ⛔ 幂等：scripts/e0-seed.mjs 仅当板为空（head_seq=0）才播种；已非空则跳过，重复执行不使板面线索翻倍。
#    ⛔ head_seq 一律走列表端点真解析（复用 e0-metrics），⛔ 不依赖单 channel GET 的 head_seq。
echo "[e0-regression] auto-seed check: TICK_CHANNEL=$TICK_CHANNEL" >&2
# ⛔ 必须带 --source code-local（attempt 5 评审 blocker）：不带 source 的种子卡 sources=[] ⇒
#    decideTick 结构上只能 block ⇒ 单 tick 终态、termination.state 恒 null ⇒ Z1（判据 8）在构造上
#    不可达。--source code-local 使种子卡映射到 dr-worker-code-local（profile 已配 ALLOWED_ROOT），
#    可被 dispatch → 收割 → 覆盖 → 达终态。--source 逐条原样转发给 tick-entry --seed。
E0_SEED_JSON="$(node "$PLUGIN_ROOT/scripts/e0-seed.mjs" "$AGENT_BUS_URL" "$AGENT_BUS_TOKEN_FILE" "$TICK_CHANNEL" --clue "$RESEARCH_QUESTION" --source code-local)"
echo "[e0-regression] auto-seed: $E0_SEED_JSON" >&2

# ── 把 run 上下文导出，供 loop-engine run 目录与 idempotency key 落到本次记录目录下。──
export DD_RUN_ID="$RUN_ID"
export DD_RUN_ROOT="$RECORD_DIR/loop-run"

echo "[e0-regression] run_id=$RUN_ID"
echo "[e0-regression] record_dir=$RECORD_DIR"

# ── 实证读数：head_seq / sum 一律走 scripts/e0-metrics.mjs（真实 JSON 解析，⛔ 不用贪婪正则）。
#    Z1 —— 测试总线 TICK head_seq 跑前基线；Z2 —— 生产总线 sum(head_seq) 跑前基线。
E0_METRICS="$PLUGIN_ROOT/scripts/e0-metrics.mjs"
BEFORE_RUN_JSON="$(node "$E0_METRICS" snapshot "$AGENT_BUS_URL" "$AGENT_BUS_TOKEN_FILE" "$TICK_CHANNEL")"
BEFORE_PROD_JSON="$(node "$E0_METRICS" sum "$E0_PROD_BUS_URL" "$E0_PROD_BUS_TOKEN_FILE")"
echo "[e0-regression] before: run-tick=$TICK_CHANNEL ($(printf '%s' "$BEFORE_RUN_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.tick_head_seq))})')) prod-sum=$(printf '%s' "$BEFORE_PROD_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.sum))})')" >&2

# ── 跑现状链路到终态；完整 stdout/stderr 落盘，退出码单独记录。──
set +e
bash "$PLUGIN_ROOT/bin/deep-research-loop.sh" --profile "$PROFILE" \
  > "$RECORD_DIR/run.stdout.log" 2> "$RECORD_DIR/run.stderr.log"
LOOP_EXIT=$?
set -e

# ── 跑后读数（Z1/Z2）：测试总线 TICK head_seq、生产总线 sum(head_seq)。──
AFTER_RUN_JSON="$(node "$E0_METRICS" snapshot "$AGENT_BUS_URL" "$AGENT_BUS_TOKEN_FILE" "$TICK_CHANNEL")"
AFTER_PROD_JSON="$(node "$E0_METRICS" sum "$E0_PROD_BUS_URL" "$E0_PROD_BUS_TOKEN_FILE")"
echo "[e0-regression] after: run-tick=$(printf '%s' "$AFTER_RUN_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.tick_head_seq))})') prod-sum=$(printf '%s' "$AFTER_PROD_JSON" | node -e 'let s="";process.stdin.on("data",d=>s+=d);process.stdin.on("end",()=>{const j=JSON.parse(s);process.stdout.write(String(j.sum))})')" >&2

# ── 实证判据（Z1/Z2）：只有 loop 本身跑到终态（exit 0）才判；否则以 loop 失败码退出。
#    两条读数的**全量 JSON**都落进运行记录，供派发方用独立实现交叉复算。──
printf '%s\n' "$BEFORE_RUN_JSON" > "$RECORD_DIR/before.run.json"
printf '%s\n' "$AFTER_RUN_JSON" > "$RECORD_DIR/after.run.json"
printf '%s\n' "$BEFORE_PROD_JSON" > "$RECORD_DIR/before.prod.json"
printf '%s\n' "$AFTER_PROD_JSON" > "$RECORD_DIR/after.prod.json"

# ── 运行记录归档（§2.3.5）：入口命令 stdout/stderr、最终 exit code、profile 与 channel 名、
#    可据以回查的 loop-engine run 目录路径。⛔ 记录目录在仓外。──
if [ "$LOOP_EXIT" -ne 0 ]; then
  FINAL_EXIT="$LOOP_EXIT"
else
  set +e
  bash "$PLUGIN_ROOT/bin/e0-verify.sh" \
    "$RECORD_DIR/before.run.json" "$RECORD_DIR/after.run.json" \
    "$RECORD_DIR/before.prod.json" "$RECORD_DIR/after.prod.json" \
    "$RECORD_DIR/run.stdout.log"
  VERIFY_EXIT=$?
  set -e
  FINAL_EXIT="$VERIFY_EXIT"
fi
{
  echo "run_id=$RUN_ID"
  echo "profile=$PROFILE"
  echo "tick_channel=$TICK_CHANNEL"
  echo "evidence_channel=$EVIDENCE_CHANNEL"
  echo "doc_channel=$DOC_CHANNEL"
  echo "loop_run_root=$RECORD_DIR/loop-run"
  echo "entry_exit_code=$FINAL_EXIT"
  echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$RECORD_DIR/run.meta"
cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt"

echo "[e0-regression] run record written: $RECORD_DIR (exit=$FINAL_EXIT)"

# 终态可判：0 = 跑到终态且实证判据成立；非零 = 没跑到终态或实证判据被违反。绝不以 0 掩盖未跑完。
exit "$FINAL_EXIT"
