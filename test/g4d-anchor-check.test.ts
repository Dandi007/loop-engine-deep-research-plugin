/**
 * G4d —— anchor-check 确定性接线：核验率的来源自己必须是机械的
 *
 * 硬验收 V1–V7：
 *  - V1  不再经 route/agent-run：spawnAnchorCheck 是子进程调用 tools/anchor-check.py
 *  - V2  核验率口径：分母是 total（判别性：total=10/parsed=1/hit=1 ⇒ 10%，不得 100%）
 *  - V3  total===0 ⇒ 核验率 null（unavailable），不得是 100%
 *  - V4  sums_ok===false ⇒ 核验率 null，不得折算成正常数字
 *  - V5  软闸门不变：核验率 <90% 仍导出但标在头部；崩溃 ⇒ unavailable
 *  - V6  落盘：anchor-check.json 写到导出件同目录；落盘失败不阻断导出
 *  - V7  --repo-root 真的被传（用 ALLOWED_ROOT）；缺失时失败传播
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  computeAnchorCheckResult,
  runGenerate,
  DEFAULT_GENERATE_CONFIG,
  type GenerateDeps,
  type EvidenceView,
} from "../src/generate";
import { assembleGenerateDeps } from "../src/tick-run";
import type { TerminationState, BoardState } from "../src/tick";

function term(over: Partial<TerminationState> = {}): TerminationState {
  return {
    state: "converged",
    coverage: 0,
    zeroGrowthRounds: 3,
    capHit: false,
    ...over,
  };
}

// ── V1: spawnAnchorCheck 是子进程调用 tools/anchor-check.py ──────────────

describe("G4d V1: spawnAnchorCheck is a deterministic subprocess call (no route/agent-run)", () => {
  it("production assembleGenerateDeps spawnAnchorCheck is a function", () => {
    const oneShotDir = join(tmpdir(), `g4d-v1-${randomUUID()}`);
    mkdirSync(oneShotDir, { recursive: true });
    try {
      const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
      const deps = assembleGenerateDeps(
        {
          channelId: "research:test",
          origin: "test-origin",
          docChannelId: "research:doc",
          question: "test question",
          oneShotDir,
        },
        term(),
        postWriteState,
      );
      expect(typeof deps.spawnAnchorCheck).toBe("function");
    } finally {
      rmSync(oneShotDir, { recursive: true, force: true });
    }
  });

  it("spawnAcProcess records argv pointing to tools/anchor-check.py with --json", async () => {
    const oneShotDir = join(tmpdir(), `g4d-v1b-${randomUUID()}`);
    mkdirSync(oneShotDir, { recursive: true });
    try {
      let capturedArgv: string[] = [];
      const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
      const deps = assembleGenerateDeps(
        {
          channelId: "research:test",
          origin: "test-origin",
          docChannelId: "research:doc",
          question: "test question",
          oneShotDir,
          spawnAcProcess: (argv) => {
            capturedArgv = [...argv];
            return JSON.stringify({
              total: 0,
              current_parsed: 0,
              current_verified_hit: 0,
              current_failed: 0,
              old_format: 0,
              unparseable: 0,
              discarded: 0,
              sums_ok: true,
              loud_failures: [],
            });
          },
        },
        term(),
        postWriteState,
      );
      await deps.spawnAnchorCheck();
      expect(capturedArgv.length).toBeGreaterThan(0);
      const joined = capturedArgv.join(" ");
      expect(joined).toContain("anchor-check.py");
      expect(joined).toContain("--json");
      expect(joined).toContain("--corpus");
    } finally {
      rmSync(oneShotDir, { recursive: true, force: true });
    }
  });
});

// ── V2: 核验率口径：分母是 total ──────────────────────────────────────────

describe("G4d V2: verification rate denominator is total (not current_parsed)", () => {
  it("total=10, current_parsed=1, current_verified_hit=1 ⇒ verificationRate = 0.1 (10%)", () => {
    const result = computeAnchorCheckResult({
      total: 10,
      current_parsed: 1,
      current_verified_hit: 1,
      current_failed: 0,
      old_format: 0,
      unparseable: 9,
      discarded: 0,
      sums_ok: true,
      loud_failures: [],
    });
    expect(result.verificationRate).toBe(0.1);
    expect(result.verificationRate).not.toBe(1);
  });

  it("discriminative: if denominator were current_parsed, the rate would be 100% — this test catches that", () => {
    const result = computeAnchorCheckResult({
      total: 10,
      current_parsed: 1,
      current_verified_hit: 1,
      current_failed: 0,
      old_format: 0,
      unparseable: 9,
      discarded: 0,
      sums_ok: true,
      loud_failures: [],
    });
    // If the implementation used current_parsed (1) as denominator, it would return 1.0
    // Our implementation uses total (10), so it returns 0.1
    expect(result.verificationRate).toBeLessThan(0.5);
  });

  it("defects = current_failed + unparseable + old_format + discarded + loud_failures.length", () => {
    const result = computeAnchorCheckResult({
      total: 10,
      current_parsed: 1,
      current_verified_hit: 1,
      current_failed: 0,
      old_format: 0,
      unparseable: 9,
      discarded: 0,
      sums_ok: true,
      loud_failures: [],
    });
    // defects = 0 + 9 + 0 + 0 + 0 = 9
    expect(result.defects).toBe(9);
  });
});

// ── V3: total===0 ⇒ 核验率 null ───────────────────────────────────────────

describe("G4d V3: total===0 ⇒ verificationRate null (unavailable, not 100%)", () => {
  it("empty corpus ⇒ verificationRate is null", () => {
    const result = computeAnchorCheckResult({
      total: 0,
      current_parsed: 0,
      current_verified_hit: 0,
      current_failed: 0,
      old_format: 0,
      unparseable: 0,
      discarded: 0,
      sums_ok: true,
      loud_failures: [],
    });
    expect(result.verificationRate).toBeNull();
    expect(result.defects).toBe(0);
  });

  it("discriminative: total=0 must NOT return verificationRate=1", () => {
    const result = computeAnchorCheckResult({
      total: 0,
      current_parsed: 0,
      current_verified_hit: 0,
      current_failed: 0,
      old_format: 0,
      unparseable: 0,
      discarded: 0,
      sums_ok: true,
      loud_failures: [],
    });
    expect(result.verificationRate).not.toBe(1);
    expect(result.verificationRate).not.toBe(0);
    expect(result.verificationRate).toBeNull();
  });
});

// ── V4: sums_ok===false ⇒ 核验率 null ─────────────────────────────────────

describe("G4d V4: sums_ok===false ⇒ verificationRate null (not a normal number)", () => {
  it("sums_ok=false ⇒ verificationRate is null, defects = total", () => {
    const result = computeAnchorCheckResult({
      total: 5,
      current_parsed: 3,
      current_verified_hit: 2,
      current_failed: 1,
      old_format: 1,
      unparseable: 0,
      discarded: 1,
      sums_ok: false,
      loud_failures: [],
    });
    expect(result.verificationRate).toBeNull();
    expect(result.defects).toBe(5);
  });

  it("discriminative: sums_ok=false must NOT be folded into a normal-looking rate", () => {
    const result = computeAnchorCheckResult({
      total: 100,
      current_parsed: 95,
      current_verified_hit: 95,
      current_failed: 0,
      old_format: 0,
      unparseable: 0,
      discarded: 5,
      sums_ok: false,
      loud_failures: [],
    });
    // If sums_ok were ignored, the rate would be 95/100 = 0.95
    // But sums_ok=false must nullify the rate
    expect(result.verificationRate).toBeNull();
    expect(result.verificationRate).not.toBe(0.95);
  });
});

// ── V5: 软闸门不变 ────────────────────────────────────────────────────────

describe("G4d V5: soft gate unchanged — rate <90% exports with header; crash ⇒ unavailable", () => {
  it("rate < 90% (e.g. 50%) still exports, rate shown in header", async () => {
    const exportCalls: Array<{ body: string }> = [];
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "output" })),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 5, verificationRate: 0.5 })),
      spawnExport: vi.fn(async (body: string) => {
        exportCalls.push({ body });
      }),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(exportCalls.length).toBe(1);
    expect(exportCalls[0].body).toContain("dr-anchor-rate 0.5");
  });

  it("rate >= 90% exports with rate in header", async () => {
    const exportCalls: Array<{ body: string }> = [];
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "output" })),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 0.95 })),
      spawnExport: vi.fn(async (body: string) => {
        exportCalls.push({ body });
      }),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(exportCalls.length).toBe(1);
    expect(exportCalls[0].body).toContain("dr-anchor-rate 0.95");
  });

  it("crash (spawnAnchorCheck throws) ⇒ head shows unavailable, export still happens", async () => {
    const exportCalls: Array<{ body: string }> = [];
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "output" })),
      spawnAnchorCheck: vi.fn(async () => {
        throw new Error("subprocess crashed");
      }),
      spawnExport: vi.fn(async (body: string) => {
        exportCalls.push({ body });
      }),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(exportCalls.length).toBe(1);
    expect(exportCalls[0].body).toContain("dr-anchor-rate unavailable");
  });

  it("verificationRate=null returned from spawnAnchorCheck ⇒ head shows unavailable", async () => {
    const exportCalls: Array<{ body: string }> = [];
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "output" })),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: null })),
      spawnExport: vi.fn(async (body: string) => {
        exportCalls.push({ body });
      }),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
    expect(exportCalls.length).toBe(1);
    expect(exportCalls[0].body).toContain("dr-anchor-rate unavailable");
  });
});

// ── V6: 落盘：anchor-check.json 写到导出件同目录 ──────────────────────────

describe("G4d V6: anchor-check.json written to export directory", () => {
  afterEach(() => {
    delete process.env.EXPORT_ROOT;
  });

  it("when EXPORT_ROOT and question are set, anchor-check.json is written", async () => {
    const oneShotDir = join(tmpdir(), `g4d-v6-${randomUUID()}`);
    const exportRoot = join(tmpdir(), `g4d-v6-export-${randomUUID()}`);
    mkdirSync(oneShotDir, { recursive: true });
    mkdirSync(exportRoot, { recursive: true });
    const prevExportRoot = process.env.EXPORT_ROOT;
    process.env.EXPORT_ROOT = exportRoot;
    try {
      const spawnAcProcess = vi.fn((_argv: string[]) =>
        JSON.stringify({
          total: 2,
          current_parsed: 2,
          current_verified_hit: 2,
          current_failed: 0,
          old_format: 0,
          unparseable: 0,
          discarded: 0,
          sums_ok: true,
          loud_failures: [],
        }),
      );
      const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
      const deps = assembleGenerateDeps(
        {
          channelId: "research:test",
          origin: "test-origin",
          docChannelId: "research:doc",
          question: "Test Question For Anchor Check",
          oneShotDir,
          spawnAcProcess,
        },
        term(),
        postWriteState,
      );
      await deps.spawnAnchorCheck();
      expect(spawnAcProcess).toHaveBeenCalledTimes(1);
      const slug = "test-question-for-anchor-check";
      const reportPath = join(exportRoot, "DeepThought", slug, "anchor-check.json");
      const content = readFileSync(reportPath, "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.total).toBe(2);
    } finally {
      process.env.EXPORT_ROOT = prevExportRoot;
      rmSync(oneShotDir, { recursive: true, force: true });
      rmSync(exportRoot, { recursive: true, force: true });
    }
  });

  it("write failure does not block export (spawnAnchorCheck still succeeds)", async () => {
    const oneShotDir = join(tmpdir(), `g4d-v6b-${randomUUID()}`);
    mkdirSync(oneShotDir, { recursive: true });
    // Use a path that cannot be written to (e.g., a file where a directory should be)
    const badExportRoot = join(tmpdir(), `g4d-v6b-export-${randomUUID()}`);
    // Create a file at the export root to make mkdirSync fail
    writeFileSync(badExportRoot, "block");
    const prevExportRoot = process.env.EXPORT_ROOT;
    process.env.EXPORT_ROOT = badExportRoot;
    try {
      const spawnAcProcess = vi.fn((_argv: string[]) =>
        JSON.stringify({
          total: 1,
          current_parsed: 1,
          current_verified_hit: 1,
          current_failed: 0,
          old_format: 0,
          unparseable: 0,
          discarded: 0,
          sums_ok: true,
          loud_failures: [],
        }),
      );
      const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
      const deps = assembleGenerateDeps(
        {
          channelId: "research:test",
          origin: "test-origin",
          docChannelId: "research:doc",
          question: "Test Question",
          oneShotDir,
          spawnAcProcess,
        },
        term(),
        postWriteState,
      );
      // Should not throw despite write failure
      const result = await deps.spawnAnchorCheck();
      expect(result.verificationRate).toBe(1);
      expect(spawnAcProcess).toHaveBeenCalledTimes(1);
    } finally {
      process.env.EXPORT_ROOT = prevExportRoot;
      rmSync(oneShotDir, { recursive: true, force: true });
      rmSync(badExportRoot, { recursive: true, force: true });
    }
  });
});

// ── V7: --repo-root 真的被传 ──────────────────────────────────────────────

describe("G4d V7: --repo-root is passed via ALLOWED_ROOT", () => {
  it("when allowedRoot is set, --repo-root appears in argv", async () => {
    const oneShotDir = join(tmpdir(), `g4d-v7-${randomUUID()}`);
    mkdirSync(oneShotDir, { recursive: true });
    try {
      let capturedArgv: string[] = [];
      const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
      const deps = assembleGenerateDeps(
        {
          channelId: "research:test",
          origin: "test-origin",
          docChannelId: "research:doc",
          question: "test question",
          allowedRoot: "/data/code/self/agent-runtime",
          oneShotDir,
          spawnAcProcess: (argv) => {
            capturedArgv = [...argv];
            return JSON.stringify({
              total: 0,
              current_parsed: 0,
              current_verified_hit: 0,
              current_failed: 0,
              old_format: 0,
              unparseable: 0,
              discarded: 0,
              sums_ok: true,
              loud_failures: [],
            });
          },
        },
        term(),
        postWriteState,
      );
      await deps.spawnAnchorCheck();
      const joined = capturedArgv.join(" ");
      expect(joined).toContain("--repo-root");
      expect(joined).toContain("/data/code/self/agent-runtime");
    } finally {
      rmSync(oneShotDir, { recursive: true, force: true });
    }
  });

  it("when allowedRoot is not set and ALLOWED_ROOT env is set, --repo-root still appears", async () => {
    const oneShotDir = join(tmpdir(), `g4d-v7b-${randomUUID()}`);
    mkdirSync(oneShotDir, { recursive: true });
    const prevAllowedRoot = process.env.ALLOWED_ROOT;
    process.env.ALLOWED_ROOT = "/data/code/self/agent-runtime";
    try {
      let capturedArgv: string[] = [];
      const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
      const deps = assembleGenerateDeps(
        {
          channelId: "research:test",
          origin: "test-origin",
          docChannelId: "research:doc",
          question: "test question",
          oneShotDir,
          spawnAcProcess: (argv) => {
            capturedArgv = [...argv];
            return JSON.stringify({
              total: 0,
              current_parsed: 0,
              current_verified_hit: 0,
              current_failed: 0,
              old_format: 0,
              unparseable: 0,
              discarded: 0,
              sums_ok: true,
              loud_failures: [],
            });
          },
        },
        term(),
        postWriteState,
      );
      await deps.spawnAnchorCheck();
      const joined = capturedArgv.join(" ");
      expect(joined).toContain("--repo-root");
    } finally {
      process.env.ALLOWED_ROOT = prevAllowedRoot;
      rmSync(oneShotDir, { recursive: true, force: true });
    }
  });
});