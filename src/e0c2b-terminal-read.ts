/**
 * E0c2b §1.1 / GT-2 —— 终态取真值：从一次 drain 的落盘产物里读取最后一轮 tick 的 termination.state。
 *
 * 读取链路（GT-2 取证路径，逐字照抄，⛔ 不得反推）：
 *   drain 摘要(JSON,含 drain_id) → <runtimeRoot>/index.jsonl → 找 drain_id 命中的 run_dir →
 *   <run_dir>/journal.jsonl → 找 identity=="tick" 的**最后一条** → 解析其 result（嵌套转义字符串）
 *   → JSON.parse(result).termination.state
 *
 * ⛔ 关键地面真相（spec §0 GT-2）：
 *   - termination **不是** journal 行的顶层键；journal 行形如
 *     `{"run_id":"tick~1","identity":"tick","result":"<tick 的完整 stdout，转义字符串>","effects":[],…}`。
 *     必须先取 `result` 再 JSON.parse 其中的 JSON 才能拿到 termination。
 *   - drain 摘要是**含嵌套对象**的单行 JSON（如 `{"ticksByLabel":{"tick":16}, ...}`），
 *     brace-free 正则永远抓不到（GT-7）：取摘要一律逐行 JSON.parse，禁止花括号正则。
 *
 * 链路任一步失败（拿不到 drain 摘要 / 无 drain_id / 找不到 run_dir / 无 journal /
 * 没有 identity=="tick" 的条目 / result 解析失败）⇒ **响亮失败并点名是哪一步**
 * （§1.1：⛔ 不得回退成「用 drain 摘要的 reason 凑合」，⛔ 不得把「读不到」当成任一方向的默认值）。
 *
 * 本模块是纯读取 + 解析；不 import ./bus、不发网络请求。所有路径来自落盘产物。
 */
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

/** 终态封闭枚举（与 src/tick.ts:TERMINAL_STATES 对齐，单源真相经结构对齐而非 import 以保持本模块无副作用依赖）。 */
export const TERMINAL_STATES = ["converged", "capped", "partial"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** 终止判定的可观察子结构（termination.state 仅取这四个字段足以判定终态）。 */
export interface TerminationSnapshot {
  state: TerminalState | null;
  coverage: number;
  zeroGrowthRounds: number;
  capHit: boolean;
}

/** 一次 drain 摘要里取真值所需的最小字段。 */
export interface DrainSummary {
  drain_id: string;
  reason?: string;
  runs_root?: string;
  [k: string]: unknown;
}

/** 终态读取失败（响亮失败，点名失败步骤）。 */
export class TerminalReadError extends Error {
  constructor(
    public readonly step: TerminalReadStep,
    message: string,
    public readonly context?: Record<string, unknown>,
  ) {
    super(`[terminal-read] step=${step}: ${message}`);
    this.name = "TerminalReadError";
  }
}

/** 链路上的每一步都有一个稳定的 step 名（失败时点名是哪一步）。 */
export type TerminalReadStep =
  | "parse_drain_summary" // drain 摘要 JSON.parse 失败 / 缺 drain_id
  | "resolve_runtime_root" // 解析 loop-engine runtime root 失败
  | "read_index" // index.jsonl 读不到
  | "find_run_dirs" // index.jsonl 里没有该 drain_id 的 lane 条目
  | "read_journal" // 某个 run_dir 的 journal.jsonl 读不到
  | "find_tick_entry" // journal 里没有 identity=="tick" 的条目
  | "parse_tick_result" // tick 的 result 不是合法 JSON
  | "read_termination"; // 解析后的 JSON 里取不到 termination 对象

/**
 * 解析 loop-engine runtime root（与 scripts/check-drain-failures.mjs 同一条路径解析，⛔ 不得另写一份）。
 * 顺序：LOOP_ENGINE_RUNTIME_ROOT > ~/.config/loop-engine/config.json:runtimeRoot > LOOP_ENGINE_STATE > /data/loop-engine。
 */
export function resolveRuntimeRoot(env: NodeJS.ProcessEnv = process.env): string {
  if (env.LOOP_ENGINE_RUNTIME_ROOT) return env.LOOP_ENGINE_RUNTIME_ROOT;
  const cfg = join(homedir(), ".config", "loop-engine", "config.json");
  try {
    const j = JSON.parse(readFileSync(cfg, "utf8"));
    if (typeof j.runtimeRoot === "string" && j.runtimeRoot.length > 0) return j.runtimeRoot;
  } catch {}
  if (env.LOOP_ENGINE_STATE) return env.LOOP_ENGINE_STATE;
  return "/data/loop-engine";
}

/**
 * GT-7 —— 从 drain stdout（可能多行，每行一个 JSON 或非 JSON）里抽出 drain 摘要。
 * ⛔ 一律**逐行 JSON.parse**：取能解析且含 drain_id 字段的那一行。
 * ⛔ 禁止任何形式的花括号正则（GT-7：真实摘要有 `"ticksByLabel":{"tick":16}` 嵌套对象，
 *    brace-free 正则 `\{[^{}]*"drain_id"[^{}]*\}` 恒抓空）。
 *
 * 多行都含 drain_id 时取**最后一行**（驱动 stdout 末尾才是最终 drain 摘要）。
 * 找不到 ⇒ 抛 TerminalReadError("parse_drain_summary")（§1.1：拿不到可解析摘要 ⇒ 响亮失败）。
 */
export function parseDrainSummary(stdout: string): DrainSummary {
  if (!stdout || !stdout.trim()) {
    throw new TerminalReadError("parse_drain_summary", "drain stdout is empty");
  }
  let last: DrainSummary | null = null;
  let lastLineNo = -1;
  const lines = stdout.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line || !line.trim()) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue; // 非 JSON 行（如驱动 stderr 渗入 / 状态行）跳过。
    }
    if (parsed && typeof parsed === "object" && "drain_id" in parsed) {
      const d = parsed as DrainSummary;
      if (typeof d.drain_id === "string" && d.drain_id.length > 0) {
        last = d;
        lastLineNo = i;
      }
    }
  }
  if (!last) {
    throw new TerminalReadError(
      "parse_drain_summary",
      "no line in drain stdout parsed to a JSON object with a non-empty string drain_id (GT-7: must line-wise JSON.parse; brace regex never matches nested objects)",
      { lineCount: lines.length },
    );
  }
  void lastLineNo; // 仅作上下文记录，不暴露到消息里。
  return last;
}

/**
 * 从 index.jsonl 里找出该 drain_id 命中的所有 lane run_dir（与 check-drain-failures.mjs 同一条路径）。
 * 找不到 ⇒ 抛 TerminalReadError("find_run_dirs")。
 */
export function findRunDirsForDrain(
  indexPath: string,
  drainId: string,
): string[] {
  if (!existsSync(indexPath)) {
    throw new TerminalReadError(
      "read_index",
      `index.jsonl not found or unreadable at ${indexPath}`,
    );
  }
  const content = readFileSync(indexPath, "utf8");
  const dirs: string[] = [];
  for (const line of content.split(/\r?\n/)) {
    if (!line || !line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      rec &&
      typeof rec === "object" &&
      (rec as { drain_id?: unknown }).drain_id === drainId &&
      typeof (rec as { run_dir?: unknown }).run_dir === "string" &&
      typeof (rec as { lane?: unknown }).lane === "string"
    ) {
      const d = (rec as { run_dir: string }).run_dir;
      if (!dirs.includes(d)) dirs.push(d);
    }
  }
  if (dirs.length === 0) {
    throw new TerminalReadError(
      "find_run_dirs",
      `no lane entries with run_dir found in index.jsonl for drain_id=${drainId}`,
      { indexPath },
    );
  }
  return dirs;
}

/**
 * 从一条 journal 行里解析 tick 的 termination 快照。
 * journal 行形如 `{"run_id":"tick~1","identity":"tick","result":"<JSON 字符串>","effects":[]}`。
 * result 是**转义字符串**（tick 的完整 stdout）；先取 result、再 JSON.parse 其内容、再取 termination。
 *
 * journal 行非 JSON / 不是 tick / result 不是合法 JSON / 无 termination 对象 ⇒ 返回 null
 * （调用方据此跳过该行；最终一条都解析不出 ⇒ findTickTermination 抛 find_tick_entry）。
 */
export function parseTickTerminationFromJournalLine(line: string): {
  termination: TerminationSnapshot;
  raw: unknown;
} | null {
  let rec: unknown;
  try {
    rec = JSON.parse(line);
  } catch {
    return null;
  }
  if (!rec || typeof rec !== "object") return null;
  const r = rec as { identity?: unknown; result?: unknown };
  if (r.identity !== "tick") return null;
  if (typeof r.result !== "string") return null;
  let tickOut: unknown;
  try {
    tickOut = JSON.parse(r.result);
  } catch {
    return null;
  }
  if (!tickOut || typeof tickOut !== "object") return null;
  const t = (tickOut as { termination?: unknown }).termination;
  if (!t || typeof t !== "object") return null;
  const snap = t as Partial<TerminationSnapshot>;
  // state 可以是 null（未终态）或封闭枚举之一；其它字段必须是数字/布尔。
  if (
    snap.state !== null &&
    typeof snap.state !== "string"
  ) {
    return null;
  }
  if (typeof snap.state === "string") {
    if (!(TERMINAL_STATES as readonly string[]).includes(snap.state)) return null;
  }
  return {
    termination: {
      state: (snap.state as TerminalState | null) ?? null,
      coverage: typeof snap.coverage === "number" ? snap.coverage : 0,
      zeroGrowthRounds:
        typeof snap.zeroGrowthRounds === "number" ? snap.zeroGrowthRounds : 0,
      capHit: typeof snap.capHit === "boolean" ? snap.capHit : false,
    },
    raw: tickOut,
  };
}

/**
 * 从一个 run_dir 的 journal.jsonl 里找**最后一条** identity=="tick" 的 termination 快照。
 * journal 读不到 ⇒ 抛 TerminalReadError("read_journal")。
 * 一条 identity=="tick" 都没有 ⇒ 抛 TerminalReadError("find_tick_entry")（§1.1 判据 3）。
 * 有 tick 条目但 result 都解析不出 termination ⇒ 抛 TerminalReadError("parse_tick_result")
 * （与 find_tick_entry 区分：前者是有 tick 行但 result 坏，后者是连 tick 行都没有）。
 */
export function findTickTerminationInJournal(
  journalPath: string,
): TerminationSnapshot {
  if (!existsSync(journalPath)) {
    throw new TerminalReadError(
      "read_journal",
      `journal.jsonl not found or unreadable at ${journalPath}`,
    );
  }
  const content = readFileSync(journalPath, "utf8");
  let sawTick = false;
  let lastParsed: TerminationSnapshot | null = null;
  for (const line of content.split(/\r?\n/)) {
    if (!line || !line.trim()) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    if (!rec || typeof rec !== "object") continue;
    if ((rec as { identity?: unknown }).identity !== "tick") continue;
    sawTick = true;
    const parsed = parseTickTerminationFromJournalLine(line);
    if (parsed) {
      lastParsed = parsed.termination; // 取最后一条可解析的 tick 行。
    }
  }
  if (lastParsed) return lastParsed;
  if (!sawTick) {
    throw new TerminalReadError(
      "find_tick_entry",
      `no journal entry with identity=="tick" found in ${journalPath} (§1.1: must loud-fail; never default either direction)`,
      { journalPath },
    );
  }
  // 有 tick 行但全部解析失败。
  throw new TerminalReadError(
    "parse_tick_result",
    `tick entries found in ${journalPath} but none yielded a parseable termination (result is nested-escaped JSON, not a top-level key)`,
    { journalPath },
  );
}

/**
 * §1.1 入口：从一次 drain 的 stdout（含摘要）读出**该 drain 最后一轮 tick 的** termination.state。
 *
 * 取**最后一个** run_dir（loop-engine 一个 drain 里 tick lane 只有一个 run_dir；若有多个 lane 条目，
 * 取 journal 里含 tick 条目的最后一个 run_dir，与 check-drain-failures.mjs 遍历顺序一致）。
 *
 * 任一步失败 ⇒ 抛 TerminalReadError（响亮失败 + 点名 step）；⛔ 不回退 drain reason、⛔ 不默认任一方向。
 *
 * 返回 { state, coverage, zeroGrowthRounds, capHit, drainId, reason? }。
 */
export function readTerminalStateFromDrain(
  drainStdout: string,
  runtimeRoot?: string,
): TerminationSnapshot & { drainId: string; reason?: string } {
  const summary = parseDrainSummary(drainStdout);
  const drainId = summary.drain_id;
  const root = runtimeRoot ?? resolveRuntimeRoot();
  const indexPath = join(root, "index.jsonl");
  const runDirs = findRunDirsForDrain(indexPath, drainId);
  // 遍历所有 run_dir；取最后一个能成功读出 termination 的（一般只有一个 tick run_dir）。
  let last: TerminationSnapshot | null = null;
  for (const dir of runDirs) {
    const journalPath = join(dir, "journal.jsonl");
    // 若该 run_dir 没有 journal（非 tick lane 或尚未落盘），跳过；只要至少一个能读到即可。
    if (!existsSync(journalPath)) continue;
    last = findTickTerminationInJournal(journalPath);
  }
  if (!last) {
    // 所有 run_dir 都没 journal 或没有 tick 条目 ⇒ 重新对最后一个 run_dir 跑一次取它的失败原因
    // （一般是 find_tick_entry，点名该 run_dir 与步骤）。
    const lastDir = runDirs[runDirs.length - 1];
    findTickTerminationInJournal(join(lastDir, "journal.jsonl"));
    // 上面没抛说明逻辑漏了 —— 显式抛以保守失败。
    throw new TerminalReadError(
      "find_tick_entry",
      `no run_dir with a tick journal found for drain_id=${drainId}`,
      { runDirs },
    );
  }
  return {
    state: last.state,
    coverage: last.coverage,
    zeroGrowthRounds: last.zeroGrowthRounds,
    capHit: last.capHit,
    drainId,
    reason: typeof summary.reason === "string" ? summary.reason : undefined,
  };
}

/**
 * CLI 入口（供 bin/e0-regression.sh 经 vite-node 调起）：
 *   stdin = drain 的完整 stdout（逐行 JSON 或非 JSON）
 *   stdout = JSON.stringify({ state, coverage, zeroGrowthRounds, capHit, drainId, reason? })
 *   state 为 null（未终态）⇒ 仍 exit 0，让 bash 侧据此决定续投 / 撞上限
 *   任一读取步骤失败 ⇒ stderr 点名 step + exit 1（§1.1：响亮失败，⛔ 不回退 drain reason）
 *
 * 仅当作为主模块（被 vite-node 直接执行）时跑 CLI；被 import 时不跑（避免单测 import 时阻塞 stdin）。
 */
async function runCli(): Promise<number> {
  let stdin = "";
  try {
    stdin = readFileSync(0, "utf8");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[terminal-read] failed to read stdin: ${msg}\n`);
    return 1;
  }
  try {
    const snap = readTerminalStateFromDrain(stdin);
    process.stdout.write(JSON.stringify(snap));
    return 0;
  } catch (err) {
    if (err instanceof TerminalReadError) {
      process.stderr.write(`${err.message}\n`);
    } else {
      const msg = err instanceof Error ? err.message : String(err);
      process.stderr.write(`[terminal-read] unexpected error: ${msg}\n`);
    }
    return 1;
  }
}

// 检测是否在 vitest 下运行（被单测 import）。vitest 会注入 VITEST 环境变量；
// 此时跳过 CLI 入口，避免阻塞 stdin。被 vite-node 直接执行时 VITEST 未设 ⇒ 跑 CLI。
const _underVitest = !!process.env.VITEST;

if (!_underVitest) {
  process.exitCode = await runCli();
}
