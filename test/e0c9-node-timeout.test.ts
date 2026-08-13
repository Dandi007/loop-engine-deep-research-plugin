/**
 * E0c9 —— node_timeout 校正 + 退出无结果不毙 tick + 兜底真能终止
 *
 * 覆盖 spec §2 判据 2–4b（判别性单测）。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  runChannelWrite,
  assembleGenerateDeps,
  DEFAULT_AGENT_RESULT_TIMEOUT_MS,
  RunExitedWithoutDocError,
} from "../src/tick-run";
import type { InspectMessage } from "../src/tick-inspect";
import { DEFAULT_TICK_CONFIG, type TerminationState, type BoardState } from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_YAML = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
const CHANNEL = "research:p-e0c9-timeout";

const runningBuses: number[] = [];
afterEach(() => {
  for (const pid of runningBuses.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
});

async function startFakeBus(seed?: Record<string, unknown[]>): Promise<{ port: number; pid: number }> {
  const { spawn: realSpawn } = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return new Promise((resolve, reject) => {
    const fixture = join(ROOT, "test", "fixtures", "fake-bus.mjs");
    const env: Record<string, string> = { ...process.env, A10B_BUS_PORT: "0" };
    let seedFile: string | undefined;
    if (seed) {
      seedFile = join(mkdtempSync(join(tmpdir(), "e0c9-bus-seed-")), "seed.json");
      writeFileSync(seedFile, JSON.stringify(seed));
      env.A10B_SEED = seedFile;
    }
    let stdout = "";
    const child = realSpawn(process.execPath, [fixture], {
      env,
      stdio: ["ignore", "pipe", "ignore"],
    });
    const pid = child.pid as number;
    runningBuses.push(pid);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const deadline = Date.now() + 5000;
    const check = (port: number) => {
      fetch(`http://127.0.0.1:${port}/v1/channels/_probe`)
        .then(() => resolve({ port, pid }))
        .catch(() => {
          if (Date.now() > deadline) reject(new Error("fake bus did not come up"));
          else setTimeout(() => check(port), 50);
        });
    };
    child.on("error", (err) => reject(err));
    const parsePort = () => {
      const m = stdout.match(/fakebus listening on (\d+)/);
      if (m) {
        const port = Number(m[1]);
        if (port > 0) {
          check(port);
          return;
        }
      }
      if (Date.now() > deadline) {
        reject(new Error("fake bus did not output listening port"));
        return;
      }
      setTimeout(parsePort, 50);
    };
    setTimeout(parsePort, 50);
  });
}

// Mock child_process.spawn to prevent ENOENT for fake agent-run
function createMockChild() {
  const EventEmitter = require("node:events").EventEmitter;
  const child = new EventEmitter();
  child.pid = 12345;
  child.unref = () => {};
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  setImmediate(() => child.emit("exit", 0));
  return child;
}

// Store captured triage run_id for test assertions
let __capturedTriageRunId = "";

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual("node:child_process") as typeof import("node:child_process");
  return {
    ...actual,
    spawn: (cmd: string, args: string[], opts?: unknown) => {
      const runIdIdx = args.indexOf("--run-id");
      const roleIdx = args.indexOf("--role");
      if (runIdIdx >= 0 && roleIdx >= 0 && args[roleIdx + 1] === "dr-triage") {
        __capturedTriageRunId = args[runIdIdx + 1] ?? "";
      }
      return createMockChild();
    },
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
      status: "explored",
      text: `clue ${clueId}`,
      depth: 1,
      sources: ["code-local"],
      ...over,
    },
    entity_id: clueId,
    supersedes: null,
    created_at: "2026-08-01T00:00:00Z",
  };
}

function triageResultMsg(runId: string, decisions: Array<{ clue_id: string; action: "keep" | "drop"; rationale: string }>, seq = 100): InspectMessage {
  return {
    message_id: `msg_triage_${runId}`,
    channel_id: "board:agent-runs",
    channel_seq: seq,
    kind: "dr-triage.result.v1",
    payload: { run_id: runId, decisions },
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
  return { cards: [], runs: {}, triageInFlight: false, ...over };
}

function setEnv(k: string, v: string | undefined): void {
  if (v === undefined) delete process.env[k];
  else process.env[k] = v;
}

// ══════════════════════════════════════════════════════════════════════
// 判据 2: node_timeout >= 实测最大单 tick 耗时 x 倍数
// ══════════════════════════════════════════════════════════════════════

describe("判据 2: node_timeout >= measured max single-tick duration x headroom multiplier", () => {
  it("workflow.yaml limits.node_timeout >= 904.2s x 1.99", () => {
    const yaml = readFileSync(WORKFLOW_YAML, "utf8");
    const doc = parse(yaml) as { limits?: { node_timeout?: number } };
    const nodeTimeout = doc?.limits?.node_timeout;
    expect(nodeTimeout).toBeDefined();
    const MEASURED_MAX_SECONDS = 904.2;
    expect(nodeTimeout).toBeGreaterThan(MEASURED_MAX_SECONDS);
    expect(nodeTimeout! / MEASURED_MAX_SECONDS).toBeGreaterThanOrEqual(1.99);
  });

  it("node_timeout is exactly 1800 (round value)", () => {
    const yaml = readFileSync(WORKFLOW_YAML, "utf8");
    const doc = parse(yaml) as { limits?: { node_timeout?: number } };
    expect(doc?.limits?.node_timeout).toBe(1800);
  });

  it("discriminant: set node_timeout to 30 would fail the assertion", () => {
    const yaml = readFileSync(WORKFLOW_YAML, "utf8");
    const doc = parse(yaml) as { limits?: { node_timeout?: number } };
    const nodeTimeout = doc?.limits?.node_timeout;
    expect(nodeTimeout).not.toBe(30);
    expect(nodeTimeout).toBeGreaterThan(30);
  });

  it("node_timeout > DEFAULT_AGENT_RESULT_TIMEOUT_MS/1000 (900s engine guillotine)", () => {
    const yaml = readFileSync(WORKFLOW_YAML, "utf8");
    const doc = parse(yaml) as { limits?: { node_timeout?: number } };
    const nodeTimeout = doc?.limits?.node_timeout ?? 0;
    expect(nodeTimeout).toBeGreaterThan(DEFAULT_AGENT_RESULT_TIMEOUT_MS / 1000);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 2a (GT-19): 墙钟预算为主，墙钟先于次数检查
// ══════════════════════════════════════════════════════════════════════

describe("判据 2a (GT-19): wall clock budget is primary", () => {
  const BIN = join(ROOT, "bin", "e0-regression.sh");
  const TEST_BUS_URL = "http://127.0.0.1:7495";
  const TEST_TOKEN = "/data/agent-bus-test/tokens/uther-tui.token";

  function runScript(env: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
    try {
      const out = execFileSync("bash", [BIN], {
        cwd: ROOT,
        encoding: "utf8",
        env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 120_000,
      });
      return { code: 0, out, err: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
      return {
        code: err.status ?? -1,
        out: String(err.stdout ?? ""),
        err: String(err.stderr ?? ""),
      };
    }
  }

  it("wall clock is checked before attempt count in e0-regression.sh", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    const wallClockIdx = script.indexOf("HIT WALL CLOCK LIMIT");
    const attemptIdx = script.indexOf("HIT ATTEMPT LIMIT");
    expect(wallClockIdx).toBeGreaterThan(0);
    expect(attemptIdx).toBeGreaterThan(0);
    expect(wallClockIdx).toBeLessThan(attemptIdx);
  });

  it("profile DRAIN_MAX_ATTEMPTS > wall_clock / (shortest drain + backoff) by safe margin", () => {
    const profilePath = join(ROOT, "profiles", "deploy", "e0-regression.env");
    const content = readFileSync(profilePath, "utf8");
    const wallClock = Number(content.match(/DRAIN_WALL_CLOCK_SECONDS=(\d+)/)?.[1]);
    const backoff = Number(content.match(/DRAIN_BACKOFF_SECONDS=(\d+)/)?.[1]);
    const maxAttempts = Number(content.match(/DRAIN_MAX_ATTEMPTS=(\d+)/)?.[1]);
    expect(wallClock).toBeGreaterThan(0);
    expect(backoff).toBeGreaterThan(0);
    expect(maxAttempts).toBeGreaterThan(0);
    const worstCaseThroughput = wallClock / backoff;
    expect(maxAttempts).toBeGreaterThan(worstCaseThroughput);
    expect(maxAttempts).toBeGreaterThanOrEqual(worstCaseThroughput * 2);
  });

  it("discriminant: DRAIN_MAX_ATTEMPTS=12 would be <= worst-case throughput", () => {
    const profilePath = join(ROOT, "profiles", "deploy", "e0-regression.env");
    const content = readFileSync(profilePath, "utf8");
    const maxAttempts = Number(content.match(/DRAIN_MAX_ATTEMPTS=(\d+)/)?.[1]);
    expect(maxAttempts).not.toBe(12);
  });

  it("profile comment documents the formula with arithmetic", () => {
    const profilePath = join(ROOT, "profiles", "deploy", "e0-regression.env");
    const content = readFileSync(profilePath, "utf8");
    expect(content).toMatch(/墙钟预算/);
    expect(content).toMatch(/2400\s*\/\s*\(/);
  });

  it("executing e0-regression.sh: with DRAIN_WALL_CLOCK_SECONDS=20 DRAIN_MAX_ATTEMPTS=100, hits wall clock not attempt limit", () => {
    const recRoot = mkdtempSync(join(tmpdir(), "e0c9-2a-wc-"));
    const exportRoot = mkdtempSync(join(tmpdir(), "e0c9-2a-exp-"));
    try {
      const env = {
        ...process.env,
        AGENT_BUS_URL: TEST_BUS_URL,
        AGENT_BUS_TOKEN_FILE: TEST_TOKEN,
        E0_RECORD_ROOT: recRoot,
        LOOP_ENGINE_RUNTIME_ROOT: "/data/loop-engine",
        DRAIN_WALL_CLOCK_SECONDS: "20",
        DRAIN_BACKOFF_SECONDS: "5",
        DRAIN_MAX_ATTEMPTS: "100",
        MAX_CLUES: "4",
        MAX_WRITES: "16",
        TRIAGE_THRESHOLD: "1",
        EXPORT_ROOT: exportRoot,
      };
      const res = runScript(env);
      expect(res.err).toContain("HIT WALL CLOCK LIMIT");
      if (res.err.includes("HIT ATTEMPT LIMIT")) {
        expect(res.err).not.toMatch(/HIT ATTEMPT LIMIT/);
      }
    } finally {
      rmSync(recRoot, { recursive: true, force: true });
      rmSync(exportRoot, { recursive: true, force: true });
    }
  }, 120_000);

  it("discriminant: with DRAIN_MAX_ATTEMPTS=2 DRAIN_WALL_CLOCK_SECONDS=2400, script hits attempt limit (not wall clock)", () => {
    const recRoot = mkdtempSync(join(tmpdir(), "e0c9-2a-att-"));
    const exportRoot = mkdtempSync(join(tmpdir(), "e0c9-2a-exp-"));
    try {
      const env = {
        ...process.env,
        AGENT_BUS_URL: TEST_BUS_URL,
        AGENT_BUS_TOKEN_FILE: TEST_TOKEN,
        E0_RECORD_ROOT: recRoot,
        LOOP_ENGINE_RUNTIME_ROOT: "/data/loop-engine",
        DRAIN_WALL_CLOCK_SECONDS: "2400",
        DRAIN_BACKOFF_SECONDS: "5",
        DRAIN_MAX_ATTEMPTS: "2",
        MAX_CLUES: "4",
        MAX_WRITES: "16",
        TRIAGE_THRESHOLD: "1",
        EXPORT_ROOT: exportRoot,
      };
      const res = runScript(env);
      expect(res.err).toContain("HIT ATTEMPT LIMIT");
    } finally {
      rmSync(recRoot, { recursive: true, force: true });
      rmSync(exportRoot, { recursive: true, force: true });
    }
  }, 120_000);
});

// ══════════════════════════════════════════════════════════════════════
// 判据 2b (GT-15/GT-16): seed board tick completes well below half node_timeout
// ══════════════════════════════════════════════════════════════════════

describe("判据 2b (GT-15/GT-16): seed-board tick well below half node_timeout", () => {
  beforeEach(() => {
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  it("seed board (1 explored clue) on real HTTP bus: tick completes with timings, totalMs below half node_timeout, termination readable", async () => {
    const seed = {
      [CHANNEL]: [
        {
          message_id: "seed_c1",
          channel_seq: 1,
          kind: "research.clue.v2",
          payload: {
            status: "explored",
            text: "seed clue",
            depth: 1,
            sources: ["code-local"],
          },
          entity_id: "c1",
        },
      ],
      "board:agent-runs": [],
    };
    const { port, pid } = await startFakeBus(seed);

    const tokenPath = join(mkdtempSync(join(tmpdir(), "e0c9-tok-")), "token");
    writeFileSync(tokenPath, "test-token\n");

    vi.resetModules();
    vi.stubEnv("AGENT_BUS_URL", `http://127.0.0.1:${port}`);
    vi.stubEnv("AGENT_BUS_TOKEN_FILE", tokenPath);
    setEnv("AGENT_RESULT_TIMEOUT_MS", "500");
    setEnv("AGENT_RESULT_POLL_MS", "10");

    const { runChannelWrite: dynRun } = await import("../src/tick-run");

    const yaml = readFileSync(WORKFLOW_YAML, "utf8");
    const doc = parse(yaml) as { limits?: { node_timeout?: number } };
    const nodeTimeout = doc?.limits?.node_timeout ?? 1800;
    const halfTimeout = nodeTimeout * 1000 * 0.5;

    const t0 = Date.now();
    const result = await dynRun({ channelId: CHANNEL });
    const elapsed = Date.now() - t0;

    expect(result.timings).toBeDefined();
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.totalMs).toBeLessThan(halfTimeout);
    expect(elapsed).toBeLessThan(halfTimeout);
    expect(result.timings.readPhaseMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.writePhaseMs).toBeGreaterThanOrEqual(0);
    expect(result.termination).toBeDefined();

    vi.resetModules();
    vi.unstubAllEnvs();
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
    rmSync(dirname(tokenPath), { recursive: true, force: true });
  }, 30_000);

  it("timings field is present in --run JSON output", async () => {
    setEnv("AGENT_RESULT_TIMEOUT_MS", "500");
    setEnv("AGENT_RESULT_POLL_MS", "10");

    const cards = [clueMsg("c1", { status: "explored" }, 1)];

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) return messagesResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMessagesResponse();
    });

    const result = await runChannelWrite({ channelId: CHANNEL });
    const json = JSON.stringify(result);
    expect(json).toContain('"timings"');
    expect(json).toContain('"totalMs"');
    expect(json).toContain('"readPhaseMs"');
    expect(json).toContain('"writePhaseMs"');
    expect(json).toContain('"generatePhaseMs"');
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 2z (GT-17): triage run exited without result ⇒ tick exits 0 with diagnostic
// ══════════════════════════════════════════════════════════════════════

describe("判据 2z (GT-17): triage run exited without result ⇒ tick exits 0 with diagnostic", () => {
  beforeEach(() => {
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  it("triage run exited without result ⇒ tick returns [], tick continues normally", async () => {
    setEnv("AGENT_RESULT_TIMEOUT_MS", "500");
    setEnv("AGENT_RESULT_POLL_MS", "10");

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
        if (__capturedTriageRunId && agentRunsReads >= 2) {
          return messagesResponse([
            {
              message_id: "msg_exited",
              channel_id: "board:agent-runs",
              channel_seq: 100,
              kind: "agent.run.exited.v2",
              payload: { run_id: __capturedTriageRunId, exit_code: 0 },
              entity_id: __capturedTriageRunId,
              supersedes: null,
              created_at: "2026-08-01T00:00:01Z",
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

    const stderrChunks: string[] = [];
    const origStderr = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(typeof chunk === "string" ? chunk : String(chunk));
      return true;
    }) as typeof process.stderr.write;

    try {
      const result = await runChannelWrite({
        channelId: CHANNEL,
        question: "test question?",
        workerCmd: "/fake/agent-run",
        maxWrites: 10,
      });

      expect(result.triageReports[0].casCount).toBe(0);
      expect(result.triageReports[0].budgetSkipped).toBe(false);
      const stderr = stderrChunks.join("");
      expect(stderr).toContain("exited without producing a dr-triage.result.v1");
      expect(stderr).toContain("recording as local failure, continuing");
      expect(stderr).toMatch(/after \d+ms/);
    } finally {
      process.stderr.write = origStderr;
    }
  });

  it("reverse case: bus unreachable ⇒ tick still must exit non-zero (throw)", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("fetch failed: connect ECONNREFUSED");
    });

    await expect(
      runChannelWrite({ channelId: CHANNEL }),
    ).rejects.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 3 (GT-14/§1.2): exited-without-result detection immediately stops waiting
// ══════════════════════════════════════════════════════════════════════

describe("判据 3 (GT-14/§1.2): exited-without-result detection immediately stops waiting", () => {
  beforeEach(() => {
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  it("generate readBody stops immediately when run exited without result (throws RunExitedWithoutDocError)", async () => {
    setEnv("AGENT_RESULT_TIMEOUT_MS", "900000");
    setEnv("AGENT_RESULT_POLL_MS", "3000");

    const generateRunId = "e0c9-gen-exited-001";
    let agentRunsReads = 0;

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        return messagesResponse([
          {
            message_id: "msg_exited",
            channel_id: "board:agent-runs",
            channel_seq: 1,
            kind: "agent.run.exited.v2",
            payload: { run_id: generateRunId, exit_code: 0 },
            entity_id: generateRunId,
            supersedes: null,
            created_at: "2026-08-01T00:00:01Z",
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

    await expect(
      deps.spawnRuntime!.readBody(generateRunId),
    ).rejects.toThrow(RunExitedWithoutDocError);

    expect(agentRunsReads).toBeLessThanOrEqual(6);
  });

  it("triage readResult stops immediately when run exited without result (polls bounded, returns [])", async () => {
    setEnv("AGENT_RESULT_TIMEOUT_MS", "900000");
    setEnv("AGENT_RESULT_POLL_MS", "3000");

    const triageRunId = "e0c9-triage-exited-001";
    let agentRunsReads = 0;

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        return messagesResponse([
          {
            message_id: "msg_exited",
            channel_id: "board:agent-runs",
            channel_seq: 1,
            kind: "agent.run.exited.v2",
            payload: { run_id: triageRunId, exit_code: 0 },
            entity_id: triageRunId,
            supersedes: null,
            created_at: "2026-08-01T00:00:01Z",
          },
        ]);
      }
      return emptyMessagesResponse();
    });

    const { readTriageResult } = await import("../src/tick-inspect");
    const { resolveAgentResultTimeout } = await import("../src/tick-run");

    const { timeoutMs, pollMs } = resolveAgentResultTimeout();
    const startTs = Date.now();
    const deadline = startTs + timeoutMs;
    let pollCount = 0;
    let result: unknown = null;

    while (Date.now() < deadline) {
      pollCount += 1;
      const triageResult = await readTriageResult(triageRunId);
      if (triageResult !== null) {
        result = triageResult;
        break;
      }
      const runsMsgs = await (await import("../src/tick-inspect")).readChannelMessages("board:agent-runs");
      if ((await import("../src/tick-inspect")).hasRunExited(triageRunId, runsMsgs)) {
        result = [];
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }

    expect(result).toEqual([]);
    expect(pollCount).toBeLessThanOrEqual(6);
    expect(agentRunsReads).toBeLessThanOrEqual(12);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 4 (§1.3): check-drain-failures detects TIMEOUT failures
// ══════════════════════════════════════════════════════════════════════

describe("判据 4 (§1.3): check-drain-failures detects TIMEOUT failures", () => {
  function runCheckDrainFailures(drainSummary: string, engineRoot: string): { code: number; err: string } {
    const checkScript = join(ROOT, "scripts", "check-drain-failures.mjs");
    try {
      execFileSync("node", [checkScript], {
        cwd: ROOT,
        encoding: "utf8",
        input: drainSummary,
        env: { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: engineRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { code: 0, err: "" };
    } catch (e) {
      const ee = e as { status?: number; stderr?: string | Buffer };
      return { code: ee.status ?? -1, err: String(ee.stderr ?? "") };
    }
  }

  function setupDrainEnv(drainId: string, journalResult: string, journalError?: string): { dir: string; engineRoot: string; runDir: string } {
    const dir = mkdtempSync(join(tmpdir(), "e0c9-c4-"));
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs", `run-${drainId}`);
    const runDir = join(runsRoot, "tick-run");
    mkdirSync(runDir, { recursive: true });

    const indexFile = join(engineRoot, "index.jsonl");
    writeFileSync(indexFile, JSON.stringify({
      schema: "lei/1", kind: "run.start", run_id: "tick~1", label: "tick",
      fleet: "fleet.yaml", caller: "drain", run_dir: runDir,
      ts: new Date().toISOString(), pid: 12345, drain_id: drainId, lane: "tick", tick: 1,
    }) + "\n");

    const journalEntry: Record<string, unknown> = {
      run_id: "tick~1", identity: "tick", result: journalResult, effects: [],
    };
    if (journalError) journalEntry.error = journalError;
    writeFileSync(join(runDir, "journal.jsonl"), JSON.stringify(journalEntry) + "\n");

    return { dir, engineRoot, runDir };
  }

  it("detects [外部调用失败 status=TIMEOUT] in journal", () => {
    const drainId = "test-drain-c4-a";
    const { dir, engineRoot, runDir } = setupDrainEnv(drainId, "[外部调用失败 status=TIMEOUT]\n", "exec");
    const drainSummary = JSON.stringify({ reason: "drained", rounds: 1, ticksByLabel: { tick: 1 }, runs_root: join(engineRoot, "runs", `run-${drainId}`), drain_id: drainId });
    const res = runCheckDrainFailures(drainSummary, engineRoot);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("TICK FAILURE");
    expect(res.err).toContain(runDir);
    expect(res.err).toContain("TIMEOUT");
    rmSync(dir, { recursive: true, force: true });
  });

  it("detects JSON journal entry with error=exec and TIMEOUT result", () => {
    const drainId = "test-drain-c4-b";
    const { dir, engineRoot, runDir } = setupDrainEnv(drainId, "[外部调用失败 status=TIMEOUT]\n", "exec");
    const drainSummary = JSON.stringify({ reason: "drained", rounds: 1, ticksByLabel: { tick: 1 }, runs_root: join(engineRoot, "runs", `run-${drainId}`), drain_id: drainId });
    const res = runCheckDrainFailures(drainSummary, engineRoot);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("TICK FAILURE");
    expect(res.err).toContain(runDir);
    rmSync(dir, { recursive: true, force: true });
  });

  it("still detects legacy [bash 非零退出 EXIT:N] pattern", () => {
    const drainId = "test-drain-c4-legacy";
    const { dir, engineRoot, runDir } = setupDrainEnv(drainId, "[bash 非零退出 EXIT:2]\nbus GET: 404");
    const drainSummary = JSON.stringify({ reason: "drained", rounds: 1, ticksByLabel: { tick: 1 }, runs_root: join(engineRoot, "runs", `run-${drainId}`), drain_id: drainId });
    const res = runCheckDrainFailures(drainSummary, engineRoot);
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("TICK FAILURE");
    expect(res.err).toContain(runDir);
    expect(res.err).toContain("exit=2");
    rmSync(dir, { recursive: true, force: true });
  });

  it("all ticks succeed => exit 0", () => {
    const drainId = "test-drain-c4-ok";
    const { dir, engineRoot } = setupDrainEnv(drainId, "OK: all fine");
    const drainSummary = JSON.stringify({ reason: "drained", rounds: 1, ticksByLabel: { tick: 1 }, runs_root: join(engineRoot, "runs", `run-${drainId}`), drain_id: drainId });
    const res = runCheckDrainFailures(drainSummary, engineRoot);
    expect(res.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 4b (regression): TICK FAILURE is visible and names run_dir, MAX_CLUES by profile
// ══════════════════════════════════════════════════════════════════════

describe("判据 4b (regression): TICK FAILURE visible, names run_dir, MAX_CLUES by profile", () => {
  it("deep-research-loop.sh calls check-drain-failures.mjs after drain", () => {
    const script = readFileSync(join(ROOT, "bin", "deep-research-loop.sh"), "utf8");
    expect(script).toContain("check-drain-failures.mjs");
  });

  it("check-drain-failures.mjs has TIMEOUT detection", () => {
    const script = readFileSync(join(ROOT, "scripts", "check-drain-failures.mjs"), "utf8");
    expect(script).toContain("外部调用失败 status=TIMEOUT");
    expect(script).toContain("error=exec");
    expect(script).toContain("TICK FAILURE");
  });

  it("e0-regression profile declares MAX_CLUES=16", () => {
    const profile = readFileSync(join(ROOT, "profiles", "deploy", "e0-regression.env"), "utf8");
    expect(profile).toContain("MAX_CLUES=16");
  });

  it("e0-regression profile has MAX_WRITES=96", () => {
    const profile = readFileSync(join(ROOT, "profiles", "deploy", "e0-regression.env"), "utf8");
    expect(profile).toContain("MAX_WRITES=96");
  });

  it("fleet.yaml.tpl wires max_clues", () => {
    const tpl = readFileSync(join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl"), "utf8");
    expect(tpl).toContain("max_clues");
  });

  it("deep-research-loop.sh exports MAX_CLUES", () => {
    const script = readFileSync(join(ROOT, "bin", "deep-research-loop.sh"), "utf8");
    expect(script).toContain("MAX_CLUES");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 5 (regression): E0c1/E0c2f/E0c3b previous behavior preserved
// ══════════════════════════════════════════════════════════════════════

describe("判据 5 (regression): previous behavior preserved", () => {
  it("DEFAULT_TICK_CONFIG.maxClues still 64", () => {
    expect(DEFAULT_TICK_CONFIG.maxClues).toBe(64);
  });

  it("DEFAULT_TICK_CONFIG.triageThreshold still 3", () => {
    expect(DEFAULT_TICK_CONFIG.triageThreshold).toBe(3);
  });

  it("e0-regression.sh has both wall clock and attempt limit checks", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    expect(script).toContain("HIT WALL CLOCK LIMIT");
    expect(script).toContain("HIT ATTEMPT LIMIT");
    expect(script).toContain("DRAIN_WALL_CLOCK_SECONDS");
    expect(script).toContain("DRAIN_MAX_ATTEMPTS");
  });

  it("e0-regression.sh DRAIN_MAX_ATTEMPTS safety net still causes non-zero exit", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    expect(script).toContain("DRAIN_MAX_ATTEMPTS");
    expect(script).toContain("HIT ATTEMPT LIMIT");
    expect(script).toMatch(/HIT ATTEMPT LIMIT[\s\S]*LOOP_EXIT=4[\s\S]*break/);
  });
});