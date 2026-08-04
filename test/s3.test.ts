import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decideTermination,
  computeCoverage,
  TERMINAL_STATES,
  DEFAULT_TICK_CONFIG,
} from "../src/tick";
import type { BoardCard, TickConfig, TerminalState } from "../src/tick";

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    clueId: "c1",
    status: "explored",
    depth: 0,
    sources: ["code-local"],
    retries: 0,
    ...over,
  };
}

const cfg: TickConfig = DEFAULT_TICK_CONFIG;

/** 收敛场景的公共参数：零增长累到阈值、无在途、无 proposed、无 blocked。 */
function convergedParams() {
  return {
    coveredClueIds: [] as string[],
    prevCoverage: 0,
    prevZeroGrowthRounds: 1,
  };
}

describe("S3 coverage", () => {
  it("C1: coverage is the set size, not the evidence count (5 evidence on 1 clue → 1)", () => {
    expect(computeCoverage(["a", "a", "a", "a", "a"])).toBe(1);
  });

  it("C2: coverage accumulates across distinct clues (3 clues × 1 evidence → 3)", () => {
    expect(computeCoverage(["a", "b", "c"])).toBe(3);
    expect(
      decideTermination(
        { cards: [], coveredClueIds: ["a", "b", "c"], prevCoverage: 0, prevZeroGrowthRounds: 0 },
        cfg,
      ).coverage,
    ).toBe(3);
  });
});

describe("S3 zeroGrowthRounds update", () => {
  it("C3: growth resets zeroGrowthRounds to 0 (and a later no-growth tick increments it)", () => {
    const grown = decideTermination(
      { cards: [], coveredClueIds: ["a", "b", "c", "d", "e"], prevCoverage: 0, prevZeroGrowthRounds: 1 },
      cfg,
    );
    expect(grown.coverage).toBe(5);
    expect(grown.zeroGrowthRounds).toBe(0);

    const notGrown = decideTermination(
      { cards: [], coveredClueIds: ["a", "b", "c", "d", "e"], prevCoverage: 5, prevZeroGrowthRounds: 0 },
      cfg,
    );
    expect(notGrown.coverage).toBe(5);
    expect(notGrown.zeroGrowthRounds).toBe(1);
  });
});

describe("S3 termination conditions", () => {
  it("C4: condition 1 with blocked=0 → converged", () => {
    const r = decideTermination(
      { cards: [card(), card()], ...convergedParams() },
      cfg,
    );
    expect(r.state).toBe("converged");
  });

  it("C5a: in-flight > 0 alone prevents termination", () => {
    const r = decideTermination(
      {
        cards: [card({ status: "in_flight" })],
        ...convergedParams(),
      },
      cfg,
    );
    expect(r.state).toBeNull();
  });

  it("C5b: proposed > 0 alone prevents termination", () => {
    const r = decideTermination(
      {
        cards: [card({ status: "proposed" })],
        ...convergedParams(),
      },
      cfg,
    );
    expect(r.state).toBeNull();
  });

  it("C5c: zeroGrowthRounds below threshold alone prevents termination", () => {
    const r = decideTermination(
      {
        cards: [card(), card()],
        coveredClueIds: [],
        prevCoverage: 0,
        prevZeroGrowthRounds: 0,
      },
      cfg,
    );
    expect(r.zeroGrowthRounds).toBe(1);
    expect(r.state).toBeNull();
  });

  it("C6: count(clue) >= maxClues → capped (not converged)", () => {
    const r = decideTermination(
      { cards: [card({ clueId: "a" }), card({ clueId: "b" })], ...convergedParams() },
      { ...cfg, maxClues: 2 },
    );
    expect(r.state).toBe("capped");
  });

  it("C7: max(depth) >= maxDepth → capped", () => {
    const r = decideTermination(
      { cards: [card({ depth: 2 })], ...convergedParams() },
      { ...cfg, maxDepth: 2 },
    );
    expect(r.state).toBe("capped");
  });

  it("C7b: condition 3 only blocks new clues — depth cap with an in-flight card does not terminate yet", () => {
    const r = decideTermination(
      {
        cards: [
          card({ clueId: "deep", depth: 2 }),
          card({ clueId: "w", status: "in_flight" }),
        ],
        ...convergedParams(),
      },
      { ...cfg, maxDepth: 2 },
    );
    expect(r.capHit).toBe(true);
    expect(r.state).toBeNull();
  });

  it("C7c: condition 3 with an open card still draining → not terminated yet", () => {
    const r = decideTermination(
      {
        cards: [
          card({ clueId: "deep", depth: 2 }),
          card({ clueId: "o", status: "open" }),
        ],
        ...convergedParams(),
      },
      { ...cfg, maxDepth: 2 },
    );
    expect(r.capHit).toBe(true);
    expect(r.state).toBeNull();
  });

  it("C7d: condition 2 (count cap) with an in-flight card also drains before capped", () => {
    const r = decideTermination(
      {
        cards: [
          card({ clueId: "a" }),
          card({ clueId: "b" }),
          card({ clueId: "w", status: "in_flight" }),
        ],
        ...convergedParams(),
      },
      { ...cfg, maxClues: 2 },
    );
    expect(r.capHit).toBe(true);
    expect(r.state).toBeNull();
  });

  it("C8: all clues blocked → NOT converged, must be partial", () => {
    const r = decideTermination(
      {
        cards: [card({ status: "blocked" }), card({ status: "blocked" })],
        ...convergedParams(),
      },
      cfg,
    );
    expect(r.state).not.toBe("converged");
    expect(r.state).toBe("partial");
  });

  it("C9: blocked=1 with the rest explored and condition 1 otherwise met → partial", () => {
    const r = decideTermination(
      {
        cards: [
          card({ status: "blocked" }),
          card({ clueId: "e1" }),
          card({ clueId: "e2" }),
        ],
        ...convergedParams(),
      },
      cfg,
    );
    expect(r.state).toBe("partial");
  });

  it("C8c: cap reached with blocked>0 resolves to capped (honest cap signal, never converged)", () => {
    const r = decideTermination(
      {
        cards: [card({ status: "blocked" }), card({ clueId: "b", status: "blocked" })],
        ...convergedParams(),
      },
      { ...cfg, maxClues: 2 },
    );
    expect(r.state).not.toBe("converged");
    expect(r.state).toBe("capped");
  });

  it("C10: terminal state is a closed enum and the three scenarios are mutually distinct", () => {
    const converged = decideTermination(
      { cards: [card(), card()], ...convergedParams() },
      cfg,
    ).state;
    const capped = decideTermination(
      { cards: [card(), card()], ...convergedParams() },
      { ...cfg, maxClues: 2 },
    ).state;
    const partial = decideTermination(
      { cards: [card({ status: "blocked" }), card()], ...convergedParams() },
      cfg,
    ).state;

    const states: TerminalState[] = [converged!, capped!, partial!];
    for (const s of states) {
      expect(TERMINAL_STATES).toContain(s);
    }
    expect(new Set(states).size).toBe(3);
  });
});

describe("S3 terminability / parameters", () => {
  it("C11: across two no-growth ticks the zeroGrowthRounds metric strictly increases", () => {
    const t1 = decideTermination(
      { cards: [card()], coveredClueIds: [], prevCoverage: 0, prevZeroGrowthRounds: 0 },
      cfg,
    );
    const t2 = decideTermination(
      { cards: [card()], coveredClueIds: [], prevCoverage: 0, prevZeroGrowthRounds: t1.zeroGrowthRounds },
      cfg,
    );
    expect(t1.zeroGrowthRounds).toBe(1);
    expect(t2.zeroGrowthRounds).toBe(2);
    expect(t2.zeroGrowthRounds).toBe(t1.zeroGrowthRounds + 1);
  });

  it("C12: parameters are not hardcoded — maxClues:2 caps at 2 clues", () => {
    const r = decideTermination(
      { cards: [card(), card()], ...convergedParams() },
      { ...cfg, maxClues: 2 },
    );
    expect(r.state).toBe("capped");
  });

  it("C13: termination decision is a pure function (no ./bus import, no Date/fetch/Math.random)", () => {
    const srcPath = fileURLToPath(new URL("../src/tick.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\/bus["']/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/Math\.random/);
  });
});
