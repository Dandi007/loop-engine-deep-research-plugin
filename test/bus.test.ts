import { describe, it, expect, vi, afterEach } from "vitest";
import { getMessages, getEntity, casUpdateClue } from "../src/bus";

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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bus D1–D3 hardening", () => {
  it("A1: a non-409 failure whose body contains \"409\" is NOT classified as conflict (M1)", async () => {
    stubFetch(async () => ({
      status: 422,
      text: async () => "bus POST /x: 422 request body contains 409 in the payload",
      json: async () => ({}),
    }));
    const result = await casUpdateClue(
      "ch",
      "ent",
      {
        message_id: "m1",
        channel_id: "ch",
        channel_seq: 1,
        kind: "research.clue.v2",
        entity_id: "ent",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
        payload: { status: "open", depth: 0, sources: [] },
      },
      { status: "in_flight" },
      "k",
    );
    // classification must come from the numeric status (422), not the body
    // text (which happens to contain "409"). A reverted msg.includes("409")
    // implementation would return { error: "conflict" } here and fail.
    expect(result).toEqual({ success: false, error: "invalid_payload" });
  });

  it("A3: getEntity rethrows on 500 (read failure is not null)", async () => {
    stubFetch(async () => ({ status: 500, json: async () => ({}) }));
    await expect(getEntity("ent")).rejects.toThrow();
  });

  it("D2: getEntity returns null only on 404 (truly missing)", async () => {
    stubFetch(async () => ({ status: 404, json: async () => ({}) }));
    await expect(getEntity("ent")).resolves.toBeNull();
  });

  it("A4: afterSeq=0 is preserved in the query string", async () => {
    const calls = stubFetch(async () => ({
      status: 200,
      json: async () => ({ messages: [] }),
    }));
    await getMessages("ch", { afterSeq: 0 });
    expect(calls[0].url).toContain("after_seq=0");
    expect(calls[0].url).not.toContain("after_seq=100");
  });

  it("D3: afterSeq undefined keeps default limit without after_seq", async () => {
    const calls = stubFetch(async () => ({
      status: 200,
      json: async () => ({ messages: [] }),
    }));
    await getMessages("ch", {});
    expect(calls[0].url).not.toContain("after_seq");
    expect(calls[0].url).toContain("limit=100");
  });
});