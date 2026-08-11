#!/usr/bin/env node
/**
 * E0 —— 从真实 tick run_output（journal.jsonl）里判定板面是否到达终态（判据 4 / §1.2）。
 *
 * ⛔ 凡是从 JSON 取值一律真解析（JSON.parse），⛔ 不用贪婪正则从 JSON 抽多值。
 *
 * 输入：run.stdout.log（stdin）—— 即 bin/deep-research-loop.sh 的完整 stdout。
 *   其中含 loop-engine 的 **drain 摘要**（单个 JSON 对象，带 reason / rounds / drain_id）。
 *
 * ⛔ 板面真正的 termination.state **不在** run.stdout.log 里：那是 tick 节点（tick-entry --run）
 *   在**每一轮 tick** 用真实板面 + 跨 tick 累计的 zeroGrowthRounds 调 decideTermination 算出的，
 *   tick.md 用 `printf '%s\n' "$run_output"` 打出 run_output 的 JSON（含 termination），
 *   被 loop-engine 收进 <run_dir>/journal.jsonl。因此要读真实终态，须沿
 *   scripts/check-drain-failures.mjs 同一条取证路径：
 *     drain 摘要.drain_id → index.jsonl → run_dir → journal.jsonl → 最后一轮 tick run_output
 *     → termination.state。
 *
 * 判定：
 *   - run.stdout.log 里没有 drain 摘要、或摘要没有 drain_id ⇒ exit 1（板面无终态证据）。
 *   - index.jsonl / journal.jsonl 读不到、或找不到该 drain 的 run_dir ⇒ exit 1（无终态证据）。
 *   - journal.jsonl 里没有含 termination 的 tick run_output ⇒ exit 1（无终态证据）。
 *   - 最后一轮 tick 的 termination.state === null ⇒ 输出字面量 "null"（板面未达终态），exit 0。
 *   - termination.state 非 null（如 "converged" / "capped" / "partial"）⇒ 输出该终态，exit 0。
 *
 * ⛔ journal.jsonl 的每一行是 loop-engine 的 **JournalEntry**：
 *   { run_id, identity, result, effects, spawned_by }，其中 `result` 是一个 **转义字符串**，
 *   装着 tick 节点 stdout 的 run_output JSON（含 termination）。tick-entry --run 打印
 *   JSON.stringify(outcome, null, 2)，而 RunWriteOutcome 没有 `result` 键 ⇒ parseEnvelope 抛错 ⇒
 *   bash 适配器回退成 { result: stdout.trim(), effects: [] }。因此 termination **嵌套在 result 里**，
 *   **不在** journal 行的顶层。读真实终态必须先解析外层 JournalEntry，再 JSON.parse 其 `result`
 *   字符串拿到 run_output，最后取 .termination.state。
 *
 * 输出（stdout）：终态字符串；"null" 表示板面未达终态。
 * 退出码：0 = 读到终态判定（含 null）；1 = 没有终态证据（读不到）。
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

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

let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  // 解析 drain 摘要（最后一个 reason+rounds 的 JSON 行）。
  let drain;
  for (const line of s.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    let obj;
    try {
      obj = JSON.parse(t);
    } catch {
      continue;
    }
    if (
      obj &&
      typeof obj === "object" &&
      typeof obj.reason === "string" &&
      typeof obj.rounds === "number"
    ) {
      drain = obj;
    }
  }
  if (!drain || typeof drain.drain_id !== "string" || drain.drain_id === "") {
    process.stderr.write(
      "[e0-terminal-state] loop output contains no drain summary with drain_id; cannot locate the run's journal to read the board's real termination.state\n",
    );
    process.exit(1);
  }
  const drainId = drain.drain_id;
  const root = runtimeRoot();
  const indexFile = join(root, "index.jsonl");
  let indexContent;
  try {
    indexContent = readFileSync(indexFile, "utf8");
  } catch {
    process.stderr.write(`[e0-terminal-state] index.jsonl not found or unreadable at ${indexFile}\n`);
    process.exit(1);
  }
  const runDirs = [];
  for (const line of indexContent.trim().split("\n")) {
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.drain_id === drainId && rec.run_dir) runDirs.push(rec.run_dir);
    } catch {}
  }
  if (runDirs.length === 0) {
    process.stderr.write(`[e0-terminal-state] no run_dir found in index.jsonl for drain_id=${drainId}\n`);
    process.exit(1);
  }
  // 遍历每个 run_dir 的 journal.jsonl，取最后一轮含 termination 的 tick run_output。
  let lastTermination = null;
  for (const runDir of runDirs) {
    const journalFile = join(runDir, "journal.jsonl");
    let journalContent;
    try {
      journalContent = readFileSync(journalFile, "utf8");
    } catch {
      process.stderr.write(
        `[e0-terminal-state] journal.jsonl not found or unreadable at ${journalFile}\n`,
      );
      process.exit(1);
    }
    for (const line of journalContent.trim().split("\n")) {
      if (!line) continue;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      // 外层是 JournalEntry：result 是**字符串**（转义包裹的 run_output JSON）。
      if (!entry || typeof entry !== "object" || typeof entry.result !== "string") continue;
      // ⛔ 用 JSON.parse 真解析 result 字符串拿 run_output，⛔ 不用正则从转义字符串里抠。
      let runOutput;
      try {
        runOutput = JSON.parse(entry.result);
      } catch {
        continue;
      }
      if (
        runOutput &&
        typeof runOutput === "object" &&
        runOutput.termination &&
        typeof runOutput.termination === "object"
      ) {
        lastTermination = runOutput.termination;
      }
    }
  }
  if (lastTermination === null) {
    process.stderr.write(
      "[e0-terminal-state] journal.jsonl contains no tick run_output with a termination object; no terminal-state evidence\n",
    );
    process.exit(1);
  }
  const state = lastTermination.state;
  process.stdout.write(`${state === null || state === undefined ? "null" : String(state)}\n`);
  process.exit(0);
});
