import { describe, it, expect, vi, afterEach } from "vitest";
import type { ClueV2 } from "../src/protocol";
import { casUpdateClue, claimClue, getMessages } from "../src/bus";

vi.mock("node:fs", () => ({
  readFileSync: () => "test-token",
}));

type StubRes = Partial<Response> & {
  status?: number;
  json?: () => Promise<unknown>;
  text?: () => Promise<string>;
};

function stubFetch(
  handler: (url: string, init?: RequestInit) => Promise<StubRes>,
): { url: string; init?: RequestInit }[] {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    async (url: any, init?: RequestInit): Promise<Response> => {
      calls.push({ url: String(url), init });
      const res = await handler(String(url), init);
      const status = res.status ?? 200;
      return {
        ok: status >= 200 && status < 300,
        status,
        json: res.json ?? (async () => ({})),
        text: res.text ?? (async () => ""),
      } as Response;
    },
  );
  return calls;
}

function headOpen(): {
  message_id: string;
  channel_id: string;
  channel_seq: number;
  kind: string;
  payload: ClueV2;
  entity_id: string;
  supersedes: string | null;
  created_at: string;
} {
  return {
    message_id: "msg_001",
    channel_id: "ch",
    channel_seq: 5,
    kind: "research.clue.v2",
    entity_id: "ent",
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
    payload: {
      text: "test clue",
      status: "open",
      depth: 0,
      sources: ["code-local"],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("claimClue / casUpdateClue (real src/bus.ts)", () => {
  it("A2: publish returns 200 with body containing 409 → success (no substring match)", async () => {
    stubFetch(async (url) => {
      if (url.includes("/publish")) {
        return {
          status: 200,
          json: async () => ({ message_id: "msg_409abc", channel_seq: 6 }),
        };
      }
      return { status: 404, json: async () => ({}) };
    });
    const head = headOpen();
    const result = await casUpdateClue(
      "ch",
      "ent",
      head,
      { status: "in_flight" },
      "key1",
    );
    expect(result.success).toBe(true);
    if (result.success) expect(result.messageId).toBe("msg_409abc");
  });

  it("A3: getEntity returns 500 → claimClue does NOT return entity_not_found", async () => {
    stubFetch(async () => ({ status: 500, json: async () => ({}) }));
    await expect(claimClue("ch", "ent", "dr", "run", "key2")).rejects.toThrow();
  });

  it("A4: getMessages({afterSeq:0}) sends after_seq=0", async () => {
    const calls = stubFetch(async () => ({
      status: 200,
      json: async () => ({ messages: [] }),
    }));
    await getMessages("ch", { afterSeq: 0 });
    expect(calls[0].url).toContain("after_seq=0");
  });

  it("A6: supersedes comes from the single head read (mutual exclusion, M4)", async () => {
    let entityReads = 0;
    const calls = stubFetch(async (url) => {
      if (url.includes("/entities/")) {
        entityReads += 1;
        // second read would expose a *different* head; a correct CAS must not
        // supersede on a fresh independent read (spec §4 A6 / §6 M4).
        const head = entityReads === 1 ? headOpen() : { ...headOpen(), message_id: "msg_003" };
        return { status: 200, json: async () => head };
      }
      if (url.includes("/publish")) {
        return {
          status: 200,
          json: async () => ({ message_id: "msg_002", channel_seq: 6 }),
        };
      }
      return { status: 404, json: async () => ({}) };
    });
    const result = await claimClue("ch", "ent", "dr", "run", "key3");
    expect(result.success).toBe(true);
    // mutual exclusion: claimClue must perform exactly one entity read
    expect(entityReads).toBe(1);
    const publishCall = calls.find((c) => c.url.includes("/publish"));
    expect(publishCall).toBeTruthy();
    const body = JSON.parse(publishCall!.init!.body as string);
    // supersedes must equal the message_id of the head from that single read
    expect(body.supersedes).toBe("msg_001");
  });

  it("D1: conflict classified by numeric status 409", async () => {
    stubFetch(async () => ({ status: 409, json: async () => ({}) }));
    const head = headOpen();
    const result = await casUpdateClue(
      "ch",
      "ent",
      head,
      { status: "in_flight" },
      "key4",
    );
    expect(result).toEqual({ success: false, error: "conflict" });
  });

  it("D1: invalid_payload classified by numeric 422", async () => {
    stubFetch(async () => ({ status: 422, json: async () => ({}) }));
    const head = headOpen();
    const result = await casUpdateClue(
      "ch",
      "ent",
      head,
      { status: "in_flight" },
      "key5",
    );
    expect(result).toEqual({ success: false, error: "invalid_payload" });
  });

  it("D2: claimClue on truly-missing entity (404) returns entity_not_found", async () => {
    stubFetch(async () => ({ status: 404, json: async () => ({}) }));
    const result = await claimClue("ch", "ent", "dr", "run", "key6");
    expect(result).toEqual({ success: false, error: "entity_not_found" });
  });
});