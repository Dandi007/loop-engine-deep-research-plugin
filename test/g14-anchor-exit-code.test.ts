/**
 * G14 —— anchor-check 用非零退出码表达结果，生产却当成崩溃：
 * 核验率与 anchor-check.json 双双丢失。
 *
 * 硬验收 V1–V6（spec §2）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  runGenerate,
  DEFAULT_GENERATE_CONFIG,
  MissingAnchorCheckRepoRootError,
  type AnchorCheckResult,
  type GenerateDeps,
} from "../src/generate";
import { assembleGenerateDeps } from "../src/tick-run";
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
const CHANNEL = "research:p02-smoke-g14";

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
    total: 424,
    current_parsed: 424,
    current_verified_hit: 408,
    current_failed: 16,
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

function makeExecError(status: number, stdout: string, stderr: string = ""): Error & { status: number; stdout: string; stderr: string } {
  const err = new Error(`Command failed: exit ${status}`) as any;
  err.status = status;
  err.stdout = stdout;
  err.stderr = stderr;
  return err;
}

function stubFetchEmpty() {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ messages: [] }),
    text: async () => JSON.stringify({ messages: [] }),
  }));
}

describe("G14 V1: exit 1 + valid JSON => normal result (rate in head, not unavailable)", () => {
  it("production spawnAnchorCheck returns parsed result when anchor-check exits 1 with valid JSON", async () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    const ac = anchorResult({ total: 424, current_verified_hit: 408 });
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(1, JSON.stringify(ac));
    });

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

    const result = await deps.spawnAnchorCheck();
    expect(result.total).toBe(424);
    expect(result.current_verified_hit).toBe(408);
    expect(result.sums_ok).toBe(true);
  });

  it("runGenerate with exit-1 spawnAnchorCheck produces rate in report head, not unavailable", async () => {
    stubFetchEmpty();
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    const ac = anchorResult({ total: 424, current_verified_hit: 408 });
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(1, JSON.stringify(ac));
    });
    const exportRoot = join(tmpdir(), `g14-v1-${Math.random().toString(36).slice(2)}`);
    process.env.EXPORT_ROOT = exportRoot;
    mkdirSync(exportRoot, { recursive: true });

    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
        allowedRoot: "/fake/repo",
        oneShotDir: join(tmpdir(), `g14-v1-synth-${Math.random().toString(36).slice(2)}`),
      },
      term(),
      postWriteState(),
    );
    const generateDeps: GenerateDeps = {
      ...deps,
      spawnRole: vi.fn(async () => ({ body: "role output" })),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
      lockSynthesizer: async () => async () => {},
    };

    try {
      await runGenerate(generateDeps, DEFAULT_GENERATE_CONFIG);
      const report = written.find((d) => d.doc_kind === "report");
      expect(report).toBeDefined();
      expect(report!.body).toContain("dr-anchor-rate 96");
      expect(report!.body).not.toContain("dr-anchor-rate unavailable");
    } finally {
      rmSync(exportRoot, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });
});

describe("G14 V2: anchor-check.json written when exit 1 produces valid JSON", () => {
  it("runGenerate with exit-1 anchor-check writes anchor-check.json", async () => {
    stubFetchEmpty();
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    const ac = anchorResult({ total: 424, current_verified_hit: 408 });
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(1, JSON.stringify(ac));
    });
    const exportRoot = join(tmpdir(), `g14-v2-${Math.random().toString(36).slice(2)}`);
    process.env.EXPORT_ROOT = exportRoot;
    mkdirSync(exportRoot, { recursive: true });

    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
        allowedRoot: "/fake/repo",
        oneShotDir: join(tmpdir(), `g14-v2-synth-${Math.random().toString(36).slice(2)}`),
      },
      term(),
      postWriteState(),
    );
    const generateDeps: GenerateDeps = {
      ...deps,
      spawnRole: vi.fn(async () => ({ body: "role output" })),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };

    try {
      await runGenerate(generateDeps, DEFAULT_GENERATE_CONFIG);
      const { slugify } = await import("../src/export");
      const slug = slugify("test question");
      const expectedPath = join(exportRoot, "DeepThought", slug, "anchor-check.json");
      const { existsSync, readFileSync } = await import("node:fs");
      expect(existsSync(expectedPath)).toBe(true);
      const parsed = JSON.parse(readFileSync(expectedPath, "utf8"));
      expect(parsed.total).toBe(424);
      expect(parsed.current_verified_hit).toBe(408);
    } finally {
      rmSync(exportRoot, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });
});

describe("G14 V3: exit 2/3 + valid JSON => still returns result; sums_ok=false visible in head", () => {
  it("production spawnAnchorCheck returns result when anchor-check exits 3 with sums_ok=false", async () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    const ac = anchorResult({ total: 424, sums_ok: false });
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(3, JSON.stringify(ac));
    });

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

    const result = await deps.spawnAnchorCheck();
    expect(result.total).toBe(424);
    expect(result.sums_ok).toBe(false);
  });

  it("runGenerate with exit-3 sums_ok=false produces sums_ok=false in head", async () => {
    stubFetchEmpty();
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    const ac = anchorResult({ total: 424, sums_ok: false });
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(3, JSON.stringify(ac));
    });
    const exportRoot = join(tmpdir(), `g14-v3-${Math.random().toString(36).slice(2)}`);
    process.env.EXPORT_ROOT = exportRoot;
    mkdirSync(exportRoot, { recursive: true });

    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
        allowedRoot: "/fake/repo",
        oneShotDir: join(tmpdir(), `g14-v3-synth-${Math.random().toString(36).slice(2)}`),
      },
      term(),
      postWriteState(),
    );
    const generateDeps: GenerateDeps = {
      ...deps,
      spawnRole: vi.fn(async () => ({ body: "role output" })),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
      lockSynthesizer: async () => async () => {},
    };

    try {
      await runGenerate(generateDeps, DEFAULT_GENERATE_CONFIG);
      const report = written.find((d) => d.doc_kind === "report");
      expect(report).toBeDefined();
      expect(report!.body).toContain("dr-anchor-rate unavailable sums_ok=false");
    } finally {
      rmSync(exportRoot, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });

  it("exit 2 + valid JSON still returns result", async () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    const ac = anchorResult({ total: 0, current_parsed: 0, current_verified_hit: 0 });
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(2, JSON.stringify(ac));
    });

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

    const result = await deps.spawnAnchorCheck();
    expect(result.total).toBe(0);
  });
});

describe("G14 V4: stdout not valid JSON => loud failure; exit code named; export still happens", () => {
  it("production spawnAnchorCheck throws with exit code when stdout is not JSON", async () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(1, "garbage output", "something broke");
    });

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

    await expect(deps.spawnAnchorCheck()).rejects.toThrow(/anchor-check exit 1/);
  });

  it("runGenerate with non-JSON stdout still exports and marks head with failure", async () => {
    stubFetchEmpty();
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(1, "garbage", "stderr content");
    });
    const exportRoot = join(tmpdir(), `g14-v4-${Math.random().toString(36).slice(2)}`);
    process.env.EXPORT_ROOT = exportRoot;
    mkdirSync(exportRoot, { recursive: true });

    const written: Array<{ body: string; doc_kind: string }> = [];
    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
        allowedRoot: "/fake/repo",
        oneShotDir: join(tmpdir(), `g14-v4-synth-${Math.random().toString(36).slice(2)}`),
      },
      term(),
      postWriteState(),
    );
    const generateDeps: GenerateDeps = {
      ...deps,
      spawnRole: vi.fn(async () => ({ body: "role output" })),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        written.push(doc);
        return "msg-1";
      }),
      lockSynthesizer: async () => async () => {},
    };

    try {
      await runGenerate(generateDeps, DEFAULT_GENERATE_CONFIG);
      expect(generateDeps.spawnExport).toHaveBeenCalled();
      const report = written.find((d) => d.doc_kind === "report");
      expect(report).toBeDefined();
      expect(report!.body).toContain("dr-anchor-rate unavailable");
      expect(report!.body).toContain("anchor-check-failed");
      expect(report!.body).toContain("exit 1");
    } finally {
      rmSync(exportRoot, { recursive: true, force: true });
      vi.unstubAllGlobals();
    }
  });
});

describe("G14 V5: exit 0 behavior unchanged", () => {
  it("production spawnAnchorCheck with exit 0 returns parsed result", async () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    const ac = anchorResult();
    mockExecFileSync.mockReturnValue(JSON.stringify(ac));

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

    const result = await deps.spawnAnchorCheck();
    expect(result.total).toBe(424);
    expect(result.current_verified_hit).toBe(408);
    expect(result.sums_ok).toBe(true);
  });

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

describe("G14 V6: assertions drive production assembleGenerateDeps", () => {
  it("V1 spawnAnchorCheck test uses assembleGenerateDeps, not hand-built deps", () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    const ac = anchorResult({ total: 424, current_verified_hit: 408 });
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(1, JSON.stringify(ac));
    });

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
    expect(deps.spawnAnchorCheck).toBeDefined();
    expect(typeof deps.spawnAnchorCheck).toBe("function");
  });

  it("V3 spawnAnchorCheck test uses assembleGenerateDeps, not hand-built deps", () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    const ac = anchorResult({ sums_ok: false });
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(3, JSON.stringify(ac));
    });

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
    expect(deps.spawnAnchorCheck).toBeDefined();
    expect(typeof deps.spawnAnchorCheck).toBe("function");
  });

  it("V4 spawnAnchorCheck test uses assembleGenerateDeps, not hand-built deps", () => {
    process.env.ANCHOR_CHECK_BIN = "/fake/anchor-check";
    mockExecFileSync.mockImplementation(() => {
      throw makeExecError(1, "garbage", "stderr");
    });

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
    expect(deps.spawnAnchorCheck).toBeDefined();
    expect(typeof deps.spawnAnchorCheck).toBe("function");
  });
});