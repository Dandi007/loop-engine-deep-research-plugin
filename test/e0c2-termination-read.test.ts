/**
 * E0c2 §1.1 / §2 判据 2,3 —— 终态取真值（GT-2 路径）单测。
 *
 * readTerminationFromDrain 按 GT-2 路径读 termination.state：
 *   drain 摘要.drain_id → index.jsonl → run_dir → journal.jsonl → 最后一条 identity=="tick" → result → termination.state
 *
 * 判别性：
 *  - 判据 2：termination.state==null ⇒ 调用方（入口）非零退出；用 drain reason 凑合 ⇒ 这些单测变红
 *    （readTerminationFromDrain 不碰 drain reason，只按 GT-2 路径取真值）。
 *  - 判据 3：journal 里没有 identity=="tick" 的条目 ⇒ TerminationReadError 点名该步，
 *    ⛔ 不得当作任一方向的默认值。
 *
 * 链路任一步断裂（无 drain_id / 无 index.jsonl / 无匹配 lane / 无 journal / 无 tick 条目 /
 * result 坏 / termination 缺失）⇒ TerminationReadError 点名是哪一步。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readTerminationFromDrain,
  parseDrainSummary,
  readLaneEntriesForDrain,
  readLastTickJournalLine,
  parseTerminationFromTickResult,
  TerminationReadError,
} from "../src/e0c2-termination-read";
import type { TerminalState } from "../src/tick";

function setupFakeRuntime(): {
  root: string;
  runDir: string;
  drainId: string;
  cleanup: () => void;
} {
  const root = mkdtempSync(join(tmpdir(), "e0c2-term-read-"));
  const drainId = "drain-test-001";
  const runDir = join(root, "runs", "tick-run-001");
  mkdirSync(runDir, { recursive: true });
  return {
    root,
    runDir,
    drainId,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

function writeIndexEntry(root: string, entry: {
  drain_id: string;
  lane: string;
  run_dir: string;
  tick?: number;
}): void {
  writeFileSync(
    join(root, "index.jsonl"),
    JSON.stringify({
      schema: "lei/1",
      kind: "run.start",
      run_id: entry.run_dir.split("/").pop() ?? "run",
      label: "tick",
      fleet: "fleet.yaml",
      caller: "drain",
      run_dir: entry.run_dir,
      ts: "2026-01-01T00:00:00Z",
      pid: 12345,
      drain_id: entry.drain_id,
      lane: entry.lane,
      tick: entry.tick ?? 1,
    }) + "\n",
  );
}

function writeJournalEntry(runDir: string, line: Record<string, unknown>): void {
  writeFileSync(
    join(runDir, "journal.jsonl"),
    JSON.stringify(line) + "\n",
  );
}

function tickResultJson(state: TerminalState | null, coverage = 0, zeroGrowthRounds = 0, capHit = false): string {
  return JSON.stringify({
    channelId: "research:test.index",
    messageCount: 0,
    decisions: [],
    writes: 0,
    skipped: 0,
    spawns: [],
    harvestReports: [],
    triageReports: [],
    hasPendingWork: state === null,
    termination: { state, coverage, zeroGrowthRounds, capHit },
  });
}

describe("§1.1 parseDrainSummary: extract drain_id from drain summary JSON", () => {
  it("parses a valid drain summary with drain_id", () => {
    const summary = parseDrainSummary(
      JSON.stringify({ reason: "drained", rounds: 1, drain_id: "abc-123" }),
    );
    expect(summary.drain_id).toBe("abc-123");
  });

  it("throws TerminationReadError on empty string (must not fall back to drain reason)", () => {
    expect(() => parseDrainSummary("")).toThrow(TerminationReadError);
  });

  it("throws TerminationReadError on invalid JSON", () => {
    expect(() => parseDrainSummary("not-json")).toThrow(TerminationReadError);
    expect(() => parseDrainSummary("not-json")).toThrow(/drain summary/);
  });

  it("throws TerminationReadError when drain_id is missing", () => {
    expect(() => parseDrainSummary(JSON.stringify({ reason: "drained" }))).toThrow(
      TerminationReadError,
    );
    expect(() => parseDrainSummary(JSON.stringify({ reason: "drained" }))).toThrow(
      /drain_id/,
    );
  });
});

describe("§2 判据 2: termination.state==null is read faithfully (not drain reason)", () => {
  it("reads termination.state===null from a valid tick journal result (not from drain reason)", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir });
      writeJournalEntry(runDir, {
        run_id: "tick~1",
        identity: "tick",
        result: tickResultJson(null, 0, 1, false),
      });
      const summary = JSON.stringify({
        reason: "drained",
        rounds: 1,
        drain_id: drainId,
      });
      const result = readTerminationFromDrain(summary, root);
      // ⛔ 判据 2 核心：state 是 null（从 tick result 读的，不是 drain reason）
      expect(result.state).toBeNull();
      expect(result.coverage).toBe(0);
      expect(result.zeroGrowthRounds).toBe(1);
      expect(result.capHit).toBe(false);
    } finally {
      cleanup();
    }
  });

  it("reads termination.state==='converged' from a valid tick journal result", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir });
      writeJournalEntry(runDir, {
        run_id: "tick~3",
        identity: "tick",
        result: tickResultJson("converged", 5, 2, false),
      });
      const result = readTerminationFromDrain(
        JSON.stringify({ reason: "drained", drain_id: drainId }),
        root,
      );
      expect(result.state).toBe("converged");
      expect(result.coverage).toBe(5);
    } finally {
      cleanup();
    }
  });

  it("takes the LAST tick entry when multiple ticks exist in journal (most recent round)", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir });
      // 两条 tick 条目：第一条 state=null，最后一条 state=converged
      writeFileSync(
        join(runDir, "journal.jsonl"),
        JSON.stringify({ run_id: "tick~1", identity: "tick", result: tickResultJson(null, 0, 0, false) }) + "\n" +
          JSON.stringify({ run_id: "tick~2", identity: "other", result: "{}" }) + "\n" +
          JSON.stringify({ run_id: "tick~3", identity: "tick", result: tickResultJson("converged", 3, 2, false) }) + "\n",
      );
      const result = readTerminationFromDrain(
        JSON.stringify({ reason: "drained", drain_id: drainId }),
        root,
      );
      // 取最后一条 identity=="tick"（tick~3），不是第一条（tick~1）
      expect(result.state).toBe("converged");
      expect(result.coverage).toBe(3);
    } finally {
      cleanup();
    }
  });

  it("DISCRIMINATING: drain reason 'drained' does not influence the result (state read from tick only)", () => {
    // 判据 2 判别性：drain 摘要的 reason 是 "drained"（看起来像「完成」），但 tick 的 termination.state 是 null。
    // readTerminationFromDrain 必须返回 null（从 tick 读），不得因为 reason=drained 就报非 null。
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir });
      writeJournalEntry(runDir, {
        run_id: "tick~1",
        identity: "tick",
        result: tickResultJson(null, 0, 1, false),
      });
      const result = readTerminationFromDrain(
        JSON.stringify({ reason: "drained", rounds: 16, drain_id: drainId }),
        root,
      );
      // ⛔ 即使 drain reason=drained，termination.state 仍是 null（不从 reason 凑合）
      expect(result.state).toBeNull();
    } finally {
      cleanup();
    }
  });
});

describe("§2 判据 3: journal with no identity=='tick' entry ⇒ loud failure (no default either way)", () => {
  it("throws TerminationReadError naming the step when journal has no tick entries", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir });
      // journal 里只有 identity="other" 的条目（没有 tick）
      writeJournalEntry(runDir, {
        run_id: "other~1",
        identity: "other",
        result: "{}",
      });
      expect(() =>
        readTerminationFromDrain(
          JSON.stringify({ drain_id: drainId }),
          root,
        ),
      ).toThrow(TerminationReadError);
      // ⛔ 判据 3：点名 identity=="tick"，不当作任一方向默认值
      expect(() =>
        readTerminationFromDrain(
          JSON.stringify({ drain_id: drainId }),
          root,
        ),
      ).toThrow(/identity.*tick/);
    } finally {
      cleanup();
    }
  });

  it("throws TerminationReadError when journal.jsonl is missing entirely", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir });
      // 故意不写 journal.jsonl
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(TerminationReadError);
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(/journal\.jsonl/);
    } finally {
      cleanup();
    }
  });

  it("throws TerminationReadError when index.jsonl has no matching drain_id lane entries", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      // index.jsonl 里有条目但 drain_id 不匹配
      writeIndexEntry(root, { drain_id: "different-drain", lane: "tick", run_dir: runDir });
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(TerminationReadError);
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(/drain_id/);
    } finally {
      cleanup();
    }
  });

  it("throws TerminationReadError when index.jsonl is missing", () => {
    const { root, drainId, cleanup } = setupFakeRuntime();
    try {
      // 故意不写 index.jsonl
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(TerminationReadError);
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(/index\.jsonl/);
    } finally {
      cleanup();
    }
  });
});

describe("§1.1 broken result string ⇒ loud failure (termination nests inside result)", () => {
  it("throws TerminationReadError when tick result is not valid JSON", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir });
      writeJournalEntry(runDir, {
        run_id: "tick~1",
        identity: "tick",
        result: "not-valid-json",
      });
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(TerminationReadError);
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(/JSON\.parse.*result/);
    } finally {
      cleanup();
    }
  });

  it("throws TerminationReadError when result has no termination object", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir });
      writeJournalEntry(runDir, {
        run_id: "tick~1",
        identity: "tick",
        result: JSON.stringify({ hasPendingWork: true }),  // 没有 termination 键
      });
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(TerminationReadError);
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(/termination/);
    } finally {
      cleanup();
    }
  });

  it("throws TerminationReadError when result is missing (no string result field)", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir });
      writeJournalEntry(runDir, {
        run_id: "tick~1",
        identity: "tick",
        // 没有 result 字段
      });
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(TerminationReadError);
    } finally {
      cleanup();
    }
  });

  it("throws TerminationReadError when termination.state is not a known TerminalState", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir });
      writeJournalEntry(runDir, {
        run_id: "tick~1",
        identity: "tick",
        result: JSON.stringify({
          termination: { state: "bogus", coverage: 0, zeroGrowthRounds: 0, capHit: false },
        }),
      });
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(TerminationReadError);
      expect(() =>
        readTerminationFromDrain(JSON.stringify({ drain_id: drainId }), root),
      ).toThrow(/TerminalState/);
    } finally {
      cleanup();
    }
  });
});

describe("§1.1 helper unit coverage", () => {
  it("readLaneEntriesForDrain returns entries with run_dir for matching drain_id", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeIndexEntry(root, { drain_id: drainId, lane: "tick", run_dir: runDir, tick: 1 });
      const lanes = readLaneEntriesForDrain(root, drainId);
      expect(lanes).toHaveLength(1);
      expect(lanes[0].run_dir).toBe(runDir);
      expect(lanes[0].lane).toBe("tick");
    } finally {
      cleanup();
    }
  });

  it("readLastTickJournalLine returns the last identity=='tick' entry", () => {
    const { root, runDir, drainId, cleanup } = setupFakeRuntime();
    try {
      writeFileSync(
        join(runDir, "journal.jsonl"),
        JSON.stringify({ identity: "tick", result: tickResultJson(null) }) + "\n" +
          JSON.stringify({ identity: "tick", result: tickResultJson("converged") }) + "\n",
      );
      const last = readLastTickJournalLine(runDir, "tick");
      const parsed = parseTerminationFromTickResult(last, runDir, "tick");
      expect(parsed.state).toBe("converged");
    } finally {
      cleanup();
    }
  });
});
