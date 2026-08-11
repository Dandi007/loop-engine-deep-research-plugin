#!/usr/bin/env node
/**
 * E0 —— 从 loop 输出里判定板面是否到达终态（判据 4 / §1.2）。
 *
 * ⛔ 凡是从 JSON 取值一律真解析（JSON.parse），⛔ 不用贪婪正则从 JSON 抽多值。
 *
 * 输入：run.stdout.log（stdin）—— 即 bin/deep-research-loop.sh 的完整 stdout。
 * ⛔ 该文件**不是** tick 级 termination 的载体：真实驱动（bin/deep-research-loop.sh）的 stdout
 *    只含 loop-store put 输出、"[deep-research-loop] mode=… run_root=…" 行，以及
 *    `cat "$DRAIN_TMP"` 发出的 **drain 摘要**（loop-engine drain 输出的单个 JSON 对象）。
 *    tick 节点里的 run_output（含 termination.state）被 loop-engine 收进
 *    <run_dir>/journal.jsonl，**不会**落到 run.stdout.log。
 *    因此这里不读 termination.state，而是解析真实驱动确实发出的 **drain 摘要**：
 *       {"reason":"drained","rounds":1}
 *       {"reason":"drained","rounds":0,"ticksByLabel":{"tick":0}}
 *       {"reason":"max_rounds","rounds":16,"ticksByLabel":{"tick":16}}
 *
 * 判定：
 *   - run.stdout.log 里没有 drain 摘要（reason+rounds 的 JSON 对象）⇒ exit 1（板面无终态证据）。
 *   - 有 drain 摘要但 rounds === 0（空板，loop 没跑任何一轮）⇒ 输出字面量 "null"（板面无终态），exit 0。
 *   - rounds >= 1 ⇒ 输出 reason（如 "drained"），exit 0。
 *
 * 输出（stdout）：终态字符串；"null" 表示板面无终态。
 * 退出码：0 = 找到 drain 摘要；1 = 没有 drain 摘要（板面无终态证据）。
 */
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
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
      // 取最后一个（drain 摘要是驱动的最后一个 JSON 行）。
      drain = obj;
    }
  }
  if (!drain) {
    process.stderr.write(
      "[e0-terminal-state] loop output contains no drain summary (reason+rounds JSON); board has no terminal state\n",
    );
    process.exit(1);
  }
  if (drain.rounds < 1) {
    process.stdout.write("null\n");
    process.exit(0);
  }
  process.stdout.write(`${drain.reason}\n`);
  process.exit(0);
});
