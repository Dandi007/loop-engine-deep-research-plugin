/**
 * E0c2 §1.1 —— 从 drain 结果读取 termination.state（GT-2 路径）。
 *
 * 输入：stdin 传入 drain 摘要 JSON（deep-research-loop.sh stdout 第三行）。
 * 输出：stdout 写入 termination 对象 JSON（含 state/coverage/zeroGrowthRounds/capHit）。
 *
 * 路径：
 *   drain 摘要 → drain_id → index.jsonl → run_dir → journal.jsonl
 *   → 最后一轮 identity=="tick" 的 result → 第一个 JSON 文档 → termination
 *
 * 失败 ⇒ stderr 报错并 exit 1（点名是哪个步骤失败）。
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

function fail(step, detail) {
  process.stderr.write(`[read-termination] FAILED at step "${step}": ${detail}\n`);
  process.exit(1);
}

function parseFirstJsonDocument(s) {
  let i = 0;
  while (i < s.length && (s[i] === " " || s[i] === "\n" || s[i] === "\r" || s[i] === "\t")) {
    i += 1;
  }
  if (i >= s.length) throw new Error("empty string");
  const start = i;
  const stack = [];
  let inString = false;
  let escape = false;
  for (; i < s.length; i += 1) {
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
      continue;
    }
    if (ch === "{" || ch === "[") {
      stack.push(ch);
    } else if (ch === "}" || ch === "]") {
      const expected = ch === "}" ? "{" : "[";
      if (stack.length === 0 || stack[stack.length - 1] !== expected) {
        throw new Error(`unexpected ${ch} at position ${i}`);
      }
      stack.pop();
      if (stack.length === 0) {
        const jsonStr = s.slice(start, i + 1);
        const value = JSON.parse(jsonStr);
        return { value, end: i + 1 };
      }
    }
  }
  throw new Error("unterminated JSON");
}

function main() {
  const stdin = readFileSync(0, "utf8").trim();
  if (!stdin) {
    fail("stdin", "no drain summary provided on stdin");
  }

  let drainJson;
  try {
    drainJson = JSON.parse(stdin);
  } catch {
    fail("parse drain summary", "drain summary is not valid JSON");
  }

  const drainId = drainJson.drain_id;
  if (!drainId || typeof drainId !== "string") {
    fail("drain_id", "drain summary missing drain_id field");
  }

  const root = runtimeRoot();
  const indexFile = join(root, "index.jsonl");

  let indexContent;
  try {
    indexContent = readFileSync(indexFile, "utf8");
  } catch (e) {
    fail("read index.jsonl", `index.jsonl not found or unreadable at ${indexFile}: ${e.message}`);
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
    fail("find lane entries", `no lane entries found in index.jsonl for drain_id=${drainId}`);
  }

  const tickEntries = laneEntries.filter((e) => e.lane);
  if (tickEntries.length === 0) {
    fail("find tick lane", `no tick lane entries found in index.jsonl for drain_id=${drainId}`);
  }

  const lastTick = tickEntries[tickEntries.length - 1];
  const journalFile = join(lastTick.run_dir, "journal.jsonl");

  let journalContent;
  try {
    journalContent = readFileSync(journalFile, "utf8");
  } catch (e) {
    fail("read journal.jsonl", `journal.jsonl not found or unreadable at ${journalFile}: ${e.message}`);
  }

  const journalLines = journalContent.trim().split("\n").filter(Boolean);
  const tickLines = journalLines.filter((line) => {
    try {
      const rec = JSON.parse(line);
      return rec.identity === "tick";
    } catch {
      return false;
    }
  });

  if (tickLines.length === 0) {
    fail("find tick journal entry", `no identity=="tick" entries in journal.jsonl at ${journalFile}`);
  }

  const lastTickLine = tickLines[tickLines.length - 1];
  let tickRecord;
  try {
    tickRecord = JSON.parse(lastTickLine);
  } catch {
    fail("parse tick journal", "tick journal entry is not valid JSON");
  }

  const result = tickRecord.result;
  if (!result || typeof result !== "string") {
    fail("result field", "tick journal entry has no result string");
  }

  let firstDoc;
  try {
    const parsed = parseFirstJsonDocument(result);
    firstDoc = parsed.value;
  } catch (e) {
    fail("parse first JSON document", `failed to parse first JSON document from result: ${e.message}`);
  }

  if (!firstDoc || typeof firstDoc !== "object") {
    fail("first JSON document", "first JSON document in result is not an object");
  }

  const termination = firstDoc.termination;
  if (!termination || typeof termination !== "object") {
    fail("termination", "first JSON document in result has no termination object");
  }

  process.stdout.write(JSON.stringify(termination));
  return 0;
}

process.exitCode = main();