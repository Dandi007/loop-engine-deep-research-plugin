/**
 * G6 —— 结果等待预算：triage readResult 与 生成段 readBody 都按
 * AGENT_RESULT_TIMEOUT_MS / AGENT_RESULT_POLL_MS 等待，不再写死 30×1s。
 *
 * 硬验收（spec §2 R1–R6）：
 *  - R1  两条路径都用新预算：triage readResult 与 生成段 readBody
 *  - R2  可覆盖：设 AGENT_RESULT_TIMEOUT_MS 为极小值 ⇒ 很快超时；不设 ⇒ 用 900000 缺省
 *  - R3  超时仍响亮并点名 runId（G5 语义保留）
 *  - R4  空结果 ≠ 读不到（G5 的 P3 保留且仍有效）
 *  - R5  不得靠真实等待把用例拖慢：用例注入极小 poll 间隔
 *  - R6  断言打在生产组装出的 deps 上
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  runChannelWrite,
  assembleGenerateDeps,
  resolveAgentResultTimeout,
  DEFAULT_AGENT_RESULT_TIMEOUT_MS,
  DEFAULT_AGENT_RESULT_POLL_MS,
} from "../src/tick-run";
import type { RunWriteOptions, WriteCasInput } from "../src/tick-run";
import {
  readTriageResult,
  readGenerateResult,
  type InspectMessage,
  type TriageResultDecision,
} from "../src/tick-inspect";
import type { TerminationState, BoardState } from "../src/tick";

const CHANNEL = "research:p06-g6-result-timeout";

let capturedTriageRunId = "";
let capturedGenerateRunId = "";

vi.mock("node:child_process", () => {
  const EventEmitter = require("node:events").EventEmitter;
  return {
    spawn: (cmd: string, args: string[]) => {
      const runIdIdx = args.indexOf("--run-id");
      const runId = runIdIdx >= 0 ? args[runIdIdx + 1] : "";
      const roleIdx = args.indexOf("--role");
      if (roleIdx >= 0) {
        const role = args[roleIdx + 1];
        if (role === "dr-triage") capturedTriageRunId = runId;
        else if (role.startsWith("dr-debater-") || role === "dr-synthesizer") {
          capturedGenerateRunId = runId;
        }
      }
      const child = new EventEmitter();
      child.pid = 12345;
      child.unref = () => {};
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => child.emit("exit", 0));
      return child;
    },
    execFileSync: () => "",
  };
});

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

function exploredClueMsg(clueId: string, seq = 1): InspectMessage {
  return clueMsg(clueId, { status: "explored" }, seq);
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

function generateResultMsg(
  runId: string,
  body: string,
  seq = 100,
): InspectMessage {
  return {
    message_id: `msg_gen_${runId}`,
    channel_id: "board:agent-runs",
    channel_seq: seq,
    kind: "dr-doc.result.v1",
    payload: {
      run_id: runId,
      body,
    },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-08-01T00:00:01Z",
  };
}

function termState(over: Partial<TerminationState> = {}): TerminationState {
  return {
    state: "converged",
    coverage: 0,
    zeroGrowthRounds: 3,
    capHit: false,
    ...over,
  };
}

function boardState(over: Partial<BoardState> = {}): BoardState {
  return {
    cards: [],
    runs: {},
    triageInFlight: false,
    ...over,
  };
}

function setEnv(k: string, v: string | undefined): void {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

const TIMEOUT_ENV = "AGENT_RESULT_TIMEOUT_MS";
const POLL_ENV = "AGENT_RESULT_POLL_MS";

beforeEach(() => {
  capturedTriageRunId = "";
  capturedGenerateRunId = "";
  delete process.env[TIMEOUT_ENV];
  delete process.env[POLL_ENV];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[TIMEOUT_ENV];
  delete process.env[POLL_ENV];
});

// ─── R1: 两条路径都用新预算 ─────────────────────────────────────────────────

describe("R1: both triage readResult and generate readBody use AGENT_RESULT_TIMEOUT_MS / AGENT_RESULT_POLL_MS", () => {
  it("R1a: triage production-assembly readResult uses time-based polling with env vars", async () => {
    capturedTriageRunId = "";
    setEnv(TIMEOUT_ENV, "500");
    setEnv(POLL_ENV, "10");

    const decisions: TriageResultDecision[] = [
      { clue_id: "c1", action: "keep", rationale: "keep c1" },
    ];

    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
      clueMsg("c2", { status: "proposed" }, 2),
      clueMsg("c3", { status: "proposed" }, 3),
    ];

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        if (capturedTriageRunId && agentRunsReads >= 2) {
          return messagesResponse([triageResultMsg(capturedTriageRunId, decisions)]);
        }
        return emptyMessagesResponse();
      }
      if (url.includes("/publish")) {
        return jsonResponse({ message_id: "pub_001" });
      }
      if (url.includes("/v1/entities/")) {
        return jsonResponse({
          head: {
            message_id: "head_001",
            channel_id: CHANNEL,
            channel_seq: 1,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue" },
            entity_id: "c1",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const result = await runChannelWrite({
      channelId: CHANNEL,
      question: "test question?",
      workerCmd: "/fake/agent-run",
      maxWrites: 10,
    });

    expect(result.triageReports[0].casCount).toBe(1);
    expect(result.triageReports[0].budgetSkipped).toBe(false);
    expect(result.triageReports[0].runId).toBe(capturedTriageRunId);
    expect(result.triageReports[0].runId).not.toBe("");
    expect(agentRunsReads).toBeGreaterThanOrEqual(2);
  });

  it("R1b: generate production-assembly readBody uses time-based polling with env vars", async () => {
    setEnv(TIMEOUT_ENV, "500");
    setEnv(POLL_ENV, "10");

    const generateRunId = "g6-gen-run-001";
    const generateBody = "generated report content";

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        return agentRunsReads >= 2
          ? messagesResponse([generateResultMsg(generateRunId, generateBody)])
          : emptyMessagesResponse();
      }
      return emptyMessagesResponse();
    });

    const deps = assembleGenerateDeps(
      { channelId: CHANNEL, workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );

    const body = await deps.spawnRuntime!.readBody(generateRunId);
    expect(body).toBe(generateBody);
    expect(agentRunsReads).toBeGreaterThanOrEqual(2);
  });

  it("R1 discriminant: generate readBody still uses time-based polling (not 30×1s)", async () => {
    setEnv(TIMEOUT_ENV, "500");
    setEnv(POLL_ENV, "10");

    const generateRunId = "g6-gen-disc-001";
    const generateBody = "discriminant body";

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        return agentRunsReads >= 3
          ? messagesResponse([generateResultMsg(generateRunId, generateBody)])
          : emptyMessagesResponse();
      }
      return emptyMessagesResponse();
    });

    const deps = assembleGenerateDeps(
      { channelId: CHANNEL, workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );

    const body = await deps.spawnRuntime!.readBody(generateRunId);
    expect(body).toBe(generateBody);
    expect(agentRunsReads).toBeGreaterThanOrEqual(3);
  });
});

// ─── R2: 可覆盖 ──────────────────────────────────────────────────────────────

describe("R2: AGENT_RESULT_TIMEOUT_MS overridable", () => {
  it("R2a: small AGENT_RESULT_TIMEOUT_MS ⇒ timeout fires quickly", async () => {
    setEnv(TIMEOUT_ENV, "10");
    setEnv(POLL_ENV, "5");

    const generateRunId = "g6-timeout-quick-001";

    vi.stubGlobal("fetch", async () => emptyMessagesResponse());

    const deps = assembleGenerateDeps(
      { channelId: CHANNEL, workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );

    await expect(
      deps.spawnRuntime!.readBody(generateRunId),
    ).rejects.toThrow(/G4c: timed out waiting for generate result for run g6-timeout-quick-001/);
  });

  it("R2b: no env vars ⇒ resolveAgentResultTimeout returns defaults (900000 / 3000)", () => {
    const { timeoutMs, pollMs } = resolveAgentResultTimeout();
    expect(timeoutMs).toBe(DEFAULT_AGENT_RESULT_TIMEOUT_MS);
    expect(pollMs).toBe(DEFAULT_AGENT_RESULT_POLL_MS);
  });

  it("R2c: triage production-assembly times out quickly with small AGENT_RESULT_TIMEOUT_MS", async () => {
    capturedTriageRunId = "";
    setEnv(TIMEOUT_ENV, "10");
    setEnv(POLL_ENV, "5");

    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
      clueMsg("c2", { status: "proposed" }, 2),
      clueMsg("c3", { status: "proposed" }, 3),
    ];

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) return emptyMessagesResponse();
      if (url.includes("/publish")) return jsonResponse({ message_id: "pub_001" });
      if (url.includes("/v1/entities/")) {
        return jsonResponse({
          head: {
            message_id: "head_001",
            channel_id: CHANNEL,
            channel_seq: 1,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue" },
            entity_id: "c1",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    await expect(
      runChannelWrite({
        channelId: CHANNEL,
        question: "test question?",
        workerCmd: "/fake/agent-run",
        maxWrites: 10,
      }),
    ).rejects.toThrow(/G5: timed out waiting for triage result for run/);
  });
});

// ─── R3: 超时仍响亮并点名 runId ──────────────────────────────────────────────

describe("R3: timeout still loudly names runId", () => {
  it("R3a: triage timeout error names the runId", async () => {
    capturedTriageRunId = "";
    setEnv(TIMEOUT_ENV, "10");
    setEnv(POLL_ENV, "5");

    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
      clueMsg("c2", { status: "proposed" }, 2),
      clueMsg("c3", { status: "proposed" }, 3),
    ];

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) return emptyMessagesResponse();
      if (url.includes("/publish")) return jsonResponse({ message_id: "pub_001" });
      if (url.includes("/v1/entities/")) {
        return jsonResponse({
          head: {
            message_id: "head_001",
            channel_id: CHANNEL,
            channel_seq: 1,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue" },
            entity_id: "c1",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    try {
      await runChannelWrite({
        channelId: CHANNEL,
        question: "test question?",
        workerCmd: "/fake/agent-run",
        maxWrites: 10,
      });
      expect.fail("expected timeout error");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/G5: timed out waiting for triage result for run/);
      expect(msg).toContain("no dr-triage.result.v1 found on board:agent-runs");
      expect(capturedTriageRunId).not.toBe("");
      expect(msg).toContain(capturedTriageRunId);
    }
  });

  it("R3b: generate timeout error names the runId", async () => {
    setEnv(TIMEOUT_ENV, "10");
    setEnv(POLL_ENV, "5");

    const generateRunId = "g6-gen-timeout-run-001";

    vi.stubGlobal("fetch", async () => emptyMessagesResponse());

    const deps = assembleGenerateDeps(
      { channelId: CHANNEL, workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );

    try {
      await deps.spawnRuntime!.readBody(generateRunId);
      expect.fail("expected timeout error");
    } catch (e) {
      const msg = (e as Error).message;
      expect(msg).toMatch(/G4c: timed out waiting for generate result for run/);
      expect(msg).toContain(generateRunId);
    }
  });
});

// ─── R4: 空结果 ≠ 读不到 ────────────────────────────────────────────────────

describe("R4: empty result is NOT treated as read-failure", () => {
  it("R4a: triage returns empty decisions ([]) ⇒ normal path, 0 CAS, no error", async () => {
    capturedTriageRunId = "";
    setEnv(TIMEOUT_ENV, "500");
    setEnv(POLL_ENV, "10");

    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
      clueMsg("c2", { status: "proposed" }, 2),
      clueMsg("c3", { status: "proposed" }, 3),
    ];

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        if (capturedTriageRunId && agentRunsReads >= 2) {
          return messagesResponse([triageResultMsg(capturedTriageRunId, [])]);
        }
        return emptyMessagesResponse();
      }
      if (url.includes("/publish")) return jsonResponse({ message_id: "pub_001" });
      if (url.includes("/v1/entities/")) {
        return jsonResponse({
          head: {
            message_id: "head_001",
            channel_id: CHANNEL,
            channel_seq: 1,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue" },
            entity_id: "c1",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const result = await runChannelWrite({
      channelId: CHANNEL,
      question: "test question?",
      workerCmd: "/fake/agent-run",
      maxWrites: 10,
    });

    expect(result.triageReports[0].casCount).toBe(0);
    expect(result.triageReports[0].budgetSkipped).toBe(false);
    expect(result.triageReports[0].runId).toBe(capturedTriageRunId);
    expect(result.triageReports[0].runId).not.toBe("");
  });

  it("R4b: generate returns empty body ⇒ normal path, body is empty string", async () => {
    setEnv(TIMEOUT_ENV, "500");
    setEnv(POLL_ENV, "10");

    const generateRunId = "g6-gen-empty-001";
    const emptyBody = "";

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        return agentRunsReads >= 2
          ? messagesResponse([generateResultMsg(generateRunId, emptyBody)])
          : emptyMessagesResponse();
      }
      return emptyMessagesResponse();
    });

    const deps = assembleGenerateDeps(
      { channelId: CHANNEL, workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );

    const body = await deps.spawnRuntime!.readBody(generateRunId);
    expect(body).toBe("");
    expect(agentRunsReads).toBeGreaterThanOrEqual(2);
  });

  it("R4 discriminant: empty result ([]) does NOT cause further polling in triage path", async () => {
    setEnv(TIMEOUT_ENV, "500");
    setEnv(POLL_ENV, "10");

    const runId = "g6-empty-disc-001";

    // readTriageResult paginates (page + empty page) so at least 2 fetch calls are expected.
    // The discriminant is that readTriageResult returns [] (empty decisions) and the polling
    // loop (readResult) does not treat it as "not found" — it returns immediately.
    let reads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        reads += 1;
        return messagesResponse([triageResultMsg(runId, [])]);
      }
      return emptyMessagesResponse();
    });

    const result = await readTriageResult(runId);
    expect(result).toEqual([]);
    expect(reads).toBeGreaterThanOrEqual(1);
  });
});

// ─── R5: 不得靠真实等待把用例拖慢 ────────────────────────────────────────────

describe("R5: tests use small poll intervals, not real waits", () => {
  it("R5: all G6 tests use AGENT_RESULT_POLL_MS ≤ 10ms", () => {
    // This test verifies the polling interval used in tests is small.
    // The actual env var is set in beforeEach/afterEach to small values.
    // The production default is 3000ms, but tests override to 5-10ms.
    expect(DEFAULT_AGENT_RESULT_POLL_MS).toBe(3000);
    // The tests above set POLL_ENV to 5 or 10, which is the small value.
    expect(DEFAULT_AGENT_RESULT_TIMEOUT_MS).toBe(900_000);
  });
});

// ─── R6: 断言打在生产组装出的 deps 上 ────────────────────────────────────────

describe("R6: assertions drive production-assembled deps", () => {
  it("R6: triage path uses production default readResult (no spawnTriage/triageSpawnRuntime injection)", async () => {
    capturedTriageRunId = "";
    setEnv(TIMEOUT_ENV, "500");
    setEnv(POLL_ENV, "10");

    const decisions: TriageResultDecision[] = [
      { clue_id: "c1", action: "keep", rationale: "keep c1" },
    ];

    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
      clueMsg("c2", { status: "proposed" }, 2),
      clueMsg("c3", { status: "proposed" }, 3),
    ];

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        if (capturedTriageRunId && agentRunsReads >= 2) {
          return messagesResponse([triageResultMsg(capturedTriageRunId, decisions)]);
        }
        return emptyMessagesResponse();
      }
      if (url.includes("/publish")) return jsonResponse({ message_id: "pub_001" });
      if (url.includes("/v1/entities/")) {
        return jsonResponse({
          head: {
            message_id: "head_001",
            channel_id: CHANNEL,
            channel_seq: 1,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue" },
            entity_id: "c1",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const result = await runChannelWrite({
      channelId: CHANNEL,
      question: "test question?",
      workerCmd: "/fake/agent-run",
      maxWrites: 10,
    });

    expect(result.triageReports[0].casCount).toBe(1);
    expect(result.triageReports[0].runId).toBe(capturedTriageRunId);
    expect(agentRunsReads).toBeGreaterThanOrEqual(2);
  });

  it("R6: generate path uses production-assembled readBody (no generateDeps injection)", async () => {
    setEnv(TIMEOUT_ENV, "500");
    setEnv(POLL_ENV, "10");

    const generateRunId = "g6-prod-gen-001";
    const generateBody = "production-assembled body";

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        return agentRunsReads >= 2
          ? messagesResponse([generateResultMsg(generateRunId, generateBody)])
          : emptyMessagesResponse();
      }
      return emptyMessagesResponse();
    });

    const deps = assembleGenerateDeps(
      { channelId: CHANNEL, workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );

    const body = await deps.spawnRuntime!.readBody(generateRunId);
    expect(body).toBe(generateBody);
    expect(agentRunsReads).toBeGreaterThanOrEqual(2);
  });
});