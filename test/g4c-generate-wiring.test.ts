/**
 * G4c —— 生成段接线硬验收（spec §2 U1–U7）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举。
 * U1/U2 测试 decideGenerate 纯函数 + 一次性保证机制。
 * U3–U7 走 runGenerate 单元测试 + 集成断言。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { randomUUID } from "node:crypto";
import {
  resetGeneratedOrigins,
  clearOneShotMarker,
  MissingExportRootError,
  parseRunCliArgs,
  runChannelWrite,
} from "../src/tick-run";
import type {
  RunWriteOptions,
} from "../src/tick-run";
import type { InspectMessage } from "../src/tick-inspect";
import {
  runGenerate,
  decideGenerate,
  AnchorCheckNotWiredError,
  DEFAULT_GENERATE_CONFIG,
  deriveDocKind,
} from "../src/generate";
import type {
  GenerateConfig,
  GenerateDeps,
} from "../src/generate";
import type { TerminationState } from "../src/tick";
import type { DocV2 } from "../src/protocol";
import { deriveExportPath } from "../src/export";
import type { ExportInput } from "../src/export";

const cfg: GenerateConfig = DEFAULT_GENERATE_CONFIG;

function term(over: Partial<TerminationState> = {}): TerminationState {
  return {
    state: "converged",
    coverage: 0,
    zeroGrowthRounds: 0,
    capHit: false,
    ...over,
  };
}

// ════════════════════════════════════════════════════════════════════
// 桩 fetch helpers（复用 G4b 模式：全局 stub fetch，runChannelWrite 走真实生产路径）
// ════════════════════════════════════════════════════════════════════
const U1_CHANNEL = "research:g4c-test-u1";
const U2_CHANNEL = "research:g4c-test-u2";

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function clueMsg(
  clueId: string,
  over: Record<string, unknown> = {},
  seq = 1,
): InspectMessage {
  return {
    message_id: `msg_${clueId}`,
    channel_id: U1_CHANNEL,
    channel_seq: seq,
    kind: "research.clue.v2",
    payload: {
      status: "explored",
      text: `clue ${clueId}`,
      depth: 0,
      sources: ["code-local"],
      ...over,
    },
    entity_id: clueId,
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function stubBoard(channelId: string, clueMessages: InspectMessage[]): void {
  let clueCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, _init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/entities/")) {
        return jsonResponse({ head: clueMessages[0] ?? {} });
      }
      if (u.includes("/publish")) {
        return jsonResponse({ message_id: "p", channel_seq: 99 });
      }
      if (u.includes(`/v1/channels/${channelId}/messages`)) {
        clueCalls += 1;
        return jsonResponse({ messages: clueCalls === 1 ? clueMessages : [] });
      }
      if (u.includes("/v1/channels/board:agent-runs/messages")) {
        return jsonResponse({ messages: [] });
      }
      return jsonResponse({ messages: [] });
    }),
  );
}

// ════════════════════════════════════════════════════════════════════
// U1 —— 可达性：终态非 null ⇒ runGenerate 被调用；终态 null ⇒ 不被调用
// ════════════════════════════════════════════════════════════════════
describe("U1: reachability — runChannelWrite triggers runGenerate when termination is non-null", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    resetGeneratedOrigins();
    clearOneShotMarker("research-u1-positive", U1_CHANNEL);
    clearOneShotMarker("research-u1-negative", U1_CHANNEL);
  });

  it("U1 positive: converged board + --origin triggers runGenerate and calls deps", async () => {
    const msgs = [clueMsg("c1", { status: "explored" })];
    stubBoard(U1_CHANNEL, msgs);

    const spawnRoleSpy = vi.fn(async () => ({ body: "test body" }));
    const writeDocSpy = vi.fn(async () => "msg-test");
    const spawnExportSpy = vi.fn(async () => {});

    const outcome = await runChannelWrite({
      channelId: U1_CHANNEL,
      origin: "research-u1-positive",
      question: "test question",
      prevCoverage: 1,
      prevZeroGrowthRounds: 2,
      generateDeps: {
        spawnRole: spawnRoleSpy,
        writeDoc: writeDocSpy,
        spawnExport: spawnExportSpy,
        lockSynthesizer: async () => async () => {},
        spawnAnchorCheck: async () => { throw new AnchorCheckNotWiredError(); },
      },
    });

    expect(outcome.generateTriggered).toBe(true);
    expect(spawnRoleSpy).toHaveBeenCalled();
    expect(writeDocSpy).toHaveBeenCalled();
    expect(spawnExportSpy).toHaveBeenCalled();
  });

  it("U1 negative: null termination state ⇒ runGenerate is NOT called", async () => {
    const msgs = [clueMsg("c1", { status: "explored" })];
    stubBoard(U1_CHANNEL, msgs);

    const spawnRoleSpy = vi.fn(async () => ({ body: "test body" }));
    const writeDocSpy = vi.fn(async () => "msg-test");
    const spawnExportSpy = vi.fn(async () => {});

    const outcome = await runChannelWrite({
      channelId: U1_CHANNEL,
      origin: "research-u1-negative",
      question: "test question",
      generateDeps: {
        spawnRole: spawnRoleSpy,
        writeDoc: writeDocSpy,
        spawnExport: spawnExportSpy,
        lockSynthesizer: async () => async () => {},
        spawnAnchorCheck: async () => { throw new AnchorCheckNotWiredError(); },
      },
    });

    expect(outcome.generateTriggered).toBe(false);
    expect(spawnRoleSpy).not.toHaveBeenCalled();
    expect(writeDocSpy).not.toHaveBeenCalled();
    expect(spawnExportSpy).not.toHaveBeenCalled();
  });
});

// ════════════════════════════════════════════════════════════════════
// U2 —— 只跑一次：同一次研究的终态被连续两个 tick 观察到时，生成段只执行一次
// ════════════════════════════════════════════════════════════════════
describe("U2: one-shot — same origin triggers generate only once", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    resetGeneratedOrigins();
    clearOneShotMarker("research-u2", U2_CHANNEL);
  });

  it("U2: two runChannelWrite calls with same origin only trigger generate once", async () => {
    const msgs = [clueMsg("c1", { status: "explored" })];
    stubBoard(U2_CHANNEL, msgs);

    const spawnRoleSpy = vi.fn(async () => ({ body: "test body" }));
    const writeDocSpy = vi.fn(async () => "msg-test");
    const spawnExportSpy = vi.fn(async () => {});

    const opts = {
      channelId: U2_CHANNEL,
      origin: "research-u2",
      question: "test question",
      prevCoverage: 1,
      prevZeroGrowthRounds: 2,
      generateDeps: {
        spawnRole: spawnRoleSpy,
        writeDoc: writeDocSpy,
        spawnExport: spawnExportSpy,
        lockSynthesizer: async () => async () => {},
        spawnAnchorCheck: async () => { throw new AnchorCheckNotWiredError(); },
      },
    };

    const outcome1 = await runChannelWrite(opts);
    expect(outcome1.generateTriggered).toBe(true);

    // Simulate a fresh tick process: clear in-memory Set, leaving only the file marker.
    resetGeneratedOrigins();

    // Re-stub for fresh board messages on second call
    stubBoard(U2_CHANNEL, msgs);
    const outcome2 = await runChannelWrite(opts);
    expect(outcome2.generateTriggered).toBe(false);

    // Spies called exactly once total (from first call only)
    expect(spawnRoleSpy).toHaveBeenCalledTimes(4);
    expect(writeDocSpy).toHaveBeenCalledTimes(4);
    expect(spawnExportSpy).toHaveBeenCalledTimes(1);
  });
});

// ════════════════════════════════════════════════════════════════════
// U3 —— 导出件带 source_message_id，且等于 report doc 实际发布的 message id
// ════════════════════════════════════════════════════════════════════
describe("U3: source_message_id equals the real report message_id", () => {
  it("U3: spawnExport receives sourceMessageId === writeDoc return value for the report", async () => {
    const reportMessageId = "msg-report-42";
    let exportSourceMessageId: string | undefined;
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test question",
      readOrigin: async () => "research-u3",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "role output" })),
      spawnAnchorCheck: async () => ({ defects: 0, verificationRate: 100 }),
      spawnExport: vi.fn(async (_body: string, sourceMessageId: string) => {
        exportSourceMessageId = sourceMessageId;
      }),
      writeDoc: vi.fn(async (doc: DocV2, _key: string) => {
        if (doc.doc_kind === "report") return reportMessageId;
        return "msg-other";
      }),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(deps, cfg);
    expect(exportSourceMessageId).toBe(reportMessageId);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });

  it("U3: source_message_id is not empty and not a constant", async () => {
    const reportMessageId = "msg-report-" + randomUUID();
    let exportSourceMessageId: string | undefined;
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test question",
      readOrigin: async () => "research-u3b",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "role output" })),
      spawnAnchorCheck: async () => ({ defects: 0, verificationRate: 100 }),
      spawnExport: vi.fn(async (_body: string, sourceMessageId: string) => {
        exportSourceMessageId = sourceMessageId;
      }),
      writeDoc: vi.fn(async (doc: DocV2) => {
        if (doc.doc_kind === "report") return reportMessageId;
        return "msg-other";
      }),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(deps, cfg);
    expect(exportSourceMessageId).toBe(reportMessageId);
    expect(exportSourceMessageId!.length).toBeGreaterThan(10);
    expect(exportSourceMessageId).not.toBe("");
  });
});

// ════════════════════════════════════════════════════════════════════
// U4 —— 导出落点 = <EXPORT_ROOT>/DeepThought/<topic-slug>/…；
//       EXPORT_ROOT 未配置 ⇒ 响亮失败
// ════════════════════════════════════════════════════════════════════
describe("U4: export path under EXPORT_ROOT/DeepThought/<topic-slug>", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });
  it("U4: deriveExportPath places the file under DeepThought/<topic-slug>", () => {
    const input: ExportInput = {
      report: { doc_kind: "report", digest: "x", body: "body", origin: "r" },
      sourceMessageId: "msg-1",
      createdAt: "2026-08-09T10:00:00Z",
      topic: "光伏并网 谐波治理",
    };
    const path = deriveExportPath(input, "/tmp/vault");
    expect(path).toContain("/DeepThought/光伏并网-谐波治理/");
    expect(path).toContain("2026-08-09");
    expect(path.endsWith(".md")).toBe(true);
  });

  it("U4: two different vaultRoots produce different paths", () => {
    const input: ExportInput = {
      report: { doc_kind: "report", digest: "x", body: "body", origin: "r" },
      sourceMessageId: "msg-1",
      createdAt: "2026-08-09T10:00:00Z",
      topic: "test",
    };
    const a = deriveExportPath(input, "/tmp/a");
    const b = deriveExportPath(input, "/tmp/b");
    expect(a).not.toBe(b);
    expect(a).toContain("/tmp/a");
    expect(b).toContain("/tmp/b");
  });

  it("U4: MissingExportRootError is thrown when EXPORT_ROOT is not set", async () => {
    clearOneShotMarker("research-u4-negative", U1_CHANNEL);
    const msgs = [clueMsg("c1", { status: "explored" })];
    stubBoard(U1_CHANNEL, msgs);

    const prevExportRoot = process.env.EXPORT_ROOT;
    delete process.env.EXPORT_ROOT;

    try {
      await expect(
        runChannelWrite({
          channelId: U1_CHANNEL,
          origin: "research-u4-negative",
          question: "test question",
          prevCoverage: 1,
          prevZeroGrowthRounds: 2,
          generateDeps: {
            spawnRole: vi.fn(async () => ({ body: "test body" })),
            writeDoc: vi.fn(async () => "msg-test"),
            lockSynthesizer: async () => async () => {},
            spawnAnchorCheck: async () => { throw new AnchorCheckNotWiredError(); },
          },
        }),
      ).rejects.toThrow(MissingExportRootError);
    } finally {
      if (prevExportRoot) process.env.EXPORT_ROOT = prevExportRoot;
    }
  });

  it("U4: export source does not hardcode vault paths", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const srcPath = fileURLToPath(new URL("../src/export.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).not.toMatch(/\bvaultRoot\s*=\s*["']\/home/);
    expect(source).not.toMatch(/\bvaultRoot\s*=\s*["']\/data/);
  });
});

// ════════════════════════════════════════════════════════════════════
// U5 —— anchor-check 未接线时头部标 unavailable，不得是 0% 或编造值
// ════════════════════════════════════════════════════════════════════
describe("U5: anchor-check not wired ⇒ head shows 'unavailable', not '0%'", () => {
  it("U5: AnchorCheckNotWiredError is a distinct error class", () => {
    const err = new AnchorCheckNotWiredError();
    expect(err.name).toBe("AnchorCheckNotWiredError");
    expect(err.message).toContain("G4c");
    expect(err.message).toContain("anchor-check");
  });

  it("U5: when spawnAnchorCheck throws, report head shows 'unavailable'", async () => {
    const written: DocV2[] = [];
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "research-u5",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "synth" })),
      spawnAnchorCheck: async () => { throw new AnchorCheckNotWiredError(); },
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async (doc: DocV2) => {
        written.push(doc);
        return "msg-1";
      }),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(deps, cfg);
    const report = written.find((d) => d.doc_kind === "report");
    expect(report).toBeDefined();
    expect(report!.body).toContain("dr-anchor-rate unavailable");
    expect(report!.body).not.toMatch(/dr-anchor-rate\s+0\b/);
    expect(report!.body).not.toMatch(/dr-anchor-rate\s+\d+/);
  });

  it("U5: a genuine 0% rate is distinguishable from 'unavailable'", async () => {
    const genuine: DocV2[] = [];
    const okDeps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "research-u5b",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "synth" })),
      spawnAnchorCheck: async () => ({ defects: 99, verificationRate: 0 }),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async (doc: DocV2) => {
        genuine.push(doc);
        return "msg-1";
      }),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(okDeps, cfg);
    expect(genuine.find((d) => d.doc_kind === "report")!.body).toContain("dr-anchor-rate 0");

    const unavailable: DocV2[] = [];
    const crashDeps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "research-u5c",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "synth" })),
      spawnAnchorCheck: async () => { throw new AnchorCheckNotWiredError(); },
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async (doc: DocV2) => {
        unavailable.push(doc);
        return "msg-1";
      }),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(crashDeps, cfg);
    expect(unavailable.find((d) => d.doc_kind === "report")!.body).toContain("dr-anchor-rate unavailable");
    // 0% 与 unavailable 必须可区分
    expect(
      genuine.find((d) => d.doc_kind === "report")!.body
    ).not.toBe(
      unavailable.find((d) => d.doc_kind === "report")!.body
    );
  });

  it("U5: production default spawnAnchorCheck throws AnchorCheckNotWiredError through runChannelWrite", async () => {
    const channel = "research:g4c-test-u5-prod";
    clearOneShotMarker("research-u5-prod", channel);
    const msgs = [clueMsg("c1", { status: "explored" })];
    stubBoard(channel, msgs);

    const prevExportRoot = process.env.EXPORT_ROOT;
    process.env.EXPORT_ROOT = "/tmp/test-vault";

    const written: { doc_kind: string; body: string }[] = [];

    try {
      const outcome = await runChannelWrite({
        channelId: channel,
        origin: "research-u5-prod",
        question: "test question",
        prevCoverage: 1,
        prevZeroGrowthRounds: 2,
        docChannelId: channel,
        generateDeps: {
          spawnRole: vi.fn(async () => ({ body: "test body" })),
          writeDoc: vi.fn(async (doc: DocV2) => {
            written.push({ doc_kind: doc.doc_kind, body: doc.body });
            return "msg-test";
          }),
          spawnExport: vi.fn(async () => {}),
          lockSynthesizer: async () => async () => {},
        },
      });
      expect(outcome.generateTriggered).toBe(true);
      const report = written.find((d) => d.doc_kind === "report");
      expect(report).toBeDefined();
      expect(report!.body).toContain("dr-anchor-rate unavailable");
    } finally {
      if (prevExportRoot) process.env.EXPORT_ROOT = prevExportRoot;
      else delete process.env.EXPORT_ROOT;
    }
  });
});

// ════════════════════════════════════════════════════════════════════
// U6 —— 串行边保持：synthesizer 并发 = 1、绝不跳过、导出在最后
// ════════════════════════════════════════════════════════════════════
describe("U6: serial edge — synthesizer concurrency = 1, never skipped, export last", () => {
  it("U6: synthesizer is never skipped — exactly one synthesizer spawn per run", async () => {
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "research-u6",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "out" })),
      spawnAnchorCheck: async () => ({ defects: 0, verificationRate: 100 }),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(deps, cfg);
    const synthCalls = (deps.spawnRole as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c) => c[0] === "dr-synthesizer",
    );
    expect(synthCalls).toHaveLength(1);
  });

  it("U6: export is after synthesizer and anchor-check in call sequence", async () => {
    const seq: string[] = [];
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "research-u6b",
      readEvidences: async () => [],
      spawnRole: vi.fn(async (role: string) => {
        seq.push(role);
        return { body: "out" };
      }),
      spawnAnchorCheck: async () => {
        seq.push("anchor-check");
        return { defects: 0, verificationRate: 100 };
      },
      spawnExport: vi.fn(async () => {
        seq.push("export");
      }),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(deps, cfg);
    const synIdx = seq.indexOf("dr-synthesizer");
    const anchorIdx = seq.indexOf("anchor-check");
    const exportIdx = seq.indexOf("export");
    expect(synIdx).toBeGreaterThanOrEqual(0);
    expect(synIdx).toBeLessThan(anchorIdx);
    expect(anchorIdx).toBeLessThan(exportIdx);
  });

  it("U6: lockSynthesizer is called before synthesizer spawn", async () => {
    const seq: string[] = [];
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "research-u6c",
      readEvidences: async () => [],
      spawnRole: vi.fn(async (role: string) => {
        seq.push(`spawn:${role}`);
        return { body: "out" };
      }),
      spawnAnchorCheck: async () => ({ defects: 0, verificationRate: 100 }),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => {
        seq.push("lock");
        return async () => { seq.push("unlock"); };
      },
    };
    await runGenerate(deps, cfg);
    const lockIdx = seq.indexOf("lock");
    const synthIdx = seq.findIndex((s) => s === "spawn:dr-synthesizer");
    const unlockIdx = seq.indexOf("unlock");
    expect(lockIdx).toBeGreaterThanOrEqual(0);
    expect(synthIdx).toBeGreaterThan(lockIdx);
    expect(unlockIdx).toBeGreaterThan(synthIdx);
  });
});

// ════════════════════════════════════════════════════════════════════
// U7 —— doc_kind 仍由 role 推出（debater ⇒ argument，synthesizer ⇒ report），不读 payload
// ════════════════════════════════════════════════════════════════════
describe("U7: doc_kind from role, never from payload", () => {
  it("U7: debater payload with stray doc_kind still yields argument", async () => {
    const written: DocV2[] = [];
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "research-u7",
      readEvidences: async () => [],
      spawnRole: vi.fn(async (role: string) => {
        if (role === "dr-debater-advocate") {
          return { body: "advocate", doc_kind: "report" } as { body: string };
        }
        return { body: "out" };
      }),
      spawnAnchorCheck: async () => ({ defects: 0, verificationRate: 100 }),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async (doc: DocV2) => {
        written.push(doc);
        return "msg-1";
      }),
      lockSynthesizer: async () => async () => {},
    };
    await runGenerate(deps, cfg);
    const argumentDocs = written.filter((d) => d.doc_kind === "argument");
    const reportDocs = written.filter((d) => d.doc_kind === "report");
    expect(argumentDocs).toHaveLength(3);
    expect(reportDocs).toHaveLength(1);
    const advocateDoc = written.find((d) => d.body === "advocate");
    expect(advocateDoc?.doc_kind).toBe("argument");
  });

  it("U7: deriveDocKind is a pure role→kind mapping", () => {
    expect(deriveDocKind("dr-synthesizer")).toBe("report");
    expect(deriveDocKind("dr-debater-advocate")).toBe("argument");
    expect(deriveDocKind("dr-debater-opponent")).toBe("argument");
    expect(deriveDocKind("dr-debater-judge")).toBe("argument");
  });

  it("U7: unknown role throws instead of silently defaulting", () => {
    expect(() => deriveDocKind("unknown-role")).toThrow(/unknown generation role/);
  });
});

// ════════════════════════════════════════════════════════════════════
// CLI parsing
// ════════════════════════════════════════════════════════════════════
describe("G4c CLI: --origin parsing", () => {
  it("--origin is parsed into RunCliOptions.origin", () => {
    const opts = parseRunCliArgs([
      "test:channel",
      "--origin",
      "research-42",
    ]);
    expect(opts.origin).toBe("research-42");
  });

  it("--origin without value throws", () => {
    expect(() => parseRunCliArgs(["test:channel", "--origin"])).toThrow(/origin/i);
  });
});

// ════════════════════════════════════════════════════════════════════
// Assembly chain: --origin flows through production assembly (bin → fleet → workflow → tick.md)
// ════════════════════════════════════════════════════════════════════
describe("G4c assembly: --origin flows through production chain", () => {
  it("tick.md contains --origin wiring in tick_args", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const tmplPath = fileURLToPath(
      new URL("../workflows/deep-research/tick/templates/tick.md", import.meta.url),
    );
    const source = readFileSync(tmplPath, "utf-8");
    expect(source).toContain("research_origin");
    expect(source).toContain("--origin");
    expect(source).toContain("$research_origin");
  });

  it("fleet.yaml.tpl contains research_origin input", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const fleetPath = fileURLToPath(
      new URL("../workflows/deep-research/fleet.yaml.tpl", import.meta.url),
    );
    const source = readFileSync(fleetPath, "utf-8");
    expect(source).toContain("research_origin");
    expect(source).toContain("RESEARCH_ORIGIN");
  });

  it("workflow.yaml seed payload contains research_origin", async () => {
    const { readFileSync } = await import("node:fs");
    const { fileURLToPath } = await import("node:url");
    const wfPath = fileURLToPath(
      new URL("../workflows/deep-research/tick/workflow.yaml", import.meta.url),
    );
    const source = readFileSync(wfPath, "utf-8");
    expect(source).toContain("research_origin");
    expect(source).toContain("{{research_origin}}");
  });
});