max_passes: 16
pipelines:
  - label: tick
    config_dir: ${PLUGIN_ROOT}/workflows/deep-research/tick
    input:
      tick_entry: ${TICK_ENTRY}
      tick_channel: ${TICK_CHANNEL}
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
