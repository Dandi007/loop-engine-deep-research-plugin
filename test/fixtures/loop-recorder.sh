#!/usr/bin/env bash
# C2 test fixture —— 记录 heavy tier loop 收到的 env + argv，然后 exit 0。
# 由 test/c2-invocation.test.ts 经 DEEP_RESEARCH_LOOP_SCRIPT 指向本脚本，用于观察
# topic→引擎 wiring（RESEARCH_QUESTION/RESEARCH_ORIGIN 是否来自调用方 topic），
# 不启动真实 loop-engine。⛔ 不是产品入口，仅测试夹具。
set -u
: "${LOOP_RECORD_FILE:?LOOP_RECORD_FILE must be set}"
{
  printf 'argv=%s\n' "$*"
  printf 'research_question=%s\n' "${RESEARCH_QUESTION:-}"
  printf 'research_origin=%s\n' "${RESEARCH_ORIGIN:-}"
  printf 'tick_channel=%s\n' "${TICK_CHANNEL:-}"
  printf 'evidence_channel=%s\n' "${EVIDENCE_CHANNEL:-}"
  printf 'doc_channel=%s\n' "${DOC_CHANNEL:-}"
} > "$LOOP_RECORD_FILE"
exit 0
