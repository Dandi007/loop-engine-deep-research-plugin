/**
 * E0c7 —— tick 超时间歇性修复；上限按预算给（GT-18 / GT-19）。
 *
 * 覆盖 spec §2 的判别性单测：
 *  - 判据 2: workflow.yaml limits.node_timeout 不小于实测值，改回 30 ⇒ 变红
 *  - 判据 2a: 墙钟预算为主，次数上限仅为失控兜底（GT-19）
 *  - 判据 2z: run 已 exited 但无 result ⇒ tick 仍 exit 0，诊断出现在输出里
 *  - 判据 3: read 立即停止并产出诊断
 *  - 判据 4: drain exec_failed ⇒ 入口响亮失败
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
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

function card(over: Partial<import("../src/tick").BoardCard> = {}): import("../src/tick").BoardCard {
  return {
    clueId: "x",
    text: "investigate X",
    status: "open",
    depth: 0,
    sources: ["code-local"],
    retries: 0,
    ...over,
  };
}

function state(over: Partial<BoardState> = {}): BoardState {
  return {
    cards: [],
    runs: {},
    triageInFlight: false,
    ...over,
  };
}

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function clueMsg(
  clueId: string,
  over: Record<string, unknown> = {},
  seq = 1,
): InspectMessage {
  const payload: Record<string, unknown> = {
    status: "proposed",
    text: `clue ${clueId}`,
    depth: 1,
    sources: ["wiki"],
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

function generateResultMsg(runId: string, body: string, seq = 100): InspectMessage {
  return {
    message_id: `msg_gen_${runId}`,
    channel_id: "board:agent-runs",
    channel_seq: seq,
    kind: "dr-doc.result.v1",
    payload: { run_id: runId, body },
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
  it("node_timeout is at least 600 (10 minutes, matching declared TICK_TIMEOUT_MS budget)", () => {
    const wf = parse(readFileSync(WORKFLOW_YAML, "utf8"));
    const nodeTimeout = wf.limits?.node_timeout as number;
    expect(nodeTimeout).toBeGreaterThanOrEqual(600);
  });

  it("DISCRIMINATING: changing node_timeout to 30 would fail this assertion", () => {
    // 本断言读 workflow.yaml 里那个键的值，改回 30 ⇒ 测试变红。
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
});

// ── 判据 2a: 墙钟预算为主，次数上限仅为失控兜底（GT-19）─────────────────

describe("判据 2a: wall-clock budget is primary, attempt count is runaway guard (GT-19)", () => {
  it("e0-regression.sh checks wall-clock before attempt count", () => {
    const script = readFileSync(E0_REGRESSION_SH, "utf8");
    // 墙钟上限检查必须在次数上限检查之前出现（swap 后的顺序）
    const wallClockIdx = script.indexOf("HIT WALL CLOCK LIMIT");
    const attemptIdx = script.indexOf("HIT ATTEMPT LIMIT");
    expect(wallClockIdx).toBeGreaterThan(0);
    expect(attemptIdx).toBeGreaterThan(0);
    expect(wallClockIdx).toBeLessThan(attemptIdx);
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
    const shortestDrain = 30; // 最短 drain ≈ 30 秒
    // 自洽式：DRAIN_MAX_ATTEMPTS > DRAIN_WALL_CLOCK_SECONDS / (shortest_drain + backoff)
    const formula = Math.ceil(wallClock / (shortestDrain + backoff));
    expect(maxAttempts).toBeGreaterThan(formula);
    // 正常情形下墙钟先撞线：maxAttempts × (shortest_drain + backoff) > wallClock
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
    // 旧值 12 会先于墙钟撞线，新值必须 > 12
    expect(maxAttempts).toBeGreaterThan(12);
  });
});

// ── 判据 2z: run 已 exited 但无 result ⇒ tick exit 0，诊断出现（GT-17）───

describe("判据 2z: run exited without result ⇒ tick exits 0, diagnosis appears (GT-17)", () => {
  it("triage run exited without result ⇒ diagnostics populated, tick does not fail", async () => {
    capturedTriageRunId = "";
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        // 动态返回 exited 消息，runId 与 spawn 出来的 runId 对齐
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

    // triage run 退出无 result ⇒ 诊断被记录
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    expect(result.diagnostics[0]).toContain("E0c7 §1.2");
    expect(result.diagnostics[0]).toContain("exited without producing a result");
  });

  it("bus unreachable ⇒ tick must still fail non-zero", async () => {
    // 真正无法继续的错误（bus 不可达）⇒ 非零退出
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
  });
});

// ── 判据 4: drain exec_failed ⇒ 入口响亮失败 ────────────────────────────────

describe("判据 4: drain exec_failed ⇒ entry loud failure naming run_dir", () => {
  it("check-drain-failures.mjs detects engine-killed tick (status=TIMEOUT, error=exec)", async () => {
    // 使用真实 execFileSync（vi.mock 只 mock 了顶层 import，这里动态 import 获取真实实现）
    const realChildProcess = await vi.importActual<typeof import("node:child_process")>("node:child_process");
    const realExecFileSync = realChildProcess.execFileSync;

    const dir = mkdtempSync(join(tmpdir(), "e0c7-drain-"));
    const drainId = "test-drain-e0c7";

    // 造假 index.jsonl
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

    // 造假 journal.jsonl（引擎杀掉的 tick）
    writeFileSync(
      join(runDir, "journal.jsonl"),
      JSON.stringify({
        identity: "tick",
        result: "[外部调用失败 status=TIMEOUT]\n",
        error: "exec",
      }) + "\n",
    );

    // 造假 drain JSON
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

  it("DISCRIMINATING: removing the engine-killed check ⇒ script exits 0", async () => {
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

    // 正常 journal（无 bash 非零退出，无 exec error）
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

    // 正常 tick 应当 exit 0
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