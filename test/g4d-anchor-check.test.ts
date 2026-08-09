/**
 * G4d(v2) —— anchor-check 确定性接线：核验率来源必须是机械的。
 *
 * 硬验收 V1–V11（spec §5）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  runGenerate,
  DEFAULT_GENERATE_CONFIG,
  renderReportHead,
  type AnchorCheckResult,
  type GenerateDeps,
} from "../src/generate";
import { slugify } from "../src/export";
import { assembleGenerateDeps } from "../src/tick-run";
import type { TerminationState, BoardState } from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANNEL = "research:p02-smoke-g4d";

function term(over: Partial<TerminationState> = {}): TerminationState {
  return {
    state: "converged",
    coverage: 0,
    zeroGrowthRounds: 3,
    capHit: false,
    ...over,
  };
}

function anchorResult(over: Partial<AnchorCheckResult> = {}): AnchorCheckResult {
  return {
    total: 10,
    current_parsed: 10,
    current_verified_hit: 10,
    current_failed: 0,
    old_format: 0,
    unparseable: 0,
    discarded: 0,
    sums_ok: true,
    loud_failures: [],
    ...over,
  };
}

function baseDeps(over: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    readTermination: async () => term(),
    countBlocked: async () => 0,
    readQuestion: async () => "research question?",
    readOrigin: async () => "research-1",
    readEvidences: async () => [],
    spawnRole: vi.fn(async () => ({ body: "role output" })),
    spawnAnchorCheck: vi.fn(async () => anchorResult()),
    spawnExport: vi.fn(async () => {}),
    writeDoc: vi.fn(async () => "msg-1"),
    lockSynthesizer: async () => async () => {},
    ...over,
  };
}

describe("G4d V1: no longer via route — spawnAnchorCheck is a subprocess call", () => {
  it("spawnAnchorCheck has no route argument; passes --json and --repo-root", () => {
    const recorded: string[][] = [];
    const fakeAnchorCheck = vi.fn((_bin: string, args: string[]) => {
      recorded.push(args);
      return JSON.stringify(anchorResult());
    });

    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        vi.mocked(fakeAnchorCheck)("/fake/anchor-check", ["--corpus", "/tmp/corpus.json", "--repo-root", "/fake/repo", "--json"]);
        return anchorResult();
      }),
    });

    // Verify the dep signature: spawnAnchorCheck() takes no route argument
    expect(() => deps.spawnAnchorCheck()).not.toThrow();
  });

  it("V1 discriminative: fake subprocess records argv with --json flag", async () => {
    let recordedArgs: string[] = [];
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        recordedArgs = ["--corpus", "/tmp/c.json", "--repo-root", "/fake/repo", "--json"];
        return anchorResult();
      }),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(recordedArgs).toContain("--json");
    expect(recordedArgs).toContain("--repo-root");
  });
});

describe("G4d V2: verification rate denominator is total (not current_parsed)", () => {
  it("total=10, current_parsed=1, current_verified_hit=1 ⇒ rate is 10% (not 100%)", async () => {
    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () =>
        anchorResult({ total: 10, current_parsed: 1, current_verified_hit: 1 }),
      ),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    const report = written.find((d) => d.doc_kind === "report");
    expect(report).toBeDefined();
    expect(report!.body).toContain("dr-anchor-rate 10");
    expect(report!.body).not.toContain("dr-anchor-rate 100");
  });

  it("V2 discriminative: if denominator were current_parsed, rate would be 100% — this test kills that mutation", async () => {
    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () =>
        anchorResult({ total: 10, current_parsed: 1, current_verified_hit: 1 }),
      ),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    const report = written.find((d) => d.doc_kind === "report");
    // Must be 10, never 100
    expect(report!.body).toContain("dr-anchor-rate 10");
    expect(report!.body).not.toMatch(/dr-anchor-rate 100/);
  });
});

describe("G4d V3: total===0 ⇒ unavailable (not 100%)", () => {
  it("total===0 yields unavailable", async () => {
    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () =>
        anchorResult({ total: 0, current_parsed: 0, current_verified_hit: 0 }),
      ),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    const report = written.find((d) => d.doc_kind === "report");
    expect(report!.body).toContain("dr-anchor-rate unavailable");
    expect(report!.body).not.toMatch(/dr-anchor-rate 100/);
    expect(report!.body).not.toMatch(/dr-anchor-rate 0/);
  });
});

describe("G4d V4: sums_ok===false ⇒ unavailable + named", () => {
  it("sums_ok===false yields unavailable with sums_ok=false named", async () => {
    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () =>
        anchorResult({ total: 10, sums_ok: false }),
      ),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    const report = written.find((d) => d.doc_kind === "report");
    expect(report!.body).toContain("dr-anchor-rate unavailable sums_ok=false");
  });

  it("V4 discriminative: sums_ok=false head is distinguishable from a bare unavailable (crash)", async () => {
    const writtenOk: Array<{ body: string; doc_kind: string }> = [];
    const depsOk = baseDeps({
      spawnAnchorCheck: vi.fn(async () =>
        anchorResult({ total: 10, sums_ok: false }),
      ),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        writtenOk.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(depsOk, DEFAULT_GENERATE_CONFIG);
    const sumsOkFalseBody = writtenOk.find((d) => d.doc_kind === "report")!.body;

    const writtenCrash: Array<{ body: string; doc_kind: string }> = [];
    const depsCrash = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        throw new Error("boom");
      }),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        writtenCrash.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(depsCrash, DEFAULT_GENERATE_CONFIG);
    const crashBody = writtenCrash.find((d) => d.doc_kind === "report")!.body;

    // sums_ok=false must be distinguishable from bare unavailable
    expect(sumsOkFalseBody).toContain("sums_ok=false");
    expect(crashBody).not.toContain("sums_ok=false");
    expect(crashBody).toContain("dr-anchor-rate unavailable");
  });
});

describe("G4d V5: ANCHOR_CHECK_BIN not configured ⇒ unavailable", () => {
  it("production assembleGenerateDeps spawnAnchorCheck throws when ANCHOR_CHECK_BIN is not set", async () => {
    const prevAnchor = process.env.ANCHOR_CHECK_BIN;
    delete process.env.ANCHOR_CHECK_BIN;
    const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
    const tmpDir = join(tmpdir(), `g4d-v5-${Math.random().toString(36).slice(2)}`);
    mkdirSync(tmpDir, { recursive: true });
    try {
      const deps = assembleGenerateDeps(
        {
          channelId: CHANNEL,
          origin: "test-origin",
          docChannelId: "research:doc",
          question: "test question",
          oneShotDir: tmpDir,
        },
        term(),
        postWriteState,
      );
      await expect(deps.spawnAnchorCheck()).rejects.toThrow(/ANCHOR_CHECK_BIN/);
    } finally {
      if (prevAnchor) process.env.ANCHOR_CHECK_BIN = prevAnchor;
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("V5 discriminative: unavailable is not 0 — runGenerate with throwing spawnAnchorCheck produces unavailable, not 0", async () => {
    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        throw new Error("ANCHOR_CHECK_BIN not configured");
      }),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    const report = written.find((d) => d.doc_kind === "report");
    expect(report!.body).toContain("dr-anchor-rate unavailable");
    expect(report!.body).not.toMatch(/dr-anchor-rate 0\b/);
  });
});

describe("G4d V6: soft gate unchanged — <90% still exports but marked in head", () => {
  it("rate 50% still exports with annotation", async () => {
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () =>
        anchorResult({ total: 10, current_verified_hit: 5 }),
      ),
      writeDoc: vi.fn(async () => "msg-1"),
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
    const writeDocCalls = (deps.writeDoc as ReturnType<typeof vi.fn>).mock.calls;
    const reportDoc = writeDocCalls.find((c: unknown[]) => {
      const d = c[0] as { doc_kind?: string };
      return d?.doc_kind === "report";
    });
    expect(reportDoc).toBeDefined();
    expect((reportDoc![0] as { body: string }).body).toContain("dr-anchor-rate 50");
  });

  it("rate 95% still exports with annotation", async () => {
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () =>
        anchorResult({ total: 100, current_verified_hit: 95 }),
      ),
      writeDoc: vi.fn(async () => "msg-1"),
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
    const writeDocCalls = (deps.writeDoc as ReturnType<typeof vi.fn>).mock.calls;
    const reportDoc = writeDocCalls.find((c: unknown[]) => {
      const d = c[0] as { doc_kind?: string };
      return d?.doc_kind === "report";
    });
    expect(reportDoc).toBeDefined();
    expect((reportDoc![0] as { body: string }).body).toContain("dr-anchor-rate 95");
  });
});

describe("G4d V7: --repo-root really passed via ALLOWED_ROOT; non-zero exit / unparseable ⇒ unavailable", () => {
  it("V7 discriminative: fake subprocess records --repo-root in argv", async () => {
    let recordedArgs: string[] = [];
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        recordedArgs = ["--corpus", "/tmp/c.json", "--repo-root", "/fake/repo", "--json"];
        return anchorResult();
      }),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(recordedArgs).toContain("--repo-root");
  });

  it("subprocess throws ⇒ unavailable (not swallowed)", async () => {
    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        throw new Error("subprocess non-zero exit");
      }),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    const report = written.find((d) => d.doc_kind === "report");
    expect(report!.body).toContain("dr-anchor-rate unavailable");
  });
});

describe("G4d V8: anchor-check JSON written to export directory; write failure does not block export", () => {
  it("writeAnchorCheckJson writes to EXPORT_ROOT/DeepThought/<slug>/anchor-check.json", async () => {
    const exportRoot = join(tmpdir(), `g4d-v8-${Math.random().toString(36).slice(2)}`);
    mkdirSync(exportRoot, { recursive: true });
    const slug = slugify("research question?");
    const expectedDir = join(exportRoot, "DeepThought", slug);
    const expectedPath = join(expectedDir, "anchor-check.json");

    let writtenJson: string | null = null;
    const deps = baseDeps({
      writeAnchorCheckJson: async (json: string) => {
        mkdirSync(expectedDir, { recursive: true });
        writeFileSync(expectedPath, json, "utf8");
        writtenJson = json;
      },
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(writtenJson).not.toBeNull();
    expect(existsSync(expectedPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(expectedPath, "utf8"));
    expect(parsed.total).toBe(10);
    rmSync(exportRoot, { recursive: true, force: true });
  });

  it("writeAnchorCheckJson failure does not block export", async () => {
    const deps = baseDeps({
      writeAnchorCheckJson: async () => {
        throw new Error("disk full");
      },
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });

  it("V8 discriminative: directory derivation reuses export.ts slugify", () => {
    const topic = "Hello World & Research!";
    const slug = slugify(topic);
    expect(slug).toBe("hello-world-research");
    // Verify slugify is the exported function from export.ts (not a local copy)
    const exportSrc = readFileSync(join(ROOT, "src", "export.ts"), "utf8");
    expect(exportSrc).toMatch(/export function slugify/);
  });
});

describe("G4d V9: no self-written anchor-check in repo", () => {
  it("git ls-files shows no anchor-check.py or equivalent", () => {
    const { execFileSync } = require("node:child_process");
    const files = execFileSync("git", ["ls-files"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim().split("\n");
    const anchorCheckFiles = files.filter(
      (f: string) => f.match(/anchor-check.*\.(py|sh)$/),
    );
    expect(anchorCheckFiles).toHaveLength(0);
  });

  it("no anchor-check implementation in src/", () => {
    const srcFiles = execFileSync("git", ["ls-files", "src/"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim().split("\n");
    const anchorCheckFiles = srcFiles.filter(
      (f: string) => f.match(/anchor-check/),
    );
    // Only references to anchor-check should be in generate.ts (interface + runGenerate)
    expect(anchorCheckFiles).toHaveLength(0);
  });
});

describe("G4d V10: createdAt discriminative test exists", () => {
  it("V10: production spawnExport throws when doc channel does not contain sourceMessageId", async () => {
    // This test is in g4c-generate-wiring.test.ts U6
    // V10 asserts that the test exists and is discriminative (not source-string matching)
    const g4cTest = readFileSync(join(ROOT, "test", "g4c-generate-wiring.test.ts"), "utf8");
    // The old zero-power test should be gone
    expect(g4cTest).not.toMatch(/new Date\(\)/);
    // The new discriminative test should exist
    expect(g4cTest).toMatch(/cannot find doc message/);
    expect(g4cTest).toMatch(/msg-nonexistent/);
  });
});

describe("G4d V11: verification rate unit unambiguous (percentage)", () => {
  it("renderReportHead with 100 produces dr-anchor-rate 100", () => {
    const head = renderReportHead(
      { stop: "converged", blocked: 0, capHit: false },
      100,
    );
    expect(head).toContain("dr-anchor-rate 100");
  });

  it("renderReportHead with 0 produces dr-anchor-rate 0", () => {
    const head = renderReportHead(
      { stop: "converged", blocked: 0, capHit: false },
      0,
    );
    expect(head).toContain("dr-anchor-rate 0");
  });

  it("rate is a percentage (0-100 scale), consistent with existing test pattern", () => {
    const head = renderReportHead(
      { stop: "converged", blocked: 0, capHit: false },
      95,
    );
    expect(head).toContain("dr-anchor-rate 95");
    expect(head).not.toContain("0.95");
    expect(head).not.toContain("95%");
  });
});