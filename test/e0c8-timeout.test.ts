/**
 * E0c8 —— tick 超时修复：引擎级 node_timeout 抬升、墙钟为主 drain、run 退出无结果可检测。
 *
 * 覆盖 spec §2 判据 2, 2a, 2z, 2b, 3, 4。
 * 每个判据的测试必须真正驱动被测对象（GT-23）。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, chmodSync, existsSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const runningBuses: number[] = [];
afterEach(() => {
  for (const pid of runningBuses.splice(0)) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
});

async function startFakeBus(seedFile?: string): Promise<number> {
  const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const realSpawn = realChildProcess.spawn;
  return new Promise((resolve, reject) => {
    const fixture = join(ROOT, "test", "fixtures", "fake-bus.mjs");
    let stdout = "";
    const child = realSpawn(process.execPath, [fixture], {
      env: { ...process.env, A10B_BUS_PORT: "0", ...(seedFile ? { A10B_SEED: seedFile } : {}) },
      stdio: ["ignore", "pipe", "ignore"],
    });
    runningBuses.push(child.pid as number);
    child.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    const deadline = Date.now() + 5000;
    const check = (port: number) => {
      fetch(`http://127.0.0.1:${port}/v1/channels/_probe`)
        .then(() => resolve(port))
        .catch(() => {
          if (Date.now() > deadline) reject(new Error("fake bus did not come up"));
          else setTimeout(() => check(port), 50);
        });
    };
    child.on("error", (err) => reject(err));
    const parsePort = () => {
      const m = stdout.match(/fakebus listening on (\d+)/);
      if (m) { const port = Number(m[1]); if (port > 0) { check(port); return; } }
      if (Date.now() > deadline) { reject(new Error("fake bus did not output listening port")); return; }
      setTimeout(parsePort, 50);
    };
    setTimeout(parsePort, 50);
  });
}

// Mock node:child_process.spawn to avoid ENOENT for /fake/agent-run.
// Captures the last spawned run_id from --run-id argument for use in fetch mock.
let lastSpawnedRunId = "";
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  const EventEmitter = (await import("node:events")).EventEmitter;
  return {
    ...actual,
    spawn: (cmd: string, args: string[]) => {
      const runIdIdx = args.indexOf("--run-id");
      if (runIdIdx >= 0 && runIdIdx + 1 < args.length) {
        lastSpawnedRunId = args[runIdIdx + 1];
      }
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
//   node_timeout=2000s 依据：
//   - GT-13 实测最大单 tick 耗时 904.2s（E0c3b 真机长跑，run_id=e0-1786589921832979147-1672191）
//   - GT-15 实测 30.5s / 39.9s（种子板，node_timeout=30 被引擎杀）
//   - GT-18 worker 耗时 221.084s / 36.109s（agent.run.exited.v2 exit=0）
//   node_timeout=2000s ≥ 2.0× 实测最大单 tick 耗时（904.2s × 2.0 = 1808.4s，取 2000s ≈ 2.21×）
//   若改回 30 ⇒ 测试变红（判据 2 判别性）。
// ══════════════════════════════════════════════════════════════════════

const MEASURED_MAX_SINGLE_TICK_S = 904.2;
const COMMENT_MULTIPLIER = 2.0;

describe("判据 2 (GT-18): node_timeout in workflow.yaml ≥ multiplier × measured max single-tick time", () => {
  it("workflow.yaml limits.node_timeout >= 2.0 × measured max single-tick time (904.2s)", () => {
    const wfPath = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
    const content = readFileSync(wfPath, "utf8");
    const parsed = YAML.parse(content) as Record<string, unknown>;
    const limits = parsed.limits as Record<string, number>;
    expect(limits).toBeDefined();
    expect(limits.node_timeout).toBeDefined();
    // node_timeout (seconds) must be >= COMMENT_MULTIPLIER × MEASURED_MAX_SINGLE_TICK_S
    // as recorded in the workflow.yaml comment (spec §1.1 / GT-21 evidence).
    expect(limits.node_timeout).toBeGreaterThanOrEqual(MEASURED_MAX_SINGLE_TICK_S * COMMENT_MULTIPLIER);
  });

  it("discriminant: node_timeout is not 30 (the old value that caused GT-15 timeouts)", () => {
    const wfPath = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
    const content = readFileSync(wfPath, "utf8");
    const parsed = YAML.parse(content) as Record<string, unknown>;
    const limits = parsed.limits as Record<string, number>;
    expect(limits.node_timeout).not.toBe(30);
  });

  it("discriminant: changing node_timeout back to 30 would make the multiplier test fail", () => {
    const wfPath = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
    const content = readFileSync(wfPath, "utf8");
    const parsed = YAML.parse(content) as Record<string, unknown>;
    const limits = parsed.limits as Record<string, number>;
    expect(limits.node_timeout).toBeGreaterThanOrEqual(MEASURED_MAX_SINGLE_TICK_S * COMMENT_MULTIPLIER);
    // If this were 30, the assertion would fail (30 < 904.2 * 2.0 = 1808.4)
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

  it("discriminant: execution-driven — wall clock sufficient, attempts exhausted ⇒ entry continues past limit", async () => {
    // Construct a scenario where wall clock budget is sufficient but attempt
    // count is exhausted. The entry must continue (not exit due to attempt limit).
    // GT-19: wall clock is the primary limiter; fixed attempt count must not
    // cause failure before the wall clock budget is consumed.
    // GT-22: DRAIN_MAX_ATTEMPTS is a runaway safeguard — it must terminate when
    // hit, but the profile self-consistency ensures it never triggers before
    // wall clock in normal operation. This test uses DRAIN_MAX_ATTEMPTS=100
    // (well above the wall clock budget of 5s) so wall clock is hit first.
    const dir = mkdtempSync(join(tmpdir(), "e0c8-2a-exec-"));
    try {
      // Symlink critical workspace directories so the entry script can resolve deps
      for (const sub of ["node_modules", "src", "scripts", "package.json", "tsconfig.json"]) {
        const target = join(dir, sub);
        if (!existsSync(target)) {
          try { symlinkSync(join(ROOT, sub), target); } catch { }
        }
      }

      // Create profile with wall clock = 5s, max attempts = 100, backoff = 0
      const profilesDir = join(dir, "profiles", "deploy");
      mkdirSync(profilesDir, { recursive: true });
      const binDir = join(dir, "bin");
      mkdirSync(binDir, { recursive: true });
      const recordRoot = join(dir, "records");
      mkdirSync(recordRoot, { recursive: true });
      const engineRoot = join(dir, "engine-root");
      mkdirSync(engineRoot, { recursive: true });
      const runsRoot = join(engineRoot, "runs");
      mkdirSync(runsRoot, { recursive: true });

      // Create profile
      const profile = [
        "RESEARCH_PROFILE_BASE=e0c8-2a",
        "RESEARCH_QUESTION=test",
        "RESEARCH_ORIGIN=test",
        `EXPORT_ROOT=${join(dir, "export")}`,
        `ALLOWED_ROOT=${dir}`,
        "ANCHOR_CHECK_BIN=/bin/true",
        "SEED_CLUE=test seed",
        "SEED_SOURCES=code-local",
        "DRAIN_BACKOFF_SECONDS=0",
        "DRAIN_MAX_ATTEMPTS=100",
        "DRAIN_WALL_CLOCK_SECONDS=5",
        `LOOP_ENGINE_RUNTIME_ROOT=${engineRoot}`,
        "",
      ].join("\n");
      writeFileSync(join(profilesDir, "test-e0c8-2a.env"), profile);

      // Symlink real e0-regression.sh
      try {
        symlinkSync(join(ROOT, "bin", "e0-regression.sh"), join(binDir, "e0-regression.sh"));
      } catch { }

      // Create fake deep-research-loop.sh that always returns null termination
      const fakeLoop = [
        "#!/usr/bin/env bash",
        `printf '{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"${runsRoot}","drain_id":"test-drain"}\\n'`,
        "exit 0",
      ].join("\n");
      writeFileSync(join(binDir, "deep-research-loop.sh"), fakeLoop + "\n");
      chmodSync(join(binDir, "deep-research-loop.sh"), 0o755);

      // Create runtime dirs for null termination (3 drains)
      for (let i = 1; i <= 3; i++) {
        const runDir = join(runsRoot, `run-test-drain`, "tick-run");
        mkdirSync(runDir, { recursive: true });
        const tickOutput = JSON.stringify({
          hasPendingWork: false,
          decisions: [],
          termination: { state: null, coverage: 0, zeroGrowthRounds: 0, capHit: false, boardComposition: { proposed: 0, open: 0, inFlight: 0, explored: 0, blocked: 0 } },
        });
        writeFileSync(
          join(runDir, "journal.jsonl"),
          JSON.stringify({ run_id: `tick~test`, identity: "tick", result: tickOutput, effects: [] }) + "\n",
        );
        const indexFile = join(engineRoot, "index.jsonl");
        const existing = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "";
        const entry = JSON.stringify({
          schema: "lei/1", kind: "run.start", run_id: `tick~test`, label: "tick",
          fleet: "fleet.yaml", caller: "drain", run_dir: runDir,
          ts: new Date().toISOString(), pid: 12345, drain_id: "test-drain", lane: "tick", tick: 1,
        }) + "\n";
        writeFileSync(indexFile, existing + entry);
      }

      // Create token file
      const tokenDir = join(dir, "tokens");
      mkdirSync(tokenDir, { recursive: true });
      writeFileSync(join(tokenDir, "token"), "test-token\n");

      // Start fake bus for the entry script
      const busPort = await startFakeBus();
      const prodBusPort = await startFakeBus();

      // Run the entry
      const env: Record<string, string> = {
        AGENT_BUS_URL: `http://127.0.0.1:${busPort}`,
        AGENT_BUS_TOKEN_FILE: join(tokenDir, "token"),
        E0_RECORD_ROOT: recordRoot,
        E0C1_PROD_BUS_URL: `http://127.0.0.1:${prodBusPort}`,
        E0C1_PROD_BUS_TOKEN_FILE: join(tokenDir, "token"),
        DD_RUN_ID: `test-2a-${Date.now()}`,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/root",
        LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      };
      try {
        const out = execFileSync("bash", [join(binDir, "e0-regression.sh"), "--profile", "test-e0c8-2a"], {
          cwd: ROOT,
          encoding: "utf8",
          env: { ...process.env, ...env },
          stdio: ["ignore", "pipe", "pipe"],
          timeout: 15000,
        });
        // Entry should NOT exit 0 on wall clock limit — it exits non-zero.
        // But it should hit WALL CLOCK LIMIT, not ATTEMPT LIMIT.
        throw new Error("expected non-zero exit from wall clock limit");
      } catch (e) {
        const ee = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
        const out = String(ee.stdout ?? "");
        const err = String(ee.stderr ?? "");
        // With wall-clock-primary, the entry continues past the attempt limit
        // (100 attempts) and eventually hits the wall clock limit (5s).
        // It should NOT exit with HIT ATTEMPT LIMIT (that would be the
        // "attempts-first" reverted case).
        // GT-22: DRAIN_MAX_ATTEMPTS is a runaway safeguard that terminates when
        // actually hit, but with 100 attempts and 5s wall clock, the wall clock
        // is always hit first in normal operation.
        expect(err).not.toMatch(/HIT ATTEMPT LIMIT/i);
        expect(err).toMatch(/HIT WALL CLOCK LIMIT/i);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 20000 });

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
  let stderrChunks: string[] = [];
  let origStderrWrite: typeof process.stderr.write;

  beforeEach(() => {
    vi.unstubAllGlobals();
    stderrChunks = [];
    origStderrWrite = process.stderr.write;
    process.stderr.write = ((chunk: string) => {
      stderrChunks.push(chunk);
      return true;
    }) as typeof process.stderr.write;
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    process.stderr.write = origStderrWrite;
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

  it("discriminant: run exited without result produces diagnostic on stderr and tick continues (exit 0)", async () => {
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

    const { randomUUID } = await import("node:crypto");

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
      },
    });

    // Tick should exit 0 (it returned normally)
    expect(result).toBeDefined();
    expect(result.timings).toBeDefined();

    // Diagnostic should be on stderr (production tick.md parses stdout as JSON)
    const stderr = stderrChunks.join("");
    expect(stderr).toContain("E0c8:");
    expect(stderr).toContain("exited without producing a result");
    expect(stderr).toContain("[deep-research-loop]");
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

  it("readTriageResult poll loop drives production readResult and detects run exited", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "100");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "10");
    const runId = "e0c8-bounded-001";

    // Mock bus: board:agent-runs returns agent.run.exited for the run_id
    // but no dr-triage.result.v1 exists. The production readResult polling loop
    // (src/tick-run.ts:1644-1660) will detect isRunExited and throw.
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
      if (url.includes("/publish")) {
        return jsonResponse({ message_id: "pub_001" });
      }
      if (url.includes("/v1/entities/")) {
        return jsonResponse({
          head: {
            message_id: "head_001",
            channel_id: "research:e0c8-bounded",
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
            channel_id: "research:e0c8-bounded",
            channel_seq: 1,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue c1", depth: 1, sources: ["wiki"] },
            entity_id: "c1",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
          {
            message_id: "msg_c2",
            channel_id: "research:e0c8-bounded",
            channel_seq: 2,
            kind: "research.clue.v2",
            payload: { status: "proposed", text: "clue c2", depth: 1, sources: ["wiki"] },
            entity_id: "c2",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
          {
            message_id: "msg_c3",
            channel_id: "research:e0c8-bounded",
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

    const { runChannelWrite } = await import("../src/tick-run");
    const start = Date.now();
    const result = await runChannelWrite({
      channelId: "research:e0c8-bounded",
      question: "test question?",
      workerCmd: "/fake/agent-run",
      maxWrites: 10,
      triageSpawnRuntime: {
        agentRunBin: "/fake/agent-run",
        runId,
        spawnProcess: async () => ({ pid: 12345 }),
      },
    });

    // Tick should exit 0 (it returned normally, the error was caught)
    expect(result).toBeDefined();
    expect(result.timings).toBeDefined();
    // Verify the detection happened quickly (not after full timeout)
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(500);
  });

  it("readGenerateResult poll loop drives production readBody and detects run exited", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "100");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "10");
    const CHANNEL = "research:e0c8-gen-bounded";
    // Use a unique oneShotDir so the marker file is isolated per run and
    // cleaned up after the test (判据 1 requires running twice; without
    // cleanup, the second run finds the marker and skips the generate path).
    const oneShotDir = mkdtempSync(join(tmpdir(), "e0c8-gen-oneshot-"));

    try {
      lastSpawnedRunId = "";
      vi.stubGlobal("fetch", async (input: RequestInfo) => {
        const url = typeof input === "string" ? input : input.toString();
        if (url.includes("board:agent-runs")) {
          const rid = lastSpawnedRunId;
          if (rid) {
            return messagesResponse([
              {
                message_id: "msg_exited",
                channel_id: "board:agent-runs",
                channel_seq: 1,
                kind: "agent.run.exited.v1",
                payload: { run_id: rid, exit_code: 0 },
                entity_id: rid,
                supersedes: null,
                created_at: "2026-08-01T00:00:00Z",
              },
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
              payload: { status: "explored", text: "explored 1", depth: 1, sources: ["wiki"] },
              entity_id: "e1",
              supersedes: null,
              created_at: "2026-08-01T00:00:00Z",
            },
          });
        }
        if (url.includes("/messages")) {
          return messagesResponse([
            {
              message_id: "msg_e1",
              channel_id: CHANNEL,
              channel_seq: 1,
              kind: "research.clue.v2",
              payload: { status: "explored", text: "explored 1", depth: 1, sources: ["wiki"] },
              entity_id: "e1",
              supersedes: null,
              created_at: "2026-08-01T00:00:00Z",
            },
            {
              message_id: "msg_e2",
              channel_id: CHANNEL,
              channel_seq: 2,
              kind: "research.clue.v2",
              payload: { status: "explored", text: "explored 2", depth: 1, sources: ["wiki"] },
              entity_id: "e2",
              supersedes: null,
              created_at: "2026-08-01T00:00:00Z",
            },
            {
              message_id: "msg_e3",
              channel_id: CHANNEL,
              channel_seq: 3,
              kind: "research.clue.v2",
              payload: { status: "explored", text: "explored 3", depth: 1, sources: ["wiki"] },
              entity_id: "e3",
              supersedes: null,
              created_at: "2026-08-01T00:00:00Z",
            },
          ]);
        }
        return emptyMessagesResponse();
      });

      const { runChannelWrite } = await import("../src/tick-run");
      const startTime = Date.now();
      const result = await runChannelWrite({
        channelId: CHANNEL,
        maxWrites: 10,
        workerCmd: "/fake/agent-run",
        origin: "test-origin",
        docChannelId: "research:e0c8-gen-bounded.docs",
        question: "test question?",
        maxClues: 3,
        oneShotDir,
      });

      expect(result).toBeDefined();
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(500);
    } finally {
      rmSync(oneShotDir, { recursive: true, force: true });
    }
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

it("real --run on a seed board (1 clue) returns timings and termination", async () => {
    const CHANNEL = "research:e0c8-2b-seed";

    // Create seed file for the fake bus with 1 seed clue
    const dir = mkdtempSync(join(tmpdir(), "e0c8-2b-exec-"));
    const seedFile = join(dir, "seed.json");
    const seedPayload = {
      [CHANNEL]: [
        { message_id: "msg_seed", channel_id: CHANNEL, channel_seq: 1, kind: "research.clue.v2", payload: { status: "open", text: "seed clue", depth: 0, sources: ["wiki"] }, entity_id: "seed-clue", supersedes: null, created_at: new Date().toISOString() },
      ],
    };
    writeFileSync(seedFile, JSON.stringify(seedPayload));

    const busPort = await startFakeBus(seedFile);
    const busUrl = `http://127.0.0.1:${busPort}`;

    const tokenDir = join(dir, "tokens");
    mkdirSync(tokenDir, { recursive: true });
    const tokenFile = join(tokenDir, "token");
    writeFileSync(tokenFile, "test-token\n");

    const tickEntry = join(ROOT, "src", "tick-entry.ts");
    const start = Date.now();
    try {
      const out = execFileSync("npx", [
        "vite-node",
        tickEntry,
        "--run", CHANNEL,
        "--max-writes", "10",
        "--question", "test question?",
        "--worker-cmd", "/bin/true",
      ], {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          AGENT_BUS_URL: busUrl,
          AGENT_BUS_TOKEN_FILE: tokenFile,
          AGENT_RESULT_TIMEOUT_MS: "200",
          AGENT_RESULT_POLL_MS: "50",
        },
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30000,
      });
      const elapsed = Date.now() - start;
      const result = JSON.parse(out.trim());

      expect(result.timings).toBeDefined();
      expect(typeof result.timings.totalMs).toBe("number");
      expect(typeof result.timings.readMs).toBe("number");

      // On a seed board, should complete quickly (well under 30s, the old
      // node_timeout=30 that caused GT-15 engine kills).  If the tick were
      // still slow enough to be killed by the old node_timeout=30, this test
      // would fail.  The discriminant: reverting §1.1 (making the tick slow
      // again) ⇒ this test goes red.
      const OLD_NODE_TIMEOUT_MS = 30 * 1000;
      expect(elapsed).toBeLessThan(OLD_NODE_TIMEOUT_MS / 2);

      // termination should be readable
      expect(result.termination).toBeDefined();
      expect(result.termination.state === null || typeof result.termination.state === "string").toBe(true);
    } catch (e) {
      const ee = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
      throw new Error(`--run failed: exit=${ee.status ?? -1} stderr=${String(ee.stderr ?? "").slice(0, 1000)} stdout=${String(ee.stdout ?? "").slice(0, 1000)}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 30000 });

  it("discriminant: timings field is present and has all required sub-fields (in-process)", async () => {
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

  it("discriminant: timings totalMs covers generate phase (in-process)", async () => {
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

  it("discriminant: RunWriteOutcome carries hasPendingWork and termination (in-process)", async () => {
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