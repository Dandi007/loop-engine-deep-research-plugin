import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  runGenerate,
  decideGenerate,
  buildReportMarker,
  renderReportBody,
  parseReportMarker,
  DEFAULT_GENERATE_CONFIG,
} from "../src/generate";
import type { GenerateConfig, GenerateDeps, ReportMarker } from "../src/generate";
import type { TerminationState } from "../src/tick";

const cfg: GenerateConfig = DEFAULT_GENERATE_CONFIG;

function term(over: Partial<TerminationState> = {}): TerminationState {
  return {
    state: "converged",
    coverage: 0,
    zeroGrowthRounds: 0,
    capHit: false,
    ...over,
  };
}

/** 立即完成的空 deps 骨架，测试按需覆写。 */
function baseDeps(over: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    readTermination: async () => term(),
    countBlocked: async () => 0,
    spawnDebater: vi.fn(async () => {}),
    spawnSynthesizer: vi.fn(async () => {}),
    spawnAnchorCheck: vi.fn(async () => ({ defects: 0 })),
    spawnExport: vi.fn(async () => {}),
    lockSynthesizer: async () => async () => {},
    ...over,
  };
}

describe("S4 gate (D1/D2/D3)", () => {
  it("D1: state===null does not start the generation phase (no spawns at all)", async () => {
    const deps = baseDeps({ readTermination: async () => term({ state: null }) });
    expect(decideGenerate(term({ state: null }))).toBe(false);
    await runGenerate(deps, cfg);
    expect(deps.spawnDebater).toHaveBeenCalledTimes(0);
    expect(deps.spawnSynthesizer).toHaveBeenCalledTimes(0);
    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(0);
    expect(deps.spawnExport).toHaveBeenCalledTimes(0);
  });

  it("D2: capHit=true but state===null (draining) does not start generation", async () => {
    const deps = baseDeps({
      readTermination: async () => term({ state: null, capHit: true }),
    });
    expect(decideGenerate(term({ state: null, capHit: true }))).toBe(false);
    await runGenerate(deps, cfg);
    expect(deps.spawnDebater).toHaveBeenCalledTimes(0);
    expect(deps.spawnSynthesizer).toHaveBeenCalledTimes(0);
    expect(deps.spawnExport).toHaveBeenCalledTimes(0);
  });

  it("D3: every non-empty terminal state starts the generation phase", async () => {
    for (const state of ["converged", "capped", "partial"] as const) {
      const deps = baseDeps({ readTermination: async () => term({ state }) });
      await runGenerate(deps, cfg);
      expect(deps.spawnDebater).toHaveBeenCalledTimes(3);
      expect(deps.spawnExport).toHaveBeenCalledTimes(1);
    }
  });
});

describe("S4 debaters (D4/D5/D16)", () => {
  it("D4: exactly 3 debaters are spawned", async () => {
    const deps = baseDeps();
    await runGenerate(deps, cfg);
    expect(deps.spawnDebater).toHaveBeenCalledTimes(3);
  });

  it("D5: the three debater routes are mutually distinct (dedup size === 3)", async () => {
    const routes: string[] = [];
    const deps = baseDeps({
      spawnDebater: vi.fn(async (route: string) => {
        routes.push(route);
      }),
    });
    await runGenerate(deps, cfg);
    expect(routes).toHaveLength(3);
    expect(new Set(routes).size).toBe(3);
  });

  it("D5/Q2: a caller-supplied config with duplicate debater routes is rejected (not silently accepted)", async () => {
    const bad: GenerateConfig = {
      ...cfg,
      debaterRoutes: ["debater.pro", "debater.pro", "debater.con"],
    };
    await expect(runGenerate(baseDeps(), bad)).rejects.toThrow(/mutually distinct/);
  });

  it("D16: route combination is not hardcoded — custom three routes are the ones used", async () => {
    const routes: string[] = [];
    const custom: GenerateConfig = {
      ...cfg,
      debaterRoutes: ["custom.one", "custom.two", "custom.three"],
    };
    const deps = baseDeps({
      spawnDebater: vi.fn(async (route: string) => {
        routes.push(route);
      }),
    });
    await runGenerate(deps, custom);
    expect(routes).toEqual(["custom.one", "custom.two", "custom.three"]);
  });
});

describe("S4 ordering (D7/D8)", () => {
  it("D7: all 3 debaters complete before the synthesizer (shared call sequence)", async () => {
    const seq: string[] = [];
    const deps = baseDeps({
      spawnDebater: vi.fn(async (route: string) => {
        seq.push(`debater:${route}`);
      }),
      spawnSynthesizer: vi.fn(async () => {
        seq.push("synthesizer");
      }),
    });
    await runGenerate(deps, cfg);
    const debIdx = seq
      .map((e, i) => (e.startsWith("debater:") ? i : -1))
      .filter((i) => i >= 0);
    const synIdx = seq.indexOf("synthesizer");
    expect(debIdx).toHaveLength(3);
    for (const i of debIdx) {
      expect(i).toBeLessThan(synIdx);
    }
  });

  it("D8: synthesizer → anchor-check → export are strictly ordered (shared sequence)", async () => {
    const seq: string[] = [];
    const deps = baseDeps({
      spawnSynthesizer: vi.fn(async () => {
        seq.push("synthesizer");
      }),
      spawnAnchorCheck: vi.fn(async () => {
        seq.push("anchor-check");
        return { defects: 0 };
      }),
      spawnExport: vi.fn(async () => {
        seq.push("export");
      }),
    });
    await runGenerate(deps, cfg);
    const synIdx = seq.indexOf("synthesizer");
    const anchorIdx = seq.indexOf("anchor-check");
    const exportIdx = seq.indexOf("export");
    expect(synIdx).toBeGreaterThanOrEqual(0);
    expect(synIdx).toBeLessThan(anchorIdx);
    expect(anchorIdx).toBeLessThan(exportIdx);
  });
});

describe("S4 singleton synthesizer lock (D6)", () => {
  it("D6: while one synthesizer is pending, the lock serializes — no second synthesizer spawn; synthesizer is never skipped", async () => {
    let locked = false;
    let waiters: Array<() => void> = [];
    let resolveSynth!: () => void;
    const gate = new Promise<void>((r) => {
      resolveSynth = r;
    });
    const spawnSynth = vi.fn(async () => {
      await gate;
    });
    const lockSynth = vi.fn(async () => {
      if (locked) {
        // 串行化：等待锁释放（wait-then-run），绝不跳过 synthesizer。
        await new Promise<void>((r) => waiters.push(r));
      }
      locked = true;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        locked = false;
        const w = waiters;
        waiters = [];
        w.forEach((r) => r());
      };
    });
    const deps = baseDeps({
      spawnSynthesizer: spawnSynth,
      lockSynthesizer: lockSynth,
    });

    const first = runGenerate(deps, cfg);
    // 等第一次调用真正发起 synthesizer spawn（此刻 lock 已被持有且挂起）。
    await vi.waitFor(() => expect(spawnSynth).toHaveBeenCalledTimes(1));

    // 挂起期间驱动第二次编排：拿不到锁必须等待，不得发起第二次 synthesizer spawn。
    const second = runGenerate(deps, cfg);
    await new Promise((r) => setTimeout(r, 20));
    expect(spawnSynth).toHaveBeenCalledTimes(1);

    // 释放第一次后，第二次串行拿到锁并补跑 synthesizer（不跳过阶段）。
    resolveSynth();
    await first;
    await second;
    expect(spawnSynth).toHaveBeenCalledTimes(2);
  });
});

describe("S4 anchor-check never blocks export (D9/D10)", () => {
  it("D9: anchor-check throwing an exception does not block export", async () => {
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        throw new Error("anchor-check boom");
      }),
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, cfg);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });

  it("D10: anchor-check reporting defects (non-exception) does not block export", async () => {
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => ({ defects: 5 })),
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, cfg);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

describe("S4 report header (D11/D12/D13/D14/D15)", () => {
  it("D11: header carries the stop reason (converged / capped)", () => {
    expect(renderReportBody({ stop: "converged", blocked: 0, capHit: false })).toContain(
      "stop=converged",
    );
    expect(renderReportBody({ stop: "capped", blocked: 2, capHit: true })).toContain(
      "stop=capped",
    );
  });

  it("D12: header carries the blocked count (blocked=12 parses to 12)", () => {
    const body = renderReportBody({ stop: "capped", blocked: 12, capHit: true });
    const marker = parseReportMarker(body);
    expect(marker?.blocked).toBe(12);
  });

  it("D13: header carries capHit", () => {
    const body = renderReportBody({ stop: "converged", blocked: 0, capHit: true });
    const marker = parseReportMarker(body);
    expect(marker?.capHit).toBe(true);
  });

  it("D14: a capped-with-blocked report header is distinguishable from a normal converged one", () => {
    const cappedBlocked = renderReportBody({ stop: "capped", blocked: 12, capHit: true });
    const converged = renderReportBody({ stop: "converged", blocked: 0, capHit: false });
    expect(cappedBlocked).not.toBe(converged);
  });

  it("D15: header is deterministically parseable — body → structured marker object", () => {
    const body = renderReportBody({ stop: "capped", blocked: 3, capHit: true });
    const marker = parseReportMarker(body);
    expect(marker).toEqual({ stop: "capped", blocked: 3, capHit: true } satisfies ReportMarker);

    // 散文/无标记 body → null
    expect(parseReportMarker("## 无结论")).toBeNull();
  });

  it("D15: parse is head-scoped — a marker embedded mid-document (not at body head) is NOT parsed", () => {
    const body = renderReportBody({ stop: "converged", blocked: 0, capHit: false });
    // 把标记嵌进正文中间（前面有散文），不得被当成头部标记解析出来。
    const midDocument = `prose intro\n${body}\nmore`;
    expect(parseReportMarker(midDocument)).toBeNull();
  });
});

describe("S4 pure decision + marker build (D17 helpers)", () => {
  it("buildReportMarker maps capped → capped, converged/partial → converged with blocked", () => {
    expect(buildReportMarker(term({ state: "capped", capHit: true }), 2)).toEqual({
      stop: "capped",
      blocked: 2,
      capHit: true,
    });
    expect(buildReportMarker(term({ state: "partial" }), 3)).toEqual({
      stop: "converged",
      blocked: 3,
      capHit: false,
    });
    expect(buildReportMarker(term({ state: "converged" }), 0)).toEqual({
      stop: "converged",
      blocked: 0,
      capHit: false,
    });
  });

  it("D17: the orchestration decision module is a pure function (no ./bus, no Date/fetch/Math.random)", () => {
    const srcPath = fileURLToPath(new URL("../src/generate.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\/bus["']/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/Math\.random/);
  });
});
