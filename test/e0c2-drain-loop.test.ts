/**
 * E0c2 §1.3 / §2 判据 5,6 —— 跨 drain 循环（GT-3）+ 上限保护。
 *
 * 判据 5（GT-3 判别性）：构造「第一次 drain 后 termination.state 仍 null、第二次后非 null」⇒
 *   入口**继续跑第二轮并最终退出 0**；改回只跑一次 drain ⇒ 测试变红。
 * 判据 6（上限判别性）：termination.state 永远为 null ⇒ 撞到 profile 声明的上限时非零退出，
 *   且点名撞的是哪个上限（drain 次数或墙钟）；⛔ 不得无限循环。
 *
 * 测试分三层：
 *   A. 逻辑层：用 readTerminationFromDrain 模拟跨 drain 的循环判定（判别性在于循环本身）。
 *   B. 源码层：验证 bin/e0-regression.sh 真的包含循环结构、上限检查、退避、每轮记录。
 *   C. 入口执行层（评审 blocker 修复）：真跑 bin/e0-regression.sh 的跨 drain 循环——
 *      用假 bus / 假 loop-engine CLI / 预置 journal 驱动入口的真实 bash 循环，
 *      断言判据 5（第二轮后非 null ⇒ 退出 0）与判据 6（永远 null ⇒ 撞上限非零退出并点名）。
 */
import { describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTerminationFromDrain } from "../src/e0c2-termination-read";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const E0_SCRIPT = join(ROOT, "bin", "e0-regression.sh");
const DRIVER_SCRIPT = join(ROOT, "bin", "deep-research-loop.sh");

function makeDrainRuntime(testDir: string, drainId: string, state: string | null): string {
  const runDir = join(testDir, "runtime", "runs", drainId);
  mkdirSync(runDir, { recursive: true });
  const termJson = JSON.stringify({
    hasPendingWork: false,
    termination: { state, coverage: state === null ? 0 : 1, zeroGrowthRounds: state === null ? 1 : 2, capHit: false },
  });
  writeFileSync(
    join(runDir, "journal.jsonl"),
    JSON.stringify({ run_id: "tick~1", identity: "tick", result: termJson }) + "\n",
  );
  return runDir;
}

function appendIndexEntry(runtimeRoot: string, drainId: string, runDir: string): void {
  const indexPath = join(runtimeRoot, "index.jsonl");
  const entry = JSON.stringify({ drain_id: drainId, lane: "tick", run_dir: runDir }) + "\n";
  const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  writeFileSync(indexPath, existing + entry);
}

/**
 * 镜像 bin/e0-regression.sh 的 RUN_SEGMENT 派生（sha256(run_id)[:16]）+ TICK_CHANNEL 拼装
 * （`research:<RESEARCH_PROFILE_BASE>-<segment>.index`，RESEARCH_PROFILE_BASE=e0 来自 profile）。
 * 用于让假 bus 知道入口本轮会去读哪个 channel 的 head_seq（列表端点）。
 */
const TEST_RUN_ID = "e0c2-entry-test";
const TEST_TICK_CHANNEL = (() => {
  const segment = createHash("sha256").update(TEST_RUN_ID).digest("hex").slice(0, 16);
  return `research:e0-${segment}.index`;
})();
// 假 bus 为 tick channel 在列表端点报告的 head_seq。选一个非 0 的真实数值（7），
// 让断言能区分「真从列表端点读到 7」与「凑合的 0 / 单 channel GET 取不到的 N/A」。
const TEST_TICK_HEAD_SEQ = 7;

// ── 逻辑层：跨 drain 循环判定 ──────────────────────────────────────────────

describe("§2 判据 5 (GT-3): first drain null, second drain non-null ⇒ loop must continue", () => {
  it("first drain state==null, second drain state==converged ⇒ loop reaches 2nd drain and succeeds", () => {
    const testDir = mkdtempSync(join(tmpdir(), "e0c2-loop5-"));
    try {
      const runtimeRoot = join(testDir, "runtime");
      mkdirSync(join(runtimeRoot, "runs"), { recursive: true });

      // drain 1: state=null（worker 还没返回，板面无进展）
      const runDir1 = makeDrainRuntime(testDir, "drain-1", null);
      // drain 2: state=converged（worker 返回后收割，终态达成）
      const runDir2 = makeDrainRuntime(testDir, "drain-2", "converged");

      writeFileSync(join(runtimeRoot, "index.jsonl"), "");
      appendIndexEntry(runtimeRoot, "drain-1", runDir1);
      appendIndexEntry(runtimeRoot, "drain-2", runDir2);

      const summary1 = JSON.stringify({ reason: "max_rounds", drain_id: "drain-1" });
      const summary2 = JSON.stringify({ reason: "drained", drain_id: "drain-2" });

      // 模拟入口的循环逻辑
      const states: (string | null)[] = [];
      const summaries = [summary1, summary2];
      for (const s of summaries) {
        const r = readTerminationFromDrain(s, runtimeRoot);
        states.push(r.state);
        if (r.state !== null) break; // 成功收尾
        // 否则退避后继续下一轮
      }

      // ⛔ 判据 5 核心：循环在第一次 null 后继续到第二次，第二次非 null ⇒ 成功。
      expect(states).toEqual([null, "converged"]);
      // 判别性：改回只跑一次 drain ⇒ states 只会是 [null] ⇒ 永远不会到 "converged" ⇒ 变红。
      expect(states[states.length - 1]).toBe("converged");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe("§2 判据 6 (limits): state never non-null ⇒ must hit limit and fail (no infinite loop)", () => {
  it("all drains return null ⇒ loop hits attempt limit without infinite spin", () => {
    const testDir = mkdtempSync(join(tmpdir(), "e0c2-loop6-"));
    try {
      const runtimeRoot = join(testDir, "runtime");
      mkdirSync(join(runtimeRoot, "runs"), { recursive: true });
      writeFileSync(join(runtimeRoot, "index.jsonl"), "");

      // 模拟永远 null 的 drain（比 maxAttempts 多一些，验证循环在 maxAttempts 停而非遍历全部）
      const maxAttempts = 3;
      for (let i = 1; i <= 5; i++) {
        const runDir = makeDrainRuntime(testDir, `drain-${i}`, null);
        appendIndexEntry(runtimeRoot, `drain-${i}`, runDir);
      }

      let attemptsUsed = 0;
      let finalState: string | null = "never-ran";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attemptsUsed = attempt;
        const summary = JSON.stringify({ drain_id: `drain-${attempt}` });
        const r = readTerminationFromDrain(summary, runtimeRoot);
        finalState = r.state;
        if (r.state !== null) break;
      }

      // ⛔ 判据 6 核心：永远 null ⇒ 撞 maxAttempts 上限、非零退出（循环里 finalState 仍 null）
      expect(finalState).toBeNull();
      expect(attemptsUsed).toBe(maxAttempts); // 在上限停，不是遍历全部 5 个
      // 判别性：上限被设成无穷大 ⇒ 循环不会在有限步停 ⇒ 该测试无法完成 ⇒ 变红
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ── 入口层：验证真实脚本包含循环结构与上限保护 ─────────────────────────────

describe("§2 判据 5,6 entry-level: e0-regression.sh contains cross-drain loop with profile-declared limits", () => {
  it("e0-regression.sh has a drain loop that breaks on non-null termination state", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    // 判别性：改回只跑一次 drain ⇒ while : / break 消失 ⇒ 变红
    expect(script).toMatch(/while\s*:/);
    expect(script).toMatch(/break/);
  });

  it("e0-regression.sh checks all three profile-declared limits (backoff, wall, attempts)", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    // ⛔ 三个上限都必须由 profile 声明（不在脚本里写死）
    expect(script).toMatch(/E0_DRAIN_BACKOFF_SECONDS/);
    expect(script).toMatch(/E0_DRAIN_MAX_WALL_SECONDS/);
    expect(script).toMatch(/E0_DRAIN_MAX_ATTEMPTS/);
    // 缺失任何一个 ⇒ REFUSING to start（spec §1.3）
    expect(script).toMatch(/REFUSING to start.*E0_DRAIN_BACKOFF_SECONDS/);
    expect(script).toMatch(/REFUSING to start.*E0_DRAIN_MAX_WALL_SECONDS/);
    expect(script).toMatch(/REFUSING to start.*E0_DRAIN_MAX_ATTEMPTS/);
    // 三个值都必须是正整数（⛔ 不得零间隔空转）
    expect(script).toMatch(/positive integer/);
  });

  it("e0-regression.sh names which limit was hit on failure (drain count or wall-clock)", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    expect(script).toMatch(/hit drain count limit/);
    expect(script).toMatch(/hit wall-clock limit/);
    // 失败时退出非 0
    expect(script).toMatch(/_LOOP_FINAL_EXIT=3/);
  });

  it("e0-regression.sh backs off between drains (not zero-interval spinning)", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    // ⛔ 退避量级与 worker 真实耗时相称（sleep DRAIN_BACKOFF），不是零间隔
    expect(script).toMatch(/sleep.*DRAIN_BACKOFF/);
    expect(script).toMatch(/backing off/);
  });

  it("e0-regression.sh reads termination via e0c2-termination-read.ts (GT-2 path, not drain reason)", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    // §1.1：终态取真值用 e0c2-termination-read.ts（GT-2 路径），⛔ 不用 drain reason 凑合
    expect(script).toMatch(/e0c2-termination-read/);
    expect(script).toMatch(/Refusing to fall back to drain reason/);
  });

  it("e0-regression.sh appends every drain attempt to drain-attempts.jsonl (not just the last)", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    // ⛔ 每轮的 runs_root/reason/终态都追加进运行记录，不只留最后一轮
    expect(script).toMatch(/drain-attempts\.jsonl/);
    // 进度行：第几轮 / drain reason / termination.state / head_seq
    expect(script).toMatch(/termination\.state=/);
    expect(script).toMatch(/tick_head_seq=/);
  });
});

describe("§2 判据 5 (GT-3): deep-research-loop.sh puts a seed trigger unconditionally (no unevidenced `list open` contract)", () => {
  it("driver does NOT depend on an unevidenced `list open` store-cli subcommand (judging 8: E0c1 behavior preserved)", () => {
    // 评审 major 修复（attempt 1 final REJECT）：上一版在 put 前加了 `loop-store list open` 门，
    //   但 `list` 子命令在 spec §0 GT 与 dev-notes 里都无实测依据（只有 put 与 claim open done tick
    //   被记录为已测量）。若真实 store-cli 无 list，每次调用（含生产 agent-harness 路径）都会 exit 3，
    //   regress E0c1 行为（判据 8）。该门只被返回 "[]" 的假 runner 满足——正是 §0「为观察不到的产物
    //   发明契约、再写 fixture 满足它」的形状。
    //   判别性：把 list 门加回来 ⇒ 这两个断言变红（list open / REFUSING 重新出现）。
    const driver = readFileSync(DRIVER_SCRIPT, "utf8");
    // ⛔ 驱动不得调 list 子命令（unevidenced contract）。匹配实际调用形态（runner 调 store-cli 时带 list），
    //   而非注释文字。
    expect(driver).not.toMatch(/\$LOOP_STORE_CLI.*\blist\b/);
    expect(driver).not.toMatch(/"\$TRIGGER_STORE_DIR"\s+(list|open)/);
    expect(driver).not.toMatch(/failed to (list|enumerate) open triggers/);
    expect(driver).not.toMatch(/skipping seed/);
    // ✅ 驱动无条件 put 一条 open seed 触发（E0c1 单一证据源契约）。
    expect(driver).toMatch(/"\$LOOP_ENGINE_RUNNER" "\$LOOP_STORE_CLI" "\$TRIGGER_STORE_DIR" put/);
    // put payload 含 status:open + body:{seed:true}（bash 转义引号，故用宽松匹配）。
    expect(driver).toMatch(/status.*open.*body.*\{.*seed.*true.*\}/);
  });
});

// ── 入口执行层（评审 blocker 修复：真跑 bin/e0-regression.sh 的跨 drain 循环）──────────
//
// 评审 blocker（attempt 1 final REJECT）：原判据 5/6 测试在测试内部 for-loop 调
//   readTerminationFromDrain，从不执行 bin/e0-regression.sh 的 bash 循环。入口层只做源码 grep。
//   ⇒ §1.1 那个 brace-free 正则 blocker 在该套件下永远不会被发现（正是 §0「用 fixture 证明契约」的形状）。
//   这里补一组**真跑入口**的判别性测试：用假 bus + 假 loop-engine CLI + 预置 journal 驱动入口真实 bash 循环。

/**
 * 假 bus：接受任意 channel GET/POST（channel 预备 / publish / messages 读），返回最小 200 JSON。
 *
 * 评审 major 修复（attempt 2 final REJECT）：原假 bus 对**所有**端点（含单 channel GET）一律返回
 *   `{ok:true, head_seq:0, messages:[]}`——正是真机该端点不含 head_seq 的那个端点。这掩盖了
 *   `bin/e0-regression.sh:_read_tick_head_seq` 从单 channel GET 取 head_seq 的 blocker（真机该端点
 *   根本没有 head_seq，恒 N/A）。判据 5 的入口执行用例又从不断言 head_seq 是真实数值 ⇒
 *   「head_seq 恒 N/A」全绿通过——与 attempt 1 被驳回的「用 fixture 证明契约、不跑真实取值路径」同族。
 *
 * 本假 bus 严格复刻真机两个 channel 端点的字段集（src/bus.ts GT-1 逐字）：
 *   - `GET /v1/channels`（列表端点）→ 含 head_seq（GT-1：head_seq 只在这里）。
 *   - `GET /v1/channels/<id>`（单 channel GET）→ ⛔ 不含 head_seq（GT-1：字段集为 channel_id/
 *     closed_at/created_at/.../visibility，无 head_seq）。
 * 这样判据 5 的入口执行用例真跑 `_read_tick_head_seq` 时走的是**列表端点**取 head_seq；
 * 若实现退化为读单 channel GET，会读到 undefined ⇒ 进度行/记录里 head_seq 退化为
 * HEAD_SEQ_READ_FAILED，断言会变红（判别性）。
 *
 * @param tickChannelHeadSeq 列表端点为 tick channel 报告的 head_seq（默认 7，一个非 0 的真实数值，
 *   让断言能区分「真读到」与「凑合的 0」）。
 */
function startFakeBus(tickChannelId: string, tickChannelHeadSeq = 7): Promise<{ base: string; close: () => void }> {
  return new Promise((r) => {
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      // GET /v1/channels（列表端点，prod-read 与 tick_head_seq 读取都用它）：列出 tick channel，
      // 带真实 head_seq（GT-1：列表端点是 head_seq 的唯一来源，连空 channel 也以 head_seq:0 列出）。
      if ((url === "/v1/channels" || url.startsWith("/v1/channels?")) && req.method !== "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ channels: [{ channel_id: tickChannelId, head_seq: tickChannelHeadSeq }] }));
        return;
      }
      // POST /v1/channels（建 channel）：返回 ok。
      if (url === "/v1/channels" && req.method === "POST") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      // POST .../publish：返回 publish 形状（seed 用）。
      if (url.endsWith("/publish")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message_id: "m", channel_seq: 1, deduplicated: false }));
        return;
      }
      // GET 单 channel / messages：⛔ 复刻真机字段集（**不含 head_seq**，GT-1）。
      //   若实现退化为从单 channel GET 取 head_seq，会读到 undefined（不会得到 0 或 7）。
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          channel_id: tickChannelId,
          closed_at: null,
          created_at: "2026-08-12T00:00:00Z",
          default_lease_ms: 60000,
          delivery_mode: "fanout",
          max_attempts: 5,
          metadata: {},
          owner_agent_id: "uther",
          refs_required: 0,
          visibility: "private",
        }),
      );
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      r({ base: `http://127.0.0.1:${port}`, close: () => server.close() });
    });
  });
}

/**
 * 搭一套驱动入口跑到 drain 循环所需的假环境：
 *   - 假 loop-engine CLI：每次被 drain 调用时打印一条 drain 摘要 JSON（drain_id 按 invocation 递增）。
 *   - 假 store-cli：no-op（put 落盘无关紧要；deep-research-loop.sh 只检查它存在）。
 *   - 假 runner：bash，直接 exec node 跑假 CLI（让 deep-research-loop.sh 的 put/drain 都走 runner）。
 *   - LOOP_ENGINE_RUNTIME_ROOT：预置 index.jsonl + 每个 drain_id 对应的 journal.jsonl，
 *     让 src/e0c2-termination-read.ts 按 states 序列读出每轮的 termination.state。
 *
 * states: 每一轮 drain 对应的 termination.state（null 或 converged/capped/partial）。
 *   假 CLI 第 i 次被调打印 drain_id=`drain-<i>`；预置 journal 让该 drain_id 读到 states[i-1]。
 */
function setupEntryEnv(opts: {
  states: (string | null)[];
  busBase: string;
  /** 覆盖默认上限（判据 6 用小值让测试在有限时间内撞上限）。 */
  maxAttempts?: number;
  maxWall?: number;
  backoff?: number;
}): {
  dir: string;
  cli: string;
  storeCli: string;
  runner: string;
  runtimeRoot: string;
  tokenFile: string;
  recordRoot: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "e0c2-entry-"));
  mkdirSync(join(dir, "dist", "lib"), { recursive: true });
  const cli = join(dir, "dist", "cli.js");
  const storeCli = join(dir, "dist", "lib", "store-cli.js");

  // 假 loop-engine CLI：argv 形如 `<runner> <cli> drain <fleet> --label deep-research`。
  // 每次被调（drain）打印第 N 条 drain 摘要，drain_id=drain-<N>（N 由文件计数）。
  // 摘要形状照抄 spec §0 GT-1（含嵌套 ticksByLabel 对象——正是上一版 brace-free 正则匹配不到的形状）。
  const counterFile = join(dir, "drain-counter");
  writeFileSync(counterFile, "0");
  writeFileSync(
    cli,
    `#!/usr/bin/env node\n` +
      `const fs = require("fs");\n` +
      `// 仅在 drain 调用时打印摘要（put 由 store-cli 处理；这里只处理 cli.js 的 drain）。\n` +
      `const n = parseInt(fs.readFileSync(${JSON.stringify(counterFile)}, "utf8"), 10) + 1;\n` +
      `fs.writeFileSync(${JSON.stringify(counterFile)}, String(n));\n` +
      `const drainId = "drain-" + n;\n` +
      `// 照抄 GT-1 的嵌套形状：ticksByLabel 是嵌套对象，drain_id 在其后。\n` +
      `console.log(JSON.stringify({ reason: "drained", rounds: 1, ticksByLabel: { tick: 1 }, runs_root: ${JSON.stringify(join(dir, "runs"))}, drain_id: drainId }));\n` +
      `process.exit(0);\n`,
  );
  chmodSync(cli, 0o755);

  // 假 store-cli：no-op（deep-research-loop.sh 的 put 只需 exit 0）。
  writeFileSync(storeCli, "#!/usr/bin/env node\n// no-op\n");
  chmodSync(storeCli, 0o755);

  // 假 runner：直接用 node 跑被给的 CLI 脚本（让 put/drain 都经 runner，F4 同款）。
  const runner = join(dir, "runner");
  writeFileSync(
    runner,
    `#!/usr/bin/env bash\n` +
      `exec node "$@"\n`,
  );
  chmodSync(runner, 0o755);

  // 预置 runtime root：index.jsonl 列出每个 drain_id 的 lane 条目；每个 run_dir 下 journal.jsonl
  // 含一条 identity=="tick" 的 result（termination.state = states[i]）。
  const runtimeRoot = join(dir, "runtime");
  mkdirSync(join(runtimeRoot, "runs"), { recursive: true });
  const indexLines: string[] = [];
  opts.states.forEach((state, i) => {
    const drainId = `drain-${i + 1}`;
    const runDir = join(runtimeRoot, "runs", drainId);
    mkdirSync(runDir, { recursive: true });
    const termJson = JSON.stringify({
      hasPendingWork: false,
      termination: {
        state,
        coverage: state === null ? 0 : 1,
        zeroGrowthRounds: state === null ? 1 : 2,
        capHit: false,
      },
    });
    writeFileSync(
      join(runDir, "journal.jsonl"),
      JSON.stringify({ run_id: "tick~1", identity: "tick", result: termJson }) + "\n",
    );
    indexLines.push(JSON.stringify({ drain_id: drainId, lane: "tick", run_dir: runDir }));
  });
  writeFileSync(join(runtimeRoot, "index.jsonl"), indexLines.join("\n") + "\n");

  // 测试 token 文件（入口 AGENT_BUS_TOKEN_FILE 读它；不能落 /data/agent-bus/ 下，否则护栏拒）。
  const tokenFile = join(dir, "token");
  writeFileSync(tokenFile, "FAKE_TEST_TOKEN");

  const recordRoot = join(dir, "e0-records");
  mkdirSync(recordRoot, { recursive: true });

  return { dir, cli, storeCli, runner, runtimeRoot, tokenFile, recordRoot };
}

function runEntry(env: NodeJS.ProcessEnv): Promise<{ code: number; out: string; err: string }> {
  // 用 spawn（异步）而非 execFileSync：入口会 curl 假 bus，node 的 http server 只在事件循环里处理请求，
  // execFileSync/spawnSync 会阻塞事件循环 ⇒ curl 永远收不到响应 ⇒ 死锁。
  return new Promise((resolvePromise) => {
    const child = spawn("bash", [E0_SCRIPT], {
      cwd: ROOT,
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => { out += d; });
    child.stderr.on("data", (d) => { err += d; });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      resolvePromise({ code: -1, out, err: err + "\n<timeout: killed>" });
    }, 60000);
    // 用 close（不是 exit）：入口用 `exec 1> >(tee ...)` 把 fd 喂给后台 tee 子进程，
    // bash 退出后 tee 还在刷缓冲；close 事件在所有 stdio 流关闭后才触发，确保收齐全部输出。
    child.on("close", (code) => {
      clearTimeout(timer);
      resolvePromise({ code: code ?? -1, out, err });
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolvePromise({ code: -1, out, err });
    });
  });
}

/** 组装跑入口所需的完整 env（profile 默认 e0-regression，但用小上限覆盖 E0_DRAIN_*）。 */
function entryEnv(opts: {
  states: (string | null)[];
  busBase: string;
  maxAttempts: number;
  maxWall: number;
  backoff: number;
}): NodeJS.ProcessEnv {
  const setup = setupEntryEnv({ states: opts.states, busBase: opts.busBase });
  return {
    // 保留 PATH / HOME（node / vite-node / bash 可解析）。
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    // 测试总线（假 bus）：护栏放行（不指向 7490，token 不在 /data/agent-bus/ 下）。
    AGENT_BUS_URL: opts.busBase,
    AGENT_BUS_TOKEN_FILE: setup.tokenFile,
    // 生产总线读数也指向假 bus（返回 head_seq=0 的最小 JSON，sum=0）。
    E0C1_PROD_BUS_URL: opts.busBase,
    E0C1_PROD_BUS_TOKEN_FILE: setup.tokenFile,
    // 记录根 → 临时目录（不在 /data/loop-engine/e0-runs 下留垃圾）。
    E0_RECORD_ROOT: setup.recordRoot,
    // loop-engine 假 CLI / 假 store-cli / 假 runner。
    LOOP_ENGINE_CLI: setup.cli,
    LOOP_STORE_CLI: setup.storeCli,
    LOOP_ENGINE_RUNNER: setup.runner,
    // 终态读取的 runtime root（预置了 index.jsonl + journal.jsonl）。
    LOOP_ENGINE_RUNTIME_ROOT: setup.runtimeRoot,
    // 跨 drain 上限（用小值，让判据 6 在有限时间内撞上限；判据 5 用 2 轮就够）。
    E0_DRAIN_BACKOFF_SECONDS: String(opts.backoff),
    E0_DRAIN_MAX_WALL_SECONDS: String(opts.maxWall),
    E0_DRAIN_MAX_ATTEMPTS: String(opts.maxAttempts),
    // 固定 run id（便于断言记录目录里的文件名）。
    DD_RUN_ID: "e0c2-entry-test",
  };
}

describe("§2 判据 5 (GT-3) entry-execution: first drain null, second drain non-null ⇒ entry exits 0", () => {
  it("entry's real bash loop runs drain 1 (null), backs off, runs drain 2 (converged) ⇒ exit 0", async () => {
    const bus = await startFakeBus(TEST_TICK_CHANNEL, TEST_TICK_HEAD_SEQ);
    try {
      // ⛔ 判据 5 核心：真跑 bin/e0-regression.sh 的跨 drain 循环。
      //   states=[null, "converged"]：drain 1 读到 null（继续），drain 2 读到 converged（收尾）。
      //   评审 blocker：原测试只在测试里 for-loop 调 readTerminationFromDrain，从不执行入口的 bash 循环；
      //   这里真跑，断言入口确实跑了两轮 drain（drain-1 与 drain-2 的 stdout 落盘文件都存在）且退出 0。
      const env = entryEnv({
        states: [null, "converged"],
        busBase: bus.base,
        maxAttempts: 5,
        maxWall: 120,
        backoff: 1,
      });
      const res = await runEntry(env);
      expect(res.code, `stdout: ${res.out}\nstderr: ${res.err}`).toBe(0);

      // 入口确实跑了第二轮 drain（判据 5 判别性核心：改回只跑一次 drain ⇒ drain-2 文件不存在 ⇒ 变红）。
      const recordDir = join(env.E0_RECORD_ROOT!, "e0c2-entry-test");
      expect(existsSync(join(recordDir, "drain-1.stdout.log"))).toBe(true);
      expect(existsSync(join(recordDir, "drain-2.stdout.log"))).toBe(true);

      // 进度行点名 converged（第二轮的 termination.state）。
      expect(res.out).toMatch(/termination\.state=converged/);
      // drain-attempts.jsonl 记了两轮（不只最后一轮）。
      const attempts = readFileSync(join(recordDir, "drain-attempts.jsonl"), "utf8").trim().split("\n");
      expect(attempts.length).toBe(2);
      const a1 = JSON.parse(attempts[0]);
      const a2 = JSON.parse(attempts[1]);
      expect(a1.termination_state).toBeNull();
      expect(a2.termination_state).toBe("converged");
      // §1.3 minor：每轮的 runs_root 都进了记录。
      expect(typeof a1.runs_root).toBe("string");
      expect(typeof a2.runs_root).toBe("string");
      // 真实 drain reason（不是 parse_error）—— 评审 blocker：原 brace-free 正则让 reason 永远 parse_error。
      expect(a1.reason).toBe("drained");
      expect(a2.reason).toBe("drained");
      // 评审 major（attempt 2 final REJECT）：每轮的 tick_head_seq 必须是真实数值（从列表端点读到），
      //   不是 N/A / HEAD_SEQ_READ_FAILED。原假 bus 对单 channel GET 返回 head_seq:0 ⇒ 掩盖了
      //   真机该端点不含 head_seq 的 blocker；本假 bus 复刻真机字段集（单 channel GET 不含 head_seq，
      //   列表端点含），若实现退化为读单 channel GET，a*.tick_head_seq 会是 HEAD_SEQ_READ_FAILED ⇒ 变红。
      expect(a1.tick_head_seq).toBe(String(TEST_TICK_HEAD_SEQ));
      expect(a2.tick_head_seq).toBe(String(TEST_TICK_HEAD_SEQ));
      // 进度行也带真实 head_seq（不是 N/A）。
      expect(res.out).toMatch(new RegExp(`tick_head_seq=${TEST_TICK_HEAD_SEQ}`));
    } finally {
      bus.close();
    }
  }, 90000);
});

describe("§2 判据 6 (limits) entry-execution: state never non-null ⇒ entry hits attempt limit, non-zero exit, names the limit", () => {
  it("all drains return null ⇒ entry hits E0_DRAIN_MAX_ATTEMPTS, exits non-zero, names 'drain count limit'", async () => {
    const bus = await startFakeBus(TEST_TICK_CHANNEL, TEST_TICK_HEAD_SEQ);
    try {
      // ⛔ 判据 6 核心：真跑 bin/e0-regression.sh 的跨 drain 循环，termination.state 永远 null。
      //   maxAttempts=2（小值，让测试在有限时间内撞上限）。退避 1 秒（非零间隔，但测试要快）。
      //   评审 blocker：原测试只在测试里 for-loop，从不执行入口的上限检查；这里真跑，断言入口
      //   确实在 maxAttempts 停（不是无限循环）、非零退出、且点名「drain count limit」。
      const env = entryEnv({
        states: [null, null, null, null, null],
        busBase: bus.base,
        maxAttempts: 2,
        maxWall: 120,
        backoff: 1,
      });
      const res = await runEntry(env);
      expect(res.code, `stdout: ${res.out}\nstderr: ${res.err}`).not.toBe(0);

      // 入口点名撞的是 drain count 上限（判据 6 判别性：点名是哪个上限）。
      expect(res.err).toMatch(/hit drain count limit/);
      // 入口确实跑了 maxAttempts 轮就停（不是无限循环，不是遍历全部 5 个预置 drain）。
      const recordDir = join(env.E0_RECORD_ROOT!, "e0c2-entry-test");
      expect(existsSync(join(recordDir, "drain-1.stdout.log"))).toBe(true);
      expect(existsSync(join(recordDir, "drain-2.stdout.log"))).toBe(true);
      // 没有第三轮（撞了 maxAttempts=2 上限就停）。
      expect(existsSync(join(recordDir, "drain-3.stdout.log"))).toBe(false);
      // 评审 major（attempt 2 final REJECT）：即便撞上限，每轮记录的 tick_head_seq 仍是真实数值
      //   （从列表端点读到），不是 N/A / HEAD_SEQ_READ_FAILED。本假 bus 复刻真机字段集
      //   （单 channel GET 不含 head_seq），若实现退化会读到 HEAD_SEQ_READ_FAILED ⇒ 变红。
      const attempts = readFileSync(join(recordDir, "drain-attempts.jsonl"), "utf8").trim().split("\n");
      expect(attempts.length).toBe(2);
      for (const line of attempts) {
        expect(JSON.parse(line).tick_head_seq).toBe(String(TEST_TICK_HEAD_SEQ));
      }
    } finally {
      bus.close();
    }
  }, 90000);
});
