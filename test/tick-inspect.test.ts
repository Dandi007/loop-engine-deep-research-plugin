/**
 * A8a —— tick --inspect 只读模式硬验收测试（spec §4 H1–H7 / H10）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举（spec §5.1 第 2 条）。
 * H1/H2/H4 直接喂消息数组对纯数据求值（spec §5.1 第 4 条），
 * 断言作用域收窄到组装结果的字段（spec §5.1 第 5 条）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  assembleBoard,
  computeInspect,
  readChannelMessages,
  runInspect,
  type InspectMessage,
} from "../src/tick-inspect";

const ROOT = dirname(fileURLToPath(import.meta.url));

type Payload = Record<string, unknown>;

function clueMsg(
  seq: number,
  entityId: string,
  payload: Payload,
): InspectMessage {
  return {
    message_id: `m${seq}`,
    channel_id: "research:test",
    channel_seq: seq,
    kind: "research.clue.v2",
    payload,
    entity_id: entityId,
    supersedes: null,
    created_at: "",
  };
}

function evMsg(seq: number, clueId: string): InspectMessage {
  return {
    message_id: `e${seq}`,
    channel_id: "research:test",
    channel_seq: seq,
    kind: "research.evidence.v2",
    payload: { clue_id: clueId },
    entity_id: `e${seq}`,
    supersedes: null,
    created_at: "",
  };
}

function v1Msg(seq: number, kind: string): InspectMessage {
  return {
    message_id: `v${seq}`,
    channel_id: "research:test",
    channel_seq: seq,
    kind,
    payload: {},
    entity_id: `v${seq}`,
    supersedes: null,
    created_at: "",
  };
}

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function stubFetch(handler: (url: string) => ReturnType<typeof jsonResponse> | Promise<ReturnType<typeof jsonResponse>>): void {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => handler(String(url))));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("H1: version chain taken by head", () => {
  it("same entity_id 3 revisions (open/in_flight/explored) → 1 card, status=explored", () => {
    const msgs = [
      clueMsg(1, "e1", { status: "open", depth: 0, sources: [] }),
      clueMsg(2, "e1", { status: "in_flight", depth: 0, sources: [] }),
      clueMsg(3, "e1", { status: "explored", depth: 0, sources: [] }),
    ];
    const a = assembleBoard(msgs, {});
    expect(a.cards).toHaveLength(1);
    expect(a.clueEntities).toBe(1);
    expect(a.cards[0].status).toBe("explored");
  });
});

describe("H2: v1 messages explicitly skipped and counted", () => {
  it("mixed v1×2 + v2×1 → skippedV1=2 and board holds only the v2 card", () => {
    const msgs = [
      v1Msg(1, "research.clue.v1"),
      v1Msg(2, "research.finding.v1"),
      clueMsg(3, "e2", { status: "open", depth: 0, sources: [] }),
    ];
    const a = assembleBoard(msgs, {});
    expect(a.skippedV1).toBe(2);
    expect(a.cards).toHaveLength(1);
    expect(a.cards[0].clueId).toBe("e2");
  });
});

describe("H3: paginated read until empty", () => {
  it("pages 100/20/0 → 3 reads, 2nd and 3rd URLs carry after_seq", async () => {
    const calls: string[] = [];
    const page = (n: number, start: number): InspectMessage[] =>
      Array.from({ length: n }, (_, i) =>
        clueMsg(start + i, `e${start + i}`, { status: "open", depth: 0, sources: [] }));
    const pages: InspectMessage[][] = [page(100, 1), page(20, 101), []];
    let idx = 0;
    stubFetch((url) => {
      calls.push(url);
      const cur = pages[Math.min(idx, pages.length - 1)];
      if (idx < pages.length - 1) idx += 1;
      return jsonResponse({ messages: cur });
    });
    const msgs = await readChannelMessages("research:test");
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("after_seq=");
    expect(calls[2]).toContain("after_seq=");
    expect(msgs).toHaveLength(120);
  });
});

describe("H4: coverage is unique clue_id set size", () => {
  it("two evidence with the same clue_id → coverage 1", () => {
    const msgs = [evMsg(1, "c1"), evMsg(2, "c1")];
    const a = assembleBoard(msgs, {});
    expect(a.coveredClueIds).toEqual(["c1"]);
    expect(a.coverage).toBe(1);
  });
});

describe("H5: no decision reimplementation", () => {
  it("tick-inspect imports decideTick/decideTermination from ./tick", () => {
    const src = readFileSync(join(ROOT, "..", "src", "tick-inspect.ts"), "utf8");
    expect(src).toMatch(/from\s+["']\.\/tick["']/);
    expect(src).toMatch(/decideTick/);
    expect(src).toMatch(/decideTermination/);
  });

  it("decideTick / decideTermination are defined exactly once across src", () => {
    const files = [
      "tick.ts",
      "tick-entry.ts",
      "tick-inspect.ts",
      "generate.ts",
      "ingest.ts",
      "bus.ts",
      "mineru.ts",
      "export.ts",
      "protocol.ts",
    ];
    const defCount = (re: RegExp): number => {
      let n = 0;
      for (const f of files) {
        const body = readFileSync(join(ROOT, "..", "src", f), "utf8");
        n += (body.match(re) ?? []).length;
      }
      return n;
    };
    expect(defCount(/function decideTick\s*\(/)).toBe(1);
    expect(defCount(/function decideTermination\s*\(/)).toBe(1);
  });
});

describe("H6: inspect issues only GET and at least one request", () => {
  it("every request method is GET/undefined and a request actually happened", async () => {
    const methods: (string | undefined)[] = [];
    vi.stubGlobal("fetch", vi.fn(async (_url: unknown, init?: RequestInit) => {
      methods.push(init?.method);
      return jsonResponse({ messages: [] });
    }));
    const code = await runInspect("research:test", () => {});
    expect(methods.length).toBeGreaterThan(0);
    for (const m of methods) {
      expect(m === "GET" || m === undefined).toBe(true);
    }
    expect(code).toBe(0);
  });
});

describe("H7: inspect path does not touch MinerU or vault/export", () => {
  it("tick-inspect has no ./mineru or ./export import", () => {
    const src = readFileSync(join(ROOT, "..", "src", "tick-inspect.ts"), "utf8");
    expect(src).not.toMatch(/from\s+["']\.\/mineru["']/);
    expect(src).not.toMatch(/from\s+["']\.\/export["']/);
  });
});

describe("H10: terminal state any value → exit 0", () => {
  it("capped board (depth ≥ maxDepth) still exits 0", async () => {
    const msgs = [clueMsg(1, "e1", { status: "explored", depth: 3, sources: [] })];
    let first = true;
    stubFetch(async () => {
      const cur = first ? msgs : [];
      first = false;
      return jsonResponse({ messages: cur });
    });
    const out = computeInspect("research:test", msgs, {});
    expect(out.termination.state).toBe("capped");
    const code = await runInspect("research:test", () => {});
    expect(code).toBe(0);
  });

  it("null board (no clue) still exits 0", async () => {
    stubFetch(async () => jsonResponse({ messages: [] }));
    const code = await runInspect("research:test", () => {});
    expect(code).toBe(0);
  });

  it("computeInspect carries termination state through the same exit-0 path", () => {
    const nullOut = computeInspect("research:test", [], {});
    const cappedOut = computeInspect("research:test", [
      clueMsg(1, "e1", { status: "explored", depth: 3, sources: [] }),
    ], {});
    expect([nullOut.termination.state, cappedOut.termination.state]).toEqual([null, "capped"]);
  });
});