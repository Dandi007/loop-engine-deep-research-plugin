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
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
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
