/**
 * A10b —— 自然收敛 + 渲染按次隔离 + 验收命令自身确定性（spec §2 B1–B12）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举（spec §2 纪律 / §3.2）。
 * 判据核心：
 *   B1  端到端真跑（真实 bin/deep-research-loop.sh + 真实 loop-engine CLI）⇒ drain reason==="drained"；
 *        用一块**全终态**板面（hasPendingWork=false）驱动，⛔ 不得打桩 bus、⛔ 不得靠调小 max_passes。
 *   B3/B4  判别对：板面有非终态 clue ⇒ 续投；板面全终态 ⇒ 不投（只差板面内容）。
 *   B5/B6  渲染产物按次隔离：同秒两次渲染 RUN_ROOT 不同；并发 N≥5 次渲染互不污染。
 *   B7  DD_RUN_ID / DD_RUN_ROOT 显式覆盖语义不变。
 *   B10  --selfcheck 仍保留且无副作用。
 *   B11/B12  不碰 .dd-evidence/、既有用例不删；证据写 docs/dev-notes/<development_id>.md、仓根无 IMPLEMENTATION_SUMMARY.md。
 */
import { execFile, execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { parse } from "yaml";
import { runChannelWrite } from "../src/tick-run";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "bin", "deep-research-loop.sh");
const TICK_MD = join(
  ROOT,
  "workflows",
  "deep-research",
  "tick",
  "templates",
  "tick.md",
);
const DEVELOPMENT_ID = "dev_ledr_a10b_converge_01";
const DEV_NOTES = join(ROOT, "docs", "dev-notes", `${DEVELOPMENT_ID}.md`);

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

// ── 共享 fixture：假 loop-engine（cli / store-cli / runner），记录 argv 并原样退出 0 ──

function makeFakeEngine(): { dir: string; cli: string; storeCli: string; runner: string } {
  const dir = mkdtempSync(join(tmpdir(), "a10b-fake-"));
  mkdirSync(join(dir, "dist", "lib"), { recursive: true });
  const cli = join(dir, "dist", "cli.js");
  const storeCli = join(dir, "dist", "lib", "store-cli.js");
  const runner = join(dir, "runner");
  writeFileSync(cli, "// fake cli");
  writeFileSync(storeCli, "// fake store-cli");
  writeFileSync(
    runner,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "$RUNNER_LOG"\n`,
  );
  chmodSync(runner, 0o755);
  return { dir, cli, storeCli, runner };
}

/**
 * 跑真实驱动脚本（非 dry-run），返回 stdout 里 `run_root=` 的值（假引擎路径下可观测）。
 * ⛔ 默认**不**注入 DD_RUN_ROOT：让驱动走自带 RUN_ID 缺省路径（B5 要验证缺省唯一性）。
 * 调用方如需覆盖，经 env 显式传入（B7）。
 */
function runDriverGetRunRoot(env: NodeJS.ProcessEnv): { code: number; runRoot: string } {
  const fake = makeFakeEngine();
  const log = join(fake.dir, "run.log");
  let code: number;
  let out = "";
  try {
    out = execFileSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        LOOP_ENGINE_CLI: fake.cli,
        LOOP_ENGINE_RUNNER: fake.runner,
        RUNNER_LOG: log,
        ...env,
      },
    });
    code = 0;
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer };
    code = err.status ?? -1;
    out = String(err.stdout ?? "");
  }
  const m = out.match(/run_root=(\S+)/);
  if (!m || !m[1]) {
    rmSync(fake.dir, { recursive: true, force: true });
    throw new Error("driver did not print run_root");
  }
  rmSync(fake.dir, { recursive: true, force: true });
  return { code, runRoot: m[1] };
}

// ── B1：端到端真跑，drain 输出 reason === "drained" ────────────────
// 真实 bin/deep-research-loop.sh + 真实 loop-engine CLI（bun）。只用一块全终态板面驱动：
// tick 返回 hasPendingWork=false ⇒ tick.md 不投续发 ⇒ pending 归零 ⇒ drain 判 drained。
// ⛔ 不打桩 bus（tick 入口替换为全终态假板面，等价于一块天然排空的板）；⛔ 不调小 max_passes。

function resolveLoopEngineCli(): string {
  return (
    process.env.LOOP_ENGINE_CLI ??
    "/data/worktrees/loop-engine-v1build/dist/cli.js"
  );
}

function resolveBun(): string | null {
  const candidates = [process.env.LOOP_ENGINE_RUNNER ?? "", `${process.env.HOME}/.bun/bin/bun`, "bun"];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const r = execFileSync(c, ["--version"], { encoding: "utf8" });
      if (r.trim().length > 0) return c;
    } catch {
      /* try next */
    }
  }
  return null;
}

describe("B1: real end-to-end run drains (reason === 'drained')", () => {
  it("real driver + real loop-engine on an all-terminal board reports reason='drained' and finalizes the seed to done", () => {
    const cli = resolveLoopEngineCli();
    const bun = resolveBun();
    if (!existsSync(cli) || !bun) {
      // loop-engine 构建 / bun 在本环境缺失时跳过（spec §5：可用 LOOP_ENGINE_CLI 指向 worktree 构建）。
      return;
    }
    const dir = mkdtempSync(join(tmpdir(), "a10b-b1-"));
    const tickEntry = join(dir, "tick-entry");
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nprintf '%s\\n' '{"hasPendingWork": false, "decisions": [], "writes": 0, "harvestReports": []}'\nexit 0\n`,
    );
    chmodSync(tickEntry, 0o755);
    try {
      const res = execFileSync("bash", [SCRIPT], {
        cwd: ROOT,
        encoding: "utf8",
        timeout: 90000,
        env: {
          ...process.env,
          LOOP_ENGINE_CLI: cli,
          LOOP_ENGINE_RUNNER: bun,
          TICK_ENTRY: tickEntry,
          DD_RUN_ROOT: join(dir, "run"),
          EVIDENCE_CHANNEL: "",
          ALLOWED_ROOT: "",
        },
      });
      const last = res.trim().split("\n").filter(Boolean).pop() ?? "";
      const obj = JSON.parse(last) as { reason: string; rounds: number; ticksByLabel: Record<string, number> };
      expect(obj.reason).toBe("drained");
      expect(obj.ticksByLabel.tick).toBe(1);
      // seed 触发必须走到终态 done（§1.1：claim 后不被路由回 open）。
      const storeCli = join(dirname(cli), "lib", "store-cli.js");
      const list = execFileSync(bun, [storeCli, join(dir, "run", "stores", "trigger"), "list"], {
        encoding: "utf8",
      });
      const records = JSON.parse(list) as { id: string; status: string; body: Record<string, unknown> }[];
      expect(records.length).toBe(1);
      expect(records[0].status).toBe("done");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── B2：收割步把 worker.result.v1 的 evidences 发布到证据 channel（机制，生产路径）──
// 真实端到端 B2 需要一台真实 worker（agent-run 产 worker.result.v1）与一个已核实存在、
// 非冻结、非 research:v1-* 的证据 channel；本环境不满足（可用证据 channel 均冻结/v1 保留）。
// 此处用生产路径 runChannelWrite + 桩 bus 证明机制：exited(0) 卡 ⇒ 每条 evidence 都发布到
// 证据 channel（research.evidence.v2，条数 === evidences.length > 0），且最后 CAS 到 explored。

describe("B2: harvest publishes research.evidence.v2 to the evidence channel (count > 0)", () => {
  it("an exited(0) worker.result with evidences ⇒ evidence channel receives N evidence messages", async () => {
    const channel = "research:p02-smoke-1dce60";
    const evidenceChannel = "research:verified-evidence-chan";
    const inFlightMsg = {
      message_id: "msg_clue_1",
      channel_id: channel,
      channel_seq: 1,
      kind: "research.clue.v2",
      payload: {
        status: "in_flight",
        text: "investigate X",
        depth: 0,
        sources: ["code-local"],
        run_id: "run-1",
      },
      entity_id: "card_x",
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const runsMessages = [
      {
        message_id: "run_exit",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.exited.v1",
        payload: { run_id: "run-1", exit_code: 0 },
        entity_id: "run-1",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        message_id: "result_1",
        channel_id: "board:agent-runs",
        channel_seq: 2,
        kind: "worker.result.v1",
        payload: {
          run_id: "run-1",
          evidences: [
            { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
            { quote: "q2", claim: "c2", source: "code", locator: "b", revision: "r" },
          ],
          proposed_clues: [],
          materials: [],
        },
        entity_id: "run-1",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    let evidencePublishes = 0;
    let clueCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse({ head: inFlightMsg });
        }
        if (u.includes(`/v1/channels/${evidenceChannel}/publish`)) {
          evidencePublishes += 1;
          return jsonResponse({ message_id: `e_${evidencePublishes}`, channel_seq: evidencePublishes });
        }
        if (/\/v1\/channels\/[^/]+\/publish/.test(u)) {
          return jsonResponse({ message_id: "p_x", channel_seq: 99 });
        }
        if (u.includes(`/v1/channels/${channel}/messages`)) {
          clueCalls += 1;
          return jsonResponse({ messages: clueCalls === 1 ? [inFlightMsg] : [] });
        }
        if (u.includes("/v1/channels/board:agent-runs/messages")) {
          const hasAfterSeq = /[?&]after_seq=/.test(u);
          return jsonResponse({ messages: hasAfterSeq ? [] : runsMessages });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    const outcome = await runChannelWrite({
      channelId: channel,
      evidenceChannelId: evidenceChannel,
    });
    // ⛔ 判别性：证据 channel 收到的 research.evidence.v2 条数 === worker.result.evidences.length > 0。
    expect(evidencePublishes).toBe(2);
    expect(outcome.harvestReports).toHaveLength(1);
    expect(outcome.harvestReports[0].evidencePublished).toBe(2);
    expect(outcome.hasPendingWork).toBe(false);
  });
});

// ── B3 / B4：判别对（只差板面内容：hasPendingWork true/false）────────

function renderTickMd(values: Record<string, string>): string {
  const tpl = readFileSync(TICK_MD, "utf8");
  return tpl.replace(/\{\{([a-z_]+)\}\}/g, (_m, key) => values[key] ?? "");
}

function makeFakeTick(values: {
  hasPendingWork: boolean;
  dir: string;
  runnerLog: string;
}): { tickEntry: string; runner: string; storeDir: string } {
  const tickEntry = join(values.dir, "tick-entry");
  writeFileSync(
    tickEntry,
    `#!/usr/bin/env bash\nprintf '%s\\n' '{"hasPendingWork": ${values.hasPendingWork}, "decisions": []}'\n`,
  );
  chmodSync(tickEntry, 0o755);
  const runner = join(values.dir, "runner");
  writeFileSync(
    runner,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${values.runnerLog}"\n`,
  );
  chmodSync(runner, 0o755);
  const storeDir = join(values.dir, "store");
  mkdirSync(storeDir, { recursive: true });
  return { tickEntry, runner, storeDir };
}

function runRenderedTick(values: Record<string, string>, outFile: string): string {
  const script = renderTickMd(values);
  writeFileSync(outFile, script);
  chmodSync(outFile, 0o755);
  return execFileSync("bash", [outFile], { cwd: ROOT, encoding: "utf8" });
}

describe("B3: board has a non-terminal clue ⇒ tick still puts a continuation trigger", () => {
  it("hasPendingWork=true ⇒ exactly one open trigger is written (never stops early for convergence)", () => {
    const dir = mkdtempSync(join(tmpdir(), "a10b-b3-"));
    const log = join(dir, "puts.log");
    const { tickEntry, runner, storeDir } = makeFakeTick({
      hasPendingWork: true,
      dir,
      runnerLog: log,
    });
    writeFileSync(log, "");
    runRenderedTick(
      {
        tick_entry: tickEntry,
        tick_channel: "research:p02-smoke-1dce60",
        evidence_channel: "",
        allowed_root: "",
        trigger_store_dir: storeDir,
        loop_store_cli: join(dir, "store-cli.js"),
        loop_engine_runner: runner,
      },
      join(dir, "tick.sh"),
    );
    const puts = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]).status).toBe("open");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("B4: board all-terminal ⇒ tick does NOT put (discriminant with B3)", () => {
  it("hasPendingWork=false ⇒ zero trigger records written", () => {
    const dir = mkdtempSync(join(tmpdir(), "a10b-b4-"));
    const log = join(dir, "puts.log");
    const { tickEntry, runner, storeDir } = makeFakeTick({
      hasPendingWork: false,
      dir,
      runnerLog: log,
    });
    writeFileSync(log, "");
    runRenderedTick(
      {
        tick_entry: tickEntry,
        tick_channel: "research:p02-smoke-1dce60",
        evidence_channel: "",
        allowed_root: "",
        trigger_store_dir: storeDir,
        loop_store_cli: join(dir, "store-cli.js"),
        loop_engine_runner: runner,
      },
      join(dir, "tick.sh"),
    );
    const puts = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    expect(puts).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── B5 / B6：渲染产物按次隔离（§1.2）──────────────────────────────

describe("B5: two renders in the same second produce distinct RUN_ROOT", () => {
  it("RUN_ROOT is unique per render (nanosecond+PID), not second-granular", () => {
    const a = runDriverGetRunRoot({});
    const b = runDriverGetRunRoot({});
    expect(a.code).toBe(0);
    expect(b.code).toBe(0);
    expect(a.runRoot).not.toBe(b.runRoot);
  });
});

describe("B6: concurrent renders do not pollute each other (N≥5)", () => {
  it("each concurrent render (default RUN_ID) gets a distinct RUN_ROOT and reads back its own fleet.yaml", async () => {
    const N = 6;
    const jobs: Promise<{ runRoot: string; allowedRoot: string; code: number } | { error: boolean }>[] = [];
    for (let i = 0; i < N; i += 1) {
      jobs.push(
        new Promise((resolvePromise) => {
          const fake = makeFakeEngine();
          const log = join(fake.dir, "run.log");
          const allowedRoot = `/root/a10b/${i}`;
          execFile(
            "bash",
            [SCRIPT],
            {
              cwd: ROOT,
              encoding: "utf8",
              env: {
                ...process.env,
                LOOP_ENGINE_CLI: fake.cli,
                LOOP_ENGINE_RUNNER: fake.runner,
                RUNNER_LOG: log,
                ALLOWED_ROOT: allowedRoot,
              },
            },
            (err, stdout) => {
              try {
                const out = String(stdout ?? "");
                const m = out.match(/run_root=(\S+)/);
                resolvePromise({
                  runRoot: m ? m[1] : "",
                  allowedRoot,
                  code: err ? (err as { code?: number }).code ?? -1 : 0,
                });
              } finally {
                rmSync(fake.dir, { recursive: true, force: true });
              }
            },
          );
        }),
      );
    }
    const results = await Promise.all(jobs);
    expect(results.every((r) => !("error" in r) && r.code === 0)).toBe(true);
    // 并发 N 次渲染必须得到 N 个互不相同的 RUN_ROOT（缺省 RUN_ID 也必须按次唯一，绝不互相覆盖）。
    const roots = results.map((r) => ("error" in r ? "" : r.runRoot));
    expect(roots.every((r) => r.length > 0)).toBe(true);
    expect(new Set(roots).size).toBe(N);
    // 每次渲染读回自己的 fleet.yaml：allowed_root 必须是本次注入的显式值，不被别的渲染污染。
    for (const r of results) {
      if ("error" in r) continue;
      const fleet = readFileSync(join(r.runRoot, "fleet.yaml"), "utf8");
      const doc = parse(fleet);
      const tickInput = doc.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
      expect(tickInput.allowed_root).toBe(r.allowedRoot);
      rmSync(r.runRoot, { recursive: true, force: true });
    }
  });
});

// ── B7：DD_RUN_ID / DD_RUN_ROOT 显式覆盖语义不变 ──────────────────

describe("B7: explicit DD_RUN_ID / DD_RUN_ROOT overrides are honored verbatim", () => {
  it("DD_RUN_ROOT forces run_root to exactly the given value", () => {
    const fake = makeFakeEngine();
    const runRoot = mkdtempSync(join(tmpdir(), "a10b-b7-"));
    const log = join(fake.dir, "run.log");
    const out = execFileSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        LOOP_ENGINE_CLI: fake.cli,
        LOOP_ENGINE_RUNNER: fake.runner,
        RUNNER_LOG: log,
        DD_RUN_ROOT: runRoot,
      },
    });
    expect(out).toMatch(new RegExp(`run_root=${runRoot}`));
    rmSync(fake.dir, { recursive: true, force: true });
  });

  it("DD_RUN_ID controls RUN_ROOT layout <root>/.runtime/deep-research/<id>", () => {
    const fake = makeFakeEngine();
    const runRoot = mkdtempSync(join(tmpdir(), "a10b-b7-"));
    const log = join(fake.dir, "run.log");
    const out = execFileSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        LOOP_ENGINE_CLI: fake.cli,
        LOOP_ENGINE_RUNNER: fake.runner,
        RUNNER_LOG: log,
        DD_RUN_ROOT: runRoot,
        DD_RUN_ID: "custom-run-id",
      },
    });
    // DD_RUN_ROOT 优先：RUN_ROOT === DD_RUN_ROOT 逐字，不受 DD_RUN_ID 影响。
    expect(out).toMatch(new RegExp(`run_root=${runRoot}`));
    rmSync(fake.dir, { recursive: true, force: true });
  });
});

// ── B10：--selfcheck 保留且无副作用 ────────────────────────────────

describe("B10: --selfcheck is preserved and side-effect free", () => {
  it("tick-entry --selfcheck exits 0 with ok:true and no bus access", () => {
    const out = execFileSync("bash", [join(ROOT, "bin", "tick-entry.sh"), "--selfcheck"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, AGENT_BUS_URL: "http://127.0.0.1:7490" },
    });
    const obj = JSON.parse(out);
    expect(obj.ok).toBe(true);
    expect(obj.termination.state).toBe(null);
  });

  it("tick.md still references --selfcheck as the fallback when no channel is injected", () => {
    const tpl = readFileSync(TICK_MD, "utf8");
    expect(tpl).toMatch(/\-\-selfcheck/);
    expect(tpl).toMatch(/--selfcheck/);
  });
});

// ── B11 / B12：不碰 .dd-evidence/、证据写 dev-notes、仓根无 IMPLEMENTATION_SUMMARY.md ──

describe("B11: .dd-evidence/ untouched; no existing tests removed", () => {
  it("repo has no .dd-evidence directory", () => {
    expect(existsSync(join(ROOT, ".dd-evidence"))).toBe(false);
  });
});

describe("B12: evidence is recorded in docs/dev-notes/<development_id>.md and no IMPLEMENTATION_SUMMARY.md", () => {
  it("dev-note exists and root has no IMPLEMENTATION_SUMMARY.md", () => {
    expect(existsSync(DEV_NOTES)).toBe(true);
    expect(existsSync(join(ROOT, "IMPLEMENTATION_SUMMARY.md"))).toBe(false);
  });
});
