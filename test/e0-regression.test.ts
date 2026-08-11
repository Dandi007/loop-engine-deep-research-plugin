/**
 * E0 —— 真机端到端回归基线（deep-research V3 第一个包）。
 *
 * 覆盖 spec §2.4 的四条判别性单测（每条把被测行为改坏后必须变红）：
 *  - T-A  AGENT_BUS_TOKEN_FILE 设 ⇒ 读该路径；不设 ⇒ 读默认路径（两个方向都断言）。
 *  - T-B  凭证文件不存在/为空 ⇒ 抛错且错误信息含变量名与解析到的路径；不静默降级。
 *  - T-C  生产护栏：AGENT_BUS_URL 指向 7490（或 token 路径落生产目录）⇒ 入口拒绝启动、
 *         非零退出、且没有发生任何 bus 写入（用计数 bus 断言零请求）。
 *  - T-D  --profile e0-regression 加载后，§2.2 列出的每个键都非空；channel 名与生产 profile 无交集。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const fsProbe = vi.hoisted(() => ({
  readPaths: [] as string[],
  capture: false,
  overrides: {} as Record<string, string>,
}));

// 仅当 capture 打开时记录 bus 模块读取的 token 文件路径；overrides 命中时返回合成内容
// （T-A 'unset' 方向用它为默认凭证路径提供合成 token，使单测不依赖生产凭证文件是否存在）。
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: unknown, ...args: unknown[]) => {
      const p = String(path);
      if (fsProbe.capture) fsProbe.readPaths.push(p);
      if (fsProbe.overrides[p] !== undefined) return fsProbe.overrides[p];
      return (actual.readFileSync as (p: unknown, ...a: unknown[]) => string)(path, ...args);
    },
  };
});

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "e0-regression.sh");
const VERIFY_BIN = join(ROOT, "bin", "e0-verify.sh");
const FAKE_BUS = join(ROOT, "test", "fixtures", "fake-bus.mjs");
const SEED_BIN = join(ROOT, "scripts", "e0-seed.mjs");
const METRICS_BIN = join(ROOT, "scripts", "e0-metrics.mjs");
const PROFILES_DIR = join(ROOT, "profiles", "deploy");
const DEFAULT_TOKEN_PATH = "/data/agent-bus/tokens/uther-tui.token";
const REQUIRED_PROFILE_KEYS = [
  "RESEARCH_QUESTION",
  "RESEARCH_ORIGIN",
  "DOC_CHANNEL",
  "TICK_CHANNEL",
  "EVIDENCE_CHANNEL",
  "ANCHOR_CHECK_BIN",
  "EXPORT_ROOT",
  "ALLOWED_ROOT",
];

async function loadBus() {
  vi.resetModules();
  return await import("../src/bus");
}

function stubFetchCapture(): () => string | null {
  let auth: string | null = null;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: unknown, init?: RequestInit) => {
      const headers = init?.headers as Record<string, string> | undefined;
      auth = headers?.Authorization ?? null;
      return {
        ok: true,
        status: 200,
        json: async () => ({ message_id: "m", channel_seq: 1, deduplicated: false }),
        text: async () => "",
      } as Response;
    }),
  );
  return () => auth;
}

function makeTempToken(content: string): string {
  const dir = mkdtempSync(join(tmpdir(), "e0-tok-"));
  const p = join(dir, "token");
  writeFileSync(p, content);
  return p;
}

function readProfile(name: string): Record<string, string> {
  const text = readFileSync(join(PROFILES_DIR, `${name}.env`), "utf8");
  const rec: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) rec[m[1]] = m[2];
  }
  return rec;
}

function runScript(env: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("bash", [BIN], {
      cwd: ROOT,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
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

function startCountingBus(): Promise<{
  base: string;
  count: () => number;
  close: () => void;
}> {
  return new Promise((resolve) => {
    let count = 0;
    const server = createServer((_req, res) => {
      count += 1;
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        count: () => count,
        close: () => server.close(),
      });
    });
  });
}

function runCmd(argv: string[], env: NodeJS.ProcessEnv = process.env): { code: number; out: string; err: string } {
  try {
    const out = execFileSync(argv[0], argv.slice(1), {
      cwd: ROOT,
      encoding: "utf8",
      env,
      stdio: ["ignore", "pipe", "pipe"],
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

interface SnapshotJson {
  tick_channel: string;
  tick_head_seq: number;
  sum: number;
  channel_count: number;
  channels: Record<string, number>;
}

// 真实驱动（bin/deep-research-loop.sh）在 run.stdout.log 里发出的收尾信号是 loop-engine 的
// **drain 摘要**（`cat "$DRAIN_TMP"` 的单个 JSON 对象，reason+rounds+drain_id）。
// 板面真正的 termination.state **不在** run.stdout.log 里：那是 tick 节点每轮 run_output 的 JSON
// （含 termination），被 loop-engine 收进 <run_dir>/journal.jsonl。e0-verify 沿
// drain_id → index.jsonl → run_dir → journal.jsonl 读它。因此本文件要构造与真实驱动一致的
// 运行时根（index.jsonl + journal.jsonl），让终态断言能读到真实 tick run_output 的 termination.state。

interface EngineTerminal {
  /** 写入 journal.jsonl 里最后一轮 tick run_output 的 termination.state（null = 板面未达终态）。 */
  state: string | null;
  /** drain 摘要里要带的 drain_id；null 表示 run.stdout.log 里没有 drain 摘要/drain_id。 */
  drainId?: string;
}

// 构造一个假的 loop-engine 运行时根：index.jsonl + run_dir/journal.jsonl（含 tick run_output JSON）。
function makeEngineRoot(
  dir: string,
  drainId: string,
  termState: string | null,
): { indexFile: string; runDir: string } {
  const runDir = join(dir, "engine-root", "runs", "run-r", "tick-run");
  mkdirSync(runDir, { recursive: true });
  const runOutput = JSON.stringify({
    channelId: "t",
    messageCount: 1,
    decisions: [],
    writes: 1,
    skipped: 0,
    spawns: [],
    harvestReports: [],
    triageReports: [],
    hasPendingWork: false,
    termination: {
      state: termState,
      coverage: termState === null ? 1 : 1,
      zeroGrowthRounds: termState === null ? 0 : 2,
      capHit: false,
    },
  });
  writeFileSync(join(runDir, "journal.jsonl"), `${runOutput}\n`);
  const indexFile = join(dir, "engine-root", "index.jsonl");
  writeFileSync(
    indexFile,
    JSON.stringify({
      schema: "lei/1",
      kind: "run.start",
      run_id: "tick-run",
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
  return { indexFile, runDir };
}

// run.stdout.log 里 loop-engine drain 摘要（与真实驱动 `cat "$DRAIN_TMP"` 同构）。
function drainLine(drainId: string, rounds = 1): string {
  return `${JSON.stringify({ reason: "drained", rounds, ticksByLabel: { tick: rounds }, drain_id: drainId })}\n`;
}

interface VerifyOpts {
  /** 覆盖 run.stdout.log 内容。缺省用含 drainId 的 drain 摘要。 */
  runLog?: string;
  /** journal.jsonl 里最后一轮 tick 的 termination.state（缺省 "converged"）。 */
  termState?: string | null;
  /** drain_id；缺省随机生成。 */
  drainId?: string;
  /** 是否构建运行时根（index.jsonl + journal.jsonl）。true 时 set LOOP_ENGINE_RUNTIME_ROOT。 */
  engine?: boolean;
}

function runVerify(
  beforeRun: SnapshotJson,
  afterRun: SnapshotJson,
  beforeProd: { sum: number; channel_count: number; channels: Record<string, number> },
  afterProd: { sum: number; channel_count: number; channels: Record<string, number> },
  opts: VerifyOpts = {},
): { code: number; out: string; err: string } {
  const dir = mkdtempSync(join(tmpdir(), "e0-verify-"));
  const w = (name: string, content: string) => writeFileSync(join(dir, name), content);
  w("br.json", JSON.stringify(beforeRun));
  w("ar.json", JSON.stringify(afterRun));
  w("bp.json", JSON.stringify(beforeProd));
  w("ap.json", JSON.stringify(afterProd));
  const drainId = opts.drainId ?? `drain-${Math.random().toString(36).slice(2)}`;
  const termState = opts.termState === undefined ? "converged" : opts.termState;
  const runLog = opts.runLog ?? drainLine(drainId);
  w("run.stdout.log", runLog);
  const env: NodeJS.ProcessEnv = { ...process.env };
  if (opts.engine !== false) {
    makeEngineRoot(dir, drainId, termState);
    env.LOOP_ENGINE_RUNTIME_ROOT = join(dir, "engine-root");
  }
  try {
    return runCmd(
      [
        "bash",
        VERIFY_BIN,
        join(dir, "br.json"),
        join(dir, "ar.json"),
        join(dir, "bp.json"),
        join(dir, "ap.json"),
        join(dir, "run.stdout.log"),
      ],
      env,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function startFakeBus(port: number): Promise<{ base: string; close: () => void }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [FAKE_BUS], {
      env: { ...process.env, A10B_BUS_PORT: String(port) },
      stdio: "ignore",
    });
    const deadline = Date.now() + 5000;
    const poll = async () => {
      try {
        await fetch(`http://127.0.0.1:${port}/v1/channels/_probe`);
        resolve({ base: `http://127.0.0.1:${port}`, close: () => child.kill() });
      } catch {
        if (Date.now() > deadline) {
          child.kill();
          reject(new Error(`fake bus did not come up on ${port}`));
          return;
        }
        setTimeout(poll, 40);
      }
    };
    poll();
  });
}

const SNAP = (
  tick: number,
  sum: number,
  channels: Record<string, number>,
): SnapshotJson => ({ tick_channel: "t", tick_head_seq: tick, sum, channel_count: Object.keys(channels).length, channels });
const PROD = (sum: number, channels: Record<string, number>) => ({ sum, channel_count: Object.keys(channels).length, channels });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  delete process.env.AGENT_BUS_TOKEN_FILE;
});

// ── T-A：凭证路径可配置（两个方向）──────────────────────────────────────

describe("T-A: AGENT_BUS_TOKEN_FILE selects the token path", () => {
  it("when set, reads the configured path (Authorization carries that file's token)", async () => {
    const p = makeTempToken("CONFIGURED_TOKEN\n");
    vi.stubEnv("AGENT_BUS_TOKEN_FILE", p);
    const getAuth = stubFetchCapture();
    const bus = await loadBus();
    await bus.publish("research:e0-regression.index", {
      kind: "k",
      payload: {},
      idempotency_key: "ik",
    });
    expect(getAuth()).toBe("Bearer CONFIGURED_TOKEN");
    rmSync(dirname(p), { recursive: true, force: true });
  });

  it("when unset, falls back to the default path (reads the default path, not any other)", async () => {
    delete process.env.AGENT_BUS_TOKEN_FILE;
    fsProbe.readPaths.length = 0;
    fsProbe.capture = true;
    fsProbe.overrides[DEFAULT_TOKEN_PATH] = "SYNTHETIC_TOKEN";
    const getAuth = stubFetchCapture();
    const bus = await loadBus();
    await bus.publish("research:e0-regression.index", {
      kind: "k",
      payload: {},
      idempotency_key: "ik",
    });
    fsProbe.capture = false;
    delete fsProbe.overrides[DEFAULT_TOKEN_PATH];
    expect(fsProbe.readPaths).toContain(DEFAULT_TOKEN_PATH);
    expect(getAuth()).toBe("Bearer SYNTHETIC_TOKEN");
  });
});

// ── T-B：凭证读取失败响亮失败，不静默降级 ────────────────────────────────

describe("T-B: missing/empty token file fails loudly (no silent fallback)", () => {
  it("missing file ⇒ error names AGENT_BUS_TOKEN_FILE and the resolved path", async () => {
    const p = join(mkdtempSync(join(tmpdir(), "e0-missing-")), "no-such-token");
    vi.stubEnv("AGENT_BUS_TOKEN_FILE", p);
    stubFetchCapture();
    const bus = await loadBus();
    const e1 = (await bus
      .publish("research:e0-regression.index", { kind: "k", payload: {}, idempotency_key: "ik" })
      .catch((err) => err)) as Error;
    expect(e1).toBeInstanceOf(Error);
    expect(String(e1.message)).toMatch(/AGENT_BUS_TOKEN_FILE/);
    expect(String(e1.message)).toContain(p);
  });

  it("empty file ⇒ error names AGENT_BUS_TOKEN_FILE and the resolved path", async () => {
    const p = makeTempToken("\n   \n");
    vi.stubEnv("AGENT_BUS_TOKEN_FILE", p);
    stubFetchCapture();
    const bus = await loadBus();
    const e1 = (await bus
      .publish("research:e0-regression.index", { kind: "k", payload: {}, idempotency_key: "ik" })
      .catch((err) => err)) as Error;
    expect(e1).toBeInstanceOf(Error);
    expect(String(e1.message)).toMatch(/AGENT_BUS_TOKEN_FILE/);
    expect(String(e1.message)).toContain(p);
    expect(String(e1.message)).toMatch(/empty/i);
  });
});

// ── T-C：生产护栏（拒绝启动、非零退出、零 bus 写入）──────────────────────

describe("T-C: production guard refuses to start with zero bus writes", () => {
  it("token path under /data/agent-bus/ ⇒ non-zero exit naming the trigger, and ZERO bus requests", async () => {
    const bus = await startCountingBus();
    try {
      const env = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: "/data/agent-bus/tokens/uther-tui.token",
      };
      const res = runScript(env);
      expect(res.code).not.toBe(0);
      expect(res.err).toMatch(/REFUSING/);
      expect(res.err).toMatch(/AGENT_BUS_TOKEN_FILE/);
      expect(bus.count()).toBe(0);
    } finally {
      bus.close();
    }
  });

  it("AGENT_BUS_URL targeting port 7490 ⇒ non-zero exit naming the trigger", async () => {
    const env = {
      ...process.env,
      AGENT_BUS_URL: "http://127.0.0.1:7490",
      AGENT_BUS_TOKEN_FILE: "/data/agent-bus-test/tokens/uther-tui.token",
    };
    const res = runScript(env);
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/REFUSING/);
    expect(res.err).toMatch(/7490/);
  });
});

// ── T-D：profile 键齐备且 channel 名与生产无交集 ─────────────────────────

describe("T-D: --profile e0-regression provides every required key and disjoint channels", () => {
  it("every §2.2 key is present and non-empty", () => {
    const prof = readProfile("e0-regression");
    for (const k of REQUIRED_PROFILE_KEYS) {
      expect(prof[k], `profile key ${k} must be present and non-empty`).toBeTruthy();
      expect(prof[k].trim(), `profile key ${k} must not be blank`).not.toBe("");
    }
  });

  it("channel names are disjoint from the production profile agent-harness.env", () => {
    const e0 = readProfile("e0-regression");
    const prod = readProfile("agent-harness");
    const e0Ch = [e0.TICK_CHANNEL, e0.EVIDENCE_CHANNEL, e0.DOC_CHANNEL];
    const prodCh = [prod.TICK_CHANNEL, prod.EVIDENCE_CHANNEL, prod.DOC_CHANNEL];
    for (const c of e0Ch) {
      expect(c).toMatch(/research:e0/);
      expect(prodCh).not.toContain(c);
    }
  });

  it("--profile e0-regression loads via the entry script (guard passes, script proceeds past profile load)", () => {
    // 使用测试总线 URL + 一个不存在的测试 token 路径：护栏放行（不指向生产），
    // 脚本应越过 profile 加载并进入 channel 预备阶段（因测试 token 缺失而响亮失败，而非“unknown profile”）。
    // E0_RECORD_ROOT 指向临时目录，避免在 /data/loop-engine/e0-runs 下累积空记录目录。
    const recRoot = mkdtempSync(join(tmpdir(), "e0-recroot-"));
    try {
      const env = {
        ...process.env,
        AGENT_BUS_URL: "http://127.0.0.1:7495",
        AGENT_BUS_TOKEN_FILE: "/data/agent-bus-test/tokens/nonexistent.token",
        E0_RECORD_ROOT: recRoot,
      };
      const res = runScript(env);
      expect(res.err).not.toMatch(/unknown deploy profile/);
      expect(res.err).toMatch(/e0-regression/);
    } finally {
      rmSync(recRoot, { recursive: true, force: true });
    }
  });
});

// ── T-VERIFY-Z2（⭐ 判别性，blocker 2）：生产总线 sum(head_seq) 增长 ⇒ 非零退出并点名污染 ──

describe("T-VERIFY-Z2: production bus sum(head_seq) growth is flagged", () => {
  it("production sum grew after run ⇒ non-zero exit naming the pollution", () => {
    const res = runVerify(
      SNAP(5, 20, { a: 10, b: 10 }),
      SNAP(6, 20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      PROD(50, { a: 30, b: 20 }),
    );
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/Z2/);
    expect(res.err).toMatch(/pollut/i);
  });

  it("production sum unchanged after run ⇒ exit 0", () => {
    const res = runVerify(
      SNAP(5, 20, { a: 10, b: 10 }),
      SNAP(6, 20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
    );
    expect(res.code).toBe(0);
  });
});

// ── T-VERIFY-Z1（⭐ 判别性，E0a 目标）：loop 退出 0 但零写入 / 板面无终态 ⇒ 非零退出 ──

describe("T-VERIFY-Z1: loop exit 0 with zero bus growth is flagged", () => {
  it("tick head_seq did not grow (loop wrote nothing / no terminal state) ⇒ non-zero exit naming Z1", () => {
    const res = runVerify(
      SNAP(5, 20, { a: 10, b: 10 }),
      SNAP(5, 20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
    );
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/Z1/);
  });

  it("tick head_seq strictly grew ⇒ exit 0", () => {
    const res = runVerify(
      SNAP(5, 20, { a: 10, b: 10 }),
      SNAP(9, 20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
    );
    expect(res.code).toBe(0);
  });
});

// ── T-FIXTURE-CONTRACT（⭐ 判别性，blocker 1 / §1.3）：fixture 必须与真实 agent-bus 契约一致 ──
//    真实 API 的单 channel GET 不返回 head_seq；head_seq 只在列表端点 GET /v1/channels 出现。
//    若把 fixture 改回 E0a 虚构契约（单 channel GET 返回 head_seq / 列表不返回），本组必须变红。

describe("T-FIXTURE-CONTRACT: fake bus matches the real agent-bus field contract", () => {
  it("single channel GET does NOT return head_seq; list GET DOES return head_seq", async () => {
    const port = 20000 + Math.floor(Math.random() * 40000);
    const bus = await startFakeBus(port);
    try {
      await fetch(`${bus.base}/v1/channels/research:e0-test.ch/publish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "k", payload: {}, idempotency_key: "ik" }),
      });
      const single = (await (await fetch(`${bus.base}/v1/channels/research:e0-test.ch`)).json()) as Record<string, unknown>;
      expect(single).not.toHaveProperty("head_seq");

      const list = (await (await fetch(`${bus.base}/v1/channels`)).json()) as Array<Record<string, unknown>>;
      expect(Array.isArray(list)).toBe(true);
      const entry = list.find((c) => c.channel_id === "research:e0-test.ch");
      expect(entry).toBeDefined();
      expect(entry).toHaveProperty("head_seq");
    } finally {
      bus.close();
    }
  });
});

// ── T-METRICS-CLI-HTTP（finding 4）：e0-metrics CLI 真正驱动 fixture 的 HTTP 契约 ──
//    之前只有纯函数与字段集契约被测试，从没测过 CLI 经 HTTP 读 fixture 的路径。
//    本组覆盖「POST /v1/channels 创建空 channel → 列表端点能读到 head_seq 0」这一条
//    e0-regression.sh 实际依赖的路径（真实 agent-bus 里创建但为空的 channel 也会出现在列表）。

describe("T-METRICS-CLI-HTTP: e0-metrics CLI drives the fixture over HTTP", () => {
  it("a created-but-empty channel is listed with head_seq 0 and snapshot reads it via HTTP", async () => {
    const port = 20000 + Math.floor(Math.random() * 40000);
    const bus = await startFakeBus(port);
    const tokenPath = makeTempToken("TEST_TOKEN\n");
    try {
      const created = await fetch(`${bus.base}/v1/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: "research:e0-empty.ch" }),
      });
      expect(created.status).toBe(200);

      const env = { ...process.env, AGENT_BUS_URL: bus.base, AGENT_BUS_TOKEN_FILE: tokenPath };
      const snap = runCmd(["node", METRICS_BIN, "snapshot", bus.base, tokenPath, "research:e0-empty.ch"], env);
      expect(snap.code).toBe(0);
      const j = JSON.parse(snap.out.trim());
      expect(j.tick_channel).toBe("research:e0-empty.ch");
      expect(j.tick_head_seq).toBe(0);

      const sum = runCmd(["node", METRICS_BIN, "sum", bus.base, tokenPath], env);
      expect(sum.code).toBe(0);
      expect(JSON.parse(sum.out.trim()).sum).toBe(0);
    } finally {
      bus.close();
      rmSync(dirname(tokenPath), { recursive: true, force: true });
    }
  });
});

// ── T-SEED（⭐ 判据 5）：空板自播种生效且幂等 ──
//    新建的空 TICK_CHANNEL ⇒ 投 research.clue.v2 种子线索（板面 head_seq 增长）；
//    再次执行 ⇒ 跳过，板面线索**不翻倍**。

describe("T-SEED (criterion 5): empty-board auto-seeding is effective and idempotent", () => {
  it("seeds an empty channel once and does NOT double board clues on repeat", async () => {
    const port = 20000 + Math.floor(Math.random() * 40000);
    const bus = await startFakeBus(port);
    const tokenPath = makeTempToken("TEST_TOKEN\n");
    const CH = "research:e0-regression.index";
    try {
      const created = await fetch(`${bus.base}/v1/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: CH }),
      });
      expect(created.status).toBe(200);

      const env = { ...process.env, AGENT_BUS_URL: bus.base, AGENT_BUS_TOKEN_FILE: tokenPath };
      // 空板 ⇒ 播种
      const r1 = runCmd(
        ["node", SEED_BIN, bus.base, tokenPath, CH, "--clue", "e0 seed clue", "--clue", "second seed clue"],
        env,
      );
      expect(r1.code).toBe(0);
      expect(JSON.parse(r1.out.trim()).seeded).toBe(true);

      const snap1 = JSON.parse(
        runCmd(["node", METRICS_BIN, "snapshot", bus.base, tokenPath, CH], env).out.trim(),
      );
      expect(snap1.tick_head_seq).toBe(2);

      // 已非空 ⇒ 幂等跳过，板面线索不翻倍
      const r2 = runCmd(
        ["node", SEED_BIN, bus.base, tokenPath, CH, "--clue", "e0 seed clue", "--clue", "second seed clue"],
        env,
      );
      expect(r2.code).toBe(0);
      expect(JSON.parse(r2.out.trim()).seeded).toBe(false);

      const snap2 = JSON.parse(
        runCmd(["node", METRICS_BIN, "snapshot", bus.base, tokenPath, CH], env).out.trim(),
      );
      expect(snap2.tick_head_seq).toBe(snap1.tick_head_seq);
    } finally {
      bus.close();
      rmSync(dirname(tokenPath), { recursive: true, force: true });
    }
  });
});

// ── T-VERIFY-TERMINAL（⭐ 判据 4 / attempt 3 final blocker 1+2）：板面真实终态判定 ──
//    ⛔ 终态**不是** drain 的 reason/rounds：drain rounds>=1、head_seq 涨了，只要板面真实
//    termination.state===null（板面未达终态）就必须非零退出。finnal 评审点名：reason='max_rounds'
//    是死锁签名（永不 drained），'drained' 且 termination.state===null 也是"loop 做了事但板面无终态"。
//    板面真实终态从 journal.jsonl（drain_id → index.jsonl → run_dir → 最后一轮 tick run_output）
//    读取——这正是 E0a 想防的 'mock 全绿 ≠ 判据成立' 形状。

describe("T-VERIFY-TERMINAL: board with no real terminal state is flagged even when the loop did work", () => {
  it("loop did work (rounds>=1, head_seq grew) yet board termination.state===null ⇒ non-zero exit naming TERMINAL", () => {
    // max_rounds 死锁签名：drain rounds>=1 且 head_seq 涨，但板面 termination.state 为 null。
    const res = runVerify(
      SNAP(5, 20, { a: 10, b: 10 }),
      SNAP(9, 20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      { termState: null },
    );
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/TERMINAL/);
  });

  it("drain reason 'max_rounds' with rounds>=1 is NOT a terminal state ⇒ non-zero exit", () => {
    const drainId = `drain-${Math.random().toString(36).slice(2)}`;
    const res = runVerify(
      SNAP(5, 20, { a: 10, b: 10 }),
      SNAP(9, 20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      {
        runLog: `${JSON.stringify({ reason: "max_rounds", rounds: 16, ticksByLabel: { tick: 16 }, drain_id: drainId })}\n`,
        termState: null,
        drainId,
      },
    );
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/TERMINAL/);
  });

  it("board reached a real terminal state (termination.state non-null) ⇒ exit 0", () => {
    const res = runVerify(
      SNAP(5, 20, { a: 10, b: 10 }),
      SNAP(9, 20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      { termState: "converged" },
    );
    expect(res.code).toBe(0);
  });

  it("run.stdout.log has no drain summary with drain_id ⇒ cannot read real termination ⇒ non-zero exit naming TERMINAL", () => {
    const res = runVerify(
      SNAP(5, 20, { a: 10, b: 10 }),
      SNAP(9, 20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      PROD(20, { a: 10, b: 10 }),
      { runLog: "some non-json diagnostic line\nand another\n" },
    );
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/TERMINAL/);
  });
});

// ── T-VERIFY-DRAIN（attempt 2 final finding 2）：终态断言必须对**真实驱动产出**成立 ──
//    用假 loop-engine CLI 驱动生产 bin/deep-research-loop.sh，取其**真实 stdout** 当 run.stdout.log，
//    再喂给 bin/e0-verify.sh ⇒ 必须判 0。证明终态断言读的是真实驱动确实发出的 drain 摘要，
//    而不是一份无人发出的手写 termination JSON。

describe("T-VERIFY-DRAIN: terminal assertion holds on real deep-research-loop.sh stdout", () => {
  const LOOP = join(ROOT, "bin", "deep-research-loop.sh");

  function runDriver(env: Record<string, string>): { code: number; out: string; err: string } {
    try {
      const out = execFileSync("bash", [LOOP], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, ...env },
        stdio: ["ignore", "pipe", "pipe"],
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

  it("drain rounds>=1 with real board terminal state on real driver stdout ⇒ e0-verify exits 0 (Z1 reachable)", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0-drain-real-"));
    try {
      mkdirSync(join(dir, "dist", "lib"), { recursive: true });
      mkdirSync(join(dir, "engine-root", "runs", "run-r", "tick-run"), { recursive: true });
      const cli = join(dir, "dist", "cli.js");
      const storeCli = join(dir, "dist", "lib", "store-cli.js");
      const drainJson = JSON.stringify({
        reason: "drained",
        rounds: 1,
        ticksByLabel: { tick: 1 },
        runs_root: join(dir, "engine-root", "runs"),
        drain_id: "test-drain-real",
      });
      writeFileSync(cli, `#!/usr/bin/env node\nconsole.log('${drainJson.replace(/'/g, "\\'")}');\nprocess.exit(0);\n`);
      chmodSync(cli, 0o755);
      writeFileSync(storeCli, "#!/usr/bin/env node\n// no-op\n");
      chmodSync(storeCli, 0o755);
      writeFileSync(
        join(dir, "engine-root", "index.jsonl"),
        JSON.stringify({
          schema: "lei/1",
          kind: "run.start",
          run_id: "tick-run",
          label: "tick",
          fleet: "fleet.yaml",
          caller: "drain",
          run_dir: join(dir, "engine-root", "runs", "run-r", "tick-run"),
          ts: new Date().toISOString(),
          pid: 12345,
          drain_id: "test-drain-real",
          lane: "tick",
          tick: 1,
        }) + "\n",
      );
      // journal.jsonl 含真实 tick run_output（tick-entry --run 的 JSON，含 termination.state）。
      // 这模拟 loop-engine 捕获的 tick 节点 stdout：最后一轮 run_output 的 termination.state 非 null
      // （板面真的到了终态）⇒ e0-verify 的终态断言判过。
      const runOutput = JSON.stringify({
        channelId: "research:test-real",
        messageCount: 1,
        decisions: [],
        writes: 1,
        skipped: 0,
        spawns: [],
        harvestReports: [],
        triageReports: [],
        hasPendingWork: false,
        termination: {
          state: "converged",
          coverage: 1,
          zeroGrowthRounds: 2,
          capHit: false,
        },
      });
      writeFileSync(
        join(dir, "engine-root", "runs", "run-r", "tick-run", "journal.jsonl"),
        `some diagnostic line\n${runOutput}\n`,
      );

      // 驱动生产 deep-research-loop.sh，取真实 stdout 作为 run.stdout.log。
      const driver = runDriver({
        LOOP_ENGINE_CLI: cli,
        LOOP_STORE_CLI: storeCli,
        LOOP_ENGINE_RUNNER: "node",
        LOOP_ENGINE_RUNTIME_ROOT: join(dir, "engine-root"),
        TICK_CHANNEL: "research:test-real",
        RESEARCH_QUESTION: "test research question",
        MAX_WRITES: "96",
      });
      expect(driver.code).toBe(0);
      // 驱动 stdout 确实含 drain 摘要（reason+rounds）。
      expect(driver.out).toMatch(/"reason"\s*:\s*"drained"/);
      expect(driver.out).toMatch(/"rounds"\s*:\s*1/);

      // 把真实 stdout 落成 run.stdout.log，喂给 e0-verify.sh（Z1 成立、Z2 零增长）。
      const runLogPath = join(dir, "run.stdout.log");
      writeFileSync(runLogPath, driver.out);
      writeFileSync(join(dir, "br.json"), JSON.stringify(SNAP(5, 20, { a: 10, b: 10 })));
      writeFileSync(join(dir, "ar.json"), JSON.stringify(SNAP(9, 20, { a: 10, b: 10 })));
      writeFileSync(join(dir, "bp.json"), JSON.stringify(PROD(20, { a: 10, b: 10 })));
      writeFileSync(join(dir, "ap.json"), JSON.stringify(PROD(20, { a: 10, b: 10 })));
      const res2 = runCmd(
        [
          "bash",
          VERIFY_BIN,
          join(dir, "br.json"),
          join(dir, "ar.json"),
          join(dir, "bp.json"),
          join(dir, "ap.json"),
          runLogPath,
        ],
        { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: join(dir, "engine-root") },
      );
      expect(res2.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

