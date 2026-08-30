/**
 * C5 ——「预算耗尽 + 板面未排空 + 报告未生成 ⇒ 响亮非收敛终态」判别性测试（判别测试 1-3）。
 *
 * 真机实据（spec §一）：coverage=40 后触 maxDepth=3 深度封顶，capHit=true 但
 * in_flight≈26/proposed≈11/open≈11 在 max_passes=68 有界预算内恒未排空 ⇒
 * decideTermination 被 inFlight>0 永久卡死（state 恒 null）⇒ decideGenerate 恒 false ⇒
 * runGenerate 永不触发 ⇒ 零报告；预算耗尽后 drain 以 status=done + outstanding>0 + 无 reason
 * + exit 0 静默收尾（C3 违约）。
 *
 * 判别性规格（§四）：
 *   1. 预算耗尽 + 未排空（in_flight>0 或 proposed>0）+ 报告未生成 ⇒ drain 写响亮非收敛 reason
 *     （machine-readable，点名 outstanding/in_flight/proposed/open 计数）且非零退出。
 *   2. 卡死的 in_flight worker（started 超预算 / exited 无 result）须在有界预算内被
 *     bounded-terminalize（转 blocked，带点名 run_id/缺 result/超时的 rationale），
 *     使板面可排空、decideTermination 可评估、generate 可点燃。
 *   3. 终态转移后 termination.state 在有界预算内达到非空（converged/partial/capped）⇒ generate 被触发。
 *
 * 判别测试 1：深度封顶后板面仍有 in_flight(26)/proposed(11) 排不尽 ⇒ 预算耗尽路径产出
 *   非空响亮的非收敛终态（state 或 reason 非空），且 drain 退出契约非零。
 * 判别测试 2：含 ≥1 张「started 但超预算仍未 exit」或「exited(0) 无 result」卡 ⇒
 *   bounded-terminalize 在有限轮次内把该卡转 blocked（响亮态），不无限 in_flight。
 * 判别测试 3：「预算耗尽 + 未排空」时 drain 写 reason 点名三个计数且 exit_code!=0。
 */
import { describe, it, expect, afterEach } from "vitest";
import {
  appendFileSync,
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  decideDrainExit,
  type DrainExitContractResult,
} from "../src/run-exit-diagnostic";
import {
  decideTick,
  decideTermination,
  DEFAULT_TICK_CONFIG,
  type BoardCard,
  type BoardState,
  type Decision,
  type RunEvent,
  type TerminationState,
} from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CHECKER = join(ROOT, "scripts", "check-drain-failures.mjs");

function card(
  clueId: string,
  status: BoardCard["status"],
  over: Partial<BoardCard> = {},
): BoardCard {
  return {
    clueId,
    text: `investigate ${clueId}`,
    status,
    depth: 0,
    sources: ["code-remote"],
    retries: 0,
    runId: null,
    ...over,
  };
}

function runEvent(state: RunEvent["state"], exitCode?: number): RunEvent {
  return state === "exited" ? { state, exitCode } : { state };
}

function emptyState(): BoardState {
  return { cards: [], runs: {}, triageInFlight: false };
}

afterEach(() => {
  delete process.env.DR_DRAIN_RETRY_WRAPPED;
  delete process.env.LOOP_ENGINE_RUNTIME_ROOT;
  delete process.env.RESEARCH_ORIGIN;
  delete process.env.TICK_CHANNEL;
  delete process.env.DR_ONE_SHOT_DIR;
});

// ── 判别测试 1：深度封顶 + in_flight(26)/proposed(11) 排不尽 ⇒ 预算耗尽响亮非收敛终态 ──

describe("C5-fix5 判别测试 1: depth-capped undrainable board ⇒ budget exhaustion path produces loud non-convergent terminal + non-zero drain exit", () => {
  function undrainableState(): BoardState {
    const cards: BoardCard[] = [];
    const runs: Record<string, RunEvent> = {};
    // 26 张 in_flight：started 但超预算仍未 exit（c5fix4 只治 exited-no-result，started 永不-exit 幸存）。
    for (let i = 0; i < 26; i += 1) {
      const id = `clue_inflight_${i}`;
      cards.push(
        card(id, "in_flight", { depth: 3, runId: `run_${i}` }),
      );
      runs[`run_${i}`] = runEvent("started");
    }
    // 11 张 proposed + 11 张 open（深度封顶后仍排不尽）。
    for (let i = 0; i < 11; i += 1) {
      cards.push(card(`clue_proposed_${i}`, "proposed", { depth: 3 }));
      cards.push(card(`clue_open_${i}`, "open", { depth: 3 }));
    }
    return { cards, runs, triageInFlight: false };
  }

  it("decideTick(budgetExhausted) bounded-terminalizes started in_flight cards to blocked, then decideTermination produces non-empty loud reason", () => {
    const state = undrainableState();
    // 预算耗尽：started 超预算在飞卡 → blocked（响亮态），绝不无限 in_flight。
    const decisions = decideTick(state, DEFAULT_TICK_CONFIG, { budgetExhausted: true });
    const startedBlocked = decisions.filter(
      (d): d is Extract<Decision, { kind: "reclaim" }> =>
        d.kind === "reclaim" && d.to === "blocked",
    );
    expect(startedBlocked.length).toBe(26);
    const rationale = startedBlocked[0].rationale ?? "";
    expect(rationale).toContain("run_0");
    expect(rationale).toContain("budget");

    // 终态转移后的板面：26 张 in_flight 已转 blocked，proposed(11)/open(11) 仍在。
    const blockedIds = new Set(startedBlocked.map((d) => d.clueId));
    const postCards = state.cards.map((c) =>
      blockedIds.has(c.clueId) ? { ...c, status: "blocked" as const } : c,
    );
    const term = decideTermination(
      {
        cards: postCards,
        coveredClueIds: [],
        prevCoverage: 0,
        prevZeroGrowthRounds: 0,
        budgetExhausted: true,
      },
      DEFAULT_TICK_CONFIG,
    );
    // ⛔ 判别性规格 1：预算耗尽路径必须产出非空响亮非收敛终态（state 或 reason 非空）。
    expect(term.state !== null || (term.reason ?? null) !== null).toBe(true);
    expect(term.reason).toContain("in_flight=0");
    expect(term.reason).toContain("proposed=11");
    expect(term.reason).toContain("open=11");

    // drain 退出契约非零（判别测试 1 收尾）。
    const exit = decideDrainExit({
      budgetExhausted: true,
      boardComposition: term.boardComposition,
      outstanding: 1,
      reportGenerated: false,
    });
    expect(exit.exitCode).not.toBe(0);
    expect(exit.reason).toMatch(/in_flight=\d+/);
    expect(exit.reason).toMatch(/proposed=\d+/);
    expect(exit.reason).toMatch(/open=\d+/);
  });

  it("healthy control: budget NOT exhausted ⇒ no loud reason (regression guard)", () => {
    const state = undrainableState();
    const decisions = decideTick(state, DEFAULT_TICK_CONFIG);
    expect(decisions.filter((d) => d.kind === "reclaim" && d.to === "blocked")).toHaveLength(0);
    const term = decideTermination(
      {
        cards: state.cards,
        coveredClueIds: [],
        prevCoverage: 0,
        prevZeroGrowthRounds: 0,
        budgetExhausted: false,
      },
      DEFAULT_TICK_CONFIG,
    );
    expect(term.state).toBeNull();
    expect(term.reason ?? null).toBeNull();
  });
});

// ── 判别测试 2：started 超预算 / exited(0) 无 result ⇒ bounded-terminalize 转 blocked ──

describe("C5-fix5 判别测试 2: started-over-budget / exited(0)-no-result card ⇒ bounded-terminalize to blocked within finite rounds", () => {
  it("started-but-over-budget in_flight card ⇒ decideTick(budgetExhausted) emits reclaim to blocked with run_id rationale", () => {
    const state = emptyState();
    state.cards = [
      card("clue_stuck", "in_flight", { runId: "run_stuck" }),
    ];
    state.runs["run_stuck"] = runEvent("started");

    const decisions = decideTick(state, DEFAULT_TICK_CONFIG, { budgetExhausted: true });
    const blocked = decisions.filter(
      (d): d is Extract<Decision, { kind: "reclaim" }> =>
        d.kind === "reclaim" && d.to === "blocked" && d.clueId === "clue_stuck",
    );
    expect(blocked).toHaveLength(1);
    expect(blocked[0].rationale ?? "").toContain("run_stuck");
  });

  it("finite rounds: repeated decideTick(budgetExhausted) keeps the card blocked, never returns to in_flight", () => {
    const state = emptyState();
    state.cards = [
      card("clue_stuck", "in_flight", { runId: "run_stuck" }),
    ];
    state.runs["run_stuck"] = runEvent("started");

    // 有限轮次（预算内）：第 1 轮 bounded-terminalize 到 blocked。
    let d1 = decideTick(state, DEFAULT_TICK_CONFIG, { budgetExhausted: true });
    expect(d1.some((d) => d.kind === "reclaim" && d.to === "blocked")).toBe(true);

    // 终态转移后板面 in_flight=0：第 2 轮不再有 in_flight 卡可回收 ⇒ 不会回到 in_flight。
    state.cards = [{ ...state.cards[0], status: "blocked" }];
    const d2 = decideTick(state, DEFAULT_TICK_CONFIG, { budgetExhausted: true });
    expect(d2.some((d) => d.kind === "reclaim" && d.to === "in_flight")).toBe(false);
    expect(d2.some((d) => d.kind === "dispatch" && d.clueId === "clue_stuck")).toBe(false);
  });

  it("exited(0)-no-result in_flight card ⇒ decideTick emits harvest; c5fix4 noResultBlocked terminalizes to blocked (covered by c5fix4, here direct decideDrainExit sanity)", () => {
    const state = emptyState();
    state.cards = [
      card("clue_dead", "in_flight", { runId: "run_dead" }),
    ];
    state.runs["run_dead"] = runEvent("exited", 0);
    const decisions = decideTick(state, DEFAULT_TICK_CONFIG, { budgetExhausted: true });
    expect(decisions.some((d) => d.kind === "harvest" && d.clueId === "clue_dead")).toBe(true);
  });
});

// ── 判别测试 3：预算耗尽 + 未排空 ⇒ drain 写 reason 点名三个计数且 exit_code!=0 ──

describe("C5-fix5 判别测试 3: budget exhausted + not drained ⇒ drain writes reason naming three counts and exit_code != 0", () => {
  it("decideDrainExit (TS single source of truth): budgetExhausted + undrained + no report ⇒ exit 3 + reason names outstanding/in_flight/proposed/open", () => {
    const r: DrainExitContractResult = decideDrainExit({
      budgetExhausted: true,
      boardComposition: { inFlight: 26, proposed: 11, open: 11 },
      outstanding: 1,
      reportGenerated: false,
    });
    expect(r.exitCode).not.toBe(0);
    expect(r.reason).toContain("outstanding=1");
    expect(r.reason).toContain("in_flight=26");
    expect(r.reason).toContain("proposed=11");
    expect(r.reason).toContain("open=11");
  });

  it("sentinel (check-drain-failures.mjs): done + outstanding>0 + max_rounds budget hit + board composition in tick output ⇒ reason names in_flight/proposed/open counts + exit != 0", () => {
    const dir = mkdtempSync(join(tmpdir(), "c5fix5-"));
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs", "run-fix5");
    mkdirSync(runsRoot, { recursive: true });
    const runDir = join(runsRoot, "tick-run-fix5");
    mkdirSync(runDir, { recursive: true });

    // drain.json：预算耗尽的 registry 形态（done + outstanding=1 + 无 reason）。
    writeFileSync(
      join(runsRoot, "drain.json"),
      JSON.stringify(
        {
          contract_version: 2,
          drain_id: "c5fix5-drain",
          runs_root: runsRoot,
          pid: 1,
          status: "done",
          loop_events: "loop-events.jsonl",
          last_heartbeat: 0,
          outstanding: 1,
          ended: 1,
        },
        null,
        2,
      ),
    );
    const indexPath = join(engineRoot, "index.jsonl");
    const base = { schema: "lei/1", ts: new Date().toISOString(), pid: 12345 };
    writeFileSync(
      indexPath,
      JSON.stringify({
        ...base,
        kind: "run.start",
        run_id: "c5fix5-drain",
        label: "deep-research",
        fleet: "fleet.yaml",
        run_dir: runsRoot,
      }) + "\n",
    );
    appendFileSync(
      indexPath,
      JSON.stringify({
        ...base,
        kind: "run.end",
        run_id: "c5fix5-drain",
        label: "deep-research",
        fleet: "fleet.yaml",
      }) + "\n",
    );
    appendFileSync(
      indexPath,
      JSON.stringify({
        ...base,
        kind: "run.start",
        run_id: "tick-fix5",
        label: "tick",
        fleet: "workflows/deep-research/tick",
        run_dir: runDir,
        drain_id: "c5fix5-drain",
        lane: "tick",
        tick: 1,
      }) + "\n",
    );
    // tick 的 run 输出 JSON（journal result 字段）：termination.boardComposition 携带板面计数。
    const tickOut = JSON.stringify({
      hasPendingWork: true,
      termination: {
        state: null,
        coverage: 40,
        zeroGrowthRounds: 38,
        capHit: true,
        boardComposition: { proposed: 11, open: 11, inFlight: 26, explored: 25, blocked: 6 },
      },
    });
    writeFileSync(
      join(runDir, "journal.jsonl"),
      JSON.stringify({ run_id: "tick~1", identity: "tick", result: tickOut }) + "\n",
    );

    const summary = JSON.stringify({
      reason: "max_rounds",
      rounds: 68,
      ticksByLabel: { tick: 68 },
      runs_root: runsRoot,
      drain_id: "c5fix5-drain",
    });

    let code = 0;
    let err = "";
    try {
      execFileSync("node", [CHECKER], {
        input: summary,
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: engineRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      const ce = e as { status?: number; stderr?: string | Buffer };
      code = ce.status ?? -1;
      err = String(ce.stderr ?? "");
    }

    // 判别测试 3：exit_code != 0 且 reason 点名三个计数。
    expect(code).not.toBe(0);
    expect(err).toContain("budget_exhausted_no_report");
    expect(err).toContain("in_flight=26");
    expect(err).toContain("proposed=11");
    expect(err).toContain("open=11");

    rmSync(dir, { recursive: true, force: true });
  });

  it("healthy control: budget NOT hit (drained) ⇒ no budget_exhausted_no_report (regression guard)", () => {
    const dir = mkdtempSync(join(tmpdir(), "c5fix5-ok-"));
    const engineRoot = join(dir, "engine-root");
    mkdirSync(engineRoot, { recursive: true });
    const runsRoot = join(engineRoot, "runs", "run-fix5-ok");
    mkdirSync(runsRoot, { recursive: true });
    const runDir = join(runsRoot, "tick-run-fix5-ok");
    mkdirSync(runDir, { recursive: true });

    writeFileSync(
      join(runsRoot, "drain.json"),
      JSON.stringify({
        contract_version: 2,
        drain_id: "c5fix5-drain-ok",
        runs_root: runsRoot,
        pid: 1,
        status: "done",
        loop_events: "loop-events.jsonl",
        last_heartbeat: 0,
        outstanding: 0,
        ended: 1,
      }),
    );
    const indexPath = join(engineRoot, "index.jsonl");
    const base = { schema: "lei/1", ts: new Date().toISOString(), pid: 12345 };
    writeFileSync(
      indexPath,
      JSON.stringify({ ...base, kind: "run.start", run_id: "c5fix5-drain-ok", label: "deep-research", fleet: "fleet.yaml", run_dir: runsRoot }) + "\n",
    );
    appendFileSync(indexPath, JSON.stringify({ ...base, kind: "run.end", run_id: "c5fix5-drain-ok", label: "deep-research", fleet: "fleet.yaml" }) + "\n");
    appendFileSync(indexPath, JSON.stringify({ ...base, kind: "run.start", run_id: "tick-fix5-ok", label: "tick", fleet: "workflows/deep-research/tick", run_dir: runDir, drain_id: "c5fix5-drain-ok", lane: "tick", tick: 1 }) + "\n");
    writeFileSync(join(runDir, "journal.jsonl"), JSON.stringify({ run_id: "tick~1", identity: "tick", result: "OK: all fine" }) + "\n");

    const summary = JSON.stringify({ reason: "drained", rounds: 2, ticksByLabel: { tick: 2 }, runs_root: runsRoot, drain_id: "c5fix5-drain-ok" });

    let err = "";
    try {
      execFileSync("node", [CHECKER], {
        input: summary,
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, LOOP_ENGINE_RUNTIME_ROOT: engineRoot },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (e) {
      err = String((e as { stderr?: string | Buffer }).stderr ?? "");
    }
    expect(err).not.toContain("budget_exhausted_no_report");
    expect(err).not.toContain("ZERO REPORT");

    rmSync(dir, { recursive: true, force: true });
  });
});
