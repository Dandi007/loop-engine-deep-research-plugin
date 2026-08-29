/**
 * C5-fix2 —— tick 对「已 started 未 exited」的在飞 worker 阻塞等待结果，再在同一 pass 收割。
 *
 * 根因（spec C5-fix2）：decideTick 只对已 exited(0) 的卡发 harvest；对 in_flight + started +
 * 未 exited 的卡不发任何决策、tick 直接返回再触发下一轮 ⇒ 分钟级 worker 还在跑时 coverage 恒 0、
 * round budget（max_passes=16）在 worker 出结果前耗尽，run 以 max_rounds 终止。
 *
 * 本测试驱动**真实 tick**（runChannelWrite，不 mock spawn），钉死以下判据（deliverable 4）：
 *   (a) in_flight + started + 未 exited 的卡 ⇒ tick 阻塞/轮询，结果落定后同一 pass 收割成 evidence。
 *   (b) 判别性：tick 不再「读一次就返回」——轮询多次（旧行为只读一次 ⇒ 变红）。
 *   (c) 永不 exited 的 worker ⇒ 声明超时上响亮失败（非零退出），不是静默零增长。
 *   (d) exited 但无 result 的 worker ⇒ 诊断并继续（tick 仍 0 退出，RunExitedWithoutResultError 保留）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { runChannelWrite } from "../src/tick-run";

const CHANNEL = "research:c5fix2.index";
const EVIDENCE_CHANNEL = "research:c5fix2.evidence";
const RUN_ID = "run-1";

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function clueMsg(over: Record<string, unknown> = {}) {
  return {
    message_id: "msg_clue_1",
    channel_id: CHANNEL,
    channel_seq: 1,
    kind: "research.clue.v2",
    payload: {
      status: "in_flight",
      text: "investigate dispatch() route-materialize-then-spawn",
      depth: 0,
      sources: ["code-local"],
      run_id: RUN_ID,
      ...over,
    },
    entity_id: "clue_x",
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function startedMsg() {
  return {
    message_id: "run_started_1",
    channel_id: "board:agent-runs",
    channel_seq: 1,
    kind: "agent.run.started.v1",
    payload: { run_id: RUN_ID },
    entity_id: RUN_ID,
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function exitedMsg() {
  return {
    message_id: "run_exited_1",
    channel_id: "board:agent-runs",
    channel_seq: 2,
    kind: "agent.run.exited.v1",
    payload: { run_id: RUN_ID, exit_code: 0 },
    entity_id: RUN_ID,
    supersedes: null,
    created_at: "2026-01-01T00:00:01Z",
  };
}

function workerResultMsg() {
  return {
    message_id: "worker_result_1",
    channel_id: "board:agent-runs",
    channel_seq: 3,
    kind: "worker.result.v1",
    payload: {
      run_id: RUN_ID,
      evidences: [
        {
          quote: "route-materialize-then-spawn is performed by dispatch()",
          claim: "dispatch() performs route-materialize-then-spawn",
          source: "code",
          locator: "src/dispatch.ts",
          revision: "abcd1234efgh5678",
          range: "L734",
        },
      ],
      proposed_clues: [],
      materials: [],
    },
    entity_id: RUN_ID,
    supersedes: null,
    created_at: "2026-01-01T00:00:02Z",
  };
}

interface CapturedPublish {
  kind: string;
  payload: Record<string, unknown>;
}

/**
 * 打桩 fetch：板 channel 返回一张 in_flight 卡；board:agent-runs 前 `resultAfterReads`-1 次
 * page-1 读只返回 started（worker 还在跑），之后返回 started+exited(0)+worker.result.v1；
 * 捕获 publish body 便于断言收割把 evidence 发到了证据 channel。
 */
function stubTick(opts: {
  resultAfterReads: number;
  exitedAfterReads?: number;
  captures?: CapturedPublish[];
}): { runsPage1Calls: () => number } {
  let runsPage1Calls = 0;
  let boardCalls = 0;
  const captures = opts.captures ?? [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/entities/")) {
        return jsonResponse({ head: clueMsg() });
      }
      if (u.includes("/publish")) {
        if (init?.body) captures.push(JSON.parse(String(init.body)) as CapturedPublish);
        return jsonResponse({ message_id: "pub_1", channel_seq: 99 });
      }
      if (u.includes(`/v1/channels/${CHANNEL}/messages`)) {
        boardCalls += 1;
        return jsonResponse({ messages: boardCalls === 1 ? [clueMsg()] : [] });
      }
      if (u.includes("/v1/channels/board:agent-runs/messages")) {
        const hasAfterSeq = /[?&]after_seq=/.test(u);
        if (hasAfterSeq) return jsonResponse({ messages: [] });
        runsPage1Calls += 1;
        if (opts.exitedAfterReads !== undefined && runsPage1Calls >= opts.exitedAfterReads) {
          // exited 无 result 路径：只放 exited(0)，永不放 worker.result.v1。
          return jsonResponse({ messages: [startedMsg(), exitedMsg()] });
        }
        if (runsPage1Calls >= opts.resultAfterReads) {
          return jsonResponse({ messages: [startedMsg(), exitedMsg(), workerResultMsg()] });
        }
        return jsonResponse({ messages: [startedMsg()] });
      }
      if (u.includes(`/v1/channels/${EVIDENCE_CHANNEL}/messages`)) {
        return jsonResponse({ messages: [] });
      }
      return jsonResponse({ messages: [] });
    }),
  );
  return { runsPage1Calls: () => runsPage1Calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AGENT_RESULT_TIMEOUT_MS;
  delete process.env.AGENT_RESULT_POLL_MS;
  delete process.env.RUN_EXIT_GRACE_MS;
});

// ── (a) started + 未 exited ⇒ 阻塞/轮询后同一 pass 收割成 evidence ──────────

describe("C5-fix2 (a): in-flight + started + not-exited worker ⇒ tick blocks then harvests", () => {
  it("worker result appears during polling ⇒ same-pass harvest publishes evidence", async () => {
    process.env.AGENT_RESULT_POLL_MS = "5";
    process.env.AGENT_RESULT_TIMEOUT_MS = "1000";
    const captures: CapturedPublish[] = [];
    const { runsPage1Calls } = stubTick({ resultAfterReads: 3, captures });

    const outcome = await runChannelWrite({
      channelId: CHANNEL,
      evidenceChannelId: EVIDENCE_CHANNEL,
      maxWrites: 20,
    });

    // ⛔ 判别性（deliverable 4b）：tick 轮询了 board:agent-runs 多次（>1 次初始读），
    //    而不是「读一次就返回」触发下一轮；旧行为 runsPage1Calls === 1 ⇒ 变红。
    expect(runsPage1Calls()).toBeGreaterThanOrEqual(3);

    // 同一 pass 内收割：worker.result.v1 被转成 evidence 发布。
    expect(outcome.harvestReports).toHaveLength(1);
    expect(outcome.harvestReports[0].evidencePublished).toBeGreaterThanOrEqual(1);
    expect(outcome.harvestReports[0].casExplored).toBe(true);

    // 证据真的发到了证据 channel（kind 与 clue_id 可核验），且 anchor 合法。
    const evidencePub = captures.find((c) => c.kind === "research.evidence.v2");
    expect(evidencePub).toBeDefined();
    expect(evidencePub!.payload.clue_id).toBe("clue_x");
    expect(evidencePub!.payload.anchor).toBe("code://src/dispatch.ts@abcd1234efgh5678#L734");
  });
});

// ── (b) 判别性：tick 不再读一次就返回 ───────────────────────────────────────

describe("C5-fix2 (b): a tick that returns immediately (old behavior) is detected red", () => {
  it("tick performs multiple board:agent-runs reads before returning (blocking, not immediate)", async () => {
    process.env.AGENT_RESULT_POLL_MS = "5";
    process.env.AGENT_RESULT_TIMEOUT_MS = "1000";
    const { runsPage1Calls } = stubTick({ resultAfterReads: 4 });

    await runChannelWrite({ channelId: CHANNEL, evidenceChannelId: EVIDENCE_CHANNEL, maxWrites: 20 });

    // 结果在「第 4 次 page-1 读」才出现 ⇒ tick 必须连续轮询至少 4 次才拿到结果。
    // 旧实现（decideTick 对 started 卡直接 continue、runChannelWrite 立即返回）只读 1 次 ⇒ 变红。
    expect(runsPage1Calls()).toBeGreaterThanOrEqual(4);
  });
});

// ── (c) 永不 exited ⇒ 声明超时响亮失败，不是静默零增长 ──────────────────────

describe("C5-fix2 (c): never-exiting worker ⇒ loud timeout (not silent zero-growth)", () => {
  it("started but never exits/never produces result ⇒ throws declared-timeout error", async () => {
    process.env.AGENT_RESULT_POLL_MS = "5";
    process.env.AGENT_RESULT_TIMEOUT_MS = "60";
    // result 永不出现（resultAfterReads 极大），run 也永不 exited ⇒ 纯超时。
    const { runsPage1Calls } = stubTick({ resultAfterReads: 1_000_000 });

    await expect(
      runChannelWrite({ channelId: CHANNEL, evidenceChannelId: EVIDENCE_CHANNEL, maxWrites: 20 }),
    ).rejects.toThrow(/C5-fix2: timed out waiting for worker result for run run-1/);

    // 确实是「阻塞等待」到超时（轮询多次），而非静默返回零增长。
    expect(runsPage1Calls()).toBeGreaterThanOrEqual(2);
  });
});

// ── (d) exited 但无 result ⇒ 诊断并继续（RunExitedWithoutResultError 保留）──

describe("C5-fix2 (d): exited-without-result worker ⇒ diagnosed, tick exit 0", () => {
  it("run exits with code 0 but no result ⇒ diagnostic recorded, tick continues", async () => {
    process.env.AGENT_RESULT_POLL_MS = "5";
    process.env.AGENT_RESULT_TIMEOUT_MS = "1000";
    process.env.RUN_EXIT_GRACE_MS = "10";
    // exited 在第 2 次 page-1 读出现，但永不出现 worker.result.v1 ⇒ RunExitedWithoutResultError。
    const { runsPage1Calls } = stubTick({ resultAfterReads: 1_000_000, exitedAfterReads: 2 });

    const outcome = await runChannelWrite({
      channelId: CHANNEL,
      evidenceChannelId: EVIDENCE_CHANNEL,
      maxWrites: 20,
    });

    // tick 以 0 退出（没有抛错），且诊断含 worker phase（run_id + role + elapsedMs）。
    expect(runsPage1Calls()).toBeGreaterThanOrEqual(2);
    expect(outcome.diagnostics.length).toBeGreaterThanOrEqual(1);
    const diag = outcome.diagnostics.find((d) => d.phase === "worker");
    expect(diag).toBeDefined();
    expect(diag!.runId).toBe(RUN_ID);
    expect(diag!.elapsedMs).toBeGreaterThan(0);
  });
});