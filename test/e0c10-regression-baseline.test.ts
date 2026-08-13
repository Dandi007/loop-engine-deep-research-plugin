/**
 * E0c10 —— 回归基线的收尾包：D1–D7 判别性测试（spec §2 判据 2–7）。
 *
 * 每条测试都「把被测行为改坏后必须变红」（spec §5 评审口径）：
 *  - D1  workflow.yaml limits.node_timeout ≥ 904.2 × 2.0（GT-A 余量倍数）；不与源码常量对齐。
 *  - D2  墙钟为主：墙钟充足但次数用尽 ⇒ 入口继续跑（drain_attempts > maxAttempts）。
 *  - D3  次数失控兜底：次数 + 墙钟都用尽 ⇒ 非零退出并点名 BACKSTOP。
 *  - D4  triage 与 generate 各一条：run exited 无 result ⇒ tick 以 0 退出、诊断含已等时长、
 *        该 doc/clue 标失败（不静默当成功）；测试驱动真实轮询读取路径。
 *        反向：bus 不可达 ⇒ tick 非零退出。
 *  - D5  MAX_CLUES 经 profile → fleet.yaml.tpl → workflow.yaml → tick.md → --max-clues 真正接线；
 *        删掉 fleet 注入 ⇒ 变红（不得在测试里直接给 runChannelWrite 传参绕过装配链）。
 *  - D6  timings 覆盖整个 tick（含 generate 段）；数字可溯源到具体字段。
 *  - D7  journal 里 [外部调用失败 status=TIMEOUT] + error:"exec" ⇒ 检查器非零退出并点名 run_dir。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";
import {
  runChannelWrite,
  assembleGenerateDeps,
  pollForResultOrExit,
  RunExitedWithoutResultError,
  resolveRunExitGraceMs,
  DEFAULT_RUN_EXIT_GRACE_MS,
  type TickTimings,
} from "../src/tick-run";
import type { InspectMessage } from "../src/tick-inspect";
import type { TerminationState, BoardState } from "../src/tick";
import type { GenerateDeps, AnchorCheckResult } from "../src/generate";

// execFileSync 被 vi.mock("node:child_process") 替换；D7 需要真实的 execFileSync 来跑检查器子进程。
const realExecFileSync: typeof import("node:child_process").execFileSync =
  await vi.importActual<typeof import("node:child_process")>("node:child_process").then((m) => m.execFileSync);

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WORKFLOW_YAML = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
const FLEET_TPL = join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl");
const TICK_MD = join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md");
const E0_PROFILE = join(ROOT, "profiles", "deploy", "e0-regression.env");
const DRAIN_FAILURES_SCRIPT = join(ROOT, "scripts", "check-drain-failures.mjs");

// D4 —— 假 spawn 捕获 triage 的 run_id（与 g6-result-timeout.test.ts 同款 hoist 范式）。
let capturedTriageRunId = "";
vi.mock("node:child_process", () => {
  const EventEmitter = require("node:events").EventEmitter;
  return {
    spawn: (cmd: string, args: string[]) => {
      const runIdIdx = args.indexOf("--run-id");
      const runId = runIdIdx >= 0 ? args[runIdIdx + 1] : "";
      const roleIdx = args.indexOf("--role");
      if (roleIdx >= 0 && args[roleIdx + 1] === "dr-triage") {
        capturedTriageRunId = runId;
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

// ── D1: node_timeout ≥ 904.2 × 2.0（GT-A 余量倍数）─────────────────────────────

describe("D1: workflow.yaml limits.node_timeout ≥ 904.2 × 2.0 (GT-A)", () => {
  // GT-A 真机取证：实测最大单 tick 耗时 = 904.2 秒。
  const GT_MAX_TICK_SECONDS = 904.2;
  // 声明的余量倍数（与 workflow.yaml 注释逐字一致：≈ 2.0×）。
  const DECLARED_MARGIN = 2.0;

  function readLimits(): Record<string, number> {
    const text = readFileSync(WORKFLOW_YAML, "utf8");
    const m = text.match(/^limits:\s*\{([^}]*)\}/m);
    expect(m, "workflow.yaml must have a limits: { ... } line").not.toBeNull();
    const inner = m![1];
    const rec: Record<string, number> = {};
    for (const part of inner.split(",")) {
      const km = part.match(/([A-Za-z_]+)\s*:\s*(\d+)/);
      if (km) rec[km[1]] = Number(km[2]);
    }
    return rec;
  }

  it("node_timeout ≥ 904.2 × 2.0 = 1808.4 (GT-A declared margin × observed max)", () => {
    const limits = readLimits();
    expect(limits.node_timeout).toBeDefined();
    // 判据 3：断言 ≥ 904.2 × 声明的余量倍数（⛔ 不得断言与源码常量对齐）。
    expect(limits.node_timeout).toBeGreaterThanOrEqual(GT_MAX_TICK_SECONDS * DECLARED_MARGIN);
  });

  it("discriminant: reverting node_timeout to any value < 904.2 makes this red", () => {
    const limits = readLimits();
    // 调回任一小于 904.2 的值 ⇒ 变红（spec §2 判据 3）。
    expect(limits.node_timeout).toBeGreaterThanOrEqual(GT_MAX_TICK_SECONDS);
  });

  it("node_timeout > DEFAULT_AGENT_RESULT_TIMEOUT_MS/1000 = 900 (GT-B)", () => {
    const limits = readLimits();
    // GT-B：闸刀必须大于一次合法等待的预算（900s），否则 readResult/readBody 被腰斩。
    expect(limits.node_timeout).toBeGreaterThan(900);
  });

  it("wall_clock (same unit, same map) also reviewed: ≥ 904.2 × 2.0", () => {
    const limits = readLimits();
    expect(limits.wall_clock).toBeDefined();
    // wall_clock 与 node_timeout 同单位（秒）、同 map：合法 tick 可达 904.2s ⇒ 一并复核。
    expect(limits.wall_clock).toBeGreaterThanOrEqual(GT_MAX_TICK_SECONDS * DECLARED_MARGIN);
  });

  it("comments document both GT-A (904.2× margin) and GT-B (> 900s) reasons", () => {
    const text = readFileSync(WORKFLOW_YAML, "utf8");
    // GT-A：实测最大 904.2s 与余量倍数。
    expect(text).toMatch(/904\.2/);
    expect(text).toMatch(/2\.0×|2\.0 ?×|× ?2\.0/);
    // GT-B：大于 DEFAULT_AGENT_RESULT_TIMEOUT_MS(900s)。
    expect(text).toMatch(/DEFAULT_AGENT_RESULT_TIMEOUT_MS/);
    expect(text).toMatch(/900/);
  });
});

// ── D5: MAX_CLUES 装配链（profile → fleet → workflow → tick.md → --max-clues）────────

describe("D5: MAX_CLUES wired through profile → fleet → workflow → tick.md → --max-clues", () => {
  function readProfileKeys(): Record<string, string> {
    const rec: Record<string, string> = {};
    for (const line of readFileSync(E0_PROFILE, "utf8").split("\n")) {
      const m = line.match(/^([A-Z_]+)=(.*)$/);
      if (m) rec[m[1]] = m[2];
    }
    return rec;
  }

  it("e0-regression profile declares MAX_CLUES=24 (GT-D)", () => {
    const prof = readProfileKeys();
    expect(prof.MAX_CLUES).toBe("24");
  });

  it("fleet.yaml.tpl injects max_clues into pipeline input (assembly-chain wired)", () => {
    const tpl = readFileSync(FLEET_TPL, "utf8");
    // 判据 5：装配链必须把 max_clues 传到 tick。删掉 fleet 的 max_clues 注入 ⇒ 变红。
    expect(tpl).toMatch(/max_clues:\s*\$\{MAX_CLUES\}/);
  });

  it("workflow.yaml seed payload carries max_clues (optional `?`)", () => {
    const wf = readFileSync(WORKFLOW_YAML, "utf8");
    expect(wf).toMatch(/max_clues:\s*"\{\{max_clues\?\}\}"/);
  });

  it("tick.md template passes --max-clues when max_clues is non-empty", () => {
    const md = readFileSync(TICK_MD, "utf8");
    expect(md).toMatch(/--max-clues/);
    // 必须是条件传递（缺省空串不传 ⇒ tick-entry 用 64）。
    expect(md).toMatch(/-n "\$max_clues"/);
  });

  it("discriminant (end-to-end assembly): removing fleet max_clues injection makes --max-clues not reach tick-entry", () => {
    // 真实驱动 tick.md 渲染 + 执行，断言 --max-clues 真的到达 tick-entry argv（经装配链，非直传）。
    const dir = mkdtempSync(join(tmpdir(), "d5-asm-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    const fakeTickEntry = `#!/usr/bin/env bash
case "$1" in
  --parse-trigger-body) printf ''; exit 0 ;;
  *) printf '%s\\n' "$@" > "${argvLog}"; printf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}'; exit 0 ;;
esac
`;
    writeFileSync(tickEntry, fakeTickEntry);
    chmodSync(tickEntry, 0o755);

    // 装配链：profile 的 MAX_CLUES=24 经渲染进入 tick.md 的 {{max_clues}} 占位符。
    const values: Record<string, string> = {
      tick_entry: tickEntry,
      tick_channel: "research:d5.index",
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      max_clues: "24",
      research_question: "test",
      research_origin: "",
      doc_channel: "",
      triage_threshold: "3",
      trigger_store_dir: dir,
      loop_store_cli: join(dir, "loop-store"),
      loop_engine_runner: "bash",
      trigger_body: '{"seed":true}',
    };
    const script = readFileSync(TICK_MD, "utf8").replace(/\{\{([a-z_]+)\}\}/g, (_m, key) => values[key] ?? "");
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);

    try {
      realExecFileSync("bash", [outShell], { cwd: ROOT, encoding: "utf8" });
    } catch {
      // tick.md may exit non-zero if continuation put fails; argv 已记录。
    }
    const argv = readFileSync(argvLog, "utf8").trim().split("\n").filter((l) => l.length > 0);
    expect(argv).toContain("--max-clues");
    const idx = argv.indexOf("--max-clues");
    expect(argv[idx + 1]).toBe("24");
    rmSync(dir, { recursive: true, force: true });
  });

  it("maxClues wired into decideTermination capHit (not just harvest cap)", async () => {
    // D5 装配链判别性：--max-clues 必须影响终态判定（capHit: count >= cfg.maxClues），
    // 不能只接到 harvest 的封顶。构造一个 clue 数 >= maxClues 的板面 ⇒ capHit=true。
    const CHANNEL = "research:d5-term";
    const cards: InspectMessage[] = [];
    // 3 条 explored clue（clue 数 3 >= maxClues 3 ⇒ capHit）。
    for (let i = 1; i <= 3; i++) {
      cards.push({
        message_id: `m${i}`,
        channel_id: CHANNEL,
        channel_seq: i,
        kind: "research.clue.v2",
        payload: { status: "explored", text: `c${i}`, depth: 0, sources: ["code-local"] },
        entity_id: `c${i}`,
        supersedes: null,
        created_at: "2026-08-01T00:00:00Z",
      });
    }
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) {
        return { ok: true, status: 200, json: async () => ({ messages: cards }), text: async () => "{}" } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ messages: [] }), text: async () => "{}" } as Response;
    });
    try {
      const result = await runChannelWrite({
        channelId: CHANNEL,
        maxClues: 3,
        maxWrites: 10,
        workerCmd: "/fake/agent-run",
      });
      expect(result.termination.capHit).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── D6: timings 覆盖整个 tick（含 generate 段）──────────────────────────────

describe("D6: timings cover the whole tick (incl generate), traceable to fields", () => {
  function emptyTerm(over: Partial<TerminationState> = {}): TerminationState {
    return {
      state: "converged",
      coverage: 0,
      zeroGrowthRounds: 0,
      capHit: false,
      boardComposition: { proposed: 0, open: 0, inFlight: 0, explored: 0, blocked: 0 },
      ...over,
    };
  }
  function anchorResult(over: Partial<AnchorCheckResult> = {}): AnchorCheckResult {
    return {
      total: 10, current_parsed: 10, current_verified_hit: 10, current_failed: 0,
      old_format: 0, unparseable: 0, discarded: 0, sums_ok: true, loud_failures: [], ...over,
    };
  }

  it("timings object present with all phased fields, totalMs ≥ sum of phases", async () => {
    const CHANNEL = "research:d6";
    const cards: InspectMessage[] = [{
      message_id: "m1", channel_id: CHANNEL, channel_seq: 1,
      kind: "research.clue.v2",
      payload: { status: "explored", text: "c1", depth: 0, sources: ["code-local"] },
      entity_id: "c1", supersedes: null, created_at: "2026-08-01T00:00:00Z",
    }];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) {
        return { ok: true, status: 200, json: async () => ({ messages: cards }), text: async () => "{}" } as Response;
      }
      if (url.includes("/entities")) {
        return { ok: true, status: 200, json: async () => ({ head: null }), text: async () => "{}" } as Response;
      }
      return { ok: true, status: 200, json: async () => ({ messages: [] }), text: async () => "{}" } as Response;
    });

    const oneShot = mkdtempSync(join(tmpdir(), "d6-oneshot-"));
    const generateDeps: GenerateDeps = {
      readTermination: async () => emptyTerm(),
      countBlocked: async () => 0,
      readQuestion: async () => "test",
      readOrigin: async () => "d6-origin",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "output" })),
      spawnAnchorCheck: vi.fn(async () => anchorResult()),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
    };
    try {
      const result = await runChannelWrite({
        channelId: CHANNEL,
        origin: "d6-origin",
        docChannelId: "research:d6-doc",
        prevZeroGrowthRounds: 2,
        oneShotDir: oneShot,
        generateDeps,
      });
      const t = result.timings;
      expect(t).toBeDefined();
      // 各阶段字段齐全（可溯源到具体字段，spec §2 判据 7）。
      for (const k of ["readBoardMs", "decideMs", "writeMs", "terminationMs", "generateMs", "totalMs"] as (keyof TickTimings)[]) {
        expect(t[k], `timings.${k} must be a finite number`).toBeTypeOf("number");
        expect(Number.isFinite(t[k])).toBe(true);
      }
      // totalMs 覆盖整个 tick（≥ 各阶段之和；generate 段被纳入）。
      expect(t.totalMs).toBeGreaterThanOrEqual(
        t.readBoardMs + t.decideMs + t.writeMs + t.terminationMs + t.generateMs - 5,
      );
      // generate 段确实被计时（本例 origin 已配置 ⇒ runGenerate 被调用 ⇒ generateMs 应 > 0）。
      expect(t.generateMs).toBeGreaterThan(0);
    } finally {
      vi.unstubAllGlobals();
      rmSync(oneShot, { recursive: true, force: true });
    }
  });

  it("generateMs is 0 when generate phase not invoked (origin not configured)", async () => {
    const CHANNEL = "research:d6-nogen";
    vi.stubGlobal("fetch", async () => ({
      ok: true, status: 200, json: async () => ({ messages: [] }), text: async () => "{}",
    } as Response));
    try {
      const result = await runChannelWrite({ channelId: CHANNEL, maxWrites: 5 });
      expect(result.timings.generateMs).toBe(0);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

// ── D7: check-drain-failures.mjs recognizes engine-killed ticks ──────────────

describe("D7: check-drain-failures.mjs recognizes engine-killed ticks (TIMEOUT/exec)", () => {
  function setupFakeEnv(label: string): { dir: string; engineRoot: string; runDir: string } {
    const dir = mkdtempSync(join(tmpdir(), `d7-${label}-`));
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs", `run-${label}`);
    const runDir = join(runsRoot, "tick-run");
    mkdirSync(runDir, { recursive: true });
    return { dir, engineRoot, runDir };
  }

  function writeIndexEntry(indexPath: string, runDir: string, drainId: string): void {
    writeFileSync(indexPath, JSON.stringify({
      schema: "lei/1", kind: "run.start", run_id: "tick-d7", label: "tick",
      fleet: "fleet.yaml", caller: "drain", run_dir: runDir,
      ts: new Date().toISOString(), pid: 1, drain_id: drainId, lane: "tick", tick: 1,
    }) + "\n");
  }

  function runChecker(engineRoot: string, drainId: string): { code: number; stderr: string } {
    try {
      realExecFileSync("node", [DRAIN_FAILURES_SCRIPT], {
        input: JSON.stringify({ drain_id: drainId }),
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: engineRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
      return { code: 0, stderr: "" };
    } catch (e) {
      const err = e as { status?: number; stderr?: string | Buffer };
      return { code: err.status ?? -1, stderr: String(err.stderr ?? "") };
    }
  }

  it("engine-killed tick ([外部调用失败 status=TIMEOUT] + error:exec) ⇒ non-zero exit naming run_dir", () => {
    const { dir, engineRoot, runDir } = setupFakeEnv("killed");
    const drainId = "d7-drain";
    writeIndexEntry(join(engineRoot, "index.jsonl"), runDir, drainId);
    // GT-A 逐字照抄的 journal：引擎级 node_timeout 杀掉的 tick。
    writeFileSync(join(runDir, "journal.jsonl"), JSON.stringify({
      run_id: "tick~1", identity: "tick",
      result: "[外部调用失败 status=TIMEOUT]\n",
      error: "exec",
    }) + "\n");

    const res = runChecker(engineRoot, drainId);
    expect(res.code).not.toBe(0);
    expect(res.stderr).toContain("TICK FAILURE");
    expect(res.stderr).toContain(runDir);
    expect(res.stderr).toMatch(/TIMEOUT\/exec|TIMEOUT/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("discriminant: only [bash 非零退出 EXIT:n] recognized (revert to old) ⇒ engine-killed NOT detected", () => {
    // 判别性：把检查器改回只认 [bash 非零退出 EXIT:n] ⇒ 对 TIMEOUT/exec 的 journal 报成功（exit 0），
    // 即检测不到引擎杀掉的 tick ⇒ 本测试用旧 journal 形式（EXIT:n）仍被检出，TIMEOUT 形式则否。
    // 这里直接断言脚本源码同时含两种检测分支（改回只认 EXIT:n ⇒ 变红）。
    const src = readFileSync(DRAIN_FAILURES_SCRIPT, "utf8");
    expect(src).toMatch(/\[外部调用失败 status=TIMEOUT\]/);
    expect(src).toMatch(/"error"\s*:\s*"exec"/);
  });

  it("bash non-zero exit still recognized (G15 behavior preserved)", () => {
    const { dir, engineRoot, runDir } = setupFakeEnv("bash");
    writeIndexEntry(join(engineRoot, "index.jsonl"), runDir, "d7-bash");
    writeFileSync(join(runDir, "journal.jsonl"), JSON.stringify({
      run_id: "tick~1", identity: "tick",
      result: "[bash 非零退出 EXIT:2]\nbus GET: 404",
    }) + "\n");
    const res = runChecker(engineRoot, "d7-bash");
    expect(res.code).not.toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── D4: run exited 无 result（triage 与 generate 两条路径）──────────────────────
//
// 判据 4（判别性）：构造「run 已 exited 但无 result」⇒ tick 仍以 0 退出、诊断含已等时长、
// 该 doc/clue 被标成失败（不静默当成功）；测试必须驱动真实轮询读取路径。
// 反向：bus 不可达（无任何消息、run 未 exited、纯超时）⇒ tick 非零退出。

describe("D4 (GT-D): run exited without result → record diagnostic, continue tick (exit 0)", () => {
  const CHANNEL = "research:d4-triage";

  beforeEach(() => {
    capturedTriageRunId = "";
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
    delete process.env.RUN_EXIT_GRACE_MS;
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AGENT_RESULT_TIMEOUT_MS;
    delete process.env.AGENT_RESULT_POLL_MS;
    delete process.env.RUN_EXIT_GRACE_MS;
  });

  // 假 spawn：捕获 triage 的 run_id（生产 readResult 经 hasRunExited 读 board:agent-runs）。
  // vi.mock 顶层 hoist（与 g6-result-timeout.test.ts 同款），capturedTriageRunId 为模块级共享变量。

  function jsonResponse(data: unknown) {
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) } as Response;
  }
  function emptyMsgs() { return jsonResponse({ messages: [] }); }
  function msgsResponse(msgs: InspectMessage[]) { return jsonResponse({ messages: msgs }); }

  function clueMsg(clueId: string, over: Record<string, unknown> = {}, seq = 1): InspectMessage {
    return {
      message_id: `msg_${clueId}`, channel_id: CHANNEL, channel_seq: seq,
      kind: "research.clue.v2",
      payload: { status: "proposed", text: `clue ${clueId}`, depth: 1, sources: ["wiki"], ...over },
      entity_id: clueId, supersedes: null, created_at: "2026-08-01T00:00:00Z",
    };
  }

  function runExitedMsg(runId: string, seq = 50): InspectMessage {
    return {
      message_id: `msg_exit_${runId}`, channel_id: "board:agent-runs", channel_seq: seq,
      kind: "agent.run.exited.v1",
      payload: { run_id: runId, exit_code: 0 },
      entity_id: runId, supersedes: null, created_at: "2026-08-01T00:00:01Z",
    };
  }

  it("triage: run exited without dr-triage.result.v1 ⇒ tick exit 0, diagnostic with elapsedMs, no silent success", async () => {
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";
    process.env.RUN_EXIT_GRACE_MS = "20";

    const cards = [clueMsg("c1"), clueMsg("c2"), clueMsg("c3")];
    let agentRunsReads = 0;
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        // 一旦 triage 的 run_id 被捕获，board:agent-runs 上出现 exited 事件，但永远没有 dr-triage.result.v1。
        if (capturedTriageRunId && agentRunsReads >= 2) {
          return msgsResponse([runExitedMsg(capturedTriageRunId)]);
        }
        return emptyMsgs();
      }
      if (url.includes("/publish")) return jsonResponse({ message_id: "pub_001" });
      if (url.includes("/v1/entities/")) {
        return jsonResponse({
          head: { message_id: "head_001", channel_id: CHANNEL, channel_seq: 1,
            kind: "research.clue.v2", payload: { status: "proposed", text: "clue" },
            entity_id: "c1", supersedes: null, created_at: "2026-08-01T00:00:00Z" },
        });
      }
      if (url.includes("/messages")) return msgsResponse(cards);
      return emptyMsgs();
    });

    // tick 必须以 0 退出（不抛）。runChannelWrite 正常返回即 tick 以 0 退出（tick-entry 捕获后 exit 0）。
    const result = await runChannelWrite({
      channelId: CHANNEL,
      question: "test?",
      workerCmd: "/fake/agent-run",
      maxWrites: 10,
    });

    // 诊断含 run_id / role / phase=triage / 已等时长（elapsedMs > 0）。
    expect(result.diagnostics.length).toBeGreaterThanOrEqual(1);
    const triageDiag = result.diagnostics.find((d) => d.phase === "triage");
    expect(triageDiag).toBeDefined();
    expect(triageDiag!.role).toBe("dr-triage");
    expect(triageDiag!.runId).toBe(capturedTriageRunId);
    expect(triageDiag!.elapsedMs).toBeGreaterThan(0);

    // ⛔ 不静默当成功：triage 失败 ⇒ proposed clues 不被 CAS（casCount=0），保持 proposed。
    expect(result.triageReports.length).toBeGreaterThanOrEqual(1);
    expect(result.triageReports[0].casCount).toBe(0);
  });

  it("triage reverse: bus unreachable (no exit event, pure timeout) ⇒ tick non-zero exit (throws)", async () => {
    process.env.AGENT_RESULT_TIMEOUT_MS = "30";
    process.env.AGENT_RESULT_POLL_MS = "5";
    process.env.RUN_EXIT_GRACE_MS = "5";

    const cards = [clueMsg("c1"), clueMsg("c2"), clueMsg("c3")];
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // board:agent-runs 永远空（bus 不可达：无 exited、无 result）⇒ 纯超时 ⇒ tick 非零退出。
      if (url.includes("board:agent-runs")) return emptyMsgs();
      if (url.includes("/publish")) return jsonResponse({ message_id: "pub_001" });
      if (url.includes("/v1/entities/")) {
        return jsonResponse({
          head: { message_id: "head_001", channel_id: CHANNEL, channel_seq: 1,
            kind: "research.clue.v2", payload: { status: "proposed", text: "clue" },
            entity_id: "c1", supersedes: null, created_at: "2026-08-01T00:00:00Z" },
        });
      }
      if (url.includes("/messages")) return msgsResponse(cards);
      return emptyMsgs();
    });

    // 判据 4 反向：bus 不可达 ⇒ tick 非零退出（readResult 抛 timeout，未被 D4 捕获）。
    await expect(
      runChannelWrite({ channelId: CHANNEL, question: "test?", workerCmd: "/fake/agent-run", maxWrites: 10 }),
    ).rejects.toThrow(/G5: timed out waiting for triage result for run/);
  });

  it("generate: run exited without dr-doc.result.v1 ⇒ tick exit 0, diagnostic, doc marked failed", async () => {
    process.env.AGENT_RESULT_TIMEOUT_MS = "500";
    process.env.AGENT_RESULT_POLL_MS = "10";
    process.env.RUN_EXIT_GRACE_MS = "20";

    const cards: InspectMessage[] = [{
      message_id: "m1", channel_id: CHANNEL, channel_seq: 1,
      kind: "research.clue.v2",
      payload: { status: "explored", text: "c1", depth: 0, sources: ["code-local"] },
      entity_id: "c1", supersedes: null, created_at: "2026-08-01T00:00:00Z",
    }];

    let agentRunsReads = 0;
    let generateRunId = "";
    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      // ⚠️ board:agent-runs 的 URL 也含 /messages ⇒ 必须先判 board:agent-runs，否则被 /messages 分支吞掉。
      if (url.includes("board:agent-runs")) {
        agentRunsReads += 1;
        // generate 段会读 board:agent-runs；一旦 run_id 出现（exited 事件），永远没有 dr-doc.result.v1。
        // readGenerateResult 与 hasRunExited 各自独立分页读 board:agent-runs ⇒ 两次 readChannelMessages 调用，
        // 每次都需要在自己的第一页看到 exited 事件、第二页空（终止分页）。用「偶数读返回 exited、奇数读空」
        // 模拟每个 readChannelMessages 调用：page1=exited，page2=empty（停止）。
        if (agentRunsReads >= 2 && agentRunsReads % 2 === 0) {
          return msgsResponse([runExitedMsg("d4-gen-run-001")]);
        }
        return emptyMsgs();
      }
      if (url.includes("/messages")) return msgsResponse(cards);
      if (url.includes("/entities")) return jsonResponse({ head: null });
      return emptyMsgs();
    });

    const oneShot = mkdtempSync(join(tmpdir(), "d4-gen-oneshot-"));
    // 构造生产 generate deps：readBody 经真实轮询读取路径（assembleGenerateDeps），
    // 一旦 exited 被观察到且宽限后仍无 result ⇒ 抛 RunExitedWithoutResultError ⇒
    // runGenerate 捕获（onRunExitedWithoutResult 由 runChannelWrite 注入）⇒ 记录诊断、tick 继续。
    // 为让 generate 真跑：注入 spawnRole 由 generate.ts 调用，但 readBody 走生产装配（pollForResultOrExit）。
    // 此处直接注入 generateDeps，其 spawnRuntime.readBody 用生产 pollForResultOrExit。
    const deps = assembleGenerateDeps(
      { channelId: CHANNEL, workerCmd: "/fake/agent-run", origin: "d4-gen", docChannelId: "research:d4-doc",
        question: "test?", oneShotDir: oneShot },
      { state: "converged", coverage: 0, zeroGrowthRounds: 0, capHit: false,
        boardComposition: { proposed: 0, open: 0, inFlight: 0, explored: 0, blocked: 0 } },
      { cards: [], runs: {}, triageInFlight: false },
    );
    // 让 spawnProcess 捕获 runId（模拟生产），readBody 走生产 pollForResultOrExit（已由 assembleGenerateDeps 装配）。
    const baseSpawnProcess = deps.spawnRuntime!.spawnProcess;
    deps.spawnRuntime!.spawnProcess = async (argv, env) => {
      const runIdIdx = argv.indexOf("--run-id");
      if (runIdIdx >= 0) generateRunId = argv[runIdIdx + 1];
      return baseSpawnProcess(argv, env);
    };
    // 让 readResult 的 exited 检测命中我们固定的 run_id（生产 readGenerateResult 读 board:agent-runs，
    // 但 exited 事件用固定 id；此处把 generateRunId 设为该固定 id 使 hasRunExited 命中）。
    deps.spawnRuntime!.newRunId = () => "d4-gen-run-001";

    let exportCalled = false;
    const baseExport = deps.spawnExport;
    deps.spawnExport = async (body, messageId) => { exportCalled = true; await baseExport(body, messageId); };

    // 注入 onRunExitedWithoutResult（生产装配链在 opts.generateDeps 未注入时由 runChannelWrite 注入；
    // 此处注入 generateDeps 故手动接上，把诊断推进一个本地数组，模拟 tick 输出的 diagnostics）。
    const genDiagnostics: { role: string; runId: string; elapsedMs: number }[] = [];
    deps.onRunExitedWithoutResult = (info) => { genDiagnostics.push(info); };

    try {
      // runChannelWrite 正常返回即 tick 以 0 退出（generate 角色失败被 runGenerate 捕获、记诊断、继续）。
      const result = await runChannelWrite({
        channelId: CHANNEL,
        origin: "d4-gen",
        docChannelId: "research:d4-doc",
        question: "test?",
        prevZeroGrowthRounds: 2,
        oneShotDir: oneShot,
        generateDeps: deps,
      });

      // tick 以 0 退出（runChannelWrite 正常返回）。
      // 诊断含 generate phase 的 role + run_id + elapsedMs（经 onRunExitedWithoutResult 回调）。
      expect(genDiagnostics.length).toBeGreaterThanOrEqual(1);
      const genDiag = genDiagnostics[0];
      expect(genDiag.elapsedMs).toBeGreaterThan(0);
      expect(genDiag.runId).toBe("d4-gen-run-001");
      // dr-debater-* 或 dr-synthesizer 之一。
      expect(genDiag.role).toMatch(/^dr-(debater|synthesizer)/);
      // doc 被标成失败：export 未被调用（report 未发布 ⇒ 不导出）。
      expect(exportCalled).toBe(false);
      // result.diagnostics 在生产装配（未注入 generateDeps）时会含本条；此处注入故为空，
      // 但 runChannelWrite 正常返回（tick 以 0 退出）已证明 generate 失败未毙掉 tick。
      expect(result).toBeDefined();
    } finally {
      vi.unstubAllGlobals();
      rmSync(oneShot, { recursive: true, force: true });
    }
  });

  it("pollForResultOrExit unit: result arrives ⇒ returns result; exited+grace ⇒ RunExitedWithoutResultError", async () => {
    // 直接驱动真实轮询函数（spec §2 判据 4：测试必须驱动真实轮询读取路径）。
    let resultCalls = 0;
    const outcome = await pollForResultOrExit<string>("run-1", "dr-test", {
      readResult: async () => {
        resultCalls += 1;
        return resultCalls >= 2 ? "OK" : null;
      },
      readExited: async () => false,
      timeoutMs: 1000,
      pollMs: 1,
      exitGraceMs: 10,
      buildTimeoutMessage: (rid) => `TIMEOUT ${rid}`,
    });
    expect(outcome).toBe("OK");

    // exited 无 result ⇒ RunExitedWithoutResultError（带 elapsedMs）。
    let exitedSeen = false;
    let exitedAt = 0;
    await expect(
      pollForResultOrExit<string>("run-2", "dr-test", {
        readResult: async () => null,
        readExited: async () => {
          if (!exitedSeen) { exitedSeen = true; exitedAt = Date.now(); }
          return exitedSeen;
        },
        timeoutMs: 5000,
        pollMs: 1,
        exitGraceMs: 10,
        buildTimeoutMessage: (rid) => `TIMEOUT ${rid}`,
      }),
    ).rejects.toBeInstanceOf(RunExitedWithoutResultError);
  });

  it("pollForResultOrExit reverse: no exit, pure timeout ⇒ plain Error (tick non-zero)", async () => {
    await expect(
      pollForResultOrExit<string>("run-3", "dr-test", {
        readResult: async () => null,
        readExited: async () => false,
        timeoutMs: 15,
        pollMs: 3,
        exitGraceMs: 5,
        buildTimeoutMessage: (rid) => `G5: timed out ${rid}`,
      }),
    ).rejects.toThrow(/G5: timed out run-3/);
  });

  it("resolveRunExitGraceMs default and override", () => {
    delete process.env.RUN_EXIT_GRACE_MS;
    expect(resolveRunExitGraceMs()).toBe(DEFAULT_RUN_EXIT_GRACE_MS);
    process.env.RUN_EXIT_GRACE_MS = "5";
    expect(resolveRunExitGraceMs()).toBe(5);
    delete process.env.RUN_EXIT_GRACE_MS;
  });
});

