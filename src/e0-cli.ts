/**
 * E0c —— e0-regression.sh 调用的 TS 小工具 CLI（经 vite-node 执行，Node 22 不能直接 import .ts）。
 *
 * 子命令（均为纯读/纯算，不触碰 .dev-dispatch/** 与 .dd-evidence/**）：
 *   ... sum-head-seq               读当前 AGENT_BUS_URL 生产/测试总线 sum(head_seq)，stdout 打整数。
 *   ... read-termination <index>   从 stdin 读 drain 摘要 JSON → index → journal → 最后一轮 tick 的
 *                                  termination.state；非 null 则 stdout 打印 state，null ⇒ 非零退出。
 *   ... seed-argv <channel> <clue> <source>…  打印 --seed 的 argv（带 sources 校验）。
 *
 * ⛔ 真 JSON 解析（GT-2 / GT-3），⛔ 禁止贪婪正则从单行 JSON 抽多值。
 */
import { readFileSync } from "node:fs";

/** 与 readTerminationState 的 readFile 签名匹配的封装。 */
function fsRead(path: string): string {
  return readFileSync(path, "utf8");
}
import { sumAllHeadSeqs } from "./bus";
import {
  readTerminationState,
  requireNonNullTermination,
  buildSeedArgv,
} from "./e0-regression";

async function main(argv: string[]): Promise<number> {
  const arg = argv[0];
  if (arg === "sum-head-seq") {
    const sum = await sumAllHeadSeqs();
    process.stdout.write(String(sum) + "\n");
    return 0;
  }
  if (arg === "read-termination") {
    const indexPath = argv[1];
    if (!indexPath) {
      process.stderr.write("E0c read-termination requires an index.jsonl path\n");
      return 2;
    }
    const raw = readFileSync(0, "utf8").trim();
    let summaryJson: unknown = raw;
    try {
      summaryJson = JSON.parse(raw);
    } catch {
      /* keep raw string; drainIdFromSummary will fail loudly */
    }
    const rec = readTerminationState({
      drainSummaryJson: summaryJson,
      indexPath,
      readFile: fsRead,
    });
    requireNonNullTermination(rec.state);
    process.stdout.write(JSON.stringify(rec.state) + "\n");
    return 0;
  }
  if (arg === "seed-argv") {
    const channelId = argv[1];
    const clueText = argv[2];
    const sources = argv.slice(3);
    const argvOut = buildSeedArgv(channelId, clueText, sources);
    process.stdout.write(argvOut.join("\n") + "\n");
    return 0;
  }
  process.stderr.write("unknown e0-cli subcommand: " + arg + "\n");
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
