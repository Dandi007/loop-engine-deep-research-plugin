import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  buildDigestIndex,
  scanAllMessages,
  readExistingTranscript,
  transcribeMaterial,
  transcribeBatch,
  classifyExtension,
  stripExtension,
  assertWithinSizeLimit,
  createMutex,
  MAX_MATERIAL_BYTES,
} from "../src/ingest";
import type {
  BusMessage,
  IngestDeps,
  MaterialInput,
  FetchedMaterial,
} from "../src/ingest";
import type { DocV2 } from "../src/protocol";

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

function fetched(over: Partial<FetchedMaterial> = {}): FetchedMaterial {
  return {
    filename: "a.pdf",
    bytes: new Uint8Array([1, 2, 3]),
    ...over,
  };
}

function baseDeps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    readExistingTranscript: async () => null,
    fetchMaterial: async () => fetched(),
    transcribe: vi.fn(async () => "md"),
    publishDoc: vi.fn(async () => {}),
    markBlocked: vi.fn(async () => {}),
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("N1 pure decision module (E14)", () => {
  it("src/ingest.ts does not import ./bus and has no Date/fetch/Math.random", () => {
    const srcPath = fileURLToPath(new URL("../src/ingest.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\/bus["']/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/fetch\s*\(/);
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

describe("N1 digest dedup (E1/E3)", () => {
  it("digest already present: MinerU not called and the existing doc is returned", async () => {
    const existing = doc({ digest: "dup-1", body: "existing" });
    const deps = baseDeps({
      readExistingTranscript: async () => existing,
    });
    const result = await transcribeMaterial(deps, materialInput({ digest: "dup-1" }));
    expect(deps.transcribe).toHaveBeenCalledTimes(0);
    expect(deps.publishDoc).toHaveBeenCalledTimes(0);
    expect(result).toEqual(existing);
  });

  it("digest absent: MinerU called exactly once and a doc is published", async () => {
    const deps = baseDeps({
      readExistingTranscript: async () => null,
      transcribe: vi.fn(async () => "transcribed"),
    });
    const result = await transcribeMaterial(deps, materialInput());
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.publishDoc).toHaveBeenCalledTimes(1);
    expect(result.body).toBe("transcribed");
    expect(result.digest).toBe("d1");
    expect(result.doc_kind).toBe("transcript");
  });

  it("same material run twice: second run hits dedup, MinerU total calls === 1", async () => {
    const existingByDigest = new Map<string, DocV2>();
    const deps = baseDeps({
      readExistingTranscript: async (digest) => existingByDigest.get(digest) ?? null,
      transcribe: vi.fn(async () => {
        const d = doc({ digest: "d1", body: "first-transcription" });
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
    expect(first.digest).toBe("d1");
    expect(second.digest).toBe("d1");
    expect(second).toEqual(first);
  });
});

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
    const result = await transcribeMaterial(deps, materialInput());
    expect(result.body).toBe("md");
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
  });
});

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

describe("N1 MinerU failure marks the clue blocked (E11/E12)", () => {
  it("transcribe throwing (MinerU unreachable) propagates the error and marks the clue blocked", async () => {
    const deps = baseDeps({
      transcribe: vi.fn(async () => {
        throw new Error("MinerU unreachable");
      }),
    });
    await expect(transcribeMaterial(deps, materialInput())).rejects.toThrow(/unreachable/);
    expect(deps.markBlocked).toHaveBeenCalledTimes(1);
    expect(deps.markBlocked).toHaveBeenCalledWith("clue_1");
  });

  it("a transcribe returning an explicit failure marks the clue blocked", async () => {
    const deps = baseDeps({
      transcribe: vi.fn(async () => {
        throw new Error("status=failed");
      }),
    });
    await expect(transcribeMaterial(deps, materialInput())).rejects.toThrow();
    expect(deps.markBlocked).toHaveBeenCalledTimes(1);
    expect(deps.markBlocked).toHaveBeenCalledWith("clue_1");
  });
});

describe("N1 no concurrent MinerU (E13)", () => {
  it("two materials submitted at once keep in-flight MinerU requests at most 1", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const deps = baseDeps({
      readExistingTranscript: async () => null,
      fetchMaterial: async () => fetched(),
      transcribe: vi.fn(async () => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await gate;
        inFlight -= 1;
        return "md";
      }),
    });
    const inputs = [
      materialInput({ uri: "http://e.com/1.pdf", digest: "d-a", clueId: "c-a" }),
      materialInput({ uri: "http://e.com/2.pdf", digest: "d-b", clueId: "c-b" }),
    ];
    const pending = transcribeBatch(deps, inputs);
    await new Promise((r) => setTimeout(r, 20));
    expect(maxInFlight).toBe(1);
    release();
    await pending;
    expect(deps.transcribe).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBeLessThanOrEqual(1);
  });
});

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
