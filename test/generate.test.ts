import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  runGenerate,
  decideGenerate,
  buildReportMarker,
  renderReportBody,
  parseReportMarker,
  renderReportHead,
  deriveDocKind,
  computeDocDigest,
  assertDocBodyWithinLimit,
  buildDoc,
  serializeCorpusToPositional,
  spawnGenerateRole,
  MAX_DOC_BODY_BYTES,
  DEFAULT_GENERATE_CONFIG,
} from "../src/generate";
import type {
  AnchorCheckResult,
  GenerateConfig,
  GenerateDeps,
  GenerateSpawnRuntime,
  ReportMarker,
  DebaterCorpus,
  SynthesizerCorpus,
} from "../src/generate";

/** Helper: construct an AnchorCheckResult with sensible defaults (100% rate). */
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
import type { DocV2 } from "../src/protocol";
import type { TerminationState } from "../src/tick";

const cfg: GenerateConfig = DEFAULT_GENERATE_CONFIG;

const DEBATER_ROLES = new Set([
  "dr-debater-advocate",
  "dr-debater-opponent",
  "dr-debater-judge",
]);

function debaterSpawns(deps: GenerateDeps): unknown[][] {
  const spawnRole = deps.spawnRole as ReturnType<typeof vi.fn>;
  return spawnRole.mock.calls.filter((c) => DEBATER_ROLES.has(c[0] as string));
}

function synthSpawns(deps: GenerateDeps): unknown[][] {
  const spawnRole = deps.spawnRole as ReturnType<typeof vi.fn>;
  return spawnRole.mock.calls.filter((c) => c[0] === "dr-synthesizer");
}

function term(over: Partial<TerminationState> = {}): TerminationState {
  return {
    state: "converged",
    coverage: 0,
    zeroGrowthRounds: 0,
    capHit: false,
    ...over,
  };
}

/** 立即完成的空 deps 骨架，测试按需覆写。 */
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

describe("S4 gate (D1/D2/D3)", () => {
  it("D1: state===null does not start the generation phase (no spawns at all)", async () => {
    const deps = baseDeps({ readTermination: async () => term({ state: null }) });
    expect(decideGenerate(term({ state: null }))).toBe(false);
    await runGenerate(deps, cfg);
    expect(deps.spawnRole).toHaveBeenCalledTimes(0);
    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(0);
    expect(deps.spawnExport).toHaveBeenCalledTimes(0);
    expect(deps.writeDoc).toHaveBeenCalledTimes(0);
  });

  it("D2: capHit=true but state===null (draining) does not start generation", async () => {
    const deps = baseDeps({
      readTermination: async () => term({ state: null, capHit: true }),
    });
    expect(decideGenerate(term({ state: null, capHit: true }))).toBe(false);
    await runGenerate(deps, cfg);
    expect(deps.spawnRole).toHaveBeenCalledTimes(0);
    expect(deps.spawnExport).toHaveBeenCalledTimes(0);
  });

  it("D3: every non-empty terminal state starts the generation phase", async () => {
    for (const state of ["converged", "capped", "partial"] as const) {
      const deps = baseDeps({ readTermination: async () => term({ state }) });
      await runGenerate(deps, cfg);
      expect(deps.spawnRole).toHaveBeenCalledTimes(4);
      expect(deps.spawnExport).toHaveBeenCalledTimes(1);
    }
  });
});

describe("S4 debaters (D4/D16)", () => {
  it("D4: exactly 3 debaters are spawned (advocate/opponent/judge) plus the synthesizer", async () => {
    const deps = baseDeps();
    await runGenerate(deps, cfg);
    expect(debaterSpawns(deps)).toHaveLength(3);
    expect(synthSpawns(deps)).toHaveLength(1);
  });

  it("D16: custom debater roles are the ones used (role truth is in role YAML, not config)", async () => {
    const roles: string[] = [];
    const custom: GenerateConfig = {
      ...cfg,
      debaters: [
        { role: "dr-debater-advocate" },
        { role: "dr-debater-opponent" },
        { role: "dr-debater-judge" },
      ],
    };
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string) => {
        if (role !== "dr-synthesizer") roles.push(role);
        return { body: "out" };
      }),
    });
    await runGenerate(deps, custom);
    expect(roles).toEqual(["dr-debater-advocate", "dr-debater-opponent", "dr-debater-judge"]);
  });
});

describe("S4 ordering (D7/D8)", () => {
  it("D7: all 3 debaters complete before the synthesizer (shared call sequence)", async () => {
    const seq: string[] = [];
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string) => {
        seq.push(role);
        return { body: "out" };
      }),
    });
    await runGenerate(deps, cfg);
    const synIdx = seq.indexOf("dr-synthesizer");
    expect(seq.filter((r) => DEBATER_ROLES.has(r))).toHaveLength(3);
    for (const r of DEBATER_ROLES) {
      expect(seq.indexOf(r)).toBeLessThan(synIdx);
    }
  });

  it("D8: synthesizer → anchor-check → export are strictly ordered (shared sequence)", async () => {
    const seq: string[] = [];
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string) => {
        seq.push(role);
        return { body: "out" };
      }),
      spawnAnchorCheck: vi.fn(async () => {
        seq.push("anchor-check");
        return anchorResult();
      }),
      spawnExport: vi.fn(async () => {
        seq.push("export");
      }),
    });
    await runGenerate(deps, cfg);
    const synIdx = seq.indexOf("dr-synthesizer");
    const anchorIdx = seq.indexOf("anchor-check");
    const exportIdx = seq.indexOf("export");
    expect(synIdx).toBeGreaterThanOrEqual(0);
    expect(synIdx).toBeLessThan(anchorIdx);
    expect(anchorIdx).toBeLessThan(exportIdx);
  });
});

describe("S4 singleton synthesizer lock (D6/serial)", () => {
  it("D6: while one synthesizer is pending, the lock serializes — no second synthesizer spawn; synthesizer is never skipped", async () => {
    let locked = false;
    let waiters: Array<() => void> = [];
    let resolveSynth!: () => void;
    const gate = new Promise<void>((r) => {
      resolveSynth = r;
    });
    const spawnRole = vi.fn(async (role: string) => {
      if (role === "dr-synthesizer") {
        await gate;
      }
      return { body: "out" };
    });
    const lockSynth = vi.fn(async () => {
      if (locked) {
        await new Promise<void>((r) => waiters.push(r));
      }
      locked = true;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        locked = false;
        const w = waiters;
        waiters = [];
        w.forEach((r) => r());
      };
    });
    const deps = baseDeps({
      spawnRole,
      lockSynthesizer: lockSynth,
    });

    const first = runGenerate(deps, cfg);
    await vi.waitFor(() => expect(synthSpawns(deps)).toHaveLength(1));

    const second = runGenerate(deps, cfg);
    await new Promise((r) => setTimeout(r, 20));
    expect(synthSpawns(deps)).toHaveLength(1);

    resolveSynth();
    await first;
    await second;
    expect(synthSpawns(deps)).toHaveLength(2);
  });

  it("D4: the synthesizer is never skipped — a normal run always spawns it exactly once", async () => {
    const deps = baseDeps();
    await runGenerate(deps, cfg);
    expect(synthSpawns(deps)).toHaveLength(1);
  });
});

describe("S4 anchor-check never blocks export (D9/D10)", () => {
  it("D9: anchor-check throwing an exception does not block export", async () => {
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        throw new Error("anchor-check boom");
      }),
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, cfg);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });

  it("D10: anchor-check reporting defects (non-exception) does not block export", async () => {
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => anchorResult({ total: 5, current_parsed: 5, current_verified_hit: 5 })),
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, cfg);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

describe("G7: corpus reaches the role prompt via --prompt-file (production entry + fake agent-run)", () => {
  it("spawnGenerateRole (production entry) places serialized corpus in --prompt-file, not positional", async () => {
    const recorded: string[][] = [];
    let capturedPromptContent = "";
    const corpus: DebaterCorpus = {
      question: "research question?",
      evidences: [
        {
          clue_id: "c1",
          anchor: "code://repo@abc123:src/foo.ts#L42",
          quote: "exact quoted text",
          claim: "one-sentence claim",
        },
      ],
    };
    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-1",
      writeInputFile: () => "/tmp/payload.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        const pfIdx = argv.indexOf("--prompt-file");
        capturedPromptContent = readFileSync(argv[pfIdx + 1], "utf8");
        return {};
      },
      readBody: async () => "out",
    };
    await spawnGenerateRole("dr-debater-advocate", corpus, runtime);

    expect(recorded).toHaveLength(1);
    const argv = recorded[0];
    expect(capturedPromptContent).toContain("code://repo@abc123:src/foo.ts#L42");
    expect(capturedPromptContent).toContain("exact quoted text");
    expect(capturedPromptContent).toContain("research question?");
    expect(argv[argv.indexOf("--input") + 1]).toBe("/tmp/payload.json");
    expect(argv.indexOf("--")).toBe(-1);
  });

  it("runGenerate's default spawnRole turns readEvidences corpus into --prompt-file content", async () => {
    const evidences = [
      {
        clue_id: "c1",
        anchor: "code://repo@abc123:src/foo.ts#L42",
        quote: "exact quoted text",
        claim: "one-sentence claim",
      },
    ];
    const recorded: string[][] = [];
    let capturedPromptContent = "";
    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-1",
      writeInputFile: () => "/tmp/payload.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        const pfIdx = argv.indexOf("--prompt-file");
        if (pfIdx >= 0) {
          capturedPromptContent = readFileSync(argv[pfIdx + 1], "utf8");
        }
        return {};
      },
      readBody: async () => "out",
    };
    const deps = baseDeps({
      readEvidences: async () => evidences,
      spawnRole: undefined,
      spawnRuntime: runtime,
    });
    await runGenerate(deps, cfg);

    const advArgv = recorded.find((a) => a.includes("dr-debater-advocate"));
    expect(advArgv).toBeDefined();
    expect(capturedPromptContent).toContain("code://repo@abc123:src/foo.ts#L42");
    expect(capturedPromptContent).toContain("exact quoted text");
    expect(serializeCorpusToPositional({ question: "research question?", evidences })).toContain(
      "code://repo@abc123:src/foo.ts#L42",
    );
  });
});

describe("G2a D2: doc_kind is derived from role, never from payload", () => {
  it("D2: a DEBATER payload carrying doc_kind:'report' still yields research.doc.v2 doc_kind:'argument'", async () => {
    const written: DocV2[] = [];
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string) => {
        if (role === "dr-debater-advocate") {
          return { body: "advocate argument", doc_kind: "report" } as { body: string };
        }
        return { body: "out" };
      }),
      writeDoc: vi.fn(async (doc: DocV2) => {
        written.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(deps, cfg);
    const argumentDocs = written.filter((d) => d.doc_kind === "argument");
    const reportDocs = written.filter((d) => d.doc_kind === "report");
    expect(argumentDocs).toHaveLength(3);
    expect(reportDocs).toHaveLength(1);
    const advocateDoc = written.find((d) => d.body === "advocate argument");
    expect(advocateDoc?.doc_kind).toBe("argument");
  });

  it("D2: deriveDocKind is a pure role→kind mapping", () => {
    expect(deriveDocKind("dr-synthesizer")).toBe("report");
    expect(deriveDocKind("dr-debater-advocate")).toBe("argument");
    expect(deriveDocKind("dr-debater-opponent")).toBe("argument");
    expect(deriveDocKind("dr-debater-judge")).toBe("argument");
  });
});

describe("G2a D5: 4MB body guard (both directions)", () => {
  it("D5: 4MB-1 and 4MB pass; 4MB+1 is rejected", () => {
    const oneLess = "a".repeat(MAX_DOC_BODY_BYTES - 1);
    const atLimit = "a".repeat(MAX_DOC_BODY_BYTES);
    const oneMore = "a".repeat(MAX_DOC_BODY_BYTES + 1);
    expect(() => assertDocBodyWithinLimit(oneLess)).not.toThrow();
    expect(() => assertDocBodyWithinLimit(atLimit)).not.toThrow();
    expect(() => assertDocBodyWithinLimit(oneMore)).toThrow(/exceeds/);
    expect(() => buildDoc("dr-synthesizer", { body: oneMore }, "r")).toThrow(/exceeds/);
  });
});

describe("G2a D6: report body head carries terminal marker + anchor-check rate (soft gate)", () => {
  it("D6: head contains BOTH terminal marker and anchor rate; <90% still exports with annotation", async () => {
    for (const rate of [50, 95]) {
      const written: DocV2[] = [];
      const deps = baseDeps({
        spawnAnchorCheck: vi.fn(async () => anchorResult({ total: 100, current_verified_hit: rate })),
        writeDoc: vi.fn(async (doc: DocV2) => {
          written.push(doc);
          return "msg-1";
        }),
        spawnExport: vi.fn(async () => {}),
      });
      await runGenerate(deps, cfg);
      const report = written.find((d) => d.doc_kind === "report");
      expect(report).toBeDefined();
      expect(report!.body).toMatch(/dr-terminal stop=converged/);
      expect(report!.body).toMatch(new RegExp(`dr-anchor-rate ${rate}`));
      expect(deps.spawnExport).toHaveBeenCalledTimes(1);
    }
  });

  it("D6: renderReportHead emits the terminal line then the anchor-rate line", () => {
    const head = renderReportHead(
      { stop: "converged", blocked: 0, capHit: false },
      87,
    );
    expect(head).toMatch(/dr-terminal stop=converged blocked=0 capHit=false/);
    expect(head).toMatch(/dr-anchor-rate 87/);
    expect(parseReportMarker(head)).toEqual({
      stop: "converged",
      blocked: 0,
      capHit: false,
    });
  });

  it("D6: a genuine 0% rate renders as 0, but a crashed anchor-check renders 'unavailable' (distinguishable)", async () => {
    const genuine: DocV2[] = [];
    const okDeps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => anchorResult({ total: 100, current_verified_hit: 0 })),
      writeDoc: vi.fn(async (doc: DocV2) => {
        genuine.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(okDeps, cfg);
    expect(genuine.find((d) => d.doc_kind === "report")!.body).toContain("dr-anchor-rate 0");

    const crashed: DocV2[] = [];
    const crashDeps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        throw new Error("anchor-check boom");
      }),
      writeDoc: vi.fn(async (doc: DocV2) => {
        crashed.push(doc);
        return "msg-1";
      }),
    });
    await runGenerate(crashDeps, cfg);
    expect(crashed.find((d) => d.doc_kind === "report")!.body).toContain(
      "dr-anchor-rate unavailable",
    );
    expect(crashDeps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

describe("S4 report header (D11/D12/D13/D14/D15)", () => {
  it("D11: header carries the stop reason (converged / capped)", () => {
    expect(renderReportBody({ stop: "converged", blocked: 0, capHit: false })).toContain(
      "stop=converged",
    );
    expect(renderReportBody({ stop: "capped", blocked: 2, capHit: true })).toContain(
      "stop=capped",
    );
  });

  it("D12: header carries the blocked count (blocked=12 parses to 12)", () => {
    const body = renderReportBody({ stop: "capped", blocked: 12, capHit: true });
    const marker = parseReportMarker(body);
    expect(marker?.blocked).toBe(12);
  });

  it("D13: header carries capHit", () => {
    const body = renderReportBody({ stop: "converged", blocked: 0, capHit: true });
    const marker = parseReportMarker(body);
    expect(marker?.capHit).toBe(true);
  });

  it("D14: a capped-with-blocked report header is distinguishable from a normal converged one", () => {
    const cappedBlocked = renderReportBody({ stop: "capped", blocked: 12, capHit: true });
    const converged = renderReportBody({ stop: "converged", blocked: 0, capHit: false });
    expect(cappedBlocked).not.toBe(converged);
  });

  it("D15: header is deterministically parseable — body → structured marker object", () => {
    const body = renderReportBody({ stop: "capped", blocked: 3, capHit: true });
    const marker = parseReportMarker(body);
    expect(marker).toEqual({ stop: "capped", blocked: 3, capHit: true } satisfies ReportMarker);

    expect(parseReportMarker("## 无结论")).toBeNull();
  });

  it("D15: parse is head-scoped — a marker embedded mid-document (not at body head) is NOT parsed", () => {
    const body = renderReportBody({ stop: "converged", blocked: 0, capHit: false });
    const midDocument = `prose intro\n${body}\nmore`;
    expect(parseReportMarker(midDocument)).toBeNull();
  });
});

describe("S4 pure decision + marker build (D17 helpers)", () => {
  it("buildReportMarker maps capped → capped, converged/partial → converged with blocked", () => {
    expect(buildReportMarker(term({ state: "capped", capHit: true }), 2)).toEqual({
      stop: "capped",
      blocked: 2,
      capHit: true,
    });
    expect(buildReportMarker(term({ state: "partial" }), 3)).toEqual({
      stop: "converged",
      blocked: 3,
      capHit: false,
    });
    expect(buildReportMarker(term({ state: "converged" }), 0)).toEqual({
      stop: "converged",
      blocked: 0,
      capHit: false,
    });
  });

  it("D17: the orchestration decision module is a pure function (no ./bus, no Date/fetch/Math.random)", () => {
    const srcPath = fileURLToPath(new URL("../src/generate.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\/bus["']/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/Math\.random/);
  });

  it("computeDocDigest is deterministic for a given body", () => {
    expect(computeDocDigest("hello")).toBe(computeDocDigest("hello"));
    expect(computeDocDigest("hello")).not.toBe(computeDocDigest("hellp"));
  });
});