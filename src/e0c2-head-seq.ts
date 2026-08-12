/**
 * E0c2 §1.3 —— 板面 head_seq 读数入口（供 bin/e0-regression.sh 经 vite-node 调起）。
 *
 * 复用 E0c1 已交付的列表端点读法（src/bus.ts 的 listChannelsAt），
 * 按 channel_id 从列表端点定位 head_seq（GT-8：单 channel GET 不含 head_seq）。
 *
 * 用法：
 *   node_modules/.bin/vite-node src/e0c2-head-seq.ts <channel_id>
 *
 * 环境变量：
 *   AGENT_BUS_URL —— 测试总线 URL（缺省 http://127.0.0.1:7495）
 *   AGENT_BUS_TOKEN_FILE —— token 路径（缺省 /data/agent-bus-test/tokens/uther-tui.token）
 *
 * 输出：stdout 写入 head_seq 数字（无换行）。
 * 读失败 ⇒ stderr 报错并 exit 1。
 */
import { listChannelsAt } from "./bus";

async function main(): Promise<number> {
  const channelId = process.argv[2];
  if (!channelId) {
    process.stderr.write("E0c2: head_seq read requires a channel_id argument\n");
    return 1;
  }

  const baseUrl = process.env.AGENT_BUS_URL ?? "http://127.0.0.1:7495";
  const tokenPath =
    process.env.AGENT_BUS_TOKEN_FILE ??
    "/data/agent-bus-test/tokens/uther-tui.token";

  try {
    const channels = await listChannelsAt(baseUrl, tokenPath);
    const found = channels.find((c) => c.channel_id === channelId);
    if (!found) {
      process.stderr.write(
        `E0c2: channel "${channelId}" not found on list endpoint at ${baseUrl}\n`,
      );
      return 1;
    }
    process.stdout.write(String(found.head_seq));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `E0c2: head_seq read failed for channel "${channelId}" at ${baseUrl}: ${msg}\n`,
    );
    return 1;
  }
}

process.exitCode = await main();