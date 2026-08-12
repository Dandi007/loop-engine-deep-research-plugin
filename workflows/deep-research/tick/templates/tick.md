set -euo pipefail
# A8c —— tick 节点可执行体（bash harness），已从 --selfcheck 切到真实 tick 入口（spec §1.3）。
# 真实入口：--run <channel> 执行 CAS + spawn + 收割（接线判别，spec §1.2）。
# tick_entry / tick_channel / evidence_channel / allowed_root 由 fleet 的 pipeline input 注入（loop-engine 渲染时替换）。
# ⛔ A8e——收割步的 evidence channel 也随装配系统一路注入，--run 带上 --evidence-channel
#    （spec §1.4：显式传入、无默认、无字符串推导）；缺失时收割决策会响亮失败而非卡死 tick。
# ⛔ A8f——code-local 所需 --allowed-root 也随装配系统一路注入；缺失时 code-local dispatch 会响亮失败
#    （spec §1.2 / F5），其余 role 不因它缺失被阻断。
# ⛔ A10c——--max-writes 也随装配系统一路注入（bin 导出 MAX_WRITES，缺省足以收割一张真实卡）；
#    不再让生产链路上 --run 静默吃 CLI 默认值 5（那会让 ≥5 条 evidence 的卡永远收割不了，恒死锁）。
# ⛔ G4a——研究主问题 --question 也随装配系统一路注入（bin 导出 RESEARCH_QUESTION，无缺省）；
#    CLI 支持它、引擎在 triage 决策上依赖它，唯独生产从不传它 ⇒ 收集段首个 triage 决策即响亮失败。
# ⛔ A9——trigger 续投所需的 trigger_store_dir / loop_store_cli / loop_engine_runner 随装配系统一路注入；
#    tick 完成后当且仅当板面仍有非终态 clue（hasPendingWork=true）才投下一条触发（spec §1.3 / F9）。
# ⛔ G4b——终止计数（coverage / zeroGrowthRounds）经 trigger body 跨 tick 传递（spec §1.2）：
#    claim.bind 已把 trigger_body 绑进 pipeline input；本节点读 trigger_body（claim.bind 绑进来的 JSON）解析上一轮计数，
#    以 --prev-coverage / --prev-zero-growth 传给 tick-entry，并把本轮 decideTermination 的计数
#    写进下一条 trigger 的 body。⛔ body 缺失/损坏 ⇒ 响亮失败（不得静默回落 0/0，否则计数器被无声重置）。
#    首个 seed 触发的 body 形如 {"seed":true}（无计数字段）⇒ 不传 --prev-*（tick-entry 缺省 0，首轮语义）。
# ⛔ --selfcheck 仍保留（A7 G6/G7 需要它做无副作用自检）：未注入 tick_channel 时退化为 --selfcheck。
tick_entry="{{tick_entry}}"
tick_channel="{{tick_channel}}"
evidence_channel="{{evidence_channel}}"
allowed_root="{{allowed_root}}"
max_writes="{{max_writes}}"
research_question="{{research_question}}"
research_origin="{{research_origin}}"
doc_channel="{{doc_channel}}"
trigger_store_dir="{{trigger_store_dir}}"
loop_store_cli="{{loop_store_cli}}"
loop_engine_runner="{{loop_engine_runner}}"
# G4b —— trigger_body 经 claim.bind 绑进 pipeline input，是续投 trigger 的 JSON body。
# ⛔ body 是 JSON（含双引号/花括号），不能用 bash 双引号赋值（会被 verbatim 渲染破坏）。
#    用 quoted heredoc（<<'EOF'）捕获 verbatim 字符流：loop-engine 把 trigger body 渲染进
#    heredoc 正文，bash 把整段正文（直到 G4B_TRIGGER_BODY_EOF）原样赋给 trigger_body，不受 " / { / } 影响。
trigger_body=$(cat <<'G4B_TRIGGER_BODY_EOF'
{{trigger_body}}
G4B_TRIGGER_BODY_EOF
)
# G4b —— $(cat ...) 命令替换已剥离末尾换行，trigger_body 即 JSON 原文。

run_output=""
if [ -n "$tick_channel" ]; then
  # G4a —— ⛔ 不再把 evidence/allowed_root 的可选性翻倍成 4 分支组合树（每加一个可选参数就 ×2）。
  # 改为增量拼 argv（数组累加后一次调用）；set -euo pipefail 下 [ … ] && … 作为语句在条件为假时
  # 会以非零退出终止脚本，因此用 if 块逐项累加。run_output 的捕获与后续 hasPendingWork 判定逐字不变。
  tick_args=("$tick_entry" --run "$tick_channel")
  if [ -n "$evidence_channel" ]; then tick_args+=(--evidence-channel "$evidence_channel"); fi
  if [ -n "$allowed_root" ]; then tick_args+=(--allowed-root "$allowed_root"); fi
  tick_args+=(--max-writes "$max_writes")
  if [ -n "$research_question" ]; then tick_args+=(--question "$research_question"); fi
  # G4c —— research origin 与 doc channel 可选注入 tick-entry --run。
  if [ -n "$research_origin" ]; then tick_args+=(--origin "$research_origin"); fi
  if [ -n "$doc_channel" ]; then tick_args+=(--doc-channel "$doc_channel"); fi
  # G4b —— 从 trigger_body 解析上一轮的 coverage / zeroGrowthRounds 并传给 tick-entry。
  #   ⛔ body 一旦非空就必须是合法 JSON。首轮判定基于 **seed 标记**（{"seed":true}）：
  #      seed body ⇒ 不传 --prev-*（tick-entry --run 缺省 0 = 首轮语义）。
  #      续投 body（含 {"tick":true,...}）必须带齐 coverage/zeroGrowthRounds 两个非负整数字段，
  #      否则响亮失败（exit 1，点名 trigger_body 与 G4b）；不得静默回落 0/0
  #      （那是本包根因 zeroGrowthRounds 无跨 tick 记忆的原样复发，spec §1.2 R5）。
  #      ⛔ 一个丢了计数器的续投 body（如 {"tick":true}）不被当成首轮 —— 那会让 zeroGrowthRounds
  #      被无声重置，正是 R5 禁止的形态。
  #   ⛔（attempt 2 评审 minor）解析走 tick-entry --parse-trigger-body（调用 TS 端
  #      parseTerminationFromBody 单源真相），不再在 tick.md 内嵌一份 node 解析脚本——
  #      两份解析器会静默发散，且原内嵌脚本用 fixed-name scratch file trigger_body_err.txt
  #      写入 tick 节点 CWD，CWD 不可写时 redirect 失败被误归因为「trigger body 坏」。
  #      现改为直接捕获子进程 stderr（command substitution 内 2>&1 不可靠，故用临时文件经 mktemp）。
  prev_args=()
  if [ -n "$trigger_body" ]; then
    parse_err="$(mktemp -t g4b_parse_err.XXXXXX)" || { echo "[tick] mktemp failed for trigger_body parse stderr" >&2; exit 1; }
    if ! prev_line="$("$tick_entry" --parse-trigger-body "$trigger_body" 2>"$parse_err")"; then
      cat "$parse_err" >&2
      rm -f "$parse_err"
      exit 1
    fi
    rm -f "$parse_err"
    if [ -n "$prev_line" ]; then
      _prev_cov="${prev_line%% *}"
      _prev_zgr="${prev_line#* }"
      if [ -n "$_prev_cov" ] && [ -n "$_prev_zgr" ]; then
        prev_args+=(--prev-coverage "$_prev_cov" --prev-zero-growth "$_prev_zgr")
      fi
    fi
  fi
  tick_args+=("${prev_args[@]}")
  run_output="$("${tick_args[@]}")"
  printf '%s\n' "$run_output"
  # A9 —— 板面仍有非终态 clue（hasPendingWork=true）⇒ 投下一条触发（id 每轮唯一，否则 put 覆盖）；
  #      否则不投 ⇒ drain 自然收敛退出。触发 id 用 纳秒时间戳 + PID，保证每轮唯一。
  # ⛔ 续投所需的 trigger_store_dir / loop_store_cli / loop_engine_runner 必须在 hasPendingWork=true 时
  #    全部就绪；任一缺失 ⇒ **响亮失败**（非零退出 + 点名缺项），绝不静默不投（spec §3.2 禁止静默零结果）。
  # G4b —— 续投 trigger 的 body 承载本轮 decideTermination 的 coverage/zeroGrowthRounds（spec §1.2）。
  #    从 run_output 的 JSON 解析 termination.coverage / termination.zeroGrowthRounds，写进下一条 body。
  # §1.2 —— 续投门对齐终态判据：hasPendingWork=true 或 (termination.state 仍为 null 且未触顶)。
  #   ⛔ 不得再用 grep 正则（GT-4/GT-7）：用 node JSON.parse 真解析 run_output。
  #   ⛔ 拿到非 null 终态后必须停止续投（GT-4）；触顶时按既有语义走（capped 需等在途排空）。
  _should_continue=$(node -e "
    const s = process.argv[1];
    let o;
    try { o = JSON.parse(s); } catch(e) { process.stdout.write('0'); process.exit(0); }
    const hpw = o && typeof o === 'object' ? o.hasPendingWork : false;
    const term = o && typeof o === 'object' ? o.termination : null;
    const state = term && typeof term === 'object' ? term.state : undefined;
    const capHit = term && typeof term === 'object' ? term.capHit : false;
    if (hpw) { process.stdout.write('1'); process.exit(0); }
    if ((state === null || state === undefined) && !capHit) { process.stdout.write('1'); process.exit(0); }
    process.stdout.write('0');
  " "$run_output")
  if [ "$_should_continue" = "1" ]; then
    if [ -z "$trigger_store_dir" ] || [ -z "$loop_store_cli" ] || [ -z "$loop_engine_runner" ]; then
      echo "[tick] continuation required but trigger wiring is incomplete: trigger_store_dir/loop_store_cli/loop_engine_runner must all be set. Refusing to silently skip the continuation put." >&2
      exit 1
    fi
    # G4b —— 解析本轮 termination 计数写进下一条 trigger body。run_output 必含 termination（tick-entry --run 输出）。
    #   JS 经 heredoc 喂 node stdin，避免引号冲突（同上 G4B_PARSE_EOF 块的理由）。
    next_term=$(node - "$run_output" <<'G4B_NEXT_EOF'
      const s = process.argv[2];
      let o;
      try { o = JSON.parse(s); } catch (e) {
        console.error("G4b: run output is not valid JSON: " + e.message);
        process.exit(1);
      }
      const t = o && typeof o === "object" ? o.termination : null;
      if (!t || typeof t !== "object") {
        console.error("G4b: run output missing termination object");
        process.exit(1);
      }
      const cov = t.coverage, zgr = t.zeroGrowthRounds;
      if (typeof cov !== "number" || typeof zgr !== "number") {
        console.error("G4b: termination.coverage/zeroGrowthRounds missing");
        process.exit(1);
      }
      process.stdout.write(cov + "\t" + zgr);
G4B_NEXT_EOF
    )
    next_cov="${next_term%$'\t'*}"
    next_zgr="${next_term#*$'\t'}"
    next_id="a9-$(date +%s%N)-$$"
    next_body="{\"tick\":true,\"coverage\":${next_cov},\"zeroGrowthRounds\":${next_zgr}}"
    "$loop_engine_runner" "$loop_store_cli" "$trigger_store_dir" put \
      "{\"id\":\"${next_id}\",\"status\":\"open\",\"body\":${next_body}}"
  fi
else
  "$tick_entry" --selfcheck
fi
