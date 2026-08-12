/**
 * E0c2 —— 读板面 head_seq（复用 E0c1 已交付的列表端点实现，GT-8）。
 * 用法：vite-node src/e0c2-read-head-seq.ts <channel_id>
 * 输出：head_seq 数值到 stdout；失败 ⇒ 非零退出 + stderr 点名。
 */
import { getChannelHeadSeq } from "./bus";

const channelId = process.argv[2];
if (!channelId) {
  process.stderr.write("e0c2-read-head-seq: missing <channel_id> argument\n");
  process.exit(1);
}

getChannelHeadSeq(channelId)
  .then((v) => {
    process.stdout.write(String(v));
    process.exit(0);
  })
  .catch((e) => {
    process.stderr.write(`e0c2-read-head-seq: ${(e as Error).message}\n`);
    process.exit(1);
  });