import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  runIngest,
  extractExtension,
  stripExtension,
  routeToEndpoint,
  assertSupportedExt,
  assertUnder4MB,
  extractMd,
  IngestError,
  MINERU_GPU_URL,
  MINERU_CPU_URL,
  MAX_DOC_BYTES,
} from "../src/ingest";
import type { IngestInput, IngestDeps } from "../src/ingest";
import { transcribeFile } from "../src/mineru";
import type { DocV2 } from "../src/protocol";

function input(over: Partial<IngestInput> = {}): IngestInput {
  return {
    uri: "code://repo@deadbeef:path/to/file.pdf",
    digest: "sha256:abc123",
    filename: "file.pdf",
    clueId: "clue-1",
    ...over,
  };
}

function doc(digest = "sha256:abc123"): DocV2 {
  return { doc_kind: "transcript", digest, body: "已有转写", origin: "x" };
}

function makeDeps(over: Partial<IngestDeps> = {}): IngestDeps {
  return {
    readExistingTranscript: vi.fn(async () => null),
    fetchMaterial: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]) })),
    transcribe: vi.fn(async () => "转写正文"),
    publishDoc: vi.fn(async () => {}),
    markClueBlocked: vi.fn(async () => {}),
    ...over,
  };
}

describe("E1", () => {
  it("digest already exists → MinerU is NOT called and the existing doc is returned", async () => {
    const existing = doc();
    const deps = makeDeps({ readExistingTranscript: vi.fn(async () => existing) });
    const result = await runIngest(deps, input());
    expect(deps.transcribe).toHaveBeenCalledTimes(0);
    expect(deps.publishDoc).toHaveBeenCalledTimes(0);
    expect(result).toBe(existing);
  });
});

describe("E2", () => {
  it("digest missing → MinerU called exactly once and a doc is published", async () => {
    const deps = makeDeps();
    const result = await runIngest(deps, input());
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.publishDoc).toHaveBeenCalledTimes(1);
    expect(result?.digest).toBe("sha256:abc123");
    expect(result?.doc_kind).toBe("transcript");
    expect(result?.origin).toBe("code://repo@deadbeef:path/to/file.pdf");
  });
});

describe("E3", () => {
  it("same material run twice → second run hits dedup, MinerU total calls === 1", async () => {
    let published = false;
    const deps = makeDeps({
      readExistingTranscript: vi.fn(async () => (published ? doc() : null)),
      publishDoc: vi.fn(async () => {
        published = true;
      }),
    });
    await runIngest(deps, input());
    await runIngest(deps, input());
    expect(deps.transcribe).toHaveBeenCalledTimes(1);
    expect(deps.publishDoc).toHaveBeenCalledTimes(1);
  });
});

describe("E4", () => {
  it("backend=pipeline is passed explicitly on the multipart form", async () => {
    let seenBody: unknown;
    const fakeFetch = async (_url: string, init?: RequestInit) => {
      seenBody = init?.body;
      return new Response(
        JSON.stringify({ backend: "pipeline", results: { file: { md_content: "X" } } }),
      );
    };
    await transcribeFile(
      { endpoint: MINERU_GPU_URL, filename: "file.pdf", bytes: new Uint8Array([1]) },
      fakeFetch,
    );
    const form = seenBody as FormData;
    expect(form.get("backend")).toBe("pipeline");
    expect(form.get("return_md")).toBe("true");
    expect(form.has("files")).toBe(true);
  });

  it("source never references hybrid-auto-engine", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/ingest.ts", import.meta.url)), "utf-8");
    const mineru = readFileSync(fileURLToPath(new URL("../src/mineru.ts", import.meta.url)), "utf-8");
    expect(src + mineru).not.toMatch(/hybrid-auto-engine/);
  });
});

describe("E5", () => {
  it("calls /file_parse, never /tasks", async () => {
    let seenUrl = "";
    const fakeFetch = async (url: string, init?: RequestInit) => {
      seenUrl = url;
      return new Response(
        JSON.stringify({ backend: "pipeline", results: { file: { md_content: "X" } } }),
      );
    };
    await transcribeFile(
      { endpoint: MINERU_GPU_URL, filename: "file.pdf", bytes: new Uint8Array([1]) },
      fakeFetch,
    );
    expect(seenUrl).toContain("/file_parse");
  });

  it("source has zero /tasks path hits", () => {
    const src = readFileSync(fileURLToPath(new URL("../src/ingest.ts", import.meta.url)), "utf-8");
    const mineru = readFileSync(fileURLToPath(new URL("../src/mineru.ts", import.meta.url)), "utf-8");
    expect(src + mineru).not.toMatch(/\/tasks/);
  });
});

describe("E6", () => {
  it.each(["png", "jpg"])("image extension %s routes to the CPU endpoint", (ext) => {
    expect(routeToEndpoint(ext)).toBe(MINERU_CPU_URL);
    expect(routeToEndpoint(ext)).toContain("127.0.0.1:8090");
  });

  it("exec shell passes the CPU endpoint to the transcribe dep for an image", async () => {
    const endpoints: string[] = [];
    const deps = makeDeps({
      transcribe: vi.fn(async (req) => {
        endpoints.push(req.endpoint);
        return "body";
      }),
    });
    await runIngest(deps, input({ filename: "photo.png" }));
    expect(endpoints).toEqual([MINERU_CPU_URL]);
  });
});

describe("E7", () => {
  it.each(["pdf", "docx"])("non-image extension %s routes to the GPU endpoint", (ext) => {
    expect(routeToEndpoint(ext)).toBe(MINERU_GPU_URL);
    expect(routeToEndpoint(ext)).toContain("172.22.62.133:8090");
  });

  it("exec shell passes the GPU endpoint to the transcribe dep for a pdf", async () => {
    const endpoints: string[] = [];
    const deps = makeDeps({
      transcribe: vi.fn(async (req) => {
        endpoints.push(req.endpoint);
        return "body";
      }),
    });
    await runIngest(deps, input({ filename: "paper.pdf" }));
    expect(endpoints).toEqual([MINERU_GPU_URL]);
  });
});

describe("E8", () => {
  it("result is keyed by the extension-stripped filename — probe.pdf → probe", () => {
    expect(extractMd({ probe: { md_content: "X" } }, "probe.pdf")).toBe("X");
    expect(stripExtension("probe.pdf")).toBe("probe");
  });

  it("real client extracts md_content via the stripped key", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ backend: "pipeline", results: { probe: { md_content: "X" } } }));
    const md = await transcribeFile(
      { endpoint: MINERU_GPU_URL, filename: "probe.pdf", bytes: new Uint8Array([1]) },
      fakeFetch,
    );
    expect(md).toBe("X");
  });
});

describe("E9", () => {
  it("positive case: 4MB−1 passes the guard", () => {
    expect(() => assertUnder4MB(MAX_DOC_BYTES - 1)).not.toThrow();
    expect(() => assertUnder4MB(MAX_DOC_BYTES)).not.toThrow();
  });

  it("negative case: 4MB+1 is rejected with a loud error", () => {
    expect(() => assertUnder4MB(MAX_DOC_BYTES + 1)).toThrow(IngestError);
    expect(() => assertUnder4MB(MAX_DOC_BYTES + 1)).toThrow(/4MB/);
  });

  it("exec shell rejects an over-limit transcript", async () => {
    const deps = makeDeps({
      fetchMaterial: vi.fn(async () => ({ bytes: new Uint8Array(MAX_DOC_BYTES + 1) })),
    });
    await expect(runIngest(deps, input())).rejects.toThrow(IngestError);
    expect(deps.transcribe).toHaveBeenCalledTimes(0);
  });
});

describe("E10", () => {
  it.each(["epub", "mobi", "chm", "azw"])("unsupported extension %s fails loudly", (ext) => {
    expect(() => assertSupportedExt(ext)).toThrow(IngestError);
    expect(() => assertSupportedExt(ext)).toThrow(/unsupported/);
  });

  it("exec shell rejects an unsupported extension without returning success or empty", async () => {
    const deps = makeDeps();
    await expect(runIngest(deps, input({ filename: "book.epub" }))).rejects.toThrow(IngestError);
    expect(deps.transcribe).toHaveBeenCalledTimes(0);
    expect(deps.publishDoc).toHaveBeenCalledTimes(0);
  });
});

describe("E11", () => {
  it("MinerU unreachable → loud failure AND the clue is marked blocked", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => {
        throw new IngestError("mineru_unreachable", "boom");
      }),
    });
    await expect(runIngest(deps, input())).rejects.toThrow(IngestError);
    expect(deps.markClueBlocked).toHaveBeenCalledTimes(1);
    expect(deps.markClueBlocked).toHaveBeenCalledWith("clue-1");
  });
});

describe("E12", () => {
  it("MinerU returns status=failed → loud failure AND the clue is marked blocked", async () => {
    const deps = makeDeps({
      transcribe: vi.fn(async () => {
        throw new IngestError("mineru_failed", "failed");
      }),
    });
    await expect(runIngest(deps, input())).rejects.toThrow(IngestError);
    expect(deps.markClueBlocked).toHaveBeenCalledTimes(1);
    expect(deps.markClueBlocked).toHaveBeenCalledWith("clue-1");
  });

  it("real client maps status=failed to a mineru_failed error", async () => {
    const fakeFetch = async () =>
      new Response(JSON.stringify({ backend: "pipeline", status: "failed" }));
    await expect(
      transcribeFile(
        { endpoint: MINERU_GPU_URL, filename: "probe.pdf", bytes: new Uint8Array([1]) },
        fakeFetch,
      ),
    ).rejects.toThrow(IngestError);
  });
});

describe("E13", () => {
  it("never hits MinerU concurrently — in-flight transcribe requests stay ≤ 1", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const transcribe = vi.fn(async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await gate;
      inFlight -= 1;
      return "body";
    });
    const deps = makeDeps({
      readExistingTranscript: vi.fn(async () => null),
      transcribe,
    });

    const a = runIngest(deps, input({ filename: "a.pdf" }));
    const b = runIngest(deps, input({ filename: "b.pdf" }));

    // 等第一个真正发起转写（此刻第二个被串行化挡在门外）。
    await vi.waitFor(() => expect(transcribe).toHaveBeenCalledTimes(1));
    expect(maxInFlight).toBe(1);

    release();
    await Promise.all([a, b]);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(maxInFlight).toBe(1);
  });
});

describe("E14", () => {
  it("decision module is pure: no ./bus import, no Date/fetch/Math.random", () => {
    const srcPath = fileURLToPath(new URL("../src/ingest.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\/bus["']/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/Math\.random/);
  });

  it("extension helpers are deterministic and case-insensitive", () => {
    expect(extractExtension("X.PNG")).toBe("png");
    expect(extractExtension("noext")).toBe("");
    expect(routeToEndpoint("png")).toBe(MINERU_CPU_URL);
    expect(routeToEndpoint("pdf")).toBe(MINERU_GPU_URL);
  });
});