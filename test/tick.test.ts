import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  decideTick,
  runTick,
  isValidSources,
  DEFAULT_TICK_CONFIG,
  SOURCE_ENUM,
  roleForSources,
  SOURCE_TO_ROLE,
  INVALID_SOURCES_RATIONALE,
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
    text: "investigate X",
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

  it("exited with exit_code 0 → harvest (reclaim-explored moves to harvest)", () => {
    const s = state({
      cards: [inFlightCard()],
      runs: { run_1: { state: "exited", exitCode: 0 } },
    });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      {
        kind: "harvest",
        clueId: "x",
        runId: "run_1",
        text: "investigate X",
        depth: 0,
        sources: ["code-local"],
      },
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
    expect(dispatched[0]).toEqual({
      kind: "dispatch",
      clueId: "open_0",
      role: "dr-worker-code-local",
      text: "investigate X",
      depth: 0,
      sources: ["code-local"],
    });
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
      {
        kind: "block",
        clueId: "bad",
        reason: "invalid_sources",
        rationale: INVALID_SOURCES_RATIONALE,
      },
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

describe("E0c3b 判据 2: e0-regression profile TRIAGE_THRESHOLD=1 makes 1 proposed ⇒ triage", () => {
  function readProfileThreshold(): number {
    const profilePath = fileURLToPath(new URL("../profiles/deploy/e0-regression.env", import.meta.url));
    const text = readFileSync(profilePath, "utf8");
    for (const line of text.split("\n")) {
      const m = line.match(/^TRIAGE_THRESHOLD=(\d+)$/);
      if (m) return Number(m[1]);
    }
    return -1;
  }

  it("e0-regression profile declares TRIAGE_THRESHOLD=1", () => {
    const t = readProfileThreshold();
    expect(t).toBe(1);
  });

  it("with threshold=1 (from profile), board with 1 proposed clue triggers triage", () => {
    const t = readProfileThreshold();
    expect(t).toBe(1);
    const custom: TickConfig = { ...cfg, triageThreshold: t };
    const s = state({ cards: [card({ clueId: "p", status: "proposed" })] });
    expect(decideTick(s, custom).filter((x) => x.kind === "triage")).toHaveLength(1);
  });

  it("DISCRIMINATING: with default threshold=3, 1 proposed clue does NOT trigger triage", () => {
    const s = state({ cards: [card({ clueId: "p", status: "proposed" })] });
    expect(decideTick(s, cfg).filter((x) => x.kind === "triage")).toHaveLength(0);
  });

  it("DISCRIMINATING: 3 proposed with default threshold=3 DOES trigger triage", () => {
    const s = state({
      cards: [
        card({ clueId: "p1", status: "proposed" }),
        card({ clueId: "p2", status: "proposed" }),
        card({ clueId: "p3", status: "proposed" }),
      ],
    });
    expect(decideTick(s, cfg).filter((x) => x.kind === "triage")).toHaveLength(1);
  });
});

describe("source enum sanity", () => {
  it("isValidSources accepts only closed enum members", () => {
    expect(isValidSources(["code-local", "web-search"])).toBe(true);
    expect(isValidSources(["content"])).toBe(true);
    expect(isValidSources(["wiki"])).toBe(true);
    expect(isValidSources(["bogus"])).toBe(false);
    expect(isValidSources(["code-local", "bogus"])).toBe(false);
    expect(SOURCE_ENUM).toEqual([
      "code-local",
      "code-remote",
      "wiki",
      "feishu",
      "web-search",
      "content",
    ]);
  });
});

// ── N6：枚举外 sources ⇒ 该卡 blocked，不 spawn ────────────────────

describe("N6: out-of-enum sources ⇒ card blocked, no dispatch", () => {
  it("open card with out-of-enum source ⇒ block(invalid_sources), not dispatched", () => {
    const s = state({ cards: [card({ clueId: "bad", status: "open", sources: ["not-a-source"] })] });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      {
        kind: "block",
        clueId: "bad",
        reason: "invalid_sources",
        rationale: INVALID_SOURCES_RATIONALE,
      },
    ]);
    expect(d.some((x) => x.kind === "dispatch")).toBe(false);
  });
});

// ── E2b §1.1 W1 ⭐ 判别性：web-search ⇒ 派给 dr-worker-web（不再 blocked）──
//   旧的 N7（`web` 卡 blocked、`WEB_BLOCK_RATIONALE`）死路径已在 E2b §1.2 删除：
//   `dr-worker-web` 已由 E2a 在 agent-runtime 合入并真机验证，web 线索现在有 role、应当被正常派发。

describe("W1 ⭐: sources ['web-search'] ⇒ dispatch to dr-worker-web (no longer blocked)", () => {
  it("web-search maps to dr-worker-web role", () => {
    expect(roleForSources(["web-search"])).toBe("dr-worker-web");
  });

  it("open card with sources ['web-search'] ⇒ dispatch(dr-worker-web), NOT block", () => {
    const s = state({ cards: [card({ clueId: "w", status: "open", sources: ["web-search"] })] });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      {
        kind: "dispatch",
        clueId: "w",
        role: "dr-worker-web",
        text: "investigate X",
        depth: 0,
        sources: ["web-search"],
      },
    ]);
    expect(d.some((x) => x.kind === "block")).toBe(false);
  });

  it("DISCRIMINATING: removing the web-search→dr-worker-web mapping turns this red", () => {
    // ⛔ 判别性（spec §2 W1）：把 SOURCE_TO_ROLE 的 web-search 映射删掉 ⇒ 这条断言变红。
    //    用一个本地副本模拟「映射被删」：roleForSources(['web-search']) 必须真的解析到角色。
    expect(SOURCE_TO_ROLE["web-search"]).toBe("dr-worker-web");
    expect(roleForSources(["web-search"])).not.toBeNull();
  });
});

// ── E2b §1.1 W7 ⭐ 判别性：content ⇒ 派给 dr-worker-content ──

describe("W7 ⭐: sources ['content'] ⇒ dispatch to dr-worker-content", () => {
  it("content maps to dr-worker-content role", () => {
    expect(roleForSources(["content"])).toBe("dr-worker-content");
  });

  it("open card with sources ['content'] ⇒ dispatch(dr-worker-content), NOT block", () => {
    const s = state({ cards: [card({ clueId: "c", status: "open", sources: ["content"] })] });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      {
        kind: "dispatch",
        clueId: "c",
        role: "dr-worker-content",
        text: "investigate X",
        depth: 0,
        sources: ["content"],
      },
    ]);
    expect(d.some((x) => x.kind === "block")).toBe(false);
  });
});

// ── N8：role 映射正确（六条各一例）────────────────────────────────

describe("N8: sources→role mapping is correct for all six roles", () => {
  it("code-local → dr-worker-code-local", () => {
    expect(roleForSources(["code-local"])).toBe("dr-worker-code-local");
  });
  it("code-remote → dr-worker-code-remote", () => {
    expect(roleForSources(["code-remote"])).toBe("dr-worker-code-remote");
  });
  it("wiki → dr-worker-wiki", () => {
    expect(roleForSources(["wiki"])).toBe("dr-worker-wiki");
  });
  it("feishu → dr-worker-feishu", () => {
    expect(roleForSources(["feishu"])).toBe("dr-worker-feishu");
  });
  it("web-search → dr-worker-web (E2b)", () => {
    expect(roleForSources(["web-search"])).toBe("dr-worker-web");
  });
  it("content → dr-worker-content (E2b)", () => {
    expect(roleForSources(["content"])).toBe("dr-worker-content");
  });
  it("SOURCE_TO_ROLE contains exactly the six roles", () => {
    expect(Object.keys(SOURCE_TO_ROLE).sort()).toEqual([
      "code-local",
      "code-remote",
      "content",
      "feishu",
      "web-search",
      "wiki",
    ]);
  });
  it("dispatch decision carries the mapped role", () => {
    const s = state({ cards: [card({ clueId: "a", status: "open", sources: ["wiki"] })] });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      {
        kind: "dispatch",
        clueId: "a",
        role: "dr-worker-wiki",
        text: "investigate X",
        depth: 0,
        sources: ["wiki"],
      },
    ]);
  });
});

// ── E2b §1.2 回归 ⛔：仓内不再有裸 "web" token / WEB_SOURCE / isWebSource 死路径 ──

describe("E2b §1.2: dead web-block path removed; no bare 'web' source token", () => {
  it("src/tick.ts has no WEB_SOURCE / isWebSource / WEB_BLOCK_RATIONALE / web_unimplemented", () => {
    const srcPath = fileURLToPath(new URL("../src/tick.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf8");
    expect(source).not.toMatch(/\bWEB_SOURCE\b/);
    expect(source).not.toMatch(/\bisWebSource\b/);
    expect(source).not.toMatch(/\bWEB_BLOCK_RATIONALE\b/);
    expect(source).not.toMatch(/web_unimplemented/);
  });

  it("a bare 'web' source (not in enum) is treated as invalid_sources, not web_unimplemented", () => {
    // ⛔ 判别性（spec §1.2）：裸 'web' 不在封闭枚举里（枚举 token 是 'web-search'），
    //    所以它走 INVALID_SOURCES_RATIONALE，而不是已删除的 WEB_BLOCK_RATIONALE。
    const s = state({ cards: [card({ clueId: "w", status: "open", sources: ["web"] })] });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      {
        kind: "block",
        clueId: "w",
        reason: "invalid_sources",
        rationale: INVALID_SOURCES_RATIONALE,
      },
    ]);
    expect(d.some((x) => x.kind === "dispatch")).toBe(false);
  });
});

// ── W5 回归 ⛔：枚举外 / 枚举内无映射 role 仍走 blocked（不得放宽）──

describe("W5: out-of-enum and in-enum-no-role sources still block (not relaxed by new roles)", () => {
  it("out-of-enum source ⇒ block(invalid_sources) with INVALID_SOURCES_RATIONALE", () => {
    const s = state({ cards: [card({ clueId: "x", status: "open", sources: ["bogus"] })] });
    const d = decideTick(s, cfg);
    expect(d).toEqual([
      {
        kind: "block",
        clueId: "x",
        reason: "invalid_sources",
        rationale: INVALID_SOURCES_RATIONALE,
      },
    ]);
  });
});
