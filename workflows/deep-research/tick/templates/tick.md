set -euo pipefail
# A8c —— tick 节点可执行体（bash harness），已从 --selfcheck 切到真实 tick 入口（spec §1.3）。
# 真实入口：--run <channel> 执行 CAS + spawn + 收割（接线判别，spec §1.2）。
# tick_entry / tick_channel / evidence_channel / allowed_root 由 fleet 的 pipeline input 注入（loop-engine 渲染时替换）。
# ⛔ A8e——收割步的 evidence channel 也随装配系统一路注入，`--run` 带上 `--evidence-channel`
#    （spec §1.4：显式传入、无默认、无字符串推导）；缺失时收割决策会响亮失败而非卡死 tick。
# ⛔ A8f——code-local 所需 `--allowed-root` 也随装配系统一路注入；缺失时 code-local dispatch 会响亮失败
#    （spec §1.2 / F5），其余 role 不因它缺失被阻断。
# ⛔ A10c——`--max-writes` 也随装配系统一路注入（bin 导出 MAX_WRITES，缺省足以收割一张真实卡）；
#    不再让生产链路上 `--run` 静默吃 CLI 默认值 5（那会让 ≥5 条 evidence 的卡永远收割不了，恒死锁）。
# ⛔ G4a——研究主问题 `--question` 也随装配系统一路注入（bin 导出 RESEARCH_QUESTION，无缺省）；
#    CLI 支持它、引擎在 triage 决策上依赖它，唯独生产从不传它 ⇒ 收集段首个 triage 决策即响亮失败。
# ⛔ A9——trigger 续投所需的 trigger_store_dir / loop_store_cli / loop_engine_runner 随装配系统一路注入；
#    tick 完成后当且仅当板面仍有非终态 clue（hasPendingWork=true）才投下一条触发（spec §1.3 / F9）。
# ⛔ G4b——跨 tick 计数经 trigger body 传递（spec §1.2）。claim.bind 已把 trigger 记录的 body 绑进
#    pipeline input，本节点从渲染后的 G4B trigger body 占位符读出上一轮的 coverage / zeroGrowthRounds，
#    作为 --prev-coverage / --prev-zero-growth-rounds 传给 tick-entry。续投时把本轮 decideTermination
#    返回的 coverage / zeroGrowthRounds 写进下一条 trigger 的 body。
#    ⛔ body 缺失/损坏/字段缺失 ⇒ 响亮失败（exit 1 + 点名缺项），绝不静默回落 0/0
#       （静默回落 = 计数器被无声重置 = 本缺陷原样复发，spec §1.2 / R5）。
# ⛔ --selfcheck 仍保留（A7 G6/G7 需要它做无副作用自检）：未注入 tick_channel 时退化为 --selfcheck。
tick_entry="{{tick_entry}}"
tick_channel="{{tick_channel}}"
evidence_channel="{{evidence_channel}}"
allowed_root="{{allowed_root}}"
max_writes="{{max_writes}}"
research_question="{{research_question}}"
trigger_store_dir="{{trigger_store_dir}}"
loop_store_cli="{{loop_store_cli}}"
loop_engine_runner="{{loop_engine_runner}}"
# G4b —— trigger body 经 claim.bind 从 trigger 记录的 body 字段绑入。loop-engine 的模板填充对非字符串
# 值做 JSON.stringify（多行 pretty-print），故 body 可能是多行 JSON。⛔ 不得用双引号赋值形式：
# 多行 JSON 里的引号/换行会破坏 bash 双引号赋值。改用 here-doc（quoted delim ⇒ 无 bash 展开，
# 原样捕获 fill 后的 JSON 文本，含多行与内嵌引号都安全）。
trigger_body=$(cat <<'G4B_TRIGGER_BODY_EOF'
{{trigger_body}}
G4B_TRIGGER_BODY_EOF
)

run_output=""
if [ -n "$tick_channel" ]; then
  # G4a —— ⛔ 不再把 evidence/allowed_root 的可选性翻倍成 4 分支组合树（每加一个可选参数就 ×2）。
  # 改为增量拼 argv（数组累加后一次调用）；`set -euo pipefail` 下 `[ … ] && …` 作为语句在条件为假时
  # 会以非零退出终止脚本，因此用 `if` 块逐项累加。run_output 的捕获与后续 hasPendingWork 判定逐字不变。
  tick_args=("$tick_entry" --run "$tick_channel")
  if [ -n "$evidence_channel" ]; then tick_args+=(--evidence-channel "$evidence_channel"); fi
  if [ -n "$allowed_root" ]; then tick_args+=(--allowed-root "$allowed_root"); fi
  tick_args+=(--max-writes "$max_writes")
  if [ -n "$research_question" ]; then tick_args+=(--question "$research_question"); fi
  # G4b —— 从 trigger body 解析上一轮的 coverage / zeroGrowthRounds，传给 tick-entry。
  # ⛔ body 解析失败 / 字段缺失 ⇒ 响亮失败（exit 1 + 点名），绝不静默回落 0/0（spec §1.2 / R5）。
  # node 已是硬依赖（scripts/render-template.mjs），此处复用做 JSON 解析与字段校验。
  # 输出用 tab 分隔（字段名<TAB>值），避免值里含空格被误切；解析失败时 node 以非零退出。
  prev_line="$(printf '%s' "$trigger_body" | node -e '
    let s = "";
    process.stdin.on("data", (c) => { s += c; });
    process.stdin.on("end", () => {
      if (s.length === 0) { console.error("G4b: trigger body is empty"); process.exit(1); }
      let p;
      try { p = JSON.parse(s); } catch (e) { console.error("G4b: trigger body is not valid JSON: " + e.message); process.exit(1); }
      if (typeof p !== "object" || p === null || Array.isArray(p)) { console.error("G4b: trigger body is not a JSON object"); process.exit(1); }
      if (typeof p.coverage !== "number" || !Number.isFinite(p.coverage)) { console.error("G4b: trigger body missing numeric field coverage"); process.exit(1); }
      if (typeof p.zeroGrowthRounds !== "number" || !Number.isFinite(p.zeroGrowthRounds)) { console.error("G4b: trigger body missing numeric field zeroGrowthRounds"); process.exit(1); }
      process.stdout.write("coverage\t" + p.coverage + "\nzeroGrowthRounds\t" + p.zeroGrowthRounds + "\n");
    });
  ')" || {
    # node 以非零退出 ⇒ 上面的命令整体失败（pipefail + 命令替换）。把 stderr 的具体原因带出。
    echo "[tick] G4b: failed to parse trigger_body for prev counters (coverage/zeroGrowthRounds). Refusing to silently fall back to 0/0 — that would silently reset the zero-growth counter and resurrect the convergence defect (spec §1.2 / R5)." >&2
    exit 1
  }
  prev_coverage="$(printf '%s\n' "$prev_line" | awk -F'\t' '$1=="coverage"{print $2}')"
  prev_zero="$(printf '%s\n' "$prev_line" | awk -F'\t' '$1=="zeroGrowthRounds"{print $2}')"
  tick_args+=(--prev-coverage "$prev_coverage" --prev-zero-growth-rounds "$prev_zero")
  run_output="$("${tick_args[@]}")"
  printf '%s\n' "$run_output"
  # A9 —— 板面仍有非终态 clue（hasPendingWork=true）⇒ 投下一条触发（id 每轮唯一，否则 put 覆盖）；
  #      否则不投 ⇒ drain 自然收敛退出。触发 id 用 纳秒时间戳 + PID，保证每轮唯一。
  # ⛔ 续投所需的 trigger_store_dir / loop_store_cli / loop_engine_runner 必须在 hasPendingWork=true 时
  #    全部就绪；任一缺失 ⇒ 响亮失败（非零退出 + 点名缺项），绝不静默不投（spec §3.2 禁止静默零结果）。
  # G4b —— 续投的 trigger body 必须带本轮 decideTermination 的 coverage / zeroGrowthRounds，
  #    下一轮读回作为 prev 值（spec §1.2 / R4）。从 run_output 的 termination 字段提取。
  if printf '%s' "$run_output" | grep -q '"hasPendingWork": *true'; then
    if [ -z "$trigger_store_dir" ] || [ -z "$loop_store_cli" ] || [ -z "$loop_engine_runner" ]; then
      echo "[tick] hasPendingWork=true but trigger wiring is incomplete: trigger_store_dir/loop_store_cli/loop_engine_runner must all be set. Refusing to silently skip the continuation put." >&2
      exit 1
    fi
    # 从 tick-entry 的 JSON 输出里提取 termination.coverage / termination.zeroGrowthRounds。
    # node 是硬依赖；输出 tab 分隔的 字段<TAB>值。提取失败（termination 缺失）⇒ 响亮失败（R4）。
    term_line="$(printf '%s' "$run_output" | node -e '
      let s = "";
      process.stdin.on("data", (c) => { s += c; });
      process.stdin.on("end", () => {
        let p;
        try { p = JSON.parse(s); } catch (e) { console.error("G4b: tick-entry output is not valid JSON: " + e.message); process.exit(1); }
        const t = p.termination;
        if (!t || typeof t.coverage !== "number" || typeof t.zeroGrowthRounds !== "number") {
          console.error("G4b: tick-entry output missing termination.coverage / termination.zeroGrowthRounds");
          process.exit(1);
        }
        process.stdout.write("coverage\t" + t.coverage + "\nzeroGrowthRounds\t" + t.zeroGrowthRounds + "\n");
      });
    ')" || {
      echo "[tick] G4b: failed to extract termination.coverage / termination.zeroGrowthRounds from tick-entry output for the continuation trigger body. Refusing to write a counter-less body (next round would loud-fail on missing fields)." >&2
      exit 1
    }
    next_coverage="$(printf '%s\n' "$term_line" | awk -F'\t' '$1=="coverage"{print $2}')"
    next_zero="$(printf '%s\n' "$term_line" | awk -F'\t' '$1=="zeroGrowthRounds"{print $2}')"
    next_id="a9-$(date +%s%N)-$$"
    next_body="{\"coverage\":${next_coverage},\"zeroGrowthRounds\":${next_zero}}"
    "$loop_engine_runner" "$loop_store_cli" "$trigger_store_dir" put \
      "{\"id\":\"${next_id}\",\"status\":\"open\",\"body\":${next_body}}"
  fi
else
  "$tick_entry" --selfcheck
fi
