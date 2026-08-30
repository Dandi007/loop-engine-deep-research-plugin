/**
 * C5-fix4 —— worker exit 0 无 result ⇒ in_flight 永卡 → terminate 门控死锁 → generate 永不触发
 * （C5 冷启动最终复验新失败签名，判别性规格 §四）。
 *
 * 根因链（spec §根因链）：in_flight 卡的 run 已 exited(0) 但 board:agent-runs 上永无
 * `worker.result.v1` ⇒ `harvestCard` no_result 分支按 A10a §0.3「找不到结果 ≠ 无产出」
 * 留 in_flight、下一 tick 幂等重放 ⇒ `decideTermination` 被 inFlight>0 永久卡死（state 恒 null）
 * ⇒ `decideGenerate` = (state !== null) 恒 false ⇒ `runGenerate` 永不触发 ⇒ max_passes 耗尽
 * 零报告。判别性规格 §四.1/§四.2：run 已 exit（含 exit 0）且宽限窗口内仍无 result ⇒ 该卡必须
 * 转移到响亮终态（blocked，带机器可读 rationale），termination.state 在有界轮次预算内必须非空、
 * generate 必须被触发。
 *
 * 本文件驱动**真实 tick**（runChannelWrite，不 mock spawn），钉死判别性规格：
 *   - 判别测试 1：exit 0 无 result 的 in_flight 卡经 decideTick + harvest 不再无限 in_flight
 *     （noResultBlocked ⇒ CAS → blocked，绝无 explored CAS）；
 *   - 判别测试 2：含 ≥1 张「exit 0 无 result」卡时，decideTermination 在有限轮次内 state 非空
 *     （不依赖该卡 inFlight 归零死等），generate 被触发；
 *   - 回归护栏：结果在宽限窗口内（exit 刚发生）仍可晚到 ⇒ 不提前 blocked；no_result 且无
 *     exit 时间戳（readRunExitedAt 缺省）⇒ 维持 A10a §0.3 旧行为（留 in_flight）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChannelWrite } from "../src/tick-run";
import type { GenerateDeps } from "../src/generate";
import type { InspectMessage } from "../src/tick-inspect";

const CHANNEL = "research:c5fix4.index";
const RUNS_CHANNEL = "board:agent-runs";
const EVIDENCE_CHANNEL = "research:c5fix4.evidence";

const CLUE_DEAD = "clue_dead";
const RUN_DEAD = "run-dead";

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function clueMsg(
  clueId: string,
  runId: string,
  seq: number,
  created = "2026-01-01T00:00:00Z",
): InspectMessage {
  return {
    message_id: `msg_${clueId}`,
    channel_id: CHANNEL,
    channel_seq: seq,
    kind: "research.clue.v2",
    payload: {
      status: "in_flight",
      text: `investigate ${clueId}`,
      depth: 0,
      sources: ["code-remote"],
      run_id: runId,
    },
    entity_id: clueId,
    supersedes: null,
    created_at: created,
  };
}

function startedMsg(runId: string, seq: number) {
  return {
    message_id: `started_${runId}`,
    channel_id: RUNS_CHANNEL,
    channel_seq: seq,
    kind: "agent.run.started.v1",
    payload: { run_id: runId },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function exitedMsg(runId: string, seq: number, exitCode = 0) {
  return {
    message_id: `exited_${runId}`,
    channel_id: RUNS_CHANNEL,
    channel_seq: seq,
    kind: "agent.run.exited.v1",
    payload: { run_id: runId, exit_code: exitCode },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-01-01T00:00:01Z",
  };
}

const CLUE_DEAD_MSG = clueMsg(CLUE_DEAD, RUN_DEAD, 1);

interface CapturedPublish {
  kind: string;
  payload: Record<string, unknown>;
  entity_id?: string;
}

/** 打桩 fetch：板上 1 张 in_flight 卡，run 已 exited(0)，但 board:agent-runs 上永无 worker.result.v1。 */
function makeNoResultStub(opts: { exitCode?: number; exitPresent?: boolean } = {}): {
  captures: CapturedPublish[];
} {
  const { exitCode = 0, exitPresent = true } = opts;
  const captures: CapturedPublish[] = [];
  let boardCalls = 0;
  let runsCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/entities/")) {
        return jsonResponse({ head: CLUE_DEAD_MSG });
      }
      if (u.includes("/publish")) {
        if (init?.body) captures.push(JSON.parse(String(init.body)) as CapturedPublish);
        return jsonResponse({ message_id: `pub_${captures.length}`, channel_seq: 99 });
      }
      if (u.includes(`/v1/channels/${CHANNEL}/messages`)) {
        boardCalls += 1;
        return jsonResponse({ messages: boardCalls === 1 ? [CLUE_DEAD_MSG] : [] });
      }
      if (u.includes(`/v1/channels/${RUNS_CHANNEL}/messages`)) {
        const hasAfterSeq = /[?&]after_seq=/.test(u);
        if (hasAfterSeq) return jsonResponse({ messages: [] });
        runsCalls += 1;
        const msgs: unknown[] = [startedMsg(RUN_DEAD, 1)];
        if (exitPresent) msgs.push(exitedMsg(RUN_DEAD, 2, exitCode));
        return jsonResponse({ messages: msgs });
      }
      if (u.includes(`/v1/channels/${EVIDENCE_CHANNEL}/messages`)) {
        return jsonResponse({ messages: [] });
      }
      return jsonResponse({ messages: [] });
    }),
  );
  return { captures };
}

let oneShotDir: string;

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENT_RESULT_TIMEOUT_MS;
  delete process.env.AGENT_RESULT_POLL_MS;
  delete process.env.RUN_EXIT_GRACE_MS;
  rmSync(oneShotDir, { recursive: true, force: true });
});

function makeGenerateDeps(genHits: { generate: boolean }): GenerateDeps {
  return {
    readTermination: async () => ({
      state: "partial" as const,
      coverage: 0,
      zeroGrowthRounds: 2,
      capHit: false,
      boardComposition: { proposed: 0, open: 0, inFlight: 0, explored: 0, blocked: 1 },
    }),
    countBlocked: async () => 1,
    readQuestion: async () => "test question",
    readOrigin: async () => "test-origin",
    readEvidences: async () => [],
    spawnRole: vi.fn(async () => {
      genHits.generate = true;
      return { body: "report output" };
    }),
    spawnAnchorCheck: vi.fn(async () => ({
      total: 1,
      current_parsed: 1,
      current_verified_hit: 1,
      current_failed: 0,
      old_format: 0,
      unparseable: 0,
      discarded: 0,
      sums_ok: true,
      loud_failures: [],
    })),
    spawnExport: vi.fn(async () => {}),
    writeDoc: vi.fn(async () => "doc-msg-1"),
    lockSynthesizer: async () => async () => {},
  };
}

function freshOneShotDir(): string {
  oneShotDir = mkdtempSync(join(tmpdir(), "c5fix4-"));
  return oneShotDir;
}

// ── 判别测试 1：exit 0 无 result ⇒ 不再无限 in_flight（noResultBlocked ⇒ CAS → blocked）──────

describe("C5-fix4 判别测试 1: exit 0 无 result ⇒ noResultBlocked ⇒ card terminalized to blocked (no infinite in_flight)", () => {
  it("dead in_flight card (run exited 0, no worker.result.v1) ⇒ noResultBlocked=true, CAS → blocked, never explored", async () => {
    const { captures } = makeNoResultStub();
    freshOneShotDir();
    process.env.RUN_EXIT_GRACE_MS = "10";

    const outcome = await runChannelWrite({
      channelId: CHANNEL,
      evidenceChannelId: EVIDENCE_CHANNEL,
      maxWrites: 40,
    });

    // no_result 终态化：harvestReport 报告 noResultBlocked=true（不再是旧「无限 in_flight」形态）。
    expect(outcome.harvestReports).toHaveLength(1);
    const report = outcome.harvestReports[0];
    expect(report.clueId).toBe(CLUE_DEAD);
    expect(report.skippedReason).toBe("no_result");
    expect(report.noResultBlocked).toBe(true);
    expect(report.casExplored).toBe(false);

    // 该卡被 CAS 到 blocked（响亮终态），且 rationale 点名 run_id / exit_code / 缺 result / 宽限时长。
    const blockedCas = captures.find(
      (c) => c.kind === "research.clue.v2" && c.payload.status === "blocked",
    );
    expect(blockedCas).toBeDefined();
    expect(blockedCas!.entity_id).toBe(CLUE_DEAD);
    const rationale = blockedCas!.payload.rationale as string | undefined;
    expect(rationale).toBeDefined();
    expect(rationale!).toContain(RUN_DEAD);
    expect(rationale!).toContain("no worker.result.v1");
    expect(rationale!).toContain("exit_code 0");
    expect(rationale!).toMatch(/\d+ms grace/);

    // 绝不 CAS 到 explored（找不到结果 ≠ 无产出，A10a §0.3 只留给「结果存在但为空」）。
    const exploredCas = captures.find(
      (c) => c.kind === "research.clue.v2" && c.payload.status === "explored",
    );
    expect(exploredCas).toBeUndefined();
  });
});

// ── 判别测试 2：含 ≥1 张「exit 0 无 result」卡 ⇒ decideTermination 有界轮次内 state 非空、generate 触发 ──

describe("C5-fix4 判别测试 2: with ≥1 exit-0-no-result card, termination reaches non-null within finite rounds; generate runs", () => {
  it("dead card terminalized to blocked ⇒ termination.state non-null (partial) and runGenerate triggered", async () => {
    const genHits = { generate: false };
    makeNoResultStub();
    const dir = freshOneShotDir();
    process.env.RUN_EXIT_GRACE_MS = "10";

    const outcome = await runChannelWrite({
      channelId: CHANNEL,
      evidenceChannelId: EVIDENCE_CHANNEL,
      maxWrites: 40,
      prevZeroGrowthRounds: 1,
      origin: "test-origin",
      docChannelId: "research:doc",
      oneShotDir: dir,
      generateDeps: makeGenerateDeps(genHits),
    });

    // 有界轮次内终止判定非空：dead 卡已被 blocked ⇒ inFlight=0、proposed=0、零增长达阈
    // （prevZeroGrowthRounds=1 ⇒ 本轮 +1 = 2 ≥ 阈值）⇒ blocked>0 ⇒ partial。⛔ 修复前
    //   inFlight 恒 1 ⇒ state 恒 null（红）。
    expect(outcome.termination.state).not.toBeNull();
    expect(["converged", "partial", "capped"]).toContain(outcome.termination.state);
    expect(outcome.termination.boardComposition.blocked).toBeGreaterThanOrEqual(1);

    // generate 段被保证触发（判别性规格 §四.2：partial 终态同样必须产出报告）。
    expect(genHits.generate).toBe(true);
  });
});

// ── 回归护栏：宽限窗口语义与 A10a §0.3 旧行为不得被静默推翻 ───────────────────────

describe("C5-fix4 回归护栏: grace window & A10a §0.3 semantics preserved", () => {
  it("result still within grace window (exit just happened) ⇒ noResultBlocked=false, card stays in_flight", async () => {
    // exit 事件时间戳 = 现在（宽限未过）：结果仍可能晚到 ⇒ 不提前 blocked。
    const now = new Date().toISOString();
    const captures: CapturedPublish[] = [];
    let boardCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) return jsonResponse({ head: CLUE_DEAD_MSG });
        if (u.includes("/publish")) {
          if (init?.body) captures.push(JSON.parse(String(init.body)) as CapturedPublish);
          return jsonResponse({ message_id: `pub_${captures.length}`, channel_seq: 99 });
        }
        if (u.includes(`/v1/channels/${CHANNEL}/messages`)) {
          boardCalls += 1;
          return jsonResponse({ messages: boardCalls === 1 ? [CLUE_DEAD_MSG] : [] });
        }
        if (u.includes(`/v1/channels/${RUNS_CHANNEL}/messages`)) {
          if (/[?&]after_seq=/.test(u)) return jsonResponse({ messages: [] });
          return jsonResponse({
            messages: [
              startedMsg(RUN_DEAD, 1),
              {
                message_id: "exited_now",
                channel_id: RUNS_CHANNEL,
                channel_seq: 2,
                kind: "agent.run.exited.v1",
                payload: { run_id: RUN_DEAD, exit_code: 0 },
                entity_id: RUN_DEAD,
                supersedes: null,
                created_at: now,
              },
            ],
          });
        }
        if (u.includes(`/v1/channels/${EVIDENCE_CHANNEL}/messages`)) {
          return jsonResponse({ messages: [] });
        }
        return jsonResponse({ messages: [] });
      }),
    );
    freshOneShotDir();
    process.env.RUN_EXIT_GRACE_MS = "60000";

    const outcome = await runChannelWrite({
      channelId: CHANNEL,
      evidenceChannelId: EVIDENCE_CHANNEL,
      maxWrites: 40,
    });

    expect(outcome.harvestReports).toHaveLength(1);
    expect(outcome.harvestReports[0].noResultBlocked).toBe(false);
    // 宽限内不提前 blocked：零 blocked CAS。
    const blockedCas = captures.find(
      (c) => c.kind === "research.clue.v2" && c.payload.status === "blocked",
    );
    expect(blockedCas).toBeUndefined();
    expect(outcome.harvestReports[0].casExplored).toBe(false);
  });

  it("no_result with unreadable exit timestamp ⇒ A10a §0.3 old behavior: stays in_flight", async () => {
    // run 已 exited(0)，但 exit 事件时间戳不可解析 ⇒ readRunExitedAt 返回 null ⇒
    // 无法判定宽限已过 ⇒ 维持「找不到结果 ≠ 无产出」旧行为（留 in_flight，不提前 blocked）。
    const captures: CapturedPublish[] = [];
    let boardCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) return jsonResponse({ head: CLUE_DEAD_MSG });
        if (u.includes("/publish")) {
          if (init?.body) captures.push(JSON.parse(String(init.body)) as CapturedPublish);
          return jsonResponse({ message_id: `pub_${captures.length}`, channel_seq: 99 });
        }
        if (u.includes(`/v1/channels/${CHANNEL}/messages`)) {
          boardCalls += 1;
          return jsonResponse({ messages: boardCalls === 1 ? [CLUE_DEAD_MSG] : [] });
        }
        if (u.includes(`/v1/channels/${RUNS_CHANNEL}/messages`)) {
          if (/[?&]after_seq=/.test(u)) return jsonResponse({ messages: [] });
          return jsonResponse({
            messages: [
              startedMsg(RUN_DEAD, 1),
              {
                message_id: "exited_bad",
                channel_id: RUNS_CHANNEL,
                channel_seq: 2,
                kind: "agent.run.exited.v1",
                payload: { run_id: RUN_DEAD, exit_code: 0 },
                entity_id: RUN_DEAD,
                supersedes: null,
                created_at: "not-a-timestamp",
              },
            ],
          });
        }
        if (u.includes(`/v1/channels/${EVIDENCE_CHANNEL}/messages`)) {
          return jsonResponse({ messages: [] });
        }
        return jsonResponse({ messages: [] });
      }),
    );
    freshOneShotDir();
    process.env.RUN_EXIT_GRACE_MS = "10";

    const outcome = await runChannelWrite({
      channelId: CHANNEL,
      evidenceChannelId: EVIDENCE_CHANNEL,
      maxWrites: 40,
    });

    expect(outcome.harvestReports).toHaveLength(1);
    expect(outcome.harvestReports[0].skippedReason).toBe("no_result");
    expect(outcome.harvestReports[0].noResultBlocked).toBe(false);
    const blockedCas = captures.find(
      (c) => c.kind === "research.clue.v2" && c.payload.status === "blocked",
    );
    expect(blockedCas).toBeUndefined();
    expect(outcome.harvestReports[0].casExplored).toBe(false);
  });
});
