/**
 * G13(v2) —— 生成段部分失败后该 origin 永久卡死：按 report 是否已存在恢复。
 *
 * 硬验收（spec §2）：
 *  W1  report 已存在 ⇒ 零 spawn、零 publish，导出被调用且导出内容取自该 report 的 body
 *  W2  anchor-check 在复用分支照常执行（anchor-check.json 仍产出）
 *  W3  无 report 但有 argument ⇒ 响亮失败，点名 origin 与 argument 条数；不得 spawn、不得 publish
 *  W4  该 origin 下无任何 doc ⇒ 行为与今天逐字一致（四个 role 全 spawn、四次 publish）
 *  W5  只按 origin 过滤：别的 origin 的 report 不得被误当成本 origin 的可复用产物
 *  W6  断言打在生产组装出的 deps 上（assembleGenerateDeps 已导出）
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { runGenerate, DEFAULT_GENERATE_CONFIG, type GenerateDeps, type ExistingDoc, type AnchorCheckResult } from "../src/generate";
import { assembleGenerateDeps } from "../src/tick-run";
import type { DocV2 } from "../src/protocol";
import type { TerminationState, BoardState } from "../src/tick";

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

function term(over: Partial<TerminationState> = {}): TerminationState {
  return {
    state: "converged",
    coverage: 0,
    zeroGrowthRounds: 0,
    capHit: false,
    ...over,
  };
}

function baseDeps(over: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    readTermination: async () => term(),
    countBlocked: async () => 0,
    readQuestion: async () => "research question?",
    readOrigin: async () => "test-origin",
    readEvidences: async () => [],
    spawnRole: vi.fn(async () => ({ body: "role output" })),
    spawnAnchorCheck: vi.fn(async () => anchorResult()),
    spawnExport: vi.fn(async () => {}),
    writeDoc: vi.fn(async () => "msg-1"),
    lockSynthesizer: async () => async () => {},
    ...over,
  };
}

function makeExistingReport(body: string, origin: string, messageId: string): ExistingDoc {
  return {
    doc: {
      doc_kind: "report",
      digest: "abc123",
      body,
      origin,
    },
    messageId,
  };
}

function makeExistingArgument(origin: string, messageId: string): ExistingDoc {
  return {
    doc: {
      doc_kind: "argument",
      digest: "def456",
      body: "argument body",
      origin,
    },
    messageId,
  };
}

describe("G13 W1: report exists → zero spawn, zero publish, export called with existing body", () => {
  it("existing report reuses body, spawns zero debaters, zero synthesizer, zero writeDoc", async () => {
    const existingBody = "<!-- dr-terminal stop=converged blocked=0 capHit=false -->\n<!-- dr-anchor-rate 87 -->\nexisting report content";
    const deps = baseDeps({
      readDocs: async () => [makeExistingReport(existingBody, "test-origin", "report-msg-42")],
    });

    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);

    expect(deps.spawnRole).toHaveBeenCalledTimes(0);
    expect(deps.writeDoc).toHaveBeenCalledTimes(0);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
    const exportCall = (deps.spawnExport as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(exportCall[0]).toBe(existingBody);
    expect(exportCall[1]).toBe("report-msg-42");
  });

  it("existing report: anchor-check is called", async () => {
    const deps = baseDeps({
      readDocs: async () => [makeExistingReport("existing body", "test-origin", "report-msg-42")],
    });

    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);

    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(1);
  });

  it("existing report: writeAnchorCheckJson is called when provided", async () => {
    const writeAnchorCheckJson = vi.fn(async () => {});
    const deps = baseDeps({
      readDocs: async () => [makeExistingReport("existing body", "test-origin", "report-msg-42")],
      writeAnchorCheckJson,
    });

    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);

    expect(writeAnchorCheckJson).toHaveBeenCalledTimes(1);
  });
});

describe("G13 W2: anchor-check in reuse branch runs normally", () => {
  it("anchor-check runs and produces valid JSON, anchor-check.json IS written", async () => {
    const writeAnchorCheckJson = vi.fn(async () => {});
    const deps = baseDeps({
      readDocs: async () => [makeExistingReport("existing body", "test-origin", "report-msg-42")],
      spawnAnchorCheck: vi.fn(async () => anchorResult({ total: 100, current_verified_hit: 85 })),
      writeAnchorCheckJson,
    });

    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);

    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(1);
    expect(writeAnchorCheckJson).toHaveBeenCalledTimes(1);
    const json = (writeAnchorCheckJson as ReturnType<typeof vi.fn>).mock.calls[0][0] as string;
    const parsed = JSON.parse(json);
    expect(parsed.total).toBe(100);
    expect(parsed.current_verified_hit).toBe(85);
  });

  it("anchor-check failure does not block export in reuse branch", async () => {
    const deps = baseDeps({
      readDocs: async () => [makeExistingReport("existing body", "test-origin", "report-msg-42")],
      spawnAnchorCheck: vi.fn(async () => {
        throw new Error("anchor-check boom");
      }),
    });

    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);

    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

describe("G13 W3: no report but arguments exist → loud failure, no spawn, no publish", () => {
  it("arguments exist without report: throws error naming origin and argument count", async () => {
    const deps = baseDeps({
      readDocs: async () => [
        makeExistingArgument("test-origin", "arg-msg-1"),
        makeExistingArgument("test-origin", "arg-msg-2"),
      ],
    });

    await expect(runGenerate(deps, DEFAULT_GENERATE_CONFIG)).rejects.toThrow(
      /G13.*test-origin.*2 existing argument.*partial publish/,
    );

    expect(deps.spawnRole).toHaveBeenCalledTimes(0);
    expect(deps.writeDoc).toHaveBeenCalledTimes(0);
    expect(deps.spawnExport).toHaveBeenCalledTimes(0);
  });

  it("single argument without report: throws naming origin and count 1", async () => {
    const deps = baseDeps({
      readDocs: async () => [makeExistingArgument("test-origin", "arg-msg-1")],
    });

    await expect(runGenerate(deps, DEFAULT_GENERATE_CONFIG)).rejects.toThrow(
      /G13.*test-origin.*1 existing argument.*partial publish/,
    );
  });

  it("arguments + report (both exist): no error, report reused, spawn=0", async () => {
    const deps = baseDeps({
      readDocs: async () => [
        makeExistingArgument("test-origin", "arg-msg-1"),
        makeExistingReport("existing body", "test-origin", "report-msg-42"),
      ],
    });

    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);

    expect(deps.spawnRole).toHaveBeenCalledTimes(0);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

describe("G13 W4: no docs for origin → normal behavior", () => {
  it("empty readDocs: four spawns (3 debaters + 1 synthesizer), four publish", async () => {
    const deps = baseDeps({
      readDocs: async () => [],
    });

    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);

    expect(deps.spawnRole).toHaveBeenCalledTimes(4);
    expect(deps.writeDoc).toHaveBeenCalledTimes(4);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });

  it("readDocs not provided: normal behavior (backward compat)", async () => {
    const deps = baseDeps({});

    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);

    expect(deps.spawnRole).toHaveBeenCalledTimes(4);
    expect(deps.writeDoc).toHaveBeenCalledTimes(4);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

describe("G13 W5: only filter by origin — different origin's report is not reused", () => {
  it("other origin's report in readDocs response does not prevent normal spawns", async () => {
    const deps = baseDeps({
      readDocs: async () => [
        makeExistingReport("other report body", "other-origin", "other-msg-99"),
      ],
    });

    await runGenerate(deps, DEFAULT_GENERATE_CONFIG);

    expect(deps.spawnRole).toHaveBeenCalledTimes(4);
    expect(deps.writeDoc).toHaveBeenCalledTimes(4);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

describe("G13 W6: production deps (assembleGenerateDeps) wires readDocs", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
      text: async () => JSON.stringify({ messages: [] }),
    }));
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("production assembleGenerateDeps includes readDocs that returns empty for empty doc channel", async () => {
    const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
    const deps = assembleGenerateDeps(
      {
        channelId: "research:test",
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
      },
      term(),
      postWriteState,
    );

    expect(deps.readDocs).toBeDefined();
    const docs = await deps.readDocs!("test-origin");
    expect(docs).toEqual([]);
  });

  it("production readDocs filters by origin: same origin match, different origin excluded", async () => {
    const docMessages = [
      {
        message_id: "msg-1",
        channel_id: "research:doc",
        channel_seq: 1,
        kind: "research.doc.v2",
        payload: { doc_kind: "report", body: "r1", digest: "d1", origin: "test-origin" },
        entity_id: "doc-1",
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      },
      {
        message_id: "msg-2",
        channel_id: "research:doc",
        channel_seq: 2,
        kind: "research.doc.v2",
        payload: { doc_kind: "report", body: "r2", digest: "d2", origin: "other-origin" },
        entity_id: "doc-2",
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      },
      {
        message_id: "msg-3",
        channel_id: "research:doc",
        channel_seq: 3,
        kind: "research.doc.v2",
        payload: { doc_kind: "argument", body: "a1", digest: "d3", origin: "test-origin" },
        entity_id: "doc-3",
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      },
    ];
    let pageCall = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) {
        pageCall += 1;
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: pageCall === 1 ? docMessages : [] }),
          text: async () => "{}",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [] }),
        text: async () => "{}",
      };
    });

    const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
    const deps = assembleGenerateDeps(
      {
        channelId: "research:test",
        origin: "test-origin",
        docChannelId: "research:doc",
        question: "test question",
      },
      term(),
      postWriteState,
    );

    const docs = await deps.readDocs!("test-origin");
    expect(docs).toHaveLength(2);
    expect(docs[0].doc.doc_kind).toBe("report");
    expect(docs[0].doc.origin).toBe("test-origin");
    expect(docs[0].messageId).toBe("msg-1");
    expect(docs[1].doc.doc_kind).toBe("argument");
    expect(docs[1].messageId).toBe("msg-3");
  });

  it("production readDocs returns empty when docChannelId is not set", async () => {
    const postWriteState: BoardState = { cards: [], runs: {}, triageInFlight: false };
    const deps = assembleGenerateDeps(
      {
        channelId: "research:test",
        origin: "test-origin",
        question: "test question",
      },
      term(),
      postWriteState,
    );

    const docs = await deps.readDocs!("test-origin");
    expect(docs).toEqual([]);
  });
});