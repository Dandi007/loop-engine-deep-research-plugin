#!/usr/bin/env bash
set -euo pipefail

# E0c —— 「真机端到端回归基线」唯一入口命令。
# 一条命令把现状链路在 **测试总线**（127.0.0.1:7495）上从头跑到终态：
#   导出 AGENT_BUS_URL / AGENT_BUS_TOKEN_FILE → 生产护栏 → per-run 研究板 channel 预备 →
#   空板自播种（--source，GT-4）→ 跑 loop → 从 journal 读 termination.state（GT-3）→ 归档运行记录。
# 用法：
#   bash bin/e0-regression.sh                 # 缺省即可跑（profile e0-regression）
#   bash bin/e0-regression.sh --run <id>      # 可选覆盖 run id（缺省自动生成）
#   bash bin/e0-regression.sh --profile <p>   # 可选覆盖 profile（缺省 e0-regression）
#
# 退出码：0 = 链路跑到**非 null 终态**（termination.state 已判定）；非零 = 没跑到终态
# （含生产护栏拒绝、播种失败、loop 失败、termination.state 为 null）。绝不以 0 掩盖未跑完。

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

# ── §1.2　每次运行用一块属于该 run 的干净研究板。──
#   三条 research channel 的名字由 profile 基名（RESEARCH_CHANNEL_BASE）+ 本次 run_id 派生
#   （如 research:e0-<run_id>.{index,evidence,docs}）；board:agent-runs 是全局的、不随 run 变。
#   每次运行创建这三条新 channel（不存在则建）。⛔ 不得用「清空/删除旧 channel」实现
#   （bus 是 append-only 无 DELETE）。
#   ⛔ profile 未声明 RESEARCH_CHANNEL_BASE ⇒ 响亮失败（无默认，避免误建固定 channel）。
if [ -z "${RESEARCH_CHANNEL_BASE:-}" ]; then
  echo "[e0-regression] RESEARCH_CHANNEL_BASE is not set in profile '$PROFILE'. Refusing to derive a per-run research board without a base name." >&2
  exit 3
fi
# 派生三个 per-run channel（用与 src/e0-regression.ts 相同的命名规则）。
TICK_CHANNEL="research:${RESEARCH_CHANNEL_BASE}-${RUN_ID}.index"
EVIDENCE_CHANNEL="research:${RESEARCH_CHANNEL_BASE}-${RUN_ID}.evidence"
DOC_CHANNEL="research:${RESEARCH_CHANNEL_BASE}-${RUN_ID}.docs"

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

# ── GT-4　空板自播种，且种子必须带 --source。──
#   种子文本（SEED_CLUES）与 sources（SEED_SOURCES）均由 profile 声明，⛔ 不写死在脚本里；
#   profile 用 code-local；种子文本须与 ALLOWED_ROOT 指向的仓相称（能让 code-local worker 真找到东西）。
#   播种失败（含未声明 sources / 空文本）⇒ 响亮失败、非零退出。
#   ⛔ 只有空板才播（新 per-run channel 恒为空，故每次 run 都播一次）。播种经 src/e0-regression.ts
#   的 buildSeedArgv 校验（带 sources），再调真实 tick-entry --seed。
TICK_ENTRY="${TICK_ENTRY:-$PLUGIN_ROOT/bin/tick-entry.sh}"
if [ -z "${SEED_CLUES:-}" ]; then
  echo "[e0-regression] SEED_CLUES is not set in profile '$PROFILE'. Refusing to seed a vacuous empty board (GT-4)." >&2
  exit 3
fi
if [ -z "${SEED_SOURCES:-}" ]; then
  echo "[e0-regression] SEED_SOURCES is not set in profile '$PROFILE'. Refusing to seed a clue with sources: [] (GT-4: undispatachable card)." >&2
  exit 3
fi
echo "[e0-regression] seeding empty board channel: $TICK_CHANNEL" >&2
SEED_ARGS=()
for _s in $SEED_SOURCES; do
  SEED_ARGS+=(--source "$_s")
done
"$TICK_ENTRY" --seed "$TICK_CHANNEL" --clue "$SEED_CLUES" "${SEED_ARGS[@]}" >/dev/null \
  || { echo "[e0-regression] seeding failed (GT-4): unable to seed $TICK_CHANNEL" >&2; exit 3; }
echo "[e0-regression] seeded: $TICK_CHANNEL sources=[$SEED_SOURCES]" >&2

# ── 生产总线 sum(head_seq) 跑前读数（Z2）：只读，不写生产。──
#   由 e0-cli sum-head-seq（经 vite-node 跑 src/bus.ts 的 sumAllHeadSeqs）从列表端点真解析求和。
#   AGENT_BUS_URL 此刻指向**测试总线**；生产 sum 用独立只读端点（PROD_AGENT_BUS_URL /
#   PROD_AGENT_BUS_TOKEN_FILE），缺省指向生产 bus（仅 GET，绝不写）。读失败 ⇒ 响亮失败点名（不得当 0 继续）。
VITE_NODE="$PLUGIN_ROOT/node_modules/.bin/vite-node"
E0_CLI="$PLUGIN_ROOT/src/e0-cli.ts"
PROD_SUM_BEFORE=""
if [ -n "${PROD_AGENT_BUS_URL:-}" ]; then
  PROD_SUM_BEFORE="$(AGENT_BUS_URL="$PROD_AGENT_BUS_URL" AGENT_BUS_TOKEN_FILE="$PROD_AGENT_BUS_TOKEN_FILE" \
    node "$VITE_NODE" "$E0_CLI" sum-head-seq 2>"$RECORD_DIR/prod-sum-before.err")" \
    || { echo "[e0-regression] failed to read production bus sum(head_seq) before run (Z2); refusing to continue with an unknown reading" >&2; exit 3; }
  echo "[e0-regression] production bus sum(head_seq) before: $PROD_SUM_BEFORE" >&2
fi

# ── 把 run 上下文导出，供 loop-engine run 目录与 idempotency key 落到本次记录目录下。──
export DD_RUN_ID="$RUN_ID"
export DD_RUN_ROOT="$RECORD_DIR/loop-run"
export TICK_CHANNEL EVIDENCE_CHANNEL DOC_CHANNEL

echo "[e0-regression] run_id=$RUN_ID"
echo "[e0-regression] record_dir=$RECORD_DIR"

# ── 跑现状链路到终态；完整 stdout/stderr 落盘，退出码单独记录。──
set +e
bash "$PLUGIN_ROOT/bin/deep-research-loop.sh" --profile "$PROFILE" \
  > "$RECORD_DIR/run.stdout.log" 2> "$RECORD_DIR/run.stderr.log"
LOOP_EXIT=$?
set -e

# ── 生产总线 sum(head_seq) 跑后读数（Z2）。──
PROD_SUM_AFTER=""
if [ -n "${PROD_AGENT_BUS_URL:-}" ]; then
  PROD_SUM_AFTER="$(AGENT_BUS_URL="$PROD_AGENT_BUS_URL" AGENT_BUS_TOKEN_FILE="$PROD_AGENT_BUS_TOKEN_FILE" \
    node "$VITE_NODE" "$E0_CLI" sum-head-seq 2>"$RECORD_DIR/prod-sum-after.err")" \
    || { echo "[e0-regression] failed to read production bus sum(head_seq) after run (Z2)" >&2; PROD_SUM_AFTER="ERROR"; }
  echo "[e0-regression] production bus sum(head_seq) after: $PROD_SUM_AFTER" >&2
fi

# ── GT-3　终态从 termination.state 取真值（journal 链）。──
#   drain 摘要.drain_id → index.jsonl → run_dir → journal.jsonl → 最后一轮 tick 的 result
#   → termination.state。任一步失败 ⇒ 响亮失败并点名是哪一步，⛔ 不得回退成「用 drain reason 凑合」。
#   termination.state 为 null ⇒ 非零退出（§1.1.4 / §2.5）。
TERMINATION_STATE=""
if [ "$LOOP_EXIT" -eq 0 ]; then
  DRAIN_SUMMARY="$(tail -n 1 "$RECORD_DIR/run.stdout.log" 2>/dev/null || true)"
  TERMINATION_STATE="$(printf '%s' "$DRAIN_SUMMARY" | \
    node "$VITE_NODE" "$E0_CLI" read-termination "$RECORD_DIR/loop-run/index.jsonl" 2>"$RECORD_DIR/termination.err")" \
    || { echo "[e0-regression] failed to read a non-null termination.state from the journal chain (GT-3); run is not complete" >&2; LOOP_EXIT=3; }
  echo "[e0-regression] termination.state=$TERMINATION_STATE" >&2
fi

# ── 运行记录归档（§2.3.5）：入口命令 stdout/stderr、最终 exit code、profile 与 channel 名、
#    可据以回查的 loop-engine run 目录路径、生产总线跑前跑后读数（Z2）。⛔ 记录目录在仓外。──
{
  echo "run_id=$RUN_ID"
  echo "profile=$PROFILE"
  echo "tick_channel=$TICK_CHANNEL"
  echo "evidence_channel=$EVIDENCE_CHANNEL"
  echo "doc_channel=$DOC_CHANNEL"
  echo "loop_run_root=$RECORD_DIR/loop-run"
  echo "entry_exit_code=$LOOP_EXIT"
  echo "termination_state=$TERMINATION_STATE"
  echo "prod_sum_before=$PROD_SUM_BEFORE"
  echo "prod_sum_after=$PROD_SUM_AFTER"
  echo "recorded_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} > "$RECORD_DIR/run.meta"
cp "$RECORD_DIR/run.meta" "$RECORD_DIR/run.txt"

echo "[e0-regression] run record written: $RECORD_DIR (exit=$LOOP_EXIT)"

# 终态可判：0 = 跑到终态；非零 = 没跑到终态。绝不以 0 掩盖未跑完。
exit "$LOOP_EXIT"
