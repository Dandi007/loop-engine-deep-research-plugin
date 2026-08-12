/**
 * G4d(v2) —— anchor-check 确定性接线：核验率来源必须是机械的。
 *
 * 硬验收 V1–V11（spec §5）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
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
  MissingAnchorCheckRepoRootError,
  type AnchorCheckResult,
  type GenerateDeps,
} from "../src/generate";
import { slugify } from "../src/export";
import { assembleGenerateDeps, MissingExportRootError } from "../src/tick-run";
import type { TerminationState, BoardState } from "../src/tick";

const { mockExecFileSync } = vi.hoisted(() => {
  const fn = vi.fn();
  return { mockExecFileSync: fn };
});

vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return {
    ...actual,
    execFileSync: ((cmd: string, args?: readonly string[], options?: Record<string, unknown>) => {
      if (cmd === "git") {
        return (actual.execFileSync as Function)(cmd, args, options);
      }
      return (mockExecFileSync as Function)(cmd, args, options);
    }),
  };
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANNEL = "research:p02-smoke-g4d";

function term(over: Partial<TerminationState> = {}): TerminationState {
  return {
    state: "converged",
    coverage: 0,
    zeroGrowthRounds: 3,
    capHit: false,
    boardComposition: { proposed: 0, open: 0, inFlight: 0, explored: 0, blocked: 0 },
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

function postWriteState(): BoardState {
  return { cards: [], runs: {}, triageInFlight: false };
}

afterEach(() => {
  mockExecFileSync.mockReset();
  delete process.env.ANCHOR_CHECK_BIN;
  delete process.env.EXPORT_ROOT;
});

describe("G4d V1: no longer via route — spawnAnchorCheck is a subprocess call", () => {
  it("production spawnAnchorCheck records argv with ANCHOR_CHECK_BIN and --json", async () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    mockExecFileSync.mockReturnValue(JSON.stringify(anchorResult()));

    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
        allowedRoot: "/fake/repo",
      },
      term(),
      postWriteState(),
    );

    await deps.spawnAnchorCheck();
    const callArgs = mockExecFileSync.mock.calls[0];
    expect(callArgs[0]).toBe("/fake/anchor-check");
    expect(callArgs[1]).toContain("--json");
    expect(callArgs[1]).toContain("--repo-root");
    expect(callArgs[1]).toContain("/fake/repo");
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

    expect(sumsOkFalseBody).toContain("sums_ok=false");
    expect(crashBody).not.toContain("sums_ok=false");
    expect(crashBody).toContain("dr-anchor-rate unavailable");
  });
});

describe("G4d V5: ANCHOR_CHECK_BIN not configured ⇒ unavailable", () => {
  it("production assembleGenerateDeps spawnAnchorCheck throws when ANCHOR_CHECK_BIN is not set", async () => {
    const prevAnchor = process.env.ANCHOR_CHECK_BIN;
    delete process.env.ANCHOR_CHECK_BIN;
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
        postWriteState(),
      );
      await expect(deps.spawnAnchorCheck()).rejects.toThrow(/ANCHOR_CHECK_BIN/);
    } finally {
      if (prevAnchor !== undefined) {
        process.env.ANCHOR_CHECK_BIN = prevAnchor;
      } else {
        delete process.env.ANCHOR_CHECK_BIN;
      }
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
  it("V7 discriminative: production spawnAnchorCheck records --repo-root in argv", async () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    mockExecFileSync.mockReturnValue(JSON.stringify(anchorResult()));

    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
        allowedRoot: "/fake/repo",
      },
      term(),
      postWriteState(),
    );

    await deps.spawnAnchorCheck();
    const callArgs = mockExecFileSync.mock.calls[0];
    expect(callArgs[1]).toContain("--repo-root");
    expect(callArgs[1]).toContain("/fake/repo");
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

  it("V7 discriminative: missing ALLOWED_ROOT produces no-repo-root marker, not bare unavailable", async () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";

    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
      },
      term(),
      postWriteState(),
    );

    await expect(deps.spawnAnchorCheck()).rejects.toThrow(MissingAnchorCheckRepoRootError);
  });
});

describe("G4d V8: anchor-check JSON written to export directory; write failure does not block export", () => {
  it("writeAnchorCheckJson writes to EXPORT_ROOT/DeepThought/<slug>/anchor-check.json", async () => {
    const exportRoot = join(tmpdir(), `g4d-v8-${Math.random().toString(36).slice(2)}`);
    process.env.EXPORT_ROOT = exportRoot;
    mkdirSync(exportRoot, { recursive: true });

    const slug = slugify("test question");
    const expectedPath = join(exportRoot, "DeepThought", slug, "anchor-check.json");

    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
      },
      term(),
      postWriteState(),
    );

    const json = JSON.stringify(anchorResult());
    await deps.writeAnchorCheckJson!(json);
    expect(existsSync(expectedPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(expectedPath, "utf8"));
    expect(parsed.total).toBe(10);

    rmSync(exportRoot, { recursive: true, force: true });
  });

  it("writeAnchorCheckJson throws when EXPORT_ROOT is unset (not silent)", async () => {
    delete process.env.EXPORT_ROOT;

    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
      },
      term(),
      postWriteState(),
    );

    await expect(deps.writeAnchorCheckJson!("{}")).rejects.toThrow(MissingExportRootError);
  });

  it("writeAnchorCheckJson failure does not block export (runGenerate)", async () => {
    const deps = baseDeps({
      writeAnchorCheckJson: async () => {
        throw new Error("disk full");
      },
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });

  it("V8 discriminative: production writeAnchorCheckJson uses slugify from export.ts", async () => {
    const exportRoot = join(tmpdir(), `g4d-v8b-${Math.random().toString(36).slice(2)}`);
    process.env.EXPORT_ROOT = exportRoot;
    mkdirSync(exportRoot, { recursive: true });

    const topic = "Hello World & Research!";
    const expectedSlug = slugify(topic);
    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: topic,
      },
      term(),
      postWriteState(),
    );

    const json = JSON.stringify(anchorResult());
    await deps.writeAnchorCheckJson!(json);

    const expectedPath = join(exportRoot, "DeepThought", expectedSlug, "anchor-check.json");
    expect(existsSync(expectedPath)).toBe(true);

    rmSync(exportRoot, { recursive: true, force: true });
  });
});

describe("G4d V9: no self-written anchor-check in repo", () => {
  it("git ls-files shows no anchor-check.py or equivalent", () => {
    const files = execFileSync("git", ["ls-files"], {
      cwd: ROOT,
      encoding: "utf8",
    }).trim().split("\n");
    const anchorCheckFiles = files.filter(
      (f: string) => f.match(/anchor-check.*\.(py|sh)$/),
    );
    expect(anchorCheckFiles).toHaveLength(0);
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

describe("G4d V12: no-repo-root is distinguishable from bare unavailable", () => {
  it("MissingAnchorCheckRepoRootError produces no-repo-root marker, not bare unavailable", async () => {
    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        throw new MissingAnchorCheckRepoRootError();
      }),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    const report = written.find((d) => d.doc_kind === "report");
    expect(report!.body).toContain("dr-anchor-rate unavailable no-repo-root");
  });
});

describe("G4d V13: writeAnchorCheckJson failure is visible in report head", () => {
  it("when writeAnchorCheckJson throws, report body contains anchor-json-write-failed", async () => {
    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = baseDeps({
      writeAnchorCheckJson: async () => {
        throw new Error("write failed");
      },
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    const report = written.find((d) => d.doc_kind === "report");
    expect(report!.body).toContain("anchor-json-write-failed");
  });
});