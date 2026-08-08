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
  buildGenerateRoleArgv,
  assertDistinctDebaterRoutes,
  MAX_DOC_BODY_BYTES,
  DEFAULT_GENERATE_CONFIG,
} from "../src/generate";
import type {
  GenerateConfig,
  GenerateDeps,
  ReportMarker,
  DebaterCorpus,
} from "../src/generate";
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
    spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
    spawnExport: vi.fn(async () => {}),
    writeDoc: vi.fn(async () => {}),
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

describe("S4 debaters (D4/D5/D16)", () => {
  it("D4: exactly 3 debaters are spawned (advocate/opponent/judge) plus the synthesizer", async () => {
    const deps = baseDeps();
    await runGenerate(deps, cfg);
    expect(debaterSpawns(deps)).toHaveLength(3);
    expect(synthSpawns(deps)).toHaveLength(1);
  });

  it("D5: the three debater routes are mutually distinct (dedup size === 3)", async () => {
    const routes: string[] = [];
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string, route: string) => {
        if (DEBATER_ROLES.has(role)) routes.push(route);
        return { body: "out" };
      }),
    });
    await runGenerate(deps, cfg);
    expect(routes).toHaveLength(3);
    expect(new Set(routes).size).toBe(3);
  });

  it("D5/Q2: a caller-supplied config with duplicate debater routes is rejected (not silently accepted)", async () => {
    const bad: GenerateConfig = {
      ...cfg,
      debaters: [
        { role: "dr-debater-advocate", route: "a" },
        { role: "dr-debater-opponent", route: "a" },
        { role: "dr-debater-judge", route: "c" },
      ],
    };
    expect(() => assertDistinctDebaterRoutes(bad)).toThrow(/mutually distinct/);
    await expect(runGenerate(baseDeps(), bad)).rejects.toThrow(/mutually distinct/);
  });

  it("D16: route combination is not hardcoded — custom three routes are the ones used", async () => {
    const routes: string[] = [];
    const custom: GenerateConfig = {
      ...cfg,
      debaters: [
        { role: "r1", route: "custom.one" },
        { role: "r2", route: "custom.two" },
        { role: "r3", route: "custom.three" },
      ],
    };
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string, route: string) => {
        if (role !== "dr-synthesizer") routes.push(route);
        return { body: "out" };
      }),
    });
    await runGenerate(deps, custom);
    expect(routes).toEqual(["custom.one", "custom.two", "custom.three"]);
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
        return { defects: 0, verificationRate: 100 };
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
        // 串行化：等待锁释放（wait-then-run），绝不跳过 synthesizer。
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
    // 等第一次调用真正发起 synthesizer spawn（此刻 lock 已被持有且挂起）。
    await vi.waitFor(() => expect(synthSpawns(deps)).toHaveLength(1));

    // 挂起期间驱动第二次编排：拿不到锁必须等待，不得发起第二次 synthesizer spawn。
    const second = runGenerate(deps, cfg);
    await new Promise((r) => setTimeout(r, 20));
    expect(synthSpawns(deps)).toHaveLength(1);

    // 释放第一次后，第二次串行拿到锁并补跑 synthesizer（不跳过阶段）。
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
      spawnAnchorCheck: vi.fn(async () => ({ defects: 5, verificationRate: 100 })),
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, cfg);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

describe("G2a D1: corpus reaches the role prompt via POSITIONAL args", () => {
  it("D1: serialized evidence text appears in the positional args (not just --input)", () => {
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
    const argv = buildGenerateRoleArgv({
      agentRunBin: "/fake/agent-run",
      role: "dr-debater-advocate",
      route: "opus-4-8/ccs",
      runId: "run-1",
      inputPath: "/tmp/payload.json",
      corpus,
    });
    const dd = argv.indexOf("--");
    expect(dd).toBeGreaterThanOrEqual(0);
    const positional = argv.slice(dd + 1).join(" ");
    // ⛔ 断言序列化后的证据文本出现在【位置参数】中；只断言 `--input` 存在不算数。
    expect(positional).toContain("code://repo@abc123:src/foo.ts#L42");
    expect(positional).toContain("exact quoted text");
    expect(positional).toContain("research question?");
    // `--input` 只作 schema 守卫，指向载荷文件（内容不得只靠它注入 prompt）。
    expect(argv[argv.indexOf("--input") + 1]).toBe("/tmp/payload.json");
  });

  it("D1: the assembled debater corpus flows from readEvidences into the serialized positional slot", async () => {
    const evidences = [
      {
        clue_id: "c1",
        anchor: "code://repo@abc123:src/foo.ts#L42",
        quote: "exact quoted text",
        claim: "one-sentence claim",
      },
    ];
    const captured: DebaterCorpus[] = [];
    const deps = baseDeps({
      readEvidences: async () => evidences,
      spawnRole: vi.fn(async (_role: string, _route: string, corpus: DebaterCorpus) => {
        captured.push(corpus);
        return { body: "out" };
      }),
    });
    await runGenerate(deps, cfg);
    expect(captured.length).toBeGreaterThan(0);
    const serialized = serializeCorpusToPositional(captured[0]);
    expect(serialized).toContain("code://repo@abc123:src/foo.ts#L42");
    expect(serialized).toContain("exact quoted text");
  });
});

describe("G2a D2: doc_kind is derived from role, never from payload", () => {
  it("D2: a DEBATER payload carrying doc_kind:'report' still yields research.doc.v2 doc_kind:'argument'", async () => {
    const written: DocV2[] = [];
    // 假 worker 返回的载荷里带一个 schema 拦不住的 stray `doc_kind: "report"`。
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string) => {
        if (role === "dr-debater-advocate") {
          return { body: "advocate argument", doc_kind: "report" } as { body: string };
        }
        return { body: "out" };
      }),
      writeDoc: vi.fn(async (doc: DocV2) => {
        written.push(doc);
      }),
    });
    await runGenerate(deps, cfg);
    const argumentDocs = written.filter((d) => d.doc_kind === "argument");
    const reportDocs = written.filter((d) => d.doc_kind === "report");
    // 三条 debater → argument；synthesizer → report。全部由 role 推出，与 payload 无关。
    expect(argumentDocs).toHaveLength(3);
    expect(reportDocs).toHaveLength(1);
    // 即便 debater 的载荷带了 doc_kind:'report'，引擎发出的仍是 argument。
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

describe("G2a D3: role/route wiring matches the real agent-runtime values", () => {
  it("D3: the four roles' role/route pairs equal the actual values", () => {
    expect(DEFAULT_GENERATE_CONFIG.debaters).toEqual([
      { role: "dr-debater-advocate", route: "opus-4-8/ccs" },
      { role: "dr-debater-opponent", route: "gpt-5.6-sol/ccs" },
      { role: "dr-debater-judge", route: "ds-v4-pro/ccs" },
    ]);
    expect(DEFAULT_GENERATE_CONFIG.synthesizer).toEqual({
      role: "dr-synthesizer",
      route: "opus-5/ccs",
    });
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
        spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: rate })),
        writeDoc: vi.fn(async (doc: DocV2) => {
          written.push(doc);
        }),
        spawnExport: vi.fn(async () => {}),
      });
      await runGenerate(deps, cfg);
      const report = written.find((d) => d.doc_kind === "report");
      expect(report).toBeDefined();
      expect(report!.body).toMatch(/dr-terminal stop=converged/);
      expect(report!.body).toMatch(new RegExp(`dr-anchor-rate ${rate}`));
      // 软闸门：<90% 与 ≥90% 都照样导出。
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

    // 散文/无标记 body → null
    expect(parseReportMarker("## 无结论")).toBeNull();
  });

  it("D15: parse is head-scoped — a marker embedded mid-document (not at body head) is NOT parsed", () => {
    const body = renderReportBody({ stop: "converged", blocked: 0, capHit: false });
    // 把标记嵌进正文中间（前面有散文），不得被当成头部标记解析出来。
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
