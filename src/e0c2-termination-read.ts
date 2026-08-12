/**
 * E0c2 §1.1 —— 终态取真值（GT-2 路径）。
 *
 * 读取链路（spec §0 GT-2，逐字照抄真机取证，⛔ 不得由 fixture 反推、不得凑合 drain 摘要的 reason）：
 *
 *   drain 摘要.drain_id
 *     → index.jsonl（在 loop-engine runtimeRoot 下）
 *       → 匹配 drain_id 的 lane 条目（含 run_dir + lane）
 *         → run_dir/journal.jsonl
 *           → identity=="tick" 的条目（取**最后一条** = 最近一轮 tick）
 *             → result 字段（嵌套转义字符串，⛔ 不是 journal 行的顶层键）
 *               → JSON.parse(result).termination.state
 *
 * 链路任一步失败（拿不到 drain 摘要 / 无 drain_id / 找不到 runtimeRoot / 无 index.jsonl /
 * index.jsonl 里无匹配 drain_id 的 lane 条目 / 无 run_dir / 无 journal.jsonl /
 * journal 里无 identity=="tick" 条目 / result 解析失败 / termination 缺失）⇒ **响亮失败并点名是哪一步**；
 * ⛔ 不得回退成「用 drain 摘要的 reason 凑合」（spec §1.1 明确禁止），
 * ⛔ 不得把「读不到」当成任一方向的默认值（既不当成已终止，也不当成未终止）。
 *
 * 终态封闭枚举与 src/tick.ts 的 TERMINAL_STATES 一致：converged / capped / partial。
 * null 表示未终止（继续 drain）。返回的 state 就是该枚举之一或 null，由调用方据 spec §1.3 决定续跑与否。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TerminalState } from "./tick";

/** 终止读取失败的统一错误（消息文本点名失败的具体步骤，便于诊断与判别性测试）。 */
export class TerminationReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TerminationReadError";
  }
}

/** 终止读取的结果：与 src/tick.ts:TerminationState 对齐（state 为 null 表示未终止）。 */
export interface TerminationReadResult {
  state: TerminalState | null;
  coverage: number;
  zeroGrowthRounds: number;
  capHit: boolean;
  /** 取到该结果的 tick 条目所在 run_dir（诊断/记录用）。 */
  runDir: string;
  /** 取到该结果的 tick 条目所在 lane（诊断/记录用）。 */
  lane: string;
}

/**
 * drain 摘要的最小视图（真机 stdout 第三行）。只需 drain_id；其余字段忽略。
 * 摘要本身必须是合法 JSON 且含字符串 drain_id，否则响亮失败。
 */
export interface DrainSummary {
  drain_id: string;
  [k: string]: unknown;
}

/** journal.jsonl 一行的最小视图（真机：run_id / identity / result / effects / ...）。 */
interface JournalLine {
  run_id?: string;
  identity?: string;
  /** tick 的完整 stdout，嵌套转义字符串（⛔ termination 在这里面，不是顶层键）。 */
  result?: string;
  [k: string]: unknown;
}

/** tick result JSON（tick-entry --run 的输出）里 termination 子对象的最小视图。 */
interface TickResultTermination {
  state: TerminalState | null;
  coverage: number;
  zeroGrowthRounds: number;
  capHit: boolean;
}

/** 解析 drain 摘要 JSON 字符串并提取 drain_id；任一步失败 ⇒ TerminationReadError 点名。 */
export function parseDrainSummary(drainSummaryJson: string): DrainSummary {
  if (typeof drainSummaryJson !== "string" || drainSummaryJson.length === 0) {
    throw new TerminationReadError(
      "E0c2 §1.1: drain summary is empty (spec §0 GT-2: termination must be read from the tick's own result via the drain summary; refusing to fall back to drain reason).",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(drainSummaryJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TerminationReadError(
      `E0c2 §1.1: failed to JSON.parse the drain summary (spec §0 GT-2): ${msg}. Refusing to fall back to drain reason.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TerminationReadError(
      "E0c2 §1.1: drain summary parsed to a non-object (spec §0 GT-2: drain summary must be a JSON object with drain_id). Refusing to fall back to drain reason.",
    );
  }
  const obj = parsed as { drain_id?: unknown };
  if (typeof obj.drain_id !== "string" || obj.drain_id.length === 0) {
    throw new TerminationReadError(
      "E0c2 §1.1: drain summary has no string drain_id (spec §0 GT-2: the read chain starts from drain_id; cannot locate the run_dir without it). Refusing to fall back to drain reason.",
    );
  }
  return obj as DrainSummary;
}

/**
 * 解析 loop-engine runtimeRoot（与 scripts/check-drain-failures.mjs:runtimeRoot 同一条路径，
 * 单一真相源：LOOP_ENGINE_RUNTIME_ROOT > ~/.config/loop-engine/config.json.runtimeRoot >
 * LOOP_ENGINE_STATE > /data/loop-engine）。
 *
 * 显式传入 runtimeRoot 时直接用它（便于测试注入）；否则读环境与配置。
 * 解析不到一个**存在的目录** ⇒ TerminationReadError 点名（index.jsonl 必在它下面）。
 */
export function resolveRuntimeRoot(explicit?: string): string {
  const root =
    explicit ??
    process.env.LOOP_ENGINE_RUNTIME_ROOT ??
    (() => {
      try {
        const cfg = join(
          process.env.HOME ?? "",
          ".config",
          "loop-engine",
          "config.json",
        );
        if (existsSync(cfg)) {
          const j = JSON.parse(readFileSync(cfg, "utf8")) as {
            runtimeRoot?: unknown;
          };
          if (typeof j.runtimeRoot === "string" && j.runtimeRoot.length > 0) {
            return j.runtimeRoot;
          }
        }
      } catch {
        // 落到下一个候选。
      }
      return process.env.LOOP_ENGINE_STATE ?? "/data/loop-engine";
    })();
  if (typeof root !== "string" || root.length === 0) {
    throw new TerminationReadError(
      "E0c2 §1.1: loop-engine runtimeRoot resolved to empty (cannot locate index.jsonl). Refusing to fall back to drain reason.",
    );
  }
  return root;
}

/** index.jsonl 一条 lane 条目的最小视图（与 scripts/check-drain-failures.mjs 同形）。 */
interface IndexLaneEntry {
  drain_id?: unknown;
  lane?: unknown;
  run_dir?: unknown;
  tick?: unknown;
  [k: string]: unknown;
}

/**
 * 读 index.jsonl 并返回匹配 drainId 且带 run_dir 的 lane 条目。
 * index.jsonl 不存在/不可读 ⇒ TerminationReadError 点名（GT-2 路径第二环）。
 * 无匹配条目 ⇒ TerminationReadError 点名 drainId（⛔ 不得当成任一方向的默认值）。
 */
export function readLaneEntriesForDrain(
  runtimeRoot: string,
  drainId: string,
): { run_dir: string; lane: string }[] {
  const indexFile = join(runtimeRoot, "index.jsonl");
  let indexContent: string;
  try {
    indexContent = readFileSync(indexFile, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TerminationReadError(
      `E0c2 §1.1: index.jsonl not found or unreadable at ${indexFile} (spec §0 GT-2: drain_id → index.jsonl → run_dir; the read chain cannot proceed). ${msg}. Refusing to fall back to drain reason.`,
    );
  }
  const entries: { run_dir: string; lane: string }[] = [];
  for (const line of indexContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: IndexLaneEntry;
    try {
      rec = JSON.parse(trimmed) as IndexLaneEntry;
    } catch {
      continue;
    }
    if (
      rec.drain_id === drainId &&
      typeof rec.lane === "string" &&
      typeof rec.run_dir === "string" &&
      rec.run_dir.length > 0
    ) {
      entries.push({ run_dir: rec.run_dir, lane: rec.lane });
    }
  }
  if (entries.length === 0) {
    throw new TerminationReadError(
      `E0c2 §1.1: no lane entries with run_dir found in index.jsonl for drain_id=${drainId} (spec §0 GT-2: drain_id → index.jsonl → run_dir; cannot locate the tick's journal). Refusing to fall back to drain reason.`,
    );
  }
  return entries;
}

/**
 * 从一条 journal.jsonl 里取**最后一条** identity=="tick" 的条目。
 * journal 不存在/不可读 ⇒ TerminationReadError 点名 run_dir（GT-2 路径第三环）。
 * journal 里无 identity=="tick" 条目 ⇒ TerminationReadError 点名（spec §2 判据 3：⛔ 不得当作任一方向默认值）。
 */
export function readLastTickJournalLine(
  runDir: string,
  lane: string,
): JournalLine {
  const journalFile = join(runDir, "journal.jsonl");
  let journalContent: string;
  try {
    journalContent = readFileSync(journalFile, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TerminationReadError(
      `E0c2 §1.1: journal.jsonl not found or unreadable at ${journalFile} (lane=${lane}; spec §0 GT-2: run_dir → journal.jsonl → tick result). ${msg}. Refusing to fall back to drain reason.`,
    );
  }
  let lastTick: JournalLine | null = null;
  for (const line of journalContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: JournalLine;
    try {
      rec = JSON.parse(trimmed) as JournalLine;
    } catch {
      continue;
    }
    if (rec.identity === "tick") {
      lastTick = rec;
    }
  }
  if (lastTick === null) {
    throw new TerminationReadError(
      `E0c2 §1.1: no journal entry with identity=="tick" found in ${journalFile} (lane=${lane}; spec §2 判据 3: the tick's own result is the only place termination lives; ⛔ must not default either direction). Refusing to fall back to drain reason.`,
    );
  }
  return lastTick;
}

/**
 * 从 tick journal 条目的 result 字段解析 termination。
 * result 缺失/非字符串/JSON 解析失败/termination 缺失/字段类型错 ⇒ TerminationReadError 点名（GT-2：termination 嵌在 result 字符串里）。
 */
export function parseTerminationFromTickResult(
  journalLine: JournalLine,
  runDir: string,
  lane: string,
): TerminationReadResult {
  if (typeof journalLine.result !== "string" || journalLine.result.length === 0) {
    throw new TerminationReadError(
      `E0c2 §1.1: tick journal entry has no string result (run_dir=${runDir}, lane=${lane}; spec §0 GT-2: termination is nested inside the result string, not a top-level key). Refusing to fall back to drain reason.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(journalLine.result);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new TerminationReadError(
      `E0c2 §1.1: failed to JSON.parse the tick result string (run_dir=${runDir}, lane=${lane}; spec §0 GT-2: termination nests inside result). ${msg}. Result head: "${journalLine.result.slice(0, 120)}". Refusing to fall back to drain reason.`,
    );
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new TerminationReadError(
      `E0c2 §1.1: tick result parsed to a non-object (run_dir=${runDir}, lane=${lane}; spec §0 GT-2). Refusing to fall back to drain reason.`,
    );
  }
  const term = (parsed as { termination?: unknown }).termination;
  if (term === null || typeof term !== "object" || Array.isArray(term)) {
    throw new TerminationReadError(
      `E0c2 §1.1: tick result has no termination object (run_dir=${runDir}, lane=${lane}; spec §0 GT-2: termination nests inside result.termination). Refusing to fall back to drain reason.`,
    );
  }
  const t = term as Partial<TickResultTermination>;
  if (
    (t.state !== null && typeof t.state !== "string") ||
    (typeof t.state === "string" &&
      t.state !== "converged" &&
      t.state !== "capped" &&
      t.state !== "partial")
  ) {
    throw new TerminationReadError(
      `E0c2 §1.1: tick result.termination.state is not a known TerminalState or null (run_dir=${runDir}, lane=${lane}; got ${JSON.stringify(t.state)}). Refusing to fall back to drain reason.`,
    );
  }
  if (
    typeof t.coverage !== "number" ||
    typeof t.zeroGrowthRounds !== "number" ||
    typeof t.capHit !== "boolean"
  ) {
    throw new TerminationReadError(
      `E0c2 §1.1: tick result.termination has non-numeric coverage/zeroGrowthRounds or non-boolean capHit (run_dir=${runDir}, lane=${lane}; got ${JSON.stringify({ coverage: t.coverage, zeroGrowthRounds: t.zeroGrowthRounds, capHit: t.capHit })}). Refusing to fall back to drain reason.`,
    );
  }
  return {
    state: t.state as TerminalState | null,
    coverage: t.coverage,
    zeroGrowthRounds: t.zeroGrowthRounds,
    capHit: t.capHit,
    runDir,
    lane,
  };
}

/**
 * 端到端：drain 摘要 → runtimeRoot → termination.state（GT-2 全链路）。
 * 多个 lane 条目时取**最后一个 lane 的最后一条 tick**（与单 lane 行为一致；多 lane 不改变「最后一条 tick」语义）。
 *
 * 任一步失败 ⇒ TerminationReadError（消息点名失败步骤）；⛔ 绝不回退 drain reason、绝不默认任一方向。
 */
export function readTerminationFromDrain(
  drainSummaryJson: string,
  runtimeRootExplicit?: string,
): TerminationReadResult {
  const summary = parseDrainSummary(drainSummaryJson);
  const runtimeRoot = resolveRuntimeRoot(runtimeRootExplicit);
  const lanes = readLaneEntriesForDrain(runtimeRoot, summary.drain_id);
  let last: TerminationReadResult | null = null;
  for (const lane of lanes) {
    const journalLine = readLastTickJournalLine(lane.run_dir, lane.lane);
    const result = parseTerminationFromTickResult(journalLine, lane.run_dir, lane.lane);
    // 多 lane：取遍历顺序里最后一条 lane 的最后一条 tick（与「最后一条 tick」语义对齐）。
    last = result;
  }
  // lanes.length >= 1 由 readLaneEntriesForDrain 保证；last 必非 null。
  return last as TerminationReadResult;
}

// ── CLI 入口（供 bin/e0-regression.sh 经 vite-node 调起）───────────────────
//
// 用法：
//   echo '<drain 摘要 JSON>' | LOOP_ENGINE_RUNTIME_ROOT=<root> vite-node src/e0c2-termination-read.ts
// 或：
//   vite-node src/e0c2-termination-read.ts '<drain 摘要 JSON>'
//
// stdout（成功）：termination 的 JSON（{ state, coverage, zeroGrowthRounds, capHit, runDir, lane }），
//                state 为 null 表示未终止（继续 drain），非 null 表示已终止（收尾）。
// stderr + exit 1（失败）：TerminationReadError 消息（点名失败步骤）。
//
// ⛔ 本入口只读 runtimeRoot 下的 index.jsonl / journal.jsonl，零网络、零 bus 写入。

async function cliMain(): Promise<number> {
  let drainSummaryJson = "";
  // argv[2] 优先（便于 bash 直接传参）；否则从 stdin 读整段（drain 摘要可能含换行）。
  const arg = process.argv[2];
  if (arg !== undefined && arg.length > 0) {
    drainSummaryJson = arg;
  } else {
    drainSummaryJson = readFileSync(0, "utf8");
  }
  try {
    const result = readTerminationFromDrain(drainSummaryJson);
    process.stdout.write(JSON.stringify(result));
    return 0;
  } catch (err) {
    const msg =
      err instanceof TerminationReadError
        ? err.message
        : err instanceof Error
          ? `E0c2 §1.1: unexpected error reading termination state: ${err.message}`
          : `E0c2 §1.1: unexpected error reading termination state: ${String(err)}`;
    process.stderr.write(`${msg}\n`);
    return 1;
  }
}

// ⛔ 仅在作为 CLI 入口直接执行时才跑（被 import 时不跑——否则 vitest 导入本模块会因
//    cliMain 读 stdin 而挂起）。与 e0c1-prod-read.ts / e0c1-runs-channel.ts 的区别：
//    那两个从不被测试 import；本模块的纯函数被单测 import，故必须 guard。
//
// 评审 blocker（attempt 1 final REJECT，由 entry-execution 测试暴露）：原 guard 用
//    `process.argv[1].includes("e0c2-termination-read")`。但 bash 入口经 vite-node 调起本模块时
//    （`node vite-node src/e0c2-termination-read.ts "<summary>"`），vite-node 把脚本路径从 argv 消费掉、
//    用自身二进制路径占 argv[1] ⇒ `argv[1]` 永远是 `.../vite-node`，不含模块名 ⇒ guard 永假 ⇒
//    cliMain 从不跑 ⇒ 入口拿到的 termination JSON 恒空 ⇒ termination.state 恒 parse_error ⇒
//    入口永远读不到非 null 终态 ⇒ 判据 5/6/9 永远过不了。
//    改用 `argv[2]` 判定：bash 入口传入 drain 摘要 JSON 作为 argv[2]（非空字符串）⇒ CLI 模式；
//    vitest 导入本模块时 argv[2] 恒为 undefined（实测 tinypool entry 无第三参数）⇒ 不跑 cliMain（不挂起）。
const _isMainEntry =
  process.argv[2] !== undefined && process.argv[2].length > 0;
if (_isMainEntry) {
  process.exitCode = await cliMain();
}
