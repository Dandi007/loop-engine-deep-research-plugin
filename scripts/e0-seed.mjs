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
 *   node e0-seed.mjs <baseUrl> <tokenPath> <tickChannel> --clue "<text>" [--clue "<text>" …] [--source <name> …]
 *   ⛔ --source 决定种子线索的可派发性（spec §1.2）：不带任何 source 的种子卡 status=open 但
 *      sources=[] ⇒ decideTick 无法映射到任何 worker role ⇒ 结构上只能 block，单 tick 即终态、
 *      termination.state 恒 null ⇒ Z1（判据 8）在构造上不可达。e0-regression 播种必须带
 *      --source code-local（profile 已配 ALLOWED_ROOT 供该 code-local worker 派发），
 *      使种子卡可被 dispatch → 收割 → 覆盖 → 终态。--source 逐条原样转发给 tick-entry --seed。
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
      "usage: node e0-seed.mjs <baseUrl> <tokenPath> <tickChannel> --clue <text> [--clue <text> …] [--source <name> …]",
    );
  }
  const clues = [];
  const sources = [];
  for (let i = 0; i < rest.length; i += 1) {
    if (rest[i] === "--clue") {
      const text = rest[i + 1];
      if (text === undefined || text === "") {
        throw new Error("e0-seed: --clue requires a non-empty clue text");
      }
      clues.push(text);
      i += 1;
    } else if (rest[i] === "--source") {
      const name = rest[i + 1];
      if (name === undefined || name === "") {
        throw new Error("e0-seed: --source requires a non-empty source name");
      }
      sources.push(name);
      i += 1;
    }
  }
  if (clues.length === 0) {
    throw new Error("e0-seed: auto-seed requires at least one --clue. Refusing to seed zero clues.");
  }
  return { baseUrl, tokenPath, tickChannel, clues, sources };
}

async function main() {
  const { baseUrl, tokenPath, tickChannel, clues, sources } = parseArgs(process.argv.slice(2));
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
  // attempt 5 评审 blocker/major —— 把 --source 原样转发给 tick-entry --seed：
  //   不带 source 的种子卡 sources=[] ⇒ 结构上只能 block ⇒ 单 tick 终态、termination.state 恒 null，
  //   Z1（判据 8）在构造上不可达。e0-regression 传 --source code-local 使种子卡可 dispatch → 终态可达。
  const sourceArgs = sources.flatMap((s) => ["--source", s]);
  // attempt 2 评审 minor —— 发布步必须与判空步用**同一个 bus**：
  // tick-entry --seed 经 src/bus.ts 从 AGENT_BUS_URL / AGENT_BUS_TOKEN_FILE 解析总线；
  // 若只靠调用方传入的 baseUrl/tokenPath 判空、却把发布交给继承的环境，两者可能各指一个 bus
  // （一个查 A 板空、一个写 B 板 append-only）。这里把**已解析**的 baseUrl/tokenPath 显式塞进
  // 子进程 env，消除这份耦合。
  const res = spawnSync("bash", [tickEntry, "--seed", tickChannel, ...clueArgs, ...sourceArgs], {
    cwd: repoRoot,
    encoding: "utf8",
    env: {
      ...process.env,
      AGENT_BUS_URL: baseUrl,
      AGENT_BUS_TOKEN_FILE: tokenPath,
    },
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
