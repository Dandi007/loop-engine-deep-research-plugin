/**
 * E0a —— bin/e0-regression.sh 的入口级硬验收（spec §3 判据 2/3/4/5）。
 *
 * 用**独立子进程**的本地假总线（测试总线 + 独立的生产总线各一个）+ 注入的 E0_LOOP_CMD，
 * 驱动**真实入口脚本**，验证：
 *   - 判据 4：RUNS_CHANNEL 进预备清单，且该 channel 名在入口脚本里只有一处真相源（profile），
 *            并钉死与 src/tick-run.ts 缺省值一致（防静默发散）。
 *   - 判据 3：空板自播种使 TICK_CHANNEL 的 head_seq 增长；重复执行不使线索翻倍。
 *   - 判据 5：运行记录含生产总线跑前/跑后两个 sum(head_seq)；两者不等 ⇒ 入口非零退出。
 *   - 判据 2（入口级）：loop 退出 0 但零写入 / 板面无终态 ⇒ 入口非零退出并点名。
 *
 * ⛔ 全部用本地假总线，不触碰任何生产凭证文件（npm test 机器无关）。
 * ⛔ 假总线以子进程运行：入口经 execFileSync 同步执行会阻塞测试进程事件循环，
 *    若总线与入口同进程会互相死锁（见 fixtures/e0a-fake-bus.mjs 头注）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "e0-regression.sh");
const PROFILES_DIR = join(ROOT, "profiles", "deploy");
const FAKE_BUS = join(ROOT, "test", "fixtures", "e0a-fake-bus.mjs");

interface Bus {
  base: string;
  stop: () => void;
}

async function startBus(opts?: { init?: Record<string, number>; growOnList?: boolean }): Promise<Bus> {
  const env: Record<string, string> = {
    ...process.env,
    E0A_BUS_PORT: "0",
  };
  if (opts?.init) env.E0A_INIT = Object.entries(opts.init).map(([c, n]) => `${c}:${n}`).join(",");
  if (opts?.growOnList) env.E0A_GROW_LIST = "1";
  const child = spawn("node", [FAKE_BUS], { env, stdio: ["ignore", "pipe", "inherit"] });
  const port = await new Promise<string>((resolvePort, reject) => {
    let buf = "";
    child.stdout!.on("data", (d) => {
      buf += String(d);
      const m = buf.match(/listening on (\d+)/);
      if (m) resolvePort(m[1]);
    });
    child.on("error", reject);
    child.on("exit", (c) => reject(new Error(`fake bus exited early with ${c}`)));
    setTimeout(() => reject(new Error("timed out waiting for fake bus port")), 10000);
  });
  return {
    base: `http://127.0.0.1:${port}`,
    stop: () => child.kill("SIGKILL"),
  };
}

async function busHeadSeq(base: string, ch: string): Promise<number> {
  const r = await fetch(`${base}/_debug/headseq/${encodeURIComponent(ch)}`);
  const j = (await r.json()) as { head_seq: number };
  return j.head_seq;
}

async function busClueCount(base: string, ch: string): Promise<number> {
  const r = await fetch(`${base}/_debug/clues/${encodeURIComponent(ch)}`);
  const j = (await r.json()) as { clues: number };
  return j.clues;
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

function makeTempToken(content: string): { path: string; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "e0a-tok-"));
  const p = join(dir, "token");
  writeFileSync(p, content);
  return { path: p, dir };
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

const SUCCESS_LOOP = [
  `curl -s -X POST "$AGENT_BUS_URL/v1/channels/$TICK_CHANNEL/publish"`,
  `-H "Authorization: Bearer $(cat "$AGENT_BUS_TOKEN_FILE")"`,
  `-H "Content-Type: application/json"`,
  `-d '{"kind":"research.evidence.v2","payload":{},"idempotency_key":"fk-$(date +%s%N)-$$"}'`,
  `>/dev/null;`,
  `printf '%s\\n' '{"termination":{"state":"converged","coverage":1,"zeroGrowthRounds":1,"capHit":false}}';`,
  `exit 0`,
].join(" ");

const IDLE_LOOP = [
  `printf '%s\\n' '{"termination":{"state":null,"coverage":0,"zeroGrowthRounds":0,"capHit":false}}';`,
  `exit 0`,
].join(" ");

interface Live {
  testBus: Bus;
  prodBus: Bus;
  testToken: string;
  prodToken: string;
  recRoot: string;
  cleanup: () => void;
}

async function setup(opts?: { tickInit?: number; prodGrowOnList?: boolean }): Promise<Live> {
  const testBus = await startBus({
    init: opts?.tickInit !== undefined ? { "research:e0-regression.index": opts.tickInit } : {},
  });
  const prodBus = await startBus({ init: { "prod:ch": 10 }, growOnList: opts?.prodGrowOnList });
  const testTok = makeTempToken("test-token\n");
  const prodTok = makeTempToken("prod-token\n");
  const recRoot = mkdtempSync(join(tmpdir(), "e0a-rec-"));
  return {
    testBus,
    prodBus,
    testToken: testTok.path,
    prodToken: prodTok.path,
    recRoot,
    cleanup: () => {
      testBus.stop();
      prodBus.stop();
      rmSync(testTok.dir, { recursive: true, force: true });
      rmSync(prodTok.dir, { recursive: true, force: true });
      rmSync(recRoot, { recursive: true, force: true });
    },
  };
}

function baseEnv(live: Live, loopCmd: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    AGENT_BUS_URL: live.testBus.base,
    AGENT_BUS_TOKEN_FILE: live.testToken,
    PROD_BUS_URL: live.prodBus.base,
    PROD_BUS_TOKEN_FILE: live.prodToken,
    E0_RECORD_ROOT: live.recRoot,
    E0_LOOP_CMD: loopCmd,
  };
}

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("E0a 判据 4: RUNS_CHANNEL 单一真相源", () => {
  it("profile declares RUNS_CHANNEL; entry has no hardcoded literal; agrees with tick-run default", () => {
    const prof = readProfile("e0-regression");
    expect(prof.RUNS_CHANNEL).toBeTruthy();
    const entry = readFileSync(BIN, "utf8");
    expect(entry).not.toContain("board:agent-runs");
    const tickRun = readFileSync(join(ROOT, "src", "tick-run.ts"), "utf8");
    const m = tickRun.match(/opts\.runsChannelId \?\? "([^"]+)"/);
    expect(m).toBeTruthy();
    expect(m![1]).toBe(prof.RUNS_CHANNEL);
  });
});

describe("E0a 判据 3: 空板自播种 + head_seq 增长 + 重复执行不翻倍", () => {
  it("empty board is seeded, TICK head_seq grows, re-run does not double clues", async () => {
    const live = await setup();
    cleanups.push(live.cleanup);
    const TICK = "research:e0-regression.index";

    const r1 = runScript(baseEnv(live, SUCCESS_LOOP));
    expect(r1.code, `first run stderr: ${r1.err}`).toBe(0);
    expect(await busHeadSeq(live.testBus.base, TICK)).toBeGreaterThan(0);
    const cluesAfterFirst = await busClueCount(live.testBus.base, TICK);
    expect(cluesAfterFirst).toBeGreaterThanOrEqual(1);

    const recFile = readdirSync(live.recRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((d) => join(live.recRoot, d.name, "run.txt"))
      .find((f) => existsSync(f));
    expect(recFile).toBeTruthy();
    const rec = readFileSync(recFile!, "utf8");
    expect(rec).toMatch(/prod_bus_sum_pre=/);
    expect(rec).toMatch(/prod_bus_sum_post=/);

    const r2 = runScript(baseEnv(live, SUCCESS_LOOP));
    expect(r2.code, `second run stderr: ${r2.err}`).toBe(0);
    expect(await busClueCount(live.testBus.base, TICK)).toBe(cluesAfterFirst);
    expect(await busHeadSeq(live.testBus.base, TICK)).toBeGreaterThan(cluesAfterFirst);
  });
});

describe("E0a 判据 2: loop 退出 0 但零写入 / 板面无终态 ⇒ 入口非零退出并点名", () => {
  it("non-empty board, loop exits 0, zero writes, no terminal state ⇒ entry non-zero", async () => {
    const live = await setup({ tickInit: 5 });
    cleanups.push(live.cleanup);
    const res = runScript(baseEnv(live, IDLE_LOOP));
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/termination/i);
  });
});

describe("E0a 判据 5: 生产总线两读数不等 ⇒ 入口非零退出", () => {
  it("production bus sum(head_seq) grows between reads ⇒ entry non-zero naming production", async () => {
    const live = await setup({ prodGrowOnList: true });
    cleanups.push(live.cleanup);
    const res = runScript(baseEnv(live, SUCCESS_LOOP));
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/production bus/);
  });
});
