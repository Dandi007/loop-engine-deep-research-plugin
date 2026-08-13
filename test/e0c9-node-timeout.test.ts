/**
 * E0c9 —— node_timeout 校正 + 退出无结果不毙 tick + 兜底真能终止
 *
 * 覆盖 spec §2 判据 2–4b（判别性单测）。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { DEFAULT_AGENT_RESULT_TIMEOUT_MS } from "../src/tick-run";
import { hasRunExited } from "../src/tick-inspect";
import { DEFAULT_TICK_CONFIG } from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_YAML = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");

// ══════════════════════════════════════════════════════════════════════
// 判据 2: node_timeout >= 实测最大单 tick 耗时 x 倍数
// ══════════════════════════════════════════════════════════════════════

describe("判据 2: node_timeout >= measured max single-tick duration x headroom multiplier", () => {
  it("workflow.yaml limits.node_timeout >= 904.2s x 1.99", () => {
    const yaml = readFileSync(WORKFLOW_YAML, "utf8");
    const doc = parse(yaml) as { limits?: { node_timeout?: number } };
    const nodeTimeout = doc?.limits?.node_timeout;
    expect(nodeTimeout).toBeDefined();
    const MEASURED_MAX_MS = 904.2;
    expect(nodeTimeout).toBeGreaterThan(MEASURED_MAX_MS);
    // 1800 / 904.2 ≈ 1.99x headroom
    expect(nodeTimeout! / MEASURED_MAX_MS).toBeGreaterThanOrEqual(1.99);
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
// 判据 2a (GT-19): 墙钟预算为主，不可让次数先撞线
// ══════════════════════════════════════════════════════════════════════

describe("判据 2a (GT-19): wall clock budget is primary, attempt count is safety net", () => {
  it("profile DRAIN_MAX_ATTEMPTS > wall_clock / backoff by a safe margin", () => {
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
});

// ══════════════════════════════════════════════════════════════════════
// 判据 3 (GT-14/§1.2): hasRunExited 函数存在且可判
// ══════════════════════════════════════════════════════════════════════

describe("判据 3 (GT-14/§1.2): hasRunExited function exists and correctly detects exit status", () => {
  it("hasRunExited returns true when agent.run.exited event exists for the run_id", () => {
    const messages = [
      {
        message_id: "m1",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.exited.v2",
        payload: { run_id: "run-001", exit_code: 0 },
        entity_id: "run-001",
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      },
    ];
    expect(hasRunExited("run-001", messages)).toBe(true);
  });

  it("hasRunExited returns false when no agent.run.exited event exists", () => {
    const messages = [
      {
        message_id: "m1",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.started.v2",
        payload: { run_id: "run-001" },
        entity_id: "run-001",
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      },
    ];
    expect(hasRunExited("run-001", messages)).toBe(false);
  });

  it("hasRunExited returns false for empty messages", () => {
    expect(hasRunExited("run-001", [])).toBe(false);
  });

  it("discriminant: if hasRunExited were removed, this test would fail", () => {
    const code = readFileSync(join(ROOT, "src", "tick-inspect.ts"), "utf8");
    expect(code).toContain("export function hasRunExited");
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

  it("detects [外部调用失敗 status=TIMEOUT] in journal", () => {
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
// 判据 4b (regression): TICK FAILURE is visible and names run_dir
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

  it("e0-regression profile has MAX_WRITES=96", () => {
    const profile = readFileSync(join(ROOT, "profiles", "deploy", "e0-regression.env"), "utf8");
    expect(profile).toContain("MAX_WRITES=96");
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
    // The safety net causes LOOP_EXIT=4 then break
    expect(script).toMatch(/HIT ATTEMPT LIMIT[\s\S]*LOOP_EXIT=4[\s\S]*break/);
  });
});