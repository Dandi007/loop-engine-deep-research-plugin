import { describe, it, expect, vi, afterEach } from "vitest";
import {
  getMessages,
  getEntity,
  casUpdateClue,
  claimClue,
} from "../src/bus";

type FakeJson = () => Promise<unknown>;

interface FakeResponse {
  ok: boolean;
  status: number;
  json: FakeJson;
  text: FakeJson;
}

type FetchHandler = (url: string, init?: RequestInit) => Promise<FakeResponse>;

function jsonResponse(status: number, data: unknown): FakeResponse {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function stubFetch(handler: FetchHandler): void {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown, init?: RequestInit) => {
    return handler(String(url), init);
  }));
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

describe("D1/A1: conflict classification by numeric status", () => {
  it("A2: publish returns HTTP 200 whose body contains '409' → success", async () => {
    stubFetch(async () =>
      jsonResponse(200, { message_id: "msg_409abc", channel_seq: 6 }),
    );
    const result = await casUpdateClue(
      "research:test",
      "msg_001",
      openHead,
      { status: "in_flight", assignee: "w", run_id: "r" },
      "k1",
    );
    expect(result.success).toBe(true);
  });

  it("M1: non-409 failure with '409' in body is NOT classified as conflict", async () => {
    stubFetch(async () =>
      jsonResponse(500, { message: "server exploded mid-409-handshake" }),
    );
    await expect(
      casUpdateClue(
        "research:test",
        "msg_001",
        openHead,
        { status: "in_flight" },
        "k2",
      ),
    ).rejects.toThrow();
  });

  it("HTTP 409 → conflict", async () => {
    stubFetch(async () => jsonResponse(409, { message: "stale supersedes" }));
    const result = await casUpdateClue(
      "research:test",
      "msg_001",
      openHead,
      { status: "in_flight" },
      "k3",
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("conflict");
  });
});

describe("A9: 400/422 branch classified by numeric status", () => {
  it("HTTP 500 with '422' in body is NOT invalid_payload → rethrows", async () => {
    stubFetch(async () =>
      jsonResponse(500, { code: "SERVER_ERROR", message: "422-ish mess" }),
    );
    await expect(
      casUpdateClue(
        "research:test",
        "msg_001",
        openHead,
        { status: "in_flight" },
        "k9",
      ),
    ).rejects.toThrow();
  });

  it("HTTP 422 → invalid_payload", async () => {
    stubFetch(async () => jsonResponse(422, { code: "VALIDATION_ERROR" }));
    const result = await casUpdateClue(
      "research:test",
      "msg_001",
      openHead,
      { status: "in_flight" },
      "k10",
    );
    expect(result.success).toBe(false);
    expect(result.error).toBe("invalid_payload");
  });
});

describe("D2/A3: getEntity distinguishes 404 from read failure", () => {
  it("A3: HTTP 500 during getEntity → claimClue is NOT entity_not_found", async () => {
    stubFetch(async () => jsonResponse(500, { message: "bus down" }));
    await expect(
      claimClue("research:test", "msg_001", "w", "r", "k4"),
    ).rejects.toThrow();
  });

  it("true 404 → entity_not_found", async () => {
    stubFetch(async () => jsonResponse(404, { message: "not found" }));
    const result = await claimClue(
      "research:test",
      "missing",
      "w",
      "r",
      "k5",
    );
    expect(result).toEqual({ success: false, error: "entity_not_found" });
  });

  it("getEntity returns null for a genuine 404", async () => {
    stubFetch(async () => jsonResponse(404, { message: "not found" }));
    await expect(getEntity("missing")).resolves.toBeNull();
  });

  it("getEntity unwraps the entity head message", async () => {
    stubFetch(async () =>
      jsonResponse(200, { entity_id: "msg_001", root_kind: "research.clue.v2", head: openHead, revision_count: 1 }),
    );
    await expect(getEntity("msg_001")).resolves.toEqual(openHead);
  });
});

describe("D3/A4: afterSeq=0 is carried into the query string", () => {
  it("A4: getMessages(ch, {afterSeq:0}) sends after_seq=0", async () => {
    let captured: string | null = null;
    stubFetch(async (url) => {
      captured = url;
      return jsonResponse(200, { messages: [] });
    });
    await getMessages("research:test", { afterSeq: 0 });
    expect(captured).toContain("after_seq=0");
  });

  it("getMessages without afterSeq omits the param", async () => {
    let captured: string | null = null;
    stubFetch(async (url) => {
      captured = url;
      return jsonResponse(200, { messages: [] });
    });
    await getMessages("research:test");
    expect(captured).not.toContain("after_seq");
  });
});
