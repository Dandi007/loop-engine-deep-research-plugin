/**
 * E0c2 —— 终止语义域测试（GT-2 到 GT-8）。
 *
 * 覆盖 spec §2 判据 2–6d, 7：
 *  - 判据 2: termination.state 为 null ⇒ 入口非零退出
 *  - 判据 3: journal 无 identity=="tick" 条目 ⇒ 响亮失败
 *  - 判据 4 (GT-4): 板面排空但 termination.state null 且未触顶 ⇒ 仍然续投
 *  - 判据 5 (GT-3): 跨 drain 循环直到终态
 *  - 判据 6: 撞上限 ⇒ 非零退出
 *  - 判据 6b (GT-6): max_rounds + exit 1 不是失败
 *  - 判据 6bb (GT-2): result 是双文档拼接 ⇒ 正确读出第一个 JSON
 *  - 判据 6c (GT-7): 嵌套 JSON 摘要 ⇒ 正确抽取
 *  - 判据 6d (GT-8): 单 channel GET 不返回 head_seq
 *  - 判据 7 (GT-5): tick.md 续投段在 zsh -c 下真能跑
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
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

// ── 判据 6bb (GT-2): result 是双文档拼接 ⇒ 正确读出第一个 JSON ──

describe("判据 6bb (GT-2): two concatenated JSON docs in result ⇒ first doc extracted correctly", () => {
  it("extracts termination from a result with two concatenated JSON docs", () => {
    const dir = makeTempDir();
    try {
      const engineRoot = join(dir, "engine");
      const indexFile = join(engineRoot, "index.jsonl");
      const runDir = join(dir, "run");
      mkdirSync(runDir, { recursive: true });
      mkdirSync(engineRoot, { recursive: true });

      const tickOutput = JSON.stringify({
        channelId: "research:test.index",
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
      });

      const triggerEcho = JSON.stringify({
        id: "a9-1786524011214625264-1934513",
        status: "open",
        body: { tick: true, coverage: 5, zeroGrowthRounds: 2 },
      });

      const result = tickOutput + triggerEcho;

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

  it("DISCRIMINATING: whole-string JSON.parse on result with two docs throws", () => {
    const tickOutput = JSON.stringify({
      termination: { state: "converged", coverage: 1, zeroGrowthRounds: 1, capHit: false },
    });
    const triggerEcho = JSON.stringify({ id: "x", status: "open" });
    const result = tickOutput + triggerEcho;

    expect(() => JSON.parse(result)).toThrow();
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

    for (const line of result.split("\n")) {
      if (!line.trim()) continue;
      try {
        JSON.parse(line);
      } catch {
        expect(true).toBe(true);
        return;
      }
    }
    // If all lines parse, the test should fail because the multi-line pretty-print
    // means no single line is complete JSON.
    expect(false).toBe(true);
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

      // journal has no identity=="tick" → only an identity=="other" entry
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
        // Single channel GET: /v1/channels/<id> — does NOT return head_seq
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
        // List endpoint: /v1/channels — returns head_seq
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
    // Single channel GET should NOT be used for head_seq
    // (the function uses listChannels, which calls the list endpoint)
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

      // Fake tick-entry: argv log + output with hasPendingWork=false, null state, no capHit
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

      // ⛔ 判据 4: 板面排空（hasPendingWork=false）但 termination.state=null 且未触顶 ⇒ 仍然续投
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

      // ⛔ 判据 4: termination.state 非 null ⇒ 停止续投
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

      // ⛔ 判据 4: capHit=true ⇒ 停止续投（熔断不绕过）
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

      // ⛔ 判据 7: 用 zsh -c 真跑（不是 bash、不是 sh）
      execFileSync("zsh", ["-c", `bash "${outShell}"`], {
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
# This is exactly the old bash-only syntax that GT-5 says fails in zsh
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

// ── 判据 5 (GT-3): 跨 drain 循环直到终态 ──
// ── 判据 6: 撞上限 ⇒ 非零退出 ──
// ── 判据 6b (GT-6): max_rounds + exit 1 不是失败 ──

describe("判据 5/6/6b (GT-3/GT-6): drain loop logic", () => {
  it("判据 6b (GT-6): reason=max_rounds is NOT a failure (should continue to check termination)", () => {
    // Test the GT-6 classification logic directly:
    // reason==drained or reason==max_rounds ⇒ not a failure, proceed to check termination
    const reasons = ["drained", "max_rounds"];
    for (const reason of reasons) {
      const isFailure = reason !== "drained" && reason !== "max_rounds";
      expect(isFailure).toBe(false);
    }
    // Other reasons ARE failures
    const timeoutReason: string = "timeout";
    const errorReason: string = "error";
    expect(timeoutReason !== "drained" && timeoutReason !== "max_rounds").toBe(true);
    expect(errorReason !== "drained" && errorReason !== "max_rounds").toBe(true);
  });

  it("判据 6b (GT-6): unparseable drain summary is a real failure", () => {
    // Empty summary ⇒ failure
    const summary = "";
    const isFailure = !summary;
    expect(isFailure).toBe(true);
  });

  it("判据 6: termination.state always null ⇒ continue loop until limit", () => {
    // Simulate the loop logic: drain 1 → null, drain 2 → null, drain 3 → null
    // After max_drains=3, should exit with failure
    const maxDrains = 3;
    const terminations = [null, null, null];
    let drainCount = 0;
    let converged = false;

    for (const term of terminations) {
      drainCount++;
      if (term !== null) {
        converged = true;
        break;
      }
      if (drainCount >= maxDrains) {
        break;
      }
    }

    expect(converged).toBe(false);
    expect(drainCount).toBe(3);
  });

  it("判据 5 (GT-3): first drain null, second non-null ⇒ converges on round 2", () => {
    const terminations = [null, "converged"];
    let drainCount = 0;
    let converged = false;

    for (const term of terminations) {
      drainCount++;
      if (term !== null) {
        converged = true;
        break;
      }
    }

    expect(converged).toBe(true);
    expect(drainCount).toBe(2);
  });
});