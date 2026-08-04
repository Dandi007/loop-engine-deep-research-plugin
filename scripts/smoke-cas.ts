/**
 * 真机冒烟：CAS 认领原语在真实 agent-bus 上跑一遍。
 *
 * ⛔ 只应经 `npm run smoke:cas` 显式调用，一次 attempt 只跑一次。
 *    agent-bus append-only、无 DELETE，总写入量硬上限 3 条消息。
 *
 * 幂等键用固定确定性常量（不用 Date.now()）：重跑会命中 bus 侧去重，
 * 通道消息数不再增加——这是「不要反复运行」的唯一机械保障。
 */
import { describe, it, expect } from "vitest";
import { publishClue, claimClue } from "../src/bus";

const CHANNEL = "research:p02-smoke-1dce60";
const IDEMPOTENCY_KEY = "smoke-cas-hardening-02-1dce60-c461b0a1";
const ASSIGNEE = "dr-worker-smoke";
const RUN_ID = "run_smoke_cas_hardening_02";

interface PublishWithEntity extends Awaited<ReturnType<typeof publishClue>> {
  entity_id: string;
}

describe("smoke: CAS claim on real agent-bus", () => {
  it("publish → claim → conflict", async () => {
    // ① publish clue.v2（status=open），不传 entity_id，从响应读回
    const created = (await publishClue(
      CHANNEL,
      {
        text: "smoke clue for cas hardening",
        status: "open",
        depth: 0,
        sources: ["smoke"],
      },
      IDEMPOTENCY_KEY,
    )) as PublishWithEntity;

    const entityId = created.entity_id;
    console.log(
      `[smoke] ① publish message_id=${created.message_id} channel_seq=${created.channel_seq} entity_id=${entityId} deduplicated=${created.deduplicated ?? false}`,
    );

    // ② claimClue(entityId) → success
    const claimed = await claimClue(
      CHANNEL,
      entityId,
      ASSIGNEE,
      RUN_ID,
      `${IDEMPOTENCY_KEY}:claim`,
    );
    console.log(
      `[smoke] ② claim success=${claimed.success} messageId=${claimed.messageId ?? "n/a"} error=${claimed.error ?? "n/a"}`,
    );
    expect(claimed.success).toBe(true);

    // ③ 再次 claimClue 同一 entity → conflict（必须断言到 error 值）
    const conflict = await claimClue(
      CHANNEL,
      entityId,
      ASSIGNEE,
      RUN_ID,
      `${IDEMPOTENCY_KEY}:claim:2`,
    );
    console.log(
      `[smoke] ③ claim success=${conflict.success} messageId=${conflict.messageId ?? "n/a"} error=${conflict.error ?? "n/a"}`,
    );
    expect(conflict.success).toBe(false);
    expect(conflict.error).toBe("conflict");
  });
});