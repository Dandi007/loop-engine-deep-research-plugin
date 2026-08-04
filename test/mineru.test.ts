import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { globSync } from "node:fs";
import { fileParse } from "../src/mineru";

function okResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => "",
  };
}

function captureFetch() {
  const calls: Array<{ url: string; body: FormData | null }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      calls.push({ url: String(url), body: (init?.body as FormData) ?? null });
      return okResponse({
        backend: "pipeline",
        version: "3.1.6",
        results: { probe: { md_content: "X" } },
      });
    }),
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("N1 MinerU sync /file_parse contract (E5)", () => {
  it("calls /file_parse and never /tasks", async () => {
    const calls = captureFetch();
    await fileParse("probe.pdf", new Uint8Array([1, 2, 3]));
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toContain("/file_parse");
    expect(calls[0].url).not.toContain("/tasks");
  });

  it("source tree contains no /tasks route", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    for (const file of globSync("**/*.ts", { cwd: srcDir })) {
      const source = readFileSync(`${srcDir}/${file}`, "utf-8");
      expect(source).not.toMatch(/\/tasks/);
    }
  });
});

describe("N1 MinerU backend=pipeline (E4)", () => {
  it("explicitly sends backend=pipeline in the multipart form", async () => {
    const calls = captureFetch();
    await fileParse("probe.pdf", new Uint8Array([1, 2, 3]));
    expect(calls[0].body?.get("backend")).toBe("pipeline");
    expect(calls[0].body?.get("return_md")).toBe("true");
    expect(calls[0].body?.get("files")).toBeTruthy();
  });

  it("source tree contains no hybrid-auto-engine", () => {
    const srcDir = fileURLToPath(new URL("../src", import.meta.url));
    for (const file of globSync("**/*.ts", { cwd: srcDir })) {
      const source = readFileSync(`${srcDir}/${file}`, "utf-8");
      expect(source).not.toMatch(/hybrid-auto-engine/);
    }
  });
});

describe("N1 extension hard routing (E6/E7)", () => {
  it("image extensions route to the CPU endpoint", async () => {
    for (const filename of ["pic.png", "pic.jpg"]) {
      const calls: Array<{ url: string }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) => {
          calls.push({ url: String(url) });
          return okResponse({ results: { pic: { md_content: "M" } } });
        }),
      );
      await fileParse(filename, new Uint8Array([1, 2, 3]));
      expect(calls[0].url).toContain("127.0.0.1:8090");
    }
  });

  it("pdf and docx route to the GPU endpoint", async () => {
    for (const filename of ["doc.pdf", "doc.docx"]) {
      const calls: Array<{ url: string }> = [];
      vi.stubGlobal(
        "fetch",
        vi.fn(async (url: unknown) => {
          calls.push({ url: String(url) });
          return okResponse({ results: { doc: { md_content: "M" } } });
        }),
      );
      await fileParse(filename, new Uint8Array([1, 2, 3]));
      expect(calls[0].url).toContain("172.22.62.133:8090");
    }
  });
});

describe("N1 result key is filename without extension (E8)", () => {
  it("uploading probe.pdf reads md_content from results key 'probe'", async () => {
    const captured: Array<FormData> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: unknown, init?: RequestInit) => {
        captured.push((init?.body as FormData) ?? new FormData());
        return okResponse({ results: { probe: { md_content: "X" } } });
      }),
    );
    const md = await fileParse("probe.pdf", new Uint8Array([1, 2, 3]));
    expect(md).toBe("X");
    expect((captured[0].get("files") as File).name).toBe("probe.pdf");
  });
});

describe("N1 MinerU failure shapes are distinct (E12)", () => {
  it("status=failed is a loud failure, not silently accepted", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okResponse({ status: "failed", error: "boom", results: {} }),
      ),
    );
    await expect(fileParse("probe.pdf", new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /status=failed/,
    );
  });

  it("an HTTP error status is a loud failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 500,
        json: async () => ({}),
        text: async () => "",
      })),
    );
    await expect(fileParse("probe.pdf", new Uint8Array([1, 2, 3]))).rejects.toThrow(
      /HTTP 500/,
    );
  });
});
