/**
 * E0c2b §1.1 —— 终态取真值：discriminative tests for src/e0c2b-terminal-read.ts.
 *
 * 钉死的判别性（spec §2 判据 2/3/6c）：
 *  - C2 termination.state == null ⇒ 入口非零退出；把终态判据换成「用 drain 摘要的 reason」⇒ 红。
 *  - C3 journal 里没有 identity=="tick" 的条目 ⇒ 响亮失败并点名该步（find_tick_entry），
 *      ⛔ 不得当作任一方向的默认值。
 *  - C6c (GT-7) drain 摘要是含 `"ticksByLabel":{"tick":16}` 的**嵌套对象**单行 JSON，
 *      brace-free 正则永远抓不到；摘要抽取必须逐行 JSON.parse 成功。
 *  - 另覆盖：empty stdout、无 drain_id、result 非 JSON、termination 缺字段等各失败路径。
 */
import { describe, it, expect } from "vitest";
import {
  parseDrainSummary,
  findRunDirsForDrain,
  findTickTerminationInJournal,
  parseTickTerminationFromJournalLine,
  readTerminalStateFromDrain,
  TerminalReadError,
  resolveRuntimeRoot,
} from "../src/e0c2b-terminal-read";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// ── C6c (GT-7): 嵌套 JSON 摘要可逐行 JSON.parse 抽取 ─────────────────────

describe("C6c (GT-7): nested-JSON drain summary extraction (line-wise JSON.parse)", () => {
  it("extracts summary with nested ticksByLabel object (brace regex would fail)", () => {
    // 真实形状（GT-7）：`"ticksByLabel":{"tick":16}` 是嵌套对象。
    // brace-free 正则 `\{[^{}]*"drain_id"[^{}]*\}` 恒抓空（花括号在 ticksByLabel 的值里）。
    const stdout = [
      '{"id":"a9-x","status":"open","body":{"seed":true}}',
      '[deep-research-loop] mode=deep-research run_root=/data/x',
      '{"reason":"max_rounds","rounds":16,"ticksByLabel":{"tick":16},"runs_root":"/data/r","drain_id":"d-gt7"}',
    ].join("\n");
    const summary = parseDrainSummary(stdout);
    expect(summary.drain_id).toBe("d-gt7");
    expect(summary.reason).toBe("max_rounds");
    // 嵌套对象整体保留（不是被正则切碎的子串）。
    expect(summary.ticksByLabel).toEqual({ tick: 16 });
  });

  it("takes the LAST drain_id-bearing JSON line (final summary at stdout end)", () => {
    const stdout = [
      '{"drain_id":"d-early","reason":"drained"}',
      '{"drain_id":"d-final","reason":"max_rounds","ticksByLabel":{"tick":16}}',
    ].join("\n");
    const summary = parseDrainSummary(stdout);
    expect(summary.drain_id).toBe("d-final");
  });

  it("discriminates: brace-regex shape (extracted substring without nested object) would miss — this asserts full object", () => {
    // 变异检测：如果实现退回 brace 正则，它会匹配不到（因 ticksByLabel 值含 {），
    // parseDrainSummary 应抛 TerminalReadError("parse_drain_summary")。
    const stdout = '{"reason":"drained","ticksByLabel":{"tick":1},"drain_id":"d1"}';
    expect(() => parseDrainSummary(stdout)).not.toThrow();
    // 而纯文本行（无 JSON）⇒ 抛。
    expect(() => parseDrainSummary("just some text\nno json here")).toThrow(TerminalReadError);
  });

  it("empty stdout ⇒ loud failure naming parse_drain_summary", () => {
    expect(() => parseDrainSummary("")).toThrow(TerminalReadError);
    expect(() => parseDrainSummary("   \n  ")).toThrow(TerminalReadError);
    try {
      parseDrainSummary("");
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as TerminalReadError).step).toBe("parse_drain_summary");
    }
  });

  it("stdout without any drain_id JSON line ⇒ loud failure naming parse_drain_summary", () => {
    const stdout = '{"reason":"drained","rounds":1}\n{"no_drain_id":true}';
    try {
      parseDrainSummary(stdout);
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as TerminalReadError).step).toBe("parse_drain_summary");
    }
  });
});

// ── C3: journal 里没有 identity=="tick" 的条目 ⇒ 响亮失败并点名 find_tick_entry ──

describe("C3: no identity==\"tick\" entry ⇒ loud failure naming find_tick_entry", () => {
  it("journal with only non-tick entries ⇒ TerminalReadError(find_tick_entry)", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c2b-c3-"));
    try {
      const journalPath = join(dir, "journal.jsonl");
      // 只有 triage 条目，没有 tick 条目。
      writeFileSync(
        journalPath,
        JSON.stringify({
          run_id: "triage~1",
          identity: "triage",
          result: "{}",
          effects: [],
        }) + "\n",
      );
      try {
        findTickTerminationInJournal(journalPath);
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TerminalReadError);
        expect((e as TerminalReadError).step).toBe("find_tick_entry");
        // 消息点名 identity=="tick"（让回查方知道判别依据）。
        expect((e as TerminalReadError).message).toMatch(/identity.*tick/);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("journal with tick entry whose result has no termination ⇒ TerminalReadError(parse_tick_result)", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c2b-c3b-"));
    try {
      const journalPath = join(dir, "journal.jsonl");
      writeFileSync(
        journalPath,
        JSON.stringify({
          run_id: "tick~1",
          identity: "tick",
          result: JSON.stringify({ hasPendingWork: false }), // 无 termination 字段
          effects: [],
        }) + "\n",
      );
      try {
        findTickTerminationInJournal(journalPath);
        throw new Error("should have thrown");
      } catch (e) {
        // 有 tick 行但 result 解析不出 termination ⇒ parse_tick_result（与 find_tick_entry 区分）。
        expect(e).toBeInstanceOf(TerminalReadError);
        expect((e as TerminalReadError).step).toBe("parse_tick_result");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("journal missing entirely ⇒ TerminalReadError(read_journal)", () => {
    const dir = mkdtempSync(join(tmpdir(), "e0c2b-c3c-"));
    try {
      try {
        findTickTerminationInJournal(join(dir, "nope.jsonl"));
        throw new Error("should have thrown");
      } catch (e) {
        expect(e).toBeInstanceOf(TerminalReadError);
        expect((e as TerminalReadError).step).toBe("read_journal");
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── GT-2: termination 是嵌套在 result 字符串里的，不是 journal 行顶层键 ──

describe("GT-2: termination is nested-escaped inside result string (not a top-level journal key)", () => {
  it("parseTickTerminationFromJournalLine extracts termination from escaped result string", () => {
    // journal 行：result 是 tick 的完整 stdout（JSON-as-string，转义）。
    const tickResult = JSON.stringify({
      channelId: "research:x",
      hasPendingWork: false,
      decisions: [],
      termination: { state: "converged", coverage: 1, zeroGrowthRounds: 2, capHit: false },
    });
    const journalLine = JSON.stringify({
      run_id: "tick~1",
      identity: "tick",
      result: tickResult, // 嵌套转义字符串
      effects: [],
    });
    const parsed = parseTickTerminationFromJournalLine(journalLine);
    expect(parsed).not.toBeNull();
    expect(parsed!.termination.state).toBe("converged");
    expect(parsed!.termination.coverage).toBe(1);
    expect(parsed!.termination.zeroGrowthRounds).toBe(2);
    expect(parsed!.termination.capHit).toBe(false);
  });

  it("null state (not yet terminated) is preserved, not defaulted to a terminal value", () => {
    const tickResult = JSON.stringify({
      termination: { state: null, coverage: 0, zeroGrowthRounds: 1, capHit: false },
    });
    const journalLine = JSON.stringify({ run_id: "tick~1", identity: "tick", result: tickResult });
    const parsed = parseTickTerminationFromJournalLine(journalLine);
    expect(parsed).not.toBeNull();
    expect(parsed!.termination.state).toBeNull(); // ⛔ 不得把 null 默认成任一终态
  });

  it("discriminates: a top-level termination key on the journal line is NOT read (must parse result first)", () => {
    // 变异：如果实现错把 termination 当 journal 行顶层键，它会读到这个假的 "capped"。
    // 正确实现先取 result 再 JSON.parse，拿到 result 内的 null（真值）。
    const tickResult = JSON.stringify({
      termination: { state: null, coverage: 0, zeroGrowthRounds: 0, capHit: false },
    });
    const journalLine = JSON.stringify({
      run_id: "tick~1",
      identity: "tick",
      result: tickResult,
      termination: { state: "capped" }, // 顶层陷阱：不应被读
      effects: [],
    });
    const parsed = parseTickTerminationFromJournalLine(journalLine);
    expect(parsed).not.toBeNull();
    expect(parsed!.termination.state).toBeNull(); // 来自 result，不是顶层陷阱
  });
});

// ── 端到端 readTerminalStateFromDrain（含 GT-7 嵌套 + GT-2 嵌套转义） ──

describe("readTerminalStateFromDrain: end-to-end (GT-7 nested summary + GT-2 nested result)", () => {
  it("reads termination.state from a fully-shaped drain (reason=drained, ticksByLabel nested)", () => {
    const root = mkdtempSync(join(tmpdir(), "e0c2b-e2e-"));
    try {
      const runDir = join(root, "runs", "run-1");
      mkdirSync(runDir, { recursive: true });
      // GT-7 嵌套摘要
      const stdout =
        '{"reason":"drained","rounds":1,"ticksByLabel":{"tick":1},"runs_root":"' +
        root +
        '","drain_id":"d-e2e"}\n';
      // index.jsonl
      writeFileSync(
        join(root, "index.jsonl"),
        JSON.stringify({
          schema: "lei/1",
          drain_id: "d-e2e",
          lane: "tick",
          run_dir: runDir,
        }) + "\n",
      );
      // GT-2 嵌套转义 result
      const tickResult = JSON.stringify({
        termination: { state: "converged", coverage: 3, zeroGrowthRounds: 2, capHit: false },
      });
      writeFileSync(
        join(runDir, "journal.jsonl"),
        JSON.stringify({ run_id: "tick~1", identity: "tick", result: tickResult }) + "\n",
      );
      const snap = readTerminalStateFromDrain(stdout, root);
      expect(snap.state).toBe("converged");
      expect(snap.coverage).toBe(3);
      expect(snap.drainId).toBe("d-e2e");
      expect(snap.reason).toBe("drained");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("findRunDirsForDrain: no lane entries ⇒ TerminalReadError(find_run_dirs)", () => {
    const root = mkdtempSync(join(tmpdir(), "e0c2b-e2e2-"));
    try {
      writeFileSync(join(root, "index.jsonl"), "");
      try {
        findRunDirsForDrain(join(root, "index.jsonl"), "d-none");
        throw new Error("should have thrown");
      } catch (e) {
        expect((e as TerminalReadError).step).toBe("find_run_dirs");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolveRuntimeRoot: LOOP_ENGINE_RUNTIME_ROOT takes precedence", () => {
    expect(resolveRuntimeRoot({ LOOP_ENGINE_RUNTIME_ROOT: "/custom/root" })).toBe(
      "/custom/root",
    );
  });
});
