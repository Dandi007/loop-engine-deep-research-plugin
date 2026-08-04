#!/usr/bin/env bash
set -euo pipefail

# A8c —— 真实 worker 启动入口（spec §1.2 spawn 的落地命令）。
#
# ⛔ 修复评审 blocker：此前生产 spawn 的缺省命令是 `bash <role> <clueId> <runId>`，
#    把 role 当脚本路径交给 bash 解释器——仓库里不存在 dr-worker-* 文件，脚本退出 127，
#    从未真正拉起任何 worker。本 launcher 把 role/clueId/runId 作为**参数**传给一个
#    真实存在的 worker 进程：证明 spawn 确实拉起了一个 worker 子进程（spawned:true 有进程作证）。
#
#    实际研究行为 / 产出（worker.result.v1 未注册）属 V1（spec §7），不在本包范围。
#    部署方可用 TICK_WORKER_RUNNER 指向真实 worker 运行时（agent-runtime / subagent-mcp，
#    见 README「依赖」）；缺省在库内跑一个占位 worker 进程。
#
# 用法: worker-launcher.sh <role> <clueId> <runId>

ROLE="${1:?missing role}"
CLUE_ID="${2:?missing clue_id}"
RUN_ID="${3:?missing run_id}"

# 可观察性标记（测试/运维用）：设置后把启动参数写入该文件，证明 launcher 真实被拉起。
if [ -n "${TICK_WORKER_MARKER:-}" ]; then
  printf '%s\t%s\t%s\n' "$ROLE" "$CLUE_ID" "$RUN_ID" >> "$TICK_WORKER_MARKER"
fi

# 真实 worker 运行时（agent-runtime / subagent-mcp 的派发命令）；缺省跑库内占位 worker。
RUNNER="${TICK_WORKER_RUNNER:-}"
if [ -n "$RUNNER" ]; then
  exec $RUNNER "$ROLE" "$CLUE_ID" "$RUN_ID"
fi

exec "$(dirname "$0")/worker-placeholder.sh" "$ROLE" "$CLUE_ID" "$RUN_ID"
