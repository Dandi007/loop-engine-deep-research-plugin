#!/usr/bin/env bash
set -euo pipefail

# ⛔ C2 —— 内部实现细节（不是 user-facing entry）。
# 用户/agent/人 一律走统一入口 bin/deep-research.sh（single entry，路由 light/heavy）。
# 本脚本只承载 heavy tier（V2 全编排）的 loop 落地，直接调用视为「legacy direct-run path」
# —— 已降级为内部实现，不再作为第二个面向用户的入口。

# A7 —— deep-research loop 驱动脚本。
# 渲染 workflows/deep-research/fleet.yaml.tpl → 调 loop-engine CLI。
# --dry-run 只渲染并打印渲染结果（spec G1/G2）：不依赖 loop-engine CLI 可执行，
# 不发任何网络请求（spec §8）。
#
# 架构裁定（spec §1）：loop-engine 在本设计只提供 周期驱动 / 命名 lock / 崩溃恢复。
# clue 状态不落 loop-engine 的 store_dir —— claim 的 store 只承载周期 trigger 记录，
# 不引用 clue/board 语义（spec G5）。

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# D1 —— 参数解析：--dry-run（只渲染）/ --profile <name>（受版本管理的部署配置）。
# profile 也可经 DEPLOY_PROFILE 选择（--profile 优先于 DEPLOY_PROFILE）。
_args=("$@")
DRY_RUN=""
PROFILE=""
for ((_i=0; _i<${#_args[@]}; _i++)); do
  case "${_args[$_i]}" in
    --dry-run) DRY_RUN=1 ;;
    --profile)
      _i=$((_i+1))
      if [ -z "${_args[$_i]:-}" ] || [[ "${_args[$_i]}" == --* ]]; then
        echo "[deep-research-loop] --profile requires an operand (usage: --profile <name>, e.g. --profile agent-harness)" >&2
        exit 3
      fi
      PROFILE="${_args[$_i]}"
      ;;
  esac
done
if [ -z "$PROFILE" ] && [ -n "${DEPLOY_PROFILE:-}" ]; then
  PROFILE="$DEPLOY_PROFILE"
fi

# D1 —— 受版本管理的部署配置（profile 形式，进 git / 可 diff / 可 review）。
# 选择：--profile <name> 或 DEPLOY_PROFILE=<name> → profiles/deploy/<name>.env。
# 加载顺序：显式 env > profile 文件 > 内置缺省。加载了哪个 profile 打印到 stderr（可观测）。
# ⛔ profile 只填**环境里尚未显式设置**的变量（显式 env 优先），绝不覆盖已显式给的 env。
if [ -n "$PROFILE" ]; then
  PROFILE_FILE="$PLUGIN_ROOT/profiles/deploy/$PROFILE.env"
  if [ ! -f "$PROFILE_FILE" ]; then
    echo "[deep-research-loop] unknown deploy profile '$PROFILE': $PROFILE_FILE not found. Available: $(ls "$PLUGIN_ROOT/profiles/deploy" 2>/dev/null | sed 's/\.env$//' | tr '\n' ' ')" >&2
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
  echo "[deep-research-loop] loaded deploy profile: $PROFILE ($PROFILE_FILE)" >&2
fi

MODE="deep-research"
# A10b —— 每次渲染的缺省 RUN_ID 必须唯一（§0.2/§1.2）。
# ⛔ 秒级 `date +%Y%m%d-%H%M%S` 会让同一秒内并发的多次渲染共用同一 RUN_ROOT ⇒ 互相覆盖
#    读对方写了一半的 fleet.yaml（本 gate 实测 20% 假红）。改用 纳秒时间戳 + PID（tick.md 已有
#    同款范式），保证每次渲染唯一。DD_RUN_ID / DD_RUN_ROOT 的显式覆盖语义不变（§1.2）。
RUN_ID="${DD_RUN_ID:-$(date +%s%N)-$$}"
RUN_ROOT="${DD_RUN_ROOT:-$PLUGIN_ROOT/.runtime/$MODE/$RUN_ID}"
RUNTIME_FLEET="$RUN_ROOT/fleet.yaml"

export PLUGIN_ROOT RUN_ROOT RUNTIME_FLEET MODE
export TRIGGER_STORE_DIR="$RUN_ROOT/stores/trigger"
export TICK_ENTRY="${TICK_ENTRY:-$PLUGIN_ROOT/bin/tick-entry.sh}"
# A8c——tick 的 clue 板 channel：从 pipeline input namespace 注入 tick.md 供 `--run` 使用。
# D1 —— ⛔ 内置缺省不再是 smoke channel（§1.2 / §2 E1/E2）。
#   bus 是 append-only 无 DELETE ⇒ 一个「缺省写到某个真实 channel」的值**不可回退**。
#   未受 profile 或显式 env 指定 ⇒ 响亮失败拒绝启动（与 EVIDENCE_CHANNEL 无默认同一条道理）。
export TICK_CHANNEL="${TICK_CHANNEL:-}"
if [ -z "$TICK_CHANNEL" ]; then
  echo "[deep-research-loop] TICK_CHANNEL is not set. Refusing to start: the bus is append-only with no DELETE, so a default that writes to a real channel is irreversible. Provide a deploy profile (--profile <name> or DEPLOY_PROFILE=<name>) or set TICK_CHANNEL explicitly." >&2
  exit 3
fi
# G4a —— 研究主问题：从部署配置一路贯通到 tick-entry --run --question。
# CLI 支持 --question、usage 记录它、引擎在 triage 决策上依赖它（缺失 ⇒ MissingTriageQuestionError），
# 但生产从不传它 ⇒ 收集段会在第一个 triage 决策上响亮失败。本包把它接上同一条贯通链
# （bin → fleet → workflow → tick.md → `--run --question`）。
# ⛔ 无内置缺省：编造或推导的问题字符串会让整场研究跑偏，且 bus 写入 append-only 不可回退。
#    未受 profile 或显式 env 指定 ⇒ 响亮失败拒绝启动（exit 3，点名 RESEARCH_QUESTION）。
export RESEARCH_QUESTION="${RESEARCH_QUESTION:-}"
if [ -z "$RESEARCH_QUESTION" ]; then
  echo "[deep-research-loop] RESEARCH_QUESTION is not set. Refusing to start: an invented or derived default question would send the whole research astray, and bus writes are append-only (irreversible). Provide a deploy profile (--profile <name> or DEPLOY_PROFILE=<name>) or set RESEARCH_QUESTION explicitly." >&2
  exit 3
fi
# A8e——收割的 evidence channel：`--run` 收割步必须显式传入（无默认、无字符串推导，spec §1.4）。
# 从 pipeline input namespace 注入 tick.md 供 `--run --evidence-channel` 使用；可用 EVIDENCE_CHANNEL 覆盖。
# ⛔ **无默认值**：实测真实证据 channel 并不由板 channel 名推导而来（spec §1.4 表：
#    真实证据 channel 存在且「无任何后缀」——没有 `.evidence` 兄弟 channel）。
#    由板名做 `.board`→`.evidence` 之类推导在真实 channel 上静默推不出，且发布是 append-only
#    无 DELETE、不可回退。因此这里**不给派生默认值**；部署方必须显式配置 EVIDENCE_CHANNEL 到
#    **由派发方于 2026-08-09 07:51Z 显式创建并复核（head_seq=0）**的证据 channel。未配置时留空，`--run` 一旦遇到 harvest 决策会响亮失败
#    （§1.4 / H13/H14），绝不静默写进由字符串推导的错 channel。
export EVIDENCE_CHANNEL="${EVIDENCE_CHANNEL:-}"
# A8f——worker 可读的 repo 根：从 pipeline input namespace 注入 tick.md 供 `--run --allowed-root` 使用；
# 可用 ALLOWED_ROOT 覆盖。⛔ **无派生默认值**（同 §1.4 判据：猜根目录与猜 channel 同样危险）——
# 未配置时留空，`--run` 一旦遇到 code-local dispatch 会响亮失败（§1.2 / F5），绝不静默零证据。
# 其余 role（wiki / feishu / code-remote）不需要它，不会因缺失被阻断。
export ALLOWED_ROOT="${ALLOWED_ROOT:-}"
# E1b D1/D2/D7 —— content worker 的 spool 根目录：从 bin 一路导出 → fleet → workflow → tick.md
# → `tick-entry --run --content-spool-root`。派发 content clue 前把 transcript body 落成
# <spoolRoot>/<digest>.md（D1）；content worker 的 allowed_root = spool 根（D2）。
# ⛔ D7：spool 目录归属本 run，⛔ 不得落 vault 根、⛔ 不得与 .dd-evidence/** / .dev-dispatch/** 冲突。
#    缺省留空：tick.md 不传 --content-spool-root ⇒ tick-entry --run 用 DEFAULT_CONTENT_SPOOL_ROOT
#    （tmpdir 下兜底，仅供未配置时的可观测兜底；生产由 profile CONTENT_SPOOL_ROOT 显式声明）。
export CONTENT_SPOOL_ROOT="${CONTENT_SPOOL_ROOT:-}"
# A10c——写入预算上限：从 bin 一路导出 → fleet → workflow → tick.md → `tick-entry --run --max-writes`。
# ⛔ 缺省值必须**足以收割一张真实卡**（真实 worker 产出实测 6~10 条 evidence，加最终 CAS）；
#    旧默认 5 让任何产出 ≥5 条 evidence 的卡永远收割不了 ⇒ 恒 max_rounds 死锁（本包根因）。
#    预算仍是**不可回退写的有限护栏**，绝不设成无穷大（spec §4 非目标）；显式覆盖语义保留（MAX_WRITES）。
export MAX_WRITES="${MAX_WRITES:-64}"
# E0c10 D5 —— 板面 clue 上限：从 bin 一路导出 → fleet → workflow → tick.md → `tick-entry --run --max-clues`。
# ⛔ 缺省留空（非 0）：tick.md 据此**不传** --max-clues，tick-entry --run 用 DEFAULT_TICK_CONFIG.maxClues=64，
#    生产 profile（agent-harness）行为逐字不变。回归 profile 显式声明 MAX_CLUES=24（GT-D）。
#    装配链判别性：删掉 fleet.yaml.tpl 的 max_clues 注入 ⇒ 测试变红（spec §2 判据 5）。
export MAX_CLUES="${MAX_CLUES:-}"
# D1 —— 导出落点根（§1.3 / E6）：走 profile 配置（受版本管理），源码不硬编码 vault 路径。
# 未配置时留空；实际导出由 src/export.ts 以 vaultRoot 参数接入（不在此推导）。
export EXPORT_ROOT="${EXPORT_ROOT:-}"
# G4c —— 研究 origin（report 的 origin 字段）：从 pipeline input namespace 注入 tick.md 供 `--run --origin` 使用。
# 可用 RESEARCH_ORIGIN 覆盖。⛔ 无内置缺省：编造的 origin 会让整场研究报告的溯源信息出错，
# 且 bus 写入 append-only 不可回退。未配置时留空，tick.md 不传 --origin ⇒ 生成段不执行。
export RESEARCH_ORIGIN="${RESEARCH_ORIGIN:-}"
# G4c —— doc channel（research.doc.v2 发布 channel）：从 pipeline input namespace 注入 tick.md 供 `--run --doc-channel` 使用。
# 可用 DOC_CHANNEL 覆盖。⛔ 无内置缺省：不得静默回退到板 channel（research.doc.v2 发进 clue 板是 append-only
# 不可回退的错误落点）。未配置时留空，tick.md 不传 --doc-channel ⇒ writeDoc 抛 MissingDocChannelError。
export DOC_CHANNEL="${DOC_CHANNEL:-}"
# E0c3b §1.1 —— triage 触发阈值（profile 声明，缺省 3；⛔ 不得改 DEFAULT_TICK_CONFIG 缺省）。
export TRIAGE_THRESHOLD="${TRIAGE_THRESHOLD:-3}"
# C5（再暴露）—— round 预算**有界但充分**（非固定 16）：由 tick 配置确定性推导（src/max-passes.ts
#   deriveMaxPasses：maxClues + zeroGrowthThreshold + margin），保证「终止 tick/generate 必在预算内可达」。
# ⛔ 单一真相源：走 vite-node 调 src/max-passes.ts（与 bin/e0-regression.sh 解析 RUNS_CHANNEL_ID 同款范式），
#    推导失败 ⇒ 响亮失败（绝不静默回退固定 16，那会让 heavy run 在终态 tick 前被截断）。
# 显式 MAX_PASSES 覆盖语义保留（测试/部署可注入小值模拟预算耗尽场景）。
if [ -z "${MAX_PASSES:-}" ]; then
  if ! MAX_PASSES="$(MAX_PASSES_CLI=1 "$PLUGIN_ROOT/node_modules/.bin/vite-node" "$PLUGIN_ROOT/src/max-passes.ts" 2>/dev/null)"; then
    echo "[deep-research-loop] failed to derive MAX_PASSES (round budget) from src/max-passes.ts; refusing to fall back to a fixed 16." >&2
    exit 3
  fi
fi
case "$MAX_PASSES" in
  ''|*[!0-9]*)
    echo "[deep-research-loop] derived MAX_PASSES is not a positive integer: '$MAX_PASSES'. Refusing to render an invalid round budget." >&2
    exit 3
    ;;
esac
export MAX_PASSES
# C5 —— round 预算耗尽标记（末轮响亮收口）：由部署/重试包装显式声明（DR_DRAIN_RETRY_WRAPPED 同款
# 范式），或由巡检在撞预算的最后一轮注入 1。为 1 时 tick 把 started-超预算在飞卡 bounded-terminalize
# 到 blocked、decideTermination 在未排空时产出响亮非收敛 reason；drain 哨兵按退出契约响亮非零退出
# （判别性规格 §四）。⛔ 缺省空（不启用）：既有行为逐字不变。
export BUDGET_EXHAUSTED="${BUDGET_EXHAUSTED:-}"
# A8d——生产 spawn 的落地命令：真实 `agent-run`（不再是占位 worker-launcher）。
# 解析不到时由 tick-run 的 resolveAgentRunBin 响亮失败（绝不回退占位 worker）；
# 部署方可用 AGENT_RUN_BIN 覆盖。缺省若实测存在则补到已知位置，否则留给 PATH 解析。
if [ -z "${AGENT_RUN_BIN:-}" ] && [ -x "$HOME/.local/bin/agent-run" ]; then
  export AGENT_RUN_BIN="$HOME/.local/bin/agent-run"
fi
export DD_CLAIM_STALE_MS="${DD_CLAIM_STALE_MS:-1800000}"

mkdir -p "$TRIGGER_STORE_DIR" "$(dirname "$RUNTIME_FLEET")"

render() {
  node "$PLUGIN_ROOT/scripts/render-template.mjs" \
    "$PLUGIN_ROOT/workflows/$MODE/fleet.yaml.tpl" "$RUNTIME_FLEET"
}

# A9 —— 解析驱动运行器（缺省 bun；可用 LOOP_ENGINE_RUNNER 覆盖）。
# ⛔ loop-engine 的 `dist/cli.js` 用 extensionless import —— 只有 bun 能解析，node 会给出
#    `ERR_MODULE_NOT_FOUND: .../dist/engine` 这种「指向不存在文件、实则是解析器不兼容」的误导性错误。
# ⛔ 解析不到 ⇒ 响亮失败，⛔ 绝不回退 node（本 gate 首跑正因此误判为「构建残缺」）。
resolve_runner() {
  local candidate="$1"
  if [ -x "$candidate" ]; then printf '%s' "$candidate"; return 0; fi
  if command -v "$candidate" >/dev/null 2>&1; then command -v "$candidate"; return 0; fi
  return 1
}

LOOP_ENGINE_RUNNER="${LOOP_ENGINE_RUNNER:-}"
if [ -z "$LOOP_ENGINE_RUNNER" ]; then
  if resolve_runner bun >/dev/null 2>&1; then
    LOOP_ENGINE_RUNNER="bun"
  elif resolve_runner "$HOME/.bun/bin/bun" >/dev/null 2>&1; then
    LOOP_ENGINE_RUNNER="$HOME/.bun/bin/bun"
  fi
fi
if [ -n "$LOOP_ENGINE_RUNNER" ]; then
  LOOP_ENGINE_RUNNER="$(resolve_runner "$LOOP_ENGINE_RUNNER")" || LOOP_ENGINE_RUNNER=""
fi
export LOOP_ENGINE_RUNNER

# A9 —— LOOP_ENGINE_CLI / LOOP_STORE_CLI 的**派生与导出**必须在 render 之前发生：
#    fleet.yaml.tpl 的 ${LOOP_STORE_CLI} / ${LOOP_ENGINE_RUNNER} 占位符需要非 undefined 值。
#    （文件存在性校验只在非 dry-run 的真实跑里做，dry-run 不依赖 CLI 可执行，spec G1/G2。）
LOOP_ENGINE_CLI="${LOOP_ENGINE_CLI:-/data/code/self/loop-engine/dist/cli.js}"
# A9 —— loop-store 的 put/claim/list 契约 CLI（与 cli.js 同构、同 dist 根）。
LOOP_STORE_CLI="${LOOP_STORE_CLI:-$(dirname "$LOOP_ENGINE_CLI")/lib/store-cli.js}"
export LOOP_STORE_CLI

if [ -n "$DRY_RUN" ]; then
  render
  cat "$RUNTIME_FLEET"
  exit 0
fi

if [ ! -f "$LOOP_ENGINE_CLI" ]; then
  echo "[deep-research-loop] missing LOOP_ENGINE_CLI: $LOOP_ENGINE_CLI (build loop-engine first)" >&2
  exit 3
fi
if [ ! -f "$LOOP_STORE_CLI" ]; then
  echo "[deep-research-loop] missing loop-store CLI: $LOOP_STORE_CLI (build loop-engine first)" >&2
  exit 3
fi

if [ -z "$LOOP_ENGINE_RUNNER" ]; then
  echo "[deep-research-loop] cannot resolve the loop-engine runner: set LOOP_ENGINE_RUNNER to a bun-compatible executable (default 'bun'). Refusing to fall back to node (node yields the misleading ERR_MODULE_NOT_FOUND for extensionless imports)." >&2
  exit 3
fi

# A9 —— drain 之前投下首个触发（status:"open"），否则 claimableCount() 恒 0 ⇒ 0 tick。
# 实测 loop-store 契约：put '{"id":"...","status":"open","body":{...}}' → 落盘 <id>.json。
TRIGGER_ID="a9-$(date +%s%N)-$$"
"$LOOP_ENGINE_RUNNER" "$LOOP_STORE_CLI" "$TRIGGER_STORE_DIR" put \
  "{\"id\":\"${TRIGGER_ID}\",\"status\":\"open\",\"body\":{\"seed\":true}}"

render
echo "[deep-research-loop] mode=$MODE run_root=$RUN_ROOT"
# G15/C3: drain 后检查 —— 捕获 drain 输出，解析 drain_id，
# 遍历 index.jsonl → journal.jsonl 查找 [bash 非零退出 EXIT:<n>]（G15）或
# 引擎级 node_timeout/wall_clock 杀掉的 [外部调用失败 status=TIMEOUT] + error:"exec"（E0c10 D7 / GT-A），
# 命中任一则响亮失败并点名 run_dir。
# C3（判别核心）: ⛔ 哨兵判定必须在 drain 进程**任何**退出/死亡路径后都读取 drain registry
# （drain.json status/outstanding/last_heartbeat + index.jsonl run.start/run.end 配对 +
# loop-events.jsonl 轮次配对）。存在未收割 in_flight/open 卡（outstanding>0）或 drain 未写
# run.end 时产出响亮 sentinel_lost 终态（非零退出 + 点名 drain_id/outstanding/未收割计数），
# 绝不静默 exit 0，绝不把「带活儿猝死」伪装成 done。
DRAIN_TMP=$(mktemp)
trap 'rm -f "$DRAIN_TMP"' EXIT
set +e
"$LOOP_ENGINE_RUNNER" "$LOOP_ENGINE_CLI" drain "$RUNTIME_FLEET" --label "$MODE" > "$DRAIN_TMP"
DRAIN_EXIT_CODE=$?
set -e

cat "$DRAIN_TMP"

# C3 —— 任何退出/死亡路径（含 SIGKILL 无摘要）后都执行哨兵判定。
set +e
node "$PLUGIN_ROOT/scripts/check-drain-failures.mjs" < "$DRAIN_TMP"
CHECK_EXIT_CODE=$?
set -e

if [ "$CHECK_EXIT_CODE" -ne 0 ]; then
  exit "$CHECK_EXIT_CODE"
fi
if [ "$DRAIN_EXIT_CODE" -ne 0 ]; then
  exit "$DRAIN_EXIT_CODE"
fi
exit 0
