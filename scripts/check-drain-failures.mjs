import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const stdin = readFileSync(0, "utf8").trim();
if (!stdin) {
  process.exit(0);
}

let drainJson;
try {
  drainJson = JSON.parse(stdin);
} catch {
  process.exit(0);
}

const drainId = drainJson.drain_id;
if (!drainId || typeof drainId !== "string") {
  process.exit(0);
}

function runtimeRoot() {
  if (process.env.LOOP_ENGINE_RUNTIME_ROOT) return process.env.LOOP_ENGINE_RUNTIME_ROOT;
  const cfg = join(homedir(), ".config", "loop-engine", "config.json");
  try {
    const j = JSON.parse(readFileSync(cfg, "utf8"));
    if (typeof j.runtimeRoot === "string" && j.runtimeRoot.length > 0) return j.runtimeRoot;
  } catch {}
  if (process.env.LOOP_ENGINE_STATE) return process.env.LOOP_ENGINE_STATE;
  return join(homedir(), ".loop-engine");
}

const root = runtimeRoot();
const indexFile = join(root, "index.jsonl");

let indexContent;
try {
  indexContent = readFileSync(indexFile, "utf8");
} catch {
  process.stderr.write(`[deep-research-loop] index.jsonl not found or unreadable at ${indexFile}\n`);
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
    const m = line.match(/\[bash 非零退出 EXIT:(\d+)\]/);
    if (m) {
      failed = true;
      process.stderr.write(`[deep-research-loop] TICK FAILURE: run_dir=${entry.run_dir} exit=${m[1]}\n`);
      process.stderr.write(`[deep-research-loop]   journal: ${line.trim()}\n`);
    }
  }
}

if (failed) {
  process.exit(3);
}