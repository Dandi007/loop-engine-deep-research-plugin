/**
 * C3 —— 哨兵静默失效必须响亮终态（判别性 spec，2026-08-29）。
 *
 * 真机实据（C5 冷启动 run b34f64d729b4）：drain 进程死亡后 run 静默停在
 * `drain.json.status="running"`、`outstanding>0`（存在未收割 in_flight/open 卡），
 * 无 run.end、无 sentinel_lost 终态、无告警 —— 违反 C3 不变量。
 *
 * 判别性规格（不可放宽）：
 *   - drain 未写 run.end，或 drain.json.status 非终态（仍 running）且 outstanding>0
 *     ⇒ 必须产出响亮终态：非零退出码 + 单一点名终态（sentinel_lost + outstanding=<n>）。
 *   - drain 正常写 run.end 且 outstanding==0 ⇒ 维持 exit 0。
 *
 * 本文件每个用例都**真实驱动**生产 `bin/deep-research-loop.sh`（离线假 CLI / 假 store），
 * 其中 C3-3 用真实子进程 SIGKILL 驱动「drain 进程死亡」路径。修复前（不读 registry，
 * 静默 exit 0）C3-1 / C3-3 必须红；修复后必须绿；C3-2 反向断言恒绿防误报。
 */
import { execFileSync, spawn } from "node:child_process";
import {
  appendFileSync,
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
import { describe, it, expect } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "bin", "deep-research-loop.sh");

interface FakeEnv {
  dir: string;
  cli: string;
  storeCli: string;
  engineRoot: string;
  runsRoot: string;
  runDir: string;
}

function runScript(env: Record<string, string>): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
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

function setUp(label: string): FakeEnv {
  const dir = mkdtempSync(join(tmpdir(), `c3-${label}-`));
  mkdirSync(join(dir, "dist", "lib"), { recursive: true });
  const cli = join(dir, "dist", "cli.sh");
  const storeCli = join(dir, "dist", "lib", "store-cli.sh");
  const engineRoot = join(dir, "engine-root");
  mkdirSync(engineRoot, { recursive: true });
  const runsRoot = join(engineRoot, "runs", `run-${label}`);
  mkdirSync(runsRoot, { recursive: true });
  const runDir = join(runsRoot, `tick-run-${label}`);
  mkdirSync(runDir, { recursive: true });
  return { dir, cli, storeCli, engineRoot, runsRoot, runDir };
}

function writeFakeCli(cli: string, summaryFile: string, exitCode = 0): void {
  writeFileSync(
    cli,
    `#!/usr/bin/env bash\ncat '${summaryFile}'\nexit ${exitCode}\n`,
  );
  chmodSync(cli, 0o755);
}

function writeFakeStoreCli(storeCli: string): void {
  writeFileSync(storeCli, "#!/usr/bin/env bash\n# no-op\n");
  chmodSync(storeCli, 0o755);
}

function writeSummary(summaryFile: string, drainId: string, runsRoot: string): void {
  writeFileSync(
    summaryFile,
    JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: runsRoot,
      drain_id: drainId,
    }),
  );
}

function drainRunStart(indexPath: string, drainId: string, runsRoot: string, fleet: string): void {
  writeFileSync(
    indexPath,
    JSON.stringify({
      schema: "lei/1",
      kind: "run.start",
      run_id: drainId,
      label: "deep-research",
      fleet,
      caller: "manual",
      run_dir: runsRoot,
      ts: new Date().toISOString(),
      pid: 12345,
    }) + "\n",
  );
}

function laneRunStart(indexPath: string, drainId: string, runDir: string, runId: string): void {
  appendFileSync(
    indexPath,
    JSON.stringify({
      schema: "lei/1",
      kind: "run.start",
      run_id: runId,
      label: "tick",
      fleet: "workflows/deep-research/tick",
      caller: "drain",
      run_dir: runDir,
      ts: new Date().toISOString(),
      pid: 12345,
      drain_id: drainId,
      lane: "tick",
      tick: 1,
    }) + "\n",
  );
}

function drainRunEnd(indexPath: string, drainId: string): void {
  appendFileSync(
    indexPath,
    JSON.stringify({
      schema: "lei/1",
      kind: "run.end",
      run_id: drainId,
      status: "ok",
      exit_code: 0,
      duration_ms: 1,
      ts: new Date().toISOString(),
    }) + "\n",
  );
}

function writeJournal(journalPath: string, result: string): void {
  writeFileSync(
    journalPath,
    JSON.stringify({ run_id: "tick~1", identity: "tick", result }) + "\n",
  );
}

function writeDrainJson(runsRoot: string, drainId: string, over: Record<string, unknown>): void {
  writeFileSync(
    join(runsRoot, "drain.json"),
    JSON.stringify(
      {
        contract_version: 2,
        drain_id: drainId,
        runs_root: runsRoot,
        fleet_config: "fleet.yaml",
        pid: 12345,
        started: 0,
        status: "running",
        loop_events: "loop-events.jsonl",
        last_heartbeat: 0,
        outstanding: 1,
        ...over,
      },
      null,
      2,
    ),
  );
}

function baseEnv(engineRoot: string, channel: string): Record<string, string> {
  return {
    LOOP_ENGINE_RUNNER: "bash",
    LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
    TICK_CHANNEL: channel,
    RESEARCH_QUESTION: "test research question",
  };
}

// ── C3-1（判别核心，修复前必须红）───────────────────────────────────

describe("C3-1: drain 死亡（未写 run.end / drain.json 仍 running 且 outstanding>0）⇒ 响亮 sentinel_lost", () => {
  it("drain.json running+outstanding>0 且 drain 自身 run.start 无 run.end ⇒ 非零退出 + sentinel_lost + outstanding 点名", () => {
    const drainId = "c3-dead-a";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } = setUp("dead-a");
    const summaryFile = join(dir, "summary.json");
    writeSummary(summaryFile, drainId, runsRoot);
    writeFakeCli(cli, summaryFile, 0);
    writeFakeStoreCli(storeCli);
    writeDrainJson(runsRoot, drainId, { status: "running", outstanding: 1 });
    const indexPath = join(engineRoot, "index.jsonl");
    drainRunStart(indexPath, drainId, runsRoot, "fleet.yaml");
    laneRunStart(indexPath, drainId, runDir, "tick-run-c3a");
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      ...baseEnv(engineRoot, "research:test-c3a"),
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("sentinel_lost");
    expect(res.err).toContain("outstanding=1");
    expect(res.err).toContain(drainId);
    // 判别性：绝不允许静默 exit 0 混过（spec：禁止「exit 0 也算过」）。
    expect(res.code).toBe(3);

    rmSync(dir, { recursive: true, force: true });
  });

  it("判别独立信号：仅 index.jsonl 的 drain 自身 run.start 无 run.end（无 drain.json）也判定 sentinel_lost", () => {
    const drainId = "c3-dead-b";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } = setUp("dead-b");
    const summaryFile = join(dir, "summary.json");
    writeSummary(summaryFile, drainId, runsRoot);
    writeFakeCli(cli, summaryFile, 0);
    writeFakeStoreCli(storeCli);
    const indexPath = join(engineRoot, "index.jsonl");
    drainRunStart(indexPath, drainId, runsRoot, "fleet.yaml");
    laneRunStart(indexPath, drainId, runDir, "tick-run-c3b");
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      ...baseEnv(engineRoot, "research:test-c3b"),
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("sentinel_lost");
    expect(res.err).toContain("outstanding=1");
    expect(res.err).toContain(drainId);

    rmSync(dir, { recursive: true, force: true });
  });

  it("loop-events.jsonl 轮次未闭合（死于轮中）也是 sentinel_lost 信号", () => {
    const drainId = "c3-dead-c";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } = setUp("dead-c");
    const summaryFile = join(dir, "summary.json");
    writeSummary(summaryFile, drainId, runsRoot);
    writeFakeCli(cli, summaryFile, 0);
    writeFakeStoreCli(storeCli);
    // drain.json 显示终态 done + outstanding 0，但 loop-events 有 round_start 无 round_end ⇒ 死于轮中。
    writeDrainJson(runsRoot, drainId, { status: "done", outstanding: 0, ended: 1 });
    const indexPath = join(engineRoot, "index.jsonl");
    drainRunStart(indexPath, drainId, runsRoot, "fleet.yaml");
    drainRunEnd(indexPath, drainId);
    laneRunStart(indexPath, drainId, runDir, "tick-run-c3c");
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");
    writeFileSync(
      join(runsRoot, "loop-events.jsonl"),
      JSON.stringify({ ts: 0, kind: "round_start", detail: { round: 1 } }) + "\n",
    );

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      ...baseEnv(engineRoot, "research:test-c3c"),
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("sentinel_lost");
    expect(res.err).toMatch(/outstanding=\d+/);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── C3-2（反向断言，防误报）──────────────────────────────────────

describe("C3-2: 正常 drain（写 run.end 且 outstanding==0）⇒ 维持 exit 0", () => {
  it("drain.json 终态 + run.end 配对完整 + outstanding 0 ⇒ exit 0 且无 sentinel_lost", () => {
    const drainId = "c3-healthy";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } = setUp("healthy");
    const summaryFile = join(dir, "summary.json");
    writeSummary(summaryFile, drainId, runsRoot);
    writeFakeCli(cli, summaryFile, 0);
    writeFakeStoreCli(storeCli);
    writeDrainJson(runsRoot, drainId, { status: "done", outstanding: 0, ended: 1 });
    const indexPath = join(engineRoot, "index.jsonl");
    drainRunStart(indexPath, drainId, runsRoot, "fleet.yaml");
    laneRunStart(indexPath, drainId, runDir, "tick-run-c3h");
    drainRunEnd(indexPath, drainId);
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      ...baseEnv(engineRoot, "research:test-c3h"),
    });

    expect(res.code).toBe(0);
    expect(res.err).not.toContain("sentinel_lost");

    rmSync(dir, { recursive: true, force: true });
  });

  it("drain.json 缺失 + drain 自身 run.start 有 run.end ⇒ exit 0（无 drain.json 不误报）", () => {
    const drainId = "c3-healthy-b";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } = setUp("healthy-b");
    const summaryFile = join(dir, "summary.json");
    writeSummary(summaryFile, drainId, runsRoot);
    writeFakeCli(cli, summaryFile, 0);
    writeFakeStoreCli(storeCli);
    const indexPath = join(engineRoot, "index.jsonl");
    drainRunStart(indexPath, drainId, runsRoot, "fleet.yaml");
    laneRunStart(indexPath, drainId, runDir, "tick-run-c3hb");
    drainRunEnd(indexPath, drainId);
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      ...baseEnv(engineRoot, "research:test-c3hb"),
    });

    expect(res.code).toBe(0);
    expect(res.err).not.toContain("sentinel_lost");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── C3-3（真实驱动：SIGKILL 掉 drain 子进程，死亡无摘要路径）───────

describe("C3-3: 真实驱动 drain 子进程并 SIGKILL ⇒ 驱动读 registry 产出响亮 sentinel_lost", () => {
  it(
    "drain 进程被杀（无摘要）后，驱动按 RUNTIME_FLEET 定位 registry 并响亮失败",
    { timeout: 30000 },
    async () => {
      const drainId = "c3-sigkill";
      const dir = mkdtempSync(join(tmpdir(), "c3-sigkill-"));
      const engineRoot = join(dir, "engine-root");
      mkdirSync(engineRoot, { recursive: true });
      const runsRoot = join(engineRoot, "runs", "run-sigkill");
      mkdirSync(runsRoot, { recursive: true });
      const runRoot = join(dir, "run-root");
      mkdirSync(runRoot, { recursive: true });
      const cli = join(dir, "dist", "cli.sh");
      const storeCli = join(dir, "dist", "lib", "store-cli.sh");
      mkdirSync(join(dir, "dist", "lib"), { recursive: true });
      const pidFile = join(dir, "pid.txt");
      // 本驱动渲染的 fleet 路径 == RUNTIME_FLEET == DD_RUN_ROOT/fleet.yaml。
      const fleet = join(runRoot, "fleet.yaml");

      writeFakeStoreCli(storeCli);
      // 假 loop-engine CLI：只登记 PID 后睡死，等待被 SIGKILL（不打印任何摘要）。
      writeFileSync(
        cli,
        `#!/usr/bin/env bash\nset -euo pipefail\nprintf '%s' "$$" > '${pidFile}'\nexec sleep 60\n`,
      );
      chmodSync(cli, 0o755);

      // 预构造死亡 registry：drain.json 仍 running + outstanding>0，drain 自身 run.start 无 run.end。
      writeDrainJson(runsRoot, drainId, { status: "running", outstanding: 1, fleet_config: fleet });
      const indexPath = join(engineRoot, "index.jsonl");
      drainRunStart(indexPath, drainId, runsRoot, fleet);

      const child = spawn("bash", [SCRIPT], {
        cwd: ROOT,
        env: {
          ...process.env,
          LOOP_ENGINE_CLI: cli,
          LOOP_STORE_CLI: storeCli,
          LOOP_ENGINE_RUNNER: "bash",
          LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
          DD_RUN_ROOT: runRoot,
          TICK_CHANNEL: "research:test-c3-sigkill",
          RESEARCH_QUESTION: "test research question",
        },
        stdio: ["ignore", "pipe", "pipe"],
      });

      let out = "";
      let err = "";
      child.stdout?.on("data", (c: Buffer) => {
        out += c;
      });
      child.stderr?.on("data", (c: Buffer) => {
        err += c;
      });
      const exited = new Promise<number | null>((resolve) => child.on("close", resolve));

      // 等假 CLI 登记 PID（即 drain 子进程已起、registry 已就位）。
      const deadline = Date.now() + 10000;
      while (!existsSync(pidFile)) {
        if (Date.now() > deadline) throw new Error("fake drain CLI did not register in time");
        await new Promise((r) => setTimeout(r, 50));
      }
      const pid = Number(readFileSync(pidFile, "utf8").trim());
      process.kill(pid, "SIGKILL");
      const code = await exited;

      expect(code).not.toBe(0);
      expect(err).toContain("sentinel_lost");
      expect(err).toContain("outstanding=1");

      rmSync(dir, { recursive: true, force: true });
    },
  );
});
