/**
 * E0c2 §1.3 —— 跨 drain 进度行的「板面 head_seq」读数入口（供 bin/e0-regression.sh 经 vite-node 调起）。
 *
 * 评审 blocker 修复（attempt 2 final REJECT）：原 bin/e0-regression.sh:_read_tick_head_seq 从
 *   单 channel GET 端点（`GET /v1/channels/<id>`）读 `o.head_seq`，但本仓自己的实测地面真相
 *   （src/bus.ts GT-1：单 channel GET 的字段集为 channel_id/closed_at/created_at/...
 *    ← ⛔ 没有 head_seq；`head_seq` 只在列表端点 `GET /v1/channels`）明确否定该形状。
 *   结果：真机每一轮的进度行恒为 `tick_head_seq=N/A`，drain-attempts.jsonl 每条恒记
 *   "tick_head_seq":"N/A"，§1.3 明列的这一项交付内容永远拿不到。
 *
 * 本入口复用 src/bus.ts 的 `getChannelHeadSeq`（**列表端点**单一真相源）取真实 head_seq，
 * 不在 bash 侧另写一份单 channel GET 取值（那正是 §0「为真实产物里不存在的字段发明契约、
 * 再靠 fixture 满足它」的 blocker 形状）。
 *
 * 读模块级 `BASE_URL`（受 `AGENT_BUS_URL` 覆盖，与入口其余 bus 调用同一实例）。
 * 读失败 ⇒ stderr 报错并以非零退出（入口据此判该轮 head_seq 读失败）。
 *
 * 用法：`vite-node src/e0c2-read-tick-head-seq.ts <channel_id>`
 *   stdout：head_seq 的十进制字符串（如 "3"）。
 *   找不到 channel / 列表端点不含该 channel ⇒ 非 0 退出（⛔ 不静默退化为 N/A）。
 */
import { getChannelHeadSeq } from "./bus";

async function main(): Promise<number> {
  const channelId = process.argv[2];
  if (!channelId) {
    process.stderr.write(
      "E0c2: read-tick-head-seq requires a channel_id argument (usage: vite-node src/e0c2-read-tick-head-seq.ts <channel_id>)\n",
    );
    return 3;
  }
  try {
    const headSeq = await getChannelHeadSeq(channelId);
    process.stdout.write(String(headSeq));
    return 0;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(
      `E0c2: failed to read head_seq for channel "${channelId}" from the list endpoint: ${msg}\n`,
    );
    return 1;
  }
}

process.exitCode = await main();
