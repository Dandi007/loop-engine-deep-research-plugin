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
# 到记录目录就绪后由 EXIT trap 整体落入 run.entry.log；连同每轮 drain 的 drain-<n>.stdout.log /
# drain-<n>.stderr.log 共同构成「入口命令与每次 drain 的完整 stdout/stderr」。护栏拒绝（exit 3）
# 或更早的用法错误不建记录目录，缓冲随 trap 清理，不在仓内/记录根留下脏目录。
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

# ── E0c2 §1.3 / GT-3 —— 跨 drain 循环：重复 drain 直到读到非 null 终态或撞 profile 声明的上限。──
#   单次 drain 在 worker 返回前就烧完 max_rounds（GT-3：worker ≈ 158s，16 轮 ≈ 17s）。
#   修法：drain → 按 §1.1 读 termination.state → 非 null 收尾 / 撞上限失败收尾 / 否则退避再来。
#   ⛔ 退避时长（E0_DRAIN_BACKOFF_SECONDS）、墙钟上限（E0_DRAIN_MAX_WALL_SECONDS）、
#      drain 次数上限（E0_DRAIN_MAX_ATTEMPTS）三者均由 profile 声明，⛔ 不写死在脚本里。
#   ⛔ 不得靠改 max_passes（单次 drain 的轮次上限）来"解决"（spec §1.3 明确禁止）。
if [ -z "${E0_DRAIN_BACKOFF_SECONDS:-}" ]; then
  echo "[e0-regression] REFUSING to start: E0_DRAIN_BACKOFF_SECONDS is not declared by profile '$PROFILE' (spec §1.3: backoff duration must be profile-declared and commensurate with real worker latency ≈ 158s; ⛔ not zero-interval, not hardcoded)." >&2
  exit 3
fi
if [ -z "${E0_DRAIN_MAX_WALL_SECONDS:-}" ]; then
  echo "[e0-regression] REFUSING to start: E0_DRAIN_MAX_WALL_SECONDS is not declared by profile '$PROFILE' (spec §1.3: wall-clock limit must be profile-declared; ⛔ not hardcoded)." >&2
  exit 3
fi
if [ -z "${E0_DRAIN_MAX_ATTEMPTS:-}" ]; then
  echo "[e0-regression] REFUSING to start: E0_DRAIN_MAX_ATTEMPTS is not declared by profile '$PROFILE' (spec §1.3: drain count limit must be profile-declared; ⛔ not hardcoded)." >&2
  exit 3
fi
# 三个值都必须是正整数（⛔ 不得为零/负/非整数——零间隔空转正是 GT-3 禁止的形态）。
for _limit_var in E0_DRAIN_BACKOFF_SECONDS E0_DRAIN_MAX_WALL_SECONDS E0_DRAIN_MAX_ATTEMPTS; do
  _limit_val="${!_limit_var}"
  if ! printf '%s' "$_limit_val" | grep -qE '^[1-9][0-9]*$'; then
    echo "[e0-regression] REFUSING to start: $_limit_var='$_limit_val' is not a positive integer (spec §1.3: backoff/wall-clock/drain-count limits must be positive integers; zero-interval spinning is forbidden)." >&2
    exit 3
  fi
done
unset _limit_var _limit_val

DRAIN_BACKOFF="$E0_DRAIN_BACKOFF_SECONDS"
DRAIN_MAX_WALL="$E0_DRAIN_MAX_WALL_SECONDS"
DRAIN_MAX_ATTEMPTS="$E0_DRAIN_MAX_ATTEMPTS"

# 跨 drain 运行记录（§1.3：每轮的 runs_root/reason/终态都追加进记录，⛔ 不得只留最后一轮）。
DRAIN_ATTEMPTS_LOG="$RECORD_DIR/drain-attempts.jsonl"
: > "$DRAIN_ATTEMPTS_LOG"

# §1.1 —— 终态取真值：从 drain 摘要经 index.jsonl → journal.jsonl → tick result 读 termination.state。
#   drain 摘要是 deep-research-loop.sh stdout 的最后一个 JSON（含 drain_id）。
#   本函数接收一段 stdout 文本，抽出 drain 摘要 JSON，调 e0c2-termination-read.ts 读终态。
#   任一步失败 ⇒ 响亮失败（⛔ 不回退 drain reason，spec §1.1）。
#   返回 0 且 stdout=termination JSON（state 非 null 或 null）= 成功读到；
#   返回非 0 = 链路某环断裂（已点名是哪一步）。

# 评审 blocker 修复（attempt 1 final REJECT）：原实现用 `grep -oE '\{[^{}]*"drain_id"[^{}]*\}'`
#   抽 drain 摘要——这是 brace-free 正则。真机摘要（spec §0 GT-1）是
#   `{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"…","drain_id":"…"}`，
#   在 drain_id 之前有嵌套对象（ticksByLabel），`[^{}]*` 会在到达 drain_id 前撞上嵌套 `{` ⇒ 永远匹配不到。
#   改为逐行 JSON.parse（与 scripts/check-drain-failures.mjs 同款正确构造法）：把 stdout 按行切开，
#   对每行尝试 JSON.parse，取最后一个解析成功且含字符串 drain_id 的对象。这能正确处理嵌套花括号，
#   因为 JSON.parse 知道花括号配对，而正则不知道。
#   stdout 传文件路径（$_stdout_file）；返回 0 且 stdout=抽出的 drain 摘要 JSON 原文，或返回 1。
_extract_drain_summary_from_file() {
  local _stdout_file="$1"
  node -e '
    const fs = require("fs");
    const content = fs.readFileSync(process.argv[1], "utf8");
    let last = null;
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const o = JSON.parse(trimmed);
        if (o && typeof o === "object" && !Array.isArray(o) &&
            typeof o.drain_id === "string" && o.drain_id.length > 0) {
          last = trimmed;
        }
      } catch {}
    }
    if (last === null) process.exit(1);
    process.stdout.write(last);
  ' "$_stdout_file"
}

_read_termination_from_drain_stdout() {
  local _stdout_file="$1"
  # 从 stdout 文本抽出最后一个含 drain_id 的 JSON 行（deep-research-loop.sh 最后一段 cat 的 drain 摘要）。
  local _drain_summary
  if ! _drain_summary="$(_extract_drain_summary_from_file "$_stdout_file")"; then
    echo "[e0-regression] §1.1: no drain summary (JSON with drain_id) found in deep-research-loop.sh stdout. Refusing to fall back to drain reason (spec §1.1)." >&2
    return 1
  fi
  # 调 e0c2-termination-read.ts（GT-2 路径：drain_id → index.jsonl → journal.jsonl → tick result → termination.state）。
  AGENT_RUN_BIN="${AGENT_RUN_BIN:-}" \
    node "$PLUGIN_ROOT/node_modules/.bin/vite-node" "$PLUGIN_ROOT/src/e0c2-termination-read.ts" "$_drain_summary"
}

# 读 tick channel 的 head_seq（进度行用；失败时进度行标 N/A，不影响终态判定）。
_read_tick_head_seq() {
  local _code
  set +e
  _code="$(curl -s -o /dev/null -w '%{http_code}' \
    -H "Authorization: Bearer $TOKEN" \
    "$AGENT_BUS_URL/v1/channels/$TICK_CHANNEL")"
  set -e
  if [ "$_code" != "200" ]; then
    printf 'N/A'
    return
  fi
  curl -s -H "Authorization: Bearer $TOKEN" \
    "$AGENT_BUS_URL/v1/channels/$TICK_CHANNEL" \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(String(o.head_seq??"N/A"))}catch{process.stdout.write("N/A")}})' 2>/dev/null || printf 'N/A'
}

_LOOP_WALL_START="$(date +%s)"
_LOOP_FINAL_EXIT=0
_TERMINATION_STATE=""

_attempt=0
while :; do
  _attempt=$((_attempt + 1))
  if [ "$_attempt" -gt "$DRAIN_MAX_ATTEMPTS" ]; then
    echo "[e0-regression] REFUSING to succeed: hit drain count limit (spec §1.3 / 判据 6: termination.state never reached non-null within the profile-declared drain count). attempts=$_attempt > max=$DRAIN_MAX_ATTEMPTS, last_state=${_TERMINATION_STATE:-<none>}." >&2
    _LOOP_FINAL_EXIT=3
    break
  fi
  _now="$(date +%s)"
  _elapsed=$((_now - _LOOP_WALL_START))
  if [ "$_elapsed" -gt "$DRAIN_MAX_WALL" ]; then
    echo "[e0-regression] REFUSING to succeed: hit wall-clock limit (spec §1.3 / 判据 6: termination.state never reached non-null within the profile-declared wall-clock). elapsed=${_elapsed}s > max=${DRAIN_MAX_WALL}s, attempts=$_attempt, last_state=${_TERMINATION_STATE:-<none>}." >&2
    _LOOP_FINAL_EXIT=3
    break
  fi

  # 本轮 drain 的 stdout/stderr 落进独立文件（每轮保留，⛔ 不只留最后一轮）。
  _drain_out="$RECORD_DIR/drain-${_attempt}.stdout.log"
  _drain_err="$RECORD_DIR/drain-${_attempt}.stderr.log"
  echo "[e0-regression] drain attempt $_attempt/$DRAIN_MAX_ATTEMPTS (elapsed=${_elapsed}s/${DRAIN_MAX_WALL}s wall) ..." >&2
  set +e
  bash "$PLUGIN_ROOT/bin/deep-research-loop.sh" --profile "$PROFILE" \
    > "$_drain_out" 2> "$_drain_err"
  _drain_exit=$?
  set -e

  if [ "$_drain_exit" -ne 0 ]; then
    echo "[e0-regression] drain attempt $_attempt failed (exit=$_drain_exit). stderr:" >&2
    cat "$_drain_err" >&2
    _TERMINATION_STATE="DRAIN_FAILED"
    # 把本轮记进 drain-attempts.jsonl（⛔ 每轮都追加，不只留最后一轮）。
    printf '%s\n' "{\"attempt\":${_attempt},\"exit\":${_drain_exit},\"reason\":\"drain_failed\",\"termination_state\":null,\"elapsed_seconds\":${_elapsed}}" >> "$DRAIN_ATTEMPTS_LOG"
    _LOOP_FINAL_EXIT=$_drain_exit
    break
  fi

  # 提取 drain reason（drain 摘要的 reason 字段）与 runs_root（§1.3 minor：每轮 runs_root 须进记录）。
  # 评审 blocker 修复（attempt 1 final REJECT）：原用与 §1.1 同款 brace-free 正则抽摘要再取 reason，
  #   在真机摘要（含嵌套 ticksByLabel 对象）上永远匹配不到 ⇒ reason 退化为 "parse_error"。
  #   改为复用 _extract_drain_summary_from_file（逐行 JSON.parse，正确处理嵌套花括号）抽出摘要，
  #   再 JSON.parse 取 reason / runs_root 字段。
  _drain_reason="unknown"
  _drain_runs_root=""
  if _drain_summary_for_reason="$(_extract_drain_summary_from_file "$_drain_out" 2>/dev/null)"; then
    _drain_reason="$(printf '%s' "$_drain_summary_for_reason" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(typeof o.reason==="string"&&o.reason.length>0?o.reason:"unknown")}catch{process.stdout.write("parse_error")}})' 2>/dev/null || printf 'parse_error')"
    # §1.3 minor：runs_root 是真机摘要（GT-1）里的字段；解析不到时留空（不阻断终态判定）。
    _drain_runs_root="$(printf '%s' "$_drain_summary_for_reason" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);if(typeof o.runs_root==="string")process.stdout.write(o.runs_root)}catch{}})' 2>/dev/null || true)"
  fi
  # runs_root 的 JSON 安全编码（含路径分隔符/空格等）：用 node 经 JSON.stringify 产出安全的 JSON 字符串字面量（含引号）。
  _drain_runs_root_json="$(printf '%s' "$_drain_runs_root" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.stdout.write(JSON.stringify(s))})' 2>/dev/null || printf '""')"

  # §1.1 读本轮 termination.state（GT-2 路径）。
  _term_json=""
  set +e
  _term_json="$(_read_termination_from_drain_stdout "$_drain_out" 2>"$RECORD_DIR/drain-${_attempt}.term-read.err")"
  _term_exit=$?
  set -e
  if [ "$_term_exit" -ne 0 ]; then
    echo "[e0-regression] §1.1: failed to read termination.state from drain $_attempt (exit=$_term_exit). Spec §1.1: read failure is failure (⛔ must not fall back to drain reason)." >&2
    cat "$RECORD_DIR/drain-${_attempt}.term-read.err" >&2
    _TERMINATION_STATE="READ_FAILED"
    printf '%s\n' "{\"attempt\":${_attempt},\"exit\":0,\"reason\":\"${_drain_reason}\",\"runs_root\":${_drain_runs_root_json},\"termination_state\":null,\"termination_read_error\":true,\"elapsed_seconds\":${_elapsed}}" >> "$DRAIN_ATTEMPTS_LOG"
    _LOOP_FINAL_EXIT=3
    break
  fi
  # 从 termination JSON 取 state 字段。
  _TERMINATION_STATE="$(printf '%s' "$_term_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{const o=JSON.parse(s);process.stdout.write(o.state===null?"null":String(o.state))}catch{process.stdout.write("parse_error")}})' 2>/dev/null || printf 'parse_error')"
  _head_seq="$(_read_tick_head_seq)"

  # 进度行（§1.3：第几轮 / 本轮 drain reason / 当前 termination.state / 板面 head_seq）。
  echo "[e0-regression] drain attempt $_attempt: reason=${_drain_reason} termination.state=${_TERMINATION_STATE} tick_head_seq=${_head_seq}"

  # 把本轮记进 drain-attempts.jsonl（每轮的 reason/终态都留痕）。
  # termination_state 的 JSON 编码：字面量 "null"（state 为 null）⇒ JSON null（不加引号）；
  #   其余（converged/capped/partial）⇒ JSON 字符串（加引号）。
  _term_state_json="null"
  if [ "$_TERMINATION_STATE" != "null" ] && [ "$_TERMINATION_STATE" != "parse_error" ]; then
    _term_state_json="\"$_TERMINATION_STATE\""
  fi
  printf '%s\n' "{\"attempt\":${_attempt},\"exit\":0,\"reason\":\"${_drain_reason}\",\"runs_root\":${_drain_runs_root_json},\"termination_state\":${_term_state_json},\"tick_head_seq\":\"${_head_seq}\",\"elapsed_seconds\":${_elapsed}}" >> "$DRAIN_ATTEMPTS_LOG"

  # 非 null 终态 ⇒ 成功收尾。
  if [ "$_TERMINATION_STATE" != "null" ] && [ "$_TERMINATION_STATE" != "parse_error" ]; then
    echo "[e0-regression] reached terminal state '$_TERMINATION_STATE' after $_attempt drain attempt(s)."
    _LOOP_FINAL_EXIT=0
    break
  fi

  # null 终态且未撞上限 ⇒ 退避后再来一轮（⛔ 退避量级与 worker 真实耗时相称，spec §1.3）。
  echo "[e0-regression] termination.state still null after drain $_attempt; backing off ${DRAIN_BACKOFF}s before next drain ..." >&2
  sleep "$DRAIN_BACKOFF"
done

LOOP_EXIT="$_LOOP_FINAL_EXIT"

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
#    可据以回查的 loop-engine run 目录路径、§1.2 生产总线跑前跑后读数。⛔ 记录目录在仓外。──
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
  echo "entry_exit_code=$LOOP_EXIT"
  echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$RECORD_DIR/run.meta"
cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt"

echo "[e0-regression] run record written: $RECORD_DIR (exit=$LOOP_EXIT, prod_bus_delta=$PROD_DELTA)"

# 终态可判：0 = 跑到终态；非零 = 没跑到终态。绝不以 0 掩盖未跑完。
exit "$LOOP_EXIT"
