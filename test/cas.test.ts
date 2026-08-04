import { describe, it, expect, vi, afterEach } from "vitest";
import { claimClue, casUpdateClue } from "../src/bus";

/**
 * CAS 互斥的充要条件（来自 findings.md CAS 节）
 *
 * 不变量：CAS 要成为互斥原语，前置条件必须在「你所 supersede 的那一版」上求值。
 * 同源读 ⇒ 互斥成立（读写之间有人抢到 → head 推进 → supersedes 过期 → 409）；
 * 分属两次读 ⇒ CAS 退化成纯粹的防丢失更新。
 *
 * 所有用例都通过真实调用路径进入 src/bus.ts 的 claimClue / casUpdateClue，
 * 用打桩的全局 fetch 构造场景，不在此处重写任何产品逻辑副本。
 */

type FakeJson = () => Promise<unknown>;

interface FakeResponse {
  ok: boolean;
  status: number;
  json: FakeJson;
  text: FakeJson;
}

function jsonResponse(status: number, data: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

const openHead = {
  message_id: "msg_001",
  channel_id: "research:test",
  channel_seq: 5,
  kind: "research.clue.v2",
  payload: { status: "open", text: "t", depth: 0, sources: [] },
  entity_id: "msg_001",
  supersedes: null,
  created_at: "2026-01-01T00:00:00Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("CAS claim against src/bus.ts", () => {
  it("A6: same-source read — supersedes equals the first read's message_id", async () => {
    const publishBodies: Array<Record<string, unknown>> = [];
    let entityReads = 0;
    // 第二次独立读返回一个「更先进」的 head（不同 message_id）。
    // 若 casUpdateClue 的 supersedes 改成来自第二次独立读（M4），
    // 这里就会读到 advancedHead → supersedes === "msg_002" → 断言失败。
    const advancedHead = {
      ...openHead,
      message_id: "msg_002",
      channel_seq: 6,
      payload: { ...openHead.payload, status: "open" },
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          entityReads += 1;
          return jsonResponse(200, { head: entityReads === 1 ? openHead : advancedHead });
        }
        if (u.includes("/publish")) {
          publishBodies.push(JSON.parse(String(init?.body)));
          return jsonResponse(200, { message_id: "msg_003", channel_seq: 7 });
        }
        return jsonResponse(404, { message: "unexpected" });
      }),
    );

    const result = await claimClue(
      "research:test",
      "msg_001",
      "w-1",
      "run_002",
      "claim-key",
    );

    expect(result.success).toBe(true);
    expect(publishBodies).toHaveLength(1);
    const publish = publishBodies[0];
    // 前置条件与 supersedes 出自同一次读：supersedes 必须等于第一次读到的 head.message_id，
    // 且绝不得等于第二次独立读的 advancedHead.message_id。
    expect(publish.supersedes).toBe(openHead.message_id);
    expect(publish.supersedes).not.toBe(advancedHead.message_id);
    expect(publish.entity_id).toBe("msg_001");
    expect((publish.payload as Record<string, unknown>).status).toBe("in_flight");
    expect((publish.payload as Record<string, unknown>).assignee).toBe("w-1");
    expect((publish.payload as Record<string, unknown>).run_id).toBe("run_002");
    // 正确实现只读一次 head；若发生第二次独立读（M4），entityReads === 2 → 失败。
    expect(entityReads).toBe(1);
  });

  it("CAS success returns messageId from the bus", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse(200, { head: openHead });
        }
        return jsonResponse(200, { message_id: "msg_002", channel_seq: 6 });
      }),
    );

    const result = await claimClue(
      "research:test",
      "msg_001",
      "w-1",
      "run_002",
      "claim-key-2",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.messageId).toBe("msg_002");
    }
  });

  it("CAS 409: head already in_flight → conflict, no publish", async () => {
    const inFlightHead = {
      ...openHead,
      message_id: "msg_002",
      payload: {
        status: "in_flight",
        text: "t",
        depth: 0,
        sources: [],
        assignee: "other",
        run_id: "run_001",
      },
    };
    let publishCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse(200, { head: inFlightHead });
        }
        if (u.includes("/publish")) {
          publishCalled = true;
          return jsonResponse(200, { message_id: "msg_003", channel_seq: 7 });
        }
        return jsonResponse(404, { message: "unexpected" });
      }),
    );

    const result = await claimClue(
      "research:test",
      "msg_001",
      "w-1",
      "run_003",
      "claim-key-3",
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("conflict");
    expect(publishCalled).toBe(false);
  });

  it("CAS 409: bus returns numeric 409 on stale supersedes → conflict", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse(200, { head: openHead });
        }
        return jsonResponse(409, { message: "stale supersedes" });
      }),
    );

    const result = await casUpdateClue(
      "research:test",
      "msg_001",
      openHead,
      { status: "in_flight", assignee: "w-1", run_id: "run_004" },
      "claim-key-4",
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("conflict");
  });

  it("entity not found → entity_not_found", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => jsonResponse(404, { message: "not found" })),
    );

    const result = await claimClue(
      "research:test",
      "missing",
      "w-1",
      "run_005",
      "claim-key-5",
    );

    expect(result).toEqual({ success: false, error: "entity_not_found" });
  });
});