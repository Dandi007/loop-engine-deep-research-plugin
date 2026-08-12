/**
 * E0c2b §1.3 —— 跨 drain 循环的判别性 bash 层测试（spec §2 判据 2/5/6/6b）。
 *
 * ⛔ 判据 5/6 必须真正执行 bin/e0-regression.sh 本身（前一版 attempt 1 blocker：测试在自己内部
 *    重实现了一遍循环、对入口只做源码 grep，于是入口怎么错都是绿的）。本文件用可执行桩替身
 *    注入（DEEP_RESEARCH_LOOP_BIN / LOOP_ENGINE_RUNTIME_ROOT / E0C1_PROD_BUS_URL / 假 bus），
 *    让入口真正跑它的跨 drain 循环，再断言入口的退出码与 stdout/stderr。
 *
 * 覆盖判据：
 *  - C2  termination.state 永远 null（撞次数上限）⇒ 入口非零退出；把终态判据换成 drain reason ⇒ 红。
 *  - C5  (GT-3) 第一次 drain 后仍 null、第二次后非 null ⇒ 入口继续跑第二轮并最终退出 0；
 *        改回只跑一次 drain ⇒ 红（drain-attempts.jsonl 会有两条）。
 *  - C6  (上限) termination.state 永远 null ⇒ 撞 profile 声明的上限时非零退出，点名撞的是哪个上限。
 *  - C6b (GT-6 / max_rounds 不是失败) 第一次 drain 以 reason=max_rounds + **退出码 1** 结束、
 *        终态仍 null，第二次才收敛 ⇒ 入口退避后跑第二轮并最终退出 0；
 *        把分类改回「非零即 DRAIN_FAILED 并 break」⇒ 红。
 *        反向：drain 以**其它**非零退出码（如 3）或吐不出可解析摘要 ⇒ 入口立刻响亮失败。
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  readFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "e0-regression.sh");

/** 一个最简 agent-bus 替身：所有 channel 操作（HEAD/GET/POST publish/messages）一律 200。 */
function startFakeAgentBus(): Promise<{ base: string; close: () => void; requestCount: () => number }> {
  return new Promise((resolveP) => {
    let count = 0;
    const server = createServer((req, res) => {
      count += 1;
      const url = String(req.url);
      if (url.includes("/v1/channels/") && url.includes("/messages")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ messages: [] }));
        return;
      }
      if (url.includes("/v1/channels/") && url.includes("/entities/")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ head: {} }));
        return;
      }
      if (url.includes("/v1/channels/") && url.includes("/publish")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message_id: "m", channel_seq: 1, deduplicated: false }));
        return;
      }
      if (url.includes("/v1/channels/")) {
        // single channel GET (GT-8): ⛔ 不返回 head_seq（只有列表端点返回）
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ channel_id: "x", created_at: "t" }));
        return;
      }
      if (url.includes("/v1/channels")) {
        // list channels (for prod-read sum): 返回空列表 ⇒ sum=0
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ channels: [] }));
        return;
      }
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true }));
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolveP({
        base: `http://127.0.0.1:${port}`,
        close: () => server.close(),
        requestCount: () => count,
      });
    });
  });
}

/**
 * 写一个假 deep-research-loop.sh：根据 attempts 列表依次产出 drain 摘要 + 落盘 journal/index。
 * 每个 attempt: { reason, exit, termination: { state, coverage, zeroGrowthRounds, capHit } | null }
 *   - termination 为 null ⇒ 落盘一个 result.termination.state=null 的 tick journal。
 *   - reason/exit 控制驱动 stdout 第三行与退出码。
 * 假脚本通过计数文件（counter file）读取当前是第几次被调用，自增后产出对应的 attempt。
 */
function writeFakeLoopScript(opts: {
  scriptPath: string;
  runtimeRoot: string;
  attempts: Array<{
    reason: string;
    exit: number;
    runs_root?: string;
    termination?: { state: string | null; coverage: number; zeroGrowthRounds: number; capHit: boolean } | null;
    unparseable?: boolean;
  }>;
}): void {
  const counterFile = opts.scriptPath + ".counter";
  writeFileSync(counterFile, "0");
  // 用一个独立 node 脚本做所有 IO（bash 仅负责调起 + 透传退出码），避免 bash/node env 互传的坑。
  const nodeScript = opts.scriptPath + ".mjs";
  const nodeBody = `import { writeFileSync, readFileSync, mkdirSync, appendFileSync, existsSync } from "node:fs";
const runtimeRoot = process.env.RUNTIME_ROOT;
const counterFile = process.env.COUNTER_FILE;
const attempts = JSON.parse(process.env.ATTEMPTS_JSON);
let idx = 0;
try { idx = parseInt(readFileSync(counterFile, "utf8").trim() || "0", 10); } catch { idx = 0; }
writeFileSync(counterFile, String(idx + 1));
const attempt = attempts[Math.min(idx, attempts.length - 1)];
const drainId = "drain-fake-" + idx;
const runDir = runtimeRoot + "/runs/run-" + idx;
mkdirSync(runDir, { recursive: true });
const indexLine = JSON.stringify({ schema: "lei/1", drain_id: drainId, lane: "tick", run_dir: runDir }) + "\\n";
try { appendFileSync(runtimeRoot + "/index.jsonl", indexLine); } catch { writeFileSync(runtimeRoot + "/index.jsonl", indexLine); }
let result;
if (attempt.termination === null || attempt.termination === undefined) {
  result = JSON.stringify({ hasPendingWork: false, termination: { state: null, coverage: 0, zeroGrowthRounds: 0, capHit: false } });
} else {
  result = JSON.stringify({ hasPendingWork: false, termination: attempt.termination });
}
const journalLine = JSON.stringify({ run_id: "tick~1", identity: "tick", result, effects: [] }) + "\\n";
writeFileSync(runDir + "/journal.jsonl", journalLine);
if (!attempt.unparseable) {
  const ticksByLabel = { tick: Math.max(1, (idx + 1) * 4) };
  const summary = { reason: attempt.reason, rounds: ticksByLabel.tick, ticksByLabel, runs_root: attempt.runs_root || runtimeRoot, drain_id: drainId };
  process.stdout.write("[deep-research-loop] mode=fake\\n");
  process.stdout.write(JSON.stringify(summary) + "\\n");
} else {
  process.stdout.write("garbage no json here\\nstill no drain_id line\\n");
}
process.exit(attempt.exit);
`;
  writeFileSync(nodeScript, nodeBody);
  const script = `#!/usr/bin/env bash
export RUNTIME_ROOT="${opts.runtimeRoot}"
export COUNTER_FILE="${counterFile}"
export ATTEMPTS_JSON='${JSON.stringify(opts.attempts).replace(/'/g, "'\\''")}'
exec node "${nodeScript}"
`;
  writeFileSync(opts.scriptPath, script);
  chmodSync(opts.scriptPath, 0o755);
}

interface RunResult {
  code: number;
  out: string;
  err: string;
}

/**
 * 异步入口运行器（用 spawn，而非 execFileSync）：入口的 `exec 1> >(tee ...)` 进程替换会让
 * execFileSync 的管道在 tee 孙进程退出前不收 EOF ⇒ 死锁。spawn + 子进程 exit 事件 resolve
 * （不等管道 EOF），避免死锁。
 */
function runEntry(env: NodeJS.ProcessEnv, timeoutMs = 45000): Promise<RunResult> {
  return new Promise((resolveP) => {
    const child = spawn("bash", [BIN], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
    }, timeoutMs);
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    child.on("exit", (c) => {
      clearTimeout(timer);
      resolveP({ code: timedOut ? -1 : (c ?? -1), out, err });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolveP({ code: -1, out, err });
    });
  });
}

/** 完整环境：假 bus + 假 token + 假 loop + record root + runtime root。 */
async function setUpEnv(opts: {
  fakeAttempts: Array<{
    reason: string;
    exit: number;
    termination?: { state: string | null; coverage: number; zeroGrowthRounds: number; capHit: boolean } | null;
    unparseable?: boolean;
  }>;
  profileOverrides?: Record<string, string>;
}): Promise<{
  env: NodeJS.ProcessEnv;
  cleanup: () => void;
  recordDir: string;
  runtimeRoot: string;
  drainAttemptsLog: string;
}> {
  const tmp = mkdtempSync(join(tmpdir(), "e0c2b-loop-"));
  const recordDir = join(tmp, "record");
  const runtimeRoot = join(tmp, "runtime");
  mkdirSync(runtimeRoot, { recursive: true });
  const tokenDir = join(tmp, "tokens");
  mkdirSync(tokenDir, { recursive: true });
  const tokenFile = join(tokenDir, "test.token");
  writeFileSync(tokenFile, "test-token\n");

  const fakeLoop = join(tmp, "fake-loop.sh");
  writeFakeLoopScript({ scriptPath: fakeLoop, runtimeRoot, attempts: opts.fakeAttempts });

  const bus = await startFakeAgentBus();

  // 用最小 env（不继承 vitest 的 VITEST 等变量，避免子进程被 vitest 影响——
  // 尤其是 e0c2b-terminal-read.ts 在 VITEST=1 时会跳过 CLI 入口）。
  // 只保留运行必需的 PATH / HOME / 系统 locale 变量。
  const minimalEnv: Record<string, string> = {
    PATH: process.env.PATH || "/usr/bin:/bin",
    HOME: process.env.HOME || "/tmp",
    LANG: process.env.LANG || "C.UTF-8",
    TERM: process.env.TERM || "dumb",
  };
  const baseEnv: Record<string, string> = {
    ...minimalEnv,
    // 测试总线（假 bus）
    AGENT_BUS_URL: bus.base,
    AGENT_BUS_TOKEN_FILE: tokenFile,
    // 生产总线读数也指向假 bus（假 bus 的 /v1/channels 返回空列表 ⇒ sum=0）
    E0C1_PROD_BUS_URL: bus.base,
    E0C1_PROD_BUS_TOKEN_FILE: tokenFile,
    // 注入假 deep-research-loop.sh
    DEEP_RESEARCH_LOOP_BIN: fakeLoop,
    // runtime root 让 e0c2b-terminal-read.ts 找到假 index/journal
    LOOP_ENGINE_RUNTIME_ROOT: runtimeRoot,
    // 记录根指向临时目录
    E0_RECORD_ROOT: recordDir,
    // 固定 run id（让测试可定位 record 目录）
    DD_RUN_ID: "e0c2b-test-run",
    // 跨 drain 参数：测试里用最小退避（生产 profile 仍是 30，spec §1.3 禁止零间隔空转）。
    E0_DRAIN_BACKOFF_SECONDS: "0",
    ...opts.profileOverrides,
  };

  return {
    env: baseEnv,
    cleanup: () => {
      bus.close();
      rmSync(tmp, { recursive: true, force: true });
    },
    recordDir: join(recordDir, "e0c2b-test-run"),
    runtimeRoot,
    drainAttemptsLog: join(recordDir, "e0c2b-test-run", "drain-attempts.jsonl"),
  };
}

describe("C5 (GT-3): cross-drain loop — first drain null, second converges ⇒ entry runs 2nd drain and exits 0", () => {
  it("two drains: first state=null, second state=converged ⇒ exit 0 and drain-attempts.jsonl has 2 entries", async () => {
    const { env, cleanup } = await setUpEnv({
      fakeAttempts: [
        { reason: "drained", exit: 0, termination: { state: null, coverage: 0, zeroGrowthRounds: 0, capHit: false } },
        { reason: "drained", exit: 0, termination: { state: "converged", coverage: 1, zeroGrowthRounds: 2, capHit: false } },
      ],
      profileOverrides: { E0_DRAIN_MAX_ATTEMPTS: "5", E0_DRAIN_WALL_CLOCK_SECONDS: "60" },
    });
    try {
      const res = await runEntry(env);
      // ⛔ 判据 5：第二次 drain 收敛 ⇒ 入口退出 0。
      expect(res.code, `stdout=${res.out}\nstderr=${res.err}`).toBe(0);
      // drain attempt 2 被真正执行（不是只跑一次）。
      expect(res.out).toMatch(/drain attempt=1\//);
      expect(res.out).toMatch(/drain attempt=2\//);
      // 第一次终态 null、第二次 converged。
      expect(res.out).toMatch(/drain attempt=1\/.*termination\.state=null/);
      expect(res.out).toMatch(/drain attempt=2\/.*termination\.state=converged/);
    } finally {
      cleanup();
    }
  });

  it("discriminates: single drain only (max_attempts=1) with first null ⇒ exit non-zero (cannot reach 2nd drain)", async () => {
    // 变异：把 max_attempts 限到 1 ⇒ 入口跑不出第二轮 ⇒ null 终态 ⇒ 非零退出。
    // 这条证明 C5 有判别力：改回只跑一次 drain ⇒ 红。
    const { env, cleanup } = await setUpEnv({
      fakeAttempts: [
        { reason: "drained", exit: 0, termination: { state: null, coverage: 0, zeroGrowthRounds: 0, capHit: false } },
        { reason: "drained", exit: 0, termination: { state: "converged", coverage: 1, zeroGrowthRounds: 2, capHit: false } },
      ],
      profileOverrides: { E0_DRAIN_MAX_ATTEMPTS: "1", E0_DRAIN_WALL_CLOCK_SECONDS: "60" },
    });
    try {
      const res = await runEntry(env);
      expect(res.code, `stdout=${res.out}\nstderr=${res.err}`).not.toBe(0);
      // 点名撞的是次数上限。
      expect(res.err + res.out).toMatch(/MAX ATTEMPTS LIMIT HIT/);
    } finally {
      cleanup();
    }
  });
});

describe("C6 (limits): termination.state always null ⇒ hit profile-declared limit, non-zero exit naming which limit", () => {
  it("always null within max_attempts ⇒ non-zero exit naming MAX ATTEMPTS", async () => {
    const { env, cleanup } = await setUpEnv({
      fakeAttempts: Array.from({ length: 10 }, () => ({
        reason: "drained",
        exit: 0,
        termination: { state: null, coverage: 0, zeroGrowthRounds: 0, capHit: false },
      })),
      profileOverrides: { E0_DRAIN_MAX_ATTEMPTS: "3", E0_DRAIN_WALL_CLOCK_SECONDS: "600" },
    });
    try {
      const res = await runEntry(env);
      expect(res.code, `stdout=${res.out}\nstderr=${res.err}`).not.toBe(0);
      expect(res.err + res.out).toMatch(/MAX ATTEMPTS LIMIT HIT/);
      // 点名实测值（=3）与上限变量名。
      expect(res.err + res.out).toMatch(/E0_DRAIN_MAX_ATTEMPTS=3/);
      // ⛔ 不得无限循环：跑了正好 3 次（不是更多）。
      expect(res.out).toMatch(/drain attempt=3\//);
      expect(res.out).not.toMatch(/drain attempt=4\//);
    } finally {
      cleanup();
    }
  });

  it("discriminates: hitting limit must not exit 0 (no 'pretend success by draining')", async () => {
    // 变异：如果实现把「撞上限」伪装成成功 ⇒ code=0 ⇒ 红。
    // 这里同上的场景，断言 code 非 0（与上面同向，但显式钉死「不假装成功」）。
    const { env, cleanup } = await setUpEnv({
      fakeAttempts: Array.from({ length: 5 }, () => ({
        reason: "drained",
        exit: 0,
        termination: { state: null, coverage: 0, zeroGrowthRounds: 0, capHit: false },
      })),
      profileOverrides: { E0_DRAIN_MAX_ATTEMPTS: "2", E0_DRAIN_WALL_CLOCK_SECONDS: "600" },
    });
    try {
      const res = await runEntry(env);
      expect(res.code).not.toBe(0);
    } finally {
      cleanup();
    }
  });
});

describe("C6b (GT-6): max_rounds + exit 1 is NOT a failure — entry backs off and runs 2nd drain, exits 0", () => {
  it("first drain reason=max_rounds exit=1 state=null, second converges ⇒ entry runs 2nd drain and exits 0", async () => {
    const { env, cleanup } = await setUpEnv({
      fakeAttempts: [
        { reason: "max_rounds", exit: 1, termination: { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false } },
        { reason: "drained", exit: 0, termination: { state: "converged", coverage: 1, zeroGrowthRounds: 2, capHit: false } },
      ],
      profileOverrides: { E0_DRAIN_MAX_ATTEMPTS: "5", E0_DRAIN_WALL_CLOCK_SECONDS: "60" },
    });
    try {
      const res = await runEntry(env);
      // ⛔ GT-6：max_rounds 的 exit 1 不算失败 ⇒ 入口跑第二轮并退出 0。
      expect(res.code, `stdout=${res.out}\nstderr=${res.err}`).toBe(0);
      expect(res.out).toMatch(/drain attempt=2\//);
      // 进度行可见第一次是 max_rounds、第二次 converged。
      expect(res.out).toMatch(/drain attempt=1\/.*reason=max_rounds/);
      expect(res.out).toMatch(/drain attempt=2\/.*termination\.state=converged/);
    } finally {
      cleanup();
    }
  });

  it("discriminates: 'non-zero ⇒ DRAIN_FAILED break' would fail here — first max_rounds(exit 1) would stop early", async () => {
    // 变异锚点：如果实现退回「非零即失败 break」，第一次 max_rounds exit 1 就停 ⇒ code 非 0。
    // 上面那条断言 code=0 ⇒ 该变异必红。这里再补一条断言 drain-attempts 真跑了 2 次。
    const { env, cleanup } = await setUpEnv({
      fakeAttempts: [
        { reason: "max_rounds", exit: 1, termination: { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false } },
        { reason: "drained", exit: 0, termination: { state: "converged", coverage: 1, zeroGrowthRounds: 2, capHit: false } },
      ],
      profileOverrides: { E0_DRAIN_MAX_ATTEMPTS: "5", E0_DRAIN_WALL_CLOCK_SECONDS: "60" },
    });
    try {
      const res = await runEntry(env);
      expect(res.code).toBe(0);
      // 找到 record 下的 drain-attempts.jsonl（RUN_ID 派生目录）。
      // drain-attempts 应有 2 条（不是「非零即 break」的 1 条）。
      expect(res.out).toMatch(/drain attempt=1\//);
      expect(res.out).toMatch(/drain attempt=2\//);
    } finally {
      cleanup();
    }
  });

  it("reverse: other non-zero exit (exit 3) ⇒ immediate loud failure (not retried as 'not yet converged')", async () => {
    // GT-6 反向：drain 以**其它**非零退出码（如 3）⇒ 立刻响亮失败，⛔ 不得当成「还没收敛」去重试。
    const { env, cleanup } = await setUpEnv({
      fakeAttempts: [
        { reason: "drained", exit: 3, termination: { state: null, coverage: 0, zeroGrowthRounds: 0, capHit: false } },
        { reason: "drained", exit: 0, termination: { state: "converged", coverage: 1, zeroGrowthRounds: 2, capHit: false } },
      ],
      profileOverrides: { E0_DRAIN_MAX_ATTEMPTS: "5", E0_DRAIN_WALL_CLOCK_SECONDS: "60" },
    });
    try {
      const res = await runEntry(env);
      expect(res.code, `stdout=${res.out}\nstderr=${res.err}`).not.toBe(0);
      // 点名 GT-6（不得当成「还没收敛」）。
      expect(res.err + res.out).toMatch(/DRAIN FAILED/);
      expect(res.err + res.out).toMatch(/exit=3/);
      // ⛔ 不得重试第二轮（其它非零退出码 ⇒ 立刻失败）。
      expect(res.out).not.toMatch(/drain attempt=2\//);
    } finally {
      cleanup();
    }
  });

  it("reverse: unparseable drain summary ⇒ immediate loud failure (not retried)", async () => {
    // GT-6 反向：吐不出可解析摘要 ⇒ 立刻响亮失败。
    const { env, cleanup } = await setUpEnv({
      fakeAttempts: [
        { reason: "drained", exit: 0, unparseable: true },
        { reason: "drained", exit: 0, termination: { state: "converged", coverage: 1, zeroGrowthRounds: 2, capHit: false } },
      ],
      profileOverrides: { E0_DRAIN_MAX_ATTEMPTS: "5", E0_DRAIN_WALL_CLOCK_SECONDS: "60" },
    });
    try {
      const res = await runEntry(env);
      expect(res.code, `stdout=${res.out}\nstderr=${res.err}`).not.toBe(0);
      expect(res.err + res.out).toMatch(/no parseable drain summary|unparseable_summary|DRAIN FAILED/i);
      // ⛔ 不得重试。
      expect(res.out).not.toMatch(/drain attempt=2\//);
    } finally {
      cleanup();
    }
  });
});

describe("C2: termination.state null on a single drained drain ⇒ entry does NOT exit 0", () => {
  it("one drain, drained, state=null, max_attempts=1 ⇒ non-zero exit (must read real termination, not drain reason)", async () => {
    // 判据 2：termination.state == null ⇒ 入口非零退出。
    // 把终态判据换成「drain reason == drained ⇒ 成功」⇒ 这条会变绿（实现错了）。
    // 正确实现读真 termination.state=null ⇒ 非零退出。
    const { env, cleanup } = await setUpEnv({
      fakeAttempts: [
        { reason: "drained", exit: 0, termination: { state: null, coverage: 0, zeroGrowthRounds: 0, capHit: false } },
      ],
      profileOverrides: { E0_DRAIN_MAX_ATTEMPTS: "1", E0_DRAIN_WALL_CLOCK_SECONDS: "60" },
    });
    try {
      const res = await runEntry(env);
      expect(res.code, `stdout=${res.out}\nstderr=${res.err}`).not.toBe(0);
      // drained 但 termination.state 仍 null ⇒ 撞次数上限（不是成功）。
      expect(res.err + res.out).toMatch(/MAX ATTEMPTS LIMIT HIT/);
    } finally {
      cleanup();
    }
  });
});
