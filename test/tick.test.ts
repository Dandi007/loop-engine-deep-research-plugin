import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decideTick,
  runTick,
  isValidSources,
  DEFAULT_TICK_CONFIG,
  SOURCE_ENUM,
} from "../src/tick";
import type {
  BoardState,
  BoardCard,
  TickConfig,
  TickDeps,
  CasDecision,
} from "../src/tick";

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    clueId: "clue_1",
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

const cfg: TickConfig = DEFAULT_TICK_CONFIG;

function casOk(): CasDecision {
  return { success: true };
}

describe("B1: decideTick is a pure function", () => {
  it("module does not import ./bus and has no fetch/Date/Math.random", () => {
    const srcPath = fileURLToPath(new URL("../src/tick.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\/bus["']/);
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/Math\.random/);
  });
});

describe("B2: identical input → deep-equal output", () => {
  it("same state called 3 times yields identical decisions", () => {
    const s = state({
      cards: [
        card({ clueId: "a", status: "open" }),
        card({ clueId: "b", status: "proposed" }),
        card({ clueId: "c", status: "proposed" }),
        card({ clueId: "d", status: "proposed" }),
      ],
    });
    const r1 = decideTick(s, cfg);
    const r2 = decideTick(s, cfg);
    const r3 = decideTick(s, cfg);
    expect(r1).toEqual(r2);
    expect(r1).toEqual(r3);
  });
});

describe("B3: CAS conflict → no spawn", () => {
  it("dispatch whose CAS returns conflict spawns nothing", async () => {
    const spawnWorker = vi.fn(async () => {});
    const deps: TickDeps = {
      readBoard: async () =>
        state({ cards: [card({ clueId: "a", status: "open" })] }),
      cas: vi.fn(async (): Promise<CasDecision> => ({ success: false, error: "conflict" })),
      spawnWorker,
      spawnTriage: vi.fn(async () => {}),
    };
    await runTick(deps, cfg);
    expect(spawnWorker).toHaveBeenCalledTimes(0);
  });
});

describe("B4: actual CAS-before-spawn order per card (shared sequence)", () => {
  it("cas index < spawn index for the same card", async () => {
    const seq: string[] = [];
    const deps: TickDeps = {
      readBoard: async () =>
        state({ cards: [card({ clueId: "a", status: "open" })] }),
      cas: vi.fn(async (id: string, to: string) => {
        seq.push(`cas:${id}:${to}`);
        return casOk();
      }),
      spawnWorker: vi.fn(async (id: string) => {
        seq.push(`spawn:${id}`);
      }),
      spawnTriage: vi.fn(async () => {}),
    };
    await runTick(deps, cfg);
    const casIdx = seq.indexOf("cas:a:in_flight");
    const spawnIdx = seq.indexOf("spawn:a");
    expect(casIdx).toBeGreaterThanOrEqual(0);
    expect(spawnIdx).toBeGreaterThanOrEqual(0);
    expect(casIdx).toBeLessThan(spawnIdx);
  });
});

describe("B5: spawn sync failure → immediate CAS back to open", () => {
  it("rolls the card back to open after spawn throws", async () => {
    const cas = vi.fn(async (id: string, to: string) => {
      return casOk();
    });
    const deps: TickDeps = {
      readBoard: async () =>
        state({ cards: [card({ clueId: "a", status: "open" })] }),
      cas,
      spawnWorker: vi.fn(async () => {
        throw new Error("spawn failed");
      }),
      spawnTriage: vi.fn(async () => {}),
    };
    await runTick(deps, cfg);
    const rollback = cas.mock.calls.find((c) => c[0] === "a" && c[1] === "open");
    expect(rollback).toBeDefined();
  });
});

describe("B6: reclaim four branches each have an independent case", () => {
  function inFlightCard(over: Partial<BoardCard> = {}): BoardCard {
    return card({ clueId: "x", status: "in_flight", runId: "run_1", ...over });
  }

  it("no started event → CAS back to open (crash recovery)", () => {
    const s = state({ cards: [inFlightCard()], runs: {} });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      { kind: "reclaim", clueId: "x", to: "open", retries: 0 },
    ]);
  });

  it("exited with exit_code 0 → CAS to explored", () => {
    const s = state({
      cards: [inFlightCard()],
      runs: { run_1: { state: "exited", exitCode: 0 } },
    });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      { kind: "reclaim", clueId: "x", to: "explored", retries: 0 },
    ]);
  });

  it("exited with exit_code !== 0 and retries < 2 → CAS to open, retry+1", () => {
    const s = state({
      cards: [inFlightCard({ retries: 1 })],
      runs: { run_1: { state: "exited", exitCode: 1 } },
    });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      { kind: "reclaim", clueId: "x", to: "open", retries: 2 },
    ]);
  });

  it("exited with exit_code !== 0 and retries = 2 → CAS to blocked", () => {
    const s = state({
      cards: [inFlightCard({ retries: 2 })],
      runs: { run_1: { state: "exited", exitCode: 1 } },
    });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      { kind: "reclaim", clueId: "x", to: "blocked", retries: 2 },
    ]);
  });
});

describe("B7: concurrency cap applies", () => {
  it("in-flight 3, open 5, maxConcurrentWorkers 4 → dispatch only 1", () => {
    const s = state({
      cards: [
        ...Array.from({ length: 3 }, (_, i) =>
          card({ clueId: `in_${i}`, status: "in_flight" })),
        ...Array.from({ length: 5 }, (_, i) =>
          card({ clueId: `open_${i}`, status: "open" })),
      ],
    });
    const d = decideTick(s, cfg);
    const dispatched = d.filter((x) => x.kind === "dispatch");
    expect(dispatched).toHaveLength(1);
    expect(dispatched[0]).toEqual({ kind: "dispatch", clueId: "open_0" });
  });
});

describe("B8: out-of-enum source → card blocked, others still dispatched", () => {
  it("one bad card + two good cards → 1 blocked + 2 dispatched", () => {
    const s = state({
      cards: [
        card({ clueId: "bad", status: "open", sources: ["not-a-source"] }),
        card({ clueId: "g1", status: "open", sources: ["wiki"] }),
        card({ clueId: "g2", status: "open", sources: ["feishu"] }),
      ],
    });
    const d = decideTick(s, cfg);
    const blocked = d.filter((x) => x.kind === "block");
    const dispatched = d.filter((x) => x.kind === "dispatch");
    expect(blocked).toEqual([
      { kind: "block", clueId: "bad", reason: "invalid_sources" },
    ]);
    expect(dispatched).toHaveLength(2);
  });
});

describe("B9: triage threshold", () => {
  function proposedCards(n: number): BoardCard[] {
    return Array.from({ length: n }, (_, i) =>
      card({ clueId: `p_${i}`, status: "proposed" }));
  }

  it("proposed=2 → no triage", () => {
    const s = state({ cards: proposedCards(2) });
    expect(decideTick(s, cfg).filter((x) => x.kind === "triage")).toHaveLength(0);
  });

  it("proposed=3 and no triage in-flight → spawn triage", () => {
    const s = state({ cards: proposedCards(3), triageInFlight: false });
    const d = decideTick(s, cfg);
    expect(d.filter((x) => x.kind === "triage")).toHaveLength(1);
  });

  it("proposed=3 but triage in-flight → no triage", () => {
    const s = state({ cards: proposedCards(3), triageInFlight: true });
    expect(decideTick(s, cfg).filter((x) => x.kind === "triage")).toHaveLength(0);
  });
});

describe("B11: parameters are not hardcoded", () => {
  it("TickConfig{triageThreshold:1} triggers triage at proposed=1", () => {
    const s = state({ cards: [card({ clueId: "p", status: "proposed" })] });
    const custom: TickConfig = { ...cfg, triageThreshold: 1 };
    expect(decideTick(s, custom).filter((x) => x.kind === "triage")).toHaveLength(1);
  });
});

describe("source enum sanity", () => {
  it("isValidSources accepts only closed enum members", () => {
    expect(isValidSources(["code-local", "web-search"])).toBe(true);
    expect(isValidSources(["wiki"])).toBe(true);
    expect(isValidSources(["bogus"])).toBe(false);
    expect(isValidSources(["code-local", "bogus"])).toBe(false);
    expect(SOURCE_ENUM).toEqual([
      "code-local",
      "code-remote",
      "wiki",
      "feishu",
      "web-search",
    ]);
  });
});
