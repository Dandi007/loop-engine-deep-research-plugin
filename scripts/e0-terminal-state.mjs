#!/usr/bin/env node
/**
 * E0 —— 从 loop 输出里取 termination.state（判据 4 / §1.2）。
 *
 * ⛔ 凡是从 JSON 取值一律真解析（JSON.parse），⛔ 不用贪婪正则从 JSON 抽多值。
 * 输入：run.stdout.log（stdin）。loop 每个 tick 由 tick-entry --run 输出一行 JSON，
 *       其中的 termination.state 是本轮终态。本脚本取**最后一轮**带 termination 的 state。
 *
 * 输出（stdout）：终止状态字符串（如 "converged" / "partial" / "capped"），
 *                 若末轮 state 为 null 则输出字面量 "null"。
 * 退出码：0 = 找到带 termination 的 JSON；1 = loop 输出里没有 termination JSON（板面无终态证据）。
 */
let s = "";
process.stdin.on("data", (d) => (s += d));
process.stdin.on("end", () => {
  let lastState;
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
      "termination" in obj &&
      obj.termination &&
      typeof obj.termination === "object" &&
      "state" in obj.termination
    ) {
      lastState = obj.termination.state;
    }
  }
  if (lastState === undefined) {
    process.stderr.write("[e0-terminal-state] loop output contains no termination JSON; board has no terminal state\n");
    process.exit(1);
  }
  process.stdout.write(`${lastState}\n`);
  process.exit(0);
});
