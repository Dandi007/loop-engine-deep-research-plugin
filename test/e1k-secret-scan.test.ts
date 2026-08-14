/**
 * E1k —— 证据发布前的**密钥形态扫描闸门**硬验收（canonical spec §13.1 / 本包 §2 判据 1–7）。
 *
 * ⚠️ 本线累计因「测试绕开被测对象」被驳回 10 次以上（spec §4）。⇒ 判据 2–5 的断言**一律**
 *    打在驱动 `harvestCard`（生产收割函数）后 `publishEvidence` **实际收到/未收到**的
 *    evidence 上，另配 `runChannelWrite` 全生产装配链（桩只停在 fetch 这个网络边界）的
 *    对照组：读的是 publish 请求体，即真正落到证据 channel 上的那个值。
 * ⛔ 不得只断言纯函数、⛔ 不得绕过装配链直接给扫描器传参、⛔ 源码字符串匹配不构成证据。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  harvestCard,
  SECRET_PATTERN_REJECTION_REASON,
  type HarvestBudget,
  type HarvestDeps,
} from "../src/harvest";
import {
  scanFieldForSecretPatterns,
  structuralAnchorDigestSpan,
  SECRET_PATTERN_AWS_ACCESS_KEY_ID,
  SECRET_PATTERN_GITHUB_TOKEN,
  SECRET_PATTERN_SLACK_BOT_TOKEN,
  SECRET_PATTERN_PRIVATE_KEY_BLOCK,
  SECRET_PATTERN_HIGH_ENTROPY,
} from "../src/secret-scan";
import { runChannelWrite } from "../src/tick-run";
import type { EvidenceV2 } from "../src/protocol";

const ROOT = dirname(fileURLToPath(import.meta.url));

/** ⛔ A10a B1 同纪律：夹具的顶层键从冻结 schema 读出，不手写。 */
function validWorkerResult(over: Record<string, unknown> = {}): Record<string, unknown> {
  const schema = JSON.parse(
    readFileSync(
      join(ROOT, "..", "profiles", "roles", "schemas", "worker-result.v1.json"),
      "utf8",
    ),
  ) as { required: string[] };
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

const EVIDENCE_CHANNEL = "research:p02-smoke-1dce60.evidence";
const WIRE_CHANNEL = "research:p02-smoke-1dce60";

/** 普通（非 content）卡：走 `<source>://<locator>@<revision>` 通用锚点模板。 */
const CODE_CARD = { clueId: "card_x", text: "investigate X", depth: 0, sources: ["code-local"] };

// ── §0 GT-4 逐字：本线**合法** anchor 天然含 64 位 sha256 / 40 位 commit sha ──────
// ⚠️ spec §4：这两条样本都是真机跑出来的，⛔ 不得改造它们去迁就实现。
const GT4_CONTENT_URI = "http://127.0.0.1:50287/e1-material5.png";
const GT4_CONTENT_DIGEST =
  "fc246f0aff9b5c82971135989a5ff0f770210c488466534d16b6220652c1cb9b";
const GT4_CONTENT_ANCHOR = `web://${GT4_CONTENT_URI}@${GT4_CONTENT_DIGEST}#L1`;
const GT4_CODE_REVISION = "efebe270bf1e1fe88af4b9d47fc155ed068645ab";
const GT4_CODE_ANCHOR = `code://src/dispatch.ts@${GT4_CODE_REVISION}#L1287`;

// ── 五类密钥形态的逐字夹具（spec §13.1 / §2 判据 3）────────────────────
const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GITHUB_TOKEN = "ghp_016c25f8b0a94b1d9e3f7a2c6d8e0f1a2b3c";
const SLACK_TOKEN = "xoxb-2401-2401-abcdefghijklmnop";
const PRIVATE_KEY = "-----BEGIN RSA PRIVATE KEY-----";
/** ≥40 字符连续 base64 高熵串（44 字符，香农熵 4.71 bit/char）。 */
const HIGH_ENTROPY_BLOB = "havxtl+lMTmhDQ5hS+kFPzWtQulSRz85MjmJw+EYFF0=";

function harvestDeps(over: Partial<HarvestDeps> = {}): HarvestDeps {
  return {
    evidenceChannelId: EVIDENCE_CHANNEL,
    boardChannelId: WIRE_CHANNEL,
    maxClues: 64,
    maxDepth: 3,
    boardClueCount: { value: 0 },
    readWorkerResult: vi.fn(async () => ({
      run_id: "run-1",
      evidences: [],
      proposed_clues: [],
      materials: [],
    })),
    publishEvidence: vi.fn(async () => {}),
    publishClue: vi.fn(async () => {}),
    ...over,
  };
}

/**
 * 驱动**生产收割函数** `harvestCard`，返回 `publishEvidence` 实际收到的 evidence。
 * ⛔ 判据 6：不得绕过装配链直接给扫描器传参。
 */
async function harvest(
  card: { clueId: string; text: string; depth: number; sources: string[] },
  evidences: Array<Record<string, unknown>>,
  extra: Partial<HarvestDeps> = {},
) {
  const captured: EvidenceV2[] = [];
  const keys: string[] = [];
  const hd = harvestDeps({
    publishEvidence: vi.fn(async (_channel, evidence, key) => {
      captured.push(evidence);
      keys.push(key);
    }),
    readWorkerResult: vi.fn(async () =>
      validWorkerResult({ run_id: "run-1", evidences, proposed_clues: [], materials: [] }),
    ),
    ...extra,
  });
  const report = await harvestCard(hd, card, "run-1", makeBudget(evidences.length + 8));
  return { captured, keys, report, hd };
}

// ══════════════════════════════════════════════════════════════════════════════
// 判据 2 ⭐⭐ K1 判别性 —— 一张卡两条 evidence，其一 quote 含 AKIA 形态
// ══════════════════════════════════════════════════════════════════════════════

describe("E1k 判据 2 ⭐⭐ K1 (harvestCard): a secret-shaped quote never reaches publishEvidence", () => {
  const dirtyQuote = `export const AWS_KEY = "${AWS_KEY}"; // rotate me`;

  async function k1() {
    return harvest(CODE_CARD, [
      { quote: dirtyQuote, claim: "the repo hard-codes an AWS key", source: "code", locator: "src/a.ts", revision: "r1" },
      { quote: "a perfectly ordinary verbatim quote", claim: "ordinary claim", source: "code", locator: "src/b.ts", revision: "r2" },
    ]);
  }

  it("(a) the AKIA evidence is NOT published; (b) the sibling on the SAME card still is", async () => {
    const { captured, report, hd } = await k1();
    // (a) ⛔ 判别性：把扫描删掉 ⇒ publishEvidence 会收到 2 条，本断言变红。
    expect(hd.publishEvidence).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect(captured[0].quote).toBe("a perfectly ordinary verbatim quote");
    // ⛔ 上 bus 的那条里根本没有密钥串。
    expect(JSON.stringify(captured)).not.toContain(AWS_KEY);
    // (b) 不连坐：同卡另一条照常发布，整卡照常可 CAS explored（与 E2b 条目级拒发同纪律）。
    expect(report.evidencePublished).toBe(1);
    expect(report.casExplored).toBe(true);
    expect(report.skipped).toBe(false);
  });

  it("(c) the run report carries an interception entry naming the pattern AND the field", async () => {
    const { report } = await k1();
    expect(report.secretScanRejections).toHaveLength(1);
    const rej = report.secretScanRejections[0];
    expect(rej.clueId).toBe("card_x");
    expect(rej.index).toBe(0);
    expect(rej.reason).toBe(SECRET_PATTERN_REJECTION_REASON);
    // 点名 pattern 名与字段名（D3）。
    expect(rej.patterns).toEqual([SECRET_PATTERN_AWS_ACCESS_KEY_ID]);
    expect(rej.fields).toEqual(["quote"]);
    expect(rej.hits).toEqual([
      { field: "quote", patterns: [SECRET_PATTERN_AWS_ACCESS_KEY_ID] },
    ]);
  });

  it("⭐ (d) DISCRIMINATING: the record contains NEITHER the matched secret NOR the quote body", async () => {
    const { report } = await k1();
    const serialized = JSON.stringify(report.secretScanRejections);
    // ⛔ 把记录改成回抄命中内容 ⇒ 以下断言变红（spec §2 判据 2(d)）。
    expect(serialized).not.toContain(AWS_KEY);
    expect(serialized).not.toContain("AKIA");
    expect(serialized).not.toContain(dirtyQuote);
    expect(serialized).not.toContain("rotate me");
    // 活性配对：记录本身非空且确实点了名（不是靠「什么都不记」骗过上面的安全性断言）。
    expect(serialized).toContain(SECRET_PATTERN_AWS_ACCESS_KEY_ID);
    expect(serialized).toContain("quote");
  });

  it("⭐ the OTHER card-level rejection channel is untouched (this is a distinct, parallel gate)", async () => {
    const { report } = await k1();
    // E2b 的活 URL 拒发与本包的密钥拒发并列，互不吞并（D5：并列同构）。
    expect(report.evidenceRejections).toHaveLength(0);
    expect(report.secretScanRejections).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 判据 3 ⭐ —— 五类规则各一条正向用例，各自点名对应 pattern
// ══════════════════════════════════════════════════════════════════════════════

describe("E1k 判据 3 ⭐ (harvestCard): each of the five §13.1 rule classes blocks and names itself", () => {
  const CASES: Array<{ label: string; secret: string; pattern: string }> = [
    { label: "AKIA[0-9A-Z]{16}", secret: AWS_KEY, pattern: SECRET_PATTERN_AWS_ACCESS_KEY_ID },
    { label: "ghp_[A-Za-z0-9]{36}", secret: GITHUB_TOKEN, pattern: SECRET_PATTERN_GITHUB_TOKEN },
    { label: "xoxb-", secret: SLACK_TOKEN, pattern: SECRET_PATTERN_SLACK_BOT_TOKEN },
    { label: "-----BEGIN RSA PRIVATE KEY-----", secret: PRIVATE_KEY, pattern: SECRET_PATTERN_PRIVATE_KEY_BLOCK },
    { label: "≥40-char high-entropy base64 run", secret: HIGH_ENTROPY_BLOB, pattern: SECRET_PATTERN_HIGH_ENTROPY },
  ];

  for (const c of CASES) {
    it(`${c.label} in the quote ⇒ blocked, and the record names ${c.pattern}`, async () => {
      const { captured, report } = await harvest(CODE_CARD, [
        { quote: `leaked: ${c.secret}`, claim: "c", source: "code", locator: "src/a.ts", revision: "r" },
      ]);
      expect(captured).toHaveLength(0);
      expect(report.evidencePublished).toBe(0);
      expect(report.secretScanRejections).toHaveLength(1);
      expect(report.secretScanRejections[0].patterns).toContain(c.pattern);
      expect(report.secretScanRejections[0].fields).toContain("quote");
      // ⛔ D3：记录里不得出现密钥本身。
      expect(JSON.stringify(report.secretScanRejections)).not.toContain(c.secret);
    });

    it(`${c.label} in the CLAIM ⇒ blocked too (the claim field is scanned, not just the quote)`, async () => {
      const { captured, report } = await harvest(CODE_CARD, [
        { quote: "clean quote", claim: `leaked: ${c.secret}`, source: "code", locator: "src/a.ts", revision: "r" },
      ]);
      expect(captured).toHaveLength(0);
      expect(report.secretScanRejections[0].patterns).toContain(c.pattern);
      expect(report.secretScanRejections[0].fields).toEqual(["claim"]);
    });
  }
});

// ══════════════════════════════════════════════════════════════════════════════
// 判据 4 ⭐⭐ D4 判别性 —— 高熵规则**不得误伤合法 anchor**（本包最容易做歪的一条）
// ══════════════════════════════════════════════════════════════════════════════

describe("E1k 判据 4 ⭐⭐ D4 (harvestCard): the GT-4 verbatim legitimate anchors publish with ZERO interception", () => {
  it("⭐⭐ code:// anchor carrying a 40-char commit sha ⇒ published verbatim, zero rejections", async () => {
    const { captured, report } = await harvest(CODE_CARD, [
      {
        quote: "const x = 1;",
        claim: "dispatch.ts defines x",
        source: "code",
        locator: "src/dispatch.ts",
        revision: GT4_CODE_REVISION,
        range: "L1287",
      },
    ]);
    // §0 GT-4 逐字：这正是「≥40 字符连续 hex」会误伤的那条合法证据。
    expect(captured).toHaveLength(1);
    expect(captured[0].anchor).toBe(GT4_CODE_ANCHOR);
    expect(report.secretScanRejections).toHaveLength(0);
    expect(report.evidencePublished).toBe(1);
  });

  it("⭐⭐ web:// content anchor carrying a 64-char sha256 ⇒ published verbatim, zero rejections", async () => {
    const contentCard = {
      clueId: "card_content5",
      text: `web://${GT4_CONTENT_URI}@${GT4_CONTENT_DIGEST}`,
      depth: 0,
      sources: ["content"],
    };
    const { captured, report } = await harvest(contentCard, [
      {
        quote: "H1 工程基建组围绕…",
        claim: "H1 以…为北极星方向。",
        source: "content",
        locator: GT4_CONTENT_URI,
        revision: GT4_CONTENT_DIGEST,
        range: "L1",
      },
    ]);
    expect(captured).toHaveLength(1);
    expect(captured[0].anchor).toBe(GT4_CONTENT_ANCHOR);
    expect(report.secretScanRejections).toHaveLength(0);
    expect(report.evidencePublished).toBe(1);
  });

  it("⛔ NOT a whole-field exemption: the high-entropy rule still fires on the SAME digest outside its structural slot", () => {
    // ⭐ 判别性的另一半：把 D4 的排除逻辑去掉 ⇒ 上面两条用例变红；而排除**只**覆盖结构位，
    //    同一个 64 位 digest 出现在 quote 里（无结构可言）依然被高熵规则拦下。
    expect(scanFieldForSecretPatterns(GT4_CONTENT_ANCHOR, "anchor")).toEqual([]);
    expect(scanFieldForSecretPatterns(GT4_CODE_ANCHOR, "anchor")).toEqual([]);
    expect(scanFieldForSecretPatterns(GT4_CONTENT_DIGEST, "quote")).toEqual([
      SECRET_PATTERN_HIGH_ENTROPY,
    ]);
    expect(scanFieldForSecretPatterns(GT4_CODE_REVISION, "claim")).toEqual([
      SECRET_PATTERN_HIGH_ENTROPY,
    ]);
    // 排除的区间就是 `<revision>` 段本身，⛔ 不是整条 anchor。
    expect(structuralAnchorDigestSpan(GT4_CODE_ANCHOR)).toEqual([
      GT4_CODE_ANCHOR.lastIndexOf("@") + 1,
      GT4_CODE_ANCHOR.lastIndexOf("@") + 1 + GT4_CODE_REVISION.length,
    ]);
    // 结构位上不是摘要形态（例如根本没有 digest）⇒ 无豁免区间。
    expect(structuralAnchorDigestSpan("code://src/a.ts@HEAD#L1")).toBeNull();
  });
});

describe("E1k 判据 4 ⭐⭐ REVERSE (harvestCard): a real ghp_ token hidden INSIDE the anchor is still caught", () => {
  it("⭐⭐ ghp_ in the anchor's LOCATOR segment ⇒ blocked (proves anchor is not wholesale exempt)", async () => {
    const { captured, report } = await harvest(CODE_CARD, [
      {
        quote: "clean quote",
        claim: "clean claim",
        source: "code",
        // ⛔ 真形态 token 藏进 locator 段；revision 段仍是合法 commit sha（豁免区间）。
        locator: `src/${GITHUB_TOKEN}.ts`,
        revision: GT4_CODE_REVISION,
        range: "L1",
      },
    ]);
    expect(captured).toHaveLength(0);
    expect(report.evidencePublished).toBe(0);
    expect(report.secretScanRejections).toHaveLength(1);
    expect(report.secretScanRejections[0].fields).toEqual(["anchor"]);
    expect(report.secretScanRejections[0].patterns).toContain(SECRET_PATTERN_GITHUB_TOKEN);
    expect(JSON.stringify(report.secretScanRejections)).not.toContain(GITHUB_TOKEN);
  });

  it("⭐ ghp_ in the anchor's REVISION segment ⇒ blocked (the exempt slot only ever exempts hex digests)", async () => {
    const { captured, report } = await harvest(CODE_CARD, [
      {
        quote: "clean quote",
        claim: "clean claim",
        source: "code",
        locator: "src/a.ts",
        revision: GITHUB_TOKEN,
        range: "L1",
      },
    ]);
    expect(captured).toHaveLength(0);
    expect(report.secretScanRejections[0].fields).toEqual(["anchor"]);
    expect(report.secretScanRejections[0].patterns).toContain(SECRET_PATTERN_GITHUB_TOKEN);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 判据 5 ⭐ K2 回归 —— 不含密钥形态的正常 evidence，发布行为逐字不变
// ══════════════════════════════════════════════════════════════════════════════

describe("E1k 判据 5 ⭐ K2 (harvestCard): clean evidence publishes verbatim as on base", () => {
  it("count, idempotency keys, publish order and budget consumption are unchanged", async () => {
    const evidences = [
      { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
      { quote: "q2", claim: "c2", source: "wiki", locator: "P", revision: "v" },
      { quote: "q3", claim: "c3", source: "code", locator: "src/dispatch.ts", revision: GT4_CODE_REVISION, range: "L1287" },
    ];
    const captured: EvidenceV2[] = [];
    const keys: string[] = [];
    const hd = harvestDeps({
      publishEvidence: vi.fn(async (_c, evidence, key) => {
        captured.push(evidence);
        keys.push(key);
      }),
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({ run_id: "run-1", evidences, proposed_clues: [], materials: [] }),
      ),
    });
    let consumed = 0;
    const budget: HarvestBudget = {
      total: () => 20,
      remaining: () => 20 - consumed,
      consume: (n: number) => {
        consumed += n;
      },
    };
    const report = await harvestCard(hd, CODE_CARD, "run-1", budget);
    // 条数逐字不变。
    expect(report.evidencePublished).toBe(3);
    expect(report.secretScanRejections).toHaveLength(0);
    // 幂等键 `dr-evidence:<run_id>:<index>` 逐字不变（⛔ index 仍是产物内稳定序号）。
    expect(keys).toEqual(["dr-evidence:run-1:0", "dr-evidence:run-1:1", "dr-evidence:run-1:2"]);
    // 发布顺序逐字不变。
    expect(captured.map((e) => e.quote)).toEqual(["q1", "q2", "q3"]);
    expect(captured.map((e) => e.anchor)).toEqual([
      "code://a@r",
      "wiki://P@v",
      GT4_CODE_ANCHOR,
    ]);
    // 预算消耗逐字不变：3 条 evidence 各 1 次写（CAS 由上层消耗）。
    expect(consumed).toBe(3);
    expect(report.casExplored).toBe(true);
  });

  it("⭐ a blocked evidence consumes NO write budget (the gate does not silently spend the round's budget)", async () => {
    let consumed = 0;
    const budget: HarvestBudget = {
      total: () => 20,
      remaining: () => 20 - consumed,
      consume: (n: number) => {
        consumed += n;
      },
    };
    const hd = harvestDeps({
      readWorkerResult: vi.fn(async () =>
        validWorkerResult({
          run_id: "run-1",
          evidences: [
            { quote: `leaked ${AWS_KEY}`, claim: "c", source: "code", locator: "a", revision: "r" },
            { quote: "q2", claim: "c2", source: "code", locator: "b", revision: "r" },
          ],
          proposed_clues: [],
          materials: [],
        }),
      ),
    });
    const report = await harvestCard(hd, CODE_CARD, "run-1", budget);
    expect(consumed).toBe(1);
    expect(report.evidencePublished).toBe(1);
    expect(report.secretScanRejections).toHaveLength(1);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 判据 6 ⛔ —— 断言打在**生产装配链**上：桩只停在 fetch（网络边界）
// ══════════════════════════════════════════════════════════════════════════════

describe("E1k 判据 6 ⛔ (production assembly, runChannelWrite): what actually lands on the evidence channel", () => {
  function setupBoard(
    evidences: Array<Record<string, unknown>>,
    card: { text: string; sources: string[] },
  ) {
    const inFlightMsg = {
      message_id: "msg_clue_e1k",
      channel_id: WIRE_CHANNEL,
      channel_seq: 1,
      kind: "research.clue.v2",
      payload: {
        status: "in_flight",
        text: card.text,
        depth: 0,
        sources: card.sources,
        run_id: "run-e1k-prod",
      },
      entity_id: "card_e1k",
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const runsMessages = [
      {
        message_id: "run_exit",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.exited.v1",
        payload: { run_id: "run-e1k-prod", exit_code: 0 },
        entity_id: "run-e1k-prod",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        message_id: "result_e1k",
        channel_id: "board:agent-runs",
        channel_seq: 2,
        kind: "worker.result.v1",
        payload: { run_id: "run-e1k-prod", evidences, proposed_clues: [], materials: [] },
        entity_id: "run-e1k-prod",
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
      /** 实际发到证据 channel 的 evidence payload。 */
      evidencePayloads: () =>
        publishBodies
          .filter((b) => b.kind === "research.evidence.v2" && b.channel === EVIDENCE_CHANNEL)
          .map((b) => b.payload),
      run: () =>
        runChannelWrite({ channelId: WIRE_CHANNEL, evidenceChannelId: EVIDENCE_CHANNEL }),
    };
  }

  it("⭐⭐ K1 (production): the AKIA evidence never reaches the bus; its sibling does; report names pattern+field", async () => {
    const dirtyQuote = `export const AWS_KEY = "${AWS_KEY}";`;
    const ctx = setupBoard(
      [
        { quote: dirtyQuote, claim: "hard-coded key", source: "code", locator: "src/a.ts", revision: "r1" },
        { quote: "ordinary quote", claim: "ordinary claim", source: "code", locator: "src/b.ts", revision: "r2" },
      ],
      { text: "investigate X", sources: ["code-local"] },
    );
    vi.stubGlobal("fetch", ctx.fetchMock);
    const outcome = await ctx.run();

    // (a) ⛔ 该条不出现在证据 channel 上（读的是真实 publish 请求体）。
    const payloads = ctx.evidencePayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].quote).toBe("ordinary quote");
    // ⛔ 整个出网流量里都不含这个密钥串（不只是 evidence channel）。
    expect(JSON.stringify(ctx.publishBodies)).not.toContain(AWS_KEY);

    // (c) 运行记录含拦截条目，点名 pattern 名与字段名。
    const rejections = outcome.harvestReports[0].secretScanRejections;
    expect(rejections).toHaveLength(1);
    expect(rejections[0].clueId).toBe("card_e1k");
    expect(rejections[0].patterns).toEqual([SECRET_PATTERN_AWS_ACCESS_KEY_ID]);
    expect(rejections[0].fields).toEqual(["quote"]);
    // (d) ⛔ 记录不含命中内容本身，也不含 quote 全文。
    expect(JSON.stringify(rejections)).not.toContain("AKIA");
    expect(JSON.stringify(rejections)).not.toContain(dirtyQuote);

    // 活性：不连坐 —— 同卡合规证据照常发布，卡照常 CAS explored。
    expect(outcome.harvestReports[0].evidencePublished).toBe(1);
    expect(ctx.publishBodies.some((b) => b.payload.status === "explored")).toBe(true);
  });

  it("⭐⭐ 判据 4 (production): the GT-4 verbatim legitimate anchors land on the bus untouched", async () => {
    const ctx = setupBoard(
      [
        {
          quote: "H1 工程基建组围绕…",
          claim: "H1 以…为北极星方向。",
          source: "content",
          locator: GT4_CONTENT_URI,
          revision: GT4_CONTENT_DIGEST,
          range: "L1",
        },
      ],
      { text: `web://${GT4_CONTENT_URI}@${GT4_CONTENT_DIGEST}`, sources: ["content"] },
    );
    vi.stubGlobal("fetch", ctx.fetchMock);
    const outcome = await ctx.run();
    const payloads = ctx.evidencePayloads();
    // ⛔ 判据 8 的单机对应物：正常链路**不得**被误伤成零证据。
    expect(payloads).toHaveLength(1);
    expect(payloads[0].anchor).toBe(GT4_CONTENT_ANCHOR);
    expect(outcome.harvestReports[0].secretScanRejections).toHaveLength(0);
    expect(outcome.harvestReports[0].evidencePublished).toBe(1);
  });

  it("⭐ 判据 4 REVERSE (production): a ghp_ token inside the anchor is stopped at the bus boundary", async () => {
    const ctx = setupBoard(
      [
        {
          quote: "clean quote",
          claim: "clean claim",
          source: "code",
          locator: `src/${GITHUB_TOKEN}.ts`,
          revision: GT4_CODE_REVISION,
          range: "L1",
        },
      ],
      { text: "investigate X", sources: ["code-local"] },
    );
    vi.stubGlobal("fetch", ctx.fetchMock);
    const outcome = await ctx.run();
    expect(ctx.evidencePayloads()).toHaveLength(0);
    expect(JSON.stringify(ctx.publishBodies)).not.toContain(GITHUB_TOKEN);
    const rejections = outcome.harvestReports[0].secretScanRejections;
    expect(rejections).toHaveLength(1);
    expect(rejections[0].fields).toEqual(["anchor"]);
    expect(rejections[0].patterns).toContain(SECRET_PATTERN_GITHUB_TOKEN);
  });
});
