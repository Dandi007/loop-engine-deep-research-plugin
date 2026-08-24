/**
 * A10b —— 自然收敛 + 端到端真跑 + 消灭验收命令本身的不确定性（spec §1/§2）。
 *
 * B1 —— 真实 `bin/deep-research-loop.sh` 跑完，drain 输出 `reason === "drained"`（§1.1）。
 * B1-guard —— LOOP_ENGINE_CLI 指向不存在路径 ⇒ 该用例必须响亮失败，绝不静默通过（§2）。
 * B2 —— 以 `research:p02-smoke-1dce60.evidence` 作 EVIDENCE_CHANNEL 真跑，回读该 channel
 *        断言 research.evidence.v2 条数 > 0（§2）；⛔ 不用 vi.stubGlobal 打桩 fetch。
 * B3/B4 —— 判别对：板面非终态 ⇒ 仍续投触发；板面全终态 ⇒ 不投（§2）。
 * B5 —— 同一秒内连续渲染两次，两次 RUN_ROOT 必须不同（§1.2）。
 * B6 —— 并发渲染不互相污染：并发跑 N(≥5) 次渲染，每次读回自己的 fleet.yaml 字段逐次正确（§1.2）。
 * B7a/B7b —— 判别对：只设 DD_RUN_ID ⇒ RUN_ROOT 落在该 id；同时设 ⇒ DD_RUN_ROOT 优先（§1.2）。
 * B10 —— --selfcheck 仍保留且无副作用（exit 0，零网络请求）。
 *
 * B1/B2 是「真实端到端」：真实驱动脚本 + 真实 loop-engine CLI（bun 跑）+ 本地受控 agent-bus
 * （node 起的 127.0.0.1 假 bus，零外网）。⛔ 不打桩 fetch —— 产品代码走真实 HTTP 读一个本地 bus。
 * 依赖缺失（bun / loop-engine worktree / node）必须使 B1/B2 响亮失败，不能将冻结验收降级为 skip。
 */
import { execFile, execFileSync, spawn } from "node:child_process";
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
import { describe, it, expect, afterEach } from "vitest";
import { parse } from "yaml";
import { hasPendingWork } from "../src/tick";
import type { BoardCard, BoardState } from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "bin", "deep-research-loop.sh");
const TICK_MD = join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md");

// ── 真跑所需的外部依赖（spec §5：loop-engine worktree 已备好 / bun 必须）────────

const BUN_CANDIDATES = [process.env.LOOP_ENGINE_RUNNER, join(process.env.HOME ?? "/", ".bun", "bin", "bun")].filter(
  (p): p is string => Boolean(p),
);
function resolveBun(): string | undefined {
  for (const c of BUN_CANDIDATES) {
    if (existsSync(c)) return c;
  }
  return undefined;
}
const LOOP_ENGINE_CLI = "/data/worktrees/loop-engine-v1build/dist/cli.js";

const runningBuses: number[] = [];
afterEach(() => {
  for (const pid of runningBuses.splice(0)) {
    try {
      process.kill(pid);
    } catch {
      /* already gone */
    }
  }
});

function runDriver(argv: string[], env: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("bash", argv, {
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

// A10b —— 异步渲染：用 execFile（非 execFileSync）让 N 次渲染**真正并发**地跑（B6 ⛔ 不得串行化）。
// execFile 只 spawn 子进程即返回，各子进程并行渲染；Promise.all 统一收尾。返回真实退出码，
// 非零时（execFileSync 会抛）也如实带回，保证 B1 的 `expect(code).toBe(0)` 有判别力。
function runDriverAsync(argv: string[], env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  return new Promise((resolve) => {
    execFile(
      "bash",
      argv,
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, ...env },
        maxBuffer: 16 * 1024 * 1024,
      },
      (err, stdout, stderr) => {
        if (err) {
          const e = err as { status?: number };
          resolve({ code: e.status ?? -1, out: String(stdout), err: String(stderr) });
        } else {
          resolve({ code: 0, out: String(stdout), err: String(stderr) });
        }
      },
    );
  });
}

function renderPath(): string {
  return join(ROOT, "bin", "deep-research-loop.sh");
}

function renderFleet(env: NodeJS.ProcessEnv = {}): { triggerStoreDir: string; fleetDir: string } {
  // D1 —— 渲染需要 TICK_CHANNEL（无 profile 且无显式 env ⇒ 响亮失败）；测试统一显式提供。
  // G4a —— 渲染同样需要 RESEARCH_QUESTION（无缺省 ⇒ 响亮失败）；测试统一显式提供。
  const res = runDriver([renderPath(), "--dry-run"], {
    TICK_CHANNEL: "research:v1-test.index",
    RESEARCH_QUESTION: "test research question",
    ...env,
  });
  if (res.code !== 0) throw new Error(`render failed: ${res.err}`);
  const doc = parse(res.out);
  const tickInput = doc.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
  const triggerStoreDir = tickInput?.trigger_store_dir as string;
  // trigger_store_dir == $RUN_ROOT/stores/trigger ⇒ RUN_ROOT = grandparent of stores.
  const fleetDir = dirname(dirname(triggerStoreDir));
  return { triggerStoreDir, fleetDir };
}

async function startFakeBus(seedPath?: string): Promise<number> {
  const fixture = join(ROOT, "test", "fixtures", "fake-bus.mjs");
  let stdout = "";
  const child = spawn(
    process.execPath,
    [fixture],
    {
      env: {
        ...process.env,
        A10B_BUS_PORT: "0",
        ...(seedPath ? { A10B_SEED: seedPath } : {}),
      },
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
  runningBuses.push(child.pid as number);
  child.stdout?.on("data", (chunk: Buffer) => {
    stdout += chunk.toString();
  });
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 5000;
    const check = (port: number) => {
      fetch(`http://127.0.0.1:${port}/v1/channels/_probe`)
        .then((r) => { if (r) resolve(port); })
        .catch(() => {
          if (Date.now() > deadline) reject(new Error("fake bus did not come up (kernel-assigned port)"));
          else setTimeout(() => check(port), 50);
        });
    };
    child.on("error", (err) => reject(err));
    const parsePort = () => {
      const m = stdout.match(/fakebus listening on (\d+)/);
      if (m) {
        const port = Number(m[1]);
        if (port > 0) {
          check(port);
          return;
        }
      }
      if (Date.now() > deadline) {
        reject(new Error("fake bus did not output listening port"));
        return;
      }
      setTimeout(parsePort, 50);
    };
    setTimeout(parsePort, 50);
  });
}

async function readChannel(port: number, channelId: string): Promise<unknown[]> {
  const r = await fetch(`http://127.0.0.1:${port}/v1/channels/${encodeURIComponent(channelId)}/messages?limit=100`);
  const data = (await r.json()) as { messages?: unknown[] };
  return data.messages ?? [];
}

async function runRealE2E(opts: {
  seedPath?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<{ code: number; out: string; err: string; port: number }> {
  const port = await startFakeBus(opts.seedPath);
  const runRoot = mkdtempSync(join(tmpdir(), "a10b-e2e-"));
  const bun = resolveBun()!;
  let code = 0;
  let out = "";
  let err = "";
  try {
    out = execFileSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        AGENT_BUS_URL: `http://127.0.0.1:${port}`,
        LOOP_ENGINE_CLI,
        LOOP_ENGINE_RUNNER: bun,
        // The supplied CLI prefers a machine-global registry whose chain entries
        // are incompatible with this build. Exercise the CLI's bundled registry
        // so these hermetic drain tests do not depend on host deployment state.
        LOOP_ENGINE_MODEL_REGISTRY: join(dirname(LOOP_ENGINE_CLI), "lib", "model-registry.data.json"),
        DD_RUN_ROOT: runRoot,
        // 真实 E2E 的测试板 channel（fake bus 上的字符串，非生产 smoke 板）。B2 把 clue 种在
        // 该 channel，TICK_CHANNEL 须指向它 tick 才读得到（D1 前由脚本缺省值提供同款语义）。
        TICK_CHANNEL: "research:p02-smoke-1dce60",
        RESEARCH_QUESTION: "test research question",
        PATH: `${dirname(bun)}:${process.env.PATH ?? ""}`,
        ...opts.env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (e) {
    const ee = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    code = ee.status ?? -1;
    out = String(ee.stdout ?? "");
    err = String(ee.stderr ?? "");
  }
  rmSync(runRoot, { recursive: true, force: true });
  return { code, out, err, port };
}

function drainResult(out: string): unknown {
  const lines = out.split("\n").filter((l) => l.trim().startsWith("{"));
  const last = lines[lines.length - 1];
  return JSON.parse(last);
}

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    clueId: "clue_1",
    text: "investigate X",
    status: "open",
    depth: 0,
    sources: ["code-local"],
    retries: 0,
    ...over,
  };
}
function state(over: Partial<BoardState> = {}): BoardState {
  return { cards: [], runs: {}, triageInFlight: false, ...over };
}

// ── B1 + B1-guard：真实端到端 drain 必须收敛为 drained ─────────────
// E0c2 GT-10：续投门放宽后（hasPendingWork==true OR (termination.state==null && !capHit)），
// 板面排空后仍需继续 tick 直到终态或 max_rounds，B1/B2 必然变慢（实测 B1≈2.5s, B2≈4.4s）。
// vitest 缺省 testTimeout 5s 在并发负载下不足，此处放宽到 30s 并注明理由；
// ⛔ 不得全局调大 testTimeout 掩盖别处卡死，⛔ 不得改回续投门或 skip/删用例。

describe("B1: real end-to-end drain converges to reason='drained'", () => {
  it("empty terminal board through the real driver drains with reason=drained", { timeout: 30000 }, async () => {
    expect(resolveBun(), "B1 requires bun").toBeTruthy();
    expect(existsSync(LOOP_ENGINE_CLI), "B1 requires the supplied loop-engine worktree").toBe(true);
    const { code, out } = await runRealE2E({});
    expect(code).toBe(0);
    const result = drainResult(out) as { reason?: string };
    expect(result.reason).toBe("drained");
  });
});

describe("B1-guard: dependency-missing B1 must not silently pass", () => {
  it("LOOP_ENGINE_CLI pointing at a missing path ⇒ loud non-zero failure", () => {
    const res = runDriver([SCRIPT], {
      LOOP_ENGINE_CLI: join(tmpdir(), "does-not-exist-loop-engine-cli.js"),
      LOOP_ENGINE_RUNNER: resolveBun() ?? "bun",
      TICK_CHANNEL: "research:v1-test.index",
      RESEARCH_QUESTION: "test research question",
    });
    // ⛔ 不可能是 pass：必须非零 + 响亮点名缺失。
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/missing LOOP_ENGINE_CLI|Refusing/i);
  });
});

// ── B2：真实端到端，收割发布 evidence 并回读常数 > 0 ──────────────

describe("B2: real end-to-end harvest publishes evidence readable back from the channel", () => {
  it("drains and leaves research.evidence.v2 in the evidence channel", { timeout: 30000 }, async () => {
    expect(resolveBun(), "B2 requires bun").toBeTruthy();
    expect(existsSync(LOOP_ENGINE_CLI), "B2 requires the supplied loop-engine worktree").toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "a10b-b2-"));
    const seed = join(dir, "seed.json");
    writeFileSync(
        seed,
        JSON.stringify({
          "research:p02-smoke-1dce60": [
            {
              message_id: "msg_clue_inflight",
              channel_seq: 1,
              kind: "research.clue.v2",
              entity_id: "clue_harvest_1",
              payload: {
                status: "in_flight",
                text: "investigate harvest evidence",
                depth: 0,
                sources: ["code-local"],
                run_id: "run-harvest-1",
              },
              supersedes: "",
            },
          ],
          "board:agent-runs": [
            {
              message_id: "run_exit_1",
              channel_seq: 1,
              kind: "agent.run.exited.v1",
              entity_id: "run-harvest-1",
              payload: { run_id: "run-harvest-1", exit_code: 0 },
              supersedes: "",
            },
            {
              message_id: "worker_result_1",
              channel_seq: 2,
              kind: "worker.result.v1",
              entity_id: "run-harvest-1",
              payload: {
                run_id: "run-harvest-1",
                evidences: [
                  { quote: "q", claim: "c", source: "code", locator: "a", revision: "r" },
                ],
                proposed_clues: [],
                materials: [{ uri: "m1" }],
              },
              supersedes: "",
            },
          ],
          "research:p02-smoke-1dce60.evidence": [],
        }),
    );
    const res = await runRealE2E({
      seedPath: seed,
      env: { EVIDENCE_CHANNEL: "research:p02-smoke-1dce60.evidence" },
    });
    rmSync(dir, { recursive: true, force: true });
    expect(res.out).toContain("drained");
    const msgs = await readChannel(res.port, "research:p02-smoke-1dce60.evidence");
    const evidence = msgs.filter((m) => (m as { kind?: string }).kind === "research.evidence.v2");
    expect(evidence.length).toBeGreaterThan(0);
    // §2.1 —— 跑前跑后消息数增量 ≤ --max-writes（默认 5）。证据 channel 预置为空（head_seq 0），
    //    故增量 == 回读到的 evidence 条数；收割的 evidence+clue 发布都计入预算（src/tick-run.ts）。
    expect(evidence.length).toBeLessThanOrEqual(5);
  });
});

// ── B3 / B4：判别对 —— 板面非终态 ⇒ 续投；全终态 ⇒ 不投 ───────────

function makeFakeTick(values: {
  hasPendingWork: boolean;
  dir: string;
  runnerLog: string;
  terminationState?: string;
}): { tickEntry: string; runner: string; storeDir: string } {
  const tickEntry = join(values.dir, "tick-entry");
  const termState = values.terminationState ?? "null";
  writeFileSync(
    tickEntry,
    `#!/usr/bin/env bash\nprintf '%s\\n' '{"hasPendingWork": ${values.hasPendingWork}, "decisions": [], "termination": {"state": ${termState}, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}'\n`,
  );
  chmodSync(tickEntry, 0o755);
  const runner = join(values.dir, "runner");
  writeFileSync(runner, `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${values.runnerLog}"\n`);
  chmodSync(runner, 0o755);
  const storeDir = join(values.dir, "store");
  mkdirSync(storeDir, { recursive: true });
  return { tickEntry, runner, storeDir };
}

function renderTickMd(values: Record<string, string>, outFile: string): void {
  const tpl = readFileSync(TICK_MD, "utf8");
  const script = tpl.replace(/\{\{([a-z_]+)\}\}/g, (_m, key) => values[key] ?? "");
  writeFileSync(outFile, script);
  chmodSync(outFile, 0o755);
  execFileSync("bash", [outFile], { cwd: ROOT, encoding: "utf8" });
}

// 判别对：B3/B4 只差板面内容（hasPendingWork），其余输入一字不差。
describe("B3: board has a non-terminal clue ⇒ still invests a next trigger", () => {
  it("hasPendingWork true ⇒ tick.md writes one open trigger", () => {
    expect(hasPendingWork(state({ cards: [card({ status: "open" })] }))).toBe(true);
    const dir = mkdtempSync(join(tmpdir(), "a10b-b3-"));
    const log = join(dir, "puts.log");
    const { tickEntry, runner, storeDir } = makeFakeTick({ hasPendingWork: true, dir, runnerLog: log });
    writeFileSync(log, "");
    renderTickMd(
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

describe("B4: board fully terminal ⇒ does not invest (discriminant against B3)", () => {
  it("hasPendingWork false ⇒ tick.md writes no trigger", () => {
    const s = state({
      cards: [card({ status: "explored" }), card({ status: "dropped" }), card({ status: "blocked" })],
    });
    expect(hasPendingWork(s)).toBe(false);
    const dir = mkdtempSync(join(tmpdir(), "a10b-b4-"));
    const log = join(dir, "puts.log");
    const { tickEntry, runner, storeDir } = makeFakeTick({ hasPendingWork: false, dir, runnerLog: log, terminationState: '"converged"' });
    writeFileSync(log, "");
    renderTickMd(
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

// ── B5：同一秒内连续渲染两次，RUN_ROOT 必须不同 ─────────────────────

describe("B5: two renders in the same second yield distinct RUN_ROOT", () => {
  it("two consecutive renders produce different trigger_store_dir (RUN_ROOT)", () => {
    const a = renderFleet();
    const b = renderFleet();
    expect(a.triggerStoreDir).not.toBe(b.triggerStoreDir);
    expect(a.fleetDir).not.toBe(b.fleetDir);
  });
});

// ── B6：并发渲染不互相污染 ───────────────────────────────────────

describe("B6: concurrent renders do not pollute each other", () => {
  it("N>=5 concurrent renders each read back their own fleet.yaml correctly", async () => {
    const N = 6;
    // ⛔ 不得串行化：用 execFile 异步并发 spawn N 个子进程（runDriverAsync），Promise.all 统一收尾，
    //    让几次渲染**真正同时**进行 —— 这正是 §0.2 的竞争场景（vitest 并行下同一批渲染互相覆盖）。
    //    execFileSync 是同步阻塞，串行执行下每个渲染都拿到唯一 RUN_ROOT，读回必然不碰撞，判据零功率。
    const procs = Array.from(
      { length: N },
      () => runDriverAsync([renderPath(), "--dry-run"], { TICK_CHANNEL: "research:v1-test.index", RESEARCH_QUESTION: "test research question" }),
    );
    const results = await Promise.all(procs);
    const parsed = results.map((res) => {
      expect(res.code).toBe(0);
      const doc = parse(res.out);
      const tickInput = doc.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
      const triggerStoreDir = tickInput?.trigger_store_dir as string;
      const fleetDir = dirname(dirname(triggerStoreDir));
      return { triggerStoreDir, fleetDir };
    });
    const distinct = new Set(parsed.map((r) => r.triggerStoreDir));
    expect(distinct.size).toBe(N);
    // 每次读回自己的 fleet.yaml：文件存在，且其 trigger_store_dir 与该次渲染一致（无交叉污染）。
    for (const r of parsed) {
      const fleetFile = join(r.fleetDir, "fleet.yaml");
      expect(existsSync(fleetFile)).toBe(true);
      const doc2 = parse(readFileSync(fleetFile, "utf8"));
      const tick2 = doc2.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
      expect(tick2?.trigger_store_dir).toBe(r.triggerStoreDir);
    }
  });
});

// ── B7a / B7b：DD_RUN_ID / DD_RUN_ROOT 覆盖判别对 ────────────────

describe("B7a: only DD_RUN_ID set ⇒ RUN_ROOT lands on that id", () => {
  it("RUN_ROOT = <plugin>/.runtime/deep-research/<id>", () => {
    const id = `b7a-${Date.now()}-${Math.random().toString(36).slice(2)}`;
    const { triggerStoreDir } = renderFleet({ DD_RUN_ID: id });
    expect(triggerStoreDir).toContain(`/.runtime/deep-research/${id}/stores/trigger`);
  });
});

describe("B7b: both set ⇒ DD_RUN_ROOT wins (discriminant against B7a)", () => {
  it("RUN_ROOT = DD_RUN_ROOT regardless of DD_RUN_ID", () => {
    const runRoot = mkdtempSync(join(tmpdir(), "b7b-root-"));
    const { triggerStoreDir } = renderFleet({ DD_RUN_ID: "ignored-id", DD_RUN_ROOT: runRoot });
    expect(triggerStoreDir).toBe(join(runRoot, "stores", "trigger"));
    rmSync(runRoot, { recursive: true, force: true });
  });
});

// ── B10：--selfcheck 保留且无副作用 ──────────────────────────────

describe("B10: --selfcheck preserved and side-effect free", () => {
  it("exits 0 with ok:true against an unreachable bus (no network)", () => {
    const res = runDriver([join(ROOT, "bin", "tick-entry.sh"), "--selfcheck"], {
      AGENT_BUS_URL: "http://127.0.0.1:1",
    });
    expect(res.code).toBe(0);
    const obj = JSON.parse(res.out);
    expect(obj.ok).toBe(true);
  });
});

// ── B1-guard（收敛成因）：max_nodes 不得是收敛触发器 ─────────────
// 评审 finding：§0.1 的根因是「tick 节点一旦撞 max_nodes 就以非 {halt,drained} 终局结束，claim.complete
// 把它路由回 failure_status:open ⇒ seed 永停在 open ⇒ 永不判已排空」。上一版只把 max_nodes 1→2，
// 那是 limit 调参而非修根因：板面一旦需 ≥2 个 tick pass（done.size >= max_nodes）就重演 max_nodes
// 失败。本测试把「max_nodes 必须是明显非绑定的预算护栏（不是收敛机制）」与「干净完成路由到 done」钉死，
// 任何把 max_nodes 调回 1/2 的回归都会在此被拦截。
describe("B1-guard: convergence is board-state driven, max_nodes is a non-binding budget guard", () => {
  it("workflow limits.max_nodes is high enough to never be the convergence trigger", () => {
    const wf = parse(readFileSync(join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml"), "utf8"));
    const maxNodes = wf.limits?.max_nodes as number;
    // 自然收敛要求每轮循环顶部 done.size < max_nodes，直到板面排空（drain → drained）。
    // max_rounds=16 是真正的失控兜底；max_nodes 必须明显高于单次自然 drain 可能的 pass 数，
    // 使收敛只由板面状态（tick 停止续投）决定，而非撞 max_nodes 提前终局（§0.1 根因）。
    expect(maxNodes).toBeGreaterThanOrEqual(16);
  });
  it("fleet claim.complete routes a clean tick completion to the terminal success status", () => {
    const tpl = readFileSync(join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl"), "utf8");
    // 干净完成（reason=halt/drained）→ success_status（done 终态），绝不回 open。
    expect(tpl).toMatch(/success_status:\s*done/);
    expect(tpl).not.toMatch(/success_status:\s*open/);
    // 失败（reason∉{halt,drained} 的异常终局）才回 open 重投递 —— 这才是根因所在，
    // 且只有在 max_nodes 变成收敛触发器时才会走到该分支。
    expect(tpl).toMatch(/failure_status:\s*open/);
  });
});
