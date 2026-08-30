/**
 * C5（再暴露）——「干净 exit 0 零报告」新失败签名（判别性规格 1/3）。
 *
 * 真机实据（spec §背景）：16 轮全 round_end(errors=0)、drain 干净收尾 status=done（exit 0），
 * 但报告未生成：docs channel head_seq=0、无 DeepThought 目录。drain.json 记录 outstanding=1
 * （存在未消费续投 trigger），进程已退出 —— 旧哨兵只认 running+outstanding>0 / 无 run.end /
 * 轮次未闭合，于是「done + outstanding=1 + run.end 有 + 轮次全闭合」被误当成功 ⇒ 静默 exit 0。
 *
 * C5（第三暴露）判别性规格（不可放宽）：
 *   - drain 后 status=done 且 outstanding>0（存在未消费续投 trigger）⇒ 响亮终态（非零退出 +
 *     机器可读命名 reason：zero_report + drain_id + outstanding）。
 *   - drain 干净收尾但 docs channel 无报告（generate 一次性标记缺失，未生成/未落盘）⇒ 同样响亮。
 *   - ⛔ 零报告哨兵不得再以 reason=max_rounds / max_passes 排除撞预算终局：最终 drain（未声明
 *     DR_DRAIN_RETRY_WRAPPED）撞预算 + 零报告 ⇒ 响亮 budget_exhausted_no_report（spec 判据 2/3）。
 *   - 可重试中间尝试（调用方显式声明 DR_DRAIN_RETRY_WRAPPED=1）：max_rounds 排除保持
 *     （e0-regression 多 drain 收敛 GT-6 不推翻）。
 *   - 反向：outstanding=0 且报告标记存在 ⇒ 维持 exit 0（防误报）。
 *
 * 修复前（max_passes=16 + 哨兵不捕获）本文件用例必须红（静默 exit 0）；修复后必须绿。
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
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
const CHECKER = join(ROOT, "scripts", "check-drain-failures.mjs");

interface FakeEnv {
  dir: string;
  engineRoot: string;
  runsRoot: string;
  runDir: string;
}

function setUp(label: string): FakeEnv {
  const dir = mkdtempSync(join(tmpdir(), `c5-zr-${label}-`));
  const engineRoot = join(dir, "engine-root");
  mkdirSync(engineRoot, { recursive: true });
  const runsRoot = join(engineRoot, "runs", `run-${label}`);
  mkdirSync(runsRoot, { recursive: true });
  const runDir = join(runsRoot, `tick-run-${label}`);
  mkdirSync(runDir, { recursive: true });
  return { dir, engineRoot, runsRoot, runDir };
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

function writeIndexEntry(
  indexPath: string,
  entry: {
    kind: string;
    run_id: string;
    label: string;
    fleet: string;
    run_dir?: string;
    drain_id?: string;
    lane?: string;
    tick?: number;
  },
): void {
  writeFileSync(
    indexPath,
    JSON.stringify({
      schema: "lei/1",
      ...entry,
      ts: new Date().toISOString(),
      pid: 12345,
    }) + "\n",
  );
}

function appendIndexEntry(
  indexPath: string,
  entry: Record<string, unknown>,
): void {
  appendFileSync(
    indexPath,
    JSON.stringify({ schema: "lei/1", ...entry, pid: 12345 }) + "\n",
  );
}

function writeJournal(journalPath: string, result: string): void {
  writeFileSync(
    journalPath,
    JSON.stringify({ run_id: "tick~1", identity: "tick", result }) + "\n",
  );
}

// ── 直接调用哨兵（判别性规格 3 / 判别测试 2）──────────────────────────

function runChecker(env: Record<string, string>, summary: Record<string, unknown>): {
  code: number;
  err: string;
} {
  try {
    const out = execFileSync("node", [CHECKER], {
      input: JSON.stringify(summary),
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 30000,
    });
    return { code: 0, err: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: string | Buffer };
    return { code: err.status ?? -1, err: String(err.stderr ?? "") };
  }
}

function setUpDoneOutstanding(label: string, outstanding: number): {
  env: Record<string, string>;
  summary: Record<string, unknown>;
  drainId: string;
} {
  const drainId = `c5-zr-${label}`;
  const { dir, engineRoot, runsRoot, runDir } = setUp(label);
  writeDrainJson(runsRoot, drainId, { status: "done", outstanding, ended: 1 });
  const indexPath = join(engineRoot, "index.jsonl");
  writeIndexEntry(indexPath, {
    kind: "run.start",
    run_id: drainId,
    label: "deep-research",
    fleet: "fleet.yaml",
    run_dir: runsRoot,
  });
  writeIndexEntry(indexPath, {
    kind: "run.end",
    run_id: drainId,
    label: "deep-research",
    fleet: "fleet.yaml",
  });
  appendIndexEntry(indexPath, {
    kind: "run.start",
    run_id: `tick-${label}`,
    label: "tick",
    fleet: "workflows/deep-research/tick",
    run_dir: runDir,
    drain_id: drainId,
    lane: "tick",
    tick: 1,
  });
  writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");
  const env = {
    LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
  };
  const summary = { reason: "drained", rounds: 1, drain_id: drainId, runs_root: runsRoot };
  return { env, summary, drainId };
}

function markerPathFor(oneShotDir: string, origin: string, channel: string): string {
  const hash = createHash("sha256")
    .update(`${origin}:${channel}`)
    .digest("hex")
    .slice(0, 16);
  return join(oneShotDir, `generated-${hash}`);
}

describe("C5-ZR-1: status=done + outstanding>0（未消费续投 trigger）⇒ 响亮 zero_report（修复前静默 exit 0 必红）", () => {
  it("done + outstanding=1 ⇒ 非零退出 + zero_report + drain_id + outstanding 点名", () => {
    const { env, summary, drainId } = setUpDoneOutstanding("o1", 1);
    const res = runChecker(env, summary);

    expect(res.code).not.toBe(0);
    expect(res.code).toBe(3);
    expect(res.err).toContain("ZERO REPORT");
    expect(res.err).toContain("zero_report");
    expect(res.err).toContain(drainId);
    expect(res.err).toContain("outstanding=1");
    expect(res.err).not.toContain("sentinel_lost");

    rmSync(env.LOOP_ENGINE_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("判别性：done + outstanding=1 绝不会被误当成功（非零即响亮，绝不 exit 0）", () => {
    const { env, summary } = setUpDoneOutstanding("o2", 1);
    const res = runChecker(env, summary);
    expect(res.code).not.toBe(0);
    rmSync(env.LOOP_ENGINE_RUNTIME_ROOT, { recursive: true, force: true });
  });
});

describe("C5-ZR-2: drain 干净收尾但 docs channel 无报告（generate 标记缺失）⇒ 响亮 zero_report", () => {
  it("RESEARCH_ORIGIN 已配置而 one-shot 标记缺失 ⇒ 非零退出 + report not generated 点名", () => {
    const origin = "c5-zr-origin-2";
    const channel = "research:c5-zr-2";
    const oneShotDir = mkdtempSync(join(tmpdir(), "c5-zr-oneshot-2-"));
    const { env, summary, drainId } = setUpDoneOutstanding("o3", 0);

    const res = runChecker(
      {
        ...env,
        RESEARCH_ORIGIN: origin,
        TICK_CHANNEL: channel,
        DR_ONE_SHOT_DIR: oneShotDir,
      },
      summary,
    );

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("ZERO REPORT");
    expect(res.err).toContain("report not generated");
    expect(res.err).toContain(drainId);

    rmSync(env.LOOP_ENGINE_RUNTIME_ROOT, { recursive: true, force: true });
    rmSync(oneShotDir, { recursive: true, force: true });
  });

  it("反向：标记存在（报告已生成落盘）⇒ 不判 zero_report，维持 exit 0", () => {
    const origin = "c5-zr-origin-3";
    const channel = "research:c5-zr-3";
    const oneShotDir = mkdtempSync(join(tmpdir(), "c5-zr-oneshot-3-"));
    const { env, summary } = setUpDoneOutstanding("o4", 0);
    const marker = markerPathFor(oneShotDir, origin, channel);
    writeFileSync(marker, "");

    const res = runChecker(
      {
        ...env,
        RESEARCH_ORIGIN: origin,
        TICK_CHANNEL: channel,
        DR_ONE_SHOT_DIR: oneShotDir,
      },
      summary,
    );

    expect(res.code).toBe(0);
    expect(res.err).not.toContain("zero_report");
    expect(res.err).not.toContain("ZERO REPORT");

    rmSync(env.LOOP_ENGINE_RUNTIME_ROOT, { recursive: true, force: true });
    rmSync(oneShotDir, { recursive: true, force: true });
  });

  it("反向：RESEARCH_ORIGIN 未配置（无报告预期）⇒ 不判 docs-channel 空（维持既有语义）", () => {
    const { env, summary } = setUpDoneOutstanding("o5", 0);
    const res = runChecker(env, summary);
    expect(res.err).not.toContain("zero_report");
    rmSync(env.LOOP_ENGINE_RUNTIME_ROOT, { recursive: true, force: true });
  });
});

describe("C5-ZR-3（第三暴露）: 撞预算终局（max_rounds/max_passes）判别（判别性规格 2/3）", () => {
  it("最终 drain（未声明 DR_DRAIN_RETRY_WRAPPED）：done + outstanding=1 + reason=max_rounds ⇒ 响亮 budget_exhausted_no_report + drain_id + outstanding", () => {
    const { env, summary, drainId } = setUpDoneOutstanding("maxr-final", 1);
    const res = runChecker(env, { ...summary, reason: "max_rounds" });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("ZERO REPORT");
    expect(res.err).toContain("budget_exhausted_no_report");
    expect(res.err).toContain(drainId);
    expect(res.err).toContain("outstanding=1");

    rmSync(env.LOOP_ENGINE_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("判别性（规格 2 反向）：最终 drain（未声明重试包装）max_passes 同样响亮", () => {
    const { env, summary, drainId } = setUpDoneOutstanding("maxp-final", 1);
    const res = runChecker(env, { ...summary, reason: "max_passes" });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("budget_exhausted_no_report");
    expect(res.err).toContain(drainId);

    rmSync(env.LOOP_ENGINE_RUNTIME_ROOT, { recursive: true, force: true });
  });

  it("可重试中间尝试（声明 DR_DRAIN_RETRY_WRAPPED=1）：done + outstanding=1 + reason=max_rounds ⇒ 不判 zero_report（GT-6 退避重来不推翻）", () => {
    const { env, summary } = setUpDoneOutstanding("maxr-wrapped", 1);
    const res = runChecker({ ...env, DR_DRAIN_RETRY_WRAPPED: "1" }, { ...summary, reason: "max_rounds" });

    expect(res.err).not.toContain("zero_report");
    expect(res.err).not.toContain("ZERO REPORT");
    expect(res.err).not.toContain("budget_exhausted_no_report");
    expect(res.err).not.toContain("sentinel_lost");

    rmSync(env.LOOP_ENGINE_RUNTIME_ROOT, { recursive: true, force: true });
  });
});

// ── 判别测试 1：真实驱动 round 预算耗尽场景 ⇒ 非「exit 0 无报告」─────────

function runLoopScript(env: Record<string, string>): { code: number; out: string; err: string } {
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

describe("C5-ZR-4（判别测试 1）：预算耗尽后「干净收尾但零报告」签名 ⇒ 驱动端必须响亮（绝不静默 exit 0）", () => {
  it(
    "drain CLI exit 0 + drain.json status=done + outstanding=1 ⇒ deep-research-loop.sh 非零退出且点名 zero_report",
    { timeout: 60000 },
    () => {
      const drainId = "c5-zr-e2e";
      const dir = mkdtempSync(join(tmpdir(), "c5-zr-e2e-"));
      mkdirSync(join(dir, "dist", "lib"), { recursive: true });
      const cli = join(dir, "dist", "cli.sh");
      const storeCli = join(dir, "dist", "lib", "store-cli.sh");
      const engineRoot = join(dir, "engine-root");
      mkdirSync(engineRoot, { recursive: true });
      const runsRoot = join(engineRoot, "runs", "run-e2e");
      mkdirSync(runsRoot, { recursive: true });
      const runDir = join(runsRoot, "tick-run-e2e");
      mkdirSync(runDir, { recursive: true });

      const summaryFile = join(dir, "summary.json");
      writeFileSync(
        summaryFile,
        JSON.stringify({
          reason: "drained",
          rounds: 16,
          ticksByLabel: { tick: 16 },
          runs_root: runsRoot,
          drain_id: drainId,
        }),
      );
      writeFileSync(cli, `#!/usr/bin/env bash\ncat '${summaryFile}'\nexit 0\n`);
      chmodSync(cli, 0o755);
      writeFileSync(storeCli, "#!/usr/bin/env bash\n# no-op\n");
      chmodSync(storeCli, 0o755);

      // 预算耗尽的 registry 形态：drain 自身 run.end 已写、轮次闭合，但 outstanding=1
      // （第 16 轮后的续投 trigger 未消费）——旧哨兵判成功，本签名必须响亮。
      writeDrainJson(runsRoot, drainId, { status: "done", outstanding: 1, ended: 1 });
      const indexPath = join(engineRoot, "index.jsonl");
      writeIndexEntry(indexPath, {
        kind: "run.start",
        run_id: drainId,
        label: "deep-research",
        fleet: "fleet.yaml",
        run_dir: runsRoot,
      });
      writeIndexEntry(indexPath, {
        kind: "run.end",
        run_id: drainId,
        label: "deep-research",
        fleet: "fleet.yaml",
      });
      appendIndexEntry(indexPath, {
        kind: "run.start",
        run_id: "tick-e2e",
        label: "tick",
        fleet: "workflows/deep-research/tick",
        run_dir: runDir,
        drain_id: drainId,
        lane: "tick",
        tick: 1,
      });
      writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");
      writeFileSync(join(runsRoot, "loop-events.jsonl"), "");

      const res = runLoopScript({
        LOOP_ENGINE_CLI: cli,
        LOOP_STORE_CLI: storeCli,
        LOOP_ENGINE_RUNNER: "bash",
        LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
        TICK_CHANNEL: "research:c5-zr-e2e",
        RESEARCH_QUESTION: "test research question",
      });

      // 判别性：修复前（哨兵只认 running+outstanding>0）此形态会静默 exit 0 ⇒ 本断言变红。
      expect(res.code).not.toBe(0);
      expect(res.err).toContain("ZERO REPORT");
      expect(res.err).toContain("zero_report");
      expect(res.err).toContain(drainId);

      rmSync(dir, { recursive: true, force: true });
    },
  );

  it("反向：outstanding=0 且报告标记存在 ⇒ 驱动端维持 exit 0（防误报）", () => {
    const drainId = "c5-zr-e2e-ok";
    const dir = mkdtempSync(join(tmpdir(), "c5-zr-e2e-ok-"));
    mkdirSync(join(dir, "dist", "lib"), { recursive: true });
    const cli = join(dir, "dist", "cli.sh");
    const storeCli = join(dir, "dist", "lib", "store-cli.sh");
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs", "run-e2e-ok");
    mkdirSync(runsRoot, { recursive: true });
    const runDir = join(runsRoot, "tick-run-e2e-ok");
    mkdirSync(runDir, { recursive: true });

    const summaryFile = join(dir, "summary.json");
    writeFileSync(
      summaryFile,
      JSON.stringify({
        reason: "drained",
        rounds: 2,
        ticksByLabel: { tick: 2 },
        runs_root: runsRoot,
        drain_id: drainId,
      }),
    );
    writeFileSync(cli, `#!/usr/bin/env bash\ncat '${summaryFile}'\nexit 0\n`);
    chmodSync(cli, 0o755);
    writeFileSync(storeCli, "#!/usr/bin/env bash\n# no-op\n");
    chmodSync(storeCli, 0o755);

    writeDrainJson(runsRoot, drainId, { status: "done", outstanding: 0, ended: 1 });
    const indexPath = join(engineRoot, "index.jsonl");
    writeIndexEntry(indexPath, {
      kind: "run.start",
      run_id: drainId,
      label: "deep-research",
      fleet: "fleet.yaml",
      run_dir: runsRoot,
    });
    writeIndexEntry(indexPath, {
      kind: "run.end",
      run_id: drainId,
      label: "deep-research",
      fleet: "fleet.yaml",
    });
    appendIndexEntry(indexPath, {
      kind: "run.start",
      run_id: "tick-e2e-ok",
      label: "tick",
      fleet: "workflows/deep-research/tick",
      run_dir: runDir,
      drain_id: drainId,
      lane: "tick",
      tick: 1,
    });
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");
    writeFileSync(join(runsRoot, "loop-events.jsonl"), "");

    const res = runLoopScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      LOOP_ENGINE_RUNNER: "bash",
      LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      TICK_CHANNEL: "research:c5-zr-e2e-ok",
      RESEARCH_QUESTION: "test research question",
    });

    expect(res.code).toBe(0);
    expect(res.err).not.toContain("zero_report");
    expect(res.err).not.toContain("ZERO REPORT");

    rmSync(dir, { recursive: true, force: true });
  });

  it(
    "判别性（第三暴露）: drain CLI reason=max_rounds + status=done + outstanding=1 + 无 generate 标记 ⇒ 最终 drain 响亮 budget_exhausted_no_report + drain_id + outstanding（修复前 line 190 排除 max_rounds ⇒ exit 0 必红）",
    { timeout: 60000 },
    () => {
      const drainId = "c5-zr-e2e-maxr";
      const dir = mkdtempSync(join(tmpdir(), "c5-zr-e2e-maxr-"));
      mkdirSync(join(dir, "dist", "lib"), { recursive: true });
      const cli = join(dir, "dist", "cli.sh");
      const storeCli = join(dir, "dist", "lib", "store-cli.sh");
      const engineRoot = join(dir, "engine-root");
      mkdirSync(engineRoot, { recursive: true });
      const runsRoot = join(engineRoot, "runs", "run-e2e-maxr");
      mkdirSync(runsRoot, { recursive: true });
      const runDir = join(runsRoot, "tick-run-e2e-maxr");
      mkdirSync(runDir, { recursive: true });

      const summaryFile = join(dir, "summary.json");
      writeFileSync(
        summaryFile,
        JSON.stringify({
          reason: "max_rounds",
          rounds: 68,
          ticksByLabel: { tick: 68 },
          runs_root: runsRoot,
          drain_id: drainId,
        }),
      );
      writeFileSync(cli, `#!/usr/bin/env bash\ncat '${summaryFile}'\nexit 1\n`);
      chmodSync(cli, 0o755);
      writeFileSync(storeCli, "#!/usr/bin/env bash\n# no-op\n");
      chmodSync(storeCli, 0o755);

      // 撞派生预算的 registry 形态：drain 干净收尾（done）、outstanding=1（未消费续投 trigger）、
      // run.end 有、轮次闭合、无 generate 标记 —— 修复前被 line 190 的 max_rounds 排除 ⇒ 静默 exit 0。
      writeDrainJson(runsRoot, drainId, { status: "done", outstanding: 1, ended: 1 });
      const indexPath = join(engineRoot, "index.jsonl");
      writeIndexEntry(indexPath, {
        kind: "run.start",
        run_id: drainId,
        label: "deep-research",
        fleet: "fleet.yaml",
        run_dir: runsRoot,
      });
      writeIndexEntry(indexPath, {
        kind: "run.end",
        run_id: drainId,
        label: "deep-research",
        fleet: "fleet.yaml",
      });
      appendIndexEntry(indexPath, {
        kind: "run.start",
        run_id: "tick-e2e-maxr",
        label: "tick",
        fleet: "workflows/deep-research/tick",
        run_dir: runDir,
        drain_id: drainId,
        lane: "tick",
        tick: 1,
      });
      writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");
      writeFileSync(join(runsRoot, "loop-events.jsonl"), "");

      const res = runLoopScript({
        LOOP_ENGINE_CLI: cli,
        LOOP_STORE_CLI: storeCli,
        LOOP_ENGINE_RUNNER: "bash",
        LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
        TICK_CHANNEL: "research:c5-zr-e2e-maxr",
        RESEARCH_QUESTION: "test research question",
      });

      expect(res.code).not.toBe(0);
      expect(res.err).toContain("ZERO REPORT");
      expect(res.err).toContain("budget_exhausted_no_report");
      expect(res.err).toContain(drainId);
      expect(res.err).toContain("outstanding=1");

      rmSync(dir, { recursive: true, force: true });
    },
  );
});

// ── 判别性源码断言（防止哨兵分支被改回旧行为）────────────────────────

describe("C5-ZR-5: 哨兵源码必须同时含 done+outstanding>0 与 docs-channel 空两条 C5 分支", () => {
  it("check-drain-failures.mjs 含零报告判别逻辑", () => {
    const src = readFileSync(CHECKER, "utf8");
    expect(src).toContain("zero_report");
    expect(src).toMatch(/status\s*===\s*"done"/);
    expect(src).toContain("report not generated");
  });
});
