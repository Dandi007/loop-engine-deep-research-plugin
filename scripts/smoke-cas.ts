/**
 * 真机冒烟：CAS 认领原语 —— 仅在 gate 阶段人工执行一次（⛔ 不接进 acceptance_commands）。
 *
 * agent-bus 是 append-only、无 DELETE，任何写入都不可回退。
 * 本脚本总写入量硬上限 3 条消息；不得循环、不得批量写入、不得反复运行。
 */
import { publish, claimClue, getMessages } from "../src/bus";
import type { ClueV2 } from "../src/protocol";

const CHANNEL = "research:p02-smoke-1dce60";
const ENTITY = "smoke-1dce60";
const RUN = "smoke-run-1dce60";

async function main(): Promise<void> {
  const clue: ClueV2 = {
    text: "smoke clue",
    status: "open",
    depth: 0,
    sources: ["smoke"],
  };

  const first = await publish(CHANNEL, {
    kind: "research.clue.v2",
    payload: clue,
    idempotency_key: `smoke-1-${Date.now()}`,
    entity_id: ENTITY,
  });
  console.log("① published:", first.message_id, "channel_seq=", first.channel_seq);

  const claim = await claimClue(CHANNEL, ENTITY, "smoke-worker", RUN, `smoke-claim-${Date.now()}`);
  console.log("② claim:", JSON.stringify(claim));
  if (!claim.success) {
    throw new Error("② claim should have succeeded");
  }

  const second = await claimClue(CHANNEL, ENTITY, "smoke-worker", RUN, `smoke-claim2-${Date.now()}`);
  console.log("③ re-claim:", JSON.stringify(second));
  if (second.success) {
    throw new Error("③ re-claim should have conflicted");
  }

  const messages = await getMessages(CHANNEL, { limit: 100 });
  for (const m of messages) {
    console.log(`message: ${m.message_id} channel_seq=${m.channel_seq}`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
