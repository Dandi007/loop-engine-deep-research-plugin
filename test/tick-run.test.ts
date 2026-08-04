/**
 * A8b —— tick 写侧硬验收测试（spec §3 M1–M12）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举（spec §5.1 第 2 条）。
 * M1–M5 对纯数据求值（spec §5.1 第 4 条）；M1/M2 输入只差 runs 一项（第 7 条）。
 * M9 安全性断言配活性断言（第 3 条）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { decideTick, DEFAULT_TICK_CONFIG } from "../src/tick";
import type { BoardCard, BoardState, Decision } from "../src/tick";
import {
  runWrite,
  runChannelWrite,
  parseRunCliArgs,
  DEFAULT_MAX_WRITES,
  MaxWritesExceededError,
  FrozenChannelError,
  MissingChannelError,
  isFrozenChannel,
  realCas,
} from "../src/tick-run";
import type { WriteDeps, WriteCasInput } from "../src/tick-run";
import { readAgentRuns } from "../src/tick-inspect";
import type { InspectMessage } from "../src/tick-inspect";

const ROOT = dirname(fileURLToPath(import.meta.url));
const cfg = DEFAULT_TICK_CONFIG;

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    clueId: "x",
    status: "open",
    depth: 0,
    sources: ["code-local"],
    retries: 0,
    ...over,
  };
}

function state(over: Partial<BoardState> = {}): BoardState {
  return {
    cards: [],
    runs: {},
    triageInFlight: false,
    ...over,
  };
}

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function stubFetch(handler: (url: string) => ReturnType<typeof jsonResponse> | Promise<ReturnType<typeof jsonResponse>>): void {
  vi.stubGlobal("fetch", vi.fn(async (url: unknown) => handler(String(url))));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── M1 / M2：判别性（只差 runs 一项）──────────────────────────────

const INFLIGHT_CARD: BoardCard = {
  clueId: "x",
  status: "in_flight",
  depth: 0,
  sources: ["code-local"],
  retries: 0,
  runId: "r1",
};

describe("M1: discriminative — started run ⇒ no reclaim", () => {
  it("in_flight card with matching agent.run.started ⇒ no reclaim decision", () => {
    // 与 M2 只差 runs 一项：这里 runs 含 r1:{started:true}
    const s = state({ cards: [INFLIGHT_CARD], runs: { r1: { state: "started" } } });
    const d = decideTick(s, cfg);
    const reclaims = d.filter((x) => x.kind === "reclaim" && x.clueId === "x");
    expect(reclaims).toHaveLength(0);
  });
});

describe("M2: discriminative — no started run ⇒ reclaim to open", () => {
  it("in_flight card with no matching run ⇒ reclaim open (runs = {})", () => {
    const s = state({ cards: [INFLIGHT_CARD], runs: {} });
    const d = decideTick(s, cfg);
    expect(d).toEqual([{ kind: "reclaim", clueId: "x", to: "open", retries: 0 }]);
  });
});

// ── M3 / M4 / M5：exited 分支 ────────────────────────────────────

describe("M3: exited exit_code 0 ⇒ reclaim to explored", () => {
  it("run exited with exit_code 0 ⇒ explore", () => {
    const s = state({
      cards: [INFLIGHT_CARD],
      runs: { r1: { state: "exited", exitCode: 0 } },
    });
    expect(decideTick(s, cfg)).toEqual([
      { kind: "reclaim", clueId: "x", to: "explored", retries: 0 },
    ]);
  });
});

describe("M4: exited exit_code !== 0, retries < 2 ⇒ open + retry+1", () => {
  it("exit_code 1 with retries 1 ⇒ reclaim open retries 2", () => {
    const s = state({
      cards: [card({ ...INFLIGHT_CARD, retries: 1 })],
      runs: { r1: { state: "exited", exitCode: 1 } },
    });
    expect(decideTick(s, cfg)).toEqual([
      { kind: "reclaim", clueId: "x", to: "open", retries: 2 },
    ]);
  });
});

describe("M5: exited exit_code !== 0, retries = 2 ⇒ blocked", () => {
  it("exit_code 1 with retries 2 ⇒ reclaim blocked", () => {
    const s = state({
      cards: [card({ ...INFLIGHT_CARD, retries: 2 })],
      runs: { r1: { state: "exited", exitCode: 1 } },
    });
    expect(decideTick(s, cfg)).toEqual([
      { kind: "reclaim", clueId: "x", to: "blocked", retries: 2 },
    ]);
  });
});

// ── M6：runs 由分页读取填充，非硬编码 ────────────────────────────

function runMsg(seq: number, kind: string, payload: Record<string, unknown>): InspectMessage {
  return {
    message_id: `run${seq}`,
    channel_id: "board:agent-runs",
    channel_seq: seq,
    kind,
    payload,
    entity_id: `run${seq}`,
    supersedes: null,
    created_at: "",
  };
}

describe("M6: runs filled by paginated read, not hardcoded", () => {
  it("pages 100/20/0 → 3 reads, 2nd/3rd carry after_seq", async () => {
    const calls: string[] = [];
    const page = (n: number, start: number): InspectMessage[] =>
      Array.from({ length: n }, (_, i) =>
        runMsg(start + i, "agent.run.started.v1", { run_id: `r${start + i}` }));
    const pages: InspectMessage[][] = [page(100, 1), page(20, 101), []];
    let idx = 0;
    stubFetch((url) => {
      calls.push(url);
      const cur = pages[Math.min(idx, pages.length - 1)];
      if (idx < pages.length - 1) idx += 1;
      return jsonResponse({ messages: cur });
    });
    const runs = await readAgentRuns("board:agent-runs");
    expect(calls).toHaveLength(3);
    expect(calls[1]).toContain("after_seq=");
    expect(calls[2]).toContain("after_seq=");
    expect(Object.keys(runs)).toHaveLength(120);
  });

  it("production runs-filling modules contain no `runs: {}` literal", () => {
    for (const f of ["tick-inspect.ts", "tick-run.ts"]) {
      const src = readFileSync(join(ROOT, "..", "src", f), "utf8");
      expect(src, f).not.toMatch(/runs:\s*\{\}/);
    }
  });
});

// ── M7：dispatch CAS 成功时把 run_id 写进卡 ───────────────────────

describe("M7: dispatch CAS success writes run_id into card", () => {
  it("captured cas input carries non-empty run_id and in_flight", async () => {
    const captured: WriteCasInput[] = [];
    const deps: WriteDeps = {
      cas: async (input) => {
        captured.push(input);
        return { success: true };
      },
      spawnWorker: vi.fn(async () => {}),
    };
    const decisions: Decision[] = [
      { kind: "dispatch", clueId: "x", role: "dr-worker-code-local" },
    ];
    await runWrite(deps, decisions, 5);
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe("in_flight");
    expect(captured[0].from).toBe("open");
    expect(captured[0].runId).toBeTruthy();
    expect(typeof captured[0].runId).toBe("string");
  });

  it("realCas publish body carries a non-empty run_id in payload (X3 kills M7)", async () => {
    // M7 的『怎么验』要求捕获 publish body，断言 payload 携带非空 run_id。
    // 走真实 realCas→casUpdateClue→publish 路径，因此若删除
    // `if (input.runId) update.run_id = input.runId;`（变异 X3），payload 无 run_id → 本条挂。
    const publishBodies: Array<Record<string, unknown>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse({
            head: {
              message_id: "msg_001",
              channel_id: "research:p02-smoke-1dce60",
              channel_seq: 1,
              kind: "research.clue.v2",
              payload: { status: "open", text: "t", depth: 0, sources: [] },
              entity_id: "x",
              supersedes: null,
              created_at: "2026-01-01T00:00:00Z",
            },
          });
        }
        if (u.includes("/publish")) {
          publishBodies.push(JSON.parse(String(init?.body)));
          return jsonResponse({ message_id: "msg_002", channel_seq: 2 });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    const result = await realCas(
      "research:p02-smoke-1dce60",
      { clueId: "x", to: "in_flight", from: "open", runId: "run-abc-123" },
      "nonce-1",
    );

    expect(result.success).toBe(true);
    expect(publishBodies).toHaveLength(1);
    const payload = publishBodies[0].payload as Record<string, unknown>;
    expect(payload.status).toBe("in_flight");
    expect(payload.run_id).toBeTruthy();
    expect(typeof payload.run_id).toBe("string");
    expect(payload.run_id).not.toBe("");
  });
});

describe("CAS: realCas guards head status against precondition (no live-claim overwrite)", () => {
  it("dispatch when head already in_flight (another worker) ⇒ conflict, no publish", async () => {
    // 决策在板快照上算（open→dispatch），但 CAS 前 head 已被别的 worker 认领为 in_flight。
    // realCas 必须返回 conflict 且不 publish，绝不 CAS 掉活 worker 的认领（spec §0）。
    let publishCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse({
            head: {
              message_id: "msg_002",
              channel_id: "research:p02-smoke-1dce60",
              channel_seq: 2,
              kind: "research.clue.v2",
              payload: {
                status: "in_flight",
                text: "t",
                depth: 0,
                sources: [],
                assignee: "other-worker",
                run_id: "run_other",
              },
              entity_id: "x",
              supersedes: "msg_001",
              created_at: "2026-01-01T00:00:00Z",
            },
          });
        }
        if (u.includes("/publish")) {
          publishCalled = true;
          return jsonResponse({ message_id: "msg_003", channel_seq: 3 });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    const result = await realCas(
      "research:p02-smoke-1dce60",
      { clueId: "x", to: "in_flight", from: "open", runId: "run-abc" },
      "nonce-2",
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("conflict");
    expect(publishCalled).toBe(false);
  });

  it("reclaim when head no longer in_flight ⇒ conflict, no publish", async () => {
    let publishCalled = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse({
            head: {
              message_id: "msg_002",
              channel_id: "research:p02-smoke-1dce60",
              channel_seq: 2,
              kind: "research.clue.v2",
              payload: {
                status: "blocked",
                text: "t",
                depth: 0,
                sources: [],
              },
              entity_id: "x",
              supersedes: "msg_001",
              created_at: "2026-01-01T00:00:00Z",
            },
          });
        }
        if (u.includes("/publish")) {
          publishCalled = true;
          return jsonResponse({ message_id: "msg_003", channel_seq: 3 });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    const result = await realCas(
      "research:p02-smoke-1dce60",
      { clueId: "x", to: "open", from: "in_flight" },
      "nonce-3",
    );

    expect(result.success).toBe(false);
    expect(result.error).toBe("conflict");
    expect(publishCalled).toBe(false);
  });
});

// ── M8：CAS 失败（409）⇒ 跳过该卡，不重试、不 spawn ───────────────

describe("M8: CAS conflict skips the card", () => {
  it("dispatch CAS conflict ⇒ no pending spawn, cas not called again for it", async () => {
    const casInputs: WriteCasInput[] = [];
    const spawnWorker = vi.fn(async () => {});
    const deps: WriteDeps = {
      cas: async (input) => {
        casInputs.push(input);
        return { success: false, error: "conflict" };
      },
      spawnWorker,
    };
    const decisions: Decision[] = [
      { kind: "dispatch", clueId: "x", role: "dr-worker-code-local" },
    ];
    const result = await runWrite(deps, decisions, 5);
    expect(casInputs).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.spawns).toHaveLength(0);
    expect(spawnWorker).toHaveBeenCalledTimes(0);
  });
});

// ── M9：A8c 真正 spawn —— CAS 成功后按 role/runId 调用 spawn dep ──

describe("M9: spawn after CAS success with role/runId", () => {
  it("two successful dispatches spawn twice with role+runId, recorded in spawns", async () => {
    const spawnCalls: Array<[string, string, string]> = [];
    const spawnWorker = vi.fn(async (clueId: string, role: string, runId: string) => {
      spawnCalls.push([clueId, role, runId]);
    });
    const deps: WriteDeps = {
      cas: async () => ({ success: true }),
      spawnWorker,
    };
    const decisions: Decision[] = [
      { kind: "dispatch", clueId: "a", role: "dr-worker-wiki" },
      { kind: "dispatch", clueId: "b", role: "dr-worker-feishu" },
    ];
    const result = await runWrite(deps, decisions, 5);
    // 活性：两个 dispatch 都真正 spawn 了
    expect(spawnWorker).toHaveBeenCalledTimes(2);
    expect(spawnCalls[0][0]).toBe("a");
    expect(spawnCalls[0][1]).toBe("dr-worker-wiki");
    expect(spawnCalls[0][2]).toMatch(/^[0-9a-f-]{36}$/);
    expect(spawnCalls[1][0]).toBe("b");
    expect(spawnCalls[1][1]).toBe("dr-worker-feishu");
    expect(result.spawns).toHaveLength(2);
    expect(result.spawns.map((p) => p.clueId)).toEqual(["a", "b"]);
    expect(result.spawns.every((p) => p.spawned === true)).toBe(true);
    expect(result.spawnCalls).toBe(2);
  });
});

// ── M10：--max-writes 生效，默认 5，超限响亮报错 ──────────────────

describe("M10: max-writes enforced, default 5, loud error", () => {
  it("DEFAULT_MAX_WRITES is 5", () => {
    expect(DEFAULT_MAX_WRITES).toBe(5);
  });

  it("7 write decisions with maxWrites 5 ⇒ 6th triggers MaxWritesExceededError", async () => {
    let casCalls = 0;
    const deps: WriteDeps = {
      cas: async () => {
        casCalls += 1;
        return { success: true };
      },
      spawnWorker: vi.fn(async () => {}),
    };
    const decisions: Decision[] = Array.from({ length: 7 }, (_, i) => ({
      kind: "reclaim" as const,
      clueId: `c${i}`,
      to: "open" as const,
      retries: 0,
    }));
    await expect(runWrite(deps, decisions, 5)).rejects.toBeInstanceOf(
      MaxWritesExceededError,
    );
    expect(casCalls).toBe(5);
  });
});

// ── M11：channel 无默认值，必须显式传 ─────────────────────────────

describe("M11: channel has no default, must be explicit", () => {
  it("parseRunCliArgs([]) throws MissingChannelError", () => {
    expect(() => parseRunCliArgs([])).toThrow(MissingChannelError);
  });

  it("parseRunCliArgs(['research:p02-smoke-1dce60']) parses channel + default max-writes", () => {
    const opts = parseRunCliArgs(["research:p02-smoke-1dce60"]);
    expect(opts.channelId).toBe("research:p02-smoke-1dce60");
    expect(opts.maxWrites).toBe(5);
  });
});

// ── M12：拒绝写 v1 冻结 channel，零请求发出 ───────────────────────

describe("M12: refuse writes to v1 frozen channels, zero requests", () => {
  it("isFrozenChannel matches v1 frozen channels", () => {
    expect(isFrozenChannel("research:loop-mcp-semantics.index")).toBe(true);
    expect(isFrozenChannel("research:smoke-bus-semantics.foo")).toBe(true);
    expect(isFrozenChannel("research:p02-smoke-1dce60")).toBe(false);
  });

  it("runChannelWrite on frozen channel rejects with zero fetch requests", async () => {
    let fetchCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        fetchCalls += 1;
        return jsonResponse({ messages: [] });
      }),
    );
    await expect(
      runChannelWrite({ channelId: "research:loop-mcp-semantics.index" }),
    ).rejects.toBeInstanceOf(FrozenChannelError);
    expect(fetchCalls).toBe(0);
  });
});

// ── A8c §1.1 接线判别：W1/W2 只差 board:agent-runs 的内容 ──────────
//
// 打桩 HTTP 层：clue channel 返回完全相同（同一条 in_flight 卡，run_id=run-1），
// 唯一差别是 `board:agent-runs` channel 返回的内容（W1：有 started；W2：空）。
// 这就是「两个只差一项输入的用例才构成判别性证据」（spec §4.1 第 7 条）。

const WIRE_CLUE_CHANNEL = "research:p02-smoke-1dce60";

const wireClueMsg = {
  message_id: "msg_clue_1",
  channel_id: WIRE_CLUE_CHANNEL,
  channel_seq: 1,
  kind: "research.clue.v2",
  payload: {
    status: "in_flight",
    text: "t",
    depth: 0,
    sources: ["code-local"],
    run_id: "run-1",
  },
  entity_id: "clue_x",
  supersedes: null,
  created_at: "2026-01-01T00:00:00Z",
};

const wireEntityHead = { ...wireClueMsg, message_id: "msg_clue_1" };

function wiringStub(
  runsMessages: unknown[],
  publishes: Array<Record<string, unknown>>,
  runsResponses: number[],
): void {
  let clueCalls = 0;
  let runsCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/entities/")) {
        return jsonResponse({ head: wireEntityHead });
      }
      if (u.includes("/publish")) {
        publishes.push(JSON.parse(String(init?.body)));
        return jsonResponse({ message_id: `p_${publishes.length}`, channel_seq: 99 });
      }
      if (u.includes(`/v1/channels/${WIRE_CLUE_CHANNEL}/messages`)) {
        clueCalls += 1;
        return jsonResponse({ messages: clueCalls === 1 ? [wireClueMsg] : [] });
      }
      if (u.includes("/v1/channels/board:agent-runs/messages")) {
        runsCalls += 1;
        runsResponses.push(runsMessages.length);
        return jsonResponse({ messages: runsCalls === 1 ? runsMessages : [] });
      }
      return jsonResponse({ messages: [] });
    }),
  );
}

describe("N1: W1 — bus has agent.run.started ⇒ no reclaim, no CAS", () => {
  it("only difference from N2 is board:agent-runs containing a started event", async () => {
    const publishes: Array<Record<string, unknown>> = [];
    const runsResponses: number[] = [];
    wiringStub(
      [
        {
          message_id: "run_started_1",
          channel_id: "board:agent-runs",
          channel_seq: 1,
          kind: "agent.run.started.v1",
          payload: { run_id: "run-1" },
          entity_id: "run-1",
          supersedes: null,
          created_at: "2026-01-01T00:00:00Z",
        },
      ],
      publishes,
      runsResponses,
    );
    const outcome = await runChannelWrite({ channelId: WIRE_CLUE_CHANNEL });
    // 板上有 started ⇒ 不 reclaim、不发 CAS（N1：assert CAS 调用 0 次）。
    expect(publishes).toHaveLength(0);
    expect(outcome.writes).toBe(0);
    expect(outcome.spawns).toHaveLength(0);
    // 判别性核验：runs 读确实返回了 1 条（非空），与 N2 不同。
    expect(runsResponses[0]).toBe(1);
  });
});

describe("N2: W2 — no started ⇒ reclaim→open and CAS", () => {
  it("only difference from N1 is board:agent-runs empty", async () => {
    const publishes: Array<Record<string, unknown>> = [];
    const runsResponses: number[] = [];
    wiringStub([], publishes, runsResponses);
    const outcome = await runChannelWrite({ channelId: WIRE_CLUE_CHANNEL });
    // 无 started ⇒ reclaim→open，恰好一次 to=open 的 CAS。
    expect(publishes).toHaveLength(1);
    const body = publishes[0].payload as Record<string, unknown>;
    expect(body.status).toBe("open");
    expect(outcome.writes).toBe(1);
    // 判别性核验：runs 读确实返回了 0 条（空），与 N1 不同。
    expect(runsResponses[0]).toBe(0);
  });
});

// ── N3/N4/N5：spawn 接线（runWrite 层，注入依赖）─────────────────

describe("N3: CAS success ⇒ spawn called once with clueId/role/runId", () => {
  it("spawnWorker receives the mapped role and the generated runId", async () => {
    const spawnWorker = vi.fn(async () => {});
    const deps: WriteDeps = {
      cas: async () => ({ success: true }),
      spawnWorker,
    };
    const decisions: Decision[] = [
      { kind: "dispatch", clueId: "x", role: "dr-worker-code-local" },
    ];
    const result = await runWrite(deps, decisions, 5);
    expect(spawnWorker).toHaveBeenCalledTimes(1);
    const [clueId, role, runId] = spawnWorker.mock.calls[0] as unknown as [string, string, string];
    expect(clueId).toBe("x");
    expect(role).toBe("dr-worker-code-local");
    expect(runId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.spawns).toHaveLength(1);
    expect(result.spawns[0].spawned).toBe(true);
  });
});

describe("N4: CAS conflict (409) ⇒ spawn called 0 times", () => {
  it("dispatch CAS conflict ⇒ no spawn", async () => {
    const spawnWorker = vi.fn(async () => {});
    const deps: WriteDeps = {
      cas: async () => ({ success: false, error: "conflict" }),
      spawnWorker,
    };
    const decisions: Decision[] = [
      { kind: "dispatch", clueId: "x", role: "dr-worker-code-local" },
    ];
    const result = await runWrite(deps, decisions, 5);
    expect(spawnWorker).toHaveBeenCalledTimes(0);
    expect(result.spawns).toHaveLength(0);
    expect(result.skipped).toBe(1);
  });
});

describe("N5: spawn sync throw ⇒ immediate CAS back to open", () => {
  it("after spawn throws, a to=open CAS (from in_flight) is performed", async () => {
    const casInputs: WriteCasInput[] = [];
    const deps: WriteDeps = {
      cas: async (input) => {
        casInputs.push(input);
        return { success: true };
      },
      spawnWorker: async () => {
        throw new Error("spawn failed");
      },
    };
    const decisions: Decision[] = [
      { kind: "dispatch", clueId: "x", role: "dr-worker-code-local" },
    ];
    const result = await runWrite(deps, decisions, 5);
    // 第一次 CAS：open→in_flight；第二次 CAS：in_flight→open（回滚）。
    expect(casInputs).toHaveLength(2);
    expect(casInputs[0]).toMatchObject({ clueId: "x", to: "in_flight", from: "open" });
    expect(casInputs[1]).toMatchObject({ clueId: "x", to: "open", from: "in_flight" });
    expect(result.spawns).toHaveLength(1);
    expect(result.spawns[0].spawned).toBe(false);
  });
});

// ── A8c §1.2 真实 spawn 动作：runChannelWrite 的 spawn 不是空操作 ──
// 评审 finding 2（major）：runChannelWrite 之前注入 `spawnWorker: async () => {}`，
// 真实 `--run` 认领卡到 in_flight 后什么都不做。这里证明真实路径的 spawn 会向
// `board:agent-runs` 发布一条 `agent.run.started`（run_id/role/clue_id），
// 使下一次 tick 读到 started 而不 reclaim 该在飞卡（堵掉 spec §0 churn）。

describe("A8c real spawn publishes agent.run.started on the runs channel", () => {
  it("dispatch CAS success ⇒ real spawnAgentRun registers agent.run.started", async () => {
    const openClueMsg = {
      message_id: "msg_open_1",
      channel_id: WIRE_CLUE_CHANNEL,
      channel_seq: 1,
      kind: "research.clue.v2",
      payload: { status: "open", text: "t", depth: 0, sources: ["code-local"] },
      entity_id: "clue_x",
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const publishBodies: Array<{
      channel?: string;
      kind: string;
      payload: Record<string, unknown>;
      entity_id?: string;
    }> = [];
    let clueCalls = 0;
    let runsCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse({ head: openClueMsg });
        }
        const pm = /\/v1\/channels\/([^/]+)\/publish/.exec(u);
        if (pm) {
          const body = JSON.parse(String(init?.body));
          publishBodies.push({ channel: decodeURIComponent(pm[1]), ...body });
          return jsonResponse({ message_id: `p_${publishBodies.length}`, channel_seq: 99 });
        }
        if (u.includes(`/v1/channels/${WIRE_CLUE_CHANNEL}/messages`)) {
          clueCalls += 1;
          return jsonResponse({ messages: clueCalls === 1 ? [openClueMsg] : [] });
        }
        if (u.includes("/v1/channels/board:agent-runs/messages")) {
          runsCalls += 1;
          return jsonResponse({ messages: [] });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    const outcome = await runChannelWrite({ channelId: WIRE_CLUE_CHANNEL });

    // 活性：dispatch 真被 spawn，spawns 记录 spawned=true。
    expect(outcome.spawns).toHaveLength(1);
    expect(outcome.spawns[0].spawned).toBe(true);
    // 真实 spawn 动作：向 board:agent-runs 发布 agent.run.started（run_id/role/clue_id）。
    const started = publishBodies.filter((b) => b.kind === "agent.run.started.v1");
    expect(started).toHaveLength(1);
    expect(started[0].channel).toBe("board:agent-runs");
    expect(started[0].payload.run_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(started[0].payload.role).toBe("dr-worker-code-local");
    expect(started[0].payload.clue_id).toBe("clue_x");
    // 另有恰好一次 clue CAS（open→in_flight）发到 clue 板 channel。
    const cluePubs = publishBodies.filter((b) => b.kind === "research.clue.v2");
    expect(cluePubs).toHaveLength(1);
    expect(cluePubs[0].channel).toBe(WIRE_CLUE_CHANNEL);
    expect(cluePubs[0].payload.status).toBe("in_flight");
  });
});