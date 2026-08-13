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
import { createHash } from "node:crypto";
import {
  anchorForEvidence,
  anchorAuthorityMismatch,
  composeAnchor,
  contentAnchorAuthority,
  evidenceFromWorker,
  clueFromWorker,
  harvestCard,
  normalizeAnchorRange,
  MissingEvidenceChannelError,
  OVER_MAX_DEPTH_RATIONALE,
  WorkerResultShapeError,
  webEvidenceRejectionReason,
  isContentFingerprint,
  type HarvestDeps,
  type HarvestBudget,
  type WorkerResultV1,
} from "../src/harvest";
import { runWrite, runChannelWrite, FrozenChannelError } from "../src/tick-run";
import type { WriteDeps, WriteCasInput } from "../src/tick-run";
import type { Decision } from "../src/tick";
import type { EvidenceV2, ClueV2 } from "../src/protocol";

const ROOT = dirname(fileURLToPath(import.meta.url));

// ⛔ A10a B1：夹具字段名从冻结 schema 读出，不得手写。
//   `profiles/roles/schemas/worker-result.v1.json` 是权威源；测试代码 readFileSync 它，
//   取 `required` 与 `properties` 键来驱动夹具构造——绝不再手写 `evidence` / `{items}`。
const WORKER_RESULT_SCHEMA_PATH = join(
  ROOT,
  "..",
  "profiles",
  "roles",
  "schemas",
  "worker-result.v1.json",
);

function readWorkerResultSchema(): {
  required: string[];
  properties: Record<string, { type: string }>;
} {
  return JSON.parse(readFileSync(WORKER_RESULT_SCHEMA_PATH, "utf8"));
}

/**
 * 由冻结 schema 构造一个形状合法的 worker.result.v1 骨架：
 * 每个 required 键（evidences/proposed_clues/materials）映射为数组。
 * ⛔ B2：顶层键集合 === schema 的 required 集合（精确相等），不是「包含」。
 */
function validWorkerResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  const schema = readWorkerResultSchema();
  const base: Record<string, unknown> = {};
  for (const key of schema.required) base[key] = [];
  return { ...base, ...over };
}

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

// ── E1c D1/D2/D2b ⭐⭐：content 锚点的闸门钉在 source + 调度器侧 clue 元数据上 ──────
//    GT-1b：同一份 input 的三次真跑，worker 回的 anchor 三件套形态**完全不同**
//    （`web://<uri>` / `<digest>.md` + 截断 16 位 digest / 裸 URI + `L3:1-43`）。
//    E1b 的 `locator.startsWith("web://")` 判定第三次没命中，16 条证据全部以
//    `content://http://…` 发到了无 DELETE 的证据 channel 上。
//    ⇒ `<uri>`/`<digest>` 一律取调度器侧的 clue 元数据，worker 只提供 range 与 quote。

// GT-1b 逐字：该 content-clue 的**调度器侧权威值**（spec §2 判据 2）。
const AUTH_URI = "http://127.0.0.1:50287/e1-material.png";
const AUTH_DIGEST = "63ac13abaabf5726e675d8fbb5ccda36a960767ba5b860448e701ada88f5e43b";
/** 该 content-clue 的 text（由 contentClueText 产出，E1b D3）。 */
const CONTENT_CLUE_TEXT = `web://${AUTH_URI}@${AUTH_DIGEST}`;
/** 判据 2 的期望 anchor：输入 A / B 两条都必须产出**同一个**它。 */
const EXPECTED_ANCHOR = `web://${AUTH_URI}@${AUTH_DIGEST}#L9`;

/** GT-1b 第一次真跑（seq 733）逐字：worker 自带 scheme、完整 sha256、range "L9"。 */
const WORKER_REPORT_A = {
  quote: "H1 工程基建组围绕…",
  claim: "H1 工程基建组以…为北极星方向。",
  source: "content",
  locator: "web://http://127.0.0.1:50287/e1-material.png",
  revision: "63ac13abaabf5726e675d8fbb5ccda36a960767ba5b860448e701ada88f5e43b",
  range: "L9",
};

/** GT-1b 第二次真跑（seq 751）逐字：spool 本地文件名、截断 16 位 digest、range "9"。 */
const WORKER_REPORT_B = {
  quote: "H1 工程基建组围绕…",
  claim: "H1 工程基建组以…为北极星方向。",
  source: "content",
  locator: "63ac13abaabf5726.md",
  revision: "63ac13abaabf5726",
  range: "9",
};

/** GT-1b 第三次真跑（E1b Z2 全生产链）逐字：裸 URI 无 scheme、完整 sha256、range "L3:1-43"。 */
const WORKER_REPORT_C = {
  quote: "H1 工程基建组围绕…",
  claim: "H1 工程基建组以…为北极星方向。",
  source: "content",
  locator: "http://127.0.0.1:50287/e1-material.png",
  revision: "63ac13abaabf5726e675d8fbb5ccda36a960767ba5b860448e701ada88f5e43b",
  range: "L3:1-43",
};

/** 该 content-clue 的卡（调度器侧：sources 含 content、text 携带 web://<uri>@<digest>）。 */
const CONTENT_CARD = {
  clueId: "card_content",
  text: CONTENT_CLUE_TEXT,
  depth: 0,
  sources: ["content"],
};

describe("E1c D1 ⭐⭐: content anchor comes from the dispatcher-side clue metadata (not the worker)", () => {
  it("⭐⭐ D1 discriminating: GT-1b verbatim reports A and B ⇒ THE SAME authoritative anchor", () => {
    const authority = contentAnchorAuthority(CONTENT_CARD)!;
    expect(authority).toEqual({ uri: AUTH_URI, digest: AUTH_DIGEST });
    const anchorA = anchorForEvidence(WORKER_REPORT_A, authority);
    const anchorB = anchorForEvidence(WORKER_REPORT_B, authority);
    // 判据 2：两条逐字真实回报必须产出同一个锚点。
    expect(anchorA).toBe(EXPECTED_ANCHOR);
    expect(anchorB).toBe(EXPECTED_ANCHOR);
    expect(anchorB).toBe(anchorA);
    // ⛔ 判据 2 方向钉反的三个标志：content:// / .md / 截断 16 位 digest。
    for (const a of [anchorA, anchorB]) {
      expect(a).not.toContain("content://");
      expect(a).not.toContain(".md");
      expect(a).not.toBe(`web://${AUTH_URI}@63ac13abaabf5726#L9`);
      expect(a.startsWith("web://")).toBe(true);
    }
  });

  it("⭐⭐ D1 discriminating: report C (bare URI, range L3:1-43) ⇒ authoritative uri@digest, range kept verbatim", () => {
    const authority = contentAnchorAuthority(CONTENT_CARD)!;
    const anchor = anchorForEvidence(WORKER_REPORT_C, authority);
    // 判据 2 输入 C：anchor 结尾为 #L3:1-43（range 原样保留，只归一 L 前缀）。
    expect(anchor).toBe(`web://${AUTH_URI}@${AUTH_DIGEST}#L3:1-43`);
    expect(anchor.endsWith("#L3:1-43")).toBe(true);
    expect(anchor).not.toContain("content://");
  });

  it("⭐ D1 discriminating: content evidence WITHOUT dispatcher-side authority ⇒ loud error, never a content:// fallback", () => {
    // ⛔ 回退去用 worker 的 locator/revision 正是 GT-1b 里 16 条畸形证据的成因。
    expect(() => anchorForEvidence(WORKER_REPORT_C)).toThrow(/authority/i);
    expect(() => anchorForEvidence(WORKER_REPORT_A, null)).toThrow(/authority/i);
  });

  it("⭐ D1: the gate is pinned on `source`, NOT on the worker's locator prefix", () => {
    // 三条回报的 locator 前缀三种形态（web:// / 无 scheme 的文件名 / 裸 URI），
    // 但 source 都是 content ⇒ 三条都走权威路径。若闸门钉在 locator 前缀上，B/C 必然漏。
    const authority = contentAnchorAuthority(CONTENT_CARD)!;
    const anchors = [WORKER_REPORT_A, WORKER_REPORT_B, WORKER_REPORT_C].map((r) =>
      anchorForEvidence(r, authority),
    );
    for (const a of anchors) {
      expect(a.startsWith(`web://${AUTH_URI}@${AUTH_DIGEST}#`)).toBe(true);
    }
    // 反向：composeAnchor 已不再嗅探前缀（纯机械拼装），code:// 路径逐字不变。
    expect(composeAnchor("code", "repo/path/File.ts", "abc123", "L10-L20")).toBe(
      "code://repo/path/File.ts@abc123#L10-L20",
    );
  });

  it("D1: contentAnchorAuthority returns null for non-content cards / unparseable text", () => {
    // 非 content-clue（sources 不含 content）⇒ null（code:// 路径不受影响）。
    expect(
      contentAnchorAuthority({ clueId: "c", text: CONTENT_CLUE_TEXT, depth: 0, sources: ["code-local"] }),
    ).toBeNull();
    // content 卡但 text 非 web://<uri>@<digest> 形态 ⇒ null（无从拼可核验锚点）。
    expect(
      contentAnchorAuthority({ clueId: "c", text: "investigate content", depth: 0, sources: ["content"] }),
    ).toBeNull();
  });

  it("D1 regression: code evidence anchor unchanged (authoritative source is the worker's own repo read)", () => {
    // ⛔ code:// 路径逐字不变：code worker 的 locator/revision 是它从真仓里读的，仍是权威来源。
    const a = anchorForEvidence({
      quote: "q",
      claim: "c",
      source: "code",
      locator: "src/x.ts",
      revision: "abc123",
      range: "L5",
    });
    expect(a).toBe("code://src/x.ts@abc123#L5");
  });
});

describe("E1c D2b ⭐: range shape is normalized (worker returns 'L9' or '9')", () => {
  it("⭐ D2b discriminating: range '9' and 'L9' ⇒ both anchors end with #L9", () => {
    const authority = contentAnchorAuthority(CONTENT_CARD)!;
    const withL = anchorForEvidence({ ...WORKER_REPORT_A, range: "L9" }, authority);
    const withoutL = anchorForEvidence({ ...WORKER_REPORT_A, range: "9" }, authority);
    expect(withL.endsWith("#L9")).toBe(true);
    expect(withoutL.endsWith("#L9")).toBe(true);
    expect(withoutL).toBe(withL);
    // ⛔ 原样透传会得到 #9（去掉归一 ⇒ 本条变红）。
    expect(withoutL).not.toContain("#9");
  });

  it("D2b: normalizeAnchorRange pure cases (L-prefix only; the rest is kept verbatim)", () => {
    expect(normalizeAnchorRange("9")).toBe("L9");
    expect(normalizeAnchorRange("L9")).toBe("L9");
    expect(normalizeAnchorRange("L3:1-43")).toBe("L3:1-43");
    expect(normalizeAnchorRange("3:1-43")).toBe("L3:1-43");
    expect(normalizeAnchorRange("10-20")).toBe("L10-20");
    // 缺省/空 ⇒ undefined ⇒ 调用方省略整个 # 段（H4）。
    expect(normalizeAnchorRange(undefined)).toBeUndefined();
    expect(normalizeAnchorRange("  ")).toBeUndefined();
  });

  it("D2b: range absent ⇒ content anchor has no # segment (H4 regression)", () => {
    const authority = contentAnchorAuthority(CONTENT_CARD)!;
    const a = anchorForEvidence({ ...WORKER_REPORT_A, range: undefined }, authority);
    expect(a).toBe(`web://${AUTH_URI}@${AUTH_DIGEST}`);
    expect(a).not.toContain("#");
  });
});

describe("E1c D2 ⭐: worker/authority mismatch is recorded (but never suppresses the evidence)", () => {
  it("⭐ D2 discriminating: report B (both fields differ) ⇒ mismatch names clue_id and both sides", () => {
    const authority = contentAnchorAuthority(CONTENT_CARD)!;
    const m = anchorAuthorityMismatch("card_content", 3, WORKER_REPORT_B, authority);
    expect(m).not.toBeNull();
    expect(m!.clueId).toBe("card_content");
    expect(m!.index).toBe(3);
    expect([...m!.fields].sort()).toEqual(["locator", "revision"]);
    // 两侧的值都在记录里（这是持续观察 worker 行为的唯一窗口）。
    expect(m!.workerLocator).toBe("63ac13abaabf5726.md");
    expect(m!.authoritativeUri).toBe(AUTH_URI);
    expect(m!.workerRevision).toBe("63ac13abaabf5726");
    expect(m!.authoritativeDigest).toBe(AUTH_DIGEST);
    // ⛔ 不回抄 quote 全文。
    expect(JSON.stringify(m)).not.toContain(WORKER_REPORT_B.quote);
  });

  it("⭐ D2 discriminating (pair): report A (both sides agree) ⇒ NO mismatch record", () => {
    const authority = contentAnchorAuthority(CONTENT_CARD)!;
    expect(anchorAuthorityMismatch("card_content", 0, WORKER_REPORT_A, authority)).toBeNull();
    // 输入 C 的裸 URI 与权威 uri 逐字相等、revision 是完整 sha256 ⇒ 同样不算不一致。
    expect(anchorAuthorityMismatch("card_content", 0, WORKER_REPORT_C, authority)).toBeNull();
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
      { clueId: "card_x", text: "investigate X", depth: 1, sources: ["code-local", "wiki"] },
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
      { clueId: "card_x", text: "investigate X", depth: 3, sources: ["wiki"] },
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
      { clueId: "card_x", text: "investigate X", depth: 0, sources: ["wiki"] },
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
    evidences: [
      { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
      { quote: "q2", claim: "c2", source: "wiki", locator: "P", revision: "v" },
    ],
    proposed_clues: [{ clue: "new idea 1" }, { clue: "new idea 2" }],
    materials: [{ uri: "m1" }],
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
      evidences: [
        { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
      ],
      proposed_clues: [
        { clue: "c0" },
        { clue: "c1" },
        { clue: "c2" },
        { clue: "c3" },
        { clue: "c4" },
      ],
      materials: [{ uri: "m1" }],
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
        evidences: [
          { quote: "q", claim: "c", source: "code", locator: "a", revision: "r" },
        ],
        proposed_clues: [{ clue: "idea" }],
        materials: [{ uri: "m1" }],
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
  it("needed(2 ev + 2 clue + 1 CAS = 5) > maxWrites 3 ⇒ skip whole card, marked infeasible (A10c)", async () => {
    const hd = harvestDeps();
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [HARVEST_DECISION], 3);
    expect(hd.publishEvidence).toHaveBeenCalledTimes(0);
    expect(hd.publishClue).toHaveBeenCalledTimes(0);
    expect(result.casResults).toHaveLength(0);
    expect(result.writes).toBe(0);
    expect(result.harvestReports[0].skipped).toBe(true);
    // ⛔ A10c §1.2：needed(5) > maxWrites(3)，与本轮已用无关 ⇒ 永不可收割 ⇒ 可辨识的
    //    budget_infeasible（配置错误），不再是「本轮预算耗尽」的 budget（spec D5）。
    expect(result.harvestReports[0].skippedReason).toBe("budget_infeasible");
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

// ── A10c D5/D6：死锁必须可辨识，不能只报 budget ────────────────────

describe("A10c D5/D6: distinguish never-harvestable from budget-exhausted-this-round", () => {
  it("D5: needed > maxWrites (infeasible, config error) ⇒ budget_infeasible, distinguishable from budget", async () => {
    const hd = harvestDeps();
    const deps = writeDeps(hd);
    // 默认 resultWith: 2 ev + 2 clue + 1 CAS = 5 needed；maxWrites 3 ⇒ 永不可收割。
    const result = await runWrite(deps, [HARVEST_DECISION], 3);
    expect(result.harvestReports[0].skipped).toBe(true);
    // ⛔ 与本轮已用无关（fresh 预算 3 == remaining 3）⇒ 仍判定为配置错误，标记可辨识。
    expect(result.harvestReports[0].skippedReason).toBe("budget_infeasible");
    expect(result.harvestReports[0].budgetShortfall).toBe(2);
  });

  it("D6: card A consumes budget, card B needed ≤ maxWrites but remaining short ⇒ still budget (recoverable next round)", async () => {
    const hd = harvestDeps();
    // card A: 1 ev + 1 clue (+1 CAS) = 3 writes；card B: 2 ev + 2 clue (+1 CAS) = 5 writes。
    (hd.readWorkerResult as unknown as ReturnType<typeof vi.fn>).mockImplementation(
      async (runId: string) => {
        if (runId === "run-a") {
          return {
            run_id: "run-a",
            evidences: [
              { quote: "q", claim: "c", source: "code", locator: "a", revision: "r" },
            ],
            proposed_clues: [{ clue: "idea a" }],
            materials: [{ uri: "m" }],
          };
        }
        return resultWith();
      },
    );
    const cardA: Decision = { ...HARVEST_DECISION, clueId: "card_a", runId: "run-a" };
    const cardB: Decision = { ...HARVEST_DECISION, clueId: "card_b", runId: "run-b" };
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [cardA, cardB], 5);
    // card A 完整收割（活性）。
    expect(result.harvestReports[0].skipped).toBe(false);
    // card B 被跳过，但原因是 budget（非 infeasible）：needed(5) ≤ maxWrites(5)，
    //    只是本轮 remaining(2) 不足 ⇒ 下一轮可继续（spec D6）。
    expect(result.harvestReports[1].skipped).toBe(true);
    expect(result.harvestReports[1].skippedReason).toBe("budget");
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
    // E0c1 §1.3 例外：src/run-channels.ts 的 perRunResearchChannels 从 (profileBase, runId)
    // 独立派生三条 channel（不是从 board channel 推导 evidence），是 spec 显式要求的形态；
    // pattern 4 因此要求模板变量看起来像 board/tick/index channel（boardChannel / tickChannel / .index），
    // 不误伤从 profileBase 派生的 per-run evidence channel。
    const forbidden = [
      /\.replace\s*\(\s*["'][^"']*board[^"']*["']\s*,\s*["'][^"']*evidence[^"']*["']\s*\)/i,
      /\.replace\s*\(\s*["'][^"']*\.board[^"']*["']/i,
      /\+\s*["']\.evidence["']/,
      /["']\.evidence["']\s*\+/,
      /`[^`]*\$\{[^}]*(?:boardChannel|tickChannel|boardCh|tickCh|\.index)[^}]*\}[^`]*\.evidence\b/i,
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
          evidences: [
            { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
            { quote: "q2", claim: "c2", source: "wiki", locator: "P", revision: "v" },
          ],
          proposed_clues: [{ clue: "idea" }],
          materials: [{ uri: "m1" }],
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
    // E1 D3/D6：1 条新 clue（"idea"）+ 1 条 content-clue（material m1 取材失败 ⇒ 出生即 blocked）
    //   + 1 条 explored CAS = 3。content-clue 也走板（content-clue 是 clue）。
    expect(cluePubs).toHaveLength(3);
    // 最后的写是 explored CAS（H6）。
    const last = publishBodies[publishBodies.length - 1];
    expect(last.kind).toBe("research.clue.v2");
    expect((last.payload as Record<string, unknown>).status).toBe("explored");
    expect(outcome.harvestReports).toHaveLength(1);
    expect(outcome.harvestReports[0].evidencePublished).toBe(2);
    // E1 D3/D6：content-clue 落板（取材失败 ⇒ blocked）。
    expect(outcome.harvestReports[0].contentCluesPublished).toBe(1);
    expect(outcome.harvestReports[0].contentCluesBlocked).toBe(1);
    const contentClue = cluePubs.find(
      (b) => (b.payload as Record<string, unknown>).parent === "card_x"
        && ((b.payload as Record<string, unknown>).sources as string[]).includes("content"),
    );
    expect(contentClue).toBeDefined();
    expect((contentClue!.payload as Record<string, unknown>).status).toBe("blocked");
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
          evidences: [
            { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
          ],
          proposed_clues: [{ clue: "idea" }],
          materials: [{ uri: "m1" }],
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
      total: () => remaining,
      remaining: () => remaining - consumed,
      consume: (n) => {
        consumed += n;
      },
    };
    const hd = harvestDeps();
    const report = await harvestCard(hd, { clueId: "card_x", text: "investigate X", depth: 0, sources: ["code-local"] }, "run-1", budget);
    expect(report.skipped).toBe(false);
    expect(report.casExplored).toBe(true);
    expect(report.evidencePublished).toBe(2);
    expect(report.cluesPublished).toBe(2);
    expect(consumed).toBe(4); // 发布消耗 4，CAS 由上层执行（预算 1 已在此账户外）
  });
});

// ── E1b D6 / GT-5：写预算对新 transcript 预留 2 次（doc + clue）──────────
//    一份新 transcript 实际耗 2 次 bus 写（publishDoc + content-clue 落板）；
//    原 needed 只预留 1 ⇒ --max-writes 可被超出「每份新转写 1 次」。

describe("E1b D6 / GT-5: budget reserves 2 writes per new transcript (doc + clue)", () => {
  // 一张只有 1 条 material（新 transcript，ingest 返回非 null clue）的卡。
  // needed（worst case，每条 material = doc + clue）= 0 ev + 0 regular clue + 1 content clue + 1 content doc + 1 CAS = 3。
  function newTranscriptDeps(): HarvestDeps {
    return harvestDeps({
      maxClues: 64,
      boardClueCount: { value: 0 },
      readWorkerResult: vi.fn(async () => ({
        run_id: "run-d6",
        evidences: [],
        proposed_clues: [],
        materials: [{ uri: "http://x/new-transcript.pdf" }],
      })),
      ingestMaterial: vi.fn(async () => ({
        text: "web://http://x/new-transcript.pdf@deadbeef",
        status: "proposed" as const,
        depth: 0,
        sources: ["content"],
        parent: "card_d6",
      })),
    });
  }

  it("⭐ D6 discriminating: budget remaining 2 (< needed 3) ⇒ whole card skipped, zero writes (no overflow)", async () => {
    const total = 64;
    let used = 62; // remaining = 2
    const budget: HarvestBudget = {
      total: () => total,
      remaining: () => total - used,
      consume: (n) => { used += n; },
    };
    const hd = newTranscriptDeps();
    const report = await harvestCard(hd, { clueId: "card_d6", text: "web://http://x/new-transcript.pdf@deadbeef", depth: 0, sources: ["content"] }, "run-d6", budget);
    // 整卡跳过（needed=3 > remaining=2）：零发布、零 CAS。
    expect(report.skipped).toBe(true);
    expect(report.skippedReason).toBe("budget");
    expect(report.contentCluesPublished).toBe(0);
    expect(report.casExplored).toBe(false);
    // 零 consume（没有把预算写超）。
    expect(used).toBe(62);
  });

  it("⭐ D6 discriminating: budget remaining 3 (== needed 3) ⇒ proceeds, consumes 2 (doc + clue), no overflow", async () => {
    const total = 64;
    let used = 61; // remaining = 3
    const budget: HarvestBudget = {
      total: () => total,
      remaining: () => total - used,
      consume: (n) => { used += n; },
    };
    const hd = newTranscriptDeps();
    const report = await harvestCard(hd, { clueId: "card_d6", text: "web://http://x/new-transcript.pdf@deadbeef", depth: 0, sources: ["content"] }, "run-d6", budget);
    // needed=3 ≤ remaining=3 ⇒ 放行；发布 1 条 content-clue（新 transcript），consume 2（doc + clue）。
    expect(report.skipped).toBe(false);
    expect(report.contentCluesPublished).toBe(1);
    expect(report.casExplored).toBe(true);
    // D6：consume 2（doc + clue），⛔ 不是 1（旧漏算 doc 写）。CAS 由上层执行（账户外）。
    expect(used).toBe(63); // 61 + 2
  });

  it("D6 reuse path: ingestMaterial returns null (D2 reuse) ⇒ consume 0 (no doc, no clue)", async () => {
    const total = 64;
    let used = 61; // remaining = 3
    const budget: HarvestBudget = {
      total: () => total,
      remaining: () => total - used,
      consume: (n) => { used += n; },
    };
    const hd = harvestDeps({
      maxClues: 64,
      boardClueCount: { value: 0 },
      readWorkerResult: vi.fn(async () => ({
        run_id: "run-d6-reuse",
        evidences: [],
        proposed_clues: [],
        materials: [{ uri: "http://x/existing.pdf" }],
      })),
      // D2 复用 ⇒ 返回 null（不 propose、不发 doc）。
      ingestMaterial: vi.fn(async () => null),
    });
    const report = await harvestCard(hd, { clueId: "card_d6r", text: "web://http://x/existing.pdf@deadbeef", depth: 0, sources: ["content"] }, "run-d6-reuse", budget);
    expect(report.skipped).toBe(false);
    expect(report.contentCluesPublished).toBe(0);
    // 复用路径：实际 0 写（不新发 doc），consume 0。⛔ 不得一律 +1。
    expect(used).toBe(61);
  });
});



const EV_ITEM = (i: number): { quote: string; claim: string; source: string; locator: string; revision: string } => ({
  quote: `q${i}`,
  claim: `c${i}`,
  source: "code",
  locator: `a${i}`,
  revision: "r",
});

const HARVEST_CARD = { clueId: "card_x", text: "investigate X", depth: 0, sources: ["code-local"] };

function makeBudget(total: number): HarvestBudget {
  let used = 0;
  return {
    total: () => total,
    remaining: () => total - used,
    consume: (n: number) => {
      used += n;
    },
  };
}

describe("B1: fixture field names read from frozen schema, not handwritten", () => {
  it("schema exists at profiles/roles/schemas/worker-result.v1.json and declares required array keys", () => {
    const schema = readWorkerResultSchema();
    expect(schema.required).toEqual(["evidences", "proposed_clues", "materials"]);
    expect(schema.properties.evidences.type).toBe("array");
    expect(schema.properties.proposed_clues.type).toBe("array");
    expect(schema.properties.materials.type).toBe("array");
  });
});

describe("B2: fixture top-level key set === schema required set (exact equality)", () => {
  it("validWorkerResult keys exactly equal schema.required (not a superset)", () => {
    const schema = readWorkerResultSchema();
    expect(Object.keys(validWorkerResult()).sort()).toEqual([...schema.required].sort());
  });
});

describe("B3: real shape (all three arrays) ⇒ publish count === evidences.length", () => {
  it("3 evidences ⇒ exactly 3 evidence publishes, casExplored true", async () => {
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({
          run_id: "run-1",
          evidences: [EV_ITEM(1), EV_ITEM(2), EV_ITEM(3)],
          proposed_clues: [{ clue: "i1" }],
          materials: [{ uri: "m1" }],
        }),
      ),
    });
    const report = await harvestCard(hd, HARVEST_CARD, "run-1", makeBudget(5));
    expect(hd.publishEvidence).toHaveBeenCalledTimes(3);
    expect(report.evidencePublished).toBe(3);
    expect(report.cluesPublished).toBe(1);
    expect(report.casExplored).toBe(true);
  });
});

describe("B4: proposed_clues as bare array read correctly (not .items)", () => {
  it("3 bare-array clues ⇒ exactly 3 clue publishes, skippedClues 0", async () => {
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({
          run_id: "run-1",
          evidences: [EV_ITEM(1)],
          proposed_clues: [{ clue: "a" }, { clue: "b" }, { clue: "c" }],
          materials: [{ uri: "m1" }],
        }),
      ),
    });
    const report = await harvestCard(hd, HARVEST_CARD, "run-1", makeBudget(5));
    expect(hd.publishClue).toHaveBeenCalledTimes(3);
    expect(report.cluesPublished).toBe(3);
    expect(report.skippedClues).toBe(0);
  });
});

describe("B5: old wrong shape (evidence / {items}) ⇒ loud failure, never silent 0-publish + CAS", () => {
  it("singular `evidence` key ⇒ WorkerResultShapeError, zero publish, zero CAS", async () => {
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () => ({ run_id: "run-1", evidence: [EV_ITEM(1)] }) as never),
    });
    const deps = writeDeps(hd);
    await expect(runWrite(deps, [HARVEST_DECISION], 10)).rejects.toBeInstanceOf(
      WorkerResultShapeError,
    );
    expect(hd.publishEvidence).not.toHaveBeenCalled();
    expect(hd.publishClue).not.toHaveBeenCalled();
    expect((deps.cas as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });

  it("`proposed_clues:{items:[...]}` ⇒ WorkerResultShapeError, zero publish, zero CAS", async () => {
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () =>
        ({ run_id: "run-1", evidences: [], proposed_clues: { items: [{ clue: "x" }] }, materials: [] }) as never,
      ),
    });
    const deps = writeDeps(hd);
    await expect(runWrite(deps, [HARVEST_DECISION], 10)).rejects.toBeInstanceOf(
      WorkerResultShapeError,
    );
    expect(hd.publishEvidence).not.toHaveBeenCalled();
    expect(hd.publishClue).not.toHaveBeenCalled();
    expect((deps.cas as unknown as ReturnType<typeof vi.fn>)).not.toHaveBeenCalled();
  });
});

describe("B6: missing `materials` key ⇒ loud failure (guard checks required complete)", () => {
  it("no materials key ⇒ WorkerResultShapeError", async () => {
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () => ({ run_id: "run-1", evidences: [], proposed_clues: [] }) as never),
    });
    await expect(harvestCard(hd, HARVEST_CARD, "run-1", makeBudget(5))).rejects.toBeInstanceOf(
      WorkerResultShapeError,
    );
  });
});

describe("B7: no_result ⇒ zero publish, casExplored false, skippedReason no_result", () => {
  it("readWorkerResult returns null ⇒ casExplored false, skippedReason no_result, zero publish", async () => {
    const hd = harvestDeps({ readWorkerResult: vi.fn(async () => null) });
    const report = await harvestCard(hd, HARVEST_CARD, "run-1", makeBudget(5));
    expect(report.skipped).toBe(true);
    expect(report.skippedReason).toBe("no_result");
    expect(report.casExplored).toBe(false);
    expect(hd.publishEvidence).not.toHaveBeenCalled();
    expect(hd.publishClue).not.toHaveBeenCalled();
  });

  it("runWrite: no_result ⇒ no explored CAS (card stays in_flight)", async () => {
    const hd = harvestDeps({ readWorkerResult: vi.fn(async () => null) });
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [HARVEST_DECISION], 10);
    expect(result.casResults).toHaveLength(0);
    expect(result.harvestReports[0].skippedReason).toBe("no_result");
    expect(result.harvestReports[0].casExplored).toBe(false);
  });
});

describe("B8: result exists + evidences empty array ⇒ casExplored true (discriminative vs B7)", () => {
  it("empty evidences (worker genuinely produced nothing) ⇒ casExplored true", async () => {
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({ run_id: "run-1", evidences: [], proposed_clues: [], materials: [] }),
      ),
    });
    const report = await harvestCard(hd, HARVEST_CARD, "run-1", makeBudget(5));
    expect(report.skipped).toBe(false);
    expect(report.casExplored).toBe(true);
    expect(hd.publishEvidence).not.toHaveBeenCalled();
    expect(hd.publishClue).not.toHaveBeenCalled();
  });

  it("runWrite: empty evidences ⇒ explored CAS happens (differs from B7 only by result existing)", async () => {
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({ run_id: "run-1", evidences: [], proposed_clues: [], materials: [] }),
      ),
    });
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [HARVEST_DECISION], 10);
    expect(result.casResults.some((c) => c.to === "explored")).toBe(true);
  });
});

// ── E2b §1.3 ⭐ 活 URL 证据机械拒发（本包最重要的一条）───────────────
//
// 真机实证：dr-worker-web 会把活 URL 当证据出处交差（source:"web" + locator:"https://…"
// + 空 revision + 引文摘自实时页面）。这道闸必须机械化在发布路径上。
// ⛔ 条目级：一条不合规不得连坐整卡；⛔ 拒发记录不得回抄 quote 全文。

describe("E2b §1.3 ⭐: webEvidenceRejectionReason shape predicates", () => {
  it("web source + empty revision ⇒ rejected (live-page shape)", () => {
    expect(
      webEvidenceRejectionReason({
        quote: "q",
        claim: "c",
        source: "web",
        locator: "https://ziglang.org/download/",
        revision: "",
      }),
    ).not.toBeNull();
  });

  it("web-search source + date revision ⇒ rejected (non-fingerprint)", () => {
    expect(
      webEvidenceRejectionReason({
        quote: "q",
        claim: "c",
        source: "web-search",
        locator: "https://example.com",
        revision: "2026-04-13",
      }),
    ).not.toBeNull();
  });

  it("web source + 'latest' revision ⇒ rejected (non-fingerprint)", () => {
    expect(
      webEvidenceRejectionReason({
        quote: "q",
        claim: "c",
        source: "web",
        locator: "https://example.com",
        revision: "latest",
      }),
    ).not.toBeNull();
  });

  it("bare http URL locator + empty revision (non-web source) ⇒ rejected (判据 B)", () => {
    expect(
      webEvidenceRejectionReason({
        quote: "q",
        claim: "c",
        source: "misc",
        locator: "https://example.com",
        revision: "",
      }),
    ).not.toBeNull();
  });

  it("web source + sha256 hex revision ⇒ NOT rejected (content fingerprint shape)", () => {
    expect(
      webEvidenceRejectionReason({
        quote: "q",
        claim: "c",
        source: "web",
        locator: "web://example.com/snapshot",
        revision: "a".repeat(64),
      }),
    ).toBeNull();
  });

  it("code source + non-URL locator + non-empty revision ⇒ NOT rejected", () => {
    expect(
      webEvidenceRejectionReason({
        quote: "q",
        claim: "c",
        source: "code",
        locator: "repo/File.ts",
        revision: "abc123",
      }),
    ).toBeNull();
  });
});

describe("isContentFingerprint: hex + sha-family length", () => {
  it("empty ⇒ false", () => {
    expect(isContentFingerprint("")).toBe(false);
  });
  it("date / url / 'latest' ⇒ false", () => {
    expect(isContentFingerprint("2026-04-13")).toBe(false);
    expect(isContentFingerprint("https://example.com")).toBe(false);
    expect(isContentFingerprint("latest")).toBe(false);
  });
  it("sha256 (64 hex) / sha1 (40 hex) / md5 (32 hex) ⇒ true", () => {
    expect(isContentFingerprint("a".repeat(64))).toBe(true);
    expect(isContentFingerprint("a".repeat(40))).toBe(true);
    expect(isContentFingerprint("a".repeat(32))).toBe(true);
  });
  it("non-hex string of length 64 ⇒ false", () => {
    expect(isContentFingerprint("z".repeat(64))).toBe(false);
  });
});

describe("E2b §1.3 ⭐: harvestCard rejects live-URL evidence item-level (no whole-card veto)", () => {
  it("one bad web evidence + one compliant evidence ⇒ bad NOT published, good published, card still CAS-explored", async () => {
    // 真机实证形态：一条 source=web、locator=https://…、revision="" 的活 URL evidence，
    // 同卡另一条合规 evidence（code://、非空 revision）。
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({
          run_id: "run-1",
          evidences: [
            {
              quote: "0.16.0 — 2026-04-13",
              claim: "live url quote",
              source: "web",
              locator: "https://ziglang.org/download/",
              revision: "",
            },
            {
              quote: "static quote",
              claim: "compliant",
              source: "code",
              locator: "repo/File.ts",
              revision: "abc123",
            },
          ],
          proposed_clues: [],
          materials: [],
        }),
      ),
    });
    const report = await harvestCard(hd, HARVEST_CARD, "run-1", makeBudget(5));
    // ⛔ 判别性（§1.3）：活 URL evidence 不发布。
    expect(hd.publishEvidence).toHaveBeenCalledTimes(1);
    expect(report.evidencePublished).toBe(1);
    // ⛔ 拒发记录存在：含 clue_id 与失败判据，不含 quote 全文。
    expect(report.evidenceRejections).toHaveLength(1);
    const rej = report.evidenceRejections[0];
    expect(rej.clueId).toBe("card_x");
    expect(rej.index).toBe(0);
    expect(typeof rej.reason).toBe("string");
    expect(rej.reason.length).toBeGreaterThan(0);
    expect(JSON.stringify(rej)).not.toContain("0.16.0 — 2026-04-13");
    // ⛔ 不连坐：同卡合规 evidence 照常发布，整卡照常可 CAS explored。
    expect(report.casExplored).toBe(true);
    expect(report.skipped).toBe(false);
  });

  it("DISCRIMINATING: removing the rejection (all compliant) ⇒ 2 evidence published, 0 rejections", async () => {
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({
          run_id: "run-1",
          evidences: [
            { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
            { quote: "q2", claim: "c2", source: "wiki", locator: "P", revision: "v" },
          ],
          proposed_clues: [],
          materials: [],
        }),
      ),
    });
    const report = await harvestCard(hd, HARVEST_CARD, "run-1", makeBudget(5));
    expect(report.evidencePublished).toBe(2);
    expect(report.evidenceRejections).toHaveLength(0);
  });
});

describe("E2b §1.3 ⭐ (runWrite): live-URL web evidence not on bus; rejection recorded", () => {
  it("web evidence with bare URL + empty revision ⇒ not published, rejection in harvestReports", async () => {
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({
          run_id: "run-1",
          evidences: [
            {
              quote: "live quote",
              claim: "live claim",
              source: "web",
              locator: "https://example.com/page",
              revision: "",
            },
            { quote: "q2", claim: "c2", source: "code", locator: "a", revision: "r" },
          ],
          proposed_clues: [],
          materials: [],
        }),
      ),
    });
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [HARVEST_DECISION], 10);
    // ⛔ 判别性：活 URL evidence 不上 bus；只有 1 条合规 evidence 发布。
    expect(hd.publishEvidence).toHaveBeenCalledTimes(1);
    expect(result.harvestReports).toHaveLength(1);
    expect(result.harvestReports[0].evidencePublished).toBe(1);
    expect(result.harvestReports[0].evidenceRejections).toHaveLength(1);
    // 拒发记录点名 clue_id 与判据；不回抄 quote。
    const rej = result.harvestReports[0].evidenceRejections[0];
    expect(rej.clueId).toBe("card_x");
    expect(rej.locatorShape).toBe("http-url");
    expect(rej.revisionShape).toBe("empty");
    expect(JSON.stringify(result.harvestReports[0].evidenceRejections)).not.toContain("live quote");
    // 活性：同卡合规 evidence 照常发布，整卡 CAS explored。
    expect(result.casResults.some((c) => c.to === "explored")).toBe(true);
  });
});

// ── E1 D3/D9（runWrite 生产装配链 harvestCard）：content-clue 封顶可观测 + 判别 ──
// ⛔ spec §2 判据 9 + 评审 blocker：原实现把封顶埋在生产装配的 proposeContentClue 里，
//    且 harvest 无法区分「封顶 null」与「D2 复用 null」——两者都被 `if (clue)` 静默丢弃，
//    删除生产封顶检查整套测试仍绿。本组直接驱动真实的 harvestCard（生产收割逻辑），
//    断言封顶走 skippedContentClues（与 skippedClues 同构）、ingestMaterial 零调用。

describe("E1 D9 ⭐ (runWrite/harvestCard): content-clue cap is observable + discriminative", () => {
  it("board at maxClues ⇒ ingestMaterial never called, skippedContentClues === material count, content-clue not published", async () => {
    const ingest = vi.fn(async () => ({ status: "proposed", sources: ["content"] } as ClueV2));
    const hd = harvestDeps({
      boardClueCount: { value: 64 },
      maxClues: 64,
      ingestMaterial: ingest,
    });
    const deps = writeDeps(hd);
    const result = await runWrite(deps, [HARVEST_DECISION], 20);
    expect(ingest).toHaveBeenCalledTimes(0);
    expect(result.harvestReports[0].skippedContentClues).toBe(1);
    expect(result.harvestReports[0].contentCluesPublished).toBe(0);
    // 活性：evidence 照发 + CAS（封顶不阻断收割终态）。
    expect(hd.publishEvidence).toHaveBeenCalledTimes(2);
    expect(result.casResults.some((c) => c.to === "explored")).toBe(true);
  });

  it("⭐ DISCRIMINATING: board below cap ⇒ ingestMaterial IS called, skippedContentClues === 0 (deleting the cap guard would still pass this; the red signal is the test above)", async () => {
    // 这一条与上一条成对：封顶存在 ⇒ 上一条 ingest=0、本条 ingest=1；
    // 若删掉 harvest 的封顶守卫，上一条会变成 ingest=1（红）。本条保证活性（不封顶时正常 ingest）。
    const ingest = vi.fn(async () => ({ status: "proposed", sources: ["content"] } as ClueV2));
    const hd = harvestDeps({
      boardClueCount: { value: 0 },
      maxClues: 64,
      ingestMaterial: ingest,
    });
    const result = await runWrite(writeDeps(hd), [HARVEST_DECISION], 20);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(result.harvestReports[0].skippedContentClues).toBe(0);
    expect(result.harvestReports[0].contentCluesPublished).toBe(1);
  });

  it("D9 vs D2 distinction: D2 reuse returns null but is NOT counted as skippedContentClues (only cap is)", async () => {
    // D2 复用 ⇒ ingestMaterial 返回 null（幂等静默），不计 skippedContentClues；
    // 封顶 ⇒ 根本不调 ingestMaterial，计 skippedContentClues。两者形态不同（评审 blocker #2）。
    const ingest = vi.fn(async () => null);
    const hd = harvestDeps({
      boardClueCount: { value: 0 },
      maxClues: 64,
      ingestMaterial: ingest,
    });
    const result = await runWrite(writeDeps(hd), [HARVEST_DECISION], 20);
    expect(ingest).toHaveBeenCalledTimes(1);
    expect(result.harvestReports[0].contentCluesPublished).toBe(0);
    expect(result.harvestReports[0].skippedContentClues).toBe(0);
  });
});

// ── E1 D3/D7（runWrite 生产装配链）：materials:[] 回归 + 串行化经生产 dep ──

describe("E1 D3 ⭐ (runWrite/harvestCard): materials:[] ⇒ ingest zero calls, writes identical to no-ingest base", () => {
  it("materials:[] ⇒ ingestMaterial called 0 times, writes === baseline (no ingest dep wired)", async () => {
    const ingest = vi.fn(async () => ({ status: "proposed" } as ClueV2));
    // 带 ingest dep 但 materials 为空数组。
    const hdEmpty = harvestDeps({
      ingestMaterial: ingest,
      readWorkerResult: vi.fn(async () => ({
        run_id: "run-1",
        evidences: [
          { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
        ],
        proposed_clues: [{ clue: "i1" }],
        materials: [],
      })),
    });
    const resultEmpty = await runWrite(writeDeps(hdEmpty), [HARVEST_DECISION], 20);
    expect(ingest).toHaveBeenCalledTimes(0);
    expect(resultEmpty.harvestReports[0].contentCluesPublished).toBe(0);
    expect(resultEmpty.harvestReports[0].skippedContentClues).toBe(0);

    // 基线：不带 ingest dep（与 base GT-2 行为逐字一致）。
    const hdBase = harvestDeps({
      readWorkerResult: vi.fn(async () => ({
        run_id: "run-1",
        evidences: [
          { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
        ],
        proposed_clues: [{ clue: "i1" }],
        materials: [],
      })),
    });
    const resultBase = await runWrite(writeDeps(hdBase), [HARVEST_DECISION], 20);
    // ⛔ bus 写入次数逐字一致（materials:[] 不多写一次 bus）。
    expect(resultEmpty.writes).toBe(resultBase.writes);
    expect(resultEmpty.writes).toBe(3); // 1 evidence + 1 clue + 1 CAS
  });
});

// ── E1 D3/D1/D2/D4/D5/D7/D9（runChannelWrite 全生产装配链）──
// ⛔ spec §2 判据 10：断言必须打在生产组装出的 deps 上。本组通过 runChannelWrite
//    驱动真实装配（readExistingTranscript→research:content / transcribe→MinerU fileParse /
//    publishDoc→content channel / proposeContentClue→board），桩只停在 fetch（网络边界）。
//    成功路径（fetch → 权威 digest → publishDoc → propose content-clue）首次被真正走通。

describe("E1 production assembly (runChannelWrite): full ingest success path", () => {
  // 构造一张 in_flight 卡 + exited(0) run + worker.result.v1（含一条 material），
  // 桩 fetch 同时服务：entities head / 各 channel 的 messages 分页 / publish /
  // material HTTP 下载（arrayBuffer）/ MinerU /file_parse（CPU 图片路径）。
  function setupBoard(opts: {
    materials: Array<{ uri: string; digest?: string }>;
    materialBytes?: Uint8Array;
    materialFilename?: string;
    minerUMd?: string;
    existingContentDocs?: unknown[];
    proposedClues?: Array<{ clue: string }>;
    evidenceItems?: Array<{ quote: string; claim: string; source: string; locator: string; revision: string }>;
    maxClues?: number;
  }) {
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
          evidences: opts.evidenceItems ?? [
            { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
          ],
          proposed_clues: opts.proposedClues ?? [],
          materials: opts.materials,
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
    let boardCalls = 0;
    let runsCalls = 0;
    let contentCalls = 0;
    const materialBytes = opts.materialBytes ?? new Uint8Array([1, 2, 3, 4, 5]);
    const materialFilename = opts.materialFilename ?? "a.png";
    const minerUMd = opts.minerUMd ?? "# transcribed";
    const existingContentDocs = opts.existingContentDocs ?? [];
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
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
        boardCalls += 1;
        return jsonResponse({ messages: boardCalls === 1 ? [inFlightMsg] : [] });
      }
      if (u.includes("/v1/channels/board:agent-runs/messages")) {
        runsCalls += 1;
        return jsonResponse({ messages: runsCalls === 1 ? runsMessages : [] });
      }
      if (u.includes("/v1/channels/research:content/messages")) {
        contentCalls += 1;
        return jsonResponse({ messages: contentCalls === 1 ? existingContentDocs : [] });
      }
      // material HTTP 下载（fetchMaterialHttp）：返回带 arrayBuffer 的响应。
      if (u.includes("://material.example.com/")) {
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            materialBytes.buffer.slice(
              materialBytes.byteOffset,
              materialBytes.byteOffset + materialBytes.byteLength,
            ),
        };
      }
      // MinerU /file_parse（CPU 图片路径）。
      if (u.includes("/file_parse")) {
        const form = init?.body as FormData;
        const fname = form?.get("files") instanceof File
          ? (form.get("files") as File).name
          : materialFilename;
        const key = fname.includes(".") ? fname.slice(0, fname.lastIndexOf(".")) : fname;
        return jsonResponse({
          task_id: "t",
          status: "completed",
          backend: "pipeline",
          results: { [key]: { md_content: minerUMd } },
        });
      }
      return jsonResponse({ messages: [] });
    });
    return {
      fetchMock,
      publishBodies,
      inFlightMsg,
      runsMessages,
      run: () =>
        runChannelWrite({
          channelId: WIRE_CHANNEL,
          evidenceChannelId: "research:p02-smoke-1dce60.evidence",
          ...(opts.maxClues !== undefined ? { maxClues: opts.maxClues } : {}),
        }),
    };
  }

  it("⭐ D3: one material ⇒ doc(transcript) published on research:content with doc_kind=transcript, origin=source URI", async () => {
    const ctx = setupBoard({
      materials: [{ uri: "http://material.example.com/a.png" }],
      materialBytes: new Uint8Array([10, 20, 30, 40]),
      materialFilename: "a.png",
    });
    vi.stubGlobal("fetch", ctx.fetchMock);
    const outcome = await ctx.run();
    const docPubs = ctx.publishBodies.filter(
      (b) => b.kind === "research.doc.v2" && b.channel === "research:content",
    );
    expect(docPubs).toHaveLength(1);
    const doc = docPubs[0].payload as Record<string, unknown>;
    expect(doc.doc_kind).toBe("transcript");
    expect(doc.origin).toBe("http://material.example.com/a.png");
    // D1：digest 是对取回字节的 sha256（权威），不是 worker 上报值。
    const expectedDigest = createHash("sha256")
      .update(new Uint8Array([10, 20, 30, 40]))
      .digest("hex");
    expect(doc.digest).toBe(expectedDigest);
    expect(outcome.harvestReports[0].contentCluesPublished).toBe(1);
  });

  it("⭐ D1 DISCRIMINATING (production): worker reports a fake digest ⇒ published doc.digest === sha256(bytes), not the fake value", async () => {
    const fakeDigest = "f00d".repeat(16);
    const bytes = new Uint8Array([99, 98, 97]);
    const expectedDigest = createHash("sha256").update(bytes).digest("hex");
    expect(fakeDigest).not.toBe(expectedDigest);
    const ctx = setupBoard({
      materials: [{ uri: "http://material.example.com/a.png", digest: fakeDigest }],
      materialBytes: bytes,
    });
    vi.stubGlobal("fetch", ctx.fetchMock);
    await ctx.run();
    const docPubs = ctx.publishBodies.filter(
      (b) => b.kind === "research.doc.v2" && b.channel === "research:content",
    );
    expect(docPubs).toHaveLength(1);
    expect(docPubs[0].payload.digest).toBe(expectedDigest);
    expect(docPubs[0].payload.digest).not.toBe(fakeDigest);
  });

  it("⭐⭐ D2 DISCRIMINATING (production): same bytes already on research:content ⇒ MinerU not called, existing doc reused, no new doc publish", async () => {
    const bytes = new Uint8Array([7, 7, 7]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const existingDoc = {
      message_id: "existing_doc",
      channel_id: "research:content",
      channel_seq: 1,
      kind: "research.doc.v2",
      payload: {
        doc_kind: "transcript",
        digest,
        body: "already-here",
        origin: "http://material.example.com/a.png",
      },
      entity_id: "doc_existing",
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    let minerCalls = 0;
    const ctx = setupBoard({
      materials: [{ uri: "http://material.example.com/a.png", digest: "different-worker-hint" }],
      materialBytes: bytes,
      existingContentDocs: [existingDoc],
    });
    // 包装 fetchMock 以计数 MinerU 调用。
    const inner = ctx.fetchMock;
    const countingFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/file_parse")) minerCalls += 1;
      return inner(url, init);
    });
    vi.stubGlobal("fetch", countingFetch);
    await ctx.run();
    expect(minerCalls).toBe(0);
    const docPubs = ctx.publishBodies.filter(
      (b) => b.kind === "research.doc.v2" && b.channel === "research:content",
    );
    expect(docPubs).toHaveLength(0);
  });

  it("⭐ D4 (production): success ⇒ content-clue on board with sources=['content'], parent=card, depth=parent.depth, text has digest+URI", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const ctx = setupBoard({
      materials: [{ uri: "http://material.example.com/a.png" }],
      materialBytes: bytes,
    });
    vi.stubGlobal("fetch", ctx.fetchMock);
    const outcome = await ctx.run();
    const card = outcome.harvestReports[0];
    // depth = parent depth（卡 depth=0），⛔ 不是 +1。
    expect(card.clueId).toBe("card_x");
    const contentClues = ctx.publishBodies.filter(
      (b) =>
        b.kind === "research.clue.v2"
        && b.channel === WIRE_CHANNEL
        && (b.payload as Record<string, unknown>).status !== "explored"
        && ((b.payload as Record<string, unknown>).sources as string[]).includes("content"),
    );
    expect(contentClues).toHaveLength(1);
    const clue = contentClues[0].payload as Record<string, unknown>;
    expect(clue.sources).toEqual(["content"]);
    expect(clue.parent).toBe("card_x");
    expect(clue.depth).toBe(0);
    expect(clue.status).toBe("proposed");
    expect(clue.text).toContain(digest);
    expect(clue.text).toContain("http://material.example.com/a.png");
  });

  it("⭐ D5 (production): second material with same digest ⇒ no second doc, no second content-clue (idempotent)", async () => {
    // 两条 material 字节相同。第一条：content channel 空 → 发 doc + content-clue。
    // 桩把第一条发布的 doc 反映回 content channel 的扫描结果，使第二条 readExistingTranscript
    // 命中复用 → 不发 doc、不发 content-clue（D5 幂等）。
    const bytes = new Uint8Array([5, 5, 5]);
    const digest = createHash("sha256").update(bytes).digest("hex");
    const publishedDocs: Array<{
      message_id: string;
      channel_id: string;
      channel_seq: number;
      kind: string;
      payload: unknown;
      entity_id: string;
      supersedes: string | null;
      created_at: string;
    }> = [];
    const ctx = setupBoard({
      materials: [
        { uri: "http://material.example.com/a.png" },
        { uri: "http://material.example.com/a.png" },
      ],
      materialBytes: bytes,
    });
    const inner = ctx.fetchMock;
    const reflectingFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      // 把对 content channel 的发布反映到后续 scan。
      if (/\/v1\/channels\/research:content\/publish/.test(u)) {
        const body = JSON.parse(String(init?.body));
        publishedDocs.push({
          message_id: `ref_${publishedDocs.length}`,
          channel_id: "research:content",
          channel_seq: publishedDocs.length + 1,
          kind: "research.doc.v2",
          payload: body.payload,
          entity_id: `ref_${publishedDocs.length}`,
          supersedes: null,
          created_at: "2026-01-01T00:00:00Z",
        });
      }
      const resp = await inner(url, init);
      return resp;
    });
    // 再包一层：让 content channel 的 messages scan 返回已发布的 doc（第二次扫到）。
    const finalFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/v1/channels/research:content/messages")) {
        const hasAfterSeq = /[?&]after_seq=/.test(u);
        return jsonResponse({ messages: hasAfterSeq ? [] : [...publishedDocs] });
      }
      return reflectingFetch(url, init);
    });
    vi.stubGlobal("fetch", finalFetch);
    await ctx.run();
    const docPubs = ctx.publishBodies.filter(
      (b) => b.kind === "research.doc.v2" && b.channel === "research:content",
    );
    expect(docPubs).toHaveLength(1);
    expect(docPubs[0].payload.digest).toBe(digest);
    const contentClues = ctx.publishBodies.filter(
      (b) =>
        b.kind === "research.clue.v2"
        && b.channel === WIRE_CHANNEL
        && (b.payload as Record<string, unknown>).status !== "explored"
        && ((b.payload as Record<string, unknown>).sources as string[]).includes("content"),
    );
    expect(contentClues).toHaveLength(1);
  });

  it("⭐ D9 (production assembly): board at maxClues ⇒ content-clue not published, skippedContentClues > 0, ingest skipped", async () => {
    // maxClues=1，卡带 1 条 proposed_clue + 1 条 material。普通 clue 先发（board=1=cap），
    // 随后 material 因封顶被跳过：不发 doc、不发 content-clue，skippedContentClues=1。
    const ctx = setupBoard({
      materials: [{ uri: "http://material.example.com/a.png" }],
      proposedClues: [{ clue: "takes-the-only-slot" }],
      maxClues: 1,
    });
    let minerCalls = 0;
    const inner = ctx.fetchMock;
    const countingFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      if (String(url).includes("/file_parse")) minerCalls += 1;
      return inner(url, init);
    });
    vi.stubGlobal("fetch", countingFetch);
    const outcome = await ctx.run();
    expect(minerCalls).toBe(0);
    const report = outcome.harvestReports[0];
    expect(report.skippedContentClues).toBe(1);
    expect(report.contentCluesPublished).toBe(0);
    const contentClues = ctx.publishBodies.filter(
      (b) =>
        (b.payload as Record<string, unknown>).sources
        && ((b.payload as Record<string, unknown>).sources as string[]).includes("content"),
    );
    expect(contentClues).toHaveLength(0);
    // 活性：普通 clue 占了唯一的 cap 槽，CAS 仍发生（板上出现 explored 状态的 card_x）。
    const exploredPubs2 = ctx.publishBodies.filter(
      (b) => (b.payload as Record<string, unknown>).status === "explored",
    );
    expect(exploredPubs2.length).toBeGreaterThanOrEqual(1);
  });

  it("⭐ D7 (production assembly): N materials through the shipped dep keep MinerU in-flight <= 1 (shared mutex + sequential harvest)", async () => {
    // 生产装配链把本 tick 共享的 createMutex 注入 ingestMaterialImpl（评审 major #6）。
    // harvest 的 for-loop 顺序 await + 共享 mutex 双重保证 in-flight=1。三条 material 字节
    // 各异（dedup 全不命中）⇒ 三条都打 MinerU；用计数器观测峰值并发 <= 1。
    let inFlight = 0;
    let maxInFlight = 0;
    let minerCalls = 0;
    const ctx = setupBoard({
      materials: [
        { uri: "http://material.example.com/a.png" },
        { uri: "http://material.example.com/b.png" },
        { uri: "http://material.example.com/c.png" },
      ],
      materialBytes: new Uint8Array([1]),
      materialFilename: "x.png",
    });
    const inner = ctx.fetchMock;
    const concurrencyFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("://material.example.com/")) {
        // 按 URI 末段派生不同字节，保证 digest 各异、dedup 全不命中。
        const seg = u.split("/").pop() ?? "x";
        const code = seg.charCodeAt(0);
        const buf = new Uint8Array([code, code + 1, code + 2]);
        return {
          ok: true,
          status: 200,
          arrayBuffer: async () =>
            buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
        };
      }
      if (u.includes("/file_parse")) {
        minerCalls += 1;
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        try {
          // 让 MinerU 调用异步地 yield 一次，给并发可观测窗口。
          await new Promise((r) => setTimeout(r, 5));
          return jsonResponse({
            status: "completed",
            results: { x: { md_content: "md" } },
          });
        } finally {
          inFlight -= 1;
        }
      }
      return inner(url, init);
    });
    vi.stubGlobal("fetch", concurrencyFetch);
    await ctx.run();
    expect(minerCalls).toBe(3);
    expect(maxInFlight).toBeLessThanOrEqual(1);
  });

  it("⭐ D6 (production assembly): MinerU fails ⇒ content-clue born blocked on board, parent still explored, evidence still published", async () => {
    const ctx = setupBoard({
      materials: [{ uri: "http://material.example.com/a.png" }],
      evidenceItems: [
        { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
      ],
    });
    const inner = ctx.fetchMock;
    const failingFetch = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/file_parse")) {
        return jsonResponse({ status: "failed", error: "cannot identify image file" });
      }
      return inner(url, init);
    });
    vi.stubGlobal("fetch", failingFetch);
    const outcome = await ctx.run();
    const report = outcome.harvestReports[0];
    // (a) content-clue 出生即 blocked。
    expect(report.contentCluesPublished).toBe(1);
    expect(report.contentCluesBlocked).toBe(1);
    const contentClues = ctx.publishBodies.filter(
      (b) =>
        b.kind === "research.clue.v2"
        && ((b.payload as Record<string, unknown>).sources as string[] | undefined)?.includes(
          "content",
        ),
    );
    expect(contentClues).toHaveLength(1);
    expect((contentClues[0].payload as Record<string, unknown>).status).toBe("blocked");
    expect(
      String((contentClues[0].payload as Record<string, unknown>).rationale),
    ).toContain("status=failed");
    // (b) 父 clue 仍 explored（板上出现 explored 状态的 card_x）。
    const exploredPubs3 = ctx.publishBodies.filter(
      (b) => (b.payload as Record<string, unknown>).status === "explored",
    );
    expect(exploredPubs3.length).toBeGreaterThanOrEqual(1);
    // (c) evidence 照常发布。
    const evidencePubs = ctx.publishBodies.filter((b) => b.kind === "research.evidence.v2");
    expect(evidencePubs).toHaveLength(1);
  });
});
// ── E1c D4 ⭐⭐：驱动 harvestCard，断言 **publishEvidence 实际收到的** anchor ──────
//    ⛔ spec §2 判据 5：只断言 composeAnchor / anchorForEvidence 的返回值**不算**交付。
//    这里驱动生产收割函数 harvestCard，从 publishEvidence 的捕获参数里取 anchor。

describe("E1c D4 ⭐⭐ (harvestCard): the anchor handed to publishEvidence, not composeAnchor's return", () => {
  /** 一张 content 卡 + 一条 worker 回报 ⇒ 收割一次，返回 publishEvidence 捕获到的 evidence。 */
  async function harvestOne(report: Record<string, unknown>) {
    const captured: EvidenceV2[] = [];
    const hd = harvestDeps({
      publishEvidence: vi.fn(async (_channel, evidence) => {
        captured.push(evidence);
      }),
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({
          run_id: "run-c",
          evidences: [report],
          proposed_clues: [],
          materials: [],
        }),
      ),
    });
    const result = await harvestCard(hd, CONTENT_CARD, "run-c", makeBudget(5));
    return { captured, result, hd };
  }

  it("⭐⭐ D4/D1 discriminating: report A ⇒ publishEvidence receives the authoritative anchor", async () => {
    const { captured, result } = await harvestOne(WORKER_REPORT_A);
    expect(captured).toHaveLength(1);
    // ⛔ 从捕获参数取 anchor（不是从 composeAnchor 的返回值）。
    expect(captured[0].anchor).toBe(EXPECTED_ANCHOR);
    expect(captured[0].clue_id).toBe("card_content");
    expect(result.evidencePublished).toBe(1);
    expect(result.casExplored).toBe(true);
  });

  it("⭐⭐ D4/D1 discriminating: report B (worker invents locator/revision) ⇒ SAME authoritative anchor on the wire", async () => {
    const { captured, result } = await harvestOne(WORKER_REPORT_B);
    expect(captured).toHaveLength(1);
    // 判据 2：把 <uri>@<digest> 改回取 worker 的 locator/revision ⇒ 本条必变红。
    expect(captured[0].anchor).toBe(EXPECTED_ANCHOR);
    expect(captured[0].anchor).not.toContain("content://");
    expect(captured[0].anchor).not.toContain(".md");
    // D2：证据**照常发布**（⛔ 不因不一致拒发整条）。
    expect(result.evidencePublished).toBe(1);
    expect(result.evidenceRejections).toHaveLength(0);
  });

  it("⭐⭐ D4/D1 discriminating: report C (bare URI + L3:1-43) ⇒ authoritative uri@digest, range verbatim", async () => {
    const { captured } = await harvestOne(WORKER_REPORT_C);
    expect(captured).toHaveLength(1);
    expect(captured[0].anchor).toBe(`web://${AUTH_URI}@${AUTH_DIGEST}#L3:1-43`);
  });

  it("⭐ D2 discriminating: report B ⇒ an observable mismatch record (clue_id + both sides, no quote)", async () => {
    const { result } = await harvestOne(WORKER_REPORT_B);
    expect(result.anchorMismatches).toHaveLength(1);
    const m = result.anchorMismatches[0];
    expect(m.clueId).toBe("card_content");
    expect(m.index).toBe(0);
    expect(m.workerLocator).toBe("63ac13abaabf5726.md");
    expect(m.workerRevision).toBe("63ac13abaabf5726");
    expect(m.authoritativeUri).toBe(AUTH_URI);
    expect(m.authoritativeDigest).toBe(AUTH_DIGEST);
    // ⛔ 不含 quote 全文。
    expect(JSON.stringify(result.anchorMismatches)).not.toContain(WORKER_REPORT_B.quote);
  });

  it("⭐ D2 discriminating (pair): report A ⇒ NO mismatch record (both sides agree)", async () => {
    const { result } = await harvestOne(WORKER_REPORT_A);
    expect(result.anchorMismatches).toHaveLength(0);
    // 活性：证据照发（不因"无不一致"而漏发）。
    expect(result.evidencePublished).toBe(1);
  });

  it("⭐ D2b discriminating (harvestCard): range '9' and 'L9' ⇒ the anchor on the wire ends with #L9 both times", async () => {
    const withoutL = await harvestOne({ ...WORKER_REPORT_A, range: "9" });
    const withL = await harvestOne({ ...WORKER_REPORT_A, range: "L9" });
    expect(withoutL.captured[0].anchor.endsWith("#L9")).toBe(true);
    expect(withL.captured[0].anchor.endsWith("#L9")).toBe(true);
    expect(withoutL.captured[0].anchor).toBe(withL.captured[0].anchor);
  });

  it("⭐ D1 safety: content evidence on a card WITHOUT authority ⇒ item-level rejection, no malformed anchor published", async () => {
    // 卡不是 content-clue（text 非 web://<uri>@<digest>）⇒ 无从拼可核验锚点。
    const captured: EvidenceV2[] = [];
    const hd = harvestDeps({
      publishEvidence: vi.fn(async (_c, evidence) => {
        captured.push(evidence);
      }),
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({
          run_id: "run-c",
          evidences: [
            WORKER_REPORT_A,
            { quote: "q2", claim: "c2", source: "code", locator: "a", revision: "r" },
          ],
          proposed_clues: [],
          materials: [],
        }),
      ),
    });
    const result = await harvestCard(
      hd,
      { clueId: "card_x", text: "investigate X", depth: 0, sources: ["code-local"] },
      "run-c",
      makeBudget(5),
    );
    // ⛔ 绝不落 content://<worker locator>@<worker revision> 这种畸形锚点。
    expect(captured.every((e) => !e.anchor.startsWith("content://"))).toBe(true);
    expect(result.evidenceRejections).toHaveLength(1);
    expect(result.evidenceRejections[0].clueId).toBe("card_x");
    // ⛔ 条目级：同卡合规 evidence 照常发布，整卡照常 CAS explored（不连坐）。
    expect(result.evidencePublished).toBe(1);
    expect(captured[0].anchor).toBe("code://a@r");
    expect(result.casExplored).toBe(true);
  });
});

// ── E1c D1/D4 ⭐⭐（runChannelWrite 全生产装配链）：真正上 bus 的 anchor ──────────
//    ⛔ spec §2 判据 7：断言打在**生产组装出的 deps** 上（realCas / publishEvidence / 真实
//    readWorkerResult），桩只停在 fetch（网络边界）。这里读的是 publish 请求体里的
//    payload.anchor —— 即实际落到证据 channel 上的那个值。

describe("E1c D1/D4 ⭐⭐ (production assembly): the anchor that actually lands on the evidence channel", () => {
  const EVIDENCE_CHANNEL = "research:p02-smoke-1dce60.evidence";

  function setupContentBoard(evidences: Array<Record<string, unknown>>) {
    const inFlightMsg = {
      message_id: "msg_clue_content",
      channel_id: WIRE_CHANNEL,
      channel_seq: 1,
      kind: "research.clue.v2",
      // 调度器侧的 content-clue：sources=["content"]、text 携带 web://<uri>@<digest>（E1b D3）。
      payload: {
        status: "in_flight",
        text: CONTENT_CLUE_TEXT,
        depth: 0,
        sources: ["content"],
        run_id: "run-c",
      },
      entity_id: "card_content",
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const runsMessages = [
      {
        message_id: "run_exit",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.exited.v1",
        payload: { run_id: "run-c", exit_code: 0 },
        entity_id: "run-c",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        message_id: "result_c",
        channel_id: "board:agent-runs",
        channel_seq: 2,
        kind: "worker.result.v1",
        payload: {
          run_id: "run-c",
          evidences,
          proposed_clues: [],
          materials: [],
        },
        entity_id: "run-c",
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
    let boardCalls = 0;
    let runsCalls = 0;
    const fetchMock = vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/entities/")) return jsonResponse({ head: inFlightMsg });
      const pm = /\/v1\/channels\/([^/]+)\/publish/.exec(u);
      if (pm) {
        const body = JSON.parse(String(init?.body));
        publishBodies.push({ channel: decodeURIComponent(pm[1]), ...body });
        return jsonResponse({ message_id: `p_${publishBodies.length}`, channel_seq: 99 });
      }
      if (u.includes(`/v1/channels/${WIRE_CHANNEL}/messages`)) {
        boardCalls += 1;
        return jsonResponse({ messages: boardCalls === 1 ? [inFlightMsg] : [] });
      }
      if (u.includes("/v1/channels/board:agent-runs/messages")) {
        runsCalls += 1;
        return jsonResponse({ messages: runsCalls === 1 ? runsMessages : [] });
      }
      return jsonResponse({ messages: [] });
    });
    return {
      fetchMock,
      publishBodies,
      /** 实际发到证据 channel 的 evidence（anchor 取自 publish 请求体）。 */
      evidenceAnchors: () =>
        publishBodies
          .filter((b) => b.kind === "research.evidence.v2" && b.channel === EVIDENCE_CHANNEL)
          .map((b) => String(b.payload.anchor)),
      run: () =>
        runChannelWrite({ channelId: WIRE_CHANNEL, evidenceChannelId: EVIDENCE_CHANNEL }),
    };
  }

  it("⭐⭐ D1 discriminating (judgment criterion 2): reports A, B and C ⇒ authoritative anchors on the bus", async () => {
    const ctx = setupContentBoard([WORKER_REPORT_A, WORKER_REPORT_B, WORKER_REPORT_C]);
    vi.stubGlobal("fetch", ctx.fetchMock);
    const outcome = await ctx.run();
    const anchors = ctx.evidenceAnchors();
    expect(anchors).toHaveLength(3);
    // 判据 2：A 与 B 产出**同一个**权威 anchor；C 保留自己的 range。
    expect(anchors[0]).toBe(EXPECTED_ANCHOR);
    expect(anchors[1]).toBe(EXPECTED_ANCHOR);
    expect(anchors[2]).toBe(`web://${AUTH_URI}@${AUTH_DIGEST}#L3:1-43`);
    // ⛔ 判据 2：出现 content:// / .md / 截断 16 位 digest 任一即方向钉反。
    for (const a of anchors) {
      expect(a).not.toContain("content://");
      expect(a).not.toContain(".md");
      expect(a).not.toContain(`@63ac13abaabf5726#`);
      expect(a.startsWith(`web://${AUTH_URI}@${AUTH_DIGEST}`)).toBe(true);
    }
    // 活性：三条都发布了，卡照常 CAS explored。
    expect(outcome.harvestReports[0].evidencePublished).toBe(3);
    expect(outcome.harvestReports[0].evidenceRejections).toHaveLength(0);
    expect(
      ctx.publishBodies.some((b) => b.payload.status === "explored"),
    ).toBe(true);
  });

  it("⭐ D2 discriminating (production): report B ⇒ published AND a mismatch record in the run report", async () => {
    const ctx = setupContentBoard([WORKER_REPORT_B]);
    vi.stubGlobal("fetch", ctx.fetchMock);
    const outcome = await ctx.run();
    // 证据照常发布，anchor 是权威形态。
    expect(ctx.evidenceAnchors()).toEqual([EXPECTED_ANCHOR]);
    // 同时产出一条可观测的不一致记录（含 clue_id 与两侧的值）。
    const mismatches = outcome.harvestReports[0].anchorMismatches;
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0].clueId).toBe("card_content");
    expect(mismatches[0].workerLocator).toBe("63ac13abaabf5726.md");
    expect(mismatches[0].authoritativeDigest).toBe(AUTH_DIGEST);
    // ⛔ 记录里不得回抄 quote 全文。
    expect(JSON.stringify(mismatches)).not.toContain(WORKER_REPORT_B.quote);
  });

  it("⭐ D2 discriminating (pair, production): report A ⇒ NO mismatch record", async () => {
    const ctx = setupContentBoard([WORKER_REPORT_A]);
    vi.stubGlobal("fetch", ctx.fetchMock);
    const outcome = await ctx.run();
    expect(ctx.evidenceAnchors()).toEqual([EXPECTED_ANCHOR]);
    expect(outcome.harvestReports[0].anchorMismatches).toHaveLength(0);
  });
});
