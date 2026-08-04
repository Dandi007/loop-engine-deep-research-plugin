/**
 * A7 —— tick 可执行入口（CLI）
 *
 * 把 src/tick 的纯决策逻辑封装成可在 bash harness 里调起的入口。
 * ⛔ 不 import ./bus；本包只证明「接线存在且能解析」，不跑真实 tick（V1）。
 *
 * 本入口只复用 src/tick 已交付的纯函数（decideTick / decideTermination /
 * DEFAULT_TICK_CONFIG），不重新实现任何决策逻辑（spec G9）。
 *
 * 无副作用调用：
 *   --help       打印用法并 exit 0，不发网络、不写 store、不触 bus（G6/G7）。
 *   --selfcheck  在空板面上跑一次纯决策自检并 exit 0，不发网络、不触 bus（G6/G7）。
 *
 * A8a 只读模式：
 *   --inspect <channel_id>  只读真实 agent-bus channel → 决策 → 打印 JSON → exit 0。
 *                           ⛔ 全程只发 GET，零写入，不触碰 MinerU / vault（spec §2）。
 */
import {
  decideTick,
  decideTermination,
  DEFAULT_TICK_CONFIG,
  type Decision,
  type RunEvent,
  type TerminationState,
} from "./tick";
import { runInspect } from "./tick-inspect";
import {
  parseRunCliArgs,
  runChannelWrite,
  type RunWriteOutcome,
} from "./tick-run";

const USAGE = `deep-research tick entry

把 loop-engine 的周期 tick 接到本仓已交付的纯决策模块（src/tick）。

usage:
  ... --help                    打印本用法并 exit 0（无副作用）
  ... --selfcheck               在空板面上执行一次纯决策自检并 exit 0（无副作用）
  ... --inspect <channel_id>    只读 agent-bus channel，跑决策并打印 JSON，exit 0
  ... --run <channel_id> [--max-writes <n>]  写侧：CAS + spawn（reclaim/dispatch/block），exit 0

--help / --selfcheck 不 import ./bus、不发任何网络请求、不触碰 agent-bus / MinerU / vault。
--inspect 只读真实 agent-bus（仅 GET 分页），零写入，不触碰 MinerU / vault。
--run 对显式传入的 channel 执行 CAS 认领/回收 + spawn（接线判别）：先 CAS 成功才按 role spawn，
     spawn 同步失败当场 CAS 回 open；单次写入上限默认 5（--max-writes）；拒绝写 v1 冻结 channel。
`;

interface SelfCheckOutput {
  ok: boolean;
  decisions: Decision[];
  termination: TerminationState;
}

function runSelfCheck(): SelfCheckOutput {
  // 空板面自检：用无字面量的空 runs（A8b M6 要求生产路径不得硬编码空的 runs 字面量）。
  const emptyRuns: Record<string, RunEvent> = Object.create(null);
  const state = {
    cards: [],
    runs: emptyRuns,
    triageInFlight: false,
  };
  const decisions = decideTick(state, DEFAULT_TICK_CONFIG);
  const termination = decideTermination(
    {
      cards: [],
      coveredClueIds: [],
      prevCoverage: 0,
      prevZeroGrowthRounds: 0,
    },
    DEFAULT_TICK_CONFIG,
  );
  return { ok: true, decisions, termination };
}

async function main(argv: string[]): Promise<number> {
  const arg = argv[0];
  if (arg === "--help" || arg === "-h" || arg === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (arg === "--selfcheck") {
    process.stdout.write(JSON.stringify(runSelfCheck(), null, 2) + "\n");
    return 0;
  }
  if (arg === "--inspect") {
    const channelId = argv[1];
    if (!channelId) {
      process.stderr.write("--inspect requires a <channel_id>\n\n");
      process.stderr.write(USAGE);
      return 2;
    }
    return await runInspect(channelId);
  }
  if (arg === "--run") {
    try {
      const opts = parseRunCliArgs(argv.slice(1));
      const outcome = await runChannelWrite(opts);
      process.stdout.write(JSON.stringify(outcome, null, 2) + "\n");
      return 0;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n\n`);
      process.stderr.write(USAGE);
      return 2;
    }
  }
  process.stderr.write(`unknown argument: ${arg}\n\n`);
  process.stderr.write(USAGE);
  return 2;
}

process.exitCode = await main(process.argv.slice(2));
