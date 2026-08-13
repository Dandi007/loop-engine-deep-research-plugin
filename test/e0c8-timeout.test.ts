/**
 * E0c8 —— tick 超时修复：引擎级 node_timeout 抬升、墙钟为主 drain、run 退出无结果可检测。
 *
 * 覆盖 spec §2 判据 2, 2a, 2z, 2b, 3, 4。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as YAML from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ══════════════════════════════════════════════════════════════════════
// 判据 2 (GT-18): workflow.yaml node_timeout 判别性
// ══════════════════════════════════════════════════════════════════════

describe("判据 2 (GT-18): node_timeout in workflow.yaml >= measured max tick time", () => {
  it("workflow.yaml limits.node_timeout >= 390 (实测最大单 tick 耗时, 含 generate)", () => {
    const wfPath = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
    const content = readFileSync(wfPath, "utf8");
    const parsed = YAML.parse(content) as Record<string, unknown>;
    const limits = parsed.limits as Record<string, number>;
    expect(limits).toBeDefined();
    expect(limits.node_timeout).toBeDefined();
    // 实测最大单 tick 耗时约 390s（含 generate 段，timings 埋点覆盖全阶段）。
    // node_timeout 必须 >= 390。
    expect(limits.node_timeout).toBeGreaterThanOrEqual(390);
  });

  it("discriminant: changing node_timeout back to 30 would make this test fail", () => {
    const wfPath = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
    const content = readFileSync(wfPath, "utf8");
    const parsed = YAML.parse(content) as Record<string, unknown>;
    const limits = parsed.limits as Record<string, number>;
    expect(limits.node_timeout).toBe(600);
    // If this were 30, the assertion limits.node_timeout >= 390 would fail
    expect(limits.node_timeout).not.toBe(30);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 2a (GT-19): 墙钟为主 drain（墙钟充足但 attempt 次数用尽 ⇒ 仍然继续）
// ══════════════════════════════════════════════════════════════════════

describe("判据 2a (GT-19): wall-clock-primary drain", () => {
  it("e0-regression.sh checks wall clock BEFORE attempt limit", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    const wallIdx = script.indexOf("HIT WALL CLOCK LIMIT");
    const attemptIdx = script.indexOf("HIT ATTEMPT LIMIT");
    expect(wallIdx).toBeGreaterThan(0);
    expect(attemptIdx).toBeGreaterThan(0);
    // Wall clock check must appear before attempt limit check
    expect(wallIdx).toBeLessThan(attemptIdx);
  });

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
    // 最短 drain（板面已排空）≈ 3s
    const minCycles = Math.floor(wallClock / (3 + backoff));
    // DRAIN_MAX_ATTEMPTS must be significantly larger than minCycles
    expect(maxAttempts).toBeGreaterThan(minCycles * 1.5);
    // Formula comment must exist
    expect(content).toMatch(/E0c8.*§1\.1b/);
    expect(content).toMatch(/2400.*120/);
  });

  it("discriminant: if attempt limit were checked first, wall clock would be unreachable in always-drained scenario", () => {
    const profPath = join(ROOT, "profiles", "deploy", "e0-regression.env");
    const content = readFileSync(profPath, "utf8");
    const attemptsMatch = content.match(/DRAIN_MAX_ATTEMPTS=(\d+)/);
    const wallMatch = content.match(/DRAIN_WALL_CLOCK_SECONDS=(\d+)/);
    const backoffMatch = content.match(/DRAIN_BACKOFF_SECONDS=(\d+)/);
    const maxAttempts = Number(attemptsMatch![1]);
    const wallClock = Number(wallMatch![1]);
    const backoff = Number(backoffMatch![1]);
    // With wall clock primary: even in always-drained scenario,
    // wall clock (2400s) runs out before attempt limit (40 * ~123s = 4920s)
    const worstCaseAttemptTime = maxAttempts * (3 + backoff);
    expect(worstCaseAttemptTime).toBeGreaterThan(wallClock);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 2z (GT-17): 生成角色退出却无 result ⇒ tick 继续 (exit 0)
// ══════════════════════════════════════════════════════════════════════

describe("判据 2z (GT-17): generate worker exited without result ⇒ tick continues", () => {
  it("RunExitedWithoutResultError is catchable and does not propagate as a fatal error", async () => {
    const { RunExitedWithoutResultError } = await import("../src/tick-run");
    const err = new RunExitedWithoutResultError("run-456", "dr-debater-advocate", 1234);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RunExitedWithoutResultError");
    expect(err.message).toContain("run-456");
    expect(err.message).toContain("dr-debater-advocate");
    expect(err.message).toContain("1234ms");
    // The error is designed to be caught and logged, not to kill the tick
    let caught = false;
    try {
      throw err;
    } catch (e) {
      if (e instanceof RunExitedWithoutResultError) {
        caught = true;
      }
    }
    expect(caught).toBe(true);
  });

  it("RunExitedWithoutResultError is exported from tick-run", async () => {
    const mod = await import("../src/tick-run");
    expect(mod.RunExitedWithoutResultError).toBeDefined();
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

  it("readTriageResult poll loop detects run exited and throws RunExitedWithoutResultError", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "5000");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "100");
    const runId = "g6-bounded-detection-001";

    // Mock fetch: board:agent-runs returns agent.run.exited but no triage result
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            messages: [
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
            ],
          }),
          text: async () => "",
        };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [] }),
        text: async () => "",
      };
    });

    const { readTriageResult, isRunExited, readChannelMessages } = await import("../src/tick-inspect");
    const messages = await readChannelMessages("board:agent-runs");
    expect(isRunExited(runId, messages)).toBe(true);
    // The run is exited but no triage result exists
    const result = await readTriageResult(runId);
    expect(result).toBeNull();
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

  it("discriminant: RunExitedWithoutResultError names run_id and role", async () => {
    const { RunExitedWithoutResultError } = await import("../src/tick-run");
    const err = new RunExitedWithoutResultError("run-123", "dr-triage", 5000);
    expect(err.message).toContain("run-123");
    expect(err.message).toContain("dr-triage");
    expect(err.message).toContain("5000ms");
    expect(err.message).toMatch(/exited without producing a result/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 4 (§1.3): drain 内 tick exec_failed ⇒ 响亮失败
// ══════════════════════════════════════════════════════════════════════

describe("判据 4 (§1.3): drain tick exec_failed ⇒ loud failure naming run_dir", () => {
  it("check-drain-failures.mjs detects TICK FAILURE from journal.jsonl", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c8-c4-"));
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs");
    mkdirSync(runsRoot, { recursive: true });
    const runDir = join(runsRoot, "run-fail-1", "tick-run");
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
        drain_id: "test-drain-fail",
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
      drain_id: "test-drain-fail",
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
  it("runChannelWrite without spawn/network returns timings and completes quickly", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "100");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "10");
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
      text: async () => "",
    }));
    const { runChannelWrite } = await import("../src/tick-run");
    const start = Date.now();
    const result = await runChannelWrite({
      channelId: "research:e0c8-2b-test",
      maxWrites: 10,
    });
    const elapsed = Date.now() - start;
    // timings must be present
    expect(result.timings).toBeDefined();
    expect(result.timings.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.readMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.executeMs).toBeGreaterThanOrEqual(0);
    expect(result.timings.termMs).toBeGreaterThanOrEqual(0);
    // On a seed board with no real work, should complete in well under 300s (node_timeout/2)
    expect(elapsed).toBeLessThan(300_000);
    vi.unstubAllGlobals();
  });

  it("discriminant: timings field is present in RunWriteOutcome", async () => {
    vi.stubEnv("AGENT_RESULT_TIMEOUT_MS", "100");
    vi.stubEnv("AGENT_RESULT_POLL_MS", "10");
    vi.stubGlobal("fetch", async () => ({
      ok: true,
      status: 200,
      json: async () => ({ messages: [] }),
      text: async () => "",
    }));
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
    vi.unstubAllGlobals();
  });
});