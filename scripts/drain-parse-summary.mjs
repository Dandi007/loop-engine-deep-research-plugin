/**
 * E0c2 —— 从 drain stdout 逐行解析，取出含 drain_id 的 JSON 摘要行（GT-7）。
 *
 * 输入：stdin 传入 drain 的完整 stdout（多行）。
 * 输出：stdout 写入含 drain_id 的那一行 JSON（单行）。
 *
 * ⛔ 禁止花括号正则（GT-7）：逐行 JSON.parse，取能解析且含 drain_id 的那行。
 * 找不到可解析的摘要行 ⇒ exit 1。
 */
import { readFileSync } from "node:fs";

const stdin = readFileSync(0, "utf8").trim();
if (!stdin) {
  process.stderr.write("[drain-parse-summary] no drain stdout on stdin\n");
  process.exit(1);
}

for (const line of stdin.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  try {
    const obj = JSON.parse(trimmed);
    if (obj && typeof obj === "object" && typeof obj.drain_id === "string") {
      process.stdout.write(trimmed);
      process.exit(0);
    }
  } catch {
    // not a JSON line, skip
  }
}

process.stderr.write("[drain-parse-summary] no line with drain_id found in drain stdout\n");
process.exit(1);