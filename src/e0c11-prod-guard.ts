/**
 * E0c11 §1 —— 生产总线「本次运行零写入」身份判定入口
 * （供 bin/e0-regression.sh 经 vite-node 调起）。
 *
 * 取代 E0 §1.2 的「全量 sum(head_seq) 跑前 == 跑后」判据（GT-P1：该判据把
 * 「这段时间生产总线有没有人写」当成成败，而本机生产总线始终有别的开发线在写，
 * 所以它恒为失败——这是判据设计错了，不是被测系统的缺陷）。
 *
 * 新判据要证明的是：**本次回归运行没有往生产总线写任何东西**（GT-P2），
 * ⛔ 不是「生产总线在这段时间里静止」。可行做法（spec §1，组合实现）：
 *   - 按 run 身份过滤：跑后读生产总线 `board:agent-runs` 上本次运行可能写到的 channel，
 *     断言其中没有任何一条消息属于本次运行（`payload.run_id === runId` 即算违规）；
 *   - 按 channel 存在性：本 run 派生的 research channel 名在生产总线上不得存在。
 *
 * ⛔ 不得把守卫删掉或降级成警告：本次运行真的写了生产总线 ⇒ 非零退出并点名
 *    是哪条 channel / 哪条消息（GT-P2）。
 * ⛔ 不得改成只比对某个固定 channel 的绝对值。
 *
 * 运行记录里仍保留跑前/跑后的生产总线 sum(head_seq) 读数（供人工复盘），
 * 但**判定不再依赖两者相等**（由 bin/e0-regression.sh 继续 `readProdBusHeadSeqSum`）。
 *
 * 用法：
 *   node_modules/.bin/vite-node src/e0c11-prod-guard.ts \
 *     --run-id <runId> --runs-channel <board:agent-runs> \
 *     --run-channel <derived1> --run-channel <derived2> ...
 *
 * 环境变量（与 e0c1-prod-read.ts 同源，独立于 AGENT_BUS_URL）：
 *   E0C1_PROD_BUS_URL（缺省 http://127.0.0.1:7490）
 *   E0C1_PROD_BUS_TOKEN_FILE（缺省 /data/agent-bus/tokens/uther-tui.token）
 *
 * 输出：stdout 写入 JSON `{ wrote, existingRunChannels, offenders }`（无末尾换行）。
 *   - wrote === true ⇒ 本次运行往生产总线写了；入口据此 exit 3 并点名。
 *   - wrote === false ⇒ 放行（不因此失败）。
 * 读失败 ⇒ stderr 报错并 exit 1（入口据此判「读失败即失败」，⛔ 不得跳过检查）。
 */
import { readProdBusRunWriteVerdict } from "./bus";

function parseArgs(argv: string[]): {
  runId: string;
  runsChannel: string;
  runChannels: string[];
} {
  let runId = "";
  let runsChannel = "";
  const runChannels: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--run-id") {
      runId = argv[++i] ?? "";
    } else if (a === "--runs-channel") {
      runsChannel = argv[++i] ?? "";
    } else if (a === "--run-channel") {
      const v = argv[++i];
      if (typeof v === "string" && v.length > 0) runChannels.push(v);
    }
  }
  return { runId, runsChannel, runChannels };
}

async function main(): Promise<number> {
  const { runId, runsChannel, runChannels } = parseArgs(process.argv.slice(2));
  if (!runId) {
    process.stderr.write(
      "E0c11: production-bus identity guard requires --run-id <runId> (spec §1: judge by THIS run's identity, not the whole bus).\n",
    );
    return 1;
  }
  if (!runsChannel) {
    process.stderr.write(
      "E0c11: production-bus identity guard requires --runs-channel <board:agent-runs> (spec §1: the run-identity channel to scan).\n",
    );
    return 1;
  }
  try {
    const verdict = await readProdBusRunWriteVerdict({
      runId,
      runsChannelId: runsChannel,
      runChannelIds: new Set(runChannels),
    });
    process.stdout.write(JSON.stringify(verdict));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `E0c11: production-bus identity guard read failed: ${msg}\n`,
    );
    return 1;
  }
}

process.exitCode = await main();
