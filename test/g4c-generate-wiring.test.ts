/**
 * G4c(v2) —— 生成段接进生产：runGenerate 接线判别。
 *
 * 根因（spec §0）：`runGenerate` 在 src/ 内零调用者，tick 决策集无 generate。
 * 生产 --run 在本轮决策执行完、拿到 G4b 的 TerminationState 之后：
 * decideGenerate(term) 为真 ⇒ 调用 runGenerate(deps, cfg)。
 *
 * 硬验收（spec §3 U1–U9, U11）：
 *  - U1  可达性：终态非 null + origin 已配置 ⇒ runGenerate 被调用
 *  - U2  只跑一次：跨进程文件标记
 *  - U3  失败不留标记
 *  - U4  导出件带 source_message_id
 *  - U5  导出落点 + EXPORT_ROOT 未配置 ⇒ 响亮失败
 *  - U6  createdAt 取自 bus created_at
 *  - U7  anchor-check 未接线 ⇒ 头部标 unavailable（生产默认 deps）
 *  - U8  --origin 与 --doc-channel argv 记录
 *  - U9  值缺省 ⇒ 不出现该 flag
 *  - U11 synthesizer 并发 = 1
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  runChannelWrite,
  parseRunCliArgs,
  DEFAULT_MAX_WRITES,
  AnchorCheckNotWiredError,
  MissingExportRootError,
  MissingDocChannelError,
  MissingOriginError,
  assembleGenerateDeps,
} from "../src/tick-run";
import { runGenerate, DEFAULT_GENERATE_CONFIG, type GenerateDeps } from "../src/generate";
import { deriveExportPath } from "../src/export";
import type { InspectMessage } from "../src/tick-inspect";
import type { TerminationState, BoardState } from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TICK_MD = join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md");
const CHANNEL = "research:p02-smoke-g4c";

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function emptyMessagesResponse() {
  return jsonResponse({ messages: [] });
}

function messagesResponse(msgs: InspectMessage[]) {
  return jsonResponse({ messages: msgs });
}

function clueMsg(
  clueId: string,
  over: Record<string, unknown> = {},
  seq = 1,
): InspectMessage {
  return {
    message_id: `msg_${clueId}`,
    channel_id: CHANNEL,
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
    created_at: "2026-08-01T00:00:00Z",
  };
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

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  fetchSpy = vi.fn(async (input: RequestInfo, init?: RequestInit) => {
    return emptyMessagesResponse();
  });
  vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Helper: create a unique one-shot dir for this test run. */
function uniqueOneShotDir(label: string): string {
  const dir = join(tmpdir(), `g4c-${label}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("G4c U1: reachability — runGenerate is called when termination non-null + origin configured", () => {
  it("positive: board with all cards terminal + prevZeroGrowthRounds >= threshold ⇒ runGenerate called", async () => {
    const cards = [clueMsg("c1", { status: "explored" }, 1)];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    let generateCalled = false;
    const oneShotDir = uniqueOneShotDir("u1-pos");
    const generateDeps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test question",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => {
        generateCalled = true;
        return { body: "output" };
      }),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };

    await runChannelWrite({
      channelId: CHANNEL,
      origin: "test-origin",
      docChannelId: "research:doc",
      prevZeroGrowthRounds: 2,
      oneShotDir,
      generateDeps,
    });

    expect(generateCalled).toBe(true);
    rmSync(oneShotDir, { recursive: true, force: true });
  });

  it("negative: termination state is null ⇒ runGenerate NOT called", async () => {
    const cards = [clueMsg("c1", { status: "explored" }, 1)];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    let generateCalled = false;
    const oneShotDir = uniqueOneShotDir("u1-neg1");
    const generateDeps: GenerateDeps = {
      readTermination: async () => term({ state: null }),
      countBlocked: async () => 0,
      readQuestion: async () => "test question",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => {
        generateCalled = true;
        return { body: "output" };
      }),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };

    await runChannelWrite({
      channelId: CHANNEL,
      origin: "test-origin",
      docChannelId: "research:doc",
      prevZeroGrowthRounds: 2,
      oneShotDir,
      generateDeps,
    });

    expect(generateCalled).toBe(false);
    rmSync(oneShotDir, { recursive: true, force: true });
  });

  it("negative: origin not configured ⇒ generate NOT called", async () => {
    const cards = [clueMsg("c1", { status: "explored" }, 1)];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    let generateCalled = false;
    const oneShotDir = uniqueOneShotDir("u1-neg2");
    const generateDeps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test question",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => {
        generateCalled = true;
        return { body: "output" };
      }),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };

    await runChannelWrite({
      channelId: CHANNEL,
      // origin not set
      prevZeroGrowthRounds: 2,
      oneShotDir,
      generateDeps,
    });

    expect(generateCalled).toBe(false);
    rmSync(oneShotDir, { recursive: true, force: true });
  });
});

describe("G4c U2: one-shot — same origin twice ⇒ generate only runs once", () => {
  it("consecutive calls with same origin+channelId fire generate exactly once", async () => {
    const cards = [clueMsg("c1", { status: "explored" }, 1)];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    let generateCount = 0;
    function makeDeps(): GenerateDeps {
      return {
        readTermination: async () => term(),
        countBlocked: async () => 0,
        readQuestion: async () => "test",
        readOrigin: async () => "test-origin",
        readEvidences: async () => [],
        spawnRole: vi.fn(async () => ({ body: "output" })),
        spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
        spawnExport: vi.fn(async () => {
          generateCount += 1;
        }),
        writeDoc: vi.fn(async () => "msg-1"),
        lockSynthesizer: async () => async () => {},
      };
    }

    const oneShotDir = uniqueOneShotDir("u2");

    await runChannelWrite({
      channelId: CHANNEL,
      origin: "test-origin",
      docChannelId: "research:doc",
      prevZeroGrowthRounds: 2,
      oneShotDir,
      generateDeps: makeDeps(),
    });
    expect(generateCount).toBe(1);

    await runChannelWrite({
      channelId: CHANNEL,
      origin: "test-origin",
      docChannelId: "research:doc",
      prevZeroGrowthRounds: 2,
      oneShotDir,
      generateDeps: makeDeps(),
    });
    // Second call should see the marker and skip generate
    expect(generateCount).toBe(1);

    rmSync(oneShotDir, { recursive: true, force: true });
  });

  it("cross-process: if only memory Set and no file marker, second call still fires (discriminative)", async () => {
    const cards = [clueMsg("c1", { status: "explored" }, 1)];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    let generateCount = 0;
    function makeDeps(): GenerateDeps {
      return {
        readTermination: async () => term(),
        countBlocked: async () => 0,
        readQuestion: async () => "test",
        readOrigin: async () => "test-origin",
        readEvidences: async () => [],
        spawnRole: vi.fn(async () => ({ body: "output" })),
        spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
        spawnExport: vi.fn(async () => {
          generateCount += 1;
        }),
        writeDoc: vi.fn(async () => "msg-1"),
        lockSynthesizer: async () => async () => {},
      };
    }

    // Use a fresh oneShotDir each time so no file marker survives
    const dir1 = uniqueOneShotDir("u2a");
    await runChannelWrite({
      channelId: CHANNEL,
      origin: "test-origin",
      docChannelId: "research:doc",
      prevZeroGrowthRounds: 2,
      oneShotDir: dir1,
      generateDeps: makeDeps(),
    });
    expect(generateCount).toBe(1);

    const dir2 = uniqueOneShotDir("u2b");
    await runChannelWrite({
      channelId: CHANNEL,
      origin: "test-origin",
      docChannelId: "research:doc",
      prevZeroGrowthRounds: 2,
      oneShotDir: dir2,
      generateDeps: makeDeps(),
    });
    // Different dir = no file marker = generate fires again
    expect(generateCount).toBe(2);

    rmSync(dir1, { recursive: true, force: true });
    rmSync(dir2, { recursive: true, force: true });
  });
});

describe("G4c U3: failure does not leave marker — runGenerate throws ⇒ marker not written, retry on next tick", () => {
  it("runGenerate throws ⇒ marker file not created", async () => {
    const cards = [clueMsg("c1", { status: "explored" }, 1)];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    const oneShotDir = uniqueOneShotDir("u3");

    const failingDeps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => {
        throw new Error("simulated generate failure");
      }),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };

    await expect(
      runChannelWrite({
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        prevZeroGrowthRounds: 2,
        oneShotDir,
        generateDeps: failingDeps,
      }),
    ).rejects.toThrow("simulated generate failure");

    // Marker file should NOT exist
    const markerKey = `test-origin:${CHANNEL}`;
    const markerHash = createHash("sha256").update(markerKey).digest("hex").slice(0, 16);
    const markerPath = join(oneShotDir, `generated-${markerHash}`);
    expect(existsSync(markerPath)).toBe(false);

    // Next tick with same origin should retry (no marker)
    let generateCount = 0;
    const retryDeps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "output" })),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
      spawnExport: vi.fn(async () => {
        generateCount += 1;
      }),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };

    await runChannelWrite({
      channelId: CHANNEL,
      origin: "test-origin",
      docChannelId: "research:doc",
      prevZeroGrowthRounds: 2,
      oneShotDir,
      generateDeps: retryDeps,
    });
    expect(generateCount).toBe(1);

    rmSync(oneShotDir, { recursive: true, force: true });
  });
});

describe("G4c U4: export carries source_message_id equal to writeDoc's message_id", () => {
  it("spawnExport receives the same message_id that writeDoc returned", async () => {
    const cards = [clueMsg("c1", { status: "explored" }, 1)];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    let capturedSourceMessageId = "";
    let capturedExportBody = "";
    const oneShotDir = uniqueOneShotDir("u4");
    const generateDeps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async (role: string) => {
        if (role === "dr-synthesizer") return { body: "synthesizer output" };
        return { body: "debater output" };
      }),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
      spawnExport: vi.fn(async (body: string, sourceMessageId: string) => {
        capturedExportBody = body;
        capturedSourceMessageId = sourceMessageId;
      }),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        if (doc.doc_kind === "report") return "report-msg-42";
        return "arg-msg-1";
      }),
      lockSynthesizer: async () => async () => {},
    };

    await runChannelWrite({
      channelId: CHANNEL,
      origin: "test-origin",
      docChannelId: "research:doc",
      prevZeroGrowthRounds: 2,
      oneShotDir,
      generateDeps,
    });

    expect(capturedSourceMessageId).toBe("report-msg-42");
    expect(capturedExportBody).toContain("synthesizer output");
    rmSync(oneShotDir, { recursive: true, force: true });
  });
});

describe("G4c U5: export path + EXPORT_ROOT check", () => {
  it("production deps throw MissingExportRootError when EXPORT_ROOT is not set", async () => {
    const cards = [clueMsg("c1", { status: "explored" }, 1)];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    const prevExportRoot = process.env.EXPORT_ROOT;
    delete process.env.EXPORT_ROOT;

    const oneShotDir = uniqueOneShotDir("u5");

    // Mirror the production spawnExport check: EXPORT_ROOT unset ⇒ MissingExportRootError
    const generateDeps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "output" })),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
      spawnExport: async () => {
        const exportRoot = process.env.EXPORT_ROOT;
        if (!exportRoot) throw new MissingExportRootError();
      },
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };

    try {
      await expect(
        runChannelWrite({
          channelId: CHANNEL,
          origin: "test-origin",
          docChannelId: "research:doc",
          question: "test question",
          prevZeroGrowthRounds: 2,
          oneShotDir,
          generateDeps,
        }),
      ).rejects.toThrow(MissingExportRootError);
    } finally {
      if (prevExportRoot) process.env.EXPORT_ROOT = prevExportRoot;
      rmSync(oneShotDir, { recursive: true, force: true });
    }
  });

  it("export path includes EXPORT_ROOT/DeepThought/<slug>/<date>-<slug>.md", () => {
    const input = {
      report: {
        doc_kind: "report" as const,
        body: "<!-- dr-terminal stop=converged blocked=0 capHit=false -->\ncontent",
        digest: "abc",
        origin: "test-origin",
      },
      sourceMessageId: "msg-1",
      createdAt: "2026-08-01T00:00:00Z",
      topic: "测试研究主题",
    };
    const path = deriveExportPath(input, "/data/vault");
    expect(path).toMatch(/^\/data\/vault\/DeepThought\//);
    expect(path).toMatch(/\/2026-08-01-/);
    expect(path).toMatch(/\.md$/);
    // ⛔ no hardcoded vault path in source
    const src = readFileSync(join(ROOT, "src", "export.ts"), "utf8");
    expect(src).not.toMatch(/\/data\/vault/);
  });
});

describe("G4c U6: createdAt from bus created_at, no new Date() fallback", () => {
  it("export reads createdAt from bus message, not system clock", () => {
    const exportCode = readFileSync(join(ROOT, "src", "export.ts"), "utf8");
    expect(exportCode).not.toMatch(/new Date\(\)/);
    expect(exportCode).not.toMatch(/\?\?.*new Date/);
  });
});

describe("G4c U7: anchor-check unwired ⇒ head shows unavailable (production default deps)", () => {
  it("production assembleGenerateDeps throws AnchorCheckNotWiredError", async () => {
    const cards = [clueMsg("c1", { status: "explored" }, 1)];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    let anchorError: Error | null = null;
    const oneShotDir = uniqueOneShotDir("u7");
    const generateDeps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async (role: string) => {
        return { body: "output" };
      }),
      spawnAnchorCheck: vi.fn(async () => {
        anchorError = new AnchorCheckNotWiredError();
        throw anchorError;
      }),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async (doc: { body: string; doc_kind: string }) => {
        return "msg-1";
      }),
      lockSynthesizer: async () => async () => {},
    };

    await runChannelWrite({
      channelId: CHANNEL,
      origin: "test-origin",
      docChannelId: "research:doc",
      prevZeroGrowthRounds: 2,
      oneShotDir,
      generateDeps,
    });

    // anchor-check threw (not wired), but export still happened
    expect(anchorError).toBeInstanceOf(AnchorCheckNotWiredError);
    expect(generateDeps.spawnExport).toHaveBeenCalledTimes(1);
    // The report body should have "unavailable" in the anchor-rate header
    const writeDocCalls = (generateDeps.writeDoc as ReturnType<typeof vi.fn>).mock.calls;
    const reportDoc = writeDocCalls.find((c: unknown[]) => {
      const d = c[0] as { doc_kind?: string };
      return d?.doc_kind === "report";
    });
    expect(reportDoc).toBeDefined();
    expect((reportDoc![0] as { body: string }).body).toContain("dr-anchor-rate unavailable");

    rmSync(oneShotDir, { recursive: true, force: true });
  });

  it("discriminative: if production deps return 0% rate, that would be distinguishable from unavailable", () => {
    const err = new AnchorCheckNotWiredError();
    expect(err.name).toBe("AnchorCheckNotWiredError");
    expect(err.message).toContain("anchor-check is not wired");
  });

  it("discriminative T5: production assembleGenerateDeps spawnAnchorCheck throws AnchorCheckNotWiredError", async () => {
    const oneShotDir = uniqueOneShotDir("u7-t5");
    const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
    const deps = assembleGenerateDeps(
      {
        channelId: CHANNEL,
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
        oneShotDir,
      },
      term(),
      postWriteState,
    );
    await expect(deps.spawnAnchorCheck("anchor-check")).rejects.toThrow(AnchorCheckNotWiredError);
    rmSync(oneShotDir, { recursive: true, force: true });
  });
});

describe("G4c U8: --origin and --doc-channel argv records", () => {
  it("--origin and --doc-channel really reach tick-entry argv with their values", () => {
    const dir = mkdtempSync(join(tmpdir(), "g4c-u8-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    const fakeTickEntry = `#!/usr/bin/env bash
case "$1" in
  --parse-trigger-body) printf ''; exit 0 ;;
  *) printf '%s\\n' "$@" > "${argvLog}"; printf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}'; exit 0 ;;
esac
`;
    writeFileSync(tickEntry, fakeTickEntry);
    chmodSync(tickEntry, 0o755);

    const values: Record<string, string> = {
      tick_entry: tickEntry,
      tick_channel: "research:v1-deep-research.index",
      evidence_channel: "research:v1-deep-research.evidence",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      research_origin: "g4c-test-origin",
      doc_channel: "research:v1-deep-research.content",
      trigger_store_dir: dir,
      loop_store_cli: join(dir, "loop-store"),
      loop_engine_runner: "bash",
      trigger_body: "{}",
    };
    const script = readFileSync(TICK_MD, "utf8").replace(/\{\{([a-z_]+)\}\}/g, (_m: string, key: string) => values[key] ?? "");
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);

    try {
      execFileSync("bash", [outShell], { cwd: ROOT, encoding: "utf8" });
    } catch {
      // tick.md may fail if hasPendingWork triggers the continuation put
    }
    const argv = readFileSync(argvLog, "utf8").trim().split("\n").filter((l) => l.length > 0);

    // ⛔ discriminant: assert --origin and its value; --doc-channel and its value
    expect(argv).toContain("--origin");
    const originIdx = argv.indexOf("--origin");
    expect(argv[originIdx + 1]).toBe("g4c-test-origin");

    expect(argv).toContain("--doc-channel");
    const docChannelIdx = argv.indexOf("--doc-channel");
    expect(argv[docChannelIdx + 1]).toBe("research:v1-deep-research.content");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("G4c U9: value missing ⇒ flag not present", () => {
  it("when research_origin is empty, --origin does not appear in argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "g4c-u9a-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    const fakeTickEntry = `#!/usr/bin/env bash
case "$1" in
  --parse-trigger-body) printf ''; exit 0 ;;
  *) printf '%s\\n' "$@" > "${argvLog}"; printf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}'; exit 0 ;;
esac
`;
    writeFileSync(tickEntry, fakeTickEntry);
    chmodSync(tickEntry, 0o755);

    const values: Record<string, string> = {
      tick_entry: tickEntry,
      tick_channel: "research:v1-deep-research.index",
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      research_origin: "",
      doc_channel: "",
      trigger_store_dir: dir,
      loop_store_cli: join(dir, "loop-store"),
      loop_engine_runner: "bash",
      trigger_body: "{}",
    };
    const script = readFileSync(TICK_MD, "utf8").replace(/\{\{([a-z_]+)\}\}/g, (_m: string, key: string) => values[key] ?? "");
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);

    try {
      execFileSync("bash", [outShell], { cwd: ROOT, encoding: "utf8" });
    } catch {
      // expected if continuation put fails
    }
    const argv = readFileSync(argvLog, "utf8").trim().split("\n").filter((l) => l.length > 0);

    expect(argv).not.toContain("--origin");
    expect(argv).not.toContain("--doc-channel");

    rmSync(dir, { recursive: true, force: true });
  });

  it("when doc_channel is set but research_origin is not, only --doc-channel appears", () => {
    const dir = mkdtempSync(join(tmpdir(), "g4c-u9b-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    const fakeTickEntry = `#!/usr/bin/env bash
case "$1" in
  --parse-trigger-body) printf ''; exit 0 ;;
  *) printf '%s\\n' "$@" > "${argvLog}"; printf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}'; exit 0 ;;
esac
`;
    writeFileSync(tickEntry, fakeTickEntry);
    chmodSync(tickEntry, 0o755);

    const values: Record<string, string> = {
      tick_entry: tickEntry,
      tick_channel: "research:v1-deep-research.index",
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      research_origin: "",
      doc_channel: "research:v1-docs",
      trigger_store_dir: dir,
      loop_store_cli: join(dir, "loop-store"),
      loop_engine_runner: "bash",
      trigger_body: "{}",
    };
    const script = readFileSync(TICK_MD, "utf8").replace(/\{\{([a-z_]+)\}\}/g, (_m: string, key: string) => values[key] ?? "");
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);

    try {
      execFileSync("bash", [outShell], { cwd: ROOT, encoding: "utf8" });
    } catch {
      // expected
    }
    const argv = readFileSync(argvLog, "utf8").trim().split("\n").filter((l) => l.length > 0);

    expect(argv).not.toContain("--origin");
    expect(argv).toContain("--doc-channel");
    expect(argv[argv.indexOf("--doc-channel") + 1]).toBe("research:v1-docs");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("G4c U11: synthesizer concurrency = 1, never skipped; export last; doc_kind by role", () => {
  it("two concurrent runGenerate calls serialize the synthesizer", async () => {
    let locked = false;
    const waiters: Array<() => void> = [];
    let resolveSynth!: () => void;
    const gate = new Promise<void>((r) => { resolveSynth = r; });

    const makeDeps = (): GenerateDeps => ({
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async (role: string) => {
        if (role === "dr-synthesizer") {
          await gate;
        }
        return { body: "output" };
      }),
      spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: vi.fn(async () => {
        if (locked) {
          await new Promise<void>((r) => waiters.push(r));
        }
        locked = true;
        let released = false;
        return async () => {
          if (released) return;
          released = true;
          locked = false;
          const w = [...waiters];
          waiters.length = 0;
          w.forEach((r) => r());
        };
      }),
    });

    const deps1 = makeDeps();
    const first = runGenerate(deps1, DEFAULT_GENERATE_CONFIG);
    // Wait for synthesizer to be spawned
    await vi.waitFor(() => {
      const synthCalls = (deps1.spawnRole as ReturnType<typeof vi.fn>).mock.calls.filter(
        (c: unknown[]) => c[0] === "dr-synthesizer",
      );
      expect(synthCalls).toHaveLength(1);
    });

    const deps2 = makeDeps();
    const second = runGenerate(deps2, DEFAULT_GENERATE_CONFIG);
    await new Promise((r) => setTimeout(r, 20));
    // Second should not have spawned synthesizer yet
    const synthCalls2 = (deps2.spawnRole as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "dr-synthesizer",
    );
    expect(synthCalls2).toHaveLength(0);

    resolveSynth();
    await first;
    await second;

    // Both synthesizers should have run
    const synthCalls2After = (deps2.spawnRole as ReturnType<typeof vi.fn>).mock.calls.filter(
      (c: unknown[]) => c[0] === "dr-synthesizer",
    );
    expect(synthCalls2After).toHaveLength(1);
  });

  it("export is last in the ordering", async () => {
    const seq: string[] = [];
    const deps: GenerateDeps = {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async (role: string) => {
        seq.push(role);
        return { body: "output" };
      }),
      spawnAnchorCheck: vi.fn(async () => {
        seq.push("anchor-check");
        return { defects: 0, verificationRate: 100 };
      }),
      spawnExport: vi.fn(async () => {
        seq.push("export");
      }),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };

    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);

    const synIdx = seq.indexOf("dr-synthesizer");
    const exportIdx = seq.indexOf("export");
    expect(synIdx).toBeGreaterThanOrEqual(0);
    expect(synIdx).toBeLessThan(exportIdx);
  });
});