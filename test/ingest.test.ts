import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  buildDigestIndex,
  scanAllMessages,
  readExistingTranscript,
  transcribeMaterial,
  ingestMaterial,
  ingestBatch,
  computeDigest,
  classifyExtension,
  stripExtension,
  assertWithinSizeLimit,
  createMutex,
  buildContentClue,
  contentClueText,
  fetchMaterialHttp,
  filenameFromUri,
  MAX_MATERIAL_BYTES,
  MATERIAL_BLOCKED_RATIONALE_PREFIX,
} from "../src/ingest";
import type {
  BusMessage,
  IngestDeps,
  MaterialInput,
  FetchedMaterial,
} from "../src/ingest";
import type { DocV2, ClueV2 } from "../src/protocol";

function msg(
  channelSeq: number,
  kind: string,
  payload: unknown,
  over: Partial<BusMessage> = {},
): BusMessage {
  return {
    message_id: `msg_${channelSeq}`,
    channel_id: "research:content",
    channel_seq: channelSeq,
    kind,
    payload,
    entity_id: `msg_${channelSeq}`,
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
    ...over,
  };
}

function doc(over: Partial<DocV2> = {}): DocV2 {
  return {
    doc_kind: "transcript",
    digest: "d1",
    body: "body",
    origin: "http://example.com/a.pdf",
    ...over,
  };
}

function materialInput(over: Partial<MaterialInput> = {}): MaterialInput {
  return {
    uri: "http://example.com/a.pdf",
    digest: "d1",
    clueId: "clue_1",
    ...over,
  };
}

const FIXED_BYTES = new Uint8Array([1, 2, 3, 4, 5]);
const FIXED_DIGEST = createHash("sha256").update(FIXED_BYTES).digest("hex");

function fetched(over: Partial<FetchedMaterial> = {}): FetchedMaterial {
  return {
    filename: "a.pdf",
    bytes: FIXED_BYTES,
    ...over,
  };
}

function baseDeps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    readExistingTranscript: async () => null,
    fetchMaterial: async () => fetched(),
    transcribe: vi.fn(async () => "md"),
    publishDoc: vi.fn(async () => {}),
    proposeContentClue: vi.fn(async (clue: ClueV2) => clue),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("N1 pure decision module (E14)", () => {
  it("src/ingest.ts does not import ./bus and has no Date/fetch/Math.random (fetchMaterialHttp excepted via fetch global)", () => {
    const srcPath = fileURLToPath(new URL("../src/ingest.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\/bus["']/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/Math\.random/);
  });
});

describe("N1 buildDigestIndex (E17)", () => {
  it("builds a full index over a literal BusMessage[]: 3 docs, 2 with the same digest, dedup by digest", () => {
    const a = doc({ digest: "A", body: "first-A" });
    const a2 = doc({ digest: "A", body: "second-A" });
    const b = doc({ digest: "B", body: "B-body" });
    const messages: BusMessage[] = [
      msg(1, "research.doc.v2", a),
      msg(2, "research.doc.v2", a2),
      msg(3, "research.doc.v2", b),
    ];
    const index = buildDigestIndex(messages);
    expect(index.size).toBe(2);
    expect(index.get("A")?.body).toBe("second-A");
    expect(index.get("B")?.body).toBe("B-body");
  });

  it("ignores non-transcript docs and non-doc messages", () => {
    const messages: BusMessage[] = [
      msg(1, "research.clue.v2", { text: "x" }),
      msg(2, "research.doc.v2", doc({ doc_kind: "report" })),
      msg(3, "research.doc.v2", doc({ digest: "T", doc_kind: "transcript" })),
    ];
    const index = buildDigestIndex(messages);
    expect(index.size).toBe(1);
    expect(index.get("T")).toBeDefined();
  });
});

describe("N1 paginated scan (E18)", () => {
  it("issues repeated after_seq reads until empty: >100 messages trigger multiple pages", async () => {
    const page1 = Array.from({ length: 100 }, (_, i) =>
      msg(i + 1, "research.doc.v2", doc({ digest: `d${i}` })),
    );
    const page2 = Array.from({ length: 20 }, (_, i) =>
      msg(i + 101, "research.doc.v2", doc({ digest: `d${i + 100}` })),
    );
    const pages = [page1, page2, []];
    let call = 0;
    const afterSeqs: Array<number | null> = [];
    const scanFn = async (afterSeq: number | null) => {
      afterSeqs.push(afterSeq);
      return pages[Math.min(call++, 2)];
    };
    const messages = await scanAllMessages(scanFn);
    expect(call).toBe(3);
    expect(afterSeqs).toEqual([null, page1[99].channel_seq, page2[19].channel_seq]);
    expect(messages).toHaveLength(120);
  });

  it("wired to the real bus client, page 2 and 3 URLs carry after_seq=", async () => {
    const { getMessages } = await import("../src/bus");
    const page1 = Array.from({ length: 100 }, (_, i) =>
      msg(i + 1, "research.doc.v2", doc({ digest: `d${i}` })),
    );
    const page2 = Array.from({ length: 20 }, (_, i) =>
      msg(i + 101, "research.doc.v2", doc({ digest: `d${i + 100}` })),
    );
    const pages = [page1, page2, []];
    let call = 0;
    const urls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        urls.push(String(url));
        const page = pages[Math.min(call++, 2)];
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: page }),
          text: async () => "",
        };
      }),
    );
    const found = await readExistingTranscript(
      (afterSeq) =>
        getMessages(
          "research:content",
          afterSeq !== null ? { afterSeq } : {},
        ),
      "d500",
    );
    expect(urls).toHaveLength(3);
    expect(urls[0]).not.toContain("after_seq=");
    expect(urls[1]).toContain("after_seq=");
    expect(urls[2]).toContain("after_seq=");
    expect(found).toBeNull();
  });
});

describe("N1 readExistingTranscript composition (E19)", () => {
  it("is a concrete function (not an abstract method) that dedups through a stubbed HTTP layer", async () => {
    const { getMessages } = await import("../src/bus");
    const existing = doc({ digest: "dup-1", body: "already transcribed" });
    const messages: BusMessage[] = [
      msg(1, "research.doc.v2", existing),
      msg(2, "research.doc.v2", doc({ digest: "other" })),
    ];
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        call += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: call === 1 ? messages : [] }),
          text: async () => "",
        };
      }),
    );
    const result = await readExistingTranscript(
      (afterSeq) => getMessages("research:content", afterSeq !== null ? { afterSeq } : {}),
      "dup-1",
    );
    expect(result).toEqual(existing);
    expect(result?.body).toBe("already transcribed");
  });
});

// ── E1 D1: authoritative digest ─────────────────────────────────────

describe("E1 D1 computeDigest (authoritative digest over fetched bytes)", () => {
  it("computeDigest returns sha256 hex of the bytes", () => {
    expect(computeDigest(FIXED_BYTES)).toBe(FIXED_DIGEST);
    expect(computeDigest(new Uint8Array([1]))).toBe(
      createHash("sha256").update(new Uint8Array([1])).digest("hex"),
    );
  });

  it("⭐⭐ D1 discriminating: stub fetch returns known bytes, worker reports a different fake digest ⇒ published doc.digest === sha256(bytes), not the fake value", async () => {
    const fakeDigest = "deadbeef".repeat(8);
    expect(fakeDigest).not.toBe(FIXED_DIGEST);
    const deps = baseDeps();
    const { doc } = await transcribeMaterial(
      deps,
      materialInput({ digest: fakeDigest }),
    );
    expect(doc.digest).toBe(FIXED_DIGEST);
    expect(doc.digest).not.toBe(fakeDigest);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.publishDoc).toHaveBeenCalledTimes(1);
  });

  it("⭐⭐ D1 negative control: if digest were keyed on input.digest this would break (sanity: published doc carries computed digest)", async () => {
    const deps = baseDeps();
    const { doc } = await transcribeMaterial(deps, materialInput({ digest: "worker-hint" }));
    expect(doc.digest).toBe(FIXED_DIGEST);
    expect(doc.doc_kind).toBe("transcript");
    expect(doc.origin).toBe("http://example.com/a.pdf");
  });
});

// ── E1 D2: global dedup by authoritative digest ────────────────────

describe("E1 D2 global dedup by authoritative digest", () => {
  it("⭐⭐ D2 discriminating: same bytes second time with DIFFERENT worker-reported digest ⇒ transcribe stub called 0 times (second), existing doc reused", async () => {
    const existing = doc({ digest: FIXED_DIGEST, body: "first" });
    let transcribeCalls = 0;
    const deps = baseDeps({
      readExistingTranscript: async (d) => (d === FIXED_DIGEST ? existing : null),
      transcribe: vi.fn(async () => {
        transcribeCalls += 1;
        return "should-not-be-called";
      }),
    });
    const r1 = await transcribeMaterial(deps, materialInput({ digest: "hint-a" }));
    expect(r1.reused).toBe(true);
    expect(transcribeCalls).toBe(0);
    expect(r1.doc).toEqual(existing);
  });

  it("D2: different bytes (different computed digest) with same worker hint ⇒ transcribe called (no dedup hit)", async () => {
    const deps = baseDeps({
      readExistingTranscript: async () => null,
    });
    const { doc, reused } = await transcribeMaterial(deps, materialInput());
    expect(reused).toBe(false);
    expect(doc.digest).toBe(FIXED_DIGEST);
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
  });

  it("D2: same material twice through a stateful dedup map ⇒ transcribe total calls === 1", async () => {
    const existingByDigest = new Map<string, DocV2>();
    const deps = baseDeps({
      readExistingTranscript: async (d) => existingByDigest.get(d) ?? null,
      transcribe: vi.fn(async () => {
        const d = doc({ digest: FIXED_DIGEST, body: "first-transcription" });
        existingByDigest.set(d.digest, d);
        return d.body;
      }),
      publishDoc: vi.fn(async (d: DocV2) => {
        existingByDigest.set(d.digest, d);
      }),
    });
    const first = await transcribeMaterial(deps, materialInput());
    const second = await transcribeMaterial(deps, materialInput());
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(first.doc.digest).toBe(FIXED_DIGEST);
    expect(second.reused).toBe(true);
    expect(second.doc).toEqual(first.doc);
  });
});

// ── N1 4MB guard (E9) ──────────────────────────────────────────────

describe("N1 4MB guard (E9)", () => {
  it("4MB-1 passes the guard", () => {
    expect(() => assertWithinSizeLimit(MAX_MATERIAL_BYTES - 1)).not.toThrow();
  });

  it("4MB+1 is rejected loudly", () => {
    expect(() => assertWithinSizeLimit(MAX_MATERIAL_BYTES + 1)).toThrow(/4MB|guard/i);
  });

  it("a material over 4MB is rejected at the transcribe step without calling MinerU", async () => {
    const deps = baseDeps({
      fetchMaterial: async () => fetched({ bytes: new Uint8Array(MAX_MATERIAL_BYTES + 1) }),
    });
    await expect(transcribeMaterial(deps, materialInput())).rejects.toThrow();
    expect(deps.transcribe).toHaveBeenCalledTimes(0);
    expect(deps.publishDoc).toHaveBeenCalledTimes(0);
  });

  it("a material at 4MB-1 flows through to transcription", async () => {
    const deps = baseDeps({
      fetchMaterial: async () => fetched({ bytes: new Uint8Array(MAX_MATERIAL_BYTES - 1) }),
    });
    const { doc } = await transcribeMaterial(deps, materialInput());
    expect(doc.body).toBe("md");
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
  });
});

// ── N1 unsupported extensions (E10) ────────────────────────────────

describe("N1 unsupported extensions fail loudly (E10)", () => {
  for (const ext of ["epub", "mobi", "chm", "azw"]) {
    it(`classifyExtension throws for .${ext}`, () => {
      expect(() => classifyExtension(`book.${ext}`)).toThrow(/unsupported/i);
    });
  }

  it("an unsupported material is rejected without publishing", async () => {
    const deps = baseDeps({
      fetchMaterial: async () => fetched({ filename: "book.epub" }),
    });
    await expect(transcribeMaterial(deps, materialInput())).rejects.toThrow();
    expect(deps.transcribe).toHaveBeenCalledTimes(0);
    expect(deps.publishDoc).toHaveBeenCalledTimes(0);
  });
});

// ── E1 D4/D5/D6: content-clue lifecycle via ingestMaterial ─────────

describe("E1 D4 propose content-clue on successful transcription", () => {
  it("⭐ D4 discriminating: success ⇒ propose clue with sources:['content'], parent=clueId, depth=parentDepth (not +1), text has digest+URI", async () => {
    const deps = baseDeps();
    const clue = await ingestMaterial(deps, materialInput({ clueId: "parent_3" }), 3, "k1");
    expect(clue).not.toBeNull();
    expect(clue!.sources).toEqual(["content"]);
    expect(clue!.parent).toBe("parent_3");
    expect(clue!.depth).toBe(3);
    expect(clue!.status).toBe("proposed");
    expect(clue!.text).toContain(FIXED_DIGEST);
    expect(clue!.text).toContain("http://example.com/a.pdf");
    expect(deps.proposeContentClue).toHaveBeenCalledTimes(1);
  });

  it("⭐ D4 negative control: depth === parent.depth (changing to parent.depth+1 would break)", () => {
    const clue = buildContentClue({
      parentClueId: "p",
      parentDepth: 5,
      digest: "abc",
      originUri: "uri",
      status: "proposed",
    });
    expect(clue.depth).toBe(5);
    expect(clue.depth).not.toBe(6);
  });

  it("D4: contentClueText carries both digest and URI", () => {
    const t = contentClueText("dig123", "http://u/x.pdf");
    expect(t).toContain("dig123");
    expect(t).toContain("http://u/x.pdf");
  });
});

describe("E1 D5 content-clue idempotency (D2 reuse ⇒ no propose)", () => {
  it("⭐ D5: same digest second time (D2 reuse) ⇒ proposeContentClue call count stays at 1 (no second propose)", async () => {
    const existingByDigest = new Map<string, DocV2>();
    const deps = baseDeps({
      readExistingTranscript: async (d) => existingByDigest.get(d) ?? null,
      transcribe: vi.fn(async () => {
        const d = doc({ digest: FIXED_DIGEST, body: "first" });
        existingByDigest.set(d.digest, d);
        return d.body;
      }),
      publishDoc: vi.fn(async (d: DocV2) => {
        existingByDigest.set(d.digest, d);
      }),
    });
    const first = await ingestMaterial(deps, materialInput(), 2, "k1");
    expect(first).not.toBeNull();
    expect(deps.proposeContentClue).toHaveBeenCalledTimes(1);
    const second = await ingestMaterial(deps, materialInput(), 2, "k2");
    expect(second).toBeNull();
    expect(deps.proposeContentClue).toHaveBeenCalledTimes(1);
  });
});

describe("E1 D6 failure granularity sinks to material (parent clue not collateralized)", () => {
  it("⭐⭐ D6 discriminating: stub transcribe throws ⇒ (a) content-clue born blocked with rationale containing error detail; (b) no exception propagated", async () => {
    const deps = baseDeps({
      transcribe: vi.fn(async () => {
        throw new Error("MinerU unreachable");
      }),
    });
    const clue = await ingestMaterial(deps, materialInput({ clueId: "parent_1" }), 1, "k1");
    expect(clue).not.toBeNull();
    expect(clue!.status).toBe("blocked");
    expect(clue!.rationale).toContain(MATERIAL_BLOCKED_RATIONALE_PREFIX);
    expect(clue!.rationale).toContain("MinerU unreachable");
    expect(clue!.parent).toBe("parent_1");
    expect(clue!.sources).toEqual(["content"]);
    expect(deps.proposeContentClue).toHaveBeenCalledTimes(1);
  });

  it("⭐⭐ D6: parent clue is NOT markBlocked (no markBlocked dep exists); evidence/CAS handled upstream by harvest", async () => {
    const deps = baseDeps({
      transcribe: vi.fn(async () => {
        throw new Error("status=failed");
      }),
    });
    const clue = await ingestMaterial(deps, materialInput({ clueId: "parent_9" }), 9, "k1");
    expect(clue!.status).toBe("blocked");
    expect(clue!.rationale).toContain("status=failed");
    expect(clue!.depth).toBe(9);
  });

  it("D6: fetch failure also produces a blocked content-clue (not just transcribe)", async () => {
    const deps = baseDeps({
      fetchMaterial: async () => {
        throw new Error("HTTP 503");
      },
    });
    const clue = await ingestMaterial(deps, materialInput(), 2, "k1");
    expect(clue!.status).toBe("blocked");
    expect(clue!.rationale).toContain("HTTP 503");
  });
});

// ── E1 D7: serialization (in-flight MinerU === 1) ──────────────────

describe("E1 D7 no concurrent MinerU (ingestBatch serializes)", () => {
  it("⭐ D7: N materials submitted at once keep in-flight MinerU requests at most 1", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps = baseDeps({
      readExistingTranscript: async () => null,
      fetchMaterial: async (uri) => fetched({ filename: `${uri}.pdf` }),
      transcribe: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
        return "md";
      }),
    });
    const inputs = [
      materialInput({ uri: "http://e.com/1", digest: "d-a", clueId: "c-a" }),
      materialInput({ uri: "http://e.com/2", digest: "d-b", clueId: "c-b" }),
      materialInput({ uri: "http://e.com/3", digest: "d-c", clueId: "c-c" }),
    ];
    const pending = ingestBatch(deps, inputs, 1, "batch");
    await new Promise((r) => setTimeout(r, 30));
    expect(maxInFlight).toBe(1);
    release();
    await pending;
    expect(deps.transcribe).toHaveBeenCalledTimes(3);
    expect(maxInFlight).toBeLessThanOrEqual(1);
  });
});

// ── E1 D9: maxClues cap for content-clue ───────────────────────────

describe("E1 D9 maxClues cap for content-clue", () => {
  it("⭐ D9: proposeContentClue returning null (cap) ⇒ ingestMaterial returns null (not published)", async () => {
    const deps = baseDeps({
      proposeContentClue: vi.fn(async () => null),
    });
    const clue = await ingestMaterial(deps, materialInput(), 1, "k1");
    expect(clue).toBeNull();
    expect(deps.proposeContentClue).toHaveBeenCalledTimes(1);
  });
});

// ── N1 createMutex serialization core (E13) ────────────────────────

describe("N1 createMutex serializes (E13 core)", () => {
  it("runSerialized executes functions one at a time even when submitted concurrently", async () => {
    const serialize = createMutex();
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const fn = async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return "ok";
    };
    const p1 = serialize(fn);
    const p2 = serialize(fn);
    await new Promise((r) => setTimeout(r, 10));
    expect(maxInFlight).toBe(1);
    release();
    await Promise.all([p1, p2]);
    expect(maxInFlight).toBe(1);
  });
});

// ── N1 helper purity ───────────────────────────────────────────────

describe("N1 helper purity", () => {
  it("stripExtension removes only the final extension", () => {
    expect(stripExtension("probe.pdf")).toBe("probe");
    expect(stripExtension("report.v1.docx")).toBe("report.v1");
    expect(stripExtension("noext")).toBe("noext");
  });

  it("classifyExtension routes images to cpu and pdf/office to gpu", () => {
    for (const f of ["a.png", "a.jpg", "a.webp", "a.tiff"]) {
      expect(classifyExtension(f).route).toBe("cpu");
    }
    for (const f of ["a.pdf", "a.docx", "a.pptx", "a.xlsx"]) {
      expect(classifyExtension(f).route).toBe("gpu");
    }
  });
});

// ── E1 D8: production fetchMaterialHttp ────────────────────────────

describe("E1 D8 fetchMaterialHttp (production fetchMaterial)", () => {
  it("downloads bytes and derives filename from URI path", async () => {
    const payload = new Uint8Array([10, 20, 30]);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength),
      })),
    );
    const m = await fetchMaterialHttp("https://host/path/doc.pdf");
    expect(m.bytes).toEqual(payload);
    expect(m.filename).toBe("doc.pdf");
  });

  it("D8: HTTP non-2xx ⇒ loud failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: false, status: 503 })),
    );
    await expect(fetchMaterialHttp("https://host/x.pdf")).rejects.toThrow(/503|HTTP/);
  });

  it("D8: empty bytes ⇒ loud failure (refusing to treat empty as success)", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => new ArrayBuffer(0),
      })),
    );
    await expect(fetchMaterialHttp("https://host/x.pdf")).rejects.toThrow(/0 bytes|empty/i);
  });

  it("D8: over 4MB ⇒ loud failure via assertWithinSizeLimit", async () => {
    const big = new Uint8Array(MAX_MATERIAL_BYTES + 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        status: 200,
        arrayBuffer: async () => big.buffer.slice(big.byteOffset, big.byteOffset + big.byteLength),
      })),
    );
    await expect(fetchMaterialHttp("https://host/big.pdf")).rejects.toThrow(/4MB|guard/i);
  });

  it("filenameFromUri: derives last path segment; falls back to 'material'", () => {
    expect(filenameFromUri("https://h/a/b/c.pdf")).toBe("c.pdf");
    expect(filenameFromUri("https://h/")).toBe("material");
    expect(filenameFromUri("not-a-url/just/a/path.txt")).toBe("path.txt");
  });
});
