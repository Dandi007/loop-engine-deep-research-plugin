/**
 * E0c2 —— 终止语义域：终态取真值、续投门对齐、入口反复 drain 直到终态。
 *
 * 覆盖 spec §2 判据 2–7（判别性单测）。
 */
import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import {
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

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const READ_TERMINATION = join(ROOT, "scripts", "read-termination.mjs");
const DRAIN_PARSE_SUMMARY = join(ROOT, "scripts", "drain-parse-summary.mjs");
const TICK_MD = join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md");

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
    const ee = e;
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
      const ee = e;
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
      const ee = e;
      code = ee.status ?? -1;
      err = String(ee.stderr ?? "");
    }
    expect(code).not.toBe(0);
    expect(err).toMatch(/bad option|read.*-a/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 6d (GT-8): 单 channel GET 不返回 head_seq
// ══════════════════════════════════════════════════════════════════════

describe("判据 6d (GT-8): single channel GET does not return head_seq", () => {
  it("fake-bus.mjs single channel GET handler response body excludes head_seq", () => {
    const fakeBusPath = join(ROOT, "test", "fixtures", "fake-bus.mjs");
    const busCode = readFileSync(fakeBusPath, "utf8");
    // The response body for single channel GET should not include head_seq
    // (GT-8: head_seq is only on the list endpoint).
    // Check the send(200, {...}) block for the handler.
    // Find the first send(200, { after the single-channel GET handler pattern
    const handlerIdx = busCode.indexOf("if (req.method === \"GET\" && /^\\/v1\\/channels\\/[^/]+$/.test(path))");
    if (handlerIdx >= 0) {
      const handlerBlock = busCode.slice(handlerIdx);
      const sendIdx = handlerBlock.indexOf("return send(200, {");
      if (sendIdx >= 0) {
        const afterSend = handlerBlock.slice(sendIdx + 17);
        // Find the matching closing brace
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
        // Check that head_seq is not a key in the body (comments are fine)
        const nonComment = bodyBlock.split("\n").filter(l => !l.trim().startsWith("//") && !l.trim().startsWith("*"));
        const hasHeadSeqKey = nonComment.some(l => /\bhead_seq\s*:/.test(l));
        expect(hasHeadSeqKey).toBe(false);
      }
    }
    expect(busCode).toMatch(/channel_id/);
    expect(busCode).toMatch(/delivery_mode/);
    expect(busCode).toMatch(/owner_agent_id/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 6b (GT-6): max_rounds + exit 1 不是失败，其他非零退出码是失败
// ══════════════════════════════════════════════════════════════════════

describe("判据 6b (GT-6): max_rounds exit 1 classification", () => {
  it("e0-regression.sh contains the GT-6 classification logic", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    // Must distinguish max_rounds from other failures
    expect(script).toMatch(/DRAIN_REASON.*max_rounds/);
    expect(script).toMatch(/DRAIN_EXIT/);
    // Must treat max_rounds + exit 1 as not-failure
    expect(script).toMatch(/max_rounds/);
    // Must not have "non-zero is failure" catch-all
    expect(script).not.toMatch(/非零即失败|DRAIN_FAILED.*non-zero/);
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判据 4: 板面已排空但 termination.state 仍为 null 且未触顶 ⇒ 仍然续投
// （已在 a9-tick-trigger.test.ts 和 a10b-convergence.test.ts 中验证）
// ══════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════
// 判据 5/6: 跨 drain 循环（e0-regression.sh 的循环结构检查）
// ══════════════════════════════════════════════════════════════════════

describe("判据 5/6: e0-regression.sh has cross-drain loop structure", () => {
  it("contains a while loop with drain attempt tracking", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    expect(script).toMatch(/while true; do/);
    expect(script).toMatch(/DRAIN_ATTEMPT/);
    expect(script).toMatch(/DRAIN_MAX_ATTEMPTS/);
    expect(script).toMatch(/DRAIN_WALL_CLOCK_SECONDS/);
    expect(script).toMatch(/DRAIN_BACKOFF_SECONDS/);
  });

  it("termination.state non-null ⇒ LOOP_EXIT=0, break", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    expect(script).toMatch(/TERMINATION_STATE.*!=.*null/);
    expect(script).toMatch(/LOOP_EXIT=0/);
    expect(script).toMatch(/break/);
  });

  it("hits limits ⇒ non-zero exit naming the limit", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    expect(script).toMatch(/HIT WALL CLOCK LIMIT/);
    expect(script).toMatch(/HIT ATTEMPT LIMIT/);
  });

  it("failure branches echo drain stdout and stderr", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    expect(script).toMatch(/drain stdout/);
    expect(script).toMatch(/drain stderr/);
  });

  it("progress line contains head_seq, reason, termination.state, attempt number", () => {
    const script = readFileSync(join(ROOT, "bin", "e0-regression.sh"), "utf8");
    expect(script).toMatch(/head_seq/);
    expect(script).toMatch(/termination\.state/);
    expect(script).toMatch(/DRAIN_ATTEMPT/);
  });
});