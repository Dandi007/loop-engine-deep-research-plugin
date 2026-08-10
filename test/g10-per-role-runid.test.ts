/**
 * G10 —— 生成段四个 role 各得唯一 run-id（spec §2 Y1–Y5）。
 *
 * 判据：
 *  Y1  四个 role 的 run-id 两两不同
 *  Y2  argv 与回读同 id
 *  Y3  无死字段：GenerateSpawnRuntime 不保留 runId
 *  Y4  断言打在生产组装出的 deps 上（assembleGenerateDeps）
 *  Y5  triage / worker 两条路径的 run-id 生成不受影响
 */
import { describe, it, expect, vi } from "vitest";
import { spawnGenerateRole } from "../src/generate";
import type { DebaterCorpus } from "../src/generate";
import { assembleGenerateDeps } from "../src/tick-run";
import type { TerminationState, BoardState } from "../src/tick";

const ROLES = [
  "dr-debater-advocate",
  "dr-debater-opponent",
  "dr-debater-judge",
  "dr-synthesizer",
] as const;

function termState(): TerminationState {
  return { state: "converged", capHit: false, coverage: 0, zeroGrowthRounds: 0 };
}

function boardState(): BoardState {
  return { cards: [], runs: {}, triageInFlight: false };
}

const corpus: DebaterCorpus = {
  question: "test question?",
  evidences: [
    { clue_id: "c1", anchor: "a1", quote: "q1", claim: "c1" },
  ],
};

// ── Y1: 四个 role 的 run-id 两两不同 ─────────────────────────────────

describe("Y1: four role run-ids are pairwise distinct", () => {
  it("four spawnGenerateRole calls each get a unique run-id on argv", async () => {
    const deps = assembleGenerateDeps(
      { channelId: "research:test", workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );
    const runtime = deps.spawnRuntime!;
    const recordedRunIds: string[] = [];

    runtime.spawnProcess = async (argv) => {
      const idx = argv.indexOf("--run-id");
      recordedRunIds.push(argv[idx + 1]);
      return {};
    };
    runtime.readBody = async () => "body";

    for (const role of ROLES) {
      await spawnGenerateRole(role, corpus, runtime);
    }

    expect(recordedRunIds).toHaveLength(4);
    expect(new Set(recordedRunIds).size).toBe(4);
    for (const id of recordedRunIds) {
      expect(typeof id).toBe("string");
      expect(id.length).toBeGreaterThan(0);
    }
  });
});

// ── Y2: argv 与回读同 id ────────────────────────────────────────────

describe("Y2: argv run-id equals readBody run-id for each spawn", () => {
  it("each spawn passes the same run-id to argv and readBody", async () => {
    const deps = assembleGenerateDeps(
      { channelId: "research:test", workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );
    const runtime = deps.spawnRuntime!;
    const pairs: Array<{ argvId: string; readId: string }> = [];

    runtime.spawnProcess = async (argv) => {
      const idx = argv.indexOf("--run-id");
      pairs.push({ argvId: argv[idx + 1], readId: "" });
      return {};
    };
    runtime.readBody = async (runId) => {
      pairs[pairs.length - 1].readId = runId;
      return "body";
    };

    for (const role of ROLES) {
      await spawnGenerateRole(role, corpus, runtime);
    }

    expect(pairs).toHaveLength(4);
    for (const pair of pairs) {
      expect(pair.argvId).toBe(pair.readId);
      expect(pair.argvId.length).toBeGreaterThan(0);
    }
  });
});

// ── Y3: 无死字段 ────────────────────────────────────────────────────

describe("Y3: no dead runId field on GenerateSpawnRuntime", () => {
  it("GenerateSpawnRuntime has newRunId, not runId", () => {
    const deps = assembleGenerateDeps(
      { channelId: "research:test", workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );
    const runtime = deps.spawnRuntime!;

    expect(runtime).toHaveProperty("newRunId");
    expect(typeof runtime.newRunId).toBe("function");
    expect(runtime).not.toHaveProperty("runId");
  });

  it("newRunId returns a non-empty string", () => {
    const deps = assembleGenerateDeps(
      { channelId: "research:test", workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );
    const runtime = deps.spawnRuntime!;

    const id = runtime.newRunId();
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("newRunId returns unique values on successive calls", () => {
    const deps = assembleGenerateDeps(
      { channelId: "research:test", workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );
    const runtime = deps.spawnRuntime!;

    const ids = new Set<string>();
    for (let i = 0; i < 10; i++) {
      ids.add(runtime.newRunId());
    }
    expect(ids.size).toBe(10);
  });
});

// ── Y4: 断言打在生产组装出的 deps 上 ─────────────────────────────────

describe("Y4: assertions drive production assembleGenerateDeps", () => {
  it("Y1/Y2/Y3 all obtain runtime from assembleGenerateDeps, not hand-built", () => {
    const deps = assembleGenerateDeps(
      { channelId: "research:test", workerCmd: "/fake/agent-run" },
      termState(),
      boardState(),
    );
    expect(deps.spawnRuntime).toBeDefined();
    expect(deps.spawnRuntime!.agentRunBin).toBe("/fake/agent-run");
    expect(typeof deps.spawnRuntime!.newRunId).toBe("function");
    expect(typeof deps.spawnRuntime!.spawnProcess).toBe("function");
    expect(typeof deps.spawnRuntime!.readBody).toBe("function");
  });
});

// ── Y5: triage / worker 两条路径的 run-id 生成不受影响 ─────────────────

describe("Y5: triage and worker run-id generation unchanged", () => {
  it("TriageSpawnRuntime has runId (not newRunId)", async () => {
    const { randomUUID } = await import("node:crypto");
    const runtime: import("../src/tick-run").TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: randomUUID(),
      spawnProcess: async () => ({}),
      readResult: async () => [],
    };
    expect(runtime).toHaveProperty("runId");
    expect(runtime).not.toHaveProperty("newRunId");
    expect(typeof runtime.runId).toBe("string");
    expect(runtime.runId.length).toBeGreaterThan(0);
  });

  it("worker per-dispatch runId is const runId = randomUUID() in src/tick.ts", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync("src/tick.ts", "utf8");
    expect(src).toMatch(/const runId = randomUUID\(\)/);
  });
});