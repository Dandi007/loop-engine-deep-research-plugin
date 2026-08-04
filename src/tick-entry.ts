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
 */
import {
  decideTick,
  decideTermination,
  DEFAULT_TICK_CONFIG,
  type Decision,
  type TerminationState,
} from "./tick";

const USAGE = `deep-research tick entry

把 loop-engine 的周期 tick 接到本仓已交付的纯决策模块（src/tick）。

usage:
  ... --help       打印本用法并 exit 0（无副作用）
  ... --selfcheck  在空板面上执行一次纯决策自检并 exit 0（无副作用）

本入口不 import ./bus，不发起任何网络请求，不触碰真实 agent-bus / MinerU / vault。
真实启动（连 bus 跑完整 tick）属 V1，不在本包范围。
`;

interface SelfCheckOutput {
  ok: boolean;
  decisions: Decision[];
  termination: TerminationState;
}

function runSelfCheck(): SelfCheckOutput {
  const state = {
    cards: [],
    runs: {},
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

function main(argv: string[]): number {
  const arg = argv[0];
  if (arg === "--help" || arg === "-h" || arg === undefined) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (arg === "--selfcheck") {
    process.stdout.write(JSON.stringify(runSelfCheck(), null, 2) + "\n");
    return 0;
  }
  process.stderr.write(`unknown argument: ${arg}\n\n`);
  process.stderr.write(USAGE);
  return 2;
}

process.exitCode = main(process.argv.slice(2));
