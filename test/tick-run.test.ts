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
    const decisions: Decision[] = [{ kind: "dispatch", clueId: "x" }];
    await runWrite(deps, decisions, 5);
    expect(captured).toHaveLength(1);
    expect(captured[0].to).toBe("in_flight");
    expect(captured[0].runId).toBeTruthy();
    expect(typeof captured[0].runId).toBe("string");
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
    const decisions: Decision[] = [{ kind: "dispatch", clueId: "x" }];
    const result = await runWrite(deps, decisions, 5);
    expect(casInputs).toHaveLength(1);
    expect(result.skipped).toBe(1);
    expect(result.pendingSpawns).toHaveLength(0);
    expect(spawnWorker).toHaveBeenCalledTimes(0);
  });
});

// ── M9：本包不 spawn，注入的 spawn dep 是 no-op 且被记录 ──────────

describe("M9: no spawn — injected spawn dep is no-op and recorded", () => {
  it("spawn dep called 0 times yet pendingSpawns records the dispatch", async () => {
    const spawnWorker = vi.fn(async () => {});
    const deps: WriteDeps = {
      cas: async () => ({ success: true }),
      spawnWorker,
    };
    const decisions: Decision[] = [
      { kind: "dispatch", clueId: "a" },
      { kind: "dispatch", clueId: "b" },
    ];
    const result = await runWrite(deps, decisions, 5);
    // 安全性：spawn dep 一次都没被调用
    expect(spawnWorker).toHaveBeenCalledTimes(0);
    // 活性：两个 dispatch 都被登记为待 spawn
    expect(result.pendingSpawns).toHaveLength(2);
    expect(result.pendingSpawns.map((p) => p.clueId)).toEqual(["a", "b"]);
    expect(result.spawnCalls).toBe(0);
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