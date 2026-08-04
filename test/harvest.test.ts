/**
 * A8e —— 收割步硬验收测试（spec §3 H1–H16 / §4 变异 U1–U8 归因）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举（spec §4.1 纪律 2）。
 * 对纯数据/发布调用序列求值（纪律 4）；安全性断言配活性断言（纪律 3）；
 * 判别性成对用例（纪律 7：H5 / H9）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  anchorForEvidence,
  composeAnchor,
  evidenceFromWorker,
  clueFromWorker,
  harvestCard,
  MissingEvidenceChannelError,
  OVER_MAX_DEPTH_RATIONALE,
  type HarvestDeps,
  type HarvestBudget,
  type WorkerResultV1,
} from "../src/harvest";
import { runWrite, runChannelWrite, FrozenChannelError } from "../src/tick-run";
import type { WriteDeps, WriteCasInput } from "../src/tick-run";
import type { Decision } from "../src/tick";
import type { EvidenceV2, ClueV2 } from "../src/protocol";

const ROOT = dirname(fileURLToPath(import.meta.url));

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

// ── 纯函数：anchor（H3 / H4）───────────────────────────────────────

describe("H3: anchor shaped <source>://<locator>@<revision>#<range>", () => {
  it("with range → contains :// and @ and #", () => {
    const anchor = composeAnchor("code", "repo/path", "abc123", "L10-L20");
    expect(anchor).toBe("code://repo/path@abc123#L10-L20");
    expect(anchor).toContain("://");
    expect(anchor).toContain("@");
    expect(anchor).toContain("#");
  });
});

describe("H4: range absent ⇒ anchor has no # (separate case)", () => {
  it("no range → no # segment, no dangling #", () => {
    const anchor = composeAnchor("wiki", "Page", "rev-1");
    expect(anchor).toBe("wiki://Page@rev-1");
    expect(anchor).not.toContain("#");
  });
});

// ── evidence 映射（H2 / H5）────────────────────────────────────────

describe("H2: evidence payload has four non-empty required fields", () => {
  it("clue_id/anchor/quote/claim all non-empty", () => {
    const ev = evidenceFromWorker("card_x", {
      quote: "the exact quote",
      claim: "one-line conclusion",
      source: "code",
      locator: "repo/File.ts",
      revision: "abc123",
    });
    expect(ev.clue_id).toBe("card_x");
    expect(ev.clue_id.length).toBeGreaterThan(0);
    expect(ev.anchor.length).toBeGreaterThan(0);
    expect(ev.quote.length).toBeGreaterThan(0);
    expect(ev.claim.length).toBeGreaterThan(0);
  });
});

describe("H5: clue_id from card entity_id, not worker output (discriminative)", () => {
  it("worker item carrying a fake clue_id is ignored; card id wins", () => {
    const item = {
      quote: "q",
      claim: "c",
      source: "code",
      locator: "a",
      revision: "r",
      clue_id: "FAKE_FROM_WORKER",
    };
    const ev = evidenceFromWorker("card_x", item as never);
    expect(ev.clue_id).toBe("card_x");
    expect(ev.clue_id).not.toBe("FAKE_FROM_WORKER");
  });
});

// ── anchor 缺组件必须响亮失败，不得落退化空锚（review minor finding）──

describe("anchor missing component fails loudly (no silent empty anchor)", () => {
  it("missing source ⇒ error, never a degenerate '://@' anchor", () => {
    expect(() =>
      anchorForEvidence({
        quote: "q",
        claim: "c",
        locator: "a",
        revision: "r",
      }),
    ).toThrow(/anchor/);
  });

  it("missing locator ⇒ error", () => {
    expect(() =>
      anchorForEvidence({
        quote: "q",
        claim: "c",
        source: "code",
        revision: "r",
      }),
    ).toThrow(/anchor/);
  });

  it("missing revision ⇒ error", () => {
    expect(() =>
      anchorForEvidence({
        quote: "q",
        claim: "c",
        source: "code",
        locator: "a",
      }),
    ).toThrow(/anchor/);
  });

  it("empty-string source ⇒ error (empty is not a meaningful anchor component)", () => {
    expect(() =>
      anchorForEvidence({
        quote: "q",
        claim: "c",
        source: "",
        locator: "a",
        revision: "r",
      }),
    ).toThrow(/anchor/);
  });
});

// ── clue 映射（H10 / H11 / H19）────────────────────────────────────

describe("H10: proposed_clue ⇒ proposed, depth=父+1, sources inherited, parent=父 id", () => {
  it("maps all four fields", () => {
    const clue = clueFromWorker(
      { clueId: "card_x", depth: 1, sources: ["code-local", "wiki"] },
      { clue: "follow-up idea" },
      3,
    );
    expect(clue.status).toBe("proposed");
    expect(clue.depth).toBe(2);
    expect(clue.sources).toEqual(["code-local", "wiki"]);
    expect(clue.parent).toBe("card_x");
  });
});

describe("H11: depth+1 > maxDepth ⇒ clue blocked with non-empty rationale, not dropped", () => {
  it("still produces a clue (publishable), status=blocked, rationale non-empty", () => {
    const clue = clueFromWorker(
      { clueId: "card_x", depth: 3, sources: ["wiki"] },
      { clue: "too deep" },
      3,
    );
    expect(clue.status).toBe("blocked");
    expect(clue.depth).toBe(4);
    expect(typeof clue.rationale).toBe("string");
    expect(String(clue.rationale).length).toBeGreaterThan(0);
    expect(clue.rationale).toBe(OVER_MAX_DEPTH_RATIONALE);
  });
});

describe("H19: worker reason is not stored; clue has no reason field", () => {
  it("clue payload has no `reason` key even when worker item carries one", () => {
    const clue = clueFromWorker(
      { clueId: "card_x", depth: 0, sources: ["wiki"] },
      { clue: "idea", reason: "because triage" },
      3,
    );
    expect(clue).not.toHaveProperty("reason");
  });

  it("dev-notes records the explicit decision not to store reason", () => {
    const note = readFileSync(
      join(ROOT, "..", "docs", "dev-notes", "dev_ledr_a8e_harvest_01.md"),
      "utf8",
    );
    expect(note).toMatch(/reason/);
    expect(note).toMatch(/不落库/);
  });
});

// ── runWrite 层：CAS 次序 / 幂等 / 预算 / 错误（H6/H7/H8/H9/H12/H13/H14/H16）─

const HARVEST_DECISION: Decision = {
  kind: "harvest",
  clueId: "card_x",
  runId: "run-1",
  text: "investigate X",
  depth: 0,
  sources: ["code-local"],
};

function resultWith(over: Partial<WorkerResultV1> = {}): WorkerResultV1 {
  return {
    run_id: "run-1",
    evidence: [
      { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
      { quote: "q2", claim: "c2", source: "wiki", locator: "P", revision: "v" },
    ],
    proposed_clues: { items: [{ clue: "new idea 1" }, { clue: "new idea 2" }] },
    ...over,
  };
}

function harvestDeps(over: Partial<HarvestDeps> = {}): HarvestDeps {
  return {
    evidenceChannelId: "research:p02-smoke-1dce60.evidence",
    boardChannelId: "research:p02-smoke-1dce60",
    maxClues: 64,
    maxDepth: 3,
    boardClueCount: { value: 0 },
    readWorkerResult: vi.fn(async () => resultWith()),
    publishEvidence: vi.fn(async () => {}),
    publishClue: vi.fn(async () => {}),
    ...over,
  };
}

function writeDeps(hd: HarvestDeps): WriteDeps {
  return {
    cas: vi.fn(async (): Promise<{ success: boolean }> => ({ success: true })),
    spawnWorker: vi.fn(async () => {}),
    harvest: hd,
  };
}

// ── H6 / H7：先发完，才 CAS ────────────────────────────────────────

describe("H6: CAS to explored happens after all publishes (liveness)", () => {
  it("recorded call order: all publishes before the explored CAS", async () => {
    const seq: string[] = [];
    const hd = harvestDeps({
      publishEvidence: vi.fn(async (_c, _e, _k) => {
        seq.push("evidence");
      }),
      publishClue: vi.fn(async (_c, _cl, _k) => {
        seq.push("clue");
      }),
    });
    const deps = writeDeps(hd);
    deps.cas = vi.fn(async (input: WriteCasInput) => {
      seq.push(`cas:${input.to}`);
      return { success: true };
    });
    await runWrite(deps, [HARVEST_DECISION], 10);
    // 活性：确实 CAS 到 explored。
    expect(seq).toContain("cas:explored");
    // 安全性：explored CAS 是最后一次（H6：CAS 最后）。
    expect(seq[seq.length - 1]).toBe("cas:explored");
  });
});

describe("H7: publish throws ⇒ no CAS, card stays in_flight (safety)", () => {
  it("2nd evidence publish rejects ⇒ no explored CAS, runWrite rejects", async () => {
    let publishCount = 0;
    const hd = harvestDeps({
      publishEvidence: vi.fn(async () => {
        publishCount += 1;
        if (publishCount === 2) throw new Error("bus down");
      }),
    });
    const deps = writeDeps(hd);
    let casCalls = 0;
    deps.cas = vi.fn(async () => {
      casCalls += 1;
      return { success: true };
    });
    await expect(runWrite(deps, [HARVEST_DECISION], 10)).rejects.toThrow("bus down");
    // 安全性：零 CAS（不 CAS 掉 in_flight，下一 tick 重放安全）。
    expect(casCalls).toBe(0);
  });
});

// ── H8 / H9：幂等键 ────────────────────────────────────────────────

describe("H8: idempotency key = dr-evidence:<run_id>:<index> / dr-clue:<run_id>:<index>", () => {
  it("captured keys match the exact pattern", async () => {
    const evKeys: string[] = [];
    const clueKeys: string[] = [];
    const hd = harvestDeps({
      publishEvidence: vi.fn(async (_c, _e, key) => {
        evKeys.push(key);
      }),
      publishClue: vi.fn(async (_c, _cl, key) => {
        clueKeys.push(key);
      }),
    });
    await runWrite(writeDeps(hd), [HARVEST_DECISION], 10);
    expect(evKeys).toEqual(["dr-evidence:run-1:0", "dr-evidence:run-1:1"]);
    expect(clueKeys).toEqual(["dr-clue:run-1:0", "dr-clue:run-1:1"]);
  });
});

describe("H9: idempotency key has no timestamp/random (discriminative)", () => {
  it("same input run twice ⇒ identical key sets", async () => {
    const run = async (): Promise<string[]> => {
      const keys: string[] = [];
      const hd = harvestDeps({
        publishEvidence: vi.fn(async (_c, _e, key) => {
          keys.push(key);
        }),
        publishClue: vi.fn(async (_c, _cl, key) => {
          keys.push(key);
        }),
      });
      await runWrite(writeDeps(hd), [HARVEST_DECISION], 10);
      return keys;
    };
    const first = await run();
    const second = await run();
    expect(first).toEqual(second);
    expect(first).toHaveLength(4);
  });
});

// ── H12：maxClues 封顶 ─────────────────────────────────────────────

describe("H12: board at maxClues ⇒ no new clue, evidence still published, skipped reported", () => {
  it("boardClueCount >= maxClues ⇒ 0 clue publishes, 2 evidence publishes, skippedClues=2", async () => {
    const hd = harvestDeps({
      boardClueCount: { value: 64 },
      maxClues: 64,
    });
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [HARVEST_DECISION], 10);
    expect(hd.publishEvidence).toHaveBeenCalledTimes(2);
    expect(hd.publishClue).toHaveBeenCalledTimes(0);
    expect(result.harvestReports).toHaveLength(1);
    expect(result.harvestReports[0].evidencePublished).toBe(2);
    expect(result.harvestReports[0].cluesPublished).toBe(0);
    expect(result.harvestReports[0].skippedClues).toBe(2);
    // 活性：evidence 照发 + CAS（不因封顶而不 CAS）。
    expect(result.casResults.some((c) => c.to === "explored")).toBe(true);
  });
});

// ── maxClues 运行计数：不完全看 pre-tick 快照，随发布递增（review minor finding）──

describe("maxClues cap increments as clues are published (no overshoot)", () => {
  it("boardClueCount below maxClues with more clues than headroom ⇒ clips at headroom", async () => {
    // boardClueCount=62, maxClues=64 ⇒ headroom=2，但卡带 5 条 proposed_clue。
    // 若只看 pre-tick 快照（boardClueCount 62 < 64 ⇒ 全发），板会被冲到 67 > 64。
    // 修复后：只发 2 条，跳过 3 条，板不超 maxClues。
    const hd = harvestDeps({ boardClueCount: { value: 62 }, maxClues: 64 });
    // 覆盖默认 resultWith 的 2 条 proposed_clues，改成 5 条。
    (hd.readWorkerResult as unknown as ReturnType<typeof vi.fn>).mockResolvedValue({
      run_id: "run-1",
      evidence: [
        { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
      ],
      proposed_clues: {
        items: [
          { clue: "c0" },
          { clue: "c1" },
          { clue: "c2" },
          { clue: "c3" },
          { clue: "c4" },
        ],
      },
    });
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [HARVEST_DECISION], 10);
    expect((hd.publishClue as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(2);
    expect(result.harvestReports[0].cluesPublished).toBe(2);
    expect(result.harvestReports[0].skippedClues).toBe(3);
    // 活性：evidence 照发 + CAS。
    expect(result.casResults.some((c) => c.to === "explored")).toBe(true);
    // ⛔ 共享计数被写回：发布后 boardClueCount.value 从 62 → 64（跨卡累计）。
    expect(hd.boardClueCount.value).toBe(64);
  });
});

// ── maxClues 跨卡累计：attempt 2 major finding（多张 harvest 卡同一 tick）──

describe("maxClues cap accumulates across multiple harvest cards in one runWrite", () => {
  it("boardClueCount=63, maxClues=64, two exited(0) cards each with 1 clue ⇒ only 1 published, board never hits 65", async () => {
    // ⛔ attempt 2 major finding 的复现场景：卡 A 发 1 条（board=64），卡 B 若仍从
    //    旧的 pre-tick 快照 63 重算 headroom，就会再发 1 条（board=65）> maxClues。
    //    修复后：boardClueCount 是共享可变计数，卡 A 发完写回 64；卡 B 从 64 重算
    //    headroom=0 ⇒ 一条不发。整体板面最多停在 64。
    const hd = harvestDeps({ boardClueCount: { value: 63 }, maxClues: 64 });
    // 两张 harvest 决策，各带 1 条 evidence + 1 条 proposed_clue。
    const cardA: Decision = { ...HARVEST_DECISION, clueId: "card_a", runId: "run-a" };
    const cardB: Decision = { ...HARVEST_DECISION, clueId: "card_b", runId: "run-b" };
    (hd.readWorkerResult as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (runId: string) => ({
        run_id: runId,
        evidence: [
          { quote: "q", claim: "c", source: "code", locator: "a", revision: "r" },
        ],
        proposed_clues: { items: [{ clue: "idea" }] },
      }),
    );
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [cardA, cardB], 10);
    // 卡 A 发 1 条 clue；卡 B 因共享计数已达 maxClues 一条不发。
    expect((hd.publishClue as unknown as ReturnType<typeof vi.fn>)).toHaveBeenCalledTimes(1);
    expect(result.harvestReports).toHaveLength(2);
    expect(result.harvestReports[0].cluesPublished).toBe(1);
    expect(result.harvestReports[0].skippedClues).toBe(0);
    expect(result.harvestReports[1].cluesPublished).toBe(0);
    expect(result.harvestReports[1].skippedClues).toBe(1);
    // ⛔ 板面绝不超过 maxClues：共享计数停在 64。
    expect(hd.boardClueCount.value).toBe(64);
    // 活性：两张卡都 CAS 到 explored（evidence 照发 + CAS，不因封顶而不 CAS）。
    expect(result.casResults.filter((c) => c.to === "explored")).toHaveLength(2);
  });
});

// ── H13：预算不足 ⇒ 整卡跳过 ───────────────────────────────────────

describe("H13: budget insufficient for whole card ⇒ zero publish, zero CAS, loud report", () => {
  it("needed(2 ev + 2 clue + 1 CAS = 5) > maxWrites 3 ⇒ skip whole card", async () => {
    const hd = harvestDeps();
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [HARVEST_DECISION], 3);
    expect(hd.publishEvidence).toHaveBeenCalledTimes(0);
    expect(hd.publishClue).toHaveBeenCalledTimes(0);
    expect(result.casResults).toHaveLength(0);
    expect(result.writes).toBe(0);
    expect(result.harvestReports[0].skipped).toBe(true);
    expect(result.harvestReports[0].skippedReason).toBe("budget");
    expect(result.harvestReports[0].clueId).toBe("card_x");
  });

  it("sufficient budget ⇒ publishes + CAS happen (liveness pairing)", async () => {
    const hd = harvestDeps();
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [HARVEST_DECISION], 5);
    expect(result.writes).toBe(5);
    expect(result.casResults.some((c) => c.to === "explored")).toBe(true);
  });
});

// ── H14：证据 channel 无默认值，缺失响亮报错，零请求 ───────────────

describe("H14: evidence channel has no default; missing ⇒ loud error, zero requests", () => {
  it("harvest decision without harvest deps ⇒ MissingEvidenceChannelError", async () => {
    const deps: WriteDeps = {
      cas: vi.fn(async () => ({ success: true })),
      spawnWorker: vi.fn(async () => {}),
    };
    await expect(runWrite(deps, [HARVEST_DECISION], 5)).rejects.toBeInstanceOf(
      MissingEvidenceChannelError,
    );
  });

  it("harvest deps with empty evidenceChannelId ⇒ error, readWorkerResult never called", async () => {
    const hd = harvestDeps({ evidenceChannelId: "" });
    const deps = writeDeps(hd);
    await expect(runWrite(deps, [HARVEST_DECISION], 5)).rejects.toBeInstanceOf(
      MissingEvidenceChannelError,
    );
    expect(hd.readWorkerResult).not.toHaveBeenCalled();
  });
});

// ── H15：无 .board→.evidence 字符串推导 ────────────────────────────

describe("H15: no .board→.evidence string derivation", () => {
  it("no board→evidence derivation anywhere in src/, bin/, workflows/, scripts/", () => {
    // ⛔ review note（rf-attempt_01KZ7DKP...）：H15 必须仓库级 grep，不能只读 src/harvest.ts
    //    并断言一个宽松代理（not.toMatch(/replace\(/)）。那检测不到加在 src/tick-run.ts、
    //    src/tick-entry.ts、或 shell/workflow 装配层（bin/、workflows/、scripts/）里的派生——
    //    之前那个派生默认值实证就住在 bin/deep-research-loop.sh。这里把装配与源码一起扫。
    const dirs = ["src", "bin", "workflows", "scripts"];
    const files: string[] = [];
    for (const dir of dirs) {
      const absolute = join(ROOT, "..", dir);
      const walk = (d: string): void => {
        for (const name of readdirSync(d)) {
          const full = join(d, name);
          if (statSync(full).isDirectory()) walk(full);
          else if (/\.(ts|sh|yaml|yml|mjs|md)$/.test(name)) files.push(full);
        }
      };
      walk(absolute);
    }
    // 只扫「把板 channel 名推导成 evidence channel」的**代码**形态（replace / 拼接 / 模板），
    // 不匹配文档注释里的「`.board`→`.evidence`」字样。
    const forbidden = [
      /\.replace\s*\(\s*["'][^"']*board[^"']*["']\s*,\s*["'][^"']*evidence[^"']*["']\s*\)/i,
      /\.replace\s*\(\s*["'][^"']*\.board[^"']*["']/i,
      /\+\s*["']\.evidence["']/,
      /["']\.evidence["']\s*\+/,
      /`[^`]*\$\{[^}]*\}[^`]*\.evidence\b/,
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const re of forbidden) {
        expect(text, `${file} should not derive evidence channel from board channel`).not.toMatch(re);
      }
    }
    // 证据 channel 是显式注入的字段，绝不由 board channel 推导。
    const harvestSrc = readFileSync(join(ROOT, "..", "src", "harvest.ts"), "utf8");
    expect(harvestSrc).toMatch(/evidenceChannelId/);
  });
});

// ── H16：v1 冻结证据 channel 拒写、零请求 ──────────────────────────

describe("H16: v1 frozen evidence channel refused, zero requests", () => {
  it("frozen evidenceChannelId ⇒ FrozenChannelError, readWorkerResult never called", async () => {
    const hd = harvestDeps({
      evidenceChannelId: "research:loop-mcp-semantics.evidence",
    });
    const deps = writeDeps(hd);
    await expect(runWrite(deps, [HARVEST_DECISION], 5)).rejects.toBeInstanceOf(
      FrozenChannelError,
    );
    expect(hd.readWorkerResult).not.toHaveBeenCalled();
  });
});

// ── H1：端到端（runChannelWrite）——每条 evidence 各发一条 research.evidence.v2 ──

const WIRE_CHANNEL = "research:p02-smoke-1dce60";

describe("H1: exited(0) + worker.result.v1 ⇒ one research.evidence.v2 per evidence", () => {
  it("publishes evidence (kind research.evidence.v2) then CAS to explored", async () => {
    const inFlightMsg = {
      message_id: "msg_clue_1",
      channel_id: WIRE_CHANNEL,
      channel_seq: 1,
      kind: "research.clue.v2",
      payload: {
        status: "in_flight",
        text: "investigate X",
        depth: 0,
        sources: ["code-local"],
        run_id: "run-1",
      },
      entity_id: "card_x",
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const runsMessages = [
      {
        message_id: "run_exit",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.exited.v1",
        payload: { run_id: "run-1", exit_code: 0 },
        entity_id: "run-1",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        message_id: "result_1",
        channel_id: "board:agent-runs",
        channel_seq: 2,
        kind: "worker.result.v1",
        payload: {
          run_id: "run-1",
          evidence: [
            { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
            { quote: "q2", claim: "c2", source: "wiki", locator: "P", revision: "v" },
          ],
          proposed_clues: { items: [{ clue: "idea" }] },
        },
        entity_id: "run-1",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    const publishBodies: Array<{
      channel?: string;
      kind: string;
      payload: Record<string, unknown>;
      idempotency_key?: string;
    }> = [];
    let clueCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse({ head: inFlightMsg });
        }
        const pm = /\/v1\/channels\/([^/]+)\/publish/.exec(u);
        if (pm) {
          const body = JSON.parse(String(init?.body));
          publishBodies.push({ channel: decodeURIComponent(pm[1]), ...body });
          return jsonResponse({ message_id: `p_${publishBodies.length}`, channel_seq: 99 });
        }
        if (u.includes(`/v1/channels/${WIRE_CHANNEL}/messages`)) {
          clueCalls += 1;
          return jsonResponse({ messages: clueCalls === 1 ? [inFlightMsg] : [] });
        }
        if (u.includes("/v1/channels/board:agent-runs/messages")) {
          // 分页：首页（无 after_seq）返回 runs 消息，带 after_seq 返回空页。
          const hasAfterSeq = /[?&]after_seq=/.test(u);
          return jsonResponse({ messages: hasAfterSeq ? [] : runsMessages });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    const outcome = await runChannelWrite({
      channelId: WIRE_CHANNEL,
      evidenceChannelId: "research:p02-smoke-1dce60.evidence",
    });

    // H1：每条 evidence 各发一条 research.evidence.v2。
    const evidencePubs = publishBodies.filter((b) => b.kind === "research.evidence.v2");
    expect(evidencePubs).toHaveLength(2);
    expect(evidencePubs.every((b) => b.channel === "research:p02-smoke-1dce60.evidence")).toBe(true);
    // 新 clue 发往板。
    const cluePubs = publishBodies.filter((b) => b.kind === "research.clue.v2");
    expect(cluePubs).toHaveLength(2); // 1 条新 clue + 1 条 explored CAS
    // 最后的写是 explored CAS（H6）。
    const last = publishBodies[publishBodies.length - 1];
    expect(last.kind).toBe("research.clue.v2");
    expect((last.payload as Record<string, unknown>).status).toBe("explored");
    expect(outcome.harvestReports).toHaveLength(1);
    expect(outcome.harvestReports[0].evidencePublished).toBe(2);
  });
});

// ── H14 生产路径：runChannelWrite 缺 evidence channel ⇒ 响亮失败、零写入 ──
// ⛔ spec §4.1 纪律 8：H14 是「响亮失败」判据，验收必须落在 `--run` 的生产路径
//    （runChannelWrite），不得只验单元层 runWrite。这里构造真实的 in_flight 卡 +
//    exited(0) run + worker.result.v1，让 decideTick 发出 harvest 决策；
//    不传 evidenceChannelId ⇒ 生产装配路径必须响亮抛 MissingEvidenceChannelError，
//    且零 publish（不发任何 evidence/clue/CAS 写请求）。

describe("H14 production path: runChannelWrite without evidence channel ⇒ loud error, zero writes", () => {
  it("harvest decision on real path without evidenceChannelId rejects and publishes nothing", async () => {
    const inFlightMsg = {
      message_id: "msg_clue_1",
      channel_id: WIRE_CHANNEL,
      channel_seq: 1,
      kind: "research.clue.v2",
      payload: {
        status: "in_flight",
        text: "investigate X",
        depth: 0,
        sources: ["code-local"],
        run_id: "run-1",
      },
      entity_id: "card_x",
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const runsMessages = [
      {
        message_id: "run_exit",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.exited.v1",
        payload: { run_id: "run-1", exit_code: 0 },
        entity_id: "run-1",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        message_id: "result_1",
        channel_id: "board:agent-runs",
        channel_seq: 2,
        kind: "worker.result.v1",
        payload: {
          run_id: "run-1",
          evidence: [
            { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
          ],
          proposed_clues: { items: [{ clue: "idea" }] },
        },
        entity_id: "run-1",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    let publishCount = 0;
    let clueCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse({ head: inFlightMsg });
        }
        if (/\/v1\/channels\/[^/]+\/publish/.test(u)) {
          publishCount += 1;
          return jsonResponse({ message_id: `p_${publishCount}`, channel_seq: 99 });
        }
        if (u.includes(`/v1/channels/${WIRE_CHANNEL}/messages`)) {
          clueCalls += 1;
          return jsonResponse({ messages: clueCalls === 1 ? [inFlightMsg] : [] });
        }
        if (u.includes("/v1/channels/board:agent-runs/messages")) {
          const hasAfterSeq = /[?&]after_seq=/.test(u);
          return jsonResponse({ messages: hasAfterSeq ? [] : runsMessages });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    // ⛔ 生产路径：不传 evidenceChannelId（缺省 ⇒ 装配层 evidenceChannelId=""）。
    await expect(
      runChannelWrite({ channelId: WIRE_CHANNEL }),
    ).rejects.toBeInstanceOf(MissingEvidenceChannelError);
    // 零写入：没有发任何 publish（evidence / clue / CAS 全都没有）。
    expect(publishCount).toBe(0);
  });
});

// ── harvestCard 单元：预算接口（H13 的纯函数面）───────────────────

describe("harvestCard budget boundary", () => {
  it("budget exactly 5 (needed) ⇒ publishes all + reserves CAS", async () => {
    let remaining = 5;
    let consumed = 0;
    const budget: HarvestBudget = {
      remaining: () => remaining - consumed,
      consume: (n) => {
        consumed += n;
      },
    };
    const hd = harvestDeps();
    const report = await harvestCard(hd, { clueId: "card_x", depth: 0, sources: ["code-local"] }, "run-1", budget);
    expect(report.skipped).toBe(false);
    expect(report.casExplored).toBe(true);
    expect(report.evidencePublished).toBe(2);
    expect(report.cluesPublished).toBe(2);
    expect(consumed).toBe(4); // 发布消耗 4，CAS 由上层执行（预算 1 已在此账户外）
  });
});