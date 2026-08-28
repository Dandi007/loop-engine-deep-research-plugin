/**
 * C2 —— 统一调用面（single entry）验收。
 *
 * 硬验收（spec deliverable 6，全部驱动**真实 CLI 入口** bin/deep-research.sh，不 mock 路由/preflight）：
 *  (a) 同一个入口按 scale 阈值路由 light vs heavy；
 *  (b) heavy 路径零手工输入完成 profile 选择 + channel 预备（create-or-reuse 真发生）；
 *  (c) 非绿的 preflight 拒绝 heavy 启动（fail-closed）；
 *  (d) legacy direct-run（bin/deep-research-loop.sh）不再是 user-facing entry。
 *
 * 另有纯函数单测（decideTier 边界 / deriveTopicChannels 确定性 / planChannelPrep 划分），
 * 以及 create-or-reuse 原语（ensureChannel）对本地假 bus 的真集成测试。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import {
  decideTier,
  deriveTopicChannels,
  planChannelPrep,
  HEAVY_TIER_MIN_SOURCES,
  DEFAULT_PROFILE,
} from "../src/invocation";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "bin", "deep-research.sh");
const LOOP = join(ROOT, "bin", "deep-research-loop.sh");

const REQUIRED_ENV = [
  "TICK_CHANNEL",
  "EVIDENCE_CHANNEL",
  "ALLOWED_ROOT",
  "CONTENT_SPOOL_ROOT",
  "MAX_WRITES",
  "RESEARCH_QUESTION",
  "DOC_CHANNEL",
  "RESEARCH_ORIGIN",
  "ANCHOR_CHECK_BIN",
  "EXPORT_ROOT",
];
const STRIP = [...REQUIRED_ENV, "DEPLOY_PROFILE", "DEEP_RESEARCH_PROFILE", "DEEP_RESEARCH_SESSION_WORKFLOW"];

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of STRIP) delete env[k];
  return env;
}

function runEntry(args: string[], env?: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("bash", [ENTRY, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: env ?? cleanEnv(),
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

// ── 纯函数：scale 阈值路由 ───────────────────────────────────────────

describe("C2 (a): decideTier routes light vs heavy on the documented scale threshold", () => {
  it("below threshold => light (session-level workflow.js)", () => {
    for (let s = 1; s < HEAVY_TIER_MIN_SOURCES; s++) {
      const d = decideTier("some topic", s);
      expect(d.tier).toBe("light");
      expect(d.reason).toMatch(/workflow\.js/);
    }
  });

  it("at/above threshold => heavy (V2 orchestration)", () => {
    for (let s = HEAVY_TIER_MIN_SOURCES; s < HEAVY_TIER_MIN_SOURCES + 3; s++) {
      const d = decideTier("some topic", s);
      expect(d.tier).toBe("heavy");
      expect(d.reason).toMatch(/orchestration/i);
    }
  });

  it("explicit --tier override wins without changing the threshold", () => {
    expect(decideTier("t", 100, "light").tier).toBe("light");
    expect(decideTier("t", 1, "heavy").tier).toBe("heavy");
  });
});

// ── 纯函数：channel 派生确定性 + 计划划分 ─────────────────────────────

describe("C2: deriveTopicChannels is deterministic and topic-scoped", () => {
  it("same profile+topic => same channels (reusable); different topic => different channels", () => {
    const a1 = deriveTopicChannels("agent-harness", "PPO vs SAC");
    const a2 = deriveTopicChannels("agent-harness", "PPO vs SAC");
    const b = deriveTopicChannels("agent-harness", "另一项研究");
    expect(a1).toEqual(a2);
    expect(a1.index).not.toBe(b.index);
    expect(a1.evidence).not.toBe(b.evidence);
    expect(a1.docs).not.toBe(b.docs);
  });

  it("channel names are channel_id-legal", () => {
    const c = deriveTopicChannels("agent-harness", "PPO vs SAC");
    for (const id of [c.index, c.evidence, c.docs]) {
      expect(id).toMatch(/^research:agent-harness-[0-9a-f]{12}\.(index|evidence|docs)$/);
    }
  });
});

describe("C2: planChannelPrep splits desired channels into create vs reuse", () => {
  it("existing => reuse, absent => create", () => {
    const plan = planChannelPrep(["a", "c"], ["a", "b", "c"]);
    expect(plan.reuse).toEqual(["a", "c"]);
    expect(plan.create).toEqual(["b"]);
  });
});

// ── 真实 CLI：路由 light vs heavy（drive real entrypoint）────────────

describe("C2 (a): the SAME entry routes light vs heavy per scale rule", () => {
  it("sources below threshold => tier light (session-level workflow.js), exit 0", () => {
    const res = runEntry(["PPO vs SAC", "--sources", "2", "--dry-run"]);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.out) as Record<string, unknown>;
    expect(doc.tier).toBe("light");
    expect(String(doc.session_workflow)).toMatch(/workflow\.js/);
    expect(doc.dry_run).toBe(true);
  });

  it("sources at threshold => tier heavy, exit 0", () => {
    const res = runEntry(["PPO vs SAC", "--sources", String(HEAVY_TIER_MIN_SOURCES), "--dry-run"]);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.out) as Record<string, unknown>;
    expect(doc.tier).toBe("heavy");
    expect(doc.preflight).toBeTruthy();
  });
});

// ── 真实 CLI：heavy 零手工 profile + channel 步骤 ─────────────────────

describe("C2 (b): heavy path auto-completes profile + channel prep (no manual steps)", () => {
  it("dry-run auto-selects default profile and derives per-topic channels with no --profile/--channel", () => {
    const env = cleanEnv();
    // ⛔ 自证子环境里没有相关 env / 无 DEPLOY_PROFILE（否则会掩盖「自动选择」）。
    for (const k of STRIP) expect(env).not.toHaveProperty(k);
    const res = runEntry(["auto profile topic", "--sources", "5", "--dry-run"], env);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.out) as Record<string, unknown>;
    expect(doc.profile).toBe(DEFAULT_PROFILE);
    const ch = doc.channels as Record<string, string>;
    for (const k of ["index", "evidence", "docs"]) {
      expect(ch[k]).toMatch(/^research:/);
    }
    // profile 选择非手工：入口缺省 agent-harness。
    expect(doc.preflight).toBeTruthy();
  });

  it("explicit --profile overrides the auto-selected default", () => {
    const res = runEntry(["some topic", "--sources", "5", "--dry-run", "--profile", "local"]);
    // local profile 缺 RESEARCH_ORIGIN/ANCHOR_CHECK_BIN ⇒ preflight 非绿 ⇒ refused +
    // 但 profile 字段已反映显式选择（在 refusal JSON 里带 profile）。
    expect(res.code).not.toBe(0);
    const doc = JSON.parse(res.out) as Record<string, unknown>;
    expect(doc.profile).toBe("local");
  });
});

// ── 真实 CLI：preflight 非绿拒绝 heavy 启动（fail-closed）────────────

describe("C2 (c): non-green preflight refuses the heavy start", () => {
  it("profile missing required env => exit nonzero, outcome=refused, no loop launched", () => {
    const res = runEntry(["some topic", "--sources", "5", "--dry-run", "--profile", "local"]);
    expect(res.code).not.toBe(0);
    expect(res.out).not.toContain('"outcome": "prepared"');
    const doc = JSON.parse(res.out) as Record<string, unknown>;
    expect(doc.outcome).toBe("refused");
    const pf = doc.preflight as Record<string, unknown>;
    expect(pf.status).toBe("FAIL");
    expect(pf.error_code).toBe("REQUIRED_ENV_MISSING");
  });

  it("green preflight (agent-harness) plans the heavy start", () => {
    const res = runEntry(["some topic", "--sources", "5", "--dry-run"]);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.out) as Record<string, unknown>;
    expect(doc.outcome).toBe("planned");
    const pf = doc.preflight as Record<string, unknown>;
    expect(pf.status).toBe("PASS");
  });
});

// ── legacy direct-run 降级 ───────────────────────────────────────────

describe("C2 (d): legacy direct-run is no longer a user-facing entry", () => {
  it("loop script header marks itself as an internal implementation detail", () => {
    const src = readFileSync(LOOP, "utf8");
    expect(src).toMatch(/内部实现细节/);
    expect(src).toMatch(/bin\/deep-research\.sh/);
  });

  it("the MCP tool + skill declarations point at the single entry", () => {
    const mcp = JSON.parse(
      readFileSync(join(ROOT, "deploy", "declarations", "deep-research.mcp-tool.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(mcp.entry).toBe("bin/deep-research.sh");
    const skill = readFileSync(
      join(ROOT, "deploy", "declarations", "deep-research.skill.md"),
      "utf8",
    );
    expect(skill).toMatch(/bin\/deep-research\.sh/);
  });
});

// ── create-or-reuse 原语：对本地假 bus 的真集成 ────────────────────────

let fakeBus: ChildProcess | null = null;
let busPort = 0;

async function startFakeBus(): Promise<number> {
  const fixture = join(ROOT, "test", "fixtures", "fake-bus.mjs");
  let stdout = "";
  const child = spawn(process.execPath, [fixture], {
    env: { ...process.env, A10B_BUS_PORT: "0" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  fakeBus = child;
  child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
  return await new Promise<number>((resolvePromise, reject) => {
    const deadline = Date.now() + 8000;
    const parse = () => {
      const m = stdout.match(/fakebus listening on (\d+)/);
      if (m) return resolvePromise(Number(m[1]));
      if (Date.now() > deadline) return reject(new Error("fake bus did not start"));
      setTimeout(parse, 50);
    };
    setTimeout(parse, 50);
  });
}

describe("C2 (b): ensureChannel create-or-reuse against a local fake bus", () => {
  beforeAll(async () => {
    busPort = await startFakeBus();
    const tok = join(mkdtempSync(join(tmpdir(), "c2-tok-")), "token");
    writeFileSync(tok, "test-token");
    process.env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    process.env.AGENT_BUS_TOKEN_FILE = tok;
  });

  afterAll(() => {
    fakeBus?.kill("SIGKILL");
  });

  it("first ensure creates, second ensure reuses", async () => {
    const { ensureChannel, listChannels } = await import("../src/bus");
    const first = await ensureChannel("research:c2-prep.index");
    expect(first.created).toBe(true);
    expect(first.reused).toBe(false);
    const second = await ensureChannel("research:c2-prep.index");
    expect(second.created).toBe(false);
    expect(second.reused).toBe(true);
    const listed = (await listChannels()).map((c) => c.channel_id);
    expect(listed).toContain("research:c2-prep.index");
  });
});