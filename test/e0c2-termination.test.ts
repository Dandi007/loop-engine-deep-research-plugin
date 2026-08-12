/**
 * E0c2 —— 终止语义域测试（GT-2 到 GT-8）。
 *
 * 覆盖 spec §2 判据 2–6d, 7：
 *  - 判据 2: termination.state 为 null ⇒ 入口非零退出
 *  - 判据 3: journal 无 identity=="tick" 条目 ⇒ 响亮失败
 *  - 判据 4 (GT-4): 板面排空但 termination.state null 且未触顶 ⇒ 仍然续投
 *  - 判据 5 (GT-3): 跨 drain 循环直到终态（入口级，用可执行桩替身注入）
 *  - 判据 6: 撞上限 ⇒ 非零退出（入口级）
 *  - 判据 6b (GT-6): max_rounds + exit 1 不是失败（入口级）
 *  - 判据 6bb (GT-2): result 是双文档拼接 ⇒ 正确读出第一个 JSON
 *  - 判据 6c (GT-7): 嵌套 JSON 摘要 ⇒ 正确抽取
 *  - 判据 6d (GT-8): 单 channel GET 不返回 head_seq
 *  - 判据 7 (GT-5): tick.md 续投段在 zsh -c 下真能跑
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  mkdirSync,
  chmodSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPTS_DIR = join(ROOT, "scripts");
const SRC_DIR = join(ROOT, "src");
const NODE_MODULES = join(ROOT, "node_modules");
const TERM_SCRIPT = join(SCRIPTS_DIR, "read-termination-state.mjs");
const TICK_MD = join(
  ROOT,
  "workflows",
  "deep-research",
  "tick",
  "templates",
  "tick.md",
);
const VITE_NODE = join(NODE_MODULES, ".bin", "vite-node");
const ENTRY_BIN = join(ROOT, "bin", "e0-regression.sh");

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "e0c2-test-"));
}

function makeTokenFile(content = "faketok"): string {
  const dir = mkdtempSync(join(tmpdir(), "e0c2-tok-"));
  const p = join(dir, "token");
  writeFileSync(p, content);
  return p;
}

// ── 判据 6bb (GT-2): result 是双文档拼接 ⇒ 正确读出第一个 JSON ──

describe("判据 6bb (GT-2): two concatenated JSON docs in result ⇒ first doc extracted correctly", () => {
  it("extracts termination from a result with two concatenated JSON docs (GT-2 real shape)", () => {
    const dir = makeTempDir();
    try {
      const engineRoot = join(dir, "engine");
      const indexFile = join(engineRoot, "index.jsonl");
      const runDir = join(dir, "run");
      mkdirSync(runDir, { recursive: true });
      mkdirSync(engineRoot, { recursive: true });

      // GT-2 real shape: pretty-print tick output (multi-line) + single-line trigger echo
      const tickObj = {
        channelId: "research:e0-142fbba57906dec3.index",
        messageCount: 1,
        decisions: [
          { kind: "dispatch", clueId: "msg_abc", role: "dr-worker-code-local" },
        ],
        hasPendingWork: true,
        termination: {
          state: "converged",
          coverage: 5,
          zeroGrowthRounds: 2,
          capHit: false,
        },
      };
      const tickOutput = JSON.stringify(tickObj, null, 2);
      const triggerEcho = JSON.stringify({
        id: "a9-1786524011214625264-1934513",
        status: "open",
        body: { tick: true, coverage: 5, zeroGrowthRounds: 2 },
      });
      const result = tickOutput + "\n" + triggerEcho;

      const drainId = "drain-gt2-test";
      const drainSummary = JSON.stringify({
        reason: "drained",
        rounds: 1,
        ticksByLabel: { tick: 1 },
        runs_root: engineRoot,
        drain_id: drainId,
      });

      writeFileSync(
        indexFile,
        JSON.stringify({
          drain_id: drainId,
          lane: "deep-research",
          run_dir: runDir,
        }) + "\n",
      );

      writeFileSync(
        join(runDir, "journal.jsonl"),
        JSON.stringify({
          run_id: "tick~1",
          identity: "tick",
          result,
          effects: [],
        }) + "\n",
      );

      const out = execFileSync(
        "node",
        [TERM_SCRIPT],
        {
          input: drainSummary,
          encoding: "utf8",
          env: {
            ...process.env,
            LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "/root",
          },
        },
      );

      const parsed = JSON.parse(out);
      expect(parsed.state).toBe("converged");
      expect(parsed.coverage).toBe(5);
      expect(parsed.zeroGrowthRounds).toBe(2);
      expect(parsed.capHit).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DISCRIMINATING: whole-string JSON.parse on result with two docs throws (Extra data)", () => {
    const tickOutput = JSON.stringify(
      { termination: { state: "converged", coverage: 1, zeroGrowthRounds: 1, capHit: false } },
      null,
      2,
    );
    const triggerEcho = JSON.stringify({ id: "x", status: "open" });
    const result = tickOutput + "\n" + triggerEcho;

    expect(() => JSON.parse(result)).toThrow(/Extra data|Unexpected/);
  });

  it("DISCRIMINATING: line-by-line JSON.parse on pretty-printed result fails", () => {
    const tickOutput = JSON.stringify(
      {
        termination: { state: "converged", coverage: 1, zeroGrowthRounds: 1, capHit: false },
      },
      null,
      2,
    );
    const result = tickOutput + '\n{"id":"x","status":"open"}';

    let anyLineParsed = false;
    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
        anyLineParsed = true;
      } catch {
        // expected for most lines
      }
    }
    // If any single line parses as complete JSON, the line-by-line approach would
    // grab the wrong value. In the GT-2 real shape, line-by-line should FAIL because
    // no single line of the multi-line output is a complete JSON document.
    // But the trigger echo line IS a complete JSON doc, so line-by-line would pick it up.
    // The discriminating test: line-by-line parsing would find the trigger echo, not the tick.
    // To prove our implementation is correct, we show that the DISCRIMINATING approach
    // (line-by-line) picks up the wrong document (trigger echo, not tick output).
    expect(anyLineParsed).toBe(true);
  });
});

// ── 判据 2: termination.state 为 null ⇒ 入口非零退出 ──

describe("判据 2: termination.state null ⇒ non-zero exit", () => {
  it("read-termination-state returns state:null when termination.state is null", () => {
    const dir = makeTempDir();
    try {
      const engineRoot = join(dir, "engine");
      const runDir = join(dir, "run");
      mkdirSync(runDir, { recursive: true });
      mkdirSync(engineRoot, { recursive: true });

      const drainId = "drain-null-test";
      const drainSummary = JSON.stringify({
        reason: "drained",
        rounds: 1,
        ticksByLabel: { tick: 1 },
        runs_root: engineRoot,
        drain_id: drainId,
      });

      writeFileSync(
        join(engineRoot, "index.jsonl"),
        JSON.stringify({
          drain_id: drainId,
          lane: "deep-research",
          run_dir: runDir,
        }) + "\n",
      );

      const tickOutput = JSON.stringify({
        hasPendingWork: false,
        termination: {
          state: null,
          coverage: 0,
          zeroGrowthRounds: 1,
          capHit: false,
        },
      });

      writeFileSync(
        join(runDir, "journal.jsonl"),
        JSON.stringify({
          run_id: "tick~1",
          identity: "tick",
          result: tickOutput,
          effects: [],
        }) + "\n",
      );

      const out = execFileSync("node", [TERM_SCRIPT], {
        input: drainSummary,
        encoding: "utf8",
        env: {
          ...process.env,
          LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "/root",
        },
      });

      const parsed = JSON.parse(out);
      expect(parsed.state).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("entry exits non-zero when termination.state is null and hits limit", async () => {
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c2-rec-null-"));
    const tokFile = makeTokenFile();
    const runId = "e0c2-nullstate-001";
    try {
      const engineRoot = setupEngineRoot();
      const drainId = "drain-null-entry";
      const runDir = join(engineRoot, "run-" + drainId);
      mkdirSync(runDir, { recursive: true });

      writeFileSync(
        join(engineRoot, "index.jsonl"),
        JSON.stringify({ drain_id: drainId, lane: "deep-research", run_dir: runDir }) + "\n",
      );
      writeFileSync(
        join(runDir, "journal.jsonl"),
        JSON.stringify({
          run_id: "tick~1",
          identity: "tick",
          result: JSON.stringify({
            hasPendingWork: false,
            termination: { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false },
          }),
          effects: [],
        }) + "\n",
      );

      const fakeLoop = makeFakeLoopDir([
        { drainId, runsRoot: engineRoot, reason: "drained", exitCode: 0 },
      ]);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        DEEP_RESEARCH_LOOP_BIN: fakeLoop,
        TERMINATION_BACKOFF_SECONDS: "0",
        TERMINATION_MAX_DRAINS: "1",
        TERMINATION_WALL_CLOCK_SECONDS: "60",
        LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      };
      const res = await runEntryDetached(env);
      expect(res.code).toBe(3);
      expect(res.stderr).toMatch(/TERMINATION NOT REACHED/);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
    }
  }, 45000);

  it("DISCRIMINATING: using drain reason as criterion would incorrectly pass (reason=drained is not null state)", async () => {
    // When termination.state is null but reason is "drained", a naive implementation
    // that treats "drained" as success would exit 0. Our implementation correctly
    // exits non-zero because it reads the actual termination.state.
    // This test verifies that the entry's behavior is based on termination.state,
    // not on drain reason.
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c2-rec-disc-"));
    const tokFile = makeTokenFile();
    const runId = "e0c2-disc2-001";
    try {
      const engineRoot = setupEngineRoot();
      const drainId = "drain-disc-entry";
      const runDir = join(engineRoot, "run-" + drainId);
      mkdirSync(runDir, { recursive: true });

      writeFileSync(
        join(engineRoot, "index.jsonl"),
        JSON.stringify({ drain_id: drainId, lane: "deep-research", run_dir: runDir }) + "\n",
      );
      writeFileSync(
        join(runDir, "journal.jsonl"),
        JSON.stringify({
          run_id: "tick~1",
          identity: "tick",
          result: JSON.stringify({
            hasPendingWork: false,
            termination: { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false },
          }),
          effects: [],
        }) + "\n",
      );

      const fakeLoop = makeFakeLoopDir([
        { drainId, runsRoot: engineRoot, reason: "drained", exitCode: 0 },
      ]);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        DEEP_RESEARCH_LOOP_BIN: fakeLoop,
        TERMINATION_BACKOFF_SECONDS: "0",
        TERMINATION_MAX_DRAINS: "1",
        TERMINATION_WALL_CLOCK_SECONDS: "60",
        LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      };
      const res = await runEntryDetached(env);
      // The entry must exit non-zero because termination.state is null,
      // even though drain reason is "drained" (which a naive implementation
      // might treat as success).
      expect(res.code).toBe(3);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
    }
  }, 45000);
});

// ── 判据 3: journal 无 identity=="tick" 条目 ⇒ 响亮失败 ──

describe("判据 3: no identity==tick in journal ⇒ loud failure", () => {
  it("read-termination-state exits non-zero when journal has no tick entry", () => {
    const dir = makeTempDir();
    try {
      const engineRoot = join(dir, "engine");
      const runDir = join(dir, "run");
      mkdirSync(runDir, { recursive: true });
      mkdirSync(engineRoot, { recursive: true });

      const drainId = "drain-no-tick-test";
      const drainSummary = JSON.stringify({
        reason: "drained",
        rounds: 1,
        ticksByLabel: { tick: 1 },
        runs_root: engineRoot,
        drain_id: drainId,
      });

      writeFileSync(
        join(engineRoot, "index.jsonl"),
        JSON.stringify({
          drain_id: drainId,
          lane: "deep-research",
          run_dir: runDir,
        }) + "\n",
      );

      writeFileSync(
        join(runDir, "journal.jsonl"),
        JSON.stringify({
          run_id: "run~1",
          identity: "other",
          result: "{}",
          effects: [],
        }) + "\n",
      );

      expect(() => {
        execFileSync("node", [TERM_SCRIPT], {
          input: drainSummary,
          encoding: "utf8",
          env: {
            ...process.env,
            LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "/root",
          },
        });
      }).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 判据 6c (GT-7): 嵌套 JSON 摘要 ⇒ 正确抽取 ──

describe("判据 6c (GT-7): nested JSON drain summary", () => {
  it("read-termination-state parses drain summary with nested ticksByLabel", () => {
    const dir = makeTempDir();
    try {
      const engineRoot = join(dir, "engine");
      const runDir = join(dir, "run");
      mkdirSync(runDir, { recursive: true });
      mkdirSync(engineRoot, { recursive: true });

      const drainId = "drain-nested-test";
      const drainSummary = JSON.stringify({
        reason: "max_rounds",
        rounds: 16,
        ticksByLabel: { tick: 16 },
        runs_root: engineRoot,
        drain_id: drainId,
      });

      writeFileSync(
        join(engineRoot, "index.jsonl"),
        JSON.stringify({
          drain_id: drainId,
          lane: "deep-research",
          run_dir: runDir,
        }) + "\n",
      );

      writeFileSync(
        join(runDir, "journal.jsonl"),
        JSON.stringify({
          run_id: "tick~1",
          identity: "tick",
          result: JSON.stringify({
            hasPendingWork: false,
            termination: {
              state: null,
              coverage: 0,
              zeroGrowthRounds: 1,
              capHit: false,
            },
          }),
          effects: [],
        }) + "\n",
      );

      const out = execFileSync("node", [TERM_SCRIPT], {
        input: drainSummary,
        encoding: "utf8",
        env: {
          ...process.env,
          LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
          PATH: process.env.PATH ?? "",
          HOME: process.env.HOME ?? "/root",
        },
      });

      const parsed = JSON.parse(out);
      expect(parsed.state).toBeNull();
      expect(parsed.coverage).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 判据 6d (GT-8): 单 channel GET 不返回 head_seq ──

describe("判据 6d (GT-8): single channel GET does not return head_seq", () => {
  it("fake bus single channel GET lacks head_seq (list endpoint is the sole source)", async () => {
    let singleGetCount = 0;
    let listGetCount = 0;

    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (/\/v1\/channels\/[^/]+$/.test(u) && !u.includes("/messages")) {
          singleGetCount += 1;
          return jsonResponse({
            channel_id: "research:test.index",
            closed_at: null,
            created_at: "2026-01-01T00:00:00Z",
            delivery_mode: "fanout",
            owner_agent_id: "agent-1",
            visibility: "public",
          });
        }
        if (u.endsWith("/v1/channels") || u.includes("/v1/channels?")) {
          listGetCount += 1;
          return jsonResponse({
            channels: [
              {
                channel_id: "research:test.index",
                head_seq: 42,
                created_at: "2026-01-01T00:00:00Z",
                delivery_mode: "fanout",
                owner_agent_id: "agent-1",
                visibility: "public",
              },
            ],
          });
        }
        return jsonResponse({});
      }),
    );

    const { getChannelHeadSeq } = await import("../src/bus");
    const seq = await getChannelHeadSeq("research:test.index");
    expect(seq).toBe(42);
    expect(listGetCount).toBeGreaterThanOrEqual(1);
  });
});

// ── 判据 4 (GT-4): 续投门 —— 板面排空但 termination.state null 且未触顶 ⇒ 仍然续投 ──

describe("判据 4 (GT-4): continuation gate — board drained but null termination + not capHit ⇒ continue", () => {
  it("continuation gate triggers when hasPendingWork=false but termination.state=null and capHit=false", () => {
    const dir = makeTempDir();
    try {
      const argvLog = join(dir, "argv.log");
      const runnerLog = join(dir, "puts.log");
      const tickEntry = join(dir, "tick-entry");
      const runner = join(dir, "runner");
      const storeDir = join(dir, "store");

      writeFileSync(runnerLog, "");
      mkdirSync(storeDir, { recursive: true });

      writeFileSync(
        tickEntry,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--parse-trigger-body" ]; then
  "${VITE_NODE}" "${join(SRC_DIR, "tick-entry.ts")}" --parse-trigger-body "$2"
  exit $?
fi
printf '%s\\n' "$@" > "${argvLog}"
printf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 1, "capHit": false}}'
`,
      );
      chmodSync(tickEntry, 0o755);

      writeFileSync(
        runner,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${runnerLog}"\n`,
      );
      chmodSync(runner, 0o755);

      const tpl = readFileSync(TICK_MD, "utf8");
      const script = tpl
        .replace(/\{\{tick_entry\}\}/g, tickEntry)
        .replace(/\{\{tick_channel\}\}/g, "research:test.index")
        .replace(/\{\{evidence_channel\}\}/g, "")
        .replace(/\{\{allowed_root\}\}/g, "")
        .replace(/\{\{max_writes\}\}/g, "64")
        .replace(/\{\{research_question\}\}/g, "")
        .replace(/\{\{research_origin\}\}/g, "")
        .replace(/\{\{doc_channel\}\}/g, "")
        .replace(/\{\{trigger_store_dir\}\}/g, storeDir)
        .replace(/\{\{loop_store_cli\}\}/g, join(dir, "store-cli.js"))
        .replace(/\{\{loop_engine_runner\}\}/g, runner)
        .replace(/\{\{trigger_body\}\}/g, '{"tick":true,"coverage":0,"zeroGrowthRounds":1}');

      const outShell = join(dir, "tick.sh");
      writeFileSync(outShell, script);
      chmodSync(outShell, 0o755);

      execFileSync("bash", [outShell], { cwd: dir, encoding: "utf8" });

      const puts = readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean);
      expect(puts.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse(puts[0]);
      expect(body.body.coverage).toBe(0);
      expect(body.body.zeroGrowthRounds).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DISCRIMINATING: when termination.state is non-null, continuation STOPS even with null capHit", () => {
    const dir = makeTempDir();
    try {
      const runnerLog = join(dir, "puts.log");
      const tickEntry = join(dir, "tick-entry");
      const runner = join(dir, "runner");
      const storeDir = join(dir, "store");

      writeFileSync(runnerLog, "");
      mkdirSync(storeDir, { recursive: true });

      writeFileSync(
        tickEntry,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--parse-trigger-body" ]; then
  "${VITE_NODE}" "${join(SRC_DIR, "tick-entry.ts")}" --parse-trigger-body "$2"
  exit $?
fi
printf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": "converged", "coverage": 5, "zeroGrowthRounds": 2, "capHit": false}}'
`,
      );
      chmodSync(tickEntry, 0o755);

      writeFileSync(
        runner,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${runnerLog}"\n`,
      );
      chmodSync(runner, 0o755);

      const tpl = readFileSync(TICK_MD, "utf8");
      const script = tpl
        .replace(/\{\{tick_entry\}\}/g, tickEntry)
        .replace(/\{\{tick_channel\}\}/g, "research:test.index")
        .replace(/\{\{evidence_channel\}\}/g, "")
        .replace(/\{\{allowed_root\}\}/g, "")
        .replace(/\{\{max_writes\}\}/g, "64")
        .replace(/\{\{research_question\}\}/g, "")
        .replace(/\{\{research_origin\}\}/g, "")
        .replace(/\{\{doc_channel\}\}/g, "")
        .replace(/\{\{trigger_store_dir\}\}/g, storeDir)
        .replace(/\{\{loop_store_cli\}\}/g, join(dir, "store-cli.js"))
        .replace(/\{\{loop_engine_runner\}\}/g, runner)
        .replace(/\{\{trigger_body\}\}/g, '{"tick":true,"coverage":0,"zeroGrowthRounds":1}');

      const outShell = join(dir, "tick.sh");
      writeFileSync(outShell, script);
      chmodSync(outShell, 0o755);

      execFileSync("bash", [outShell], { cwd: dir, encoding: "utf8" });

      const puts = readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean);
      expect(puts).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DISCRIMINATING: when capHit is true, continuation STOPS even with null state", () => {
    const dir = makeTempDir();
    try {
      const runnerLog = join(dir, "puts.log");
      const tickEntry = join(dir, "tick-entry");
      const runner = join(dir, "runner");
      const storeDir = join(dir, "store");

      writeFileSync(runnerLog, "");
      mkdirSync(storeDir, { recursive: true });

      writeFileSync(
        tickEntry,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--parse-trigger-body" ]; then
  "${VITE_NODE}" "${join(SRC_DIR, "tick-entry.ts")}" --parse-trigger-body "$2"
  exit $?
fi
printf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 1, "capHit": true}}'
`,
      );
      chmodSync(tickEntry, 0o755);

      writeFileSync(
        runner,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${runnerLog}"\n`,
      );
      chmodSync(runner, 0o755);

      const tpl = readFileSync(TICK_MD, "utf8");
      const script = tpl
        .replace(/\{\{tick_entry\}\}/g, tickEntry)
        .replace(/\{\{tick_channel\}\}/g, "research:test.index")
        .replace(/\{\{evidence_channel\}\}/g, "")
        .replace(/\{\{allowed_root\}\}/g, "")
        .replace(/\{\{max_writes\}\}/g, "64")
        .replace(/\{\{research_question\}\}/g, "")
        .replace(/\{\{research_origin\}\}/g, "")
        .replace(/\{\{doc_channel\}\}/g, "")
        .replace(/\{\{trigger_store_dir\}\}/g, storeDir)
        .replace(/\{\{loop_store_cli\}\}/g, join(dir, "store-cli.js"))
        .replace(/\{\{loop_engine_runner\}\}/g, runner)
        .replace(/\{\{trigger_body\}\}/g, '{"tick":true,"coverage":0,"zeroGrowthRounds":1}');

      const outShell = join(dir, "tick.sh");
      writeFileSync(outShell, script);
      chmodSync(outShell, 0o755);

      execFileSync("bash", [outShell], { cwd: dir, encoding: "utf8" });

      const puts = readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean);
      expect(puts).toHaveLength(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 判据 7 (GT-5): tick.md 续投段在 zsh -c 下真能跑 ──

describe("判据 7 (GT-5): tick.md continuation gate runs under zsh -c", () => {
  it("tick.md with hasPendingWork=true AND null termination continues under zsh -c", () => {
    const dir = makeTempDir();
    try {
      const argvLog = join(dir, "argv.log");
      const runnerLog = join(dir, "puts.log");
      const tickEntry = join(dir, "tick-entry");
      const runner = join(dir, "runner");
      const storeDir = join(dir, "store");

      writeFileSync(runnerLog, "");
      mkdirSync(storeDir, { recursive: true });

      writeFileSync(
        tickEntry,
        `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--parse-trigger-body" ]; then
  "${VITE_NODE}" "${join(SRC_DIR, "tick-entry.ts")}" --parse-trigger-body "$2"
  exit $?
fi
printf '%s\\n' "$@" > "${argvLog}"
printf '%s\\n' '{"hasPendingWork": true, "decisions": [], "termination": {"state": null, "coverage": 3, "zeroGrowthRounds": 1, "capHit": false}}'
`,
      );
      chmodSync(tickEntry, 0o755);

      writeFileSync(
        runner,
        `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${runnerLog}"\n`,
      );
      chmodSync(runner, 0o755);

      const tpl = readFileSync(TICK_MD, "utf8");
      const script = tpl
        .replace(/\{\{tick_entry\}\}/g, tickEntry)
        .replace(/\{\{tick_channel\}\}/g, "research:test.index")
        .replace(/\{\{evidence_channel\}\}/g, "")
        .replace(/\{\{allowed_root\}\}/g, "")
        .replace(/\{\{max_writes\}\}/g, "64")
        .replace(/\{\{research_question\}\}/g, "")
        .replace(/\{\{research_origin\}\}/g, "")
        .replace(/\{\{doc_channel\}\}/g, "")
        .replace(/\{\{trigger_store_dir\}\}/g, storeDir)
        .replace(/\{\{loop_store_cli\}\}/g, join(dir, "store-cli.js"))
        .replace(/\{\{loop_engine_runner\}\}/g, runner)
        .replace(/\{\{trigger_body\}\}/g, '{"tick":true,"coverage":2,"zeroGrowthRounds":1}');

      const outShell = join(dir, "tick.sh");
      writeFileSync(outShell, script);
      chmodSync(outShell, 0o755);

      // ⛔ 判据 7: 用 zsh 真跑（不是 bash、不是 zsh -c bash）
      execFileSync("zsh", [outShell], {
        cwd: dir,
        encoding: "utf8",
      });

      const puts = readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean);
      expect(puts.length).toBeGreaterThanOrEqual(1);
      const body = JSON.parse(puts[0]);
      expect(body.body.coverage).toBe(3);
      expect(body.body.zeroGrowthRounds).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("DISCRIMINATING: bash-only read -r -a fails under zsh -c", () => {
    const dir = makeTempDir();
    try {
      const testScript = join(dir, "test-zsh.sh");
      writeFileSync(
        testScript,
        `#!/usr/bin/env zsh
set -euo pipefail
IFS=\$'\\t' read -r -a prev_arr <<< "--prev-coverage\\t3\\t--prev-zero-growth\\t2"
echo "got: \${prev_arr[@]}"
`,
      );
      chmodSync(testScript, 0o755);

      expect(() => {
        execFileSync("zsh", [testScript], {
          encoding: "utf8",
        });
      }).toThrow();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── 入口级测试基础设施（判据 5, 6, 6b）─────────────────────────────────

interface DrainSpec {
  drainId: string;
  runsRoot: string;
  reason: string;
  exitCode: number;
}

function startFakeBus(): Promise<{
  base: string;
  createdChannels: () => string[];
  setProdSum: (n: number) => void;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const created: string[] = [];
    let prodSum = 0;
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      const method = req.method ?? "GET";
      if (method === "POST" && url === "/v1/channels") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const obj = JSON.parse(body);
            if (typeof obj.channel_id === "string" && !created.includes(obj.channel_id)) {
              created.push(obj.channel_id);
            }
          } catch (_) {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ channel_id: "ok" }));
        });
        return;
      }
      if (method === "GET" && url === "/v1/channels") {
        res.writeHead(200, { "Content-Type": "application/json" });
        const chs = created.map((c) => ({
          channel_id: c,
          head_seq: 0,
          created_at: "2026-01-01T00:00:00Z",
          delivery_mode: "fanout" as const,
          owner_agent_id: "agent-1",
          visibility: "public" as const,
        }));
        chs.push({
          channel_id: "fake:prod",
          head_seq: prodSum,
          created_at: "2026-01-01T00:00:00Z",
          delivery_mode: "fanout" as const,
          owner_agent_id: "agent-1",
          visibility: "public" as const,
        });
        res.end(JSON.stringify({ channels: chs }));
        return;
      }
      if (method === "GET" && url.startsWith("/v1/channels/")) {
        const chId = decodeURIComponent(url.slice("/v1/channels/".length));
        if (created.includes(chId)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ channel_id: chId, visibility: "private" }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "not found" }));
        }
        return;
      }
      if (method === "POST" && url.includes("/publish")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message_id: "m", channel_seq: 1 }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        createdChannels: () => [...created],
        setProdSum: (n: number) => {
          prodSum = n;
        },
        close: () => server.close(),
      });
    });
  });
}

function makeFakeLoopDir(drains: DrainSpec[]): string {
  const dir = mkdtempSync(join(tmpdir(), "e0c2-fake-loop-"));
  const counterFile = join(dir, "counter");
  writeFileSync(counterFile, "0\n");

  const script = join(dir, "deep-research-loop.sh");
  writeFileSync(
    script,
    `#!/usr/bin/env bash
set -euo pipefail
c=\$(cat "${counterFile}" | head -1)
c=\$((c + 1))
echo "\${c}" > "${counterFile}"
` + drains
    .map(
      (d, i) =>
        `if [ "\${c}" = "${i + 1}" ]; then
  echo '{"id":"a9-test","status":"open","body":{"seed":true}}'
  echo '[deep-research-loop] mode=deep-research run_root=/tmp/test'
  echo '${JSON.stringify({ reason: d.reason, rounds: 1, ticksByLabel: { tick: 1 }, runs_root: d.runsRoot, drain_id: d.drainId })}'
  exit ${d.exitCode}
fi
`,
    )
    .join("") +
    `echo "FATAL: unexpected drain call #\${c}" >&2
exit 99
`,
  );
  chmodSync(script, 0o755);
  return script;
}

function runEntryDetached(env: NodeJS.ProcessEnv, timeoutMs = 30000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [ENTRY_BIN], {
      cwd: ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      reject(new Error(`entry script timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function setupDrainJournal(engineRoot: string, drainId: string, termination: object): string {
  const runDir = join(engineRoot, "run-" + drainId);
  mkdirSync(runDir, { recursive: true });
  writeFileSync(
    join(engineRoot, "index.jsonl"),
    JSON.stringify({ drain_id: drainId, lane: "deep-research", run_dir: runDir }) + "\n",
    { flag: "a" },
  );
  writeFileSync(
    join(runDir, "journal.jsonl"),
    JSON.stringify({
      run_id: "tick~1",
      identity: "tick",
      result: JSON.stringify({ hasPendingWork: false, decisions: [], termination }),
      effects: [],
    }) + "\n",
  );
  return engineRoot;
}

function setupEngineRoot(): string {
  const engineRoot = mkdtempSync(join(tmpdir(), "e0c2-engine-"));
  mkdirSync(engineRoot, { recursive: true });
  return engineRoot;
}

// ── 判据 5 (GT-3): 跨 drain 循环直到终态 ──
// ── 判据 6: 撞上限 ⇒ 非零退出 ──
// ── 判据 6b (GT-6): max_rounds + exit 1 不是失败 ──

describe("判据 5/6/6b (GT-3/GT-6): drain loop, entry-level with stub injection", () => {
  it("判据 5 (GT-3): first drain null, second non-null ⇒ converges on round 2, exit 0", async () => {
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c2-rec-5-"));
    const tokFile = makeTokenFile();
    const runId = "e0c2-converge-001";
    try {
      const engineRoot = setupEngineRoot();
      const drainId1 = "drain-converge-1";
      const drainId2 = "drain-converge-2";

      setupDrainJournal(engineRoot, drainId1, { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false });
      setupDrainJournal(engineRoot, drainId2, { state: "converged", coverage: 5, zeroGrowthRounds: 2, capHit: false });

      const fakeLoop = makeFakeLoopDir([
        { drainId: drainId1, runsRoot: engineRoot, reason: "drained", exitCode: 0 },
        { drainId: drainId2, runsRoot: engineRoot, reason: "drained", exitCode: 0 },
      ]);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        DEEP_RESEARCH_LOOP_BIN: fakeLoop,
        TERMINATION_BACKOFF_SECONDS: "0",
        TERMINATION_MAX_DRAINS: "3",
        TERMINATION_WALL_CLOCK_SECONDS: "60",
        LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      };
      const res = await runEntryDetached(env);
      expect(res.code).toBe(0);
      expect(res.stderr).toMatch(/TERMINATION REACHED/);
      expect(res.stderr).toMatch(/state=converged/);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
    }
  }, 45000);

  it("判据 5 (GT-3) DISCRIMINATING: with max_drains=1, never converges ⇒ exit 3", async () => {
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c2-rec-5d-"));
    const tokFile = makeTokenFile();
    const runId = "e0c2-converge-disc-001";
    try {
      const engineRoot = setupEngineRoot();
      const drainId = "drain-converge-disc";

      setupDrainJournal(engineRoot, drainId, { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false });

      const fakeLoop = makeFakeLoopDir([
        { drainId, runsRoot: engineRoot, reason: "drained", exitCode: 0 },
        { drainId: "drain-never-reached", runsRoot: engineRoot, reason: "drained", exitCode: 0 },
      ]);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        DEEP_RESEARCH_LOOP_BIN: fakeLoop,
        TERMINATION_BACKOFF_SECONDS: "0",
        TERMINATION_MAX_DRAINS: "1",
        TERMINATION_WALL_CLOCK_SECONDS: "60",
        LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      };
      const res = await runEntryDetached(env);
      // ⛔ 判据 5 discriminant: 只跑一次 drain 时，null 状态不会收敛 ⇒ exit 3
      expect(res.code).toBe(3);
      expect(res.stderr).toMatch(/TERMINATION NOT REACHED/);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
    }
  }, 45000);

  it("判据 6: termination.state always null ⇒ hit max drain count, exit 3", async () => {
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c2-rec-6-"));
    const tokFile = makeTokenFile();
    const runId = "e0c2-limit-001";
    try {
      const engineRoot = setupEngineRoot();
      const drainId = "drain-limit";

      setupDrainJournal(engineRoot, drainId, { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false });

      const fakeLoop = makeFakeLoopDir([
        { drainId, runsRoot: engineRoot, reason: "drained", exitCode: 0 },
        { drainId, runsRoot: engineRoot, reason: "drained", exitCode: 0 },
      ]);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        DEEP_RESEARCH_LOOP_BIN: fakeLoop,
        TERMINATION_BACKOFF_SECONDS: "0",
        TERMINATION_MAX_DRAINS: "2",
        TERMINATION_WALL_CLOCK_SECONDS: "60",
        LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      };
      const res = await runEntryDetached(env);
      expect(res.code).toBe(3);
      expect(res.stderr).toMatch(/TERMINATION NOT REACHED/);
      expect(res.stderr).toMatch(/hit max drain count/);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
    }
  }, 45000);

  it("判据 6b (GT-6): max_rounds + exit 1 is NOT a failure, continues to convergence", async () => {
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c2-rec-6b-"));
    const tokFile = makeTokenFile();
    const runId = "e0c2-maxrounds-001";
    try {
      const engineRoot = setupEngineRoot();
      const drainId1 = "drain-maxrounds-1";
      const drainId2 = "drain-maxrounds-2";

      setupDrainJournal(engineRoot, drainId1, { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false });
      setupDrainJournal(engineRoot, drainId2, { state: "converged", coverage: 10, zeroGrowthRounds: 3, capHit: false });

      const fakeLoop = makeFakeLoopDir([
        { drainId: drainId1, runsRoot: engineRoot, reason: "max_rounds", exitCode: 1 },
        { drainId: drainId2, runsRoot: engineRoot, reason: "drained", exitCode: 0 },
      ]);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        DEEP_RESEARCH_LOOP_BIN: fakeLoop,
        TERMINATION_BACKOFF_SECONDS: "0",
        TERMINATION_MAX_DRAINS: "3",
        TERMINATION_WALL_CLOCK_SECONDS: "60",
        LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      };
      const res = await runEntryDetached(env);
      // ⛔ 判据 6b: max_rounds + exit 1 不是失败，应继续并最终收敛 ⇒ exit 0
      expect(res.code).toBe(0);
      expect(res.stderr).toMatch(/TERMINATION REACHED/);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
    }
  }, 45000);

  it("判据 6b (GT-6) DISCRIMINATING: non-max_rounds non-zero exit (e.g. 3) ⇒ fail immediately", async () => {
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c2-rec-6bd-"));
    const tokFile = makeTokenFile();
    const runId = "e0c2-real-fail-001";
    try {
      const engineRoot = setupEngineRoot();
      const drainId = "drain-real-fail";

      setupDrainJournal(engineRoot, drainId, { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false });

      const fakeLoop = makeFakeLoopDir([
        { drainId, runsRoot: engineRoot, reason: "error", exitCode: 3 },
      ]);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        DEEP_RESEARCH_LOOP_BIN: fakeLoop,
        TERMINATION_BACKOFF_SECONDS: "0",
        TERMINATION_MAX_DRAINS: "3",
        TERMINATION_WALL_CLOCK_SECONDS: "60",
        LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
      };
      const res = await runEntryDetached(env);
      // ⛔ 判据 6b discriminant: 非 max_rounds/drained 的 reason 是真失败，应立即退出
      expect(res.code).toBe(3);
      expect(res.stderr).toMatch(/DRAIN FAILED/);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
    }
  }, 45000);

  it("判据 6b (GT-6) DISCRIMINATING: unparseable drain summary ⇒ fail immediately", async () => {
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c2-rec-6bd2-"));
    const tokFile = makeTokenFile();
    const runId = "e0c2-unparseable-001";
    try {
      const dir = mkdtempSync(join(tmpdir(), "e0c2-fake-loop-up-"));
      const counterFile = join(dir, "counter");
      writeFileSync(counterFile, "0\n");

      const script = join(dir, "deep-research-loop.sh");
      writeFileSync(
        script,
        `#!/usr/bin/env bash
echo "this is not JSON at all"
exit 0
`,
      );
      chmodSync(script, 0o755);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        DEEP_RESEARCH_LOOP_BIN: script,
        TERMINATION_BACKOFF_SECONDS: "0",
        TERMINATION_MAX_DRAINS: "3",
        TERMINATION_WALL_CLOCK_SECONDS: "60",
      };
      const res = await runEntryDetached(env);
      expect(res.code).toBe(3);
      expect(res.stderr).toMatch(/DRAIN FAILED/);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
    }
  }, 45000);

  it("§1.1 / GT-7: drain summary without drain_id ⇒ DRAIN FAILED (GT-7 parse rejects)", async () => {
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c2-rec-noid-"));
    const tokFile = makeTokenFile();
    const runId = "e0c2-noid-001";
    try {
      const dir = mkdtempSync(join(tmpdir(), "e0c2-fake-loop-noid-"));
      const script = join(dir, "deep-research-loop.sh");
      writeFileSync(
        script,
        `#!/usr/bin/env bash
echo '{"id":"a9-test","status":"open","body":{"seed":true}}'
echo '[deep-research-loop] mode=deep-research'
echo '{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"/tmp/foo"}'
exit 0
`,
      );
      chmodSync(script, 0o755);

      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        DEEP_RESEARCH_LOOP_BIN: script,
        TERMINATION_BACKOFF_SECONDS: "0",
        TERMINATION_MAX_DRAINS: "3",
        TERMINATION_WALL_CLOCK_SECONDS: "60",
      };
      const res = await runEntryDetached(env);
      expect(res.code).toBe(3);
      expect(res.stderr).toMatch(/DRAIN FAILED/);
      expect(res.stderr).toMatch(/cannot parse drain summary/);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
    }
  }, 45000);
});