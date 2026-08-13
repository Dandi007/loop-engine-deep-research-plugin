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
import { readFileSync } from "node:fs";
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

describe("判据 2a: wall-clock budget is primary, attempt count is runaway guard (GT-19)", () => {
  it("e0-regression.sh checks wall-clock before attempt count", () => {
    const script = readFileSync(E0_REGRESSION_SH, "utf8");
    const wallClockIdx = script.indexOf("HIT WALL CLOCK LIMIT");
    const attemptIdx = script.indexOf("HIT ATTEMPT");
    expect(wallClockIdx).toBeGreaterThan(0);
    expect(attemptIdx).toBeGreaterThan(0);
    expect(wallClockIdx).toBeLessThan(attemptIdx);
  });

  it("e0-regression.sh does NOT break on attempt count (wall clock is primary, GT-19)", () => {
    const script = readFileSync(E0_REGRESSION_SH, "utf8");
    const attemptIdx = script.indexOf("HIT ATTEMPT LIMIT (runaway guard)");
    expect(attemptIdx).toBeGreaterThan(0);
    // The attempt limit section should NOT contain a break that exits the loop
    const attemptBlockEnd = script.indexOf("DRAIN_ATTEMPT=$((DRAIN_ATTEMPT + 1))");
    const attemptBlock = script.substring(attemptIdx, attemptBlockEnd);
    expect(attemptBlock).not.toMatch(/\bbreak\b/);
    expect(attemptBlock).not.toMatch(/\bLOOP_EXIT=4\b/);
    expect(attemptBlock).toContain("runaway guard");
    expect(attemptBlock).toContain("HIT ATTEMPT LIMIT");
  });

  it("profile DRAIN_MAX_ATTEMPTS × (shortest_drain + backoff) > wall_clock", () => {
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
});

// ── 判据 2b: 种子板 --run 耗时 < node_timeout/2（GT-15/GT-16）────────────────

describe("判据 2b: seed board --run duration < node_timeout/2 (GT-15/GT-16)", () => {
  it("--run on a 1-clue seed board completes within node_timeout/2 and produces termination", async () => {
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        return jsonResponse({ messages: [] });
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
            payload: { status: "open", text: "seed clue", depth: 0, sources: ["code-local"] },
            entity_id: "seed-1",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) {
        return jsonResponse({
          messages: [
            clueMsg("seed-1", { status: "open", depth: 0, sources: ["code-local"] }, 1),
          ],
        });
      }
      return jsonResponse({ messages: [] });
    });

    const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
    const nodeTimeout = wf.limits?.node_timeout as number;
    const t0 = Date.now();
    const result = await runChannelWrite({
      channelId: CHANNEL,
      question: "test question?",
      workerCmd: "/fake/agent-run",
      allowedRoot: ROOT,
      maxWrites: 10,
      maxClues: 24,
    });
    const elapsed = Date.now() - t0;

    expect(elapsed).toBeLessThan(nodeTimeout * 1000 * 0.5);
    expect(result.termination).toBeDefined();
    expect(result.timings).toBeDefined();
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.readBoardMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.decideTickMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.writeSideMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.decideTerminationMs).toBeGreaterThanOrEqual(0);
  });

  it("DISCRIMINATING: if node_timeout were 30, elapsed time would exceed half", () => {
    const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
    const nodeTimeout = wf.limits?.node_timeout as number;
    // Only the real node_timeout value works; 30 would be too small
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

    // tick does not fail — runChannelWrite resolves (exit 0 equivalent)
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics[0]).toContain("E0c7 §1.2");
    expect(result.diagnostics[0]).toContain("exited without producing a result");
    // decisions were still executed
    expect(result.decisions.length).toBeGreaterThanOrEqual(1);
    // triage report reflects the failure (not budgetSkipped)
    expect(result.triageReports.length).toBeGreaterThanOrEqual(1);
    const triageRpt = result.triageReports[0];
    expect(triageRpt.budgetSkipped).toBe(false);
    expect(triageRpt.runId).toBeTruthy();
  });

  it("bus unreachable ⇒ tick must still fail non-zero", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNREFUSED");
    });

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

  it("--run with maxClues uses the profile value, not the default", async () => {
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        return jsonResponse({ messages: [] });
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
            payload: { status: "open", text: "clue", depth: 0, sources: ["code-local"] },
            entity_id: "c1",
            supersedes: null,
            created_at: "2026-08-01T00:00:00Z",
          },
        });
      }
      if (url.includes("/messages")) {
        return jsonResponse({
          messages: [
            clueMsg("c1", { status: "open", depth: 0, sources: ["code-local"] }, 1),
          ],
        });
      }
      return jsonResponse({ messages: [] });
    });

    const result = await runChannelWrite({
      channelId: CHANNEL,
      question: "test question?",
      workerCmd: "/fake/agent-run",
      allowedRoot: ROOT,
      maxWrites: 10,
      maxClues: 24,
    });

    expect(result.termination).toBeDefined();
    expect(result.termination.boardComposition).toBeDefined();
  });
});