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

# ── E0c2b §1.3 —— 跨 drain 循环：反复 drain 直到 termination.state 非 null。
#    （GT-3：单次 drain 不是「跑完一次研究」的单位；worker 还没回来、16 轮已在十几秒内烧完。）
#    三个上限/退避由 profile 声明（E0_DRAIN_*），⛔ 不写死在脚本里。
#    每轮 drain：
#      1) 跑一次 deep-research-loop.sh（一次 drain），记下退出码与 stdout。
#      2) GT-6 分类：
#         - 拿不到可解析摘要 / 非 max_rounds 的非零退出码 ⇒ 真失败（响亮收尾，非零退出，点名退出码与 stderr）。
#         - reason==drained 或 reason==max_rounds（max_rounds 的 exit 1 ⛔ 不算失败）⇒ 继续判终态。
#      3) §1.1 读本次 termination.state（经 src/e0c2b-terminal-read.ts：drain 摘要.drain_id → index.jsonl →
#         run_dir → journal.jsonl → 最后一轮 tick result → termination.state）。
#         读失败 ⇒ 响亮失败并点名是哪一步（⛔ 不回退 drain reason、⛔ 不默认任一方向）。
#      4) termination.state 非 null ⇒ 成功收尾（退出循环）。
#         撞墙钟或次数上限 ⇒ 失败收尾（响亮、非零退出、点名撞的是哪个上限、实测值多少）。
#         否则 ⇒ 退避后再来一轮。
#    ⛔ 不得用「非零即失败」一刀切（GT-6）；⛔ 也不得反过来把一切非零都当「还没收敛」无限重试。
#    ⛔ 不得靠改 max_passes（单次 drain 的轮次上限）来"解决"（spec §1.3 末段）。
E0_DRAIN_BACKOFF_SECONDS="${E0_DRAIN_BACKOFF_SECONDS:-}"
E0_DRAIN_MAX_ATTEMPTS="${E0_DRAIN_MAX_ATTEMPTS:-}"
E0_DRAIN_WALL_CLOCK_SECONDS="${E0_DRAIN_WALL_CLOCK_SECONDS:-}"
if [ -z "$E0_DRAIN_BACKOFF_SECONDS" ] || [ -z "$E0_DRAIN_MAX_ATTEMPTS" ] || [ -z "$E0_DRAIN_WALL_CLOCK_SECONDS" ]; then
  echo "[e0-regression] REFUSING to start: E0_DRAIN_BACKOFF_SECONDS / E0_DRAIN_MAX_ATTEMPTS / E0_DRAIN_WALL_CLOCK_SECONDS must all be declared by profile '$PROFILE' (spec §1.3: cross-drain backoff/limits are profile-declared, not hardcoded)." >&2
  exit 3
fi
# 简单数值校验（profile 声明的必须是非负整数；上限必须 > 0，否则循环逻辑无意义）。
case "$E0_DRAIN_BACKOFF_SECONDS" in ''|*[!0-9]*) echo "[e0-regression] E0_DRAIN_BACKOFF_SECONDS must be a non-negative integer (got '$E0_DRAIN_BACKOFF_SECONDS')" >&2; exit 3;; esac
case "$E0_DRAIN_MAX_ATTEMPTS"  in ''|*[!0-9]*) echo "[e0-regression] E0_DRAIN_MAX_ATTEMPTS must be a non-negative integer (got '$E0_DRAIN_MAX_ATTEMPTS')" >&2; exit 3;; esac
case "$E0_DRAIN_WALL_CLOCK_SECONDS" in ''|*[!0-9]*) echo "[e0-regression] E0_DRAIN_WALL_CLOCK_SECONDS must be a non-negative integer (got '$E0_DRAIN_WALL_CLOCK_SECONDS')" >&2; exit 3;; esac
if [ "$E0_DRAIN_MAX_ATTEMPTS" -le 0 ] || [ "$E0_DRAIN_WALL_CLOCK_SECONDS" -le 0 ]; then
  echo "[e0-regression] REFUSING to start: E0_DRAIN_MAX_ATTEMPTS and E0_DRAIN_WALL_CLOCK_SECONDS must be > 0 (got max_attempts=$E0_DRAIN_MAX_ATTEMPTS, wall_clock=$E0_DRAIN_WALL_CLOCK_SECONDS)." >&2
  exit 3
fi

# 跨 drain 进度记录文件（每轮追加 runs_root/reason/终态，⛔ 不得只留最后一轮）。
DRAIN_ATTEMPTS_LOG="$RECORD_DIR/drain-attempts.jsonl"
: > "$DRAIN_ATTEMPTS_LOG"

# 读取本次 drain 的 termination.state（§1.1）。stdin = drain stdout，stdout = JSON snapshot。
_read_drain_termination() {
  AGENT_RUN_BIN="${AGENT_RUN_BIN:-}" \
    node "$PLUGIN_ROOT/node_modules/.bin/vite-node" "$PLUGIN_ROOT/src/e0c2b-terminal-read.ts"
}

_WALL_START="$(date +%s)"
LOOP_EXIT=0
_TERMINAL_STATE=""
_DRAIN_ATTEMPT=0
_FINAL_OUTCOME="running"

while [ "$_DRAIN_ATTEMPT" -lt "$E0_DRAIN_MAX_ATTEMPTS" ]; do
  _DRAIN_ATTEMPT=$((_DRAIN_ATTEMPT + 1))
  _attempt_dir="$RECORD_DIR/drain-$_DRAIN_ATTEMPT"
  mkdir -p "$_attempt_dir"
  # 跑一次 drain（一次 deep-research-loop.sh）。
  # E0c2b：支持 DEEP_RESEARCH_LOOP_BIN 覆盖（测试注入用，生产路径不变；缺省指向仓内脚本）。
  _loop_bin="${DEEP_RESEARCH_LOOP_BIN:-$PLUGIN_ROOT/bin/deep-research-loop.sh}"
  set +e
  bash "$_loop_bin" --profile "$PROFILE" \
    > "$_attempt_dir/drain.stdout.log" 2> "$_attempt_dir/drain.stderr.log"
  _drain_exit=$?
  set -e
  unset _loop_bin
  # GT-6 分类：先逐行 JSON.parse 抽 drain 摘要（GT-7：⛔ 禁止花括号正则）。
  # 取 stdout 里**最后一行**能 JSON.parse 且含 drain_id 的（驱动 stdout 末尾才是最终 drain 摘要）。
  _drain_summary=""
  _drain_reason=""
  _drain_id=""
  _drain_runs_root=""
  # GT-7：⛔ 禁止花括号正则；逐行 JSON.parse 取最后一条含 drain_id 的。
  # set -e 下 `var=$(false)` 会直接退出脚本 ⇒ 用 set +e 包住，捕获退出码与输出。
  set +e
  _drain_summary="$(node -e '
    const fs = require("fs");
    const data = fs.readFileSync(0, "utf8");
    let last = null;
    for (const line of data.split(/\r?\n/)) {
      if (!line || !line.trim()) continue;
      let o;
      try { o = JSON.parse(line); } catch { continue; }
      if (o && typeof o === "object" && typeof o.drain_id === "string" && o.drain_id.length > 0) last = o;
    }
    if (!last) { process.stderr.write("[e0-regression] GT-7: no parseable drain summary (line-wise JSON.parse) with a drain_id found in drain stdout.\n"); process.exit(3); }
    process.stdout.write(JSON.stringify(last));
  ' < "$_attempt_dir/drain.stdout.log")"
  _drain_summary_ec=$?
  set -e
  if [ "$_drain_summary_ec" -ne 0 ]; then
    # 拿不到可解析摘要 ⇒ 真失败（GT-6）。
    _FINAL_OUTCOME="drain_unparseable"
    LOOP_EXIT=3
    {
      printf '{"attempt":%d,"exit":%d,"reason":"unparseable_summary","termination_state":null}\n' \
        "$_DRAIN_ATTEMPT" "$_drain_exit"
    } >> "$DRAIN_ATTEMPTS_LOG"
    echo "[e0-regression] DRAIN FAILED (attempt $_DRAIN_ATTEMPT): could not parse drain summary from stdout (exit=$_drain_exit). GT-6: unparseable summary is a real failure, not 'not yet converged'." >&2
    echo "[e0-regression]   drain stderr (tail):" >&2
    tail -n 20 "$_attempt_dir/drain.stderr.log" >&2 || true
    break
  fi
  _drain_reason="$(printf '%s' "$_drain_summary" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(typeof o.reason==="string"?o.reason:"")})')"
  _drain_id="$(printf '%s' "$_drain_summary" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(typeof o.drain_id==="string"?o.drain_id:"")})')"
  _drain_runs_root="$(printf '%s' "$_drain_summary" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(typeof o.runs_root==="string"?o.runs_root:"")})')"

  # GT-6 三类分类：
  #   - exit==0 且 reason==drained   ⇒ 排空了但可能没收敛 ⇒ 继续判终态。
  #   - exit==1 且 reason==max_rounds ⇒ 轮次护栏触顶（worker 还在跑）⇒ 继续判终态（⛔ exit 1 不是失败）。
  #   - 其它非零退出码 / 非 drained&max_rounds 的 reason 组合 ⇒ 真失败。
  _is_converging=0
  if [ "$_drain_exit" -eq 0 ] && [ "$_drain_reason" = "drained" ]; then
    _is_converging=1
  elif [ "$_drain_exit" -eq 1 ] && [ "$_drain_reason" = "max_rounds" ]; then
    _is_converging=1
  fi
  if [ "$_is_converging" -ne 1 ]; then
    _FINAL_OUTCOME="drain_failed"
    LOOP_EXIT="${_drain_exit}"
    [ "$LOOP_EXIT" -eq 0 ] && LOOP_EXIT=3  # exit 0 但 reason 既非 drained 也非 max_rounds ⇒ 异常，强失败。
    {
      printf '{"attempt":%d,"exit":%d,"reason":"%s","drain_id":"%s","termination_state":null}\n' \
        "$_DRAIN_ATTEMPT" "$_drain_exit" "$_drain_reason" "$_drain_id"
    } >> "$DRAIN_ATTEMPTS_LOG"
    echo "[e0-regression] DRAIN FAILED (attempt $_DRAIN_ATTEMPT): exit=$_drain_exit reason=$_drain_reason (GT-6: only reason==drained or reason==max_rounds are 'not yet converged'; other non-zero exits are real failures)." >&2
    echo "[e0-regression]   drain stderr (tail):" >&2
    tail -n 20 "$_attempt_dir/drain.stderr.log" >&2 || true
    break
  fi

  # §1.1 —— 读本次 drain 的 termination.state（drain_id → index.jsonl → run_dir → journal → 最后一轮 tick result）。
  #   读失败 ⇒ 响亮失败并点名是哪一步（⛔ 不回退 drain reason、⛔ 不默认任一方向）。
  set +e
  _term_snap="$(node "$PLUGIN_ROOT/node_modules/.bin/vite-node" "$PLUGIN_ROOT/src/e0c2b-terminal-read.ts" < "$_attempt_dir/drain.stdout.log" 2>"$ENTRY_TMP.term-read.err")"
  _term_ec=$?
  set -e
  if [ "$_term_ec" -ne 0 ]; then
    _term_err="$(cat "$ENTRY_TMP.term-read.err" 2>/dev/null || true)"
    rm -f "$ENTRY_TMP.term-read.err" 2>/dev/null || true
    _FINAL_OUTCOME="terminal_read_failed"
    LOOP_EXIT=3
    {
      printf '{"attempt":%d,"exit":%d,"reason":"%s","drain_id":"%s","termination_state":null,"terminal_read_error":%s}\n' \
        "$_DRAIN_ATTEMPT" "$_drain_exit" "$_drain_reason" "$_drain_id" \
        "$(printf '%s' "$_term_err" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.stringify(s.trim()))})')"
    } >> "$DRAIN_ATTEMPTS_LOG"
    echo "[e0-regression] TERMINAL READ FAILED (attempt $_DRAIN_ATTEMPT): §1.1 termination.state read failed (§1.1: never fall back to drain reason; never default either direction)." >&2
    echo "[e0-regression]   error: $_term_err" >&2
    break
  fi
  rm -f "$ENTRY_TMP.term-read.err" 2>/dev/null || true
  _TERMINAL_STATE="$(printf '%s' "$_term_snap" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(o.state===null?"null":String(o.state))})')"
  _term_cov="$(printf '%s' "$_term_snap" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.coverage))})')"
  _term_zgr="$(printf '%s' "$_term_snap" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.zeroGrowthRounds))})')"

  # 进度行（stdout）：第几轮 / 本轮 drain reason / 当前 termination.state / drain_id。
  echo "[e0-regression] drain attempt=$_DRAIN_ATTEMPT/$E0_DRAIN_MAX_ATTEMPTS reason=$_drain_reason termination.state=$_TERMINAL_STATE coverage=$_term_cov zeroGrowthRounds=$_term_zgr drain_id=$_drain_id"

  # 每轮的 runs_root/reason/终态追加进运行记录（⛔ 不得只留最后一轮）。
  {
    printf '{"attempt":%d,"exit":%d,"reason":"%s","drain_id":"%s","runs_root":"%s","termination_state":"%s","coverage":%s,"zeroGrowthRounds":%s}\n' \
      "$_DRAIN_ATTEMPT" "$_drain_exit" "$_drain_reason" "$_drain_id" "$_drain_runs_root" "$_TERMINAL_STATE" "$_term_cov" "$_term_zgr"
  } >> "$DRAIN_ATTEMPTS_LOG"

  # termination.state 非 null ⇒ 成功收尾。
  if [ "$_TERMINAL_STATE" != "null" ] && [ -n "$_TERMINAL_STATE" ]; then
    _FINAL_OUTCOME="converged"
    LOOP_EXIT=0
    break
  fi

  # 撞墙钟上限 ⇒ 失败收尾（点名撞的是哪个上限、实测值多少）。
  _now="$(date +%s)"
  _elapsed=$((_now - _WALL_START))
  if [ "$_elapsed" -ge "$E0_DRAIN_WALL_CLOCK_SECONDS" ]; then
    _FINAL_OUTCOME="wall_clock_exceeded"
    LOOP_EXIT=3
    echo "[e0-regression] WALL CLOCK LIMIT HIT: elapsed=${_elapsed}s >= limit=${E0_DRAIN_WALL_CLOCK_SECONDS}s (E0_DRAIN_WALL_CLOCK_SECONDS) and termination.state still null after attempt $_DRAIN_ATTEMPT." >&2
    break
  fi

  # 还有下一次机会 ⇒ 退避后再来一轮（⛔ 不得零间隔空转）。
  if [ "$_DRAIN_ATTEMPT" -lt "$E0_DRAIN_MAX_ATTEMPTS" ]; then
    echo "[e0-regression] backing off ${E0_DRAIN_BACKOFF_SECONDS}s before next drain (worker still running; spec §1.3: backoff must be non-zero, commensurate with real worker latency ≈158s)." >&2
    sleep "$E0_DRAIN_BACKOFF_SECONDS"
  fi
done

# 撞次数上限（循环正常退出但终态仍 null）⇒ 失败收尾，点名撞的是次数上限。
if [ "$_FINAL_OUTCOME" = "running" ]; then
  if [ "$_TERMINAL_STATE" = "null" ] || [ -z "$_TERMINAL_STATE" ]; then
    _FINAL_OUTCOME="max_attempts_exceeded"
    LOOP_EXIT=3
    echo "[e0-regression] MAX ATTEMPTS LIMIT HIT: reached E0_DRAIN_MAX_ATTEMPTS=$E0_DRAIN_MAX_ATTEMPTS and termination.state still null." >&2
  else
    _FINAL_OUTCOME="converged"
    LOOP_EXIT=0
  fi
fi

unset _drain_exit _drain_summary _drain_reason _drain_id _drain_runs_root _drain_summary_ec
unset _is_converging _term_snap _term_ec _term_err _term_cov _term_zgr _now _elapsed _attempt_dir _WALL_START _DRAIN_ATTEMPT

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
    echo "loop_exit_code=$LOOP_EXIT"
    echo "prod_bus_sum_before=$PROD_SUM_BEFORE"
    echo "prod_bus_sum_after=READ_FAILED"
    echo "loop_run_root=$RECORD_DIR/loop-run"
    echo "entry_exit_code=3"
    echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  } > "$RECORD_DIR/run.meta"
  cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt"
  exit 3
fi
echo "[e0-regression] prod_bus_sum(head_seq)_after=$PROD_SUM_AFTER" >&2
echo "$PROD_SUM_AFTER" > "$RECORD_DIR/prod_bus_sum_after.json"

# §1.2 —— 两个读数不相等 ⇒ 判失败并非零退出（生产总线零写入是本次运行的硬不变量）。
#   派发方独立复算（读 prod_bus_sum_before.json / prod_bus_sum_after.json 各自 JSON.parse 求和）。
PROD_SUM_BEFORE_NUM="$(printf '%s' "$PROD_SUM_BEFORE" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.sum))})')"
PROD_SUM_AFTER_NUM="$(printf '%s' "$PROD_SUM_AFTER" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const o=JSON.parse(s);process.stdout.write(String(o.sum))})')"
PROD_DELTA=$((PROD_SUM_AFTER_NUM - PROD_SUM_BEFORE_NUM))
if [ "$PROD_DELTA" -ne 0 ]; then
  echo "[e0-regression] REFUSING to succeed: production bus sum(head_seq) grew during the run (before=$PROD_SUM_BEFORE_NUM, after=$PROD_SUM_AFTER_NUM, delta=$PROD_DELTA). spec §1.2: the regression must not write to the production bus." >&2
  LOOP_EXIT=3
fi

# ── 运行记录归档（§2.3.5）：入口命令 stdout/stderr、最终 exit code、profile 与 channel 名、
#    可据以回查的 loop-engine run 目录路径、§1.2 生产总线跑前跑后读数、§1.3 跨 drain 结果。
#    ⛔ 记录目录在仓外。──
{
  echo "run_id=$RUN_ID"
  echo "profile=$PROFILE"
  echo "tick_channel=$TICK_CHANNEL"
  echo "evidence_channel=$EVIDENCE_CHANNEL"
  echo "doc_channel=$DOC_CHANNEL"
  echo "runs_channel=$RUNS_CHANNEL_ID"
  echo "loop_run_root=$RECORD_DIR/loop-run"
  echo "prod_bus_sum_before=$PROD_SUM_BEFORE_NUM"
  echo "prod_bus_sum_after=$PROD_SUM_AFTER_NUM"
  echo "prod_bus_delta=$PROD_DELTA"
  echo "drain_outcome=$_FINAL_OUTCOME"
  echo "drain_terminal_state=$_TERMINAL_STATE"
  echo "drain_attempts_log=$DRAIN_ATTEMPTS_LOG"
  echo "entry_exit_code=$LOOP_EXIT"
  echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$RECORD_DIR/run.meta"
cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt"

echo "[e0-regression] run record written: $RECORD_DIR (exit=$LOOP_EXIT, outcome=$_FINAL_OUTCOME, prod_bus_delta=$PROD_DELTA)"

unset _FINAL_OUTCOME _TERMINAL_STATE DRAIN_ATTEMPTS_LOG

# 终态可判：0 = 跑到终态；非零 = 没跑到终态。绝不以 0 掩盖未跑完。
exit "$LOOP_EXIT"
