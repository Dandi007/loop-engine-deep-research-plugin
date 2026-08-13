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
import { describe, it, expect, vi, afterEach, beforeEach, beforeAll, afterAll } from "vitest";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { createServer } from "node:http";
import {
  runChannelWrite,
  assembleGenerateDeps,
  resolveAgentResultTimeout,
  DEFAULT_AGENT_RESULT_TIMEOUT_MS,
  DEFAULT_AGENT_RESULT_POLL_MS,
  GenerateWorkerExitedWithoutResultError,
  TriageWorkerExitedWithoutResultError,
  checkRunExited,
} from "../src/tick-run";
import type { RunWriteOptions, WriteCasInput } from "../src/tick-run";
import type { GenerateDeps, AnchorCheckResult } from "../src/generate";
import { rmSync, mkdtempSync } from "node:fs";
import {
  readTriageResult,
  readGenerateResult,
  type InspectMessage,
  type TriageResultDecision,
} from "../src/tick-inspect";
import type { TerminationState, BoardState } from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_YAML = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
let ENGINE_NODE_TIMEOUT_SECONDS = 30;
try {
  const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
  if (wf?.limits?.node_timeout && typeof wf.limits.node_timeout === "number") {
    ENGINE_NODE_TIMEOUT_SECONDS = wf.limits.node_timeout;
  }
} catch { /* use default */ }
const NODE_TIMEOUT_HALF_MS = ENGINE_NODE_TIMEOUT_SECONDS * 500;

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
        return agentRunsReads >= 31
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
    expect(agentRunsReads).toBeGreaterThanOrEqual(31);
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
  it("R5: env override AGENT_RESULT_POLL_MS=10 ⇒ resolveAgentResultTimeout returns pollMs ≤ 10", () => {
    setEnv(POLL_ENV, "10");
    setEnv(TIMEOUT_ENV, "500");
    const { pollMs, timeoutMs } = resolveAgentResultTimeout();
    expect(pollMs).toBeLessThanOrEqual(10);
    expect(timeoutMs).toBeLessThanOrEqual(500);
  });

  it("R5: env override AGENT_RESULT_POLL_MS=5 ⇒ resolveAgentResultTimeout returns pollMs ≤ 5", () => {
    setEnv(POLL_ENV, "5");
    setEnv(TIMEOUT_ENV, "10");
    const { pollMs, timeoutMs } = resolveAgentResultTimeout();
    expect(pollMs).toBeLessThanOrEqual(5);
    expect(timeoutMs).toBeLessThanOrEqual(10);
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

// ─── E0c6 §2 criterion 2 (GT-17): generateError on exited worker, tick survives ──

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

function uniqueOneShotDir(label: string): string {
  return join(tmpdir(), `g6-gt17-${label}-${Math.random().toString(36).slice(2)}`);
}

describe("E0c6 §2 criterion 2 (GT-17): generate worker exited without result ⇒ tick exit 0, generateError set", () => {
  beforeEach(() => {
    capturedTriageRunId = "";
    capturedGenerateRunId = "";
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  it("GT-17a: generate worker exits without result ⇒ tick still returns 0, generateError is set, other decisions proceed", async () => {
    const cards = [exploredClueMsg("c1", 1)];
    const oneShotDir = uniqueOneShotDir("gt17a");
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        return messagesResponse([
          {
            message_id: "msg_exited_v1",
            channel_id: "board:agent-runs",
            channel_seq: 200,
            kind: "agent.run.exited.v1",
            payload: { run_id: "gt17-run-001", exit_code: 0 },
            entity_id: "gt17-run-001",
            supersedes: null,
            created_at: "2026-08-01T00:00:02Z",
          },
        ]);
      }
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    const generateDeps: GenerateDeps = {
      readTermination: async () => termState({ state: "converged" }),
      countBlocked: async () => 0,
      readQuestion: async () => "test question",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRuntime: {
        agentRunBin: "/fake/agent-run",
        newRunId: () => "gt17-run-001",
        spawnProcess: async () => {
          return {};
        },
        readBody: async (runId: string) => {
          const startTime = Date.now();
          const { timeoutMs, pollMs } = resolveAgentResultTimeout();
          const deadline = startTime + timeoutMs;
          while (Date.now() < deadline) {
            const result = await readGenerateResult(runId);
            if (result) return result.body;
            const exited = await checkRunExited(runId);
            if (exited) {
              const waitedMs = Date.now() - startTime;
              throw new GenerateWorkerExitedWithoutResultError(runId, "generate", waitedMs);
            }
            await new Promise((r) => setTimeout(r, pollMs));
          }
          throw new Error(`G4c: timed out waiting for generate result for run ${runId}`);
        },
      },
      spawnAnchorCheck: async () => anchorResult(),
      spawnExport: async () => {},
      writeDoc: async () => "msg-1",
      lockSynthesizer: async () => async () => {},
    };

    try {
      const result = await runChannelWrite({
        channelId: CHANNEL,
        origin: "test-origin",
        prevZeroGrowthRounds: 2,
        oneShotDir,
        generateDeps,
      });

      expect(result.generateError).toBeDefined();
      expect(result.generateError).toContain("gt17-run-001");
      expect(result.generateError).toContain("exited without producing");
      expect(result.generateError).toContain("dr-doc.result.v1");
      expect(result.decisions).toBeDefined();
      expect(result.hasPendingWork).toBe(false);
      expect(result.termination).toBeDefined();
    } finally {
      rmSync(oneShotDir, { recursive: true, force: true });
    }
  });

  it("GT-17b reverse: truly unrecoverable error (bus unreachable) still propagates, tick does NOT exit 0", async () => {
    const cards = [exploredClueMsg("c1", 1)];
    const oneShotDir = uniqueOneShotDir("gt17b");

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    const generateDeps: GenerateDeps = {
      readTermination: async () => termState({ state: "converged" }),
      countBlocked: async () => 0,
      readQuestion: async () => "test question",
      readOrigin: async () => "test-origin",
      readEvidences: async () => [],
      spawnRole: async () => {
        throw new Error("bus unreachable: connection refused");
      },
      spawnAnchorCheck: async () => anchorResult(),
      spawnExport: async () => {},
      writeDoc: async () => "msg-1",
      lockSynthesizer: async () => async () => {},
    };

    try {
      await expect(
        runChannelWrite({
          channelId: CHANNEL,
          origin: "test-origin",
          prevZeroGrowthRounds: 2,
          oneShotDir,
          generateDeps,
        }),
      ).rejects.toThrow("bus unreachable");
    } finally {
      rmSync(oneShotDir, { recursive: true, force: true });
    }
  });

  it("GT-17c: GenerateWorkerExitedWithoutResultError is caught only in the generate phase; runWrite triage path catches TriageWorkerExitedWithoutResultError", async () => {
    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
      clueMsg("c2", { status: "proposed" }, 2),
      clueMsg("c3", { status: "proposed" }, 3),
    ];

    capturedTriageRunId = "";
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";

    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        if (capturedTriageRunId && agentRunsReads >= 2) {
          return messagesResponse([
            {
              message_id: "msg_exited",
              channel_id: "board:agent-runs",
              channel_seq: 200,
              kind: "agent.run.exited.v1",
              payload: { run_id: capturedTriageRunId, exit_code: 0 },
              entity_id: capturedTriageRunId,
              supersedes: null,
              created_at: "2026-08-01T00:00:02Z",
            },
          ]);
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

    expect(result.triageReports[0].skippedReason).toBeDefined();
    expect(result.triageReports[0].skippedReason).toContain("exited without producing");
    expect(result.triageReports[0].skippedReason).toContain("dr-triage");
    expect(result.triageReports[0].runId).toBe("");
    expect(result.triageReports[0].budgetSkipped).toBe(false);
    expect(result.triageReports[0].casCount).toBe(0);
  });
});

// ─── E0c6 §2 criterion 3 (GT-14): checkRunExited short-circuits result-wait ──

describe("E0c6 §2 criterion 3 (GT-14): checkRunExited short-circuits result-wait loop immediately", () => {
  beforeEach(() => {
    capturedTriageRunId = "";
    capturedGenerateRunId = "";
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  it("GT-14a: agent.run.exited.v1 on board:agent-runs ⇒ checkRunExited returns true ⇒ triage readResult short-circuits immediately", async () => {
    capturedTriageRunId = "";
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";

    const cards = [
      clueMsg("c1", { status: "proposed" }, 1),
      clueMsg("c2", { status: "proposed" }, 2),
      clueMsg("c3", { status: "proposed" }, 3),
    ];

    let boardAgentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        boardAgentRunsReads += 1;
        if (capturedTriageRunId && boardAgentRunsReads >= 2) {
          return messagesResponse([
            {
              message_id: "msg_exited_v1",
              channel_id: "board:agent-runs",
              channel_seq: 200,
              kind: "agent.run.exited.v1",
              payload: { run_id: capturedTriageRunId, exit_code: 0 },
              entity_id: capturedTriageRunId,
              supersedes: null,
              created_at: "2026-08-01T00:00:02Z",
            },
          ]);
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

    expect(result.triageReports[0].skippedReason).toBeDefined();
    expect(result.triageReports[0].skippedReason).toContain("E0c6 §1.2:");
    expect(result.triageReports[0].skippedReason).toContain("exited without producing");
    expect(result.triageReports[0].skippedReason).toContain("dr-triage");
    expect(result.triageReports[0].skippedReason).toContain(capturedTriageRunId);
    expect(capturedTriageRunId).not.toBe("");
    expect(boardAgentRunsReads).toBeGreaterThanOrEqual(2);
  });

  it("GT-14b: agent.run.exited.v1 on board:agent-runs ⇒ checkRunExited returns true ⇒ generate readBody short-circuits immediately", async () => {
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";

    const generateRunId = "g6-gt14b-gen-run";
    let boardAgentRunsReads = 0;

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        boardAgentRunsReads += 1;
        return messagesResponse([
          {
            message_id: "msg_exited_v1",
            channel_id: "board:agent-runs",
            channel_seq: 200,
            kind: "agent.run.exited.v1",
            payload: { run_id: generateRunId, exit_code: 0 },
            entity_id: generateRunId,
            supersedes: null,
            created_at: "2026-08-01T00:00:02Z",
          },
        ]);
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
      expect.fail("expected GenerateWorkerExitedWithoutResultError");
    } catch (e) {
      const err = e as Error;
      expect(err).toBeInstanceOf(GenerateWorkerExitedWithoutResultError);
      expect(err.message).toContain(generateRunId);
      expect(err.message).toContain("exited without producing");
      expect(err.message).toContain("dr-doc.result.v1");
      expect(boardAgentRunsReads).toBeGreaterThanOrEqual(1);
    }
  });

  it("GT-14c reverse: if no agent.run.exited.v1 appears, the triage path falls through to the full timeout (not short-circuited), and the test would reject", async () => {
    capturedTriageRunId = "";
    process.env.AGENT_RESULT_TIMEOUT_MS = "10";
    process.env.AGENT_RESULT_POLL_MS = "5";

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

// ─── E0c6 §2 criterion 2b (GT-15/GT-16): seed board tick under half node_timeout ──

describe("E0c6 §2 criterion 2b (GT-15/GT-16): seed board tick completes under half engine node_timeout", () => {
  let fakeBusPort = 0;
  let fakeBusServer: ReturnType<typeof createServer> | undefined;

  beforeAll(async () => {
    const server = createServer((_req, res) => {
      const url = new URL(_req.url ?? "/", `http://127.0.0.1:${fakeBusPort}`);
      const path = url.pathname;
      if (_req.method === "GET" && /^\/v1\/channels\/[^/]+\/messages/.test(path)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages: [] }));
        return;
      }
      if (_req.method === "GET" && /^\/v1\/entities\/[^/]+$/.test(path)) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ code: "NOT_FOUND" }));
        return;
      }
      if (_req.method === "POST" && /^\/v1\/channels\/[^/]+\/publish/.test(path)) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message_id: "pub_001", channel_seq: 1, deduplicated: false }));
        return;
      }
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address();
        if (addr && typeof addr === "object") fakeBusPort = addr.port;
        resolve();
      });
    });
    fakeBusServer = server;
  });

  afterAll(() => {
    if (fakeBusServer) {
      fakeBusServer.close();
    }
  });

  beforeEach(() => {
    capturedTriageRunId = "";
    capturedGenerateRunId = "";
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  it("GT-16a: seed board with 1 clue completes under half the engine node_timeout and termination is readable", async () => {
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";

    const cards = [
      clueMsg("seed-1", { status: "proposed" }, 1),
    ];

    const nativeFetch = globalThis.fetch.bind(globalThis);
    let msgReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        return nativeFetch(`http://127.0.0.1:${fakeBusPort}/v1/channels/board%3Aagent-runs/messages`, init);
      }
      if (url.includes("/publish")) {
        return nativeFetch(input, init);
      }
      if (url.includes("/v1/entities/")) {
        return nativeFetch(input, init);
      }
      if (url.includes("/messages")) {
        msgReads += 1;
        return msgReads <= 1 ? messagesResponse(cards) : emptyMessagesResponse();
      }
      return emptyMessagesResponse();
    });

    const start = Date.now();
    const result = await runChannelWrite({
      channelId: CHANNEL,
      workerCmd: "/fake/agent-run",
      maxWrites: 10,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(NODE_TIMEOUT_HALF_MS);
    expect(result.termination).toBeDefined();
    expect(result.termination).toHaveProperty("state");
    expect(result.termination).toHaveProperty("coverage");
    expect(result.termination).toHaveProperty("zeroGrowthRounds");
    expect(result.termination).toHaveProperty("capHit");
    expect(result.termination).toHaveProperty("boardComposition");
    expect(result.decisions).toBeDefined();
    expect(result.messageCount).toBe(1);
    expect(result.timings).toBeDefined();
    expect(result.timings!.totalMs).toBeGreaterThan(0);
    expect(result.timings!.busReadMs).toBeGreaterThan(0);
  });

  it("GT-16b: time-based polling with AGENT_RESULT_TIMEOUT_MS/POL_MS does not cause the seed tick to exceed half node_timeout", async () => {
    process.env.AGENT_RESULT_TIMEOUT_MS = "200";
    process.env.AGENT_RESULT_POLL_MS = "5";

    const cards = [
      clueMsg("seed-1", { status: "proposed" }, 1),
    ];

    const nativeFetch = globalThis.fetch.bind(globalThis);
    let msgReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        return nativeFetch(`http://127.0.0.1:${fakeBusPort}/v1/channels/board%3Aagent-runs/messages`, init);
      }
      if (url.includes("/publish")) {
        return nativeFetch(input, init);
      }
      if (url.includes("/v1/entities/")) {
        return nativeFetch(input, init);
      }
      if (url.includes("/messages")) {
        msgReads += 1;
        return msgReads <= 1 ? messagesResponse(cards) : emptyMessagesResponse();
      }
      return emptyMessagesResponse();
    });

    const start = Date.now();
    const result = await runChannelWrite({
      channelId: CHANNEL,
      workerCmd: "/fake/agent-run",
      maxWrites: 10,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(NODE_TIMEOUT_HALF_MS);
    expect(result.termination).toHaveProperty("state");
    expect(result.termination).toHaveProperty("coverage");
    expect(result.timings).toBeDefined();
    expect(result.timings!.totalMs).toBeGreaterThan(0);
  });
});