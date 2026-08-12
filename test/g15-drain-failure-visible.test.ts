/**
 * G15 —— tick 失败在驱动层不可见：deep-research-loop.sh 恒 exit 0
 *
 * 硬验收 Y1–Y4（spec §2）。每个测试用假 loop-engine CLI / 假 store-cli
 * 驱动生产 bin/deep-research-loop.sh，离线不碰 bus。
 *
 * E0c5 §1.3 —— 新增 TIMEOUT / exec_failed 检测（Y5–Y6）。
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "bin", "deep-research-loop.sh");

function runScript(env: Record<string, string>): {
  code: number;
  out: string;
  err: string;
} {
  try {
    const out = execFileSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    const err = e as {
      status?: number;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
    };
    return {
      code: err.status ?? -1,
      out: String(err.stdout ?? ""),
      err: String(err.stderr ?? ""),
    };
  }
}

function drainJson(drainId: string, runsRoot: string): string {
  return JSON.stringify({
    reason: "drained",
    rounds: 1,
    ticksByLabel: { tick: 1 },
    runs_root: runsRoot,
    drain_id: drainId,
  });
}

function setUpFakeEnv(label: string): {
  dir: string;
  cli: string;
  storeCli: string;
  engineRoot: string;
  runsRoot: string;
  runDir: string;
} {
  const dir = mkdtempSync(join(tmpdir(), `g15-${label}-`));
  mkdirSync(join(dir, "dist", "lib"), { recursive: true });
  const cli = join(dir, "dist", "cli.js");
  const storeCli = join(dir, "dist", "lib", "store-cli.js");
  const engineRoot = join(dir, "engine-root");
  mkdirSync(engineRoot, { recursive: true });
  const runsRoot = join(engineRoot, "runs", `run-${label}`);
  mkdirSync(runsRoot, { recursive: true });
  const runDir = join(runsRoot, `tick-run-${label}`);
  mkdirSync(runDir, { recursive: true });
  return { dir, cli, storeCli, engineRoot, runsRoot, runDir };
}

function writeFakeCli(cli: string, json: string, exitCode: number): void {
  writeFileSync(
    cli,
    `#!/usr/bin/env node\nconsole.log('${json.replace(/'/g, "\\'")}');\nprocess.exit(${exitCode});\n`,
  );
  chmodSync(cli, 0o755);
}

function writeFakeStoreCli(storeCli: string): void {
  writeFileSync(storeCli, "#!/usr/bin/env node\n// no-op\n");
  chmodSync(storeCli, 0o755);
}

function writeIndexEntry(
  indexPath: string,
  entry: {
    drain_id: string;
    lane: string;
    run_dir: string;
    tick: number;
  },
): void {
  writeFileSync(
    indexPath,
    JSON.stringify({
      schema: "lei/1",
      kind: "run.start",
      run_id: entry.run_dir.split("/").pop() ?? "run",
      label: "tick",
      fleet: "fleet.yaml",
      caller: "drain",
      run_dir: entry.run_dir,
      ts: new Date().toISOString(),
      pid: 12345,
      drain_id: entry.drain_id,
      lane: entry.lane,
      tick: entry.tick,
    }) + "\n",
  );
}

function writeJournal(journalPath: string, result: string): void {
  writeFileSync(
    journalPath,
    JSON.stringify({
      run_id: "tick~1",
      identity: "tick",
      result,
    }) + "\n",
  );
}

function writeEventJournal(journalPath: string, events: string[]): void {
  writeFileSync(
    journalPath,
    JSON.stringify({
      run_id: "tick~1",
      identity: "tick",
      events,
    }) + "\n",
  );
}

describe("Y1: tick 非零退出 ⇒ 脚本非零退出，且 stderr 点名 run_dir 与退出码", () => {
  it("single tick failure detected from journal.jsonl", () => {
    const drainId = "test-drain-y1";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } =
      setUpFakeEnv("y1");

    writeFakeCli(cli, drainJson(drainId, runsRoot), 0);
    writeFakeStoreCli(storeCli);
    writeIndexEntry(join(engineRoot, "index.jsonl"), {
      drain_id: drainId,
      lane: "tick",
      run_dir: runDir,
      tick: 1,
    });
    writeJournal(
      join(runDir, "journal.jsonl"),
      "[bash 非零退出 EXIT:2]\nbus GET …/messages?limit=100: 404 NOT_FOUND",
    );

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      LOOP_ENGINE_RUNNER: "node",
      LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      TICK_CHANNEL: "research:test-y1",
      RESEARCH_QUESTION: "test research question",
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("TICK FAILURE");
    expect(res.err).toContain(runDir);
    expect(res.err).toContain("exit=2");
    expect(res.err).toContain("[bash 非零退出 EXIT:2]");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Y2: tick 成功时行为逐字不变", () => {
  it("all ticks succeed ⇒ script exit 0 and stdout unchanged", () => {
    const drainId = "test-drain-y2";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } =
      setUpFakeEnv("y2");

    writeFakeCli(cli, drainJson(drainId, runsRoot), 0);
    writeFakeStoreCli(storeCli);
    writeIndexEntry(join(engineRoot, "index.jsonl"), {
      drain_id: drainId,
      lane: "tick",
      run_dir: runDir,
      tick: 1,
    });
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      LOOP_ENGINE_RUNNER: "node",
      LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      TICK_CHANNEL: "research:test-y2",
      RESEARCH_QUESTION: "test research question",
    });

    expect(res.code).toBe(0);
    expect(res.out).toContain("drain_id");
    expect(res.out).toContain(drainId);
    expect(res.err).not.toContain("TICK FAILURE");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Y3: 多 tick 中任一失败即失败，且报告全部失败的 run_dir", () => {
  it("two ticks, second fails ⇒ only failed run_dir reported", () => {
    const drainId = "test-drain-y3";
    const { dir, cli, storeCli, engineRoot, runsRoot } = setUpFakeEnv("y3");
    const runDir1 = join(runsRoot, "tick-run-y3a");
    const runDir2 = join(runsRoot, "tick-run-y3b");
    mkdirSync(runDir1, { recursive: true });
    mkdirSync(runDir2, { recursive: true });

    writeFakeCli(cli, drainJson(drainId, runsRoot), 0);
    writeFakeStoreCli(storeCli);

    const indexPath = join(engineRoot, "index.jsonl");
    writeFileSync(
      indexPath,
      JSON.stringify({
        schema: "lei/1",
        kind: "run.start",
        run_id: "tick-run-y3a",
        label: "tick",
        fleet: "fleet.yaml",
        caller: "drain",
        run_dir: runDir1,
        ts: new Date().toISOString(),
        pid: 12345,
        drain_id: drainId,
        lane: "tick",
        tick: 1,
      }) +
        "\n" +
        JSON.stringify({
          schema: "lei/1",
          kind: "run.start",
          run_id: "tick-run-y3b",
          label: "tick",
          fleet: "fleet.yaml",
          caller: "drain",
          run_dir: runDir2,
          ts: new Date().toISOString(),
          pid: 12345,
          drain_id: drainId,
          lane: "tick",
          tick: 2,
        }) +
        "\n",
    );

    writeJournal(join(runDir1, "journal.jsonl"), "OK: all fine");
    writeJournal(
      join(runDir2, "journal.jsonl"),
      "[bash 非零退出 EXIT:2]\nbus GET …/messages?limit=100: 404 NOT_FOUND",
    );

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      LOOP_ENGINE_RUNNER: "node",
      LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      TICK_CHANNEL: "research:test-y3",
      RESEARCH_QUESTION: "test research question",
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("TICK FAILURE");
    expect(res.err).toContain(runDir2);
    expect(res.err).toContain("exit=2");
    expect(res.err).not.toContain(runDir1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("both ticks fail ⇒ both reported", () => {
    const drainId = "test-drain-y3b";
    const { dir, cli, storeCli, engineRoot, runsRoot } = setUpFakeEnv("y3b");
    const runDir1 = join(runsRoot, "tick-run-y3b1");
    const runDir2 = join(runsRoot, "tick-run-y3b2");
    mkdirSync(runDir1, { recursive: true });
    mkdirSync(runDir2, { recursive: true });

    writeFakeCli(cli, drainJson(drainId, runsRoot), 0);
    writeFakeStoreCli(storeCli);

    const indexPath = join(engineRoot, "index.jsonl");
    writeFileSync(
      indexPath,
      JSON.stringify({
        schema: "lei/1",
        kind: "run.start",
        run_id: "tick-run-y3b1",
        label: "tick",
        fleet: "fleet.yaml",
        caller: "drain",
        run_dir: runDir1,
        ts: new Date().toISOString(),
        pid: 12345,
        drain_id: drainId,
        lane: "tick",
        tick: 1,
      }) +
        "\n" +
        JSON.stringify({
          schema: "lei/1",
          kind: "run.start",
          run_id: "tick-run-y3b2",
          label: "tick",
          fleet: "fleet.yaml",
          caller: "drain",
          run_dir: runDir2,
          ts: new Date().toISOString(),
          pid: 12345,
          drain_id: drainId,
          lane: "tick",
          tick: 2,
        }) +
        "\n",
    );

    writeJournal(
      join(runDir1, "journal.jsonl"),
      "[bash 非零退出 EXIT:2]\nbus GET: 404",
    );
    writeJournal(
      join(runDir2, "journal.jsonl"),
      "[bash 非零退出 EXIT:3]\nother error",
    );

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      LOOP_ENGINE_RUNNER: "node",
      LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      TICK_CHANNEL: "research:test-y3b",
      RESEARCH_QUESTION: "test research question",
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("TICK FAILURE");
    expect(res.err).toContain(runDir1);
    expect(res.err).toContain(runDir2);
    expect(res.err).toContain("exit=2");
    expect(res.err).toContain("exit=3");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Y4: 痕迹不可读 ⇒ 响亮失败", () => {
  it("index.jsonl missing ⇒ non-zero exit and names index.jsonl", () => {
    const drainId = "test-drain-y4a";
    const { dir, cli, storeCli, engineRoot, runsRoot } = setUpFakeEnv("y4a");

    writeFakeCli(cli, drainJson(drainId, runsRoot), 0);
    writeFakeStoreCli(storeCli);

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      LOOP_ENGINE_RUNNER: "node",
      LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      TICK_CHANNEL: "research:test-y4a",
      RESEARCH_QUESTION: "test research question",
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("index.jsonl");
    expect(res.err).toContain("not found");

    rmSync(dir, { recursive: true, force: true });
  });

  it("no matching lane entries in index.jsonl ⇒ non-zero exit and names drain_id", () => {
    const drainId = "test-drain-y4b";
    const { dir, cli, storeCli, engineRoot, runsRoot } = setUpFakeEnv("y4b");

    writeFakeCli(cli, drainJson(drainId, runsRoot), 0);
    writeFakeStoreCli(storeCli);

    const indexPath = join(engineRoot, "index.jsonl");
    writeFileSync(
      indexPath,
      JSON.stringify({
        schema: "lei/1",
        kind: "run.start",
        run_id: "other-run",
        label: "tick",
        fleet: "fleet.yaml",
        caller: "drain",
        run_dir: runsRoot,
        ts: new Date().toISOString(),
        pid: 12345,
        drain_id: "some-other-drain",
        lane: "tick",
        tick: 1,
      }) + "\n",
    );

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      LOOP_ENGINE_RUNNER: "node",
      LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      TICK_CHANNEL: "research:test-y4b",
      RESEARCH_QUESTION: "test research question",
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("no lane entries");
    expect(res.err).toContain(drainId);

    rmSync(dir, { recursive: true, force: true });
  });
});

// ── E0c5 §1.3: TIMEOUT / exec_failed 检测 ─────────────────────────────────────

describe("Y5: tick 被引擎超时砍掉 (status=TIMEOUT) ⇒ 响亮失败点名 run_dir", () => {
  it("journal contains status=TIMEOUT ⇒ non-zero exit naming run_dir and timeout", () => {
    const drainId = "test-drain-y5";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } =
      setUpFakeEnv("y5");

    writeFakeCli(cli, drainJson(drainId, runsRoot), 0);
    writeFakeStoreCli(storeCli);
    writeIndexEntry(join(engineRoot, "index.jsonl"), {
      drain_id: drainId,
      lane: "tick",
      run_dir: runDir,
      tick: 1,
    });
    writeJournal(join(runDir, "journal.jsonl"), "[外部调用失败 status=TIMEOUT]");

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      LOOP_ENGINE_RUNNER: "node",
      LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      TICK_CHANNEL: "research:test-y5",
      RESEARCH_QUESTION: "test research question",
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("TICK FAILURE");
    expect(res.err).toContain(runDir);
    expect(res.err).toContain("timeout");

    rmSync(dir, { recursive: true, force: true });
  });
});

describe("Y6: tick 以 exec_failed 结束 ⇒ 响亮失败点名 run_dir", () => {
  it("journal events contain exec_failed ⇒ non-zero exit naming run_dir", () => {
    const drainId = "test-drain-y6";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } =
      setUpFakeEnv("y6");

    writeFakeCli(cli, drainJson(drainId, runsRoot), 0);
    writeFakeStoreCli(storeCli);
    writeIndexEntry(join(engineRoot, "index.jsonl"), {
      drain_id: drainId,
      lane: "tick",
      run_dir: runDir,
      tick: 1,
    });
    writeEventJournal(join(runDir, "journal.jsonl"), [
      "start", "spawn", "dispatch", "done", "exec_failed", "stop",
    ]);

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      LOOP_ENGINE_RUNNER: "node",
      LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      TICK_CHANNEL: "research:test-y6",
      RESEARCH_QUESTION: "test research question",
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("TICK FAILURE");
    expect(res.err).toContain(runDir);
    expect(res.err).toContain("exec_failed");

    rmSync(dir, { recursive: true, force: true });
  });
});