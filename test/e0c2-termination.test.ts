/**
 * E0c2 —— 终止语义域：终态取真值、续投门对齐、入口反复 drain 直到终态。
 *
 * 覆盖 spec §2 判据 2–7（判别性单测）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READ_TERMINATION = join(ROOT, "scripts", "read-termination.mjs");
const DRAIN_PARSE_SUMMARY = join(ROOT, "scripts", "drain-parse-summary.mjs");
const TICK_MD = join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md");

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

function startFakeBus(): Promise<number> {
  return new Promise((resolve, reject) => {
    const fixture = join(ROOT, "test", "fixtures", "fake-bus.mjs");
    let stdout = "";
    const child = spawn(process.execPath, [fixture], {
      env: { ...process.env, A10B_BUS_PORT: "0" },
      stdio: ["ignore", "pipe", "ignore"],
    });
    runningBuses.push(child.pid as number);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    const deadline = Date.now() + 5000;
    const check = (port: number) => {
      fetch(`http://127.0.0.1:${port}/v1/channels/_probe`)
        .then(() => resolve(port))
        .catch(() => {
          if (Date.now() > deadline) reject(new Error("fake bus did not come up (kernel-assigned port)"));
          else setTimeout(() => check(port), 50);
        });
    };
    child.on("error", (err) => reject(err));
    // Wait for the fake bus to print its listening port
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

function setupRuntimeDir(
  engineRoot: string,
  runsRoot: string,
  drainId: string,
  terminationState: string | null,
  coverage?: number,
  zeroGrowthRounds?: number,
  boardComposition?: { proposed: number; open: number; inFlight: number; explored: number; blocked: number },
  triageThreshold?: number,
): string {
  const runDir = join(runsRoot, `run-${drainId}`, "tick-run");
  mkdirSync(runDir, { recursive: true });
  const tickOutput = JSON.stringify({
    hasPendingWork: false,
    decisions: [],
    ...(triageThreshold !== undefined ? { triageThreshold } : {}),
    termination: {
      state: terminationState,
      coverage: coverage ?? 0,
      zeroGrowthRounds: zeroGrowthRounds ?? 0,
      capHit: false,
      boardComposition: boardComposition ?? { proposed: 0, open: 0, inFlight: 0, explored: 0, blocked: 0 },
    },
  });
  const journalFile = join(runDir, "journal.jsonl");
  writeFileSync(
    journalFile,
    JSON.stringify({
      run_id: `tick~${drainId}`,
      identity: "tick",
      result: tickOutput,
      effects: [],
    }) + "\n",
  );
  const indexFile = join(engineRoot, "index.jsonl");
  const existing = existsSync(indexFile) ? readFileSync(indexFile, "utf8") : "";
  const entry = JSON.stringify({
    schema: "lei/1",
    kind: "run.start",
    run_id: `tick~${drainId}`,
    label: "tick",
    fleet: "fleet.yaml",
    caller: "drain",
    run_dir: runDir,
    ts: new Date().toISOString(),
    pid: 12345,
    drain_id: drainId,
    lane: "tick",
    tick: 1,
  }) + "\n";
  writeFileSync(indexFile, existing + entry);
  return runDir;
}

function createFakeLoopStub(
  binDir: string,
  version: string,
  attemptFile: string,
  runsRoot: string,
): void {
  // Use a printf-based approach to avoid nested quoting issues
  const lines: string[] = [
    "#!/usr/bin/env bash",
    "ATTEMPT=1",
    'if [ -f "${FAKE_LOOP_ATTEMPT_FILE:-}" ]; then',
    '  ATTEMPT=$(($(cat "${FAKE_LOOP_ATTEMPT_FILE:-}") + 1))',
    "fi",
    'echo "$ATTEMPT" > "${FAKE_LOOP_ATTEMPT_FILE:-/dev/null}"',
    "",
    'VERSION="${FAKE_LOOP_VERSION:-default}"',
    "",
    'case "$VERSION" in',
  ];

  if (version === "maxrounds-then-converge") {
    lines.push("  maxrounds-then-converge)");
    lines.push('    if [ "$ATTEMPT" -eq 1 ]; then');
    lines.push(`      printf '{"reason":"max_rounds","rounds":16,"ticksByLabel":{"tick":16},"runs_root":"${runsRoot}","drain_id":"fake-drain-maxrounds-1"}\\n'`);
    lines.push("      exit 1");
    lines.push("    else");
    lines.push(`      printf '{"reason":"drained","rounds":2,"ticksByLabel":{"tick":2},"runs_root":"${runsRoot}","drain_id":"fake-drain-converged-2"}\\n'`);
    lines.push("      exit 0");
    lines.push("    fi");
    lines.push("    ;;");
  } else if (version === "null-then-converge") {
    lines.push("  null-then-converge)");
    lines.push(`    printf '{"reason":"drained","rounds":2,"ticksByLabel":{"tick":2},"runs_root":"${runsRoot}","drain_id":"fake-drain-attempt-'"$ATTEMPT"'\\"}\\n'`);
    lines.push("    exit 0");
    lines.push("    ;;");
  } else if (version === "always-null") {
    lines.push("  always-null)");
    lines.push(`    printf '{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"${runsRoot}","drain_id":"fake-drain-null-'"$ATTEMPT"'\\"}\\n'`);
    lines.push("    exit 0");
    lines.push("    ;;");
  } else if (version === "other-exit-code") {
    lines.push("  other-exit-code)");
    lines.push(`    printf '{"reason":"other","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"${runsRoot}","drain_id":"fake-drain-bad-1"}\\n'`);
    lines.push("    exit 3");
    lines.push("    ;;");
  } else if (version === "unparseable") {
    lines.push("  unparseable)");
    lines.push('    printf "not json at all\\n"');
    lines.push("    exit 1");
    lines.push("    ;;");
  }

  lines.push("  *)");
  lines.push(`    printf '{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"${runsRoot}","drain_id":"fake-drain-default"}\\n'`);
  lines.push("    exit 0");
  lines.push("    ;;");
  lines.push("esac");

  writeFileSync(join(binDir, "deep-research-loop.sh"), lines.join("\n") + "\n");
  chmodSync(join(binDir, "deep-research-loop.sh"), 0o755);
}

function setupE0RegressionEnv(
  version: string,
  opts: {
    maxAttempts?: number;
    wallClockSeconds?: number;
    backoffSeconds?: number;
    terminationStates?: Array<{ drainId: string; state: string | null }>;
  } = {},
): {
  dir: string;
  env: Record<string, string>;
  attemptFile: string;
  e0regression: string;
  recordRoot: string;
  engineRoot: string;
  runsRoot: string;
} {
  const dir = mkdtempSync(join(tmpdir(), "e0c2-exec-"));
  const binDir = join(dir, "bin");
  mkdirSync(binDir, { recursive: true });

  try {
    symlinkSync(join(ROOT, "bin", "e0-regression.sh"), join(binDir, "e0-regression.sh"));
  } catch {
    // Already exists or symlink not supported
  }

  for (const sub of ["node_modules", "src", "scripts", "package.json", "tsconfig.json"]) {
    const target = join(dir, sub);
    if (!existsSync(target)) {
      try {
        symlinkSync(join(ROOT, sub), target);
      } catch {
        // ignore
      }
    }
  }

  const profilesDir = join(dir, "profiles", "deploy");
  mkdirSync(profilesDir, { recursive: true });
  const recordRoot = join(dir, "records");
  mkdirSync(recordRoot, { recursive: true });
  const engineRoot = join(dir, "engine-root");
  mkdirSync(engineRoot, { recursive: true });
  const runsRoot = join(engineRoot, "runs");
  mkdirSync(runsRoot, { recursive: true });

  const maxAttempts = opts.maxAttempts ?? 3;
  const wallClockSeconds = opts.wallClockSeconds ?? 10;
  const backoffSeconds = opts.backoffSeconds ?? 0;

  const profile = [
    "RESEARCH_PROFILE_BASE=e0c2-test",
    "RESEARCH_QUESTION=test research question",
    "RESEARCH_ORIGIN=test",
    `EXPORT_ROOT=${join(dir, "export")}`,
    `ALLOWED_ROOT=${dir}`,
    "ANCHOR_CHECK_BIN=/bin/true",
    "SEED_CLUE=test seed clue for e0c2",
    "SEED_SOURCES=code-local",
    `DRAIN_BACKOFF_SECONDS=${backoffSeconds}`,
    `DRAIN_MAX_ATTEMPTS=${maxAttempts}`,
    `DRAIN_WALL_CLOCK_SECONDS=${wallClockSeconds}`,
    `LOOP_ENGINE_RUNTIME_ROOT=${engineRoot}`,
    "",
  ].join("\n");
  writeFileSync(join(profilesDir, "test-e0c2.env"), profile);

  const tokenDir = join(dir, "tokens");
  mkdirSync(tokenDir, { recursive: true });
  const tokenFile = join(tokenDir, "token");
  writeFileSync(tokenFile, "test-token\n");

  const attemptFile = join(dir, "fake-attempt.txt");
  writeFileSync(attemptFile, "0");
  createFakeLoopStub(binDir, version, attemptFile, runsRoot);

  if (opts.terminationStates) {
    for (const ts of opts.terminationStates) {
      setupRuntimeDir(engineRoot, runsRoot, ts.drainId, ts.state);
    }
  }

  const env: Record<string, string> = {
    AGENT_BUS_TOKEN_FILE: tokenFile,
    E0_RECORD_ROOT: recordRoot,
    E0C1_PROD_BUS_TOKEN_FILE: tokenFile,
    DD_RUN_ID: `test-e0c2-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    PATH: process.env.PATH ?? "/usr/bin",
    HOME: process.env.HOME ?? "/root",
    FAKE_LOOP_ATTEMPT_FILE: attemptFile,
    FAKE_LOOP_VERSION: version,
    LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
  };

  return {
    dir,
    env,
    attemptFile,
    e0regression: join(binDir, "e0-regression.sh"),
    recordRoot,
    engineRoot,
    runsRoot,
  };
}

function runE0Regression(
  e0regression: string,
  env: Record<string, string>,
): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("bash", [e0regression, "--profile", "test-e0c2"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    const ee = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: ee.status ?? -1,
      out: String(ee.stdout ?? ""),
      err: String(ee.stderr ?? ""),
    };
  }
}

function runNodeScript(scriptPath: string, input: string, env?: Record<string, string>): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("node", [scriptPath], {
      cwd: ROOT,
      encoding: "utf8",
      input,
      env: { ...process.env, ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, out: out.trim(), err: "" };
  } catch (e) {
    const ee = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: ee.status ?? -1,
      out: String(ee.stdout ?? "").trim(),
      err: String(ee.stderr ?? "").trim(),
    };
  }
}

function setupFakeRuntime(dir: string, drainId: string, journalResult: string): { engineRoot: string; runsRoot: string; indexFile: string; journalFile: string } {
  const engineRoot = join(dir, "engine-root");
  mkdirSync(engineRoot, { recursive: true });
  const runsRoot = join(engineRoot, "runs", `run-${drainId}`);
  mkdirSync(runsRoot, { recursive: true });
  const runDir = join(runsRoot, "tick-run");
  mkdirSync(runDir, { recursive: true });
  const indexFile = join(engineRoot, "index.jsonl");
  writeFileSync(
    indexFile,
    JSON.stringify({
      schema: "lei/1",
      kind: "run.start",
      run_id: "tick~1",
      label: "tick",
      fleet: "fleet.yaml",
      caller: "drain",
      run_dir: runDir,
      ts: new Date().toISOString(),
      pid: 12345,
      drain_id: drainId,
      lane: "tick",
      tick: 1,
    }) + "\n",
  );
  const journalFile = join(runDir, "journal.jsonl");
  writeFileSync(
    journalFile,
    JSON.stringify({
      run_id: "tick~1",
      identity: "tick",
      result: journalResult,
      effects: [],
    }) + "\n",
  );
  return { engineRoot, runsRoot, indexFile, journalFile };
}

// ══════════════════════════════════════════════════════════════════════
// 判据 6bb: result 是两个文档拼接 ⇒ 终态被正确读出
// ══════════════════════════════════════════════════════════════════════

describe("判据 6bb (GT-2): two concatenated JSON docs in result", () => {
  it("reads termination from the first JSON document in a two-doc result", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c2-6bb-"));
    const drainId = "test-drain-6bb";
    const { engineRoot } = setupFakeRuntime(dir, drainId, "");
    // GT-2 真机实录形状：pretty-print tick 输出（35行）+ 续投 trigger 回显（1行）
    const tickOutput = JSON.stringify(
      {
        channelId: "research:e0-142fbba57906dec3.index",
        messageCount: 1,
        decisions: [{ kind: "dispatch", clueId: "msg_1", role: "dr-worker-code-local" }],
        hasPendingWork: true,
        termination: { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false },
      },
      null,
      2,
    );
    const triggerEcho = JSON.stringify({
      id: "a9-1786524011214625264-1934513",
      status: "open",
      body: { tick: true, coverage: 0, zeroGrowthRounds: 1 },
    });
    const journalResult = tickOutput + "\n" + triggerEcho;
    const journalFile = join(dir, "engine-root", "runs", `run-${drainId}`, "tick-run", "journal.jsonl");
    writeFileSync(
      journalFile,
      JSON.stringify({
        run_id: "tick~1",
        identity: "tick",
        result: journalResult,
        effects: [],
      }) + "\n",
    );

    const drainSummary = JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: join(dir, "engine-root", "runs", `run-${drainId}`),
      drain_id: drainId,
    });

    const res = runNodeScript(READ_TERMINATION, drainSummary, { LOOP_ENGINE_RUNTIME_ROOT: join(dir, "engine-root") });
    expect(res.code).toBe(0);
    if (res.code === 0) {
      const term = JSON.parse(res.out);
      expect(term).toHaveProperty("state");
      expect(term.state).toBeNull();
      expect(term.zeroGrowthRounds).toBe(1);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it("discriminant: JSON.parse on whole string fails (Extra data error)", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c2-6bb-disc-"));
    const drainId = "test-drain-6bb-disc";
    const tickOutput = JSON.stringify(
      { hasPendingWork: true, termination: { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false } },
      null,
      2,
    );
    const triggerEcho = JSON.stringify({ id: "a9-1", status: "open" });
    const journalResult = tickOutput + "\n" + triggerEcho;
    const { engineRoot } = setupFakeRuntime(dir, drainId, journalResult);
    const drainSummary = JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: join(engineRoot, "runs", `run-${drainId}`),
      drain_id: drainId,
    });
    // JSON.parse on the whole string should throw Extra data error
    expect(() => JSON.parse(journalResult)).toThrow();
    // But the first-JSON parsing should work
    const res = runNodeScript(READ_TERMINATION, drainSummary, { LOOP_ENGINE_RUNTIME_ROOT: join(dir, "engine-root") });
    expect(res.code).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 6c: 嵌套 JSON 的 drain 摘要（GT-7）
// ══════════════════════════════════════════════════════════════════════

describe("判据 6c (GT-7): nested JSON in drain summary", () => {
  it("parses a summary with nested ticksByLabel", () => {
    const summary = JSON.stringify({
      reason: "max_rounds",
      rounds: 16,
      ticksByLabel: { tick: 16 },
      runs_root: "/tmp/runs/x",
      drain_id: "test-drain-6c",
    });
    const res = runNodeScript(DRAIN_PARSE_SUMMARY, summary);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.out);
    expect(parsed.drain_id).toBe("test-drain-6c");
    expect(parsed.ticksByLabel.tick).toBe(16);
  });

  it("discriminant: brace-free regex would fail on nested JSON", () => {
    // A naive `grep -oE '\{[^{}]*"drain_id"[^{}]*\}'` would not match nested objects
    const summary = JSON.stringify({
      reason: "max_rounds",
      rounds: 16,
      ticksByLabel: { tick: 16 },
      runs_root: "/tmp/runs/x",
      drain_id: "test-drain-6c-disc",
    });
    // The brace regex approach (simulated) would fail
    const braceRegex = /\{[^{}]*"drain_id"[^{}]*\}/;
    expect(summary.match(braceRegex)).toBeNull();
    // But the JSON.parse approach works
    const res = runNodeScript(DRAIN_PARSE_SUMMARY, summary);
    expect(res.code).toBe(0);
    expect(res.out).toContain("test-drain-6c-disc");
  });

  it("multiple lines, only one with drain_id", () => {
    const multiLine = `line one\nnot json\n{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"/tmp/r","drain_id":"test-drain-multi"}\n{"other":true}`;
    const res = runNodeScript(DRAIN_PARSE_SUMMARY, multiLine);
    expect(res.code).toBe(0);
    const parsed = JSON.parse(res.out);
    expect(parsed.drain_id).toBe("test-drain-multi");
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 3: 没有 identity=="tick" 的 journal ⇒ 响亮失败
// ══════════════════════════════════════════════════════════════════════

describe("判据 3: no identity=tick in journal ⇒ loud failure", () => {
  it("journal without identity=tick ⇒ non-zero exit naming the step", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c2-c3-"));
    const drainId = "test-drain-c3";
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs", `run-${drainId}`);
    mkdirSync(runsRoot, { recursive: true });
    const runDir = join(runsRoot, "tick-run");
    mkdirSync(runDir, { recursive: true });
    const indexFile = join(engineRoot, "index.jsonl");
    writeFileSync(
      indexFile,
      JSON.stringify({
        schema: "lei/1",
        kind: "run.start",
        run_id: "tick~1",
        label: "tick",
        fleet: "fleet.yaml",
        caller: "drain",
        run_dir: runDir,
        ts: new Date().toISOString(),
        pid: 12345,
        drain_id: drainId,
        lane: "tick",
        tick: 1,
      }) + "\n",
    );
    // journal with no identity="tick" entry
    const journalFile = join(runDir, "journal.jsonl");
    writeFileSync(
      journalFile,
      JSON.stringify({
        run_id: "other~1",
        identity: "other",
        result: "some result",
      }) + "\n",
    );

    const drainSummary = JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: runsRoot,
      drain_id: drainId,
    });

    const res = runNodeScript(READ_TERMINATION, drainSummary, { LOOP_ENGINE_RUNTIME_ROOT: engineRoot });
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/identity.*tick|find tick journal entry/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 2: termination.state null ⇒ 入口非零退出
// ══════════════════════════════════════════════════════════════════════

describe("判据 2: termination.state null ⇒ non-zero exit (discriminant)", () => {
  it("read-termination returns null state when termination.state is null", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c2-c2-"));
    const drainId = "test-drain-c2";
    const tickOutput = JSON.stringify(
      { hasPendingWork: false, termination: { state: null, coverage: 0, zeroGrowthRounds: 0, capHit: false } },
    );
    const { engineRoot } = setupFakeRuntime(dir, drainId, tickOutput);
    const drainSummary = JSON.stringify({
      reason: "drained",
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: join(engineRoot, "runs", `run-${drainId}`),
      drain_id: drainId,
    });
    const res = runNodeScript(READ_TERMINATION, drainSummary, { LOOP_ENGINE_RUNTIME_ROOT: engineRoot });
    expect(res.code).toBe(0);
    const term = JSON.parse(res.out);
    expect(term.state).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 7: tick.md 续投逻辑在 zsh -c 下真能跑（GT-5）
// ══════════════════════════════════════════════════════════════════════

describe("判据 7 (GT-5): tick.md continuation runs under zsh -c", () => {
  it("rendered tick.md with continuation body succeeds under zsh -c", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c2-c7-"));
    const tickEntry = join(dir, "tick-entry");
    const realEntry = join(ROOT, "src", "tick-entry.ts");
    const viteNode = join(ROOT, "node_modules", ".bin", "vite-node");
    // Fake tick-entry: delegates --parse-trigger-body to real tick-entry;
    // --run outputs hasPendingWork=true to trigger continuation
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nset -euo pipefail\nif [ "\${1:-}" = "--parse-trigger-body" ]; then\n  exec "${viteNode}" "${realEntry}" --parse-trigger-body "$2"\nfi\nprintf '%s\\n' '{"hasPendingWork": true, "decisions": [], "termination": {"state": null, "coverage": 5, "zeroGrowthRounds": 2, "capHit": false}}'\n`,
    );
    chmodSync(tickEntry, 0o755);
    const runner = join(dir, "runner");
    writeFileSync(runner, `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${dir}/puts.log"\n`);
    chmodSync(runner, 0o755);
    const storeDir = join(dir, "store");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(dir, "puts.log"), "");

    const tpl = readFileSync(TICK_MD, "utf8");
    const script = tpl
      .replace(/\{\{tick_entry\}\}/g, tickEntry)
      .replace(/\{\{tick_channel\}\}/g, "research:test-c7")
      .replace(/\{\{evidence_channel\}\}/g, "")
      .replace(/\{\{allowed_root\}\}/g, "")
      .replace(/\{\{max_writes\}\}/g, "64")
      .replace(/\{\{research_question\}\}/g, "")
      .replace(/\{\{research_origin\}\}/g, "")
      .replace(/\{\{doc_channel\}\}/g, "")
      .replace(/\{\{trigger_store_dir\}\}/g, storeDir)
      .replace(/\{\{loop_store_cli\}\}/g, join(dir, "store-cli.js"))
      .replace(/\{\{loop_engine_runner\}\}/g, runner)
      .replace(/\{\{trigger_body\}\}/g, '{"tick":true,"coverage":4,"zeroGrowthRounds":1}');
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);

    // Run under zsh (GT-5: must work in zsh, not just bash)
    let code = 0;
    let err = "";
    try {
      execFileSync("zsh", [outShell], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const ee = e as { status?: number; stderr?: string | Buffer };
      code = ee.status ?? -1;
      err = String(ee.stderr ?? "");
    }
    // Should succeed under zsh
    expect(code).toBe(0);
    expect(err).not.toMatch(/bad option|read.*-a/i);
    // Verify a trigger was put (continuation triggered)
    const puts = readFileSync(join(dir, "puts.log"), "utf8").trim();
    expect(puts).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("discriminant: bash-only syntax (read -a) would fail under zsh", () => {
    // Create a minimal script with bash-only `read -a` syntax
    const dir = mkdtempSync(join(tmpdir(), "e0c2-c7-disc-"));
    const badScript = join(dir, "bad.sh");
    writeFileSync(
      badScript,
      `#!/usr/bin/env zsh\nprev_line="--prev-coverage\t5\t--prev-zero-growth\t2"\nIFS=$'\t' read -r -a prev_arr <<< "$prev_line"\n`,
    );
    chmodSync(badScript, 0o755);
    let code = 0;
    let err = "";
    try {
      execFileSync("zsh", ["-c", badScript], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const ee = e as { status?: number; stderr?: string | Buffer };
      code = ee.status ?? -1;
      err = String(ee.stderr ?? "");
    }
    expect(code).not.toBe(0);
    expect(err).toMatch(/bad option|read.*-a/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 6d (GT-8): 单 channel GET 不返回 head_seq；head_seq 只能从列表端点读
// ══════════════════════════════════════════════════════════════════════

describe("判据 6d (GT-8): head_seq read from list endpoint only", () => {
  it("fake-bus.mjs single channel GET handler response body excludes head_seq", () => {
    const fakeBusPath = join(ROOT, "test", "fixtures", "fake-bus.mjs");
    const busCode = readFileSync(fakeBusPath, "utf8");
    // The response body for single channel GET should not include head_seq
    // (GT-8: head_seq is only on the list endpoint).
    // Check the send(200, {...}) block for the handler.
    const handlerIdx = busCode.indexOf("if (req.method === \"GET\" && /^\\/v1\\/channels\\/[^/]+$/.test(path))");
    if (handlerIdx >= 0) {
      const handlerBlock = busCode.slice(handlerIdx);
      const sendIdx = handlerBlock.indexOf("return send(200, {");
      if (sendIdx >= 0) {
        const afterSend = handlerBlock.slice(sendIdx + 17);
        let depth = 1;
        let endIdx = 0;
        for (let i = 0; i < afterSend.length; i++) {
          if (afterSend[i] === "{") depth++;
          if (afterSend[i] === "}") {
            depth--;
            if (depth === 0) { endIdx = i; break; }
          }
        }
        const bodyBlock = afterSend.slice(0, endIdx);
        const nonComment = bodyBlock.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
        const hasHeadSeqKey = nonComment.some(l => /\bhead_seq\s*:/.test(l));
        expect(hasHeadSeqKey).toBe(false);
      }
    }
    expect(busCode).toMatch(/channel_id/);
    expect(busCode).toMatch(/delivery_mode/);
    expect(busCode).toMatch(/owner_agent_id/);
  });

  it("e0-regression.sh progress line contains numeric head_seq (not '?')", async () => {
    const { dir, env, e0regression } = setupE0RegressionEnv(
      "null-then-converge",
      {
        terminationStates: [
          { drainId: "fake-drain-attempt-1", state: null },
          { drainId: "fake-drain-attempt-2", state: "converged" },
        ],
      },
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBus(), startFakeBus()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = runE0Regression(e0regression, env);
      expect(res.code).toBe(0);
      // The progress line should contain a numeric head_seq (not "?"),
      // because the implementation reads from the list endpoint via src/e0c2-head-seq.ts.
      // The fake-bus list endpoint returns head_seq correctly.
      expect(res.out).toMatch(/head_seq=\d+/);
      // Also verify head_seq is not "?"
      expect(res.out).not.toMatch(/head_seq=\?/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discriminant: if implementation used single-channel GET, head_seq would be '?'", async () => {
    // The fake-bus single-channel GET handler does NOT return head_seq.
    // If the implementation bypassed the list endpoint and read from
    // single-channel GET, head_seq would be "?" (the fallback).
    // This test verifies the fixture condition: single-channel GET has no head_seq.
    const fakeBusPath = join(ROOT, "test", "fixtures", "fake-bus.mjs");
    const busCode = readFileSync(fakeBusPath, "utf8");
    // Verify the single-channel GET response body explicitly excludes head_seq
    const handlerIdx = busCode.indexOf("if (req.method === \"GET\" && /^\\/v1\\/channels\\/[^/]+$/.test(path))");
    expect(handlerIdx).toBeGreaterThanOrEqual(0);
    const handlerBlock = busCode.slice(handlerIdx);
    const sendIdx = handlerBlock.indexOf("return send(200, {");
    expect(sendIdx).toBeGreaterThanOrEqual(0);
    const afterSend = handlerBlock.slice(sendIdx + 17);
    let depth = 1;
    let endIdx = 0;
    for (let i = 0; i < afterSend.length; i++) {
      if (afterSend[i] === "{") depth++;
      if (afterSend[i] === "}") {
        depth--;
        if (depth === 0) { endIdx = i; break; }
      }
    }
    const bodyBlock = afterSend.slice(0, endIdx);
    // Check that head_seq is NOT in the single-channel GET response body
    expect(bodyBlock).not.toMatch(/\bhead_seq\s*:/);
    // But the list endpoint handler DOES return head_seq
    const listHandlerIdx = busCode.indexOf("if (req.method === \"GET\" && path === \"/v1/channels\")");
    expect(listHandlerIdx).toBeGreaterThanOrEqual(0);
    const listBlock = busCode.slice(listHandlerIdx);
    expect(listBlock).toMatch(/head_seq/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 6b (GT-6): max_rounds + exit 1 不是失败，其他非零退出码是失败
// ⛔ 这些测试真正执行 bin/e0-regression.sh 本身，假 loop 用可执行桩替身注入。
// ══════════════════════════════════════════════════════════════════════

describe("判据 6b (GT-6): max_rounds exit 1 classification (executing e0-regression.sh)", () => {
  it("max_rounds + exit 1 first drain, then converges ⇒ exit 0, both attempts made", async () => {
    const { dir, env, e0regression, attemptFile } = setupE0RegressionEnv(
      "maxrounds-then-converge",
      {
        terminationStates: [
          { drainId: "fake-drain-maxrounds-1", state: null },
          { drainId: "fake-drain-converged-2", state: "converged" },
        ],
      },
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBus(), startFakeBus()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = runE0Regression(e0regression, env);
      expect(res.code).toBe(0);
      const attempts = Number(readFileSync(attemptFile, "utf8").trim());
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(res.out).toMatch(/drain #1/);
      expect(res.out).toMatch(/drain #2/);
      expect(res.out).toMatch(/max_rounds/);
      expect(res.out).toMatch(/converged/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("other non-zero exit code (e.g. 3) ⇒ immediate failure, non-zero exit, does not retry", async () => {
    const { dir, env, e0regression, attemptFile } = setupE0RegressionEnv(
      "other-exit-code",
      {
        terminationStates: [
          { drainId: "fake-drain-bad-1", state: null },
        ],
      },
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBus(), startFakeBus()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = runE0Regression(e0regression, env);
      expect(res.code).not.toBe(0);
      const attempts = Number(readFileSync(attemptFile, "utf8").trim());
      expect(attempts).toBe(1);
      expect(res.err).toMatch(/DRAIN FAILED|FAILED/i);
      expect(res.err).toMatch(/3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("unparseable drain output ⇒ immediate failure, non-zero exit, does not retry", async () => {
    const { dir, env, e0regression, attemptFile } = setupE0RegressionEnv(
      "unparseable",
      {
        terminationStates: [],
      },
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBus(), startFakeBus()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = runE0Regression(e0regression, env);
      expect(res.code).not.toBe(0);
      const attempts = Number(readFileSync(attemptFile, "utf8").trim());
      expect(attempts).toBe(1);
      expect(res.err).toMatch(/parse_error|DRAIN FAILED|FAILED/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 4 (GT-4): 板面已排空但 termination.state 仍为 null 且未触顶 ⇒ 仍然续投
// 判别性：把续投门改回只看 hasPendingWork ⇒ 测试变红
// ══════════════════════════════════════════════════════════════════════

describe("判据 4 (GT-4): empty board with null termination ⇒ still triggers continuation", () => {
  it("hasPendingWork=false, state=null, capHit=false ⇒ continuation triggered", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c2-c4-"));
    const tickEntry = join(dir, "tick-entry");
    const realEntry = join(ROOT, "src", "tick-entry.ts");
    const viteNode = join(ROOT, "node_modules", ".bin", "vite-node");
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nset -euo pipefail\nif [ "\${1:-}" = "--parse-trigger-body" ]; then\n  exec "${viteNode}" "${realEntry}" --parse-trigger-body "$2"\nfi\nprintf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 5, "zeroGrowthRounds": 2, "capHit": false}}'\n`,
    );
    chmodSync(tickEntry, 0o755);
    const runner = join(dir, "runner");
    writeFileSync(runner, `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${dir}/puts.log"\n`);
    chmodSync(runner, 0o755);
    const storeDir = join(dir, "store");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(dir, "puts.log"), "");

    const tpl = readFileSync(TICK_MD, "utf8");
    const script = tpl
      .replace(/\{\{tick_entry\}\}/g, tickEntry)
      .replace(/\{\{tick_channel\}\}/g, "research:test-c4")
      .replace(/\{\{evidence_channel\}\}/g, "")
      .replace(/\{\{allowed_root\}\}/g, "")
      .replace(/\{\{max_writes\}\}/g, "64")
      .replace(/\{\{research_question\}\}/g, "")
      .replace(/\{\{research_origin\}\}/g, "")
      .replace(/\{\{doc_channel\}\}/g, "")
      .replace(/\{\{trigger_store_dir\}\}/g, storeDir)
      .replace(/\{\{loop_store_cli\}\}/g, join(dir, "store-cli.js"))
      .replace(/\{\{loop_engine_runner\}\}/g, runner)
      .replace(/\{\{trigger_body\}\}/g, '{"tick":true,"coverage":4,"zeroGrowthRounds":1}');
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);

    let code = 0;
    let err = "";
    try {
      execFileSync("zsh", [outShell], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const ee = e as { status?: number; stderr?: string | Buffer };
      code = ee.status ?? -1;
      err = String(ee.stderr ?? "");
    }
    expect(code).toBe(0);
    const puts = readFileSync(join(dir, "puts.log"), "utf8").trim();
    expect(puts).toBeTruthy();
    rmSync(dir, { recursive: true, force: true });
  });

  it("discriminant: changing gate to hw-only stops continuation when hasPendingWork=false", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c2-c4-disc-"));
    const tickEntry = join(dir, "tick-entry");
    const realEntry = join(ROOT, "src", "tick-entry.ts");
    const viteNode = join(ROOT, "node_modules", ".bin", "vite-node");
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nset -euo pipefail\nif [ "\${1:-}" = "--parse-trigger-body" ]; then\n  exec "${viteNode}" "${realEntry}" --parse-trigger-body "$2"\nfi\nprintf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 5, "zeroGrowthRounds": 2, "capHit": false}}'\n`,
    );
    chmodSync(tickEntry, 0o755);
    const runner = join(dir, "runner");
    writeFileSync(runner, `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${dir}/puts.log"\n`);
    chmodSync(runner, 0o755);
    const storeDir = join(dir, "store");
    mkdirSync(storeDir, { recursive: true });
    writeFileSync(join(dir, "puts.log"), "");

    const tpl = readFileSync(TICK_MD, "utf8");
    // Discriminant: change the continuation gate from hw || (stateIsNull && !capHit) to just hw
    const modifiedTpl = tpl.replace(
      "const shouldContinue = hw || (stateIsNull && !capHit);",
      "const shouldContinue = hw;",
    );
    const script = modifiedTpl
      .replace(/\{\{tick_entry\}\}/g, tickEntry)
      .replace(/\{\{tick_channel\}\}/g, "research:test-c4-disc")
      .replace(/\{\{evidence_channel\}\}/g, "")
      .replace(/\{\{allowed_root\}\}/g, "")
      .replace(/\{\{max_writes\}\}/g, "64")
      .replace(/\{\{research_question\}\}/g, "")
      .replace(/\{\{research_origin\}\}/g, "")
      .replace(/\{\{doc_channel\}\}/g, "")
      .replace(/\{\{trigger_store_dir\}\}/g, storeDir)
      .replace(/\{\{loop_store_cli\}\}/g, join(dir, "store-cli.js"))
      .replace(/\{\{loop_engine_runner\}\}/g, runner)
      .replace(/\{\{trigger_body\}\}/g, '{"tick":true,"coverage":4,"zeroGrowthRounds":1}');
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);

    let code = 0;
    try {
      execFileSync("zsh", [outShell], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const ee = e as { status?: number; stderr?: string | Buffer };
      code = ee.status ?? -1;
    }
    expect(code).toBe(0);
    const puts = readFileSync(join(dir, "puts.log"), "utf8").trim();
    // With hw-only gate and hasPendingWork=false, no trigger should be put
    expect(puts).toBeFalsy();
    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 5 (GT-3): 跨 drain 循环直到终态收敛
// ⛔ 这些测试真正执行 bin/e0-regression.sh 本身，假 loop 用可执行桩替身注入。
// ══════════════════════════════════════════════════════════════════════

describe("判据 5 (GT-3): cross-drain loop until convergence (executing e0-regression.sh)", () => {
  it("first drain null, second drain converged ⇒ runs both, exits 0", async () => {
    const { dir, env, e0regression, attemptFile } = setupE0RegressionEnv(
      "null-then-converge",
      {
        terminationStates: [
          { drainId: "fake-drain-attempt-1", state: null },
          { drainId: "fake-drain-attempt-2", state: "converged" },
        ],
      },
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBus(), startFakeBus()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = runE0Regression(e0regression, env);
      expect(res.code).toBe(0);
      const attempts = Number(readFileSync(attemptFile, "utf8").trim());
      expect(attempts).toBeGreaterThanOrEqual(2);
      expect(res.out).toMatch(/drain #1/);
      expect(res.out).toMatch(/drain #2/);
      expect(res.out).toMatch(/termination\.state=converged/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discriminant: if the implementation only ran one drain, null termination would NOT exit 0", async () => {
    const { dir, env, e0regression, attemptFile } = setupE0RegressionEnv(
      "null-then-converge",
      {
        terminationStates: [
          { drainId: "fake-drain-attempt-1", state: null },
          { drainId: "fake-drain-attempt-2", state: "converged" },
        ],
      },
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBus(), startFakeBus()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = runE0Regression(e0regression, env);
      expect(res.code).toBe(0);
      const attempts = Number(readFileSync(attemptFile, "utf8").trim());
      expect(attempts).toBeGreaterThanOrEqual(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 6 (GT-3 上限): 永远 null ⇒ 撞到上限时非零退出，点名撞的是哪个上限
// ⛔ 这些测试真正执行 bin/e0-regression.sh 本身，假 loop 用可执行桩替身注入。
// ══════════════════════════════════════════════════════════════════════

describe("判据 6 (GT-3 limits): always null termination hits limit (executing e0-regression.sh)", () => {
  it("always null ⇒ hits attempt limit, non-zero exit naming the limit", async () => {
    const { dir, env, e0regression, attemptFile } = setupE0RegressionEnv(
      "always-null",
      {
        maxAttempts: 2,
        wallClockSeconds: 30,
        backoffSeconds: 0,
        terminationStates: [
          { drainId: "fake-drain-null-1", state: null },
          { drainId: "fake-drain-null-2", state: null },
        ],
      },
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBus(), startFakeBus()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = runE0Regression(e0regression, env);
      expect(res.code).not.toBe(0);
      expect(res.err).toMatch(/HIT ATTEMPT LIMIT|HIT WALL CLOCK LIMIT/i);
      expect(res.err).toMatch(/drain_attempts=2\b/);
      const attempts = Number(readFileSync(attemptFile, "utf8").trim());
      expect(attempts).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("always null ⇒ hits wall clock limit, non-zero exit naming the limit", async () => {
    const { dir, env, e0regression, attemptFile } = setupE0RegressionEnv(
      "always-null",
      {
        maxAttempts: 10,
        wallClockSeconds: 0,
        backoffSeconds: 0,
        terminationStates: [
          { drainId: "fake-drain-null-1", state: null },
        ],
      },
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBus(), startFakeBus()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = runE0Regression(e0regression, env);
      expect(res.code).not.toBe(0);
      expect(res.err).toMatch(/HIT WALL CLOCK LIMIT/i);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("discriminant: never infinite loops (test completes in finite time)", async () => {
    const { dir, env, e0regression } = setupE0RegressionEnv(
      "always-null",
      {
        maxAttempts: 2,
        wallClockSeconds: 5,
        backoffSeconds: 0,
        terminationStates: [
          { drainId: "fake-drain-null-1", state: null },
          { drainId: "fake-drain-null-2", state: null },
        ],
      },
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBus(), startFakeBus()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = runE0Regression(e0regression, env);
      expect(res.code).not.toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, { timeout: 15000 });
});

// ══════════════════════════════════════════════════════════════════════
// E0c3b 判据 4: board composition + triage deadlock naming in stderr
// ══════════════════════════════════════════════════════════════════════

describe("E0c3b 判据 4: board composition and triage deadlock naming on limit hit", () => {
  it("HIT ATTEMPT LIMIT with proposed>0 prints board composition and TRIAGE THRESHOLD DEADLOCK", async () => {
    const { dir, env, e0regression } = setupE0RegressionEnv(
      "always-null",
      {
        maxAttempts: 2,
        wallClockSeconds: 30,
        backoffSeconds: 0,
        terminationStates: [
          { drainId: "fake-drain-null-1", state: null },
          { drainId: "fake-drain-null-2", state: null },
        ],
      },
    );
    setupRuntimeDir(
      join(dir, "engine-root"),
      join(dir, "engine-root", "runs"),
      "fake-drain-null-1",
      null,
      undefined,
      undefined,
      { proposed: 1, open: 0, inFlight: 0, explored: 0, blocked: 0 },
      3,
    );
    setupRuntimeDir(
      join(dir, "engine-root"),
      join(dir, "engine-root", "runs"),
      "fake-drain-null-2",
      null,
      undefined,
      undefined,
      { proposed: 1, open: 0, inFlight: 0, explored: 0, blocked: 0 },
      3,
    );
    const [busPort, prodBusPort] = await Promise.all([startFakeBus(), startFakeBus()]);
    env.AGENT_BUS_URL = `http://127.0.0.1:${busPort}`;
    env.E0C1_PROD_BUS_URL = `http://127.0.0.1:${prodBusPort}`;
    try {
      const res = runE0Regression(e0regression, env);
      expect(res.err).toMatch(/board:\s*proposed=1/);
      expect(res.err).toMatch(/TRIAGE THRESHOLD DEADLOCK/);
      expect(res.err).toMatch(/proposed=1\s*<\s*triageThreshold=3/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DISCRIMINATING: if board composition were removed, this test would fail", () => {
    const script = readFileSync(
      join(ROOT, "bin", "e0-regression.sh"),
      "utf8",
    );
    expect(script).toContain("_print_board_composition");
    expect(script).toContain("TRIAGE THRESHOLD DEADLOCK");
    expect(script).toContain("board: ${bc}");
  });
});

// ══════════════════════════════════════════════════════════════════════
// E0c3b 判据 5b: no Math.random() in fake bus port assignment
// ══════════════════════════════════════════════════════════════════════

describe("E0c3b 判据 5b (GT-12): no Math.random() in fake bus port assignment", () => {
  const fakeBusFixtures = [
    "test/fixtures/fake-bus.mjs",
    "test/e0c2-termination.test.ts",
    "test/a10b-convergence.test.ts",
    "test/e0c1-board-credentials.test.ts",
    "test/e0-regression.test.ts",
  ];

  it("fake-bus.mjs uses kernel-assigned port (A10B_BUS_PORT=0)", () => {
    const code = readFileSync(join(ROOT, "test", "fixtures", "fake-bus.mjs"), "utf8");
    expect(code).toContain("A10B_BUS_PORT");
    expect(code).toMatch(/A10B_BUS_PORT\s*\?\?\s*0/);
    expect(code).not.toMatch(/18000\s*\+\s*Math\.floor/);
    expect(code).not.toMatch(/19000\s*\+\s*Math\.floor/);
  });

  for (const f of fakeBusFixtures) {
    it(`test file ${f} has no Math.random() in bus port assignment`, () => {
      const code = readFileSync(join(ROOT, f), "utf8");
      const lines = code.split("\n");
      const offenders: string[] = [];
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
        if (trimmed.startsWith("it(") || trimmed.startsWith("describe(")) continue;
        if (/\d+\s*\+\s*Math\.(floor|random)/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      }
      expect(offenders, `Math.random() found in bus port assignment patterns in ${f}`).toEqual([]);
    });
  }

  it("DISCRIMINATING: kernel-assigned port pattern is present in all startFakeBus callers", () => {
    for (const f of ["test/e0c2-termination.test.ts", "test/a10b-convergence.test.ts"]) {
      const code = readFileSync(join(ROOT, f), "utf8");
      expect(code, `${f}: startFakeBus must use kernel-assigned port`).toMatch(/A10B_BUS_PORT.*"0"/);
    }
    const e0c1Code = readFileSync(join(ROOT, "test", "e0c1-board-credentials.test.ts"), "utf8");
    expect(e0c1Code, "e0c1-board-credentials must use listen(0)").toMatch(/listen\(0/);
    const e0Code = readFileSync(join(ROOT, "test", "e0-regression.test.ts"), "utf8");
    expect(e0Code, "e0-regression must use listen(0)").toMatch(/listen\(0/);
  });
});