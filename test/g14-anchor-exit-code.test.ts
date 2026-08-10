/**
 * G14 —— anchor-check 用非零退出码表达结果，生产却当成崩溃：
 * 核验率与 anchor-check.json 双双丢失。
 *
 * 硬验收 V1–V6（spec §2）。
 * 每个案例用真实 shell 假二进制驱动生产 spawnAnchorCheck，
 * 而不 mock execFileSync（spec V1 要求）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync, rmSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  runGenerate,
  DEFAULT_GENERATE_CONFIG,
  type AnchorCheckResult,
  type GenerateDeps,
} from "../src/generate";
import { assembleGenerateDeps } from "../src/tick-run";
import type { TerminationState, BoardState } from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHANNEL = "research:p02-smoke-g14";

function createAnchorCheckStub(script: string): string {
  const stub = join(tmpdir(), `anchor-check-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  writeFileSync(stub, `#!/bin/sh\n${script}`);
  chmodSync(stub, 0o755);
  return stub;
}

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

function postWriteState(): BoardState {
  return { cards: [], runs: {}, triageInFlight: false };
}

function stubFetchEmpty() {
  vi.stubGlobal("fetch", async () => ({
    ok: true,
    status: 200,
    json: async () => ({ messages: [] }),
    text: async () => JSON.stringify({ messages: [] }),
  }));
}

afterEach(() => {
  delete process.env.ANCHOR_CHECK_BIN;
  delete process.env.EXPORT_ROOT;
});

describe("G14 V1: exit 1 + valid JSON => normal result (rate in head, not unavailable)", () => {
  it("production spawnAnchorCheck returns parsed result when anchor-check exits 1 with valid JSON", async () => {
    const ac = anchorResult({ total: 424, current_verified_hit: 408 });
    const stub = createAnchorCheckStub(`printf '${JSON.stringify(ac)}'; exit 1`);
    process.env.ANCHOR_CHECK_BIN = stub;

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
    const ac = anchorResult({ total: 424, current_verified_hit: 408 });
    const stub = createAnchorCheckStub(`printf '${JSON.stringify(ac)}'; exit 1`);
    process.env.ANCHOR_CHECK_BIN = stub;
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
    const ac = anchorResult({ total: 424, current_verified_hit: 408 });
    const stub = createAnchorCheckStub(`printf '${JSON.stringify(ac)}'; exit 1`);
    process.env.ANCHOR_CHECK_BIN = stub;
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
    const ac = anchorResult({ total: 424, sums_ok: false });
    const stub = createAnchorCheckStub(`printf '${JSON.stringify(ac)}'; exit 3`);
    process.env.ANCHOR_CHECK_BIN = stub;

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
    const ac = anchorResult({ total: 424, sums_ok: false });
    const stub = createAnchorCheckStub(`printf '${JSON.stringify(ac)}'; exit 3`);
    process.env.ANCHOR_CHECK_BIN = stub;
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
    const ac = anchorResult({ total: 0, current_parsed: 0, current_verified_hit: 0 });
    const stub = createAnchorCheckStub(`printf '${JSON.stringify(ac)}'; exit 2`);
    process.env.ANCHOR_CHECK_BIN = stub;

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
    const stub = createAnchorCheckStub(`printf 'garbage output'; exit 1`);
    process.env.ANCHOR_CHECK_BIN = stub;

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
    const stub = createAnchorCheckStub(`printf 'garbage'; exit 1`);
    process.env.ANCHOR_CHECK_BIN = stub;
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
    const ac = anchorResult();
    const stub = createAnchorCheckStub(`printf '${JSON.stringify(ac)}'; exit 0`);
    process.env.ANCHOR_CHECK_BIN = stub;

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
});

describe("G14 V6: assertions drive production assembleGenerateDeps through real subprocess", () => {
  it("V1 spawnAnchorCheck test uses assembleGenerateDeps with real shell stub", async () => {
    const ac = anchorResult({ total: 424, current_verified_hit: 408 });
    const stub = createAnchorCheckStub(`printf '${JSON.stringify(ac)}'; exit 1`);
    process.env.ANCHOR_CHECK_BIN = stub;

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

    const result = await deps.spawnAnchorCheck();
    expect(result.total).toBe(424);
    expect(result.current_verified_hit).toBe(408);
  });

  it("V3 spawnAnchorCheck test uses assembleGenerateDeps with real shell stub", async () => {
    const ac = anchorResult({ sums_ok: false });
    const stub = createAnchorCheckStub(`printf '${JSON.stringify(ac)}'; exit 3`);
    process.env.ANCHOR_CHECK_BIN = stub;

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

    const result = await deps.spawnAnchorCheck();
    expect(result.total).toBe(424);
    expect(result.sums_ok).toBe(false);
  });

  it("V4 spawnAnchorCheck test uses assembleGenerateDeps with real shell stub", async () => {
    const stub = createAnchorCheckStub(`printf 'garbage'; exit 1`);
    process.env.ANCHOR_CHECK_BIN = stub;

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

    await expect(deps.spawnAnchorCheck()).rejects.toThrow(/anchor-check exit 1/);
  });
});