/**
 * 真机冒烟：CAS 认领原语 —— 仅在 gate 阶段人工执行一次（⛔ 不接进 acceptance_commands）。
 *
 * agent-bus 是 append-only、无 DELETE，任何写入都不可回退。
 * 本脚本总写入量硬上限 3 条消息；不得循环、不得批量写入、不得反复运行。
 *
 * 运行器：vitest（本仓 frozen 依赖集已有），脚本文件经 `smoke:cas` 单独调用，
 * 不会被 `npm test` 的默认 include 匹配到。
 */
import { describe, it } from "vitest";
import { publish, claimClue, getMessages } from "../src/bus";
import type { ClueV2 } from "../src/protocol";

const CHANNEL = "research:p02-smoke-1dce60";
const ENTITY = "smoke-1dce60";
const RUN = "smoke-run-1dce60";

// 固定幂等键：同一 channel/entity 上重复运行会走 idempotency 去重，
// 写不进新消息（agent-bus 无 DELETE，重复写入清不掉）。
const KEY_PUBLISH = "smoke-1dce60-step-1";
const KEY_CLAIM = "smoke-1dce60-step-2";
const KEY_CLAIM2 = "smoke-1dce60-step-3";

describe("smoke-cas", () => {
  it("CAS claim: publish → claim → conflict", async () => {
    const clue: ClueV2 = {
      text: "smoke clue",
      status: "open",
      depth: 0,
      sources: ["smoke"],
    };

    const first = await publish(CHANNEL, {
      kind: "research.clue.v2",
      payload: clue,
      idempotency_key: KEY_PUBLISH,
      entity_id: ENTITY,
    });
    console.log("① published:", first.message_id, "channel_seq=", first.channel_seq);

    const claim = await claimClue(CHANNEL, ENTITY, "smoke-worker", RUN, KEY_CLAIM);
    console.log("② claim:", JSON.stringify(claim));
    if (!claim.success) {
      throw new Error(`② claim should have succeeded, got ${JSON.stringify(claim)}`);
    }

    const second = await claimClue(CHANNEL, ENTITY, "smoke-worker", RUN, KEY_CLAIM2);
    console.log("③ re-claim:", JSON.stringify(second));
    if (second.success) {
      throw new Error("③ re-claim should have conflicted");
    }
    if (second.error !== "conflict") {
      throw new Error(`③ expected error === "conflict", got ${JSON.stringify(second)}`);
    }

    const messages = await getMessages(CHANNEL, { limit: 100 });
    for (const m of messages) {
      console.log(`message: ${m.message_id} channel_seq=${m.channel_seq}`);
    }
  });
});