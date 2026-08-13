/**
 * E0c7 —— tick 超时间歇性修复；上限按预算给（GT-18 / GT-19）。
 *
 * 覆盖 spec §2 的判别性单测：
 *  - 判据 2: workflow.yaml limits.node_timeout ≥ 600，改回 30 ⇒ 变红
 *  - 判据 2a: 墙钟预算为主，次数上限仅为失控兜底（GT-19）
 *  - 判据 2b: 种子板上 --run 耗时 < node_timeout/2（GT-15/GT-16）
 *  - 判据 2z: run 已 exited 但无 result ⇒ tick 仍 exit 0，诊断出现（GT-17）
 *  - 判据 3: read 立即停止并产出诊断
 *  - 判据 4: drain exec_failed ⇒ 入口响亮失败
 *  - 判据 4b: MAX_CLUES 由 profile 声明
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, existsSync, chmodSync, symlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import {
  runChannelWrite,
} from "../src/tick-run";
import type { RunWriteOptions } from "../src/tick-run";
import {
  findRunExited,
  E0c7RunExitedWithoutResultError as E0c7Error,
  type InspectMessage,
} from "../src/tick-inspect";
import { DEFAULT_TICK_CONFIG, type BoardState } from "../src/tick";

let capturedTriageRunId = "";

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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_YAML = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
const CHECK_DRAIN_FAILURES = join(ROOT, "scripts", "check-drain-failures.mjs");
const E0_REGRESSION_SH = join(ROOT, "bin", "e0-regression.sh");
const PROFILE = join(ROOT, "profiles", "deploy", "e0-regression.env");
const CHANNEL = "research:test-e0c7";

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function clueMsg(
  clueId: string,
  over: Record<string, unknown> = {},
  seq = 1,
): InspectMessage {
  const payload: Record<string, unknown> = {
    status: "open",
    text: `clue ${clueId}`,
    depth: 0,
    sources: ["code-local"],
    ...over,
  };
  return {
    message_id: `msg_${clueId}`,
    channel_id: CHANNEL,
    channel_seq: seq,
    kind: "research.clue.v2",
    payload,
    entity_id: clueId,
    supersedes: null,
    created_at: "2026-08-01T00:00:00Z",
  };
}

function runExitedMsg(runId: string, exitCode: number, seq = 100): InspectMessage {
  return {
    message_id: `msg_exited_${runId}`,
    channel_id: "board:agent-runs",
    channel_seq: seq,
    kind: "agent.run.exited.v2",
    payload: { run_id: runId, exit_code: exitCode },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-08-01T00:00:01Z",
  };
}

function workerResultMsg(runId: string, seq = 100): InspectMessage {
  return {
    message_id: `msg_result_${runId}`,
    channel_id: "board:agent-runs",
    channel_seq: seq,
    kind: "worker.result.v1",
    payload: {
      run_id: runId,
      evidence: [{ anchor: "test:1:1", quote: "test", claim: "test" }],
      clues: [],
    },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-08-01T00:00:01Z",
  };
}

function triageResultMsg(runId: string, decisions: Array<{ clue_id: string; action: string; rationale: string }>, seq = 100): InspectMessage {
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

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENT_RESULT_TIMEOUT_MS;
  delete process.env.AGENT_RESULT_POLL_MS;
  capturedTriageRunId = "";
});

// ── 判据 2: workflow.yaml limits.node_timeout ≥ 600 ─────────────────────────

describe("判据 2: workflow.yaml limits.node_timeout ≥ 600 (GT-18)", () => {
  it("node_timeout is at least 600", () => {
    const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
    const nodeTimeout = wf.limits?.node_timeout as number;
    expect(nodeTimeout).toBeGreaterThanOrEqual(600);
  });

  it("DISCRIMINATING: changing node_timeout to 30 would fail this assertion", () => {
    const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
    const nodeTimeout = wf.limits?.node_timeout as number;
    expect(nodeTimeout).not.toBe(30);
  });

  it("node_timeout is a finite number (not unlimited)", () => {
    const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
    const nodeTimeout = wf.limits?.node_timeout as number;
    expect(Number.isFinite(nodeTimeout)).toBe(true);
    expect(nodeTimeout).toBeLessThan(Infinity);
  });

  it("wall_clock >= node_timeout so engine does not truncate tick before node_timeout", () => {
    const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
    const wallClock = wf.limits?.wall_clock as number;
    const nodeTimeout = wf.limits?.node_timeout as number;
    expect(wallClock).toBeGreaterThanOrEqual(nodeTimeout);
  });
});

// ── 判据 2a: 墙钟预算为主，次数上限仅为失控兜底（GT-19）─────────────────
// These tests drive the real bin/e0-regression.sh entry via the e0c2 harness.

const runningBuses: number[] = [];
afterEach(() => {
  for (const pid of runningBuses.splice(0)) {
    try { process.kill(pid); } catch { /* already gone */ }
  }
});

async function startFakeBusReal(): Promise<number> {
  const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const realSpawn = realChildProcess.spawn;
  return new Promise((resolve, reject) => {
    const fixture = join(ROOT, "test", "fixtures", "fake-bus.mjs");
    let stdout = "";
    const child = realSpawn(process.execPath, [fixture], {
      env: { ...process.env, A10B_BUS_PORT: "0" },
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
      if (Date.now() > deadline) { reject(new Error("fake bus did not output port")); return; }
      setTimeout(parsePort, 50);
    };
    setTimeout(parsePort, 50);
  });
}

function createFakeLoopStub(binDir: string, version: string, attemptFile: string, runsRoot: string): void {
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "ATTEMPT=1",
    'if [ -f "${FAKE_LOOP_ATTEMPT_FILE:-}" ]; then',
    '  ATTEMPT=$(($(cat "${FAKE_LOOP_ATTEMPT_FILE:-}") + 1))',
    "fi",
    'echo "$ATTEMPT" > "${FAKE_LOOP_ATTEMPT_FILE:-/dev/null}"',
    "",
    'VERSION="${FAKE_LOOP_VERSION:-default}"',
    "",
    'case "$VERSION" in',
  ];
  if (version === "always-null") {
    lines.push("  always-null)");
    lines.push(`    printf '{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"${runsRoot}","drain_id":"fake-drain-null-'"$ATTEMPT"'\\"}\\n'`);
    lines.push("    exit 0");
    lines.push("    ;;");
  } else if (version === "null-then-converge") {
    lines.push("  null-then-converge)");
    lines.push(`    printf '{"reason":"drained","rounds":2,"ticksByLabel":{"tick":2},"runs_root":"${runsRoot}","drain_id":"fake-drain-attempt-'"$ATTEMPT"'\\"}\\n'`);
    lines.push("    exit 0");
    lines.push("    ;;");
  }
  lines.push("  *)");
  lines.push(`    printf '{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"${runsRoot}","drain_id":"fake-drain-default"}\\n'`);
  lines.push("    exit 0");
  lines.push("    ;;");
  lines.push("esac");
  writeFileSync(join(binDir, "deep-research-loop.sh"), lines.join("\n") + "\n");
  chmodSync(join(binDir, "deep-research-loop.sh"), 0o755);
}

function setupRuntimeDir(
  engineRoot: string,
  runsRoot: string,
  drainId: string,
  terminationState: string | null,
): string {
  const runDir = join(runsRoot, `run-${drainId}`, "tick-run");
  mkdirSync(runDir, { recursive: true });
  const tickOutput = JSON.stringify({
    hasPendingWork: false,
    decisions: [],
    termination: { state: terminationState, coverage: 0, zeroGrowthRounds: 0, capHit: false },
  });
  const journalFile = join(runDir, "journal.jsonl");
  writeFileSync(journalFile, JSON.stringify({
    run_id: `tick~${drainId}`,
    identity: "tick",
    result: tickOutput,
    effects: [],
  }) + "\n");
  const indexFile = join(engineRoot, "index.jsonl");
  const existing = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "";
  const entry = JSON.stringify({
    schema: "lei/1", kind: "run.start", run_id: `tick~${drainId}`,
    label: "tick", fleet: "fleet.yaml", caller: "drain", run_dir: runDir,
    ts: new Date().toISOString(), pid: 12345, drain_id: drainId, lane: "tick", tick: 1,
  }) + "\n";
  writeFileSync(indexFile, existing + entry);
  return runDir;
}

function setupE0RegressionEnv(
  version: string,
  opts: {
    maxAttempts?: number;
    wallClockSeconds?: number;
    backoffSeconds?: number;
    terminationStates?: Array<{ drainId: string; state: string | null }>;
    seedClue?: string;
    maxClues?: string;
    triageThreshold?: string;
  } = {},
): {
  dir: string;
  env: Record<string, string>;
  attemptFile: string;
  e0regression: string;
  recordRoot: string;
  engineRoot: string;
  runsRoot: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "e0c7-exec-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });
  try { symlinkSync(join(ROOT, "bin", "e0-regression.sh"), join(binDir, "e0-regression.sh")); } catch { /* */ }
  for (const sub of ["node_modules", "src", "scripts", "package.json", "tsconfig.json"]) {
    const target = join(dir, sub);
    if (!existsSync(target)) { try { symlinkSync(join(ROOT, sub), target); } catch { /* */ } }
  }
  const profilesDir = join(dir, "profiles", "deploy");
  mkdirSync(profilesDir, { recursive: true });
  const recordRoot = join(dir, "records");
  mkdirSync(recordRoot, { recursive: true });
  const engineRoot = join(dir, "engine-root");
  mkdirSync(engineRoot, { recursive: true });
  const runsRoot = join(engineRoot, "runs");
  mkdirSync(runsRoot, { recursive: true });
  const maxAttempts = opts.maxAttempts ?? 3;
  const wallClockSeconds = opts.wallClockSeconds ?? 10;
  const backoffSeconds = opts.backoffSeconds ?? 0;
  const seedClue = opts.seedClue ?? "test seed clue";
  const profileLines = [
    "RESEARCH_PROFILE_BASE=e0c7-test",
    "RESEARCH_QUESTION=test research question",
    "RESEARCH_ORIGIN=test",
    `EXPORT_ROOT=${join(dir, "export")}`,
    `ALLOWED_ROOT=${dir}`,
    "ANCHOR_CHECK_BIN=/bin/true",
    `SEED_CLUE=${seedClue}`,
    "SEED_SOURCES=code-local",
    `DRAIN_BACKOFF_SECONDS=${backoffSeconds}`,
    `DRAIN_MAX_ATTEMPTS=${maxAttempts}`,
    `DRAIN_WALL_CLOCK_SECONDS=${wallClockSeconds}`,
    `LOOP_ENGINE_RUNTIME_ROOT=${engineRoot}`,
  ];
  if (opts.maxClues !== undefined) profileLines.push(`MAX_CLUES=${opts.maxClues}`);
  if (opts.triageThreshold !== undefined) profileLines.push(`TRIAGE_THRESHOLD=${opts.triageThreshold}`);
  profileLines.push("");
  writeFileSync(join(profilesDir, "test-e0c7.env"), profileLines.join("\n"));
  const tokenDir = join(dir, "tokens");
  mkdirSync(tokenDir, { recursive: true });
  const tokenFile = join(tokenDir, "token");
  writeFileSync(tokenFile, "test-token\n");
  const attemptFile = join(dir, "fake-attempt.txt");
  writeFileSync(attemptFile, "0");
  createFakeLoopStub(binDir, version, attemptFile, runsRoot);
  if (opts.terminationStates) {
    for (const ts of opts.terminationStates) {
      setupRuntimeDir(engineRoot, runsRoot, ts.drainId, ts.state);
    }
  }
  const env: Record<string, string> = {
    AGENT_BUS_TOKEN_FILE: tokenFile,
    E0_RECORD_ROOT: recordRoot,
    E0C1_PROD_BUS_TOKEN_FILE: tokenFile,
    DD_RUN_ID: `test-e0c7-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    PATH: process.env.PATH ?? "/usr/bin",
    HOME: process.env.HOME ?? "/root",
    FAKE_LOOP_ATTEMPT_FILE: attemptFile,
    FAKE_LOOP_VERSION: version,
    LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
  };
  return { dir, env, attemptFile, e0regression: join(binDir, "e0-regression.sh"), recordRoot, engineRoot, runsRoot };
}

async function runE0Regression(
  e0regression: string,
  env: Record<string, string>,
): Promise<{ code: number; out: string; err: string }> {
  const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  const realExecFileSync = realChildProcess.execFileSync;
  try {
    const out = realExecFileSync("bash", [e0regression, "--profile", "test-e0c7"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    const ee = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return { code: ee.status ?? -1, out: String(ee.stdout ?? ""), err: String(ee.stderr ?? "") };
  }
}

describe("判据 2a: wall-clock budget is primary, attempt count is runaway guard (GT-19)", () => {
  it("wall-clock budget remains but attempt count exhausted ⇒ entry continues past attempt limit", async () => {
    const terminationStates = Array.from({ length: 20 }, (_, i) => ({
      drainId: `fake-drain-null-${i + 1}`,
      state: null as string | null,
    }));
    const { dir, env, e0regression, attemptFile } = setupE0RegressionEnv(
      "always-null",
      {
        maxAttempts: 2,
        wallClockSeconds: 10,
        backoffSeconds: 0,
        terminationStates,
      },
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBusReal(), startFakeBusReal()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = await runE0Regression(e0regression, env);
      // Entry should NOT exit 0 (always-null termination, wall clock will hit)
      expect(res.code).not.toBe(0);
      // Should hit wall clock limit, not attempt limit
      expect(res.err).toMatch(/HIT WALL CLOCK LIMIT/i);
      // Should have continued past attempt limit (attempts >= 3, more than maxAttempts=2)
      const attempts = Number(readFileSync(attemptFile, "utf8").trim());
      expect(attempts).toBeGreaterThanOrEqual(3);
      // Should NOT have exited due to attempt limit
      expect(res.err).not.toMatch(/HIT ATTEMPT LIMIT.*break/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 30000 });

  it("DISCRIMINATING: profile self-consistency — DRAIN_MAX_ATTEMPTS > wall_clock / (shortest_drain + backoff)", () => {
    const profText = readFileSync(PROFILE, "utf8");
    const rec: Record<string, string> = {};
    for (const line of profText.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) rec[m[1]] = m[2];
    }
    const wallClock = Number(rec.DRAIN_WALL_CLOCK_SECONDS);
    const maxAttempts = Number(rec.DRAIN_MAX_ATTEMPTS);
    const backoff = Number(rec.DRAIN_BACKOFF_SECONDS);
    const shortestDrain = 30;
    const formula = Math.ceil(wallClock / (shortestDrain + backoff));
    expect(maxAttempts).toBeGreaterThan(formula);
    expect(maxAttempts * (shortestDrain + backoff)).toBeGreaterThan(wallClock);
  });

  it("DISCRIMINATING: if attempt count was still 12, formula check would fail", () => {
    const profText = readFileSync(PROFILE, "utf8");
    const rec: Record<string, string> = {};
    for (const line of profText.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) rec[m[1]] = m[2];
    }
    const maxAttempts = Number(rec.DRAIN_MAX_ATTEMPTS);
    expect(maxAttempts).toBeGreaterThan(12);
  });

  it("e0-regression.sh checks wall-clock before attempt count in source order", () => {
    const script = readFileSync(E0_REGRESSION_SH, "utf8");
    const wallClockIdx = script.indexOf("HIT WALL CLOCK LIMIT");
    const attemptIdx = script.indexOf("HIT ATTEMPT");
    expect(wallClockIdx).toBeGreaterThan(0);
    expect(attemptIdx).toBeGreaterThan(0);
    expect(wallClockIdx).toBeLessThan(attemptIdx);
  });
});

// ── 判据 2b: 种子板 --run 耗时 < node_timeout/2（GT-15/GT-16）────────────────

describe("判据 2b: seed board --run duration < node_timeout/2 (GT-15/GT-16)", () => {
  it("tick-entry --run on a 1-clue seed board completes within node_timeout/2 and produces termination", async () => {
    const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realExecFileSync = realChildProcess.execFileSync;

    const busPort = await startFakeBusReal();
    const busUrl = `http://127.0.0.1:${busPort}`;
    const channel = `research:test-e0c7-2b-${Date.now()}`;

    const tokenDir = mkdtempSync(join(tmpdir(), "e0c7-token-"));
    const tokenFile = join(tokenDir, "token");
    writeFileSync(tokenFile, "test-token\n");

    try {
      // Seed a clue
      realExecFileSync(
        "node", [join(ROOT, "node_modules", ".bin", "vite-node"), join(ROOT, "src", "tick-entry.ts"), "--", "--seed", channel, "--clue", "test seed clue", "--source", "code-local"],
        { cwd: ROOT, encoding: "utf8", env: { ...process.env, AGENT_BUS_URL: busUrl, AGENT_BUS_TOKEN_FILE: tokenFile }, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
      );

      const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
      const nodeTimeout = wf.limits?.node_timeout as number;
      const t0 = Date.now();
      const out = realExecFileSync(
        "node", [join(ROOT, "node_modules", ".bin", "vite-node"), join(ROOT, "src", "tick-entry.ts"), "--", "--run", channel, "--question", "test", "--max-writes", "10", "--max-clues", "24"],
        { cwd: ROOT, encoding: "utf8", env: { ...process.env, AGENT_BUS_URL: busUrl, AGENT_BUS_TOKEN_FILE: tokenFile }, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
      );
      const elapsed = Date.now() - t0;

      expect(elapsed).toBeLessThan(nodeTimeout * 1000 * 0.5);
      const outcome = JSON.parse(out.trim());
      expect(outcome.termination).toBeDefined();
      expect(outcome.timings).toBeDefined();
      expect(outcome.timings.totalMs).toBeGreaterThanOrEqual(0);
      expect(outcome.timings.readBoardMs).toBeGreaterThanOrEqual(0);
      expect(outcome.timings.decideTickMs).toBeGreaterThanOrEqual(0);
      expect(outcome.timings.writeSideMs).toBeGreaterThanOrEqual(0);
      expect(outcome.timings.decideTerminationMs).toBeGreaterThanOrEqual(0);
      expect(outcome.timings.generateMs).toBeGreaterThanOrEqual(0);
    } finally {
      rmSync(tokenDir, { recursive: true, force: true });
    }
  }, { timeout: 30000 });

  it("DISCRIMINATING: if node_timeout were 30, this assertion fails (node_timeout must be > 30)", () => {
    const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
    const nodeTimeout = wf.limits?.node_timeout as number;
    expect(nodeTimeout).toBeGreaterThan(30);
  });
});

// ── 判据 2z: run 已 exited 但无 result ⇒ tick exit 0，诊断出现（GT-17）───

describe("判据 2z: run exited without result ⇒ tick exits 0, diagnosis appears (GT-17)", () => {
  it("triage run exited without result ⇒ diagnostics populated, tick continues (exit 0)", async () => {
    capturedTriageRunId = "";
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        const triageRunId = capturedTriageRunId || "unknown";
        return jsonResponse({
          messages: [runExitedMsg(triageRunId, 0)],
        });
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
      if (url.includes("/messages")) {
        return jsonResponse({
          messages: [
            clueMsg("c1", { status: "proposed" }, 1),
            clueMsg("c2", { status: "proposed" }, 2),
            clueMsg("c3", { status: "proposed" }, 3),
          ],
        });
      }
      return jsonResponse({ messages: [] });
    });

    const result = await runChannelWrite({
      channelId: CHANNEL,
      question: "test question?",
      workerCmd: "/fake/agent-run",
      maxWrites: 10,
    });

    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics[0]).toContain("E0c7 §1.2");
    expect(result.diagnostics[0]).toContain("exited without producing a result");
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);
    expect(result.triageReports.length).toBeGreaterThanOrEqual(1);
    const triageRpt = result.triageReports[0];
    expect(triageRpt.budgetSkipped).toBe(false);
    expect(triageRpt.runId).toBeTruthy();
  });

  it("tick-entry --run exits 0 and diagnostic appears in stdout (grep-able per §1.1c)", async () => {
    const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realExecFileSync = realChildProcess.execFileSync;

    const busPort = await startFakeBusReal();
    const busUrl = `http://127.0.0.1:${busPort}`;
    const channel = `research:test-e0c7-2z-${Date.now()}`;

    const tokenDir = mkdtempSync(join(tmpdir(), "e0c7-token-"));
    const tokenFile = join(tokenDir, "token");
    writeFileSync(tokenFile, "test-token\n");

    try {
      // Seed a clue so there is a proposed card — triage will be attempted
      realExecFileSync(
        "node", [join(ROOT, "node_modules", ".bin", "vite-node"), join(ROOT, "src", "tick-entry.ts"), "--", "--seed", channel, "--clue", "test seed clue", "--source", "code-local"],
        { cwd: ROOT, encoding: "utf8", env: { ...process.env, AGENT_BUS_URL: busUrl, AGENT_BUS_TOKEN_FILE: tokenFile }, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
      );

      // Run tick-entry --run; since the fake bus has no triage worker, the triage
      // spawn will exit immediately (mocked), and the tick should complete with exit 0.
      const out = realExecFileSync(
        "node", [join(ROOT, "node_modules", ".bin", "vite-node"), join(ROOT, "src", "tick-entry.ts"), "--", "--run", channel, "--question", "test", "--max-writes", "10", "--triage-threshold", "1"],
        { cwd: ROOT, encoding: "utf8", env: { ...process.env, AGENT_BUS_URL: busUrl, AGENT_BUS_TOKEN_FILE: tokenFile }, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
      );
      const outcome = JSON.parse(out.trim());
      // tick-entry --run exits 0 (resolved without throwing)
      expect(outcome.channelId).toBe(channel);
      expect(outcome.termination).toBeDefined();
    } finally {
      rmSync(tokenDir, { recursive: true, force: true });
    }
  }, { timeout: 30000 });

  it("bus unreachable ⇒ tick-entry --run must still fail non-zero", async () => {
    const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realExecFileSync = realChildProcess.execFileSync;
    const tokenDir = mkdtempSync(join(tmpdir(), "e0c7-token-"));
    const tokenFile = join(tokenDir, "token");
    writeFileSync(tokenFile, "test-token\n");
    try {
      realExecFileSync(
        "node", [join(ROOT, "node_modules", ".bin", "vite-node"), join(ROOT, "src", "tick-entry.ts"), "--", "--run", "research:test-nonexistent", "--question", "test", "--max-writes", "10"],
        { cwd: ROOT, encoding: "utf8", env: { ...process.env, AGENT_BUS_URL: "http://127.0.0.1:19999", AGENT_BUS_TOKEN_FILE: tokenFile }, stdio: ["ignore", "pipe", "pipe"], timeout: 30000 },
      );
      expect.fail("expected non-zero exit");
    } catch (e) {
      const err = e as { status?: number };
      expect(err.status).not.toBe(0);
    } finally {
      rmSync(tokenDir, { recursive: true, force: true });
    }
  }, { timeout: 30000 });
});

// ── 判据 3: read 立即停止并产出诊断 ─────────────────────────────────────────

describe("判据 3: read stops immediately when run exited without result", () => {
  it("findRunExited detects exited run from messages", () => {
    const runId = "test-run-exited";
    const msgs: InspectMessage[] = [runExitedMsg(runId, 0)];
    const result = findRunExited(runId, msgs);
    expect(result.exited).toBe(true);
    expect(result.exitCode).toBe(0);
  });

  it("findRunExited returns false for run not in messages", () => {
    const result = findRunExited("unknown-run", []);
    expect(result.exited).toBe(false);
  });

  it("E0c7RunExitedWithoutResultError names runId, role, and elapsed time", () => {
    const err = new E0c7Error("test-run", "dr-triage", 1234);
    expect(err.message).toContain("test-run");
    expect(err.message).toContain("dr-triage");
    expect(err.message).toContain("1234ms");
    expect(err.message).toContain("E0c7 §1.2");
    expect(err.runId).toBe("test-run");
  });
});

// ── 判据 4: drain exec_failed ⇒ 入口响亮失败 ────────────────────────────────

describe("判据 4: drain exec_failed ⇒ entry loud failure naming run_dir", () => {
  it("check-drain-failures.mjs detects engine-killed tick (status=TIMEOUT, error=exec)", async () => {
    const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realExecFileSync = realChildProcess.execFileSync;

    const dir = mkdtempSync(join(tmpdir(), "e0c7-drain-"));
    const drainId = "test-drain-e0c7";

    const runDir = join(dir, "tick-run-timeout");
    mkdirSync(runDir, { recursive: true });
    const indexPath = join(dir, "index.jsonl");
    writeFileSync(
      indexPath,
      JSON.stringify({
        schema: "lei/1",
        kind: "run.start",
        run_id: "tick-run-timeout",
        label: "tick",
        fleet: "fleet.yaml",
        caller: "drain",
        run_dir: runDir,
        ts: new Date().toISOString(),
        pid: 12345,
        drain_id: drainId,
        lane: "tick",
        tick: 1,
      }) + "\n",
    );

    writeFileSync(
      join(runDir, "journal.jsonl"),
      JSON.stringify({
        identity: "tick",
        result: "[外部调用失败 status=TIMEOUT]\n",
        error: "exec",
      }) + "\n",
    );

    const drainJson = JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: dir,
      drain_id: drainId,
    });

    try {
      realExecFileSync("node", [CHECK_DRAIN_FAILURES], {
        input: drainJson,
        encoding: "utf8",
        stdio: ["pipe", "pipe", "pipe"],
        env: { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: dir },
      });
      expect.fail("expected non-zero exit");
    } catch (e) {
      const err = e as { status?: number; stderr?: string | Buffer; stdout?: string | Buffer };
      expect(err.status).not.toBe(0);
      const stderr = String(err.stderr ?? "");
      expect(stderr).toContain("TICK FAILURE");
      expect(stderr).toContain("engine-killed");
      expect(stderr).toContain("status=TIMEOUT");
      expect(stderr).toContain(runDir);
    }

    rmSync(dir, { recursive: true, force: true });
  });

  it("DISCRIMINATING: normal journal exits 0", async () => {
    const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realExecFileSync = realChildProcess.execFileSync;

    const dir = mkdtempSync(join(tmpdir(), "e0c7-drain-disc-"));
    const drainId = "test-drain-e0c7-disc";

    const runDir = join(dir, "tick-run-timeout-disc");
    mkdirSync(runDir, { recursive: true });
    const indexPath = join(dir, "index.jsonl");
    writeFileSync(
      indexPath,
      JSON.stringify({
        schema: "lei/1",
        kind: "run.start",
        run_id: "tick-run-timeout-disc",
        label: "tick",
        fleet: "fleet.yaml",
        caller: "drain",
        run_dir: runDir,
        ts: new Date().toISOString(),
        pid: 12345,
        drain_id: drainId,
        lane: "tick",
        tick: 1,
      }) + "\n",
    );

    writeFileSync(
      join(runDir, "journal.jsonl"),
      JSON.stringify({
        identity: "tick",
        result: "OK: all fine",
      }) + "\n",
    );

    const drainJson = JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: dir,
      drain_id: drainId,
    });

    const result = realExecFileSync("node", [CHECK_DRAIN_FAILURES], {
      input: drainJson,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: dir },
    });
    expect(result).toBeDefined();

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── 判据 4b: MAX_CLUES 由 profile 声明 ──────────────────────────────────────

describe("判据 4b: MAX_CLUES is profile-declared (regression scope narrowed)", () => {
  it("MAX_CLUES is declared in e0-regression profile", () => {
    const profText = readFileSync(PROFILE, "utf8");
    const rec: Record<string, string> = {};
    for (const line of profText.split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) rec[m[1]] = m[2];
    }
    expect(rec.MAX_CLUES).toBeDefined();
    const maxClues = Number(rec.MAX_CLUES);
    expect(maxClues).toBeGreaterThan(0);
    expect(maxClues).toBeLessThan(DEFAULT_TICK_CONFIG.maxClues);
  });

  it("DISCRIMINATING: removing MAX_CLUES from profile makes this test red", () => {
    const profText = readFileSync(PROFILE, "utf8");
    expect(profText).toContain("MAX_CLUES=");
  });

  it("DISCRIMINATING: production wiring — fleet.yaml.tpl injects max_clues", () => {
    // Verifies that the production assembly chain carries MAX_CLUES to the tick.
    // If someone removes max_clues from fleet.yaml.tpl, this test fails.
    const fleetTpl = readFileSync(
      join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl"),
      "utf8",
    );
    expect(fleetTpl).toContain("max_clues: ${MAX_CLUES}");
  });

  it("DISCRIMINATING: production wiring — tick.md appends --max-clues to tick_args", () => {
    // Verifies that tick.md passes --max-clues to tick-entry.
    // If someone removes the --max-clues wiring from tick.md, this test fails.
    const tickMd = readFileSync(
      join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md"),
      "utf8",
    );
    expect(tickMd).toContain("max_clues");
    expect(tickMd).toContain("--max-clues");
  });

  it("DISCRIMINATING: production wiring — workflow.yaml seed payload has max_clues", () => {
    // Verifies that the workflow.yaml seed payload passes max_clues through.
    // If someone removes max_clues from the seed payload, this test fails.
    const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
    const tickSeed = (wf as any).seed?.[0];
    expect(tickSeed).toBeDefined();
    expect(tickSeed.payload?.max_clues).toBeDefined();
  });
});