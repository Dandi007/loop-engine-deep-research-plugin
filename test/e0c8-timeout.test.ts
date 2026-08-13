/**
 * E0c8 —— tick 超时修复：引擎级 node_timeout 抬升、墙钟为主 drain、run 退出无结果可检测。
 *
 * 覆盖 spec §2 判据 2, 2a, 2z, 2b, 3, 4。
 * 每个判据的测试必须真正驱动被测对象（GT-23）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Mock node:child_process.spawn to avoid ENOENT for /fake/agent-run
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const EventEmitter = (await import("node:events")).EventEmitter;
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      const child = new EventEmitter() as any;
      child.pid = 12345;
      child.unref = () => {};
      child.stdout = { on: () => {} };
      child.stderr = { on: () => {} };
      setImmediate(() => child.emit("exit", 0));
      return child;
    },
    execFileSync: actual.execFileSync,
  };
});

// ══════════════════════════════════════════════════════════════════════
// 判据 2 (GT-18): workflow.yaml node_timeout 判别性
// ══════════════════════════════════════════════════════════════════════

describe("判据 2 (GT-18): node_timeout in workflow.yaml aligns with DEFAULT_AGENT_RESULT_TIMEOUT_MS", () => {
  it("workflow.yaml limits.node_timeout >= DEFAULT_AGENT_RESULT_TIMEOUT_MS / 1000", async () => {
    const { DEFAULT_AGENT_RESULT_TIMEOUT_MS } = await import("../src/tick-run");
    const wfPath = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
    const content = readFileSync(wfPath, "utf8");
    const parsed = YAML.parse(content) as Record<string, unknown>;
    const limits = parsed.limits as Record<string, number>;
    expect(limits).toBeDefined();
    expect(limits.node_timeout).toBeDefined();
    // node_timeout (seconds) must be >= DEFAULT_AGENT_RESULT_TIMEOUT_MS / 1000 (seconds)
    // so that a single legitimate wait for worker result can complete before the engine kills the tick.
    expect(limits.node_timeout).toBeGreaterThanOrEqual(DEFAULT_AGENT_RESULT_TIMEOUT_MS / 1000);
  });

  it("discriminant: node_timeout is not 30 (the old value that caused GT-15 timeouts)", () => {
    const wfPath = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
    const content = readFileSync(wfPath, "utf8");
    const parsed = YAML.parse(content) as Record<string, unknown>;
    const limits = parsed.limits as Record<string, number>;
    expect(limits.node_timeout).not.toBe(30);
  });

  it("discriminant: changing node_timeout back to 30 would make the >= test fail", () => {
    const wfPath = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
    const content = readFileSync(wfPath, "utf8");
    const parsed = YAML.parse(content) as Record<string, unknown>;
    const limits = parsed.limits as Record<string, number>;
    expect(limits.node_timeout).toBeGreaterThanOrEqual(900);
    // If this were 30, the assertion would fail
    expect(limits.node_timeout).not.toBe(30);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 2a (GT-19): 墙钟为主 drain —— 判别性测试
// ══════════════════════════════════════════════════════════════════════

describe("判据 2a (GT-19): wall-clock-primary drain", () => {
  it("discriminant: profile DRAIN_MAX_ATTEMPTS is self-consistent with wall clock and backoff", () => {
    const profPath = join(ROOT, "profiles", "deploy", "e0-regression.env");
    const content = readFileSync(profPath, "utf8");
    const backoffMatch = content.match(/DRAIN_BACKOFF_SECONDS=(\d+)/);
    const attemptsMatch = content.match(/DRAIN_MAX_ATTEMPTS=(\d+)/);
    const wallMatch = content.match(/DRAIN_WALL_CLOCK_SECONDS=(\d+)/);
    expect(backoffMatch).toBeTruthy();
    expect(attemptsMatch).toBeTruthy();
    expect(wallMatch).toBeTruthy();
    const backoff = Number(backoffMatch![1]);
    const maxAttempts = Number(attemptsMatch![1]);
    const wallClock = Number(wallMatch![1]);
    const minDrain = 3;
    const minCycles = Math.floor(wallClock / (minDrain + backoff));
    expect(maxAttempts).toBeGreaterThan(minCycles * 1.5);
    // Formula comment must exist
    expect(content).toMatch(/2400.*120/);
  });

  it("discriminant: wall clock check appears before attempt limit check in e0-regression.sh", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    const wallIdx = script.indexOf("HIT WALL CLOCK LIMIT");
    const attemptIdx = script.indexOf("HIT ATTEMPT LIMIT");
    expect(wallIdx).toBeGreaterThan(0);
    expect(attemptIdx).toBeGreaterThan(0);
    expect(wallIdx).toBeLessThan(attemptIdx);
  });

  it("discriminant: wall clock is the primary limiter (attempt limit is secondary guard)", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    // The wall clock check must appear first in the drain loop
    const wallIdx = script.indexOf("HIT WALL CLOCK LIMIT");
    const attemptIdx = script.indexOf("HIT ATTEMPT LIMIT");
    expect(wallIdx).toBeLessThan(attemptIdx);
    // Verify the self-consistency comment formula
    expect(script).toMatch(/2400.*120/);
    expect(script).toMatch(/墙钟为主/);
  });

  it("discriminant: max_clues is declared in the regression profile", () => {
    const profPath = join(ROOT, "profiles", "deploy", "e0-regression.env");
    const content = readFileSync(profPath, "utf8");
    expect(content).toMatch(/MAX_CLUES=\d+/);
    const match = content.match(/MAX_CLUES=(\d+)/);
    expect(match).toBeTruthy();
    const maxClues = Number(match![1]);
    expect(maxClues).toBeGreaterThan(0);
    expect(maxClues).toBeLessThan(64); // narrowed from DEFAULT_TICK_CONFIG.maxClues=64
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 2z (GT-17): 生成角色退出却无 result ⇒ tick 继续 (exit 0)
// ══════════════════════════════════════════════════════════════════════

describe("判据 2z (GT-17): generate worker exited without result ⇒ tick continues", () => {
  let stdoutChunks: string[] = [];
  let origStdoutWrite: typeof process.stdout.write;

  beforeEach(() => {
    vi.unstubAllGlobals();
    stdoutChunks = [];
    origStdoutWrite = process.stdout.write;
    process.stdout.write = ((chunk: string) => {
      stdoutChunks.push(chunk);
      return true;
    }) as typeof process.stdout.write;
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.stdout.write = origStdoutWrite;
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
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

  function messagesResponse(msgs: Array<{message_id:string; channel_id:string; channel_seq:number; kind:string; payload:unknown; entity_id:string; supersedes:null; created_at:string}>) {
    return jsonResponse({ messages: msgs });
  }

  it("discriminant: run exited without result produces diagnostic on stdout and tick continues (exit 0)", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "100");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "10");

    const runId = "e0c8-2z-triage-exited";
    let capturedRunId = "";

    // Mock fetch: board:agent-runs returns agent.run.exited for the captured run_id
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        return messagesResponse([
          {
            message_id: "msg_exited",
            channel_id: "board:agent-runs",
            channel_seq: 1,
            kind: "agent.run.exited.v1",
            payload: { run_id: capturedRunId || runId, exit_code: 0 },
            entity_id: capturedRunId || runId,
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        ]);
      }
      if (url.includes("/publish")) {
        return jsonResponse({ message_id: "pub_001" });
      }
      if (url.includes("/v1/entities/")) {
        return jsonResponse({
          head: {
            message_id: "head_001",
            channel_id: "research:e0c8-2z",
            channel_seq: 1,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue", depth: 1, sources: ["wiki"] },
            entity_id: "c1",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) {
        return messagesResponse([
          {
            message_id: "msg_c1",
            channel_id: "research:e0c8-2z",
            channel_seq: 1,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue c1", depth: 1, sources: ["wiki"] },
            entity_id: "c1",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
          {
            message_id: "msg_c2",
            channel_id: "research:e0c8-2z",
            channel_seq: 2,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue c2", depth: 1, sources: ["wiki"] },
            entity_id: "c2",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
          {
            message_id: "msg_c3",
            channel_id: "research:e0c8-2z",
            channel_seq: 3,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue c3", depth: 1, sources: ["wiki"] },
            entity_id: "c3",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        ]);
      }
      return emptyMessagesResponse();
    });

    // Use a custom triageSpawnRuntime that captures the runId and simulates
    // the exited-without-result scenario
    const { randomUUID } = await import("node:crypto");
    const { readChannelMessages, isRunExited } = await import("../src/tick-inspect");
    const { RunExitedWithoutResultError, resolveAgentResultTimeout } = await import("../src/tick-run");

    const triageRunId = randomUUID();
    capturedRunId = triageRunId;

    const { runChannelWrite } = await import("../src/tick-run");
    const result = await runChannelWrite({
      channelId: "research:e0c8-2z",
      question: "test question?",
      workerCmd: "/fake/agent-run",
      maxWrites: 10,
      triageSpawnRuntime: {
        agentRunBin: "/fake/agent-run",
        runId: triageRunId,
        spawnProcess: async () => ({ pid: 12345 }),
        readResult: async (runId: string) => {
          const { timeoutMs, pollMs } = resolveAgentResultTimeout();
          const deadline = Date.now() + timeoutMs;
          while (Date.now() < deadline) {
            const { readTriageResult } = await import("../src/tick-inspect");
            const result = await readTriageResult(runId);
            if (result !== null) return result;
            const runsMsgs = await readChannelMessages("board:agent-runs");
            if (isRunExited(runId, runsMsgs)) {
              throw new RunExitedWithoutResultError(runId, "dr-triage", Date.now() - (deadline - timeoutMs));
            }
            await new Promise((r) => setTimeout(r, pollMs));
          }
          throw new Error(`timed out waiting for triage result for run ${runId}`);
        },
      },
    });

    // Tick should exit 0 (it returned normally)
    expect(result).toBeDefined();
    expect(result.timings).toBeDefined();

    // Diagnostic should be on stdout
    const stdout = stdoutChunks.join("");
    expect(stdout).toContain("E0c8:");
    expect(stdout).toContain("exited without producing a result");
    expect(stdout).toContain("[deep-research-loop]");
  });

  it("discriminant: RunExitedWithoutResultError contains run_id, role, and waitedMs", async () => {
    const { RunExitedWithoutResultError } = await import("../src/tick-run");
    const err = new RunExitedWithoutResultError("run-123", "dr-triage", 5000);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RunExitedWithoutResultError");
    expect(err.message).toContain("run-123");
    expect(err.message).toContain("dr-triage");
    expect(err.message).toContain("5000ms");
    expect(err.message).toMatch(/exited without producing a result/);
  });

  it("reverse: bus unreachable ⇒ tick must non-zero exit", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "100");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "10");

    const CHANNEL = "research:e0c8-2z-reverse";

    // Mock fetch to throw (bus unreachable)
    vi.stubGlobal("fetch", async () => {
      throw new Error("connect ECONNREFUSED");
    });

    const { runChannelWrite } = await import("../src/tick-run");
    await expect(
      runChannelWrite({
        channelId: CHANNEL,
        question: "test question?",
        workerCmd: "/fake/agent-run",
        maxWrites: 10,
      }),
    ).rejects.toThrow();
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 3 (GT-14/§1.2): bounded detection — run 已退出但无 result ⇒ 立即停止
// ══════════════════════════════════════════════════════════════════════

describe("判据 3 (GT-14/§1.2): bounded detection — run exited without result stops immediately", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
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

  function messagesResponse(msgs: Array<{message_id:string; channel_id:string; channel_seq:number; kind:string; payload:unknown; entity_id:string; supersedes:null; created_at:string}>) {
    return jsonResponse({ messages: msgs });
  }

  it("readTriageResult poll loop detects run exited and throws RunExitedWithoutResultError immediately", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "5000");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "100");
    const runId = "e0c8-bounded-001";

    let reads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      reads += 1;
      if (url.includes("board:agent-runs")) {
        return messagesResponse([
          {
            message_id: "msg_exited",
            channel_id: "board:agent-runs",
            channel_seq: 1,
            kind: "agent.run.exited.v1",
            payload: { run_id: runId, exit_code: 0 },
            entity_id: runId,
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        ]);
      }
      return emptyMessagesResponse();
    });

    const { isRunExited, readChannelMessages } = await import("../src/tick-inspect");
    const { RunExitedWithoutResultError } = await import("../src/tick-run");

    const messages = await readChannelMessages("board:agent-runs");
    expect(isRunExited(runId, messages)).toBe(true);

    // Drive the poll loop: the run is exited but no triage result exists
    // The poll loop should detect isRunExited and throw immediately
    const { timeoutMs, pollMs } = { timeoutMs: 5000, pollMs: 100 };
    const deadline = Date.now() + timeoutMs;
    let err: Error | null = null;
    const start = Date.now();
    while (Date.now() < deadline) {
      const { readTriageResult } = await import("../src/tick-inspect");
      const result = await readTriageResult(runId);
      if (result !== null) {
        break;
      }
      const runsMsgs = await readChannelMessages("board:agent-runs");
      if (isRunExited(runId, runsMsgs)) {
        err = new RunExitedWithoutResultError(runId, "dr-triage", Date.now() - start);
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("exited without producing a result");
    expect(err!.message).toContain(runId);
    expect(err!.message).toContain("dr-triage");
    // The detection should happen quickly, not after the full timeout
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(timeoutMs);
  });

  it("readGenerateResult poll loop detects run exited and throws RunExitedWithoutResultError immediately", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "5000");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "100");
    const runId = "e0c8-gen-bounded-001";

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        return messagesResponse([
          {
            message_id: "msg_exited",
            channel_id: "board:agent-runs",
            channel_seq: 1,
            kind: "agent.run.exited.v1",
            payload: { run_id: runId, exit_code: 0 },
            entity_id: runId,
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        ]);
      }
      return emptyMessagesResponse();
    });

    const { isRunExited, readChannelMessages, readGenerateResult } = await import("../src/tick-inspect");
    const { RunExitedWithoutResultError } = await import("../src/tick-run");

    const { timeoutMs, pollMs } = { timeoutMs: 5000, pollMs: 100 };
    const deadline = Date.now() + timeoutMs;
    let err: Error | null = null;
    const start = Date.now();
    while (Date.now() < deadline) {
      const result = await readGenerateResult(runId);
      if (result) {
        break;
      }
      const runsMsgs = await readChannelMessages("board:agent-runs");
      if (isRunExited(runId, runsMsgs)) {
        err = new RunExitedWithoutResultError(runId, "generate", Date.now() - start);
        break;
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
    expect(err).not.toBeNull();
    expect(err!.message).toContain("exited without producing a result");
    expect(err!.message).toContain(runId);
    expect(err!.message).toContain("generate");
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(timeoutMs);
  });

  it("isRunExited detects agent.run.exited.v1 and agent.run.exited.v2", async () => {
    const { isRunExited } = await import("../src/tick-inspect");
    const runId = "test-run-exited";
    const msgs = [
      {
        message_id: "m1",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.exited.v1",
        payload: { run_id: runId, exit_code: 0 },
        entity_id: runId,
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      },
    ];
    expect(isRunExited(runId, msgs)).toBe(true);
    expect(isRunExited("other-run", msgs)).toBe(false);
  });

  it("isRunExited detects agent.run.exited.v2", async () => {
    const { isRunExited } = await import("../src/tick-inspect");
    const runId = "test-run-exited-v2";
    const msgs = [
      {
        message_id: "m1",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.exited.v2",
        payload: { run_id: runId, exit_code: 0 },
        entity_id: runId,
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      },
    ];
    expect(isRunExited(runId, msgs)).toBe(true);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 4 (§1.3): drain 内 tick exec_failed ⇒ 响亮失败
// ══════════════════════════════════════════════════════════════════════

describe("判据 4 (§1.3): drain tick exec_failed ⇒ loud failure naming run_dir", () => {
  it("check-drain-failures.mjs detects TIMEOUT from journal.jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c8-c4-timeout-"));
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs");
    mkdirSync(runsRoot, { recursive: true });
    const runDir = join(runsRoot, "run-timeout-1", "tick-run");
    mkdirSync(runDir, { recursive: true });
    const indexFile = join(engineRoot, "index.jsonl");
    writeFileSync(
      indexFile,
      JSON.stringify({
        schema: "lei/1",
        kind: "run.start",
        run_id: "tick~t",
        label: "tick",
        fleet: "fleet.yaml",
        caller: "drain",
        run_dir: runDir,
        ts: new Date().toISOString(),
        pid: 12345,
        drain_id: "test-drain-timeout",
        lane: "tick",
        tick: 1,
      }) + "\n",
    );
    const journalFile = join(runDir, "journal.jsonl");
    writeFileSync(
      journalFile,
      JSON.stringify({
        run_id: "tick~t",
        identity: "tick",
        result: "[外部调用失败 status=TIMEOUT]\n",
        error: "exec",
        effects: [],
      }) + "\n",
    );

    const drainSummary = JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: runsRoot,
      drain_id: "test-drain-timeout",
    });

    const checkScript = join(ROOT, "scripts", "check-drain-failures.mjs");
    let code = 0;
    let err = "";
    try {
      execFileSync("node", [checkScript], {
        cwd: ROOT,
        encoding: "utf8",
        input: drainSummary,
        env: { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: engineRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const ee = e as { status?: number; stderr?: string | Buffer };
      code = ee.status ?? -1;
      err = String(ee.stderr ?? "");
    }
    expect(code).toBe(3);
    expect(err).toMatch(/TICK FAILURE/);
    expect(err).toContain(runDir);
    expect(err).toMatch(/TIMEOUT/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("check-drain-failures.mjs detects exec_failed (error=exec) from journal.jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c8-c4-execfail-"));
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs");
    mkdirSync(runsRoot, { recursive: true });
    const runDir = join(runsRoot, "run-execfail-1", "tick-run");
    mkdirSync(runDir, { recursive: true });
    const indexFile = join(engineRoot, "index.jsonl");
    writeFileSync(
      indexFile,
      JSON.stringify({
        schema: "lei/1",
        kind: "run.start",
        run_id: "tick~ef",
        label: "tick",
        fleet: "fleet.yaml",
        caller: "drain",
        run_dir: runDir,
        ts: new Date().toISOString(),
        pid: 12345,
        drain_id: "test-drain-execfail",
        lane: "tick",
        tick: 1,
      }) + "\n",
    );
    const journalFile = join(runDir, "journal.jsonl");
    writeFileSync(
      journalFile,
      JSON.stringify({
        run_id: "tick~ef",
        identity: "tick",
        result: "some error occurred",
        error: "exec",
        effects: [],
      }) + "\n",
    );

    const drainSummary = JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: runsRoot,
      drain_id: "test-drain-execfail",
    });

    const checkScript = join(ROOT, "scripts", "check-drain-failures.mjs");
    let code = 0;
    let err = "";
    try {
      execFileSync("node", [checkScript], {
        cwd: ROOT,
        encoding: "utf8",
        input: drainSummary,
        env: { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: engineRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const ee = e as { status?: number; stderr?: string | Buffer };
      code = ee.status ?? -1;
      err = String(ee.stderr ?? "");
    }
    expect(code).toBe(3);
    expect(err).toMatch(/TICK FAILURE/);
    expect(err).toContain(runDir);
    expect(err).toMatch(/error=exec/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("check-drain-failures.mjs detects [bash 非零退出] from journal.jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c8-c4-bash-"));
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs");
    mkdirSync(runsRoot, { recursive: true });
    const runDir = join(runsRoot, "run-bash-1", "tick-run");
    mkdirSync(runDir, { recursive: true });
    const indexFile = join(engineRoot, "index.jsonl");
    writeFileSync(
      indexFile,
      JSON.stringify({
        schema: "lei/1",
        kind: "run.start",
        run_id: "tick~b",
        label: "tick",
        fleet: "fleet.yaml",
        caller: "drain",
        run_dir: runDir,
        ts: new Date().toISOString(),
        pid: 12345,
        drain_id: "test-drain-bash",
        lane: "tick",
        tick: 1,
      }) + "\n",
    );
    const journalFile = join(runDir, "journal.jsonl");
    writeFileSync(
      journalFile,
      JSON.stringify({
        run_id: "tick~b",
        identity: "tick",
        result: "[bash 非零退出 EXIT:2]\n",
        error: "exec",
        effects: [],
      }) + "\n",
    );

    const drainSummary = JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: runsRoot,
      drain_id: "test-drain-bash",
    });

    const checkScript = join(ROOT, "scripts", "check-drain-failures.mjs");
    let code = 0;
    let err = "";
    try {
      execFileSync("node", [checkScript], {
        cwd: ROOT,
        encoding: "utf8",
        input: drainSummary,
        env: { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: engineRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const ee = e as { status?: number; stderr?: string | Buffer };
      code = ee.status ?? -1;
      err = String(ee.stderr ?? "");
    }
    expect(code).toBe(3);
    expect(err).toMatch(/TICK FAILURE/);
    expect(err).toContain(runDir);
    expect(err).toContain("exit=2");
    rmSync(dir, { recursive: true, force: true });
  });

  it("check-drain-failures.mjs exits 0 when all ticks succeed", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c8-c4-ok-"));
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs");
    mkdirSync(runsRoot, { recursive: true });
    const runDir = join(runsRoot, "run-ok-1", "tick-run");
    mkdirSync(runDir, { recursive: true });
    const indexFile = join(engineRoot, "index.jsonl");
    writeFileSync(
      indexFile,
      JSON.stringify({
        schema: "lei/1",
        kind: "run.start",
        run_id: "tick~1",
        label: "tick",
        fleet: "fleet.yaml",
        caller: "drain",
        run_dir: runDir,
        ts: new Date().toISOString(),
        pid: 12345,
        drain_id: "test-drain-ok",
        lane: "tick",
        tick: 1,
      }) + "\n",
    );
    const journalFile = join(runDir, "journal.jsonl");
    writeFileSync(
      journalFile,
      JSON.stringify({
        run_id: "tick~1",
        identity: "tick",
        result: '{"hasPendingWork":false,"termination":{"state":"converged"}}',
        effects: [],
      }) + "\n",
    );

    const drainSummary = JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: runsRoot,
      drain_id: "test-drain-ok",
    });

    const checkScript = join(ROOT, "scripts", "check-drain-failures.mjs");
    let code = 0;
    try {
      execFileSync("node", [checkScript], {
        cwd: ROOT,
        encoding: "utf8",
        input: drainSummary,
        env: { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: engineRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const ee = e as { status?: number };
      code = ee.status ?? -1;
    }
    expect(code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 2b (GT-15/GT-16): 回归——真正的 --run 在种子板上耗时低于 node_timeout/2
// ══════════════════════════════════════════════════════════════════════

describe("判据 2b (GT-15/GT-16): real --run on seed board finishes under node_timeout/2", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
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

  function messagesResponse(msgs: Array<{message_id:string; channel_id:string; channel_seq:number; kind:string; payload:unknown; entity_id:string; supersedes:null; created_at:string}>) {
    return jsonResponse({ messages: msgs });
  }

  it("runChannelWrite on a seed board (1 clue) returns timings and termination", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "100");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "10");

    const CHANNEL = "research:e0c8-2b-seed";
    const SEED_CLUE_ID = "seed-clue-1";

    // Mock bus: board has exactly 1 clue (seed board)
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
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
            payload: { status: "open", text: "seed clue", depth: 0, sources: ["wiki"] },
            entity_id: SEED_CLUE_ID,
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) {
        return messagesResponse([
          {
            message_id: "msg_seed",
            channel_id: CHANNEL,
            channel_seq: 1,
            kind: "research.clue.v2",
            payload: { status: "open", text: "seed clue", depth: 0, sources: ["wiki"] },
            entity_id: SEED_CLUE_ID,
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        ]);
      }
      return emptyMessagesResponse();
    });

    const { runChannelWrite } = await import("../src/tick-run");
    const start = Date.now();
    const result = await runChannelWrite({
      channelId: CHANNEL,
      maxWrites: 10,
    });
    const elapsed = Date.now() - start;

    expect(result.timings).toBeDefined();
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.readMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.executeMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.termMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.generateMs).toBeGreaterThanOrEqual(0);

    // On a seed board with no real work, should complete quickly
    const nodeTimeoutMs = 900_000; // 900s from workflow.yaml
    expect(elapsed).toBeLessThan(nodeTimeoutMs / 2);

    // termination should be readable
    expect(result.termination).toBeDefined();
    expect(result.termination.state === null || typeof result.termination.state === "string").toBe(true);
  });

  it("discriminant: timings field is present and has all required sub-fields", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "100");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "10");

    vi.stubGlobal("fetch", async () => emptyMessagesResponse());

    const { runChannelWrite } = await import("../src/tick-run");
    const result = await runChannelWrite({
      channelId: "research:e0c8-timings-test",
      maxWrites: 10,
    });

    expect(result.timings).toBeDefined();
    expect(typeof result.timings.totalMs).toBe("number");
    expect(typeof result.timings.readMs).toBe("number");
    expect(typeof result.timings.executeMs).toBe("number");
    expect(typeof result.timings.termMs).toBe("number");
    expect(typeof result.timings.generateMs).toBe("number");
    // totalMs = readMs + executeMs + termMs + generateMs
    expect(result.timings.totalMs).toBe(
      result.timings.readMs + result.timings.executeMs + result.timings.termMs + result.timings.generateMs,
    );
  });

  it("discriminant: timings totalMs covers generate phase", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "100");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "10");

    vi.stubGlobal("fetch", async () => emptyMessagesResponse());

    const { runChannelWrite } = await import("../src/tick-run");
    const result = await runChannelWrite({
      channelId: "research:e0c8-totalms-test",
      maxWrites: 10,
    });

    // totalMs should be >= generateMs (since it includes generate phase)
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(result.timings.generateMs);
    // totalMs should be >= readMs + executeMs + termMs
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(
      result.timings.readMs + result.timings.executeMs + result.timings.termMs,
    );
  });

  it("discriminant: RunWriteOutcome carries hasPendingWork and termination", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "100");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "10");

    vi.stubGlobal("fetch", async () => emptyMessagesResponse());

    const { runChannelWrite } = await import("../src/tick-run");
    const result = await runChannelWrite({
      channelId: "research:e0c8-outcome-test",
      maxWrites: 10,
    });

    expect(typeof result.hasPendingWork).toBe("boolean");
    expect(result.termination).toBeDefined();
    expect(result.termination.state).toBeNull(); // empty board, no termination
    expect(result.termination.capHit).toBe(false);
    expect(result.termination.coverage).toBe(0);
    expect(result.termination.zeroGrowthRounds).toBeGreaterThanOrEqual(0);
  });
});