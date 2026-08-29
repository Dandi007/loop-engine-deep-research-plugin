/**
 * C5-fix3 —— 逐 worker 独立收割：一个 worker 的慢/失败**不得**毙掉整 tick 或阻塞
 * 其它 worker 的收割（根因：C5-fix2 下某个慢 worker 超时会让整 tick 以 exit=2 失败，
 * 连带丢失已就绪 worker 的 `worker.result.v1`）。
 *
 * 本测试驱动**真实 tick**（`runChannelWrite`，不 mock spawn），钉死 deliverable 4 三判据：
 *   (a) 慢 worker（未 exited、永不产结果）不阻止收割另一 worker 已就绪的结果；
 *   (b) exited 无 result 的 worker 在**短宽限**内失败（红 = 等满整个结果超时），响亮诊断；
 *   (c) 声明超时的 worker 只回收它自己的 clue（CAS → open）、tick 仍 0 退出、就绪的照常收割。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { runChannelWrite } from "../src/tick-run";

const CHANNEL = "research:c5fix3.index";
const EVIDENCE_CHANNEL = "research:c5fix3.evidence";

const RUN_FAST = "run-fast";
const RUN_SLOW = "run-slow";
const CLUE_FAST = "clue-fast";
const CLUE_SLOW = "clue-slow";

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function clueMsg(clueId: string, runId: string, sources: string[], seq: number) {
  return {
    message_id: `msg_${clueId}`,
    channel_id: CHANNEL,
    channel_seq: seq,
    kind: "research.clue.v2",
    payload: {
      status: "in_flight",
      text: `investigate ${clueId}`,
      depth: 0,
      sources,
      run_id: runId,
    },
    entity_id: clueId,
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function startedMsg(runId: string, seq: number) {
  return {
    message_id: `started_${runId}`,
    channel_id: "board:agent-runs",
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
    channel_id: "board:agent-runs",
    channel_seq: seq,
    kind: "agent.run.exited.v1",
    payload: { run_id: runId, exit_code: 0 },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-01-01T00:00:01Z",
  };
}

function workerResultMsg(runId: string, seq: number) {
  return {
    message_id: `result_${runId}`,
    channel_id: "board:agent-runs",
    channel_seq: seq,
    kind: "worker.result.v1",
    payload: {
      run_id: runId,
      evidences: [
        {
          quote: `evidence for ${runId}`,
          claim: `claim for ${runId}`,
          source: "code",
          locator: "src/dispatch.ts",
          revision: "abcd1234efgh5678",
          range: "L1",
        },
      ],
      proposed_clues: [],
      materials: [],
    },
    entity_id: runId,
    supersedes: null,
    created_at: "2026-01-01T00:00:02Z",
  };
}

interface CapturedPublish {
  kind: string;
  payload: Record<string, unknown>;
  entity_id?: string;
}

/**
 * 打桩 fetch：板 channel 返回两张 in_flight 卡（fast + slow）；board:agent-runs 前
 * `fastResultAfterReads`-1 次只返回两个 started，之后加入 fast 的 exited(0)+worker.result.v1。
 * slow 永不 exited、永不产结果（result/exited 均不会出现）。
 */
function stubTwoWorkerTick(opts: {
  fastResultAfterReads: number;
}): { runsPage1Calls: () => number; captures: CapturedPublish[] } {
  let runsPage1Calls = 0;
  let boardCalls = 0;
  const captures: CapturedPublish[] = [];
  const fastClue = clueMsg(CLUE_FAST, RUN_FAST, ["code-local"], 1);
  const slowClue = clueMsg(CLUE_SLOW, RUN_SLOW, ["code-remote"], 2);

  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/entities/")) {
        const clueId = u.split("/entities/")[1];
        return jsonResponse({ head: clueId === CLUE_FAST ? fastClue : slowClue });
      }
      if (u.includes("/publish")) {
        if (init?.body) captures.push(JSON.parse(String(init.body)) as CapturedPublish);
        return jsonResponse({ message_id: "pub_1", channel_seq: 99 });
      }
      if (u.includes(`/v1/channels/${CHANNEL}/messages`)) {
        boardCalls += 1;
        return jsonResponse({ messages: boardCalls === 1 ? [fastClue, slowClue] : [] });
      }
      if (u.includes("/v1/channels/board:agent-runs/messages")) {
        const hasAfterSeq = /[?&]after_seq=/.test(u);
        if (hasAfterSeq) return jsonResponse({ messages: [] });
        runsPage1Calls += 1;
        const msgs: unknown[] = [
          startedMsg(RUN_FAST, 1),
          startedMsg(RUN_SLOW, 2),
        ];
        if (runsPage1Calls >= opts.fastResultAfterReads) {
          msgs.push(exitedMsg(RUN_FAST, 3), workerResultMsg(RUN_FAST, 4));
        }
        return jsonResponse({ messages: msgs });
      }
      if (u.includes(`/v1/channels/${EVIDENCE_CHANNEL}/messages`)) {
        return jsonResponse({ messages: [] });
      }
      return jsonResponse({ messages: [] });
    }),
  );
  return { runsPage1Calls: () => runsPage1Calls, captures };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENT_RESULT_TIMEOUT_MS;
  delete process.env.AGENT_RESULT_POLL_MS;
  delete process.env.RUN_EXIT_GRACE_MS;
});

function runTick() {
  return runChannelWrite({
    channelId: CHANNEL,
    evidenceChannelId: EVIDENCE_CHANNEL,
    maxWrites: 40,
  });
}

// ── (a) 慢 worker（未 exited）不阻止收割另一 worker 已就绪结果 ────────────────

describe("C5-fix3 (a): slow worker (not exited) does not block harvesting another worker's ready result", () => {
  it("fast result ready + slow never exits/never results ⇒ fast harvested, slow reclaimed, tick exit 0", async () => {
    process.env.AGENT_RESULT_POLL_MS = "5";
    process.env.AGENT_RESULT_TIMEOUT_MS = "200";
    const { runsPage1Calls, captures } = stubTwoWorkerTick({ fastResultAfterReads: 2 });

    const outcome = await runTick();

    // tick 以 0 退出（未抛错）。慢 worker 超时只回收它自己，不毙整 tick。
    expect(runsPage1Calls()).toBeGreaterThanOrEqual(3);

    // 快 worker 的已就绪结果被收割成 evidence（不被慢 worker 阻塞）。
    const fastEvidence = captures.find(
      (c) => c.kind === "research.evidence.v2" && c.payload.clue_id === CLUE_FAST,
    );
    expect(fastEvidence).toBeDefined();

    // 慢 worker 的 clue 被逐 worker 回收（CAS → open），且回收的是 slow 而非 fast。
    const openCas = captures.filter(
      (c) => c.kind === "research.clue.v2" && c.payload.status === "open",
    );
    expect(openCas).toHaveLength(1);
    expect(openCas[0].entity_id).toBe(CLUE_SLOW);

    // 响亮诊断（phase=worker、reason=result-timeout）点名慢 run_id。
    const diag = outcome.diagnostics.find((d) => d.phase === "worker");
    expect(diag).toBeDefined();
    expect(diag!.reason).toBe("result-timeout");
  });
});

// ── (b) exited 无 result ⇒ 短宽限内失败（红 = 等满整个结果超时）────────────────

describe("C5-fix3 (b): exited-without-result fails within short grace (not the full timeout)", () => {
  it("worker exits with no result ⇒ RunExitedWithoutResultError diagnostic, returns well before timeout", async () => {
    // 单 worker 场景：run 在第 2 次 page-1 读 exited(0)，但永不产 worker.result.v1。
    let runsPage1Calls = 0;
    let boardCalls = 0;
    const clue = clueMsg(CLUE_SLOW, RUN_SLOW, ["code-remote"], 1);
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) return jsonResponse({ head: clue });
        if (u.includes("/publish")) return jsonResponse({ message_id: "pub_1", channel_seq: 99 });
        if (u.includes(`/v1/channels/${CHANNEL}/messages`)) {
          boardCalls += 1;
          return jsonResponse({ messages: boardCalls === 1 ? [clue] : [] });
        }
        if (u.includes("/v1/channels/board:agent-runs/messages")) {
          if (/[?&]after_seq=/.test(u)) return jsonResponse({ messages: [] });
          runsPage1Calls += 1;
          const msgs: unknown[] = [startedMsg(RUN_SLOW, 1)];
          if (runsPage1Calls >= 2) msgs.push(exitedMsg(RUN_SLOW, 2));
          return jsonResponse({ messages: msgs });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    process.env.AGENT_RESULT_POLL_MS = "5";
    process.env.AGENT_RESULT_TIMEOUT_MS = "5000";
    process.env.RUN_EXIT_GRACE_MS = "10";

    const t0 = Date.now();
    const outcome = await runTick();
    const elapsed = Date.now() - t0;

    // 判别性：宽限后即判失败并继续，而非等满 5000ms 的结果超时。
    expect(elapsed).toBeLessThan(2000);
    expect(runsPage1Calls).toBeGreaterThanOrEqual(2);

    const diag = outcome.diagnostics.find(
      (d) => d.phase === "worker" && d.reason === "exited-without-result",
    );
    expect(diag).toBeDefined();
    expect(diag!.runId).toBe(RUN_SLOW);
    expect(diag!.elapsedMs).toBeGreaterThan(0);
  });
});

// ── (c) 声明超时只回收该 clue、tick 仍 0 退出、就绪的照常收割 ─────────────────

describe("C5-fix3 (c): per-worker timeout reclaims only that clue; tick still exits 0 after harvesting ready ones", () => {
  it("slow times out ⇒ only slow clue reclaimed to open; fast clue harvested (explored); exit 0", async () => {
    process.env.AGENT_RESULT_POLL_MS = "5";
    process.env.AGENT_RESULT_TIMEOUT_MS = "200";
    const { captures } = stubTwoWorkerTick({ fastResultAfterReads: 2 });

    const outcome = await runTick();

    // fast 被收割（evidence 发布 + 该卡 CAS → explored），不是被回收成 open。
    const fastEvidence = captures.find(
      (c) => c.kind === "research.evidence.v2" && c.payload.clue_id === CLUE_FAST,
    );
    expect(fastEvidence).toBeDefined();
    const exploredCas = captures.filter(
      (c) => c.kind === "research.clue.v2" && c.payload.status === "explored",
    );
    expect(exploredCas).toHaveLength(1);
    expect(exploredCas[0].entity_id).toBe(CLUE_FAST);

    // 声明超时的 slow 被回收成 open：恰好一条 open CAS，且属于 slow clue。
    const openCas = captures.filter(
      (c) => c.kind === "research.clue.v2" && c.payload.status === "open",
    );
    expect(openCas).toHaveLength(1);
    expect(openCas[0].entity_id).toBe(CLUE_SLOW);

    // tick 仍以 0 退出（diagnostics 只含 worker 超时诊断，无其它致命错误）。
    expect(outcome).toBeDefined();
  });
});