import { existsSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

const stdin = readFileSync(0, "utf8").trim();

// drain 摘要（loop-engine CLI 打印的单行 JSON）——drain 正常/带错退出时必含 drain_id。
let summary = null;
let summaryReason = null;
if (stdin) {
  try {
    const j = JSON.parse(stdin);
    if (j && typeof j.drain_id === "string") {
      summary = {
        drain_id: j.drain_id,
        runs_root: typeof j.runs_root === "string" ? j.runs_root : null,
      };
      summaryReason = typeof j.reason === "string" ? j.reason : null;
    }
  } catch {
    // 非 JSON 摘要 —— 落到 registry 兜底判定（C3：drain 进程死亡路径无摘要）。
  }
}

function runtimeRoot() {
  if (process.env.LOOP_ENGINE_RUNTIME_ROOT) return process.env.LOOP_ENGINE_RUNTIME_ROOT;
  const cfg = join(homedir(), ".config", "loop-engine", "config.json");
  try {
    const j = JSON.parse(readFileSync(cfg, "utf8"));
    if (typeof j.runtimeRoot === "string" && j.runtimeRoot.length > 0) return j.runtimeRoot;
  } catch {}
  if (process.env.LOOP_ENGINE_STATE) return process.env.LOOP_ENGINE_STATE;
  return "/data/loop-engine";
}

const root = runtimeRoot();
const indexFile = join(root, "index.jsonl");

let indexContent;
try {
  indexContent = readFileSync(indexFile, "utf8");
} catch {
  // ⛔ 痕迹不可读 ⇒ 响亮失败（G15 Y4a 契约）：不静默 exit 0。
  process.stderr.write(`[deep-research-loop] index.jsonl not found or unreadable at ${indexFile}\n`);
  process.exit(3);
}

const records = [];
for (const line of indexContent.trim().split("\n")) {
  if (!line) continue;
  try {
    records.push(JSON.parse(line));
  } catch {}
}

function hasRunEnd(runId) {
  return records.some((r) => r.kind === "run.end" && r.run_id === runId);
}

// ── C3 —— 定位本 drain 的 registry 身份 ─────────────────────────────
// 主路径：drain 摘要给出 drain_id / runs_root（drain 正常退出或带错退出）。
// 兜底路径：drain 进程被杀死（无摘要）时，按本驱动自己的 RUNTIME_FLEET 在 index.jsonl
//   找 drain 自身的 run.start（其 fleet 字段 == RUNTIME_FLEET，tick 子 run 的 fleet
//   指向 workflow 而非 fleet.yaml，天然区分）且无 run.end —— 精确命中本 drain，不误判并发 drain。
let drainId = summary ? summary.drain_id : null;
let runsRoot = summary ? summary.runs_root : null;

if (!drainId) {
  const fleet = process.env.RUNTIME_FLEET;
  if (fleet) {
    const fleetStarts = records.filter(
      (r) => r.kind === "run.start" && r.fleet === fleet && r.run_id,
    );
    for (let i = fleetStarts.length - 1; i >= 0; i--) {
      const c = fleetStarts[i];
      if (!hasRunEnd(c.run_id)) {
        drainId = c.run_id;
        if (typeof c.run_dir === "string") runsRoot = c.run_dir;
        break;
      }
    }
  }
  if (!drainId) {
    // 无可判定对象（无摘要且无本 drain 的 registry 痕迹）⇒ 维持原有空输入语义 exit 0。
    process.exit(0);
  }
}

// 摘要未给 runs_root 时，从 drain 自身 run.start 反查 run_dir。
if (!runsRoot) {
  const own = records.find((r) => r.kind === "run.start" && r.run_id === drainId);
  if (own && typeof own.run_dir === "string") runsRoot = own.run_dir;
}
// 再兜底：runtimeRoot()/drains/<drainId>.json 指针。
if (!runsRoot) {
  try {
    const ptr = JSON.parse(readFileSync(join(root, "drains", `${drainId}.json`), "utf8"));
    if (typeof ptr.runs_root === "string") runsRoot = ptr.runs_root;
  } catch {}
}

// ── C3 —— 读 drain registry 哨兵终态 ────────────────────────────────
// 读取 loop-engine 基座**已导出**的哨兵 registry（drain.json status/outstanding/last_heartbeat
// + index.jsonl 的 run.start/run.end 配对 + loop-events.jsonl 轮次配对）。best-effort：
// 任一文件缺失/不可读时依赖其余信号判定，绝不静默跳过「响亮终态」这一整体。
let drainState = null;
let loopRoundUnbalanced = false;
if (runsRoot) {
  try {
    const d = JSON.parse(readFileSync(join(runsRoot, "drain.json"), "utf8"));
    if (d && typeof d === "object") {
      drainState = {
        status: typeof d.status === "string" ? d.status : null,
        outstanding: typeof d.outstanding === "number" ? d.outstanding : null,
        lastHeartbeat: typeof d.last_heartbeat === "number" ? d.last_heartbeat : null,
      };
    }
  } catch {
    // best-effort：drain.json 缺失时靠 run.end 配对与 loop-events 轮次配对判定。
  }
  try {
    const evLines = readFileSync(join(runsRoot, "loop-events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean);
    let starts = 0;
    let ends = 0;
    for (const l of evLines) {
      try {
        const e = JSON.parse(l);
        if (e.kind === "round_start") starts += 1;
        else if (e.kind === "round_end") ends += 1;
      } catch {}
    }
    loopRoundUnbalanced = starts > ends;
  } catch {
    // best-effort：loop-events.jsonl 缺失时忽略该信号。
  }
}

const drainStarted = records.some((r) => r.kind === "run.start" && r.run_id === drainId);
const drainEnded = hasRunEnd(drainId);

// 判别核心（C3 spec §2）：
//   drain 未写 run.end，或 drain.json.status 仍非终态（running）且 outstanding>0
//   （存在未收割 in_flight/open 卡）⇒ 响亮终态；loop-events 轮次未闭合（死于轮中）为补充信号。
const sentinelLost =
  (drainStarted && !drainEnded) ||
  (drainState !== null && drainState.status === "running" && (drainState.outstanding ?? 0) > 0) ||
  loopRoundUnbalanced;

if (sentinelLost) {
  const laneRuns = records.filter(
    (r) => r.kind === "run.start" && r.drain_id === drainId && r.lane && r.run_dir,
  );
  const outstanding =
    drainState && drainState.outstanding != null ? drainState.outstanding : laneRuns.length;
  const unharvestedSeq = laneRuns
    .map((r) => (typeof r.run_id === "string" ? r.run_id : ""))
    .filter(Boolean)
    .join(",");
  const statusLabel = drainState && drainState.status ? drainState.status : "unknown";
  const heartbeatLabel =
    drainState && drainState.lastHeartbeat != null ? String(drainState.lastHeartbeat) : "n/a";
  // ⛔ 机器可读稳定 token：sentinel_lost 与 outstanding=<n>（供巡检/看门狗直接抓取）。
  process.stderr.write(
    `[deep-research-loop] SENTINEL LOST: sentinel_lost drain_id=${drainId} outstanding=${outstanding}\n`,
  );
  process.stderr.write(
    `[deep-research-loop]   drain registry: status=${statusLabel} last_heartbeat=${heartbeatLabel} drain_run_end=${drainEnded ? "yes" : "no"} loop_round_unbalanced=${loopRoundUnbalanced ? "yes" : "no"}\n`,
  );
  process.stderr.write(
    `[deep-research-loop]   unharvested in_flight/open count=${laneRuns.length} run_id=${unharvestedSeq || "n/a"}\n`,
  );
  process.exit(3);
}

// ── C5（第三暴露）——「撞派生预算 max_passes 不收敛仍静默 exit 0 零报告」响亮化（判别性规格 1-3）──
// 根因（spec §根因链）：round 预算（max_passes）实际收敛所需轮次超出 deriveMaxPasses 派生的
//   max_passes ⇒ coverage 冻结、proposed/inFlight 未排空 ⇒ runGenerate 从未触发 ⇒ 零报告；
//   drain.json.status 被 markDrainDone 置成 done（含 max_rounds），而旧哨兵把 `max_rounds` 排除在
//   零报告判定外（旧 line 190：summaryReason !== "max_rounds"）⇒ done + outstanding≥1 +
//   零报告被误当成功 ⇒ 静默 exit 0。这正是 C3「哨兵静默失效必响亮」的违约。
//
// ⛔ 判别性规格 2：零报告哨兵不得再以 `summaryReason !== "max_rounds"`（或以 max_passes 撞顶）
//   排除撞预算终局。drain 以「status=done 且 (outstanding≥1 或 报告未生成)」结束时，无论原由是
//   drained 还是 max_rounds/max_passes，都必须响亮（非零退出 + 点名 drain_id/outstanding/缺报告），
//   reason 使用稳定 token：budget_exhausted_no_report（撞预算）/ zero_report（其余）。
//
// ⛔ 判别性规格 3（e0-regression 不推翻）：GT-6 的「max_rounds + 非零退出 ⇒ 退避重来」合法中间态
//   只适用于**非最终、可重试的 drain 尝试**；对**最终一次 drain**（无后续重试包装），撞预算 +
//   零报告必须响亮失败。判别依据：由**调用方显式声明重试包装**（DR_DRAIN_RETRY_WRAPPED=1，
//   e0-regression.sh 的多 drain 循环声明）；生产 deep-research-loop.sh 的单 drain 即最终 drain
//   （不声明）⇒ max_rounds/max_passes 不排除、必须响亮。
const retryWrapped = process.env.DR_DRAIN_RETRY_WRAPPED === "1";
const budgetHit = summaryReason === "max_rounds" || summaryReason === "max_passes";
// 可重试中间尝试（调用方声明重试包装）且撞预算 ⇒ 保持旧排除（GT-6 退避重来交给外层循环分类）；
// 其余（含最终 drain 撞预算）⇒ 全部纳入零报告判定。
const excludedBudgetHit = retryWrapped && budgetHit;
let zeroReportReason = null;
let zeroReportToken = "zero_report";
if (drainState !== null && drainState.status === "done" && !excludedBudgetHit) {
  const outstanding = drainState.outstanding ?? 0;
  if (outstanding > 0) {
    zeroReportReason = `unconsumed continuation trigger outstanding=${outstanding}`;
    if (budgetHit) zeroReportToken = "budget_exhausted_no_report";
  } else {
    // docs channel 空：RESEARCH_ORIGIN 已配置（报告预期）而 generate 一次性标记缺失
    // （未生成/未落盘）。标记路径与 src/tick-run.ts runChannelWrite 的 one-shot 标记逐字对齐：
    //   <oneShotDir>/generated-<sha256(origin:channel)[:16]>，oneShotDir 缺省
    //   join(tmpdir(), "deep-research-generated")（可用 DR_ONE_SHOT_DIR 覆盖）。
    const origin = process.env.RESEARCH_ORIGIN;
    const channel = process.env.TICK_CHANNEL;
    if (origin && channel) {
      const oneShotDir =
        process.env.DR_ONE_SHOT_DIR || join(tmpdir(), "deep-research-generated");
      const markerHash = createHash("sha256")
        .update(`${origin}:${channel}`)
        .digest("hex")
        .slice(0, 16);
      const markerPath = join(oneShotDir, `generated-${markerHash}`);
      if (!existsSync(markerPath)) {
        zeroReportReason = `report not generated (docs channel empty): missing ${markerPath}`;
        if (budgetHit) zeroReportToken = "budget_exhausted_no_report";
      }
    }
  }
}
if (zeroReportReason) {
  process.stderr.write(
    `[deep-research-loop] ZERO REPORT: ${zeroReportToken} drain_id=${drainId} ${zeroReportReason}\n`,
  );
  process.stderr.write(
    `[deep-research-loop]   drain registry: status=done outstanding=${drainState.outstanding ?? 0}\n`,
  );
  process.exit(3);
}

// ── 既有 G15 / D7 逻辑：tick 失败检测（行为逐字不变）────────────────

const laneEntries = records.filter(
  (r) => r.drain_id === drainId && r.lane && r.run_dir,
);

if (laneEntries.length === 0) {
  process.stderr.write(`[deep-research-loop] no lane entries found in index.jsonl for drain_id=${drainId}\n`);
  process.exit(3);
}

let failed = false;
for (const entry of laneEntries) {
  const journalFile = join(entry.run_dir, "journal.jsonl");
  let journalContent;
  try {
    journalContent = readFileSync(journalFile, "utf8");
  } catch {
    process.stderr.write(`[deep-research-loop] journal.jsonl not found or unreadable at ${journalFile}\n`);
    process.exit(3);
  }

  for (const line of journalContent.trim().split("\n")) {
    if (!line) continue;
    // G15 —— tick 以 bash 非零退出收尾（节点进程退出码 ≠ 0）。
    const m = line.match(/\[bash 非零退出 EXIT:(\d+)\]/);
    if (m) {
      failed = true;
      process.stderr.write(`[deep-research-loop] TICK FAILURE: run_dir=${entry.run_dir} exit=${m[1]}\n`);
      process.stderr.write(`[deep-research-loop]   journal: ${line.trim()}\n`);
    }
    // E0c10 D7 —— tick 被引擎级 node_timeout / wall_clock 杀掉（GT-A 真机取证）：
    //   journal: {"identity":"tick","result":"[外部调用失败 status=TIMEOUT]\n","error":"exec"}
    //   仅认 `[bash 非零退出 EXIT:n]` 会把「引擎杀掉的 tick」当成成功（GT-A：超时是间歇性的，
    //   板上只有种子那一条线索时也会发生 ⇒ 与板面规模无关）。此处同时认 TIMEOUT + exec 两条标志。
    //   ⛔ 必须两条同时命中：只认 `error:"exec"` 会误报普通 exec 失败；只认 TIMEOUT 会误报
    //   业务层偶然出现的 TIMEOUT 字样。引擎杀掉的 tick 两条同时出现（GT-A 逐字照抄）。
    if (/\[外部调用失败 status=TIMEOUT\]/.test(line) && /"error"\s*:\s*"exec"/.test(line)) {
      failed = true;
      process.stderr.write(`[deep-research-loop] TICK FAILURE (engine-killed): run_dir=${entry.run_dir} reason=TIMEOUT/exec\n`);
      process.stderr.write(`[deep-research-loop]   journal: ${line.trim()}\n`);
    }
  }
}

if (failed) {
  process.exit(3);
}
