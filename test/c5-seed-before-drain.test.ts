/**
 * C5-fix —— 统一 heavy entry 在 drain 前播种（empty board → worker spawn + harvest）。
 *
 * 根因（spec C5）：统一 heavy entry 只往 trigger store 写 {"seed":true}、从不调用既有播种路径
 * （src/tick-seed.ts / tick-entry --seed），于是 loop 第一轮 tick 面对空板 ⇒ 零 spawn、
 * 零证据、自然 drain（pipeline_drained）。本测试驱动**真实**入口与 tick（不 mock spawn），
 * 钉死以下三个判据：
 *
 *  (a) 非 dry-run 的 heavy entry 在起 loop drain 之前，把 >=1 条非空 research.clue.v2
 *      卡发进 research index channel（spec deliverable 1）。
 *  (b) 至少一个 worker 被真实 spawn，且其结果被收割成证据（evidence 带合法 anchor，
 *      spec deliverable 2）。
 *  (c) 判别性：删掉播种调用 / 把线索文本变空白 ⇒ 对应测试变红。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { deriveSeedClues } from "../src/invocation";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = join(ROOT, "bin", "deep-research.sh");

// ── 假 bus（复刻 c2-invocation.test.ts 的受控本地 bus，零外网）────────────

async function startFakeBus(): Promise<{ port: number; child: ChildProcess }> {
  const fixture = join(ROOT, "test", "fixtures", "fake-bus.mjs");
  let stdout = "";
  const child = spawn(process.execPath, [fixture], {
    env: { ...process.env, A10B_BUS_PORT: "0" },
    stdio: ["ignore", "pipe", "ignore"],
  });
  child.stdout?.on("data", (c: Buffer) => (stdout += c.toString()));
  const port = await new Promise<number>((resolvePromise, reject) => {
    const deadline = Date.now() + 8000;
    const parse = () => {
      const m = stdout.match(/fakebus listening on (\d+)/);
      if (m) return resolvePromise(Number(m[1]));
      if (Date.now() > deadline) return reject(new Error("fake bus did not start"));
      setTimeout(parse, 50);
    };
    setTimeout(parse, 50);
  });
  return { port, child };
}

async function readChannel(port: number, channelId: string): Promise<Array<Record<string, unknown>>> {
  const resp = await fetch(`http://127.0.0.1:${port}/v1/channels/${channelId}/messages`);
  if (!resp.ok) return [];
  const data = (await resp.json()) as { messages?: Array<Record<string, unknown>> };
  return Array.isArray(data.messages) ? data.messages : [];
}

let fakeBus: ChildProcess | null = null;
let busPort = 0;
let tokenFile = "";

beforeAll(async () => {
  const started = await startFakeBus();
  busPort = started.port;
  fakeBus = started.child;
  tokenFile = join(mkdtempSync(join(tmpdir(), "c5-tok-")), "token");
  writeFileSync(tokenFile, "test-token");
});

afterAll(() => {
  fakeBus?.kill("SIGKILL");
  rmSync(tokenFile, { force: true });
});

function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of [
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
    "DEPLOY_PROFILE",
    "DEEP_RESEARCH_PROFILE",
    "DEEP_RESEARCH_SESSION_WORKFLOW",
  ]) {
    delete env[k];
  }
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

// ── (a) 非 dry-run heavy entry 在 drain 前播种 >=1 research.clue.v2 ────────

describe("C5 (a): heavy entry seeds research.clue.v2 to the index before the loop drains", () => {
  it("non-dry-run heavy entry publishes >=1 non-empty research.clue.v2 to the index channel", async () => {
    const topic = "PPO vs SAC";
    const env = cleanEnv();
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.AGENT_BUS_TOKEN_FILE = tokenFile;
    const recordFile = join(mkdtempSync(join(tmpdir(), "c5-a-")), "loop-env.txt");
    env.DEEP_RESEARCH_LOOP_SCRIPT = join(ROOT, "test", "fixtures", "loop-recorder.sh");
    env.LOOP_RECORD_FILE = recordFile;

    const { deriveTopicChannels: dtc } = await import("../src/invocation");
    const index = dtc("agent-harness", topic).index;

    const res = runEntry([topic, "--sources", "5"], env);
    expect(res.code).toBe(0);
    const doc = JSON.parse(res.out) as Record<string, unknown>;
    expect(doc.tier).toBe("heavy");
    expect(doc.outcome).toBe("prepared");
    // ⛔ 判别性：播种失败会静默掉这个字段 ⇒ 删掉播种调用即变红。
    expect(doc.seeded_clues).toBeGreaterThanOrEqual(1);

    const msgs = await readChannel(busPort, index);
    const clues = msgs.filter((m) => m.kind === "research.clue.v2");
    expect(clues.length).toBeGreaterThanOrEqual(1);
    // ⛔ 每张卡文本非空、status open —— 空白文本会让 worker 零证据（spec C5 review bar）。
    for (const c of clues) {
      const payload = c.payload as Record<string, unknown>;
      expect(typeof payload.text).toBe("string");
      expect((payload.text as string).trim().length).toBeGreaterThan(0);
      expect(payload.status).toBe("open");
    }
  });
});

// ── (b) 真实 tick：真实 spawn worker + 收割成 evidence（带合法 anchor）────

describe("C5 (b): a real tick spawns a worker and harvests its result into evidence", () => {
  it("seeded code-local clue ⇒ worker spawned ⇒ evidence with a valid anchor", async () => {
    // 假 worker：真实子进程，读 --run-id，把 exited(0) + worker.result.v1 发上 board:agent-runs。
    const workerDir = mkdtempSync(join(tmpdir(), "c5-worker-"));
    const workerBin = join(workerDir, "agent-run");
    writeFileSync(
      workerBin,
      `#!/usr/bin/env node
const argv = process.argv.slice(2);
let runId = "";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--run-id") { runId = argv[i + 1] ?? ""; i++; }
}
const bus = process.env.AGENT_BUS_URL;
async function post(kind, payload) {
  const res = await fetch(bus + "/v1/channels/board:agent-runs/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kind, payload, idempotency_key: kind + "-" + runId }),
  });
  if (!res.ok) { console.error("worker publish failed", res.status); process.exit(1); }
}
(async () => {
  await post("agent.run.exited.v1", { run_id: runId, exit_code: 0 });
  await post("worker.result.v1", {
    run_id: runId,
    evidences: [{
      quote: "route-materialize-then-spawn is performed by dispatch()",
      claim: "dispatch() performs route-materialize-then-spawn",
      source: "code",
      locator: "src/dispatch.ts",
      revision: "abcd1234efgh5678",
      range: "L734",
    }],
    proposed_clues: [],
    materials: [],
  });
  process.exit(0);
})();
`,
    );
    chmodSync(workerBin, 0o755);

    // 受控环境：测试进程自身就是 runChannelWrite 的宿主（经动态 import 读环境）。
    process.env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    process.env.AGENT_BUS_TOKEN_FILE = tokenFile;
    process.env.AGENT_RUN_BIN = workerBin;

    const allowedRoot = mkdtempSync(join(tmpdir(), "c5-repo-"));
    const channelId = "research:c5.index";
    const evidenceChannelId = "research:c5.evidence";

    const { runSeedClues } = await import("../src/tick-seed");
    await runSeedClues(channelId, [
      { text: "investigate dispatch() route-materialize-then-spawn", sources: ["code-local"] },
    ]);

    const { runChannelWrite } = await import("../src/tick-run");
    const workerCmd = workerBin;

    // tick 1：open → CAS in_flight → 真实 spawn 假 worker；worker 退出前已把 result 发上 bus。
    const first = await runChannelWrite({
      channelId,
      evidenceChannelId,
      allowedRoot,
      workerCmd,
      maxWrites: 20,
    });
    expect(first.spawns).toHaveLength(1);
    expect(first.spawns[0].spawned).toBe(true);
    expect(first.spawns[0].role).toBe("dr-worker-code-local");

    // tick 2：读到 exited(0) + worker.result.v1 ⇒ 收割成 evidence。
    const second = await runChannelWrite({
      channelId,
      evidenceChannelId,
      allowedRoot,
      workerCmd,
      maxWrites: 20,
    });
    expect(second.harvestReports.length).toBeGreaterThanOrEqual(1);

    const evidenceMsgs = await readChannel(busPort, evidenceChannelId);
    const evidences = evidenceMsgs.filter((m) => m.kind === "research.evidence.v2");
    expect(evidences.length).toBeGreaterThanOrEqual(1);
    const anchor = (evidences[0].payload as Record<string, unknown>).anchor as string;
    // ⛔ 合法 anchor：<source>://<locator>@<revision>#<range>。
    expect(anchor).toBe("code://src/dispatch.ts@abcd1234efgh5678#L734");

    rmSync(workerDir, { recursive: true, force: true });
    rmSync(allowedRoot, { recursive: true, force: true });
    delete process.env.AGENT_RUN_BIN;
  }, 30000);
});

// ── (c) 判别性：删播种 / 空白线索文本 ⇒ 变红 ──────────────────────────────

describe("C5 (c): discriminative — removing seeding or blanking the clue text breaks the tests", () => {
  it("deriveSeedClues yields one non-blank sub-question per source (blanking ⇒ red)", () => {
    const topic = "PPO vs SAC";
    const clues = deriveSeedClues(topic, 5);
    // 一一对应：5 个 source ⇒ 5 张卡。
    expect(clues).toHaveLength(5);
    // 每条文本非空、嵌入 topic（占位/空白会被拦下）。
    for (const c of clues) {
      expect(c.text.trim().length).toBeGreaterThan(0);
      expect(c.text).toContain(topic);
    }
    // 首条恒为 code-local（可派发，无任意源依赖）。
    expect(clues[0].sources).toEqual(["code-local"]);
  });

  it("deriveSeedClues maps source types from the closed enum (role-dispatchable)", () => {
    const clues = deriveSeedClues("some topic", 6);
    const seen = clues.map((c) => c.sources[0]);
    expect(seen).toEqual([
      "code-local",
      "code-remote",
      "wiki",
      "feishu",
      "web-search",
      "content",
    ]);
    for (const c of clues) {
      // 每条 sources 单个枚举值，非空 ⇒ role 映射可达。
      expect(c.sources).toEqual([c.sources[0]]);
      expect(c.sources[0].trim().length).toBeGreaterThan(0);
    }
  });

  it("runSeedClues rejects a blank sub-question text (a worker would yield zero evidence)", async () => {
    const { runSeedClues, SeedError } = await import("../src/tick-seed");
    await expect(
      runSeedClues("research:c5-blank.index", [
        { text: "   ", sources: ["code-local"] },
      ]),
    ).rejects.toThrow(SeedError);
    await expect(
      runSeedClues("research:c5-blank.index", [
        { text: "   ", sources: ["code-local"] },
      ]),
    ).rejects.toThrow(/non-empty/);
  });

  it("runSeedClues rejects an empty sources list (structurally blocked on the real board)", async () => {
    const { runSeedClues, SeedError } = await import("../src/tick-seed");
    await expect(
      runSeedClues("research:c5-emptysrc.index", [
        { text: "a real sub-question", sources: [] },
      ]),
    ).rejects.toThrow(SeedError);
    await expect(
      runSeedClues("research:c5-emptysrc.index", [
        { text: "a real sub-question", sources: [] },
      ]),
    ).rejects.toThrow(/--source|sources/);
  });

  it("single source seeds the research question itself as the one sub-question", () => {
    const clues = deriveSeedClues("The research topic", 1);
    expect(clues).toHaveLength(1);
    expect(clues[0].text).toBe("The research topic");
    expect(clues[0].sources).toEqual(["code-local"]);
  });
});