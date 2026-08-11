#!/usr/bin/env bash
set -euo pipefail

# E0 —— 「真机端到端回归基线」唯一入口命令。
# 一条命令把现状链路在 **测试总线**（127.0.0.1:7495）上从头跑到终态：
#   导出 AGENT_BUS_URL / AGENT_BUS_TOKEN_FILE → 生产护栏 → channel 预备 → 空板自播种 →
#   跑 loop → 实证判据验证 → 归档运行记录。
#
# E0a（本包）把 E0 的「退出码透传」改成「实证判据」：
#   - §1.1  channel 预备清单补上 RUNS_CHANNEL（run 生命周期 channel），名字只来自 profile（唯一真相源）。
#   - §1.2  空板自播种：板面无线索时调用既有 --seed 入口投一条 profile 声明的 SEED_CLUE。
#   - §1.3  终态判据改为实证断言（bin/e0-verify.sh）：loop 退出码 + 板面 head_seq 严格增长 +
#           板面达到可指认终态（termination.state !== null），全部通过才退出 0。
#   - §1.4  生产总线（http://127.0.0.1:7490）跑前/跑后只读读数 sum(head_seq) 进运行记录，
#           两读数不等 ⇒ 判失败（污染生产总线）。
#
# 用法：
#   bash bin/e0-regression.sh                 # 缺省即可跑（profile e0-regression）
#   bash bin/e0-regression.sh --run <id>      # 可选覆盖 run id（缺省自动生成）
#   bash bin/e0-regression.sh --profile <p>   # 可选覆盖 profile（缺省 e0-regression）
#
# 退出码：0 = 链路跑到终态且实证判据全过；非零 = 没跑到终态 / 判据不成立（含护栏拒绝、播种失败、loop 失败）。
#   绝不以 0 掩盖未跑完。⛔ 尤其禁止「loop 空转（零写入 / 板面无终态）却被判成功」。
#
# 测试注入（仅测试用，不改变生产语义）：E0_LOOP_CMD 覆盖 loop 命令，供单测构造
#   「loop 退出 0 但零写入 / 板面无终态」的判别性用例。

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
        echo "runs_channel=${RUNS_CHANNEL:-}"
        echo "loop_run_root=$RECORD_DIR/loop-run"
        echo "entry_exit_code=$ec"
        echo "tick_head_pre=${TICK_PRE:-}"
        echo "tick_head_post=${TICK_POST:-}"
        echo "termination_state=${TERM_STATE:-}"
        echo "prod_bus_sum_pre=${PROD_SUM_PRE:-}"
        echo "prod_bus_sum_post=${PROD_SUM_POST:-}"
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
#   ⛔ 护栏管的是「往哪写」（AGENT_BUS_*）；§1.4 的生产总线**只读**读数走独立的
#   PROD_BUS_URL / PROD_BUS_TOKEN_FILE，两者互不冲突——护栏不得误伤这个只读取证。
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

# ── §1.1 —— RUNS_CHANNEL 是 channel 预备清单的一部分：名字只来自 profile（唯一真相源），
#   入口绝不再次写死字面量。缺失 ⇒ 响亮失败（同 TICK_CHANNEL 语义）。
if [ -z "${RUNS_CHANNEL:-}" ]; then
  echo "[e0-regression] RUNS_CHANNEL is not set. Refusing to start: tick/harvest/triage read the run-lifecycle channel and its name must have a single source of truth (profile key)." >&2
  exit 3
fi

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
_ensure_channel "$RUNS_CHANNEL"

# ── 读测试总线上某 channel 的 head_seq（只读 GET；读失败即失败）。──
_head_seq() {
  local ch="$1" body hs
  body="$(curl -s -H "Authorization: Bearer $TOKEN" "$AGENT_BUS_URL/v1/channels/$ch")"
  hs="$(printf '%s' "$body" | sed -n 's/.*"head_seq"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | head -n1)"
  if [ -z "$hs" ]; then
    echo "[e0-regression] FAIL: could not read head_seq for channel '$ch' on test bus (body=$body)" >&2
    return 1
  fi
  printf '%s' "$hs"
}

# ── §1.4 —— 生产总线只读读数：跑前/跑后各读一次 channel 列表，求 sum(head_seq)。
#   ⛔ 只读 GET，绝不写入；读不到即失败（不得跳过检查）。凭证只以文件路径形式出现
#   （PROD_BUS_TOKEN_FILE），且走独立于 AGENT_BUS_* 的变量，不受生产护栏误伤。
PROD_BUS_URL="${PROD_BUS_URL:-http://127.0.0.1:7490}"
PROD_BUS_TOKEN_FILE="${PROD_BUS_TOKEN_FILE:-/data/agent-bus/tokens/uther-tui.token}"
_prod_sum() {
  local token body
  token="$(cat "$PROD_BUS_TOKEN_FILE" 2>/dev/null)" || {
    echo "[e0-regression] FAIL: cannot read production bus token file '$PROD_BUS_TOKEN_FILE'" >&2
    return 1
  }
  body="$(curl -sS -H "Authorization: Bearer $token" "$PROD_BUS_URL/v1/channels" 2>/dev/null)" || {
    echo "[e0-regression] FAIL: cannot read production bus channel list at $PROD_BUS_URL/v1/channels" >&2
    return 1
  }
  if [ -z "$body" ]; then
    echo "[e0-regression] FAIL: production bus returned an empty channel list at $PROD_BUS_URL/v1/channels" >&2
    return 1
  fi
  printf '%s' "$body" | sed -n 's/.*"head_seq"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' | awk '{s+=$1} END{print s+0}'
}

# ── §1.4 跑前生产总线读数（失败即失败，非零退出）。──
if ! PROD_SUM_PRE="$(_prod_sum)"; then
  echo "[e0-regression] FAIL: could not read production bus sum(head_seq) before run" >&2
  exit 3
fi

# ── §1.2/§1.3 —— 板面跑前 head_seq；空板（head_seq=0，即无任何线索）则自播种。──
if ! TICK_PRE="$(_head_seq "$TICK_CHANNEL")"; then
  echo "[e0-regression] FAIL: could not read research board head_seq before run" >&2
  exit 3
fi
if [ "$TICK_PRE" -eq 0 ]; then
  if [ -z "${SEED_CLUE:-}" ]; then
    echo "[e0-regression] FAIL: research board $TICK_CHANNEL is empty (head_seq=0) but SEED_CLUE is not set; cannot self-seed. Refusing to run an inevitably-idle loop." >&2
    exit 3
  fi
  echo "[e0-regression] seeding empty board $TICK_CHANNEL (SEED_CLUE)" >&2
  if ! SEED_OUT="$(bash "$PLUGIN_ROOT/bin/tick-entry.sh" --seed "$TICK_CHANNEL" --clue "$SEED_CLUE" 2>&1)"; then
    echo "[e0-regression] FAIL: seeding failed: $SEED_OUT. Refusing to continue into a loop that would run on a board with no initial clue." >&2
    exit 3
  fi
  echo "[e0-regression] seed result: $SEED_OUT" >&2
fi

# ── 把 run 上下文导出，供 loop-engine run 目录与 idempotency key 落到本次记录目录下。──
export DD_RUN_ID="$RUN_ID"
export DD_RUN_ROOT="$RECORD_DIR/loop-run"
export RUNS_CHANNEL

echo "[e0-regression] run_id=$RUN_ID"
echo "[e0-regression] record_dir=$RECORD_DIR"
echo "[e0-regression] tick_head_pre=$TICK_PRE"

# ── 跑现状链路到终态；完整 stdout/stderr 落盘，退出码单独记录。
#    E0_LOOP_CMD 仅测试注入：覆盖 loop 命令以构造判别性用例，生产缺省走 deep-research-loop.sh。──
set +e
if [ -n "${E0_LOOP_CMD:-}" ]; then
  bash -c "$E0_LOOP_CMD" > "$RECORD_DIR/run.stdout.log" 2> "$RECORD_DIR/run.stderr.log"
else
  bash "$PLUGIN_ROOT/bin/deep-research-loop.sh" --profile "$PROFILE" \
    > "$RECORD_DIR/run.stdout.log" 2> "$RECORD_DIR/run.stderr.log"
fi
LOOP_EXIT=$?
set -e

# ── §1.4 跑后生产总线读数（失败即失败，非零退出）。──
if ! PROD_SUM_POST="$(_prod_sum)"; then
  echo "[e0-regression] FAIL: could not read production bus sum(head_seq) after run" >&2
  exit 3
fi

# ── §1.3 板面跑后 head_seq + 从 loop 输出提取终态（--run JSON 的 termination.state）。──
if ! TICK_POST="$(_head_seq "$TICK_CHANNEL")"; then
  echo "[e0-regression] FAIL: could not read research board head_seq after run" >&2
  exit 3
fi
_termination_state() {
  local m state
  m="$(grep -oE '"termination"[[:space:]]*:[[:space:]]*\{[^{}]*\}' "$RECORD_DIR/run.stdout.log" 2>/dev/null | tail -n1)"
  if [ -z "$m" ]; then
    m="$(grep -oE '"termination"[[:space:]]*:[[:space:]]*\{[^}]*' "$RECORD_DIR/run.stdout.log" 2>/dev/null | tail -n1)"
  fi
  state="$(printf '%s' "$m" | sed -n 's/.*"state"[[:space:]]*:[[:space:]]*\([^,}]*\).*/\1/p' | tr -d ' "')"
  printf '%s' "$state"
}
TERM_STATE="$(_termination_state)"

# ── 运行记录归档（§2.3.5 / E0a §1.4）：入口命令 stdout/stderr、最终 exit code、profile 与
#    channel 名、板面跑前/跑后 head_seq、终态、生产总线跑前/跑后 sum(head_seq)。
#    ⛔ 记录目录在仓外。──
{
  echo "run_id=$RUN_ID"
  echo "profile=$PROFILE"
  echo "tick_channel=$TICK_CHANNEL"
  echo "evidence_channel=$EVIDENCE_CHANNEL"
  echo "doc_channel=$DOC_CHANNEL"
  echo "runs_channel=$RUNS_CHANNEL"
  echo "loop_run_root=$RECORD_DIR/loop-run"
  echo "entry_exit_code=$LOOP_EXIT"
  echo "tick_head_pre=$TICK_PRE"
  echo "tick_head_post=$TICK_POST"
  echo "termination_state=$TERM_STATE"
  echo "prod_bus_sum_pre=$PROD_SUM_PRE"
  echo "prod_bus_sum_post=$PROD_SUM_POST"
  echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$RECORD_DIR/run.meta"
cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt"

# ── §1.3/§1.4 实证判据：全过才退出 0；否则非零退出并点名哪一条、实测值多少。
#    退出码**不得**是 loop 退出码的透传（那是 E0 的判不出「链路没跑起来」的根因）。──
VERIFY_EXIT=0
bash "$PLUGIN_ROOT/bin/e0-verify.sh" \
  "$LOOP_EXIT" "$TICK_PRE" "$TICK_POST" "$TERM_STATE" "$PROD_SUM_PRE" "$PROD_SUM_POST" \
  || VERIFY_EXIT=$?

echo "[e0-regression] run record written: $RECORD_DIR"
echo "[e0-regression] verification: loop_exit=$LOOP_EXIT tick_head=$TICK_PRE->$TICK_POST termination=$TERM_STATE prod_sum=$PROD_SUM_PRE->$PROD_SUM_POST"
echo "[e0-regression] exit=$VERIFY_EXIT"

exit "$VERIFY_EXIT"
