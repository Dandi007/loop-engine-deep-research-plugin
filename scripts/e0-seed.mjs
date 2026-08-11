#!/usr/bin/env node
/**
 * E0 —— 空板自播种（§1.1 / 判据 5）。
 *
 * 新建的 TICK_CHANNEL 为空（head_seq === 0）时，把 research.clue.v2 种子线索投到板上，
 * 让现状链路有卡可认领、head_seq 可增长 ⇒ Z1（判据 8）在结构上可达。
 * ⛔ 幂等：仅当板为空才播种；已非空（head_seq > 0）则跳过，重复执行不使板面线索翻倍。
 * ⛔ head_seq 一律从 **列表端点** GET /v1/channels 真解析取值（复用 scripts/e0-metrics.mjs），
 *    ⛔ 不依赖 GET /v1/channels/<id> 返回 head_seq。
 *
 * 播种复用产品既有种子路径 bin/tick-entry.sh --seed（src/tick-seed 的 runSeed）：
 * 发布 research.clue.v2，每条 status=open、depth=0，idempotency key 由输入确定性派生。
 *
 * 用法：
 *   node e0-seed.mjs <baseUrl> <tokenPath> <tickChannel> --clue "<text>" [--clue "<text>" …]
 *   → stdout 单行 JSON：
 *       {channelId, seeded:true,  reason:"empty"}  已播种
 *       {channelId, seeded:false, reason:"non-empty", headSeq}  板非空，跳过（幂等）
 *   channel 不在列表 / 列表项无 head_seq ⇒ 响亮失败（exit 1，点名 channel 与字段集）。
 */
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { listChannels, headSeqFor } from "./e0-metrics.mjs";

function parseArgs(argv) {
  const [baseUrl, tokenPath, tickChannel, ...rest] = argv;
  if (!baseUrl || !tokenPath || !tickChannel) {
    throw new Error(
      "usage: node e0-seed.mjs <baseUrl> <tokenPath> <tickChannel> --clue <text> [--clue <text> …]",
    );
  }
  const clues = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--clue") {
      const text = rest[i + 1];
      if (text === undefined || text === "") {
        throw new Error("e0-seed: --clue requires a non-empty clue text");
      }
      clues.push(text);
      i += 1;
    }
  }
  if (clues.length === 0) {
    throw new Error("e0-seed: auto-seed requires at least one --clue. Refusing to seed zero clues.");
  }
  return { baseUrl, tokenPath, tickChannel, clues };
}

async function main() {
  const { baseUrl, tokenPath, tickChannel, clues } = parseArgs(process.argv.slice(2));
  const token = readFileSync(tokenPath, "utf8").trim();
  const channels = await listChannels(baseUrl, token);
  const { found, headSeq, fieldSet } = headSeqFor(channels, tickChannel);

  if (!found) {
    console.error(
      `[e0-seed] FAIL: channel '${tickChannel}' is absent from GET /v1/channels list on ${baseUrl}. ` +
        `Cannot determine whether the board is empty; refusing to seed blindly.`,
    );
    process.exit(1);
  }
  if (headSeq === null) {
    console.error(
      `[e0-seed] FAIL: channel '${tickChannel}' on ${baseUrl} exists but its list entry has no head_seq field. ` +
        `Actual field set=${JSON.stringify(fieldSet)}. Cannot determine emptiness; refusing to seed blindly.`,
    );
    process.exit(1);
  }
  if (headSeq > 0) {
    // 板非空：幂等跳过，绝不重复投（否则板面线索翻倍，判据 5 被违反）。
    process.stdout.write(
      `${JSON.stringify({ channelId: tickChannel, seeded: false, reason: "non-empty", headSeq })}\n`,
    );
    return;
  }

  const repoRoot = fileURLToPath(new URL("..", import.meta.url));
  const tickEntry = fileURLToPath(new URL("../bin/tick-entry.sh", import.meta.url));
  const clueArgs = clues.flatMap((c) => ["--clue", c]);
  const res = spawnSync("bash", [tickEntry, "--seed", tickChannel, ...clueArgs], {
    cwd: repoRoot,
    encoding: "utf8",
  });
  if (res.status !== 0) {
    console.error(
      `[e0-seed] FAIL: auto-seed publish via tick-entry failed (exit=${res.status}): ${res.stderr || res.stdout}`,
    );
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ channelId: tickChannel, seeded: true, reason: "empty" })}\n`);
}

main().catch((err) => {
  console.error(`[e0-seed] ${err.message}`);
  process.exit(1);
});
