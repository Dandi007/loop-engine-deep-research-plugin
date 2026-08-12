/**
 * E0c1 §1.3 / 判据 6 —— `board:agent-runs` 名字单一真相源解析器。
 *
 * 供 bin/e0-regression.sh 经 vite-node 调起：从 src/run-channels.ts 的 `RUNS_CHANNEL_ID`
 * 常量把名字打到 stdout（不带末尾换行），让 bash 入口与 harvest/triage 读同一份真相源，
 * 而不是在脚本里再写一份字面量（spec §1.3：⛔ 不要再写一份字面量）。
 *
 * 读失败 ⇒ stderr 报错并 exit 1（入口据此响亮失败，⛔ 不回退任何字面量）。
 */
import { RUNS_CHANNEL_ID } from "./run-channels";

function main(): number {
  try {
    if (typeof RUNS_CHANNEL_ID !== "string" || RUNS_CHANNEL_ID.length === 0) {
      throw new Error(
        "RUNS_CHANNEL_ID resolved to a non-string or empty value; refusing to emit it.",
      );
    }
    process.stdout.write(RUNS_CHANNEL_ID);
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `E0c1: failed to resolve RUNS_CHANNEL_ID from src/run-channels.ts: ${msg}\n`,
    );
    return 1;
  }
}

process.exitCode = main();
