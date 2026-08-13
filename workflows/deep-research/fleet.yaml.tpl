max_passes: 16
pipelines:
  - label: tick
    config_dir: ${PLUGIN_ROOT}/workflows/deep-research/tick
    input:
      tick_entry: ${TICK_ENTRY}
      tick_channel: ${TICK_CHANNEL}
      evidence_channel: ${EVIDENCE_CHANNEL}
      allowed_root: ${ALLOWED_ROOT}
      # E1b D1/D2/D7 —— content worker 的 spool 根目录（--content-spool-root）：由 bin 导出
      # CONTENT_SPOOL_ROOT（缺省留空 ⇒ tick.md 不传 ⇒ tick-entry --run 用 DEFAULT_CONTENT_SPOOL_ROOT）。
      # 派发 content 线索前把 transcript body 落成 <spoolRoot>/<digest>.md（D1）；content worker 的
      # allowed_root = spool 根（D2）。⛔ D7：归属本 run，不得落 vault 根 / .dev-dispatch/**。
      content_spool_root: ${CONTENT_SPOOL_ROOT}
      # A10c —— 写入预算（--max-writes）一路注入到 tick.md：由 bin 导出 MAX_WRITES（缺省 64），
      # 显式覆盖语义保留。缺省必须足以收割一张真实卡（spec §1.1）。
      max_writes: ${MAX_WRITES}
      # E0c10 D5 —— 板面线索上限（--max-clues）一路注入到 tick.md：由 bin 导出 MAX_CLUES
      # （缺省留空 ⇒ tick.md 不传 --max-clues ⇒ tick-entry --run 用 DEFAULT_TICK_CONFIG.maxClues=64）。
      # 回归 profile 显式声明 24（GT-D）。⛔ 装配链必须真正传到 tick-entry，不得只在 profile 写键。
      max_clues: ${MAX_CLUES}
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
