#!/usr/bin/env bash
set -euo pipefail

# E0a §1.3/§1.4 —— 「实证判据」的唯一权威：入口退出码**不得**再是 loop 退出码的透传。
# 跑完 loop 后，必须全部通过才允许退出 0；任意一条不成立 ⇒ 非零退出并点名哪一条、实测值多少。
# ⛔ 尤其禁止「loop 空转（零写入 / 板面无终态）却被判成功」。
#
# 用法：
#   bash bin/e0-verify.sh <loop_exit> <tick_head_pre> <tick_head_post> <termination_state> <prod_sum_pre> <prod_sum_post>
#
# 判据：
#   1. loop 自身退出码为 0（loop_exit == 0）。
#   2. 板面达到可指认终态：termination_state 非空且非 "null"（§1.3.3）。
#      ⛔ 「没跑起来」与「跑到终态」必须靠这个字段区分，不得靠「没报错」推断。
#   3. 研究板（TICK_CHANNEL）head_seq 相对本次运行开始前严格增长（tick_head_post > tick_head_pre，§1.3.2）。
#   4. 生产总线 sum(head_seq) 跑前/跑后两个读数相等（prod_sum_pre == prod_sum_post，§1.4）——
#      不等 ⇒ 本次运行污染了生产总线（最严重失败）。

loop_exit=$1
tick_pre=$2
tick_post=$3
term_state=$4
prod_pre=$5
prod_post=$6

fail=0

if [ "$loop_exit" -ne 0 ]; then
  echo "[e0-verify] FAIL: loop exit code = $loop_exit (expected 0)" >&2
  fail=1
fi

if [ -z "$term_state" ] || [ "$term_state" = "null" ]; then
  echo "[e0-verify] FAIL: board did not reach an identifiable terminal state (termination.state='${term_state}'); the loop did not actually run to an end state" >&2
  fail=1
fi

if [ "$tick_post" -le "$tick_pre" ]; then
  echo "[e0-verify] FAIL: research board TICK_CHANNEL head_seq did not strictly grow (before=$tick_pre after=$tick_post); the run produced no board writes" >&2
  fail=1
fi

if [ "$prod_pre" -ne "$prod_post" ]; then
  echo "[e0-verify] FAIL: production bus sum(head_seq) changed (before=$prod_pre after=$prod_post); the run polluted the production bus" >&2
  fail=1
fi

exit "$fail"
