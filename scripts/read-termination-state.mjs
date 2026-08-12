import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/**
 * Read termination.state from the journal via the GT-2 path.
 *
 * Path: drain summary (stdin) → drain_id → index.jsonl → run_dir →
 *       journal.jsonl → last tick's result → first JSON document →
 *       termination.state
 *
 * GT-2: The `result` field in journal.jsonl contains TWO concatenated JSON
 * documents (the tick's pretty-printed output + the continuation trigger put
 * echo). We must extract only the first JSON document using bracket counting.
 */
const stdin = readFileSync(0, "utf8").trim();
if (!stdin) {
  process.stderr.write("[read-termination-state] empty stdin (no drain summary)\n");
  process.exit(3);
}

let drainJson;
try {
  drainJson = JSON.parse(stdin);
} catch {
  process.stderr.write("[read-termination-state] stdin is not valid JSON (drain summary parse failed)\n");
  process.exit(3);
}

const drainId = drainJson.drain_id;
if (!drainId || typeof drainId !== "string") {
  process.stderr.write("[read-termination-state] drain summary has no drain_id (cannot locate run_dir)\n");
  process.exit(3);
}

const runsRoot = drainJson.runs_root;
if (!runsRoot || typeof runsRoot !== "string") {
  process.stderr.write("[read-termination-state] drain summary has no runs_root (cannot locate index.jsonl)\n");
  process.exit(3);
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
  process.stderr.write(`[read-termination-state] index.jsonl not found or unreadable at ${indexFile}\n`);
  process.exit(3);
}

const laneEntries = [];
for (const line of indexContent.trim().split("\n")) {
  if (!line) continue;
  try {
    const rec = JSON.parse(line);
    if (rec.drain_id === drainId && rec.lane && rec.run_dir) {
      laneEntries.push({ run_dir: rec.run_dir, lane: rec.lane });
    }
  } catch {}
}

if (laneEntries.length === 0) {
  process.stderr.write(`[read-termination-state] no lane entries found in index.jsonl for drain_id=${drainId}\n`);
  process.exit(3);
}

let foundTermination = null;

for (const entry of laneEntries) {
  const journalFile = join(entry.run_dir, "journal.jsonl");
  let journalContent;
  try {
    journalContent = readFileSync(journalFile, "utf8");
  } catch {
    process.stderr.write(`[read-termination-state] journal.jsonl not found or unreadable at ${journalFile}\n`);
    process.exit(3);
  }

  for (const line of journalContent.trim().split("\n")) {
    if (!line) continue;
    let journalLine;
    try {
      journalLine = JSON.parse(line);
    } catch {
      continue;
    }
    if (journalLine.identity !== "tick") continue;

    const result = journalLine.result;
    if (typeof result !== "string" || result.length === 0) {
      process.stderr.write(`[read-termination-state] journal entry for tick has no result field\n`);
      process.exit(3);
    }

    const firstDocEnd = findFirstJsonEnd(result);
    if (firstDocEnd < 0) {
      process.stderr.write(`[read-termination-state] failed to locate first JSON document in tick result\n`);
      process.exit(3);
    }

    const firstDoc = result.slice(0, firstDocEnd);
    let parsed;
    try {
      parsed = JSON.parse(firstDoc);
    } catch {
      process.stderr.write(`[read-termination-state] first JSON document in tick result is not valid JSON\n`);
      process.exit(3);
    }

    const termination = parsed && typeof parsed === "object" ? parsed.termination : null;
    if (!termination || typeof termination !== "object") {
      process.stderr.write(`[read-termination-state] tick output has no termination object\n`);
      process.exit(3);
    }
    foundTermination = termination;
  }
}

if (foundTermination === null) {
  process.stderr.write(`[read-termination-state] no tick entry found in journal for drain_id=${drainId}\n`);
  process.exit(3);
}

const term = foundTermination;
process.stdout.write(JSON.stringify({
  state: term.state ?? null,
  coverage: term.coverage,
  zeroGrowthRounds: term.zeroGrowthRounds,
  capHit: term.capHit,
}));

/**
 * GT-2: Find the end position of the first complete JSON value in a string.
 * Uses bracket/brace counting with string literal awareness.
 * Returns the index after the last character of the first JSON value,
 * or -1 if no complete JSON value is found.
 */
function findFirstJsonEnd(s) {
  let depth = 0;
  let inString = false;
  let escape = false;
  let started = false;

  for (let i = 0; i < s.length; i++) {
    const ch = s[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (inString) {
      if (ch === "\\") {
        escape = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
      if (!started) started = true;
      continue;
    }

    if (ch === "{" || ch === "[") {
      depth++;
      started = true;
    } else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0 && started) {
        return i + 1;
      }
    }
  }

  return -1;
}