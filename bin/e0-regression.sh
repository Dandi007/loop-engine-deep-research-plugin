#!/usr/bin/env bash
set -euo pipefail

# E0c1 —— 「真机端到端回归基线」唯一入口命令（板面与凭证域）。
# 一条命令把现状链路在 **测试总线**（127.0.0.1:7495）上从头跑到终态：
#   导出 AGENT_BUS_URL / AGENT_BUS_TOKEN_FILE → 生产护栏 →
#   §1.3 per-run channel 派生 + 预备（含 board:agent-runs）→
#   §1.2 生产总线 sum(head_seq) 跑前读数 → §1.4 空板自播种（带 --source）→
#   跑 loop → §1.2 生产总线 sum(head_seq) 跑后读数（两读数写进运行记录，不等则失败）→ 归档。
# 用法：
#   bash bin/e0-regression.sh                 # 缺省即可跑（profile e0-regression）
#   bash bin/e0-regression.sh --run <id>      # 可选覆盖 run id（缺省自动生成）
#   bash bin/e0-regression.sh --profile <p>   # 可选覆盖 profile（缺省 e0-regression）
#
# 退出码：0 = 链路跑到终态；非零 = 没跑到终态（含生产护栏拒绝、loop 失败、§1.2 读数不等）。
# 绝不以 0 掩盖未跑完。

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# E0c1 §1.3 / 判据 6 —— board:agent-runs 是全局 channel，名字在仓内只有一处真相源
# （src/run-channels.ts:RUNS_CHANNEL_ID）。bash 侧**不再写第二份字面量**：从该 TS 常量
# 经 vite-node 解析（与 §1.2 prod-read 同款调用），确保 entry 预备/记录的 channel 与
# harvest/triage 读的 channel 永远来自同一处。解析失败即响亮失败（⛔ 不回退字面量）。
_resolve_runs_channel_id() {
  AGENT_RUN_BIN="${AGENT_RUN_BIN:-}" \
    node "$PLUGIN_ROOT/node_modules/.bin/vite-node" "$PLUGIN_ROOT/src/e0c1-runs-channel.ts"
}
if ! RUNS_CHANNEL_ID="$(_resolve_runs_channel_id)"; then
  echo "[e0-regression] REFUSING to start: failed to resolve RUNS_CHANNEL_ID from src/run-channels.ts (spec §1.3 / 判据 6: the name has exactly one source of truth; refusing to fall back to a hardcoded literal)." >&2
  exit 3
fi
if [ -z "$RUNS_CHANNEL_ID" ]; then
  echo "[e0-regression] REFUSING to start: RUNS_CHANNEL_ID resolved to empty from src/run-channels.ts (spec §1.3: refusing to fall back to a hardcoded literal)." >&2
  exit 3
fi

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
# 到记录目录就绪后由 EXIT trap 整体落入 run.entry.log；连同 loop 的 drain-rounds/drain-N.{stdout,stderr}.log
# 共同构成「入口命令的完整 stdout/stderr」。护栏拒绝（exit 3）或更早的
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
        echo "runs_channel=$RUNS_CHANNEL_ID"
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
# 提前到 profile 键校验之前：E0c1 §1.4 的 SEED_SOURCES/SEED_CLUE 校验失败也要能落记录、
# 且让 EXIT trap 的 _persist_record 关闭 teed fd（刷出 stderr 给捕获方），否则 tee 缓冲的
# 错误行不会出现在调用方收到的 stderr 里。
E0_RECORD_ROOT="${E0_RECORD_ROOT:-/data/loop-engine/e0-runs}"
RECORD_DIR="$E0_RECORD_ROOT/$RUN_ID"
mkdir -p "$RECORD_DIR"

# E0c1 §1.4 —— 播种所需键必须由 profile 声明（种子文本 + sources）。
# ⛔ 不写死在脚本里（spec §1.4）；缺失 ⇒ 响亮失败（GT-2：不静默播一条 sources:[] 的线索）。
if [ -z "${SEED_CLUE:-}" ]; then
  echo "[e0-regression] REFUSING to start: SEED_CLUE is not declared by profile '$PROFILE' (spec §1.4: seed text must be profile-declared and repo-relevant). Empty-board seeding is mandatory." >&2
  exit 3
fi
if [ -z "${SEED_SOURCES:-}" ]; then
  echo "[e0-regression] REFUSING to start: SEED_SOURCES is not declared by profile '$PROFILE' (spec §1.4 / GT-2: sources must be profile-declared and non-empty; a sources:[] clue is structurally blocked on the real board)." >&2
  exit 3
fi

# E0c1 §1.3 —— 派生本次 run 的三条 research channel（profile 基名 + run_id 段）。
# 与 src/run-channels.ts:perRunResearchChannels 同形（sha256(run_id)[:16] 作为派生段）。
if [ -z "${RESEARCH_PROFILE_BASE:-}" ]; then
  echo "[e0-regression] REFUSING to start: RESEARCH_PROFILE_BASE is not declared by profile '$PROFILE' (spec §1.3: per-run research channels are derived from the profile base name + run_id)." >&2
  exit 3
fi
RUN_SEGMENT="$(printf '%s' "$RUN_ID" | sha256sum | cut -c1-16)"
TICK_CHANNEL="research:${RESEARCH_PROFILE_BASE}-${RUN_SEGMENT}.index"
EVIDENCE_CHANNEL="research:${RESEARCH_PROFILE_BASE}-${RUN_SEGMENT}.evidence"
DOC_CHANNEL="research:${RESEARCH_PROFILE_BASE}-${RUN_SEGMENT}.docs"
export TICK_CHANNEL EVIDENCE_CHANNEL DOC_CHANNEL

# ── channel 预备：派生出的 per-run channel + 全局 board:agent-runs 若在测试总线上不存在则创建。
#   创建与复核都走测试总线的 HTTP API（POST /v1/channels；GET /v1/channels/<id>）。
#   E0c1 §1.3 —— board:agent-runs 是全局的、不随 run 变，但**必须在预备清单里**
#   （harvest/triage 都读它）。⛔ 不得删除/清空旧 channel（bus append-only 无 DELETE）。
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
# E0c1 §1.3 / 验收判据 6 —— board:agent-runs 在预备清单内（名字来自 RUNS_CHANNEL_ID 单一真相源）。
_ensure_channel "$RUNS_CHANNEL_ID"

# E0c1 §1.2 —— 生产总线 sum(head_seq) 跑前读数（http://127.0.0.1:7490，只读 GET）。
#   两个读数（跑前/跑后）写进运行记录；不等 ⇒ 判失败并非零退出。读失败即失败（⛔ 不得跳过检查）。
#   生产总线 URL/token 与测试总线独立（不受 AGENT_BUS_URL 覆盖影响）；
#   可用 E0C1_PROD_BUS_URL / E0C1_PROD_BUS_TOKEN_FILE 显式覆盖（测试注入用，生产路径不变）。
PROD_BUS_URL="${E0C1_PROD_BUS_URL:-http://127.0.0.1:7490}"
PROD_BUS_TOKEN_FILE="${E0C1_PROD_BUS_TOKEN_FILE:-/data/agent-bus/tokens/uther-tui.token}"
_read_prod_head_seq_sum() {
  # 真解析 + 真求和（GT-3）：用 node JSON.parse，⛔ 禁止贪婪正则抽多值。
  # 通过 node 调 src/bus.ts 的 listChannelsAt + sumHeadSeqAcrossChannels 以复用单一真相源。
  # 不再丢弃子进程 stderr：把它的 stderr 透传给调用方（与 e0c1-prod-read.ts 自己的 stderr 合并），
  # 这样 §1.2 读失败的根因（token 读不到、HTTP 状态、非数值 head_seq）能落到运行记录里便于诊断。
  local _ec _out _err
  set +e
  _out="$(AGENT_RUN_BIN="${AGENT_RUN_BIN:-}" E0C1_PROD_BUS_URL="$PROD_BUS_URL" E0C1_PROD_BUS_TOKEN_FILE="$PROD_BUS_TOKEN_FILE" \
    node "$PLUGIN_ROOT/node_modules/.bin/vite-node" "$PLUGIN_ROOT/src/e0c1-prod-read.ts" 2>"$ENTRY_TMP.prod-read.err")"
  _ec=$?
  set -e
  if [ "$_ec" -ne 0 ]; then
    _err="$(cat "$ENTRY_TMP.prod-read.err" 2>/dev/null || true)"
    rm -f "$ENTRY_TMP.prod-read.err" 2>/dev/null || true
    echo "[e0-regression] production bus read failed (exit=$_ec): ${_err:-<no stderr>}" >&2
    return "$_ec"
  fi
  rm -f "$ENTRY_TMP.prod-read.err" 2>/dev/null || true
  printf '%s' "$_out"
}

echo "[e0-regression] reading production bus sum(head_seq) BEFORE run ($PROD_BUS_URL)" >&2
if ! PROD_SUM_BEFORE="$(_read_prod_head_seq_sum)"; then
  echo "[e0-regression] REFUSING to continue: failed to read production bus sum(head_seq) before run (spec §1.2: the before/after production-bus read is mandatory; read failure is failure). PROD_BUS_URL=$PROD_BUS_URL" >&2
  exit 3
fi
echo "[e0-regression] prod_bus_sum(head_seq)_before=$PROD_SUM_BEFORE" >&2
echo "$PROD_SUM_BEFORE" > "$RECORD_DIR/prod_bus_sum_before.json"

# ── 把 run 上下文导出，供 loop-engine run 目录与 idempotency key 落到本次记录目录下。──
export DD_RUN_ID="$RUN_ID"
export DD_RUN_ROOT="$RECORD_DIR/loop-run"

echo "[e0-regression] run_id=$RUN_ID"
echo "[e0-regression] record_dir=$RECORD_DIR"
echo "[e0-regression] tick_channel=$TICK_CHANNEL (per-run derived)"

# E0c1 §1.4 —— 空板自播种：per-run 板（刚创建、必为空）⇒ 必然需要播种。
#   种子文本与 sources 均由 profile 声明（SEED_CLUE / SEED_SOURCES），⛔ 不写死在脚本里。
#   幂等：idempotency key 由输入确定性派生（src/tick-seed.ts:buildSeedIdempotencyKey），重复播种不会翻倍。
#   播种失败 ⇒ 响亮失败、非零退出（GT-2：sources 必须非空）。
#   SEED_SOURCES 支持逗号/空格分隔的多个 source（GT-2：multi-source profile 必须作为列表传入，
#   而不是一整个 bogus source 名字）；这里拆成重复的 --source 操作数。
echo "[e0-regression] seeding empty per-run board: $TICK_CHANNEL (sources=$SEED_SOURCES)" >&2
_seed_args=()
for _src in $(printf '%s' "$SEED_SOURCES" | tr ',' ' '); do
  if [ -n "$_src" ]; then
    _seed_args+=(--source "$_src")
  fi
done
if [ "${#_seed_args[@]}" -eq 0 ]; then
  echo "[e0-regression] REFUSING to continue: SEED_SOURCES declared but produced no --source operands after splitting (spec §1.4 / GT-2: sources must be non-empty and parseable)." >&2
  exit 3
fi
set +e
SEED_LOG="$(AGENT_RUN_BIN="${AGENT_RUN_BIN:-}" node "$PLUGIN_ROOT/node_modules/.bin/vite-node" "$PLUGIN_ROOT/src/tick-entry.ts" -- \
  --seed "$TICK_CHANNEL" --clue "$SEED_CLUE" "${_seed_args[@]}" 2>&1)"
SEED_EXIT=$?
set -e
unset _seed_args _src
echo "$SEED_LOG" > "$RECORD_DIR/seed.log"
if [ "$SEED_EXIT" -ne 0 ]; then
  echo "[e0-regression] REFUSING to continue: seeding failed (exit=$SEED_EXIT). spec §1.4: seeding failure must fail loudly (GT-2: sources must be non-empty and profile-declared)." >&2
  echo "$SEED_LOG" >&2
  # 仍写出运行记录（含播种失败退出码），便于回查。
  {
    echo "run_id=$RUN_ID"
    echo "profile=$PROFILE"
    echo "tick_channel=$TICK_CHANNEL"
    echo "evidence_channel=$EVIDENCE_CHANNEL"
    echo "doc_channel=$DOC_CHANNEL"
    echo "runs_channel=$RUNS_CHANNEL_ID"
    echo "seed_exit_code=$SEED_EXIT"
    echo "prod_bus_sum_before=$PROD_SUM_BEFORE"
    echo "loop_run_root=$RECORD_DIR/loop-run"
    echo "entry_exit_code=3"
    echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$RECORD_DIR/run.meta"
  cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt"
  exit 3
fi
echo "$SEED_LOG" >&2

# E0c2 §1.3 —— 跨 drain 循环参数校验（由 profile 声明，⛔ 不写死在脚本里）。
# 缺失即响亮失败（与 SEED_CLUE / SEED_SOURCES / RESEARCH_PROFILE_BASE 范式一致）。
if [ -z "${DRAIN_BACKOFF_SECONDS:-}" ]; then
  echo "[e0-regression] REFUSING to start: DRAIN_BACKOFF_SECONDS is not declared by profile '$PROFILE' (spec §1.3: backoff must be profile-declared, not hardcoded)." >&2
  exit 3
fi
if [ -z "${DRAIN_MAX_ATTEMPTS:-}" ]; then
  echo "[e0-regression] REFUSING to start: DRAIN_MAX_ATTEMPTS is not declared by profile '$PROFILE' (spec §1.3: max attempts must be profile-declared, not hardcoded)." >&2
  exit 3
fi
if [ -z "${DRAIN_WALL_CLOCK_SECONDS:-}" ]; then
  echo "[e0-regression] REFUSING to start: DRAIN_WALL_CLOCK_SECONDS is not declared by profile '$PROFILE' (spec §1.3: wall clock limit must be profile-declared, not hardcoded)." >&2
  exit 3
fi

# ── E0c3b §1.2 —— 板面构成辅助函数：从最后 drain 的 termination JSON 提取板面构成与 triage 阈值，
#   并输出诊断行（含 triage 门限死锁点名）。$1 = termination JSON（含 boardComposition/triageThreshold）。
_print_board_composition() {
  local term_json="$1"
  local bc prop open inflight expl blocked threshold
  local extracted
  if ! extracted="$(printf '%s' "$term_json" | node -e "
    let s='';
    process.stdin.on('data',d=>s+=d).on('end',()=>{
      try {
        const o=JSON.parse(s.trim());
        const bc=o.boardComposition||{};
        const t=o.triageThreshold;
        process.stdout.write(JSON.stringify({bc,t}));
      } catch { process.stdout.write('{}'); }
    });
  " 2>/dev/null)"; then
    echo "[e0-regression] board composition unavailable" >&2
    return
  fi
  bc="$(printf '%s' "$extracted" | node -e "
    let s='';
    process.stdin.on('data',d=>s+=d).on('end',()=>{
      const o=JSON.parse(s.trim());
      const bc=o.bc||{};
      process.stdout.write('proposed='+(bc.proposed||0)+' open='+(bc.open||0)+' in_flight='+(bc.inFlight||0)+' explored='+(bc.explored||0)+' blocked='+(bc.blocked||0));
    });
  " 2>/dev/null)" || bc="composition unavailable"
  threshold="$(printf '%s' "$extracted" | node -e "
    let s='';
    process.stdin.on('data',d=>s+=d).on('end',()=>{
      const o=JSON.parse(s.trim());
      process.stdout.write(String(o.t||''));
    });
  " 2>/dev/null)" || threshold=""
  echo "[e0-regression] board: ${bc}" >&2
  if [ -n "$threshold" ]; then
    prop="$(printf '%s' "$extracted" | node -e "
      let s='';
      process.stdin.on('data',d=>s+=d).on('end',()=>{
        const o=JSON.parse(s.trim());
        process.stdout.write(String((o.bc||{}).proposed||0));
      });
    " 2>/dev/null)" || prop=""
    if [ -n "$prop" ] && [ "$prop" -gt 0 ] && [ "$prop" -lt "$threshold" ]; then
      echo "[e0-regression] TRIAGE THRESHOLD DEADLOCK: proposed=${prop} < triageThreshold=${threshold} — triage will never trigger, board can never drain (spec GT-11)." >&2
    fi
  fi
}

# ── E0c2 §1.3 —— 跨 drain 循环：反复跑 deep-research-loop.sh 直到终态收敛。──
# 每轮：跑 drain → 分类退出码（GT-6）→ 读 termination.state（§1.1）→ 判终态或退避重来。
# E0c8 §1.1b（GT-19）—— 墙钟为主：只要墙钟没用完就继续退避重试，不得让固定 attempt 次数
#   先撞线。DRAIN_MAX_ATTEMPTS 是失控兜底（正常情形下不可能先于墙钟触发），
#   必须显著大于 floor(wall_clock / (最短 drain + backoff))。
#   自洽校验：DRAIN_WALL_CLOCK_SECONDS=2400, DRAIN_BACKOFF_SECONDS=120, 最短 drain≈3s
#   ⇒ 2400/(3+120)≈19.5 ⇒ DRAIN_MAX_ATTEMPTS=40 > 19.5×1.5 ⇒ 正常情形下不可能先于墙钟触发。
WALL_START=$(date +%s)
DRAIN_ATTEMPT=0
TERMINATION_STATE="null"
LOOP_EXIT=0
DRAIN_RECORDS=""

mkdir -p "$RECORD_DIR/drain-rounds"

_drain_fail_echo() {
  local attempt="$1" exit_code="$2" reason="$3"
  echo "[e0-regression] DRAIN FAILED (attempt ${attempt}): reason=${reason} exit=${exit_code}" >&2
  echo "[e0-regression] drain stdout:" >&2
  cat "$RECORD_DIR/drain-rounds/drain-${attempt}.stdout.log" >&2
  echo "[e0-regression] drain stderr:" >&2
  cat "$RECORD_DIR/drain-rounds/drain-${attempt}.stderr.log" >&2
}

while true; do
  # E0c8 §1.1b（GT-19）—— 墙钟上限检查（先于次数上限，使墙钟成为主限制器）。
  NOW=$(date +%s)
  ELAPSED=$((NOW - WALL_START))
  if [ "$ELAPSED" -ge "$DRAIN_WALL_CLOCK_SECONDS" ]; then
    echo "[e0-regression] HIT WALL CLOCK LIMIT: wall_clock_seconds=${DRAIN_WALL_CLOCK_SECONDS} elapsed=${ELAPSED} drain_attempts=${DRAIN_ATTEMPT}" >&2
    if [ "$DRAIN_ATTEMPT" -gt 0 ]; then
      _last_stdout="$RECORD_DIR/drain-rounds/drain-${DRAIN_ATTEMPT}.stdout.log"
      if [ -f "$_last_stdout" ]; then
        _last_term="$(printf '%s' "$DRAIN_SUMMARY" | node "$PLUGIN_ROOT/scripts/read-termination.mjs" 2>/dev/null)" || _last_term=""
        if [ -n "$_last_term" ]; then
          _print_board_composition "$_last_term"
        fi
      fi
    fi
    LOOP_EXIT=4
    break
  fi

  # 次数上限检查（失控兜底：仅当墙钟也已耗尽时才触发，正常情形下不可能先于墙钟触发）。
  # GT-19：墙钟为主限制器，attempt 次数不得独立决定退出。
  if [ "$DRAIN_ATTEMPT" -ge "$DRAIN_MAX_ATTEMPTS" ]; then
    NOW=$(date +%s)
    ELAPSED=$((NOW - WALL_START))
    if [ "$ELAPSED" -ge "$DRAIN_WALL_CLOCK_SECONDS" ]; then
      echo "[e0-regression] HIT WALL CLOCK LIMIT (also hit attempt limit): wall_clock_seconds=${DRAIN_WALL_CLOCK_SECONDS} elapsed=${ELAPSED} max_attempts=${DRAIN_MAX_ATTEMPTS} drain_attempts=${DRAIN_ATTEMPT}" >&2
      _last_stdout="$RECORD_DIR/drain-rounds/drain-${DRAIN_ATTEMPT}.stdout.log"
      if [ -f "$_last_stdout" ]; then
        _last_term="$(printf '%s' "$DRAIN_SUMMARY" | node "$PLUGIN_ROOT/scripts/read-termination.mjs" 2>/dev/null)" || _last_term=""
        if [ -n "$_last_term" ]; then
          _print_board_composition "$_last_term"
        fi
      fi
      LOOP_EXIT=4
      break
    fi
    # 墙钟仍充足 ⇒ 不退出，继续退避重试。
    echo "[e0-regression] attempt limit ${DRAIN_MAX_ATTEMPTS} reached but wall clock still has $((DRAIN_WALL_CLOCK_SECONDS - ELAPSED))s remaining — continuing" >&2
  fi

  DRAIN_ATTEMPT=$((DRAIN_ATTEMPT + 1))

  # ── 跑一次 drain ──
  set +e
  bash "$PLUGIN_ROOT/bin/deep-research-loop.sh" --profile "$PROFILE" \
    > "$RECORD_DIR/drain-rounds/drain-${DRAIN_ATTEMPT}.stdout.log" \
    2> "$RECORD_DIR/drain-rounds/drain-${DRAIN_ATTEMPT}.stderr.log"
  DRAIN_EXIT=$?
  set -e

  # GT-7：逐行 JSON.parse 取摘要（⛔ 禁止花括号正则）
  DRAIN_SUMMARY=""
  if ! DRAIN_SUMMARY="$(node "$PLUGIN_ROOT/scripts/drain-parse-summary.mjs" \
    < "$RECORD_DIR/drain-rounds/drain-${DRAIN_ATTEMPT}.stdout.log" 2>/dev/null)"; then
    _drain_fail_echo "$DRAIN_ATTEMPT" "$DRAIN_EXIT" "parse_error"
    LOOP_EXIT=5
    break
  fi

  # 从摘要取 reason
  DRAIN_REASON=""
  DRAIN_REASON="$(printf '%s' "$DRAIN_SUMMARY" | node -e "
    let s='';
    process.stdin.on('data',d=>s+=d).on('end',()=>{
      try { const o=JSON.parse(s.trim()); process.stdout.write(String(o.reason||'')); }
      catch { process.stdout.write(''); }
    });
  " 2>/dev/null)" || DRAIN_REASON=""

  # GT-6：分类退出码
  if [ "$DRAIN_REASON" = "max_rounds" ]; then
    if [ "$DRAIN_EXIT" -ne 1 ]; then
      _drain_fail_echo "$DRAIN_ATTEMPT" "$DRAIN_EXIT" "max_rounds_unexpected_exit"
      LOOP_EXIT=5
      break
    fi
    # max_rounds + exit 1 ⇒ 还没收敛，退避重来
  elif [ "$DRAIN_REASON" = "drained" ]; then
    # drained ⇒ 继续判终态
    :
  else
    if [ "$DRAIN_EXIT" -ne 0 ]; then
      _drain_fail_echo "$DRAIN_ATTEMPT" "$DRAIN_EXIT" "${DRAIN_REASON:-unknown}"
      LOOP_EXIT=5
      break
    fi
  fi

  # §1.1：读本次的 termination.state
  TERM_JSON=""
  if ! TERM_JSON="$(printf '%s' "$DRAIN_SUMMARY" | node "$PLUGIN_ROOT/scripts/read-termination.mjs" 2>&1)"; then
    echo "[e0-regression] FAILED to read termination.state (attempt ${DRAIN_ATTEMPT}): ${TERM_JSON}" >&2
    _drain_fail_echo "$DRAIN_ATTEMPT" "$DRAIN_EXIT" "read_termination_failed"
    LOOP_EXIT=5
    break
  fi

  if ! TERMINATION_STATE="$(printf '%s' "$TERM_JSON" | node -e "
    let s='';
    process.stdin.on('data',d=>s+=d).on('end',()=>{
      try { const o=JSON.parse(s.trim()); process.stdout.write(String(o.state||'null')); }
      catch { process.stderr.write('E0c2: failed to parse termination JSON from read-termination output\n'); process.exit(1); }
    });
  " 2>/dev/null)"; then
    echo "[e0-regression] FAILED to extract termination.state from read-termination output (attempt ${DRAIN_ATTEMPT})" >&2
    _drain_fail_echo "$DRAIN_ATTEMPT" "$DRAIN_EXIT" "termination_parse_failed"
    LOOP_EXIT=5
    break
  fi

  # 读板面 head_seq（复用 E0c1 已交付的列表端点读法，GT-8）
  HEAD_SEQ="?"
  if HEAD_SEQ="$(AGENT_RUN_BIN="${AGENT_RUN_BIN:-}" \
    node "$PLUGIN_ROOT/node_modules/.bin/vite-node" "$PLUGIN_ROOT/src/e0c2-head-seq.ts" "$TICK_CHANNEL" 2>/dev/null)"; then
    : # HEAD_SEQ 已赋值
  else
    HEAD_SEQ="?"
  fi

  # 从摘要取 runs_root
  DRAIN_RUNS_ROOT=""
  DRAIN_RUNS_ROOT="$(printf '%s' "$DRAIN_SUMMARY" | node -e "
    let s='';
    process.stdin.on('data',d=>s+=d).on('end',()=>{
      try { const o=JSON.parse(s.trim()); process.stdout.write(String(o.runs_root||'')); }
      catch { process.stdout.write(''); }
    });
  " 2>/dev/null)" || DRAIN_RUNS_ROOT=""

  # 进度行
  echo "[e0-regression] drain #${DRAIN_ATTEMPT}: reason=${DRAIN_REASON} termination.state=${TERMINATION_STATE} head_seq=${HEAD_SEQ}"

  # 追加运行记录
  DRAIN_RECORDS="${DRAIN_RECORDS}drain_attempt_${DRAIN_ATTEMPT}_reason=${DRAIN_REASON} "
  DRAIN_RECORDS="${DRAIN_RECORDS}termination_state=${TERMINATION_STATE} "
  DRAIN_RECORDS="${DRAIN_RECORDS}head_seq=${HEAD_SEQ} "
  DRAIN_RECORDS="${DRAIN_RECORDS}runs_root=${DRAIN_RUNS_ROOT} "
  DRAIN_RECORDS="${DRAIN_RECORDS}exit=${DRAIN_EXIT}\n"

  # 终态非 null ⇒ 成功收尾
  if [ "$TERMINATION_STATE" != "null" ] && [ -n "$TERMINATION_STATE" ]; then
    LOOP_EXIT=0
    break
  fi

  # 退避
  sleep "$DRAIN_BACKOFF_SECONDS"
done

# ── 运行记录归档（含每轮 drain 记录）。──
# E0c1 §1.2 —— 生产总线 sum(head_seq) 跑后读数。
echo "[e0-regression] reading production bus sum(head_seq) AFTER run ($PROD_BUS_URL)" >&2
if ! PROD_SUM_AFTER="$(_read_prod_head_seq_sum)"; then
  echo "[e0-regression] REFUSING to succeed: failed to read production bus sum(head_seq) after run (spec §1.2: read failure is failure). PROD_BUS_URL=$PROD_BUS_URL" >&2
  {
    echo "run_id=$RUN_ID"
    echo "profile=$PROFILE"
    echo "tick_channel=$TICK_CHANNEL"
    echo "evidence_channel=$EVIDENCE_CHANNEL"
    echo "doc_channel=$DOC_CHANNEL"
    echo "runs_channel=$RUNS_CHANNEL_ID"
    echo "drain_attempts=$DRAIN_ATTEMPT"
    echo "final_termination_state=$TERMINATION_STATE"
    echo "loop_exit_code=$LOOP_EXIT"
    echo "prod_bus_sum_before=$PROD_SUM_BEFORE"
    echo "prod_bus_sum_after=READ_FAILED"
    echo "loop_run_root=$RECORD_DIR/loop-run"
    echo "entry_exit_code=3"
    echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    echo "drain_records=$(printf '%b' "$DRAIN_RECORDS")"
  } > "$RECORD_DIR/run.meta"
  cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt"
  exit 3
fi
echo "[e0-regression] prod_bus_sum(head_seq)_after=$PROD_SUM_AFTER" >&2
echo "$PROD_SUM_AFTER" > "$RECORD_DIR/prod_bus_sum_after.json"

# §1.2 —— 两个读数不相等 ⇒ 判失败并非零退出。
PROD_SUM_BEFORE_NUM="$(printf '%s' "$PROD_SUM_BEFORE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.sum))})')"
PROD_SUM_AFTER_NUM="$(printf '%s' "$PROD_SUM_AFTER" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.sum))})')"
PROD_DELTA=$((PROD_SUM_AFTER_NUM - PROD_SUM_BEFORE_NUM))
if [ "$PROD_DELTA" -ne 0 ]; then
  echo "[e0-regression] REFUSING to succeed: production bus sum(head_seq) grew during the run (before=$PROD_SUM_BEFORE_NUM, after=$PROD_SUM_AFTER_NUM, delta=$PROD_DELTA). spec §1.2: the regression must not write to the production bus." >&2
  LOOP_EXIT=3
fi

# ── 运行记录归档（§2.3.5）。──
{
  echo "run_id=$RUN_ID"
  echo "profile=$PROFILE"
  echo "tick_channel=$TICK_CHANNEL"
  echo "evidence_channel=$EVIDENCE_CHANNEL"
  echo "doc_channel=$DOC_CHANNEL"
  echo "runs_channel=$RUNS_CHANNEL_ID"
  echo "loop_run_root=$RECORD_DIR/loop-run"
  echo "drain_attempts=$DRAIN_ATTEMPT"
  echo "final_termination_state=$TERMINATION_STATE"
  echo "prod_bus_sum_before=$PROD_SUM_BEFORE_NUM"
  echo "prod_bus_sum_after=$PROD_SUM_AFTER_NUM"
  echo "prod_bus_delta=$PROD_DELTA"
  echo "entry_exit_code=$LOOP_EXIT"
  echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "drain_records=$(printf '%b' "$DRAIN_RECORDS")"
} > "$RECORD_DIR/run.meta"
cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt"

echo "[e0-regression] run record written: $RECORD_DIR (exit=$LOOP_EXIT, prod_bus_delta=$PROD_DELTA, drain_attempts=$DRAIN_ATTEMPT)"

exit "$LOOP_EXIT"
