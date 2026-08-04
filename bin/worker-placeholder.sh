#!/usr/bin/env bash
set -euo pipefail

# A8c —— 占位 worker 进程（spec §1.2 spawn 的落地 worker）。
#
# ⛔ 修复评审 blocker：此前缺省 spawn 是 `bash <role> ...`（脚本不存在 ⇒ 退出 127，
#    从未拉起 worker）。本占位进程是**真实存在、可执行**的 worker 进程：被 launcher 以
#    role/clueId/runId 为参数拉起后保持运行，代表「worker 已启动」（spawned:true 有进程作证）。
#
#    真实 worker 的研究行为 / 产出（worker.result.v1 未注册）属 V1（spec §7）：
#    部署方用 TICK_WORKER_RUNNER 指向真实 worker 运行时后，本占位进程即被替换。
#    默认运行 TICK_WORKER_MAX_S 秒后退出 0（便于测试不泄漏进程）。
#
# 用法: worker-placeholder.sh <role> <clueId> <runId>

ROLE="${1:?missing role}"
CLUE_ID="${2:?missing clue_id}"
RUN_ID="${3:?missing run_id}"

MAX_S="${TICK_WORKER_MAX_S:-30}"
sleep "$MAX_S"
exit 0
