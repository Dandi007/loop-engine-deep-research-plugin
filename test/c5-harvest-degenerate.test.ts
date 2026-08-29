/**
 * C5 —— 单 worker 退化证据不得令整 tick 崩：**真实 tick 级**判别测试。
 *
 * 本文件驱动 `runChannelWrite`（真实 tick：读板 → decideTick → runWrite/harvestCard →
 * decideTermination → generate），钉死 C5 spec 判据 5（generate 段照常进行）在
 * 「某卡 worker 结果含一条缺 revision 的退化 evidence、其余卡结果正常」场景下成立：
 *
 *   - 退化卡被隔离为 blocked（绝不 CAS explored），其退化 evidence 不上证据 channel；
 *   - 同 tick 其余合规卡照常收割（evidence 发布 + CAS explored）；
 *   - tick 正常返回（不再 exit2），termination 判为 non-null ⇒ `runGenerate` 仍被调用。
 *
 * 配套的 runWrite/harvestCard 级断言见 test/harvest.test.ts 的 C5 describe。
 */
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runChannelWrite } from "../src/tick-run";
import type { GenerateDeps } from "../src/generate";
import type { InspectMessage } from "../src/tick-inspect";
import type { ClueV2 } from "../src/protocol";

const CHANNEL = "research:c5-harvest-degenerate.index";
const RUNS_CHANNEL = "board:agent-runs";
const EVIDENCE_CHANNEL = "research:c5-harvest-degenerate.evidence";

const CLUE_DEGEN = "clue_degen";
const CLUE_OK = "clue_ok";
const RUN_DEGEN = "run-degen";
const RUN_OK = "run-ok";

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
    created_at: "2026-01-01T00:00:00Z",
  };
}

const CLUE_DEGEN_MSG = clueMsg(CLUE_DEGEN, RUN_DEGEN, 1);
const CLUE_OK_MSG = clueMsg(CLUE_OK, RUN_OK, 2);

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

function exitedMsg(runId: string, seq: number) {
  return {
    message_id: `exited_${runId}`,
    channel_id: RUNS_CHANNEL,
    channel_seq: seq,
    kind: "agent.run.exited.v1",
    payload: { run_id: runId, exit_code: 0 },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-01-01T00:00:01Z",
  };
}

function workerResultMsg(runId: string, seq: number, degenerate: boolean) {
  const evidence = degenerate
    ? {
        quote: "degenerate quote",
        claim: "degenerate claim",
        source: "code",
        locator: "src/degen.ts",
        // ⛔ 缺 revision（真机形态：code-remote 读 stale 非 git 目录，persona 留空）
      }
    : {
        quote: "ok quote",
        claim: "ok claim",
        source: "code",
        locator: "src/ok.ts",
        revision: "abc123def4567890",
      };
  return {
    message_id: `result_${runId}`,
    channel_id: RUNS_CHANNEL,
    channel_seq: seq,
    kind: "worker.result.v1",
    payload: {
      run_id: runId,
      evidences: [evidence],
      proposed_clues: [],
      materials: [],
    },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-01-01T00:00:02Z",
  };
}

const RUNS_MSGS = [
  startedMsg(RUN_DEGEN, 1),
  startedMsg(RUN_OK, 2),
  exitedMsg(RUN_DEGEN, 3),
  exitedMsg(RUN_OK, 4),
  workerResultMsg(RUN_DEGEN, 5, true),
  workerResultMsg(RUN_OK, 6, false),
];

interface CapturedPublish {
  kind: string;
  payload: Record<string, unknown>;
  entity_id?: string;
}

function makeFetchStub(): { captures: CapturedPublish[]; fetch: ReturnType<typeof vi.fn> } {
  const captures: CapturedPublish[] = [];
  let boardCalls = 0;
  let runsCalls = 0;
  const fetch = vi.fn(async (url: unknown, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/entities/")) {
      const clueId = u.split("/entities/")[1];
      return jsonResponse({ head: clueId === CLUE_DEGEN ? CLUE_DEGEN_MSG : CLUE_OK_MSG });
    }
    if (u.includes("/publish")) {
      if (init?.body) captures.push(JSON.parse(String(init.body)) as CapturedPublish);
      return jsonResponse({ message_id: `pub_${captures.length}`, channel_seq: 99 });
    }
    if (u.includes(`/v1/channels/${CHANNEL}/messages`)) {
      boardCalls += 1;
      return jsonResponse({ messages: boardCalls === 1 ? [CLUE_DEGEN_MSG, CLUE_OK_MSG] : [] });
    }
    if (u.includes(`/v1/channels/${RUNS_CHANNEL}/messages`)) {
      const hasAfterSeq = /[?&]after_seq=/.test(u);
      if (hasAfterSeq) return jsonResponse({ messages: [] });
      runsCalls += 1;
      return jsonResponse({ messages: runsCalls === 1 ? RUNS_MSGS : [] });
    }
    if (u.includes(`/v1/channels/${EVIDENCE_CHANNEL}/messages`)) {
      return jsonResponse({ messages: [] });
    }
    return jsonResponse({ messages: [] });
  });
  return { captures, fetch };
}

let fetchMock: ReturnType<typeof vi.fn>;
let captures: CapturedPublish[];
let oneShotDir: string;

beforeEach(() => {
  const stub = makeFetchStub();
  fetchMock = stub.fetch;
  captures = stub.captures;
  vi.stubGlobal("fetch", fetchMock);
  oneShotDir = mkdtempSync(join(tmpdir(), "c5-harvest-degenerate-"));
});

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
      boardComposition: { proposed: 0, open: 0, inFlight: 0, explored: 1, blocked: 1 },
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

describe("C5 ⭐⭐⭐ (real tick): degenerate harvest card does not kill the tick; generate still runs", () => {
  it("degenerate card ⇒ blocked (never explored), ok card ⇒ published + explored, termination non-null ⇒ runGenerate called", async () => {
    const genHits = { generate: false };
    const outcome = await runChannelWrite({
      channelId: CHANNEL,
      evidenceChannelId: EVIDENCE_CHANNEL,
      maxWrites: 40,
      prevZeroGrowthRounds: 1,
      origin: "test-origin",
      docChannelId: "research:doc",
      oneShotDir,
      generateDeps: makeGenerateDeps(genHits),
    });

    // 判据 5：tick 正常返回（不再 exit2），且 generate 段照常执行。
    expect(outcome).toBeDefined();
    expect(genHits.generate).toBe(true);

    // 判据 3：退化卡被隔离为 blocked（绝不 CAS explored）。
    const blockedCas = captures.find(
      (c) => c.kind === "research.clue.v2" && c.payload.status === "blocked",
    );
    expect(blockedCas).toBeDefined();
    expect(blockedCas!.entity_id).toBe(CLUE_DEGEN);
    const rationale = blockedCas!.payload.rationale as string | undefined;
    expect(rationale).toBeDefined();
    expect(rationale!).toMatch(/missing revision/);
    expect(rationale!).toContain(RUN_DEGEN);
    expect(rationale!).toContain(CLUE_DEGEN);
    // 退化卡不出现 explored CAS。
    expect(
      captures.some(
        (c) => c.kind === "research.clue.v2" && c.entity_id === CLUE_DEGEN && c.payload.status === "explored",
      ),
    ).toBe(false);

    // 判据 2：退化 evidence 不上证据 channel（无空锚 evidence 发布）。
    const degenEvidence = captures.find(
      (c) => c.kind === "research.evidence.v2" && c.payload.clue_id === CLUE_DEGEN,
    );
    expect(degenEvidence).toBeUndefined();
    for (const c of captures.filter((x) => x.kind === "research.evidence.v2")) {
      const anchor = String(c.payload.anchor ?? "");
      expect(anchor).not.toBe("://@");
      expect(anchor).not.toMatch(/^[a-z]+:\/\/@/);
    }

    // 判据 4：同 tick 合规卡照常收割（evidence 发布 + CAS explored）。
    const okEvidence = captures.find(
      (c) => c.kind === "research.evidence.v2" && c.payload.clue_id === CLUE_OK,
    );
    expect(okEvidence).toBeDefined();
    expect((okEvidence!.payload.anchor as string).startsWith("code://")).toBe(true);
    const okExplored = captures.find(
      (c) => c.kind === "research.clue.v2" && c.entity_id === CLUE_OK && c.payload.status === "explored",
    );
    expect(okExplored).toBeDefined();

    // 报告佐证：harvestReports 里退化卡 isolated=true、合规卡 casExplored=true。
    const degenReport = outcome.harvestReports.find((r) => r.clueId === CLUE_DEGEN);
    const okReport = outcome.harvestReports.find((r) => r.clueId === CLUE_OK);
    expect(degenReport?.isolated).toBe(true);
    expect(degenReport?.casExplored).toBe(false);
    expect(degenReport?.degenerateRejections).toHaveLength(1);
    expect(okReport?.isolated).toBe(false);
    expect(okReport?.casExplored).toBe(true);
  });
});
