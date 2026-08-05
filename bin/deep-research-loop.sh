#!/usr/bin/env bash
set -euo pipefail

# A7 —— deep-research loop 驱动脚本。
# 渲染 workflows/deep-research/fleet.yaml.tpl → 调 loop-engine CLI。
# --dry-run 只渲染并打印渲染结果（spec G1/G2）：不依赖 loop-engine CLI 可执行，
# 不发任何网络请求（spec §8）。
#
# 架构裁定（spec §1）：loop-engine 在本设计只提供 周期驱动 / 命名 lock / 崩溃恢复。
# clue 状态不落 loop-engine 的 store_dir —— claim 的 store 只承载周期 trigger 记录，
# 不引用 clue/board 语义（spec G5）。

PLUGIN_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

DRY_RUN=""
if [ "${1:-}" = "--dry-run" ]; then DRY_RUN=1; fi

MODE="deep-research"
RUN_ID="${DD_RUN_ID:-$(date +%Y%m%d-%H%M%S)}"
RUN_ROOT="${DD_RUN_ROOT:-$PLUGIN_ROOT/.runtime/$MODE/$RUN_ID}"
RUNTIME_FLEET="$RUN_ROOT/fleet.yaml"

export PLUGIN_ROOT RUN_ROOT RUNTIME_FLEET MODE
export TRIGGER_STORE_DIR="$RUN_ROOT/stores/trigger"
export TICK_ENTRY="${TICK_ENTRY:-bash \"$PLUGIN_ROOT/bin/tick-entry.sh\"}"
# A8c——tick 的 clue 板 channel：从 pipeline input namespace 注入 tick.md 供 `--run` 使用。
# ⛔ spec §2 只允许在 research:p02-smoke-1dce60 上做真机写入验证；可用 TICK_CHANNEL 覆盖。
export TICK_CHANNEL="${TICK_CHANNEL:-research:p02-smoke-1dce60}"
# A8e——收割的 evidence channel：`--run` 收割步必须显式传入（无默认、无字符串推导，spec §1.4）。
# 从 pipeline input namespace 注入 tick.md 供 `--run --evidence-channel` 使用；可用 EVIDENCE_CHANNEL 覆盖。
# ⛔ **无默认值**：实测真实证据 channel 并不由板 channel 名推导而来（spec §1.4 表：
#    `research:p02-smoke-1dce60` 存在且「无任何后缀」——没有 `.evidence` 兄弟 channel）。
#    由板名做 `.board`→`.evidence` 之类推导在真实 channel 上静默推不出，且发布是 append-only
#    无 DELETE、不可回退。因此这里**不给派生默认值**；部署方必须显式配置 EVIDENCE_CHANNEL 到
#    **已核实存在**的证据 channel。未配置时留空，`--run` 一旦遇到 harvest 决策会响亮失败
#    （§1.4 / H13/H14），绝不静默写进由字符串推导的错 channel。
export EVIDENCE_CHANNEL="${EVIDENCE_CHANNEL:-}"
# A8f——worker 可读的 repo 根：从 pipeline input namespace 注入 tick.md 供 `--run --allowed-root` 使用；
# 可用 ALLOWED_ROOT 覆盖。⛔ **无派生默认值**（同 §1.4 判据：猜根目录与猜 channel 同样危险）——
# 未配置时留空，`--run` 一旦遇到 code-local dispatch 会响亮失败（§1.2 / F5），绝不静默零证据。
# 其余 role（wiki / feishu / code-remote）不需要它，不会因缺失被阻断。
export ALLOWED_ROOT="${ALLOWED_ROOT:-}"
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
"$LOOP_ENGINE_RUNNER" "$LOOP_ENGINE_CLI" drain "$RUNTIME_FLEET" --label "$MODE"
