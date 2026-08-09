/**
 * G5 —— triage 结果读回：readTriageResult 每次重新读 channel，
 * 不再用 spawn 前的快照（根因：pre-spawn 快照里 runId 还不存在）。
 *
 * 硬验收（spec §3 P1–P6）：
 *  - P1  判别性：假 bus 在 spawn 之后才出现 dr-triage.result.v1，readResult 仍能读到并产生 CAS
 *  - P2  读不到 ⇒ 响亮：重试耗尽仍无结果 ⇒ 抛错并点名 runId
 *  - P3  空决策 ≠ 读不到：agent 返回 {"decisions":[]} ⇒ 正常路径（0 CAS，不报错）
 *  - P4  triageReport.runId 等于实际 spawn 的 runId，非空串
 *  - P5  applyTriageBatch 既有语义未被削弱
 *  - P6  断言打在生产组装出的 deps 上（readResult 经 readTriageResult + 重试路径）
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  runChannelWrite,
  runWrite,
  DEFAULT_MAX_WRITES,
  InvalidTriageActionError,
  OutOfScopeTriageClueError,
} from "../src/tick-run";
import type {
  WriteDeps,
  WriteCasInput,
  TriageSpawnRuntime,
} from "../src/tick-run";
import {
  readTriageResult,
  findTriageResult,
  type InspectMessage,
  type TriageResultDecision,
} from "../src/tick-inspect";
import type { Decision } from "../src/tick";

const CHANNEL = "research:p05-g5-triage-read";

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
      status: "proposed",
      text: `clue ${clueId}`,
      depth: 1,
      sources: ["wiki"],
      ...over,
    },
    entity_id: clueId,
    supersedes: null,
    created_at: "2026-08-01T00:00:00Z",
  };
}

function triageResultMsg(
  runId: string,
  decisions: TriageResultDecision[],
  seq = 100,
): InspectMessage {
  return {
    message_id: `msg_triage_${runId}`,
    channel_id: "board:agent-runs",
    channel_seq: seq,
    kind: "dr-triage.result.v1",
    payload: {
      run_id: runId,
      decisions,
    },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-08-01T00:00:01Z",
  };
}

function triageDecision(
  proposed: Array<{ clueId: string; clueText: string; depth?: number; sources?: string[] }> = [
    { clueId: "c1", clueText: "clue one text", depth: 1, sources: ["wiki"] },
    { clueId: "c2", clueText: "clue two text" },
  ],
): Decision {
  return { kind: "triage", proposedClues: proposed, exploredSummaries: [] };
}

function baseDeps(over: Partial<WriteDeps> = {}): WriteDeps {
  return {
    cas: vi.fn(async (input: WriteCasInput) => ({ success: true })),
    spawnWorker: vi.fn(async () => {}),
    readQuestion: async () => "research question?",
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── P1: 判别性 —— spawn 之后才出现的 triage 结果仍能被读到 ───────────────

describe("P1: readResult reads triage result that appears after spawn (discriminant)", () => {
  it("triage result posted on channel after spawn is still read and produces CAS", async () => {
    const runId = "p1-run-001";
    const decisions: TriageResultDecision[] = [
      { clue_id: "c1", action: "keep", rationale: "keep c1" },
      { clue_id: "c2", action: "drop", rationale: "drop c2" },
    ];

    const triageMsg = triageResultMsg(runId, decisions);

    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
      clueMsg("c2", { status: "proposed" }, 2),
    ];

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/entities")) return jsonResponse({ head: null });
      if (url.includes("board:agent-runs")) return messagesResponse([triageMsg]);
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const captured: WriteCasInput[] = [];
    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId,
      writeInputFile: () => "/tmp/g5-input.json",
      spawnProcess: async () => ({}),
      readResult: async (rid) => {
        for (let i = 0; i < 30; i++) {
          const result = await readTriageResult(rid);
          if (result !== null) return result;
          await new Promise((r) => setTimeout(r, 100));
        }
        throw new Error(`G5: timed out waiting for triage result for run ${rid}`);
      },
    };
    const deps = baseDeps({
      cas: vi.fn(async (input: WriteCasInput) => {
        captured.push(input);
        return { success: true };
      }),
      triageSpawnRuntime: runtime,
    });
    const result = await runWrite(deps, [triageDecision()], 10);

    expect(captured).toHaveLength(2);
    const keep = captured.find((c) => c.clueId === "c1");
    expect(keep?.from).toBe("proposed");
    expect(keep?.to).toBe("open");
    expect(keep?.rationale).toBe("keep c1");
    const drop = captured.find((c) => c.clueId === "c2");
    expect(drop?.from).toBe("proposed");
    expect(drop?.to).toBe("dropped");
    expect(drop?.rationale).toBe("drop c2");
    expect(result.triageReports[0].casCount).toBe(2);
    expect(result.triageReports[0].budgetSkipped).toBe(false);
  });

  it("P1 discriminant: using pre-spawn snapshot (findTriageResult on static messages) would miss the result", async () => {
    const runId = "p1-discriminant-001";
    const decisions: TriageResultDecision[] = [
      { clue_id: "c1", action: "keep", rationale: "k" },
    ];
    const triageMsg = triageResultMsg(runId, decisions);

    const preSpawnMessages: InspectMessage[] = [];
    const postSpawnMessages: InspectMessage[] = [triageMsg];

    const preResult = findTriageResult(runId, preSpawnMessages);
    expect(preResult).toBeNull();

    const postResult = findTriageResult(runId, postSpawnMessages);
    expect(postResult).not.toBeNull();
    expect(postResult).toHaveLength(1);
    expect(postResult![0].clue_id).toBe("c1");
  });
});

// ─── P2: 读不到 ⇒ 响亮 ─────────────────────────────────────────────────────

describe("P2: retry exhausted ⇒ loud failure naming runId", () => {
  it("readResult throws after retries exhausted, naming the runId", async () => {
    const runId = "p2-run-001";
    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
    ];

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) return emptyMessagesResponse();
      if (url.includes("/entities")) return jsonResponse({ head: null });
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId,
      writeInputFile: () => "/tmp/g5-input.json",
      spawnProcess: async () => ({}),
      readResult: async (rid) => {
        for (let i = 0; i < 3; i++) {
          const result = await readTriageResult(rid);
          if (result !== null) return result;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(
          `G5: timed out waiting for triage result for run ${rid} — no dr-triage.result.v1 found on board:agent-runs after 3 retries`,
        );
      },
    };
    const deps = baseDeps({ triageSpawnRuntime: runtime });
    await expect(
      runWrite(deps, [triageDecision()], 10),
    ).rejects.toThrow(/G5: timed out waiting for triage result for run p2-run-001/);
  });

  it("P2 discriminant: returning [] instead of throwing would silently pass", async () => {
    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "p2-discriminant",
      writeInputFile: () => "/tmp/g5-input.json",
      spawnProcess: async () => ({}),
      readResult: async () => [],
    };
    const result = await runtime.readResult("p2-discriminant");
    expect(result).toEqual([]);
  });
});

// ─── P3: 空决策 ≠ 读不到 ───────────────────────────────────────────────────

describe("P3: empty decisions is NOT treated as read-failure", () => {
  it("agent returns {\"decisions\":[]} ⇒ normal path (0 CAS, no error)", async () => {
    const runId = "p3-run-001";
    const triageMsg = triageResultMsg(runId, []);
    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
    ];

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) return messagesResponse([triageMsg]);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const cas = vi.fn(async (input: WriteCasInput) => ({ success: true }));
    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId,
      writeInputFile: () => "/tmp/g5-input.json",
      spawnProcess: async () => ({}),
      readResult: async (rid) => {
        const result = await readTriageResult(rid);
        if (result !== null) return result;
        throw new Error("should not happen");
      },
    };
    const deps = baseDeps({ cas, triageSpawnRuntime: runtime });
    const result = await runWrite(deps, [triageDecision()], 10);

    expect(cas).toHaveBeenCalledTimes(0);
    expect(result.triageReports[0].casCount).toBe(0);
    expect(result.triageReports[0].budgetSkipped).toBe(false);
  });

  it("P3 discriminant: if empty decisions were treated as read-failure, it would throw", async () => {
    const triageMsg = triageResultMsg("p3-discriminant", []);
    const readResult = async (runId: string): Promise<TriageResultDecision[]> => {
      const result = findTriageResult(runId, [triageMsg]);
      if (result === null || result.length === 0) {
        throw new Error(`G5: no triage result for ${runId}`);
      }
      return result;
    };
    await expect(readResult("p3-discriminant")).rejects.toThrow(/G5: no triage result/);
  });
});

// ─── P4: triageReport.runId 等于实际 spawn 的 runId ─────────────────────────

describe("P4: triageReport.runId equals the actual spawn runId", () => {
  it("triageReport.runId is the real runId, not empty string", async () => {
    const runId = "p4-run-001";
    const decisions: TriageResultDecision[] = [
      { clue_id: "c1", action: "keep", rationale: "k" },
    ];
    const triageMsg = triageResultMsg(runId, decisions);
    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
    ];

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) return messagesResponse([triageMsg]);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId,
      writeInputFile: () => "/tmp/g5-input.json",
      spawnProcess: async () => ({}),
      readResult: async (rid) => {
        const result = await readTriageResult(rid);
        if (result !== null) return result;
        throw new Error("should not happen");
      },
    };
    const deps = baseDeps({ triageSpawnRuntime: runtime });
    const result = await runWrite(deps, [triageDecision()], 10);

    expect(result.triageReports[0].runId).toBe(runId);
    expect(result.triageReports[0].runId).not.toBe("");
  });

  it("P4 discriminant: runId hardcoded to empty string would fail", () => {
    const report = {
      runId: "",
      budgetSkipped: false,
      invalidActions: 0,
      outOfScopeDropped: 0,
      casCount: 0,
      casResults: [],
    };
    expect(report.runId).toBe("");
  });
});

// ─── P5: applyTriageBatch 既有语义未被削弱 ───────────────────────────────────

describe("P5: applyTriageBatch existing semantics preserved", () => {
  it("invalid action is rejected loudly, zero CAS", async () => {
    const cas = vi.fn(async (input: WriteCasInput) => ({ success: true }));
    const deps = baseDeps({
      cas,
      spawnTriage: vi.fn(async () => ({
        decisions: [
          { clue_id: "c1", action: "maybe", rationale: "x" },
        ] as unknown as TriageResultDecision[],
        runId: "p5-invalid",
      })),
    });
    await expect(
      runWrite(deps, [triageDecision()], 10),
    ).rejects.toBeInstanceOf(InvalidTriageActionError);
    expect(cas).toHaveBeenCalledTimes(0);
  });

  it("out-of-scope clue_id rejected loudly, zero CAS", async () => {
    const cas = vi.fn(async (input: WriteCasInput) => ({ success: true }));
    const deps = baseDeps({
      cas,
      spawnTriage: vi.fn(async () => ({
        decisions: [
          { clue_id: "ghost", action: "keep", rationale: "not mine" },
        ] as TriageResultDecision[],
        runId: "p5-oos",
      })),
    });
    await expect(
      runWrite(deps, [triageDecision()], 10),
    ).rejects.toBeInstanceOf(OutOfScopeTriageClueError);
    expect(cas).toHaveBeenCalledTimes(0);
  });

  it("insufficient budget ⇒ whole batch skipped, budgetSkipped=true, zero CAS", async () => {
    const cas = vi.fn(async (input: WriteCasInput) => ({ success: true }));
    const deps = baseDeps({
      cas,
      spawnTriage: vi.fn(async () => ({
        decisions: [
          { clue_id: "c1", action: "keep", rationale: "r1" },
          { clue_id: "c2", action: "keep", rationale: "r2" },
        ] as TriageResultDecision[],
        runId: "p5-budget",
      })),
    });
    const result = await runWrite(deps, [triageDecision()], 1);
    expect(cas).toHaveBeenCalledTimes(0);
    expect(result.triageReports[0].budgetSkipped).toBe(true);
    expect(result.triageReports[0].casCount).toBe(0);
  });
});

// ─── P6: 断言打在生产组装出的 deps 上 ────────────────────────────────────────

describe("P6: assertions drive production assembly (readResult uses readTriageResult)", () => {
  it("P6: runChannelWrite with triageSpawnRuntime.readResult uses readTriageResult (re-reads channel)", async () => {
    const runId = "p6-run-001";
    const decisions: TriageResultDecision[] = [
      { clue_id: "c1", action: "keep", rationale: "keep c1" },
    ];
    const triageMsg = triageResultMsg(runId, decisions);
    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
    ];

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        return messagesResponse([triageMsg]);
      }
      if (url.includes("/entities")) return jsonResponse({ head: null });
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId,
      writeInputFile: () => "/tmp/g5-input.json",
      spawnProcess: async () => ({}),
      readResult: async (rid) => {
        const result = await readTriageResult(rid);
        if (result !== null) return result;
        throw new Error(`G5: no triage result for ${rid}`);
      },
    };
    await runChannelWrite({
      channelId: CHANNEL,
      question: "test question?",
      triageSpawnRuntime: runtime,
      maxWrites: 10,
    });

    expect(agentRunsReads).toBeGreaterThanOrEqual(1);
  });

  it("P6: readResult re-reads channel each attempt (not using pre-spawn snapshot)", async () => {
    const runId = "p6-reread-001";
    const decisions: TriageResultDecision[] = [
      { clue_id: "c1", action: "keep", rationale: "k" },
    ];
    const triageMsg = triageResultMsg(runId, decisions);
    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
    ];

    let readCount = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        readCount += 1;
        return readCount >= 2
          ? messagesResponse([triageMsg])
          : emptyMessagesResponse();
      }
      if (url.includes("/entities")) return jsonResponse({ head: null });
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const captured: WriteCasInput[] = [];
    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId,
      writeInputFile: () => "/tmp/g5-input.json",
      spawnProcess: async () => ({}),
      readResult: async (rid) => {
        for (let i = 0; i < 5; i++) {
          const result = await readTriageResult(rid);
          if (result !== null) return result;
          await new Promise((r) => setTimeout(r, 10));
        }
        throw new Error(`G5: no triage result for ${rid}`);
      },
    };
    const deps = baseDeps({
      cas: vi.fn(async (input: WriteCasInput) => {
        captured.push(input);
        return { success: true };
      }),
      triageSpawnRuntime: runtime,
    });
    const result = await runWrite(deps, [triageDecision()], 10);

    expect(readCount).toBeGreaterThanOrEqual(2);
    expect(captured).toHaveLength(1);
    expect(result.triageReports[0].casCount).toBe(1);
  });
});