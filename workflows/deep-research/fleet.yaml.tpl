max_passes: 16
pipelines:
  - label: tick
    config_dir: ${PLUGIN_ROOT}/workflows/deep-research/tick
    input:
      tick_entry: ${TICK_ENTRY}
      tick_channel: ${TICK_CHANNEL}
      evidence_channel: ${EVIDENCE_CHANNEL}
      allowed_root: ${ALLOWED_ROOT}
      # A10c —— 写入预算（--max-writes）一路注入到 tick.md：由 bin 导出 MAX_WRITES（缺省 64），
      # 显式覆盖语义保留。缺省必须足以收割一张真实卡（spec §1.1）。
      max_writes: ${MAX_WRITES}
      # G4a —— 研究主问题（--question）一路注入到 tick.md：由 bin 导出 RESEARCH_QUESTION（无缺省）。
      research_question: ${RESEARCH_QUESTION}
      # G4c —— 研究 origin（--origin）一路注入到 tick.md：由 bin 导出 RESEARCH_ORIGIN（无缺省）。
      research_origin: ${RESEARCH_ORIGIN}
      # G4c —— doc channel（--doc-channel）一路注入到 tick.md：由 bin 导出 DOC_CHANNEL（无缺省）。
      doc_channel: ${DOC_CHANNEL}
      # A9 —— 触发存储一路注入到 tick.md：tick 依 hasPendingWork 决定是否续投下一条触发。
      trigger_store_dir: ${TRIGGER_STORE_DIR}
      loop_store_cli: ${LOOP_STORE_CLI}
      loop_engine_runner: ${LOOP_ENGINE_RUNNER}
      # E0c3b §1.1 —— triage 触发阈值（--triage-threshold）：由 bin 导出 TRIAGE_THRESHOLD（缺省 3），
      # 一路注入到 tick.md，再传给 tick-entry --run。与 MAX_WRITES 同款装配链。
      triage_threshold: ${TRIAGE_THRESHOLD}
      # E0c4 —— 单个 tick 的声明上界（ms），由 profile 声明。TICK_TIMEOUT_MS 缺省空（不设限）。
      tick_timeout_ms: ${TICK_TIMEOUT_MS}
      # E0c4 —— 回归基线收窄 maxClues（缺省空，由 tick-entry 的 DEFAULT_TICK_CONFIG.maxClues 兜底）。
      max_clues: ${MAX_CLUES}
    claim:
      store_dir: ${TRIGGER_STORE_DIR}
      from: open
      to: done
      by: tick
      staleMs: ${DD_CLAIM_STALE_MS}
      complete:
        success_status: done
        failure_status: open
      bind:
        trigger_id: id
        trigger_body: body
    pending:
      store_dir: ${TRIGGER_STORE_DIR}
      status: open
