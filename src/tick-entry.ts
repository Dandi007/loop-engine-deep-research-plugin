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
  parseTerminationFromBody,
  runChannelWrite,
  type RunWriteOutcome,
} from "./tick-run";
import { runSeed, parseSeedCliArgs, SeedError } from "./tick-seed";

const USAGE = `deep-research tick entry

把 loop-engine 的周期 tick 接到本仓已交付的纯决策模块（src/tick）。

usage:
  ... --help                    打印本用法并 exit 0（无副作用）
  ... --selfcheck               在空板面上执行一次纯决策自检并 exit 0（无副作用）
  ... --inspect <channel_id>    只读 agent-bus channel，跑决策并打印 JSON，exit 0
  ... --seed <channel_id> --clue "<线索文本>" [--clue "<线索文本>" …] --source <name> [--source <name> …]
                     播种入口：把初始线索发布到研究板（research.clue.v2），exit 0
                     每条线索 status=open、depth=0；idempotency key 由输入确定性派生，
                     重复播种不会翻倍。channel 不存在 ⇒ 响亮失败并点名；零线索 ⇒ 响亮失败。
                     E0c1 §1.4 / GT-2：--source 必填且非空（真机：sources=[] 的 clue 会被结构性
                     卡为 blocked、派不出 worker）；缺失 ⇒ 响亮失败，⛔ 不静默播一条 sources:[] 的线索。
... --run <channel_id> [--max-writes <n>] [--evidence-channel <evidence_channel_id>] [--allowed-root <path>] [--content-spool-root <path>] [--question <研究主问题>] [--prev-coverage <n>] [--prev-zero-growth <n>] [--origin <research_origin>] [--doc-channel <doc_channel_id>] [--one-shot-dir <path>] [--max-clues <n>]
                      写侧：CAS + spawn + 收割 + triage 派发（reclaim/dispatch/block/harvest/triage），exit 0
                      E0c10 D5——--max-clues 板面 clue 上限，由 tick.md 从 {{max_clues}} 注入；缺省 64。
                              影响 harvest 封顶与 decideTermination 的 capHit 判定。
                      E1b D1/D2/D7——--content-spool-root content worker 的 spool 根目录（= content worker 的
                              allowed_root，D2：⛔ 不是 --allowed-root）。派发 content 线索前把 transcript body
                              落成 <spoolRoot>/<digest>.md（D1）。由 tick.md 从 {{content_spool_root}} 注入；
                              缺省 DEFAULT_CONTENT_SPOOL_ROOT（tmpdir 下兜底）。⛔ D7：不得落 vault 根 / .dev-dispatch/**。
                     G4b——--prev-coverage/--prev-zero-growth 由 tick.md 从 {{trigger_body}} 经
                             本入口 --parse-trigger-body 解析后传入，首轮无前值不传（runChannelWrite 缺省 0）；
                             JSON 输出含 termination（与 hasPendingWork 并列）。
                     G4c——--origin 与 --doc-channel 由 tick.md 从 {{research_origin}}/{{doc_channel}} 传入；
                             --origin 已配置且 termination.state !== null ⇒ runGenerate 被调用；
                             --one-shot-dir 跨进程一次性标记目录（缺省 tmpdir/deep-research-generated）。
... --parse-trigger-body <body_json>
                      G4b——把 trigger body 字符串解析成跨 tick 终止计数（attempt 2 评审 minor：
                      tick.md 原先用内嵌 node 脚本另写一份解析，与本 TS 解析器可静默发散；现改为
                      统一调用 parseTerminationFromBody，单源真相）。
                      输出（stdout，换行分隔）：首轮 body（{"seed":true}）⇒ 空串（调用方不传 --prev-*）；
                      续投 body（含 coverage/zeroGrowthRounds）⇒ "--prev-coverage\n<n>\n--prev-zero-growth\n<m>\n"。
                      body 缺失/损坏/续投 body 丢计数器 ⇒ stderr 点名 trigger_body/G4b 并 exit 1（不得静默回落 0/0）。

--help / --selfcheck 不 import ./bus、不发任何网络请求、不触碰 agent-bus / MinerU / vault。
--inspect 只读真实 agent-bus（仅 GET 分页），零写入，不触碰 MinerU / vault。
--run 对显式传入的 channel 执行 CAS 认领/回收 + spawn + 收割（接线判别）：先 CAS 成功才按 role spawn，
      spawn 同步失败当场 CAS 回 open；exited(0) 卡先收割（evidence + 新 clue）再 CAS 到 explored；
       --evidence-channel 显式传入（无默认值，缺失仅当有收割时才报错）；单次写入上限默认 DEFAULT_MAX_WRITES（--max-writes，A10c 起足以收割一张真实卡）；
       --allowed-root 显式传入 worker 可读 repo 根（code-local 必需，经 --add-dir 授予读，缺失则响亮失败）；
       --question 研究主问题（进入 triage 语料 question；缺省时遇 triage 决策即响亮失败）；
       --prev-coverage/--prev-zero-growth 上一 tick 的覆盖度/零增长轮数（跨 tick 终止计数，由续投 trigger body 承载）；
        拒绝写 v1 冻结 channel。
  JSON 输出含 hasPendingWork：板面是否仍有非终态 clue（proposed/open/in_flight），由板面确定性推出（A9）。
  JSON 输出含 termination：本轮终态判定（G4b，用本轮真实板面调用 decideTermination；coverage/zeroGrowthRounds 续投时写入下一条 trigger body）。
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

export async function main(argv: string[]): Promise<number> {
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
  if (arg === "--parse-trigger-body") {
    // G4b（attempt 2 评审 minor）—— trigger body 计数的**唯一权威解析器**入口：
    // tick.md 改为调用本子命令（而非内嵌一份 node 解析脚本），消除两份解析器的静默发散。
    // 失败 ⇒ stderr 点名 trigger_body/G4b 并 exit 1（parseTerminationFromBody 抛
    // TriggerBodyTerminationError，其消息文本已含 trigger_body/G4b 字样）。
    const body = argv[1];
    if (body === undefined) {
      process.stderr.write(
        "G4b: --parse-trigger-body requires a <body_json> argument. Refusing to silently fall back to 0/0.\n",
      );
      return 1;
    }
    try {
      const parsed = parseTerminationFromBody(body);
      // 首轮（seed body）⇒ 空输出，调用方据此不传 --prev-*（tick-entry --run 缺省 0 = 首轮语义）。
      // 续投 body ⇒ 输出换行分隔的 "--prev-coverage\n<n>\n--prev-zero-growth\n<m>\n"，
      // 调用方用 while read 逐行读取追加（zsh 兼容，避免 bash-only 的 read -a）。
      if (parsed.firstRound) {
        process.stdout.write("");
      } else {
        process.stdout.write(
          `--prev-coverage\n${parsed.prevCoverage}\n--prev-zero-growth\n${parsed.prevZeroGrowthRounds}\n`,
        );
      }
      return 0;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n`);
      return 1;
    }
  }
  if (arg === "--seed") {
    try {
      const opts = parseSeedCliArgs(argv.slice(1));
      const result = await runSeed(opts);
      process.stdout.write(JSON.stringify(result, null, 2) + "\n");
      return 0;
    } catch (err) {
      process.stderr.write(`${(err as Error).message}\n\n`);
      process.stderr.write(USAGE);
      return 2;
    }
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
