/**
 * E0c4 —— tick 大板面超时修复：判别性测试
 *
 * 判据 2 (GT-13/§1.1): 板面已达规模且处于终态 ⇒ 单个 tick --run 在声明上界内返回
 * 判据 3 (GT-14/§1.2): run 已 exited 但无 result ⇒ 读取立即结束并产出诊断
 * 判据 4 (§1.3): drain 内出现 tick exec_failed ⇒ 入口响亮失败
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import {
  RunExitedWithoutResultError,
  TickTimeoutError,
  DEFAULT_AGENT_RESULT_TIMEOUT_MS,
  DEFAULT_AGENT_RESULT_POLL_MS,
  TRIAGE_ROLE,
  type WriteCasInput,
} from "../src/tick-run";
import { runChannelWrite } from "../src/tick-run";
import { assembleGenerateDeps } from "../src/tick-run";
import type { RunWriteOptions } from "../src/tick-run";
import {
  findRunExited,
  type InspectMessage,
  type TriageResultDecision,
} from "../src/tick-inspect";
import type { TerminationState, BoardState } from "../src/tick";

const CHANNEL = "research:e0c4-tick-timeout";

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

function agentRunExitedMsg(
  runId: string,
  exitCode: number,
  seq = 1,
): InspectMessage {
  return {
    message_id: `msg_run_exited_${runId}`,
    channel_id: "board:agent-runs",
    channel_seq: seq,
    kind: "agent.run.exited.v1",
    payload: {
      run_id: runId,
      exit_code: exitCode,
    },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-08-01T00:00:01Z",
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
    boardComposition: { proposed: 0, open: 0, inFlight: 0, explored: 0, blocked: 0 },
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

const TIMEOUT_ENV = "AGENT_RESULT_TIMEOUT_MS";
const POLL_ENV = "AGENT_RESULT_POLL_MS";
const TICK_TO_ENV = "TICK_TIMEOUT_MS";

beforeEach(() => {
  capturedTriageRunId = "";
  capturedGenerateRunId = "";
  delete process.env[TIMEOUT_ENV];
  delete process.env[POLL_ENV];
  delete process.env[TICK_TO_ENV];
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env[TIMEOUT_ENV];
  delete process.env[POLL_ENV];
  delete process.env[TICK_TO_ENV];
});

// ─── 判据 2 (GT-13/§1.1): 板面已达规模且处于终态 ⇒ 单个 tick --run 在声明上界内返回 ───

describe("E0c4 §1.1: tick --run on large board returns in bounded time", () => {
  it("GT-13: large terminal board (65 explored/blocked, 84 evidence) returns quickly with termination.state readable", async () => {
    capturedTriageRunId = "";
    setEnv("TICK_TIMEOUT_MS", "5000");
    setEnv(TIMEOUT_ENV, "5000");
    setEnv(POLL_ENV, "10");

    const cards: InspectMessage[] = [];
    for (let i = 0; i < 50; i++) {
      cards.push(clueMsg(`e${i}`, { status: "explored" }, i + 1));
    }
    for (let i = 50; i < 65; i++) {
      cards.push(clueMsg(`b${i}`, { status: "blocked" }, i + 1));
    }

    const evidenceMsgs: InspectMessage[] = [];
    for (let i = 0; i < 84; i++) {
      evidenceMsgs.push({
        message_id: `ev_${i}`,
        channel_id: "research:fake-evidence",
        channel_seq: i + 1,
        kind: "research.evidence.v2",
        payload: { clue_id: `e${i % 50}`, anchor: `a${i}`, quote: `q${i}`, claim: `c${i}` },
        entity_id: `ev_${i}`,
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      });
    }

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        return emptyMessagesResponse();
      }
      if (url.includes("research:fake-evidence")) {
        return messagesResponse(evidenceMsgs);
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
            payload: { status: "explored", text: "clue" },
            entity_id: "e0",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const startTime = Date.now();
    const outcome = await runChannelWrite({
      channelId: CHANNEL,
      question: "test question?",
      workerCmd: "/fake/agent-run",
      maxWrites: 100,
      maxClues: 64,
      triageThreshold: 3,
      evidenceChannelId: "research:fake-evidence",
    });
    const elapsed = Date.now() - startTime;
    expect(elapsed).toBeLessThan(5000);
    expect(outcome.termination.state).toBe("capped");
    expect(outcome.termination.capHit).toBe(true);
    expect(outcome.termination.boardComposition.proposed).toBe(0);
    expect(outcome.termination.boardComposition.open).toBe(0);
    expect(outcome.termination.boardComposition.inFlight).toBe(0);
  });

  it("D3 discriminant: with proposed cards, triage exited without result throws quickly via production default readResult", async () => {
    capturedTriageRunId = "";
    setEnv("TICK_TIMEOUT_MS", "5000");
    setEnv(TIMEOUT_ENV, "5000");
    setEnv(POLL_ENV, "10");

    const cards: InspectMessage[] = [];
    for (let i = 0; i < 30; i++) {
      cards.push(clueMsg(`p${i}`, { status: "proposed" }, i + 1));
    }
    for (let i = 30; i < 50; i++) {
      cards.push(clueMsg(`e${i}`, { status: "explored" }, i + 1));
    }
    for (let i = 50; i < 65; i++) {
      cards.push(clueMsg(`b${i}`, { status: "blocked" }, i + 1));
    }

    const evidenceMsgs: InspectMessage[] = [];
    for (let i = 0; i < 84; i++) {
      evidenceMsgs.push({
        message_id: `ev_${i}`,
        channel_id: "research:fake-evidence",
        channel_seq: i + 1,
        kind: "research.evidence.v2",
        payload: { clue_id: `e${30 + (i % 20)}`, anchor: `a${i}`, quote: `q${i}`, claim: `c${i}` },
        entity_id: `ev_${i}`,
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      });
    }

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        if (capturedTriageRunId && agentRunsReads >= 2) {
          return messagesResponse([
            agentRunExitedMsg(capturedTriageRunId, 1),
          ]);
        }
        return emptyMessagesResponse();
      }
      if (url.includes("research:fake-evidence")) {
        return messagesResponse(evidenceMsgs);
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
            entity_id: "p0",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) return messagesResponse(cards);
      return emptyMessagesResponse();
    });

    const startTime = Date.now();
    try {
      await runChannelWrite({
        channelId: CHANNEL,
        question: "test question?",
        workerCmd: "/fake/agent-run",
        maxWrites: 100,
        maxClues: 64,
        triageThreshold: 3,
        evidenceChannelId: "research:fake-evidence",
      });
      expect.fail("expected RunExitedWithoutResultError");
    } catch (e) {
      expect(e).toBeInstanceOf(RunExitedWithoutResultError);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);
      const msg = (e as Error).message;
      expect(msg).toContain("exited without producing a result");
      expect(msg).toContain(capturedTriageRunId);
      expect(msg).toContain(TRIAGE_ROLE);
      expect(capturedTriageRunId).not.toBe("");
    }
  });

  it("D4 discriminant: tick exceeds declared TICK_TIMEOUT_MS bound throws TickTimeoutError naming slow step", async () => {
    setEnv("TICK_TIMEOUT_MS", "1");
    setEnv(TIMEOUT_ENV, "5000");
    setEnv(POLL_ENV, "10");

    const cards: InspectMessage[] = [
      clueMsg("c1", { status: "proposed" }, 1),
    ];

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      await new Promise((r) => setTimeout(r, 50));
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
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

    try {
      await runChannelWrite({
        channelId: CHANNEL,
        question: "test question?",
        workerCmd: "/fake/agent-run",
        maxWrites: 10,
      });
      expect.fail("expected TickTimeoutError");
    } catch (e) {
      expect(e).toBeInstanceOf(TickTimeoutError);
      const msg = (e as Error).message;
      expect(msg).toContain("tick exceeded declared upper bound");
      expect(msg).toContain("slow step");
    }
  });
});

// ─── 判据 3 (GT-14/§1.2): run 已 exited 但无 result ⇒ 立即停止并产出诊断 ───

describe("E0c4 §1.2: triage polling stops immediately when run exited without result", () => {
  it("triage readResult throws RunExitedWithoutResultError when run exited with no result", async () => {
    capturedTriageRunId = "";
    setEnv(TIMEOUT_ENV, "5000");
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
          return messagesResponse([
            agentRunExitedMsg(capturedTriageRunId, 1),
          ]);
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

    try {
      await runChannelWrite({
        channelId: CHANNEL,
        question: "test question?",
        workerCmd: "/fake/agent-run",
        maxWrites: 10,
      });
      expect.fail("expected RunExitedWithoutResultError");
    } catch (e) {
      expect(e).toBeInstanceOf(RunExitedWithoutResultError);
      const msg = (e as Error).message;
      expect(msg).toContain("exited without producing a result");
      expect(msg).toContain(capturedTriageRunId);
      expect(msg).toContain(TRIAGE_ROLE);
      expect(capturedTriageRunId).not.toBe("");
    }
  });

  it("D1 discriminant: if exited check is removed, triage would wait full timeout", async () => {
    capturedTriageRunId = "";
    setEnv(TIMEOUT_ENV, "5000");
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
          return messagesResponse([
            agentRunExitedMsg(capturedTriageRunId, 1),
          ]);
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

    const startTime = Date.now();
    try {
      await runChannelWrite({
        channelId: CHANNEL,
        question: "test question?",
        workerCmd: "/fake/agent-run",
        maxWrites: 10,
      });
      expect.fail("expected error");
    } catch (e) {
      expect(e).toBeInstanceOf(RunExitedWithoutResultError);
      const elapsed = Date.now() - startTime;
      // Should complete in well under the timeout (5000ms)
      expect(elapsed).toBeLessThan(2000);
    }
  });
});

describe("E0c4 §1.2: generate polling stops immediately when run exited without result", () => {
  it("generate readBody throws RunExitedWithoutResultError when run exited with no result", async () => {
    capturedGenerateRunId = "";
    setEnv(TIMEOUT_ENV, "5000");
    setEnv(POLL_ENV, "10");

    const generateRunId = "e0c4-gen-exited-001";

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        return agentRunsReads >= 2
          ? messagesResponse([agentRunExitedMsg(generateRunId, 1)])
          : emptyMessagesResponse();
      }
      return emptyMessagesResponse();
    });

    const deps = assembleGenerateDeps(
      { channelId: CHANNEL, workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );

    try {
      await deps.spawnRuntime!.readBody(generateRunId);
      expect.fail("expected RunExitedWithoutResultError");
    } catch (e) {
      expect(e).toBeInstanceOf(RunExitedWithoutResultError);
      const msg = (e as Error).message;
      expect(msg).toContain("exited without producing a result");
      expect(msg).toContain(generateRunId);
      expect(msg).toContain("generate-role");
    }
  });

  it("D2 discriminant: generate readBody stops well under the timeout when run exited", async () => {
    capturedGenerateRunId = "";
    setEnv(TIMEOUT_ENV, "5000");
    setEnv(POLL_ENV, "10");

    const generateRunId = "e0c4-gen-exited-disc-001";

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        return agentRunsReads >= 2
          ? messagesResponse([agentRunExitedMsg(generateRunId, 1)])
          : emptyMessagesResponse();
      }
      return emptyMessagesResponse();
    });

    const deps = assembleGenerateDeps(
      { channelId: CHANNEL, workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );

    const startTime = Date.now();
    try {
      await deps.spawnRuntime!.readBody(generateRunId);
      expect.fail("expected error");
    } catch (e) {
      expect(e).toBeInstanceOf(RunExitedWithoutResultError);
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);
    }
  });
});

// ─── findRunExited unit tests ───

describe("E0c4: findRunExited detects exited runs in messages", () => {
  it("returns { exited: true } when agent.run.exited exists for the run", () => {
    const runId = "test-run-001";
    const msgs: InspectMessage[] = [
      agentRunExitedMsg(runId, 0),
    ];
    const result = findRunExited(runId, msgs);
    expect(result).not.toBeNull();
    expect(result!.exited).toBe(true);
    expect(result!.exitCode).toBe(0);
  });

  it("returns { exited: false } when only agent.run.started exists", () => {
    const runId = "test-run-002";
    const msgs: InspectMessage[] = [
      {
        message_id: "msg_started",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.started.v1",
        payload: { run_id: runId },
        entity_id: runId,
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      },
    ];
    const result = findRunExited(runId, msgs);
    expect(result).not.toBeNull();
    expect(result!.exited).toBe(false);
  });

  it("returns null when no agent.run events for the run", () => {
    const runId = "test-run-003";
    const msgs: InspectMessage[] = [];
    const result = findRunExited(runId, msgs);
    expect(result).toBeNull();
  });

  it("exited event takes priority over started when both exist", () => {
    const runId = "test-run-004";
    const msgs: InspectMessage[] = [
      {
        message_id: "msg_started",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.started.v1",
        payload: { run_id: runId },
        entity_id: runId,
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      },
      agentRunExitedMsg(runId, 2),
    ];
    const result = findRunExited(runId, msgs);
    expect(result).not.toBeNull();
    expect(result!.exited).toBe(true);
    expect(result!.exitCode).toBe(2);
  });
});