/**
 * E0c2 §1.3 / §2 判据 5,6 —— 跨 drain 循环（GT-3）+ 上限保护。
 *
 * 判据 5（GT-3 判别性）：构造「第一次 drain 后 termination.state 仍 null、第二次后非 null」⇒
 *   入口**继续跑第二轮并最终退出 0**；改回只跑一次 drain ⇒ 测试变红。
 * 判据 6（上限判别性）：termination.state 永远为 null ⇒ 撞到 profile 声明的上限时非零退出，
 *   且点名撞的是哪个上限（drain 次数或墙钟）；⛔ 不得无限循环。
 *
 * 测试分两层：
 *   A. 逻辑层：用 readTerminationFromDrain 模拟跨 drain 的循环判定（判别性在于循环本身）。
 *   B. 入口层：验证 bin/e0-regression.sh 真的包含循环结构、上限检查、退避、每轮记录，
 *      且 deep-research-loop.sh 在跨 drain 时跳过 seed（GT-3 续投链不断）。
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readTerminationFromDrain } from "../src/e0c2-termination-read";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const E0_SCRIPT = join(ROOT, "bin", "e0-regression.sh");
const DRIVER_SCRIPT = join(ROOT, "bin", "deep-research-loop.sh");

function makeDrainRuntime(testDir: string, drainId: string, state: string | null): string {
  const runDir = join(testDir, "runtime", "runs", drainId);
  mkdirSync(runDir, { recursive: true });
  const termJson = JSON.stringify({
    hasPendingWork: false,
    termination: { state, coverage: state === null ? 0 : 1, zeroGrowthRounds: state === null ? 1 : 2, capHit: false },
  });
  writeFileSync(
    join(runDir, "journal.jsonl"),
    JSON.stringify({ run_id: "tick~1", identity: "tick", result: termJson }) + "\n",
  );
  return runDir;
}

function appendIndexEntry(runtimeRoot: string, drainId: string, runDir: string): void {
  const indexPath = join(runtimeRoot, "index.jsonl");
  const entry = JSON.stringify({ drain_id: drainId, lane: "tick", run_dir: runDir }) + "\n";
  const existing = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : "";
  writeFileSync(indexPath, existing + entry);
}

// ── 逻辑层：跨 drain 循环判定 ──────────────────────────────────────────────

describe("§2 判据 5 (GT-3): first drain null, second drain non-null ⇒ loop must continue", () => {
  it("first drain state==null, second drain state==converged ⇒ loop reaches 2nd drain and succeeds", () => {
    const testDir = mkdtempSync(join(tmpdir(), "e0c2-loop5-"));
    try {
      const runtimeRoot = join(testDir, "runtime");
      mkdirSync(join(runtimeRoot, "runs"), { recursive: true });

      // drain 1: state=null（worker 还没返回，板面无进展）
      const runDir1 = makeDrainRuntime(testDir, "drain-1", null);
      // drain 2: state=converged（worker 返回后收割，终态达成）
      const runDir2 = makeDrainRuntime(testDir, "drain-2", "converged");

      writeFileSync(join(runtimeRoot, "index.jsonl"), "");
      appendIndexEntry(runtimeRoot, "drain-1", runDir1);
      appendIndexEntry(runtimeRoot, "drain-2", runDir2);

      const summary1 = JSON.stringify({ reason: "max_rounds", drain_id: "drain-1" });
      const summary2 = JSON.stringify({ reason: "drained", drain_id: "drain-2" });

      // 模拟入口的循环逻辑
      const states: (string | null)[] = [];
      const summaries = [summary1, summary2];
      for (const s of summaries) {
        const r = readTerminationFromDrain(s, runtimeRoot);
        states.push(r.state);
        if (r.state !== null) break; // 成功收尾
        // 否则退避后继续下一轮
      }

      // ⛔ 判据 5 核心：循环在第一次 null 后继续到第二次，第二次非 null ⇒ 成功。
      expect(states).toEqual([null, "converged"]);
      // 判别性：改回只跑一次 drain ⇒ states 只会是 [null] ⇒ 永远不会到 "converged" ⇒ 变红。
      expect(states[states.length - 1]).toBe("converged");
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

describe("§2 判据 6 (limits): state never non-null ⇒ must hit limit and fail (no infinite loop)", () => {
  it("all drains return null ⇒ loop hits attempt limit without infinite spin", () => {
    const testDir = mkdtempSync(join(tmpdir(), "e0c2-loop6-"));
    try {
      const runtimeRoot = join(testDir, "runtime");
      mkdirSync(join(runtimeRoot, "runs"), { recursive: true });
      writeFileSync(join(runtimeRoot, "index.jsonl"), "");

      // 模拟永远 null 的 drain（比 maxAttempts 多一些，验证循环在 maxAttempts 停而非遍历全部）
      const maxAttempts = 3;
      for (let i = 1; i <= 5; i++) {
        const runDir = makeDrainRuntime(testDir, `drain-${i}`, null);
        appendIndexEntry(runtimeRoot, `drain-${i}`, runDir);
      }

      let attemptsUsed = 0;
      let finalState: string | null = "never-ran";
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        attemptsUsed = attempt;
        const summary = JSON.stringify({ drain_id: `drain-${attempt}` });
        const r = readTerminationFromDrain(summary, runtimeRoot);
        finalState = r.state;
        if (r.state !== null) break;
      }

      // ⛔ 判据 6 核心：永远 null ⇒ 撞 maxAttempts 上限、非零退出（循环里 finalState 仍 null）
      expect(finalState).toBeNull();
      expect(attemptsUsed).toBe(maxAttempts); // 在上限停，不是遍历全部 5 个
      // 判别性：上限被设成无穷大 ⇒ 循环不会在有限步停 ⇒ 该测试无法完成 ⇒ 变红
    } finally {
      rmSync(testDir, { recursive: true, force: true });
    }
  });
});

// ── 入口层：验证真实脚本包含循环结构与上限保护 ─────────────────────────────

describe("§2 判据 5,6 entry-level: e0-regression.sh contains cross-drain loop with profile-declared limits", () => {
  it("e0-regression.sh has a drain loop that breaks on non-null termination state", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    // 判别性：改回只跑一次 drain ⇒ while : / break 消失 ⇒ 变红
    expect(script).toMatch(/while\s*:/);
    expect(script).toMatch(/break/);
  });

  it("e0-regression.sh checks all three profile-declared limits (backoff, wall, attempts)", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    // ⛔ 三个上限都必须由 profile 声明（不在脚本里写死）
    expect(script).toMatch(/E0_DRAIN_BACKOFF_SECONDS/);
    expect(script).toMatch(/E0_DRAIN_MAX_WALL_SECONDS/);
    expect(script).toMatch(/E0_DRAIN_MAX_ATTEMPTS/);
    // 缺失任何一个 ⇒ REFUSING to start（spec §1.3）
    expect(script).toMatch(/REFUSING to start.*E0_DRAIN_BACKOFF_SECONDS/);
    expect(script).toMatch(/REFUSING to start.*E0_DRAIN_MAX_WALL_SECONDS/);
    expect(script).toMatch(/REFUSING to start.*E0_DRAIN_MAX_ATTEMPTS/);
    // 三个值都必须是正整数（⛔ 不得零间隔空转）
    expect(script).toMatch(/positive integer/);
  });

  it("e0-regression.sh names which limit was hit on failure (drain count or wall-clock)", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    expect(script).toMatch(/hit drain count limit/);
    expect(script).toMatch(/hit wall-clock limit/);
    // 失败时退出非 0
    expect(script).toMatch(/_LOOP_FINAL_EXIT=3/);
  });

  it("e0-regression.sh backs off between drains (not zero-interval spinning)", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    // ⛔ 退避量级与 worker 真实耗时相称（sleep DRAIN_BACKOFF），不是零间隔
    expect(script).toMatch(/sleep.*DRAIN_BACKOFF/);
    expect(script).toMatch(/backing off/);
  });

  it("e0-regression.sh reads termination via e0c2-termination-read.ts (GT-2 path, not drain reason)", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    // §1.1：终态取真值用 e0c2-termination-read.ts（GT-2 路径），⛔ 不用 drain reason 凑合
    expect(script).toMatch(/e0c2-termination-read/);
    expect(script).toMatch(/Refusing to fall back to drain reason/);
  });

  it("e0-regression.sh appends every drain attempt to drain-attempts.jsonl (not just the last)", () => {
    const script = readFileSync(E0_SCRIPT, "utf8");
    // ⛔ 每轮的 runs_root/reason/终态都追加进运行记录，不只留最后一轮
    expect(script).toMatch(/drain-attempts\.jsonl/);
    // 进度行：第几轮 / drain reason / termination.state / head_seq
    expect(script).toMatch(/termination\.state=/);
    expect(script).toMatch(/tick_head_seq=/);
  });
});

describe("§2 判据 5 (GT-3): deep-research-loop.sh skips seed when open triggers exist", () => {
  it("driver checks list open before seeding and skips seed when triggers already exist", () => {
    // GT-3 跨 drain 续投链：deep-research-loop.sh 在 store 已有 open 触发时跳过 seed。
    // ⛔ 没有这个跳过 ⇒ 第二次 drain 再投 seed（body={"seed":true}）⇒ tick 以 firstRound 重置计数器。
    const driver = readFileSync(DRIVER_SCRIPT, "utf8");
    expect(driver).toMatch(/list open/);
    expect(driver).toMatch(/skipping seed/);
    // 判别性：删掉跳过逻辑 ⇒ seed 总被执行 ⇒ 续投链断裂 ⇒ 变红
  });
});
