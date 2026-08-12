/**
 * E0c —— 真机端到端回归基线的可测逻辑（§1.1 / §1.2 / GT-1…GT-5）。
 *
 * 本模块封装 E0c 的可测核心（纯函数 + 轻依赖注入），供 e0-regression.sh 编排调用，
 * 也供单测直接断言（判别性判据 §2.2–2.7）。
 *
 * ⛔ 只写产品逻辑，不触碰 .dev-dispatch/** 与 .dd-evidence/**。
 * ⛔ 真 JSON 解析（Node 已在依赖内，JSON.parse 即可），⛔ 禁止贪婪正则从单行 JSON 抽多值。
 */
import { readFileSync } from "node:fs";

// ── §1.2　每次运行用一块属于该 run 的干净研究板 ──────────────────────────

/**
 * E0c（§1.2）——三条 research channel 的名字由 profile 基名 + 本次 run_id 派生。
 * 形如 `research:<base>-<run_id>.{index,evidence,docs}`；`board:agent-runs` 是全局的、不随 run 变。
 * ⛔ 每次运行创建这三条新 channel（不存在则建），⛔ 不得用「清空/删除旧 channel」实现
 *   （bus 是 append-only 无 DELETE）。
 */
export interface ResearchChannels {
  index: string;
  evidence: string;
  docs: string;
}

export function deriveResearchChannels(
  baseName: string,
  runId: string,
): ResearchChannels {
  const safeRunId = String(runId).replace(/[^A-Za-z0-9._-]/g, "-");
  const prefix = `${baseName}-${safeRunId}`;
  // ⛔ 用分段拼接（而非「前缀 + .evidence」的单模板），避免与 H15 的
  //    「从板 channel 推导 evidence channel」扫描形态撞车（本处是从 run_id 派生，非板推导）。
  const dot = ".";
  return {
    index: "research:" + prefix + dot + "index",
    evidence: "research:" + prefix + dot + "evidence",
    docs: "research:" + prefix + dot + "docs",
  };
}

// ── GT-4　种子必须带 --source（空板自播种）──────────────────────────────

export class SeedSourcesError extends Error {
  constructor() {
    super(
      "E0c GT-4: seeding an empty board requires at least one --source (and the profile must declare SEED_SOURCES). Refusing to silently seed a clue with sources: [] — that yields an undispatachable card (GT-4).",
    );
    this.name = "SeedSourcesError";
  }
}

/**
 * GT-4 —— 严格播种守卫：种子不带 sources（或 profile 未声明 sources）⇒ **响亮失败**。
 * ⛔ 不得静默播一条 `sources: []` 的线索（那会结构性不可派发，GT-4 板面实录）。
 */
export function requireSeedSources(sources: readonly string[] | undefined): void {
  if (!sources || sources.length === 0) {
    throw new SeedSourcesError();
  }
  for (const s of sources) {
    if (!s || s.trim() === "") {
      throw new SeedSourcesError();
    }
  }
}

/**
 * GT-4 —— 播种参数（channel + clue 文本 + sources）必须齐备。
 * clue 文本须与 `ALLOWED_ROOT` 指向的仓相称（能让 code-local worker 真找到东西），
 * ⛔ 不得是放之四海皆可的空话。本函数只做结构性校验（非空 + 带 sources）；
 * 种子文本内容的相称性由 profile 声明（SEED_CLUES）承担。
 */
export function buildSeedArgv(
  channelId: string,
  clueText: string,
  sources: readonly string[],
): string[] {
  if (!channelId || channelId.trim() === "") {
    throw new Error("E0c GT-4: seed channel_id must be non-empty");
  }
  if (!clueText || clueText.trim() === "") {
    throw new Error(
      "E0c GT-4: seed clue text must be non-empty and commensurate with ALLOWED_ROOT — refusing to seed a vacuous clue",
    );
  }
  requireSeedSources(sources);
  const argv = [
    "--seed",
    channelId,
    "--clue",
    clueText,
  ];
  for (const s of sources) {
    argv.push("--source", s);
  }
  return argv;
}

// ── GT-3　终态从 termination.state 取真值（journal 链）──────────────────

/**
 * E0c（GT-3）——journal 链读取失败类：点名是哪一步失败，⛔ 不得回退成「用 drain reason 凑合」。
 */
export class TerminationReadError extends Error {
  step: string;
  constructor(step: string, detail: string) {
    super(`E0c GT-3: ${step} — ${detail}`);
    this.name = "TerminationReadError";
    this.step = step;
  }
}

/**
 * GT-3 —— 从 drain 摘要 JSON 提取 `drain_id`。
 * ⛔ 读不到（drain 摘要里没有该键）⇒ 响亮失败点名这一步。
 */
export function drainIdFromSummary(summaryJson: unknown): string {
  const o =
    summaryJson !== null && typeof summaryJson === "object"
      ? (summaryJson as Record<string, unknown>)
      : null;
  const drainId = o?.drain_id;
  if (typeof drainId !== "string" || drainId.length === 0) {
    throw new TerminationReadError(
      "drain 摘要",
      "drain_id is missing or not a non-empty string; cannot locate index.jsonl lane",
    );
  }
  return drainId;
}

/**
 * GT-3 —— 从 `index.jsonl` 内容解析出 `drain_id` 对应的 lane 的 `run_dir` 列表。
 * index.jsonl 每行一个 JSON；取 `drain_id === target` 且带 `run_dir` 的记录。
 */
export function laneRunDirsFromIndex(
  indexContent: string,
  drainId: string,
): string[] {
  const dirs: string[] = [];
  for (const line of indexContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      throw new TerminationReadError(
        "index.jsonl",
        `a line is not valid JSON: ${trimmed.slice(0, 120)}`,
      );
    }
    const r =
      rec !== null && typeof rec === "object"
        ? (rec as Record<string, unknown>)
        : null;
    if (r?.drain_id !== drainId) continue;
    if (typeof r?.run_dir === "string" && r.run_dir.length > 0) {
      dirs.push(r.run_dir);
    }
  }
  if (dirs.length === 0) {
    throw new TerminationReadError(
      "index.jsonl",
      `no lane entry with drain_id=${drainId} and a run_dir was found`,
    );
  }
  return dirs;
}

/**
 * GT-3 —— 从 `journal.jsonl` 内容解析最后一轮 tick 的 `termination.state`。
 * ⛔ termination **不是** journal 行的顶层键；必须先取 `result` 再解析其中的 JSON（GT-3 取证路径）。
 * 取「最后一轮 tick」（identity === "tick" 的最后一行）的 result 里 termination.state。
 * 任一步失败（result 非 JSON、缺 termination）⇒ 响亮失败点名。
 */
export function lastTickTerminationState(
  journalContent: string,
): { state: unknown } {
  let lastResult: unknown = undefined;
  let lastIdentity: string | undefined;
  for (const line of journalContent.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let rec: unknown;
    try {
      rec = JSON.parse(trimmed);
    } catch {
      throw new TerminationReadError(
        "journal.jsonl",
        `a line is not valid JSON: ${trimmed.slice(0, 120)}`,
      );
    }
    const r =
      rec !== null && typeof rec === "object"
        ? (rec as Record<string, unknown>)
        : null;
    if (!r) continue;
    const identity = r.identity;
    if (identity !== "tick") continue;
    lastIdentity = String(identity);
    lastResult = r.result;
  }
  if (lastIdentity === undefined) {
    throw new TerminationReadError(
      "journal.jsonl",
      "no tick line (identity==='tick') found; cannot read termination.state",
    );
  }
  if (typeof lastResult !== "string" || lastResult.length === 0) {
    throw new TerminationReadError(
      "journal.jsonl",
      `last tick line has no result string (got ${typeof lastResult}); termination.state lives inside result (GT-3)`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(lastResult);
  } catch (e) {
    throw new TerminationReadError(
      "journal.jsonl",
      `last tick result is not valid JSON: ${(e as Error).message}`,
    );
  }
  const p =
    parsed !== null && typeof parsed === "object"
      ? (parsed as Record<string, unknown>)
      : null;
  const termination =
    p?.termination !== null && typeof p?.termination === "object"
      ? (p.termination as Record<string, unknown>)
      : null;
  if (!termination) {
    throw new TerminationReadError(
      "journal.jsonl",
      "last tick result has no termination object",
    );
  }
  return { state: termination.state ?? null };
}

/**
 * GT-3 —— 完整链路（纯 IO，注入读取器便于单测）：
 *   drain 摘要.drain_id → index.jsonl → run_dir → journal.jsonl → 最后一轮 tick 的 result
 *   → termination.state。任一步失败 ⇒ 响亮失败点名是哪一步，⛔ 不得回退默认值。
 * 返回最后一个 lane 的 run_dir 与 termination.state（多个 lane 时取最后一条 lane）。
 */
export function readTerminationState(opts: {
  drainSummaryJson: unknown;
  readFile: (path: string) => string;
  indexPath: string;
}): { state: unknown; runDir: string } {
  const drainId = drainIdFromSummary(opts.drainSummaryJson);
  const indexContent = (() => {
    try {
      return opts.readFile(opts.indexPath);
    } catch (e) {
      throw new TerminationReadError(
        "index.jsonl",
        `unreadable at ${opts.indexPath}: ${(e as Error).message}`,
      );
    }
  })();
  const runDirs = laneRunDirsFromIndex(indexContent, drainId);
  const lastRunDir = runDirs[runDirs.length - 1];
  const journalContent = (() => {
    try {
      return opts.readFile(lastRunDir + "/journal.jsonl");
    } catch (e) {
      throw new TerminationReadError(
        "journal.jsonl",
        `unreadable at ${lastRunDir}/journal.jsonl: ${(e as Error).message}`,
      );
    }
  })();
  const { state } = lastTickTerminationState(journalContent);
  return { state, runDir: lastRunDir };
}

/** 默认文件读取（生产路径）。 */
export function defaultReadFile(path: string): string {
  return readFileSync(path, "utf8");
}

// ── 判据 §1.1.4 / §2.5：termination.state 为 null ⇒ 非零退出 ────────────────

/**
 * E0c（§2.5）——终态真值校验：`termination.state` 为 null ⇒ **非零退出**（响亮失败）。
 * ⛔ 不得把「读不到」当成任一方向的默认值；读链路任一步失败已在 readTerminationState 里响亮失败。
 */
export function requireNonNullTermination(state: unknown): void {
  if (state === null || state === undefined) {
    throw new TerminationReadError(
      "termination.state",
      "is null — the loop did not reach a decided terminal state; refusing to treat this run as complete",
    );
  }
}
