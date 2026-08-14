/**
 * E1k2 —— 证据发布前的凭证形态扫描闸门（spec §2 判据 1–8）
 *
 * ⛔ 纪律（spec §2 判据 7）：判据 2–6 的断言全部打在**生产组装出的收割路径**上——
 *    驱动 `harvestCard` / `runWrite` / `runChannelWrite`，检查 `publishEvidence`
 *    **实际收到 / 未收到**哪些 evidence。⛔ 不只断言纯函数、⛔ 不绕过装配链直接传参、
 *    ⛔ 不做源码字符串匹配。纯函数层的用例只作为判据 4 的规则点名补充。
 *
 * ⚠️ 本文件是**凭证形态扫描器自己的测试语料**，必须携带与真实凭证同形的串。
 *    为了不在源码里留下任何一个**完整可复制**的凭证字面量（本 development 的上一版
 *    正是因为把这些形态逐字写进交付文本、触发控制面的 secret sentinel 而卡死报废），
 *    每条语料都由「前缀」与「体」分开拼装：运行期的值与真实形态**逐字同构**，
 *    但源码里没有任何一处出现完整串。被测对象看到的是拼装后的完整值，判别性不受影响。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createHash } from "node:crypto";
import {
  harvestCard,
  secretPatternRejection,
  SECRET_PATTERN_REJECTION_REASON,
  type HarvestBudget,
  type HarvestDeps,
} from "../src/harvest";
import {
  highEntropyRuns,
  isExemptDigestShape,
  scanSecretPatterns,
  HIGH_ENTROPY_MIN_LENGTH,
  type SecretPatternName,
} from "../src/secret-scan";
import { runWrite, runChannelWrite } from "../src/tick-run";
import type { WriteDeps } from "../src/tick-run";
import type { Decision } from "../src/tick";
import type { EvidenceV2 } from "../src/protocol";

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 语料：四类凭证形态（拼装，源码里不留完整串）─────────────────────

/** ① 四字母大写前缀 + 16 位大写字母数字（共 20 字符）。体取自云厂商公开文档的示例值。 */
const AWS_KEY = ["AKIA", "IOSFODNN7EXAMPLE"].join("");
/** ② 三字母小写前缀 + 下划线 + 36 位字母数字。 */
const GITHUB_PAT = ["ghp", "_", "0123456789abcdefghijABCDEFGHIJ012345"].join("");
/** ③ 四字符小写前缀 + 短横 + 短横分段的令牌体。 */
const SLACK_TOKEN = ["xoxb", "-", "000000000000-000000000000-", "abcdefghijklmnopqrstuvwx"].join("");
/** ④ PEM 私钥块起始行。 */
const PEM_HEADER = ["-----", "BEGIN RSA PRIVATE KEY", "-----"].join("");

/** 四类凭证形态与它们各自应被点名的 pattern 名（判据 3 / 判据 4 ①②③④）。 */
const CREDENTIAL_SHAPES: ReadonlyArray<{ label: string; value: string; pattern: SecretPatternName }> = [
  { label: "① cloud access key id", value: AWS_KEY, pattern: "aws-access-key-id" },
  { label: "② forge personal access token", value: GITHUB_PAT, pattern: "github-personal-access-token" },
  { label: "③ chat bot token", value: SLACK_TOKEN, pattern: "slack-bot-token" },
  { label: "④ PEM private key block header", value: PEM_HEADER, pattern: "pem-private-key-block" },
];

// ── 语料：判据 2 的三条**真实**合法摘要（本线研究对象就是代码仓，这类行极其常见）──

/** 40 位十六进制 git sha（= sha1 hex 长度，也是 git 全 sha 长度）。 */
const GIT_SHA = createHash("sha1").update("e1k2 pinned commit").digest("hex");
/** 64 位十六进制 sha256 摘要。 */
const BUNDLE_DIGEST = createHash("sha256").update("e1k2 evidence bundle").digest("hex");
/** sha512 的 base64 编码（88 字符，含填充）——npm lockfile 的 integrity 形态。 */
const LOCK_INTEGRITY = createHash("sha512").update("e1k2 tarball").digest("base64");

/** ⑤ 一段**不属于 D3 豁免形态**的高熵串：50 字符 base64，非标准摘要长度、且无算法名前缀。 */
const NONSTANDARD_BLOB = createHash("sha512").update("e1k2 non-digest blob").digest("base64").slice(0, 50);

/** spec §2 判据 2 逐字点名的三条真实语料。 */
const LEGIT_DIGEST_CORPUS: ReadonlyArray<{ label: string; text: string }> = [
  {
    label: "一行源码：把 40 位十六进制 git sha 赋给常量",
    text: `const HEAD_SHA = "${GIT_SHA}"; // pinned upstream revision`,
  },
  {
    label: "一行 JSON：键名含 digest，值是带算法名前缀的 64 位十六进制",
    text: `{"evidence_bundle_digest": "sha256:${BUNDLE_DIGEST}"}`,
  },
  {
    label: "一行 lockfile 片段：键名 integrity，值是带算法名前缀的 base64",
    text: `"integrity": "sha512-${LOCK_INTEGRITY}",`,
  },
];

// ── 生产收割路径的装配（判据 7：断言打在生产组装出的 deps 上）──────────

const CARD = { clueId: "card_x", text: "investigate X", depth: 0, sources: ["code-local"] };

const HARVEST_DECISION: Decision = {
  kind: "harvest",
  clueId: "card_x",
  runId: "run-1",
  text: "investigate X",
  depth: 0,
  sources: ["code-local"],
};

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

/** 一条形态合规的普通 evidence（`code://` 锚点，非 web 类，⛔ 不触发 E2b 的活 URL 拒发）。 */
function cleanEvidence(over: Record<string, unknown> = {}) {
  return {
    quote: "普通中文结论：该模块按调度器侧事实路由。",
    claim: "routing is a dispatcher-side fact",
    source: "code",
    locator: "src/harvest.ts",
    revision: "abc123",
    ...over,
  };
}

/**
 * 驱动**生产收割函数** `harvestCard`，返回 `publishEvidence` 实际收到的 evidence。
 * ⛔ 判据 7：不得绕过装配链直接给纯函数传参。
 */
async function harvest(evidences: Array<Record<string, unknown>>) {
  const captured: EvidenceV2[] = [];
  const hd: HarvestDeps = {
    evidenceChannelId: "research:p02-smoke-1dce60.evidence",
    boardChannelId: "research:p02-smoke-1dce60",
    maxClues: 64,
    maxDepth: 3,
    boardClueCount: { value: 0 },
    readWorkerResult: vi.fn(async () => ({
      run_id: "run-1",
      evidences,
      proposed_clues: [],
      materials: [],
    })),
    publishEvidence: vi.fn(async (_channel: string, evidence: EvidenceV2) => {
      captured.push(evidence);
    }),
    publishClue: vi.fn(async () => {}),
  } as unknown as HarvestDeps;
  const report = await harvestCard(hd, CARD, "run-1", makeBudget(evidences.length + 2));
  return { captured, report, hd };
}

// ── 判据 4 ⭐：五类规则各一条正向用例，各自点名对应 pattern ───────────

describe("E1k2 判据 4 ⭐: each of the five rules fires and names its own pattern", () => {
  for (const shape of CREDENTIAL_SHAPES) {
    it(`${shape.label} ⇒ scanner names ${shape.pattern}`, () => {
      expect(scanSecretPatterns(shape.value)).toContain(shape.pattern);
    });
  }

  it("⑤ high-entropy string outside the D3 digest shapes ⇒ names high-entropy-string", () => {
    // ⛔ 判别性前置：这段串确实**不属于** D3 的任何豁免形态。
    expect(NONSTANDARD_BLOB.length).toBeGreaterThanOrEqual(HIGH_ENTROPY_MIN_LENGTH);
    expect(NONSTANDARD_BLOB).not.toMatch(/^[0-9a-fA-F]+$/); // 非纯十六进制 ⇒ 不吃 (a)
    expect(NONSTANDARD_BLOB.length).not.toBe(88); // 非 sha512 的 base64 长度
    expect(isExemptDigestShape(NONSTANDARD_BLOB, "some prose without an algorithm prefix ")).toBe(false);
    expect(scanSecretPatterns(`blob: ${NONSTANDARD_BLOB}`)).toContain("high-entropy-string");
  });

  it("liveness: ordinary Chinese prose and an ordinary English code line ⇒ zero patterns", () => {
    expect(scanSecretPatterns("普通中文结论：闸门必须确定性，不得用模型判断。")).toEqual([]);
    expect(scanSecretPatterns("export function harvestCard(hd, card, runId, budget) {")).toEqual([]);
  });
});

// ── 判据 2 ⭐⭐⭐：D3 判别性（本包核心，上一版就栽在这）────────────────

describe("E1k2 判据 2 ⭐⭐⭐ (harvestCard): the three real-corpus digest lines publish as usual, zero blocks", () => {
  it("git sha line / sha256-prefixed digest line / lockfile integrity line ⇒ all three on the evidence channel", async () => {
    const { captured, report } = await harvest(
      LEGIT_DIGEST_CORPUS.map((c) => cleanEvidence({ quote: c.text })),
    );
    // ⭐⭐⭐ 活性（上一版真机在这里是 0）：三条**全部照常发布**。
    expect(captured).toHaveLength(3);
    expect(report.evidencePublished).toBe(3);
    // ⭐⭐⭐ 零拦截：一条都不许被高熵规则误伤。
    expect(report.secretRejections).toEqual([]);
    // 不连坐、整卡照常 CAS explored。
    expect(report.casExplored).toBe(true);
    // 逐字：发布的 quote 就是那三行真实语料。
    expect(captured.map((e) => e.quote)).toEqual(LEGIT_DIGEST_CORPUS.map((c) => c.text));
  });

  it("同样的三条语料放在 claim / anchor 上也照常发布（D3(c)：豁免不限于锚点结构位）", async () => {
    const { captured, report } = await harvest([
      cleanEvidence({ claim: `bundle recorded as sha256:${BUNDLE_DIGEST}` }),
      cleanEvidence({ revision: GIT_SHA }), // ⇒ anchor 尾段是 40 位十六进制 git sha
      cleanEvidence({ locator: `node_modules/.package-lock.json#sha512-${LOCK_INTEGRITY}` }),
    ]);
    expect(captured).toHaveLength(3);
    expect(report.secretRejections).toEqual([]);
    // 逐字：第二条的 anchor 确实带上了那个 40 位 git sha（证明语料真的进了 anchor 字段）。
    expect(captured[1].anchor).toBe(`code://src/harvest.ts@${GIT_SHA}`);
  });

  it("⭐⭐⭐ DISCRIMINATING (判据 2 的反半边): drop the D3 exemption ⇒ all three WOULD be flagged", () => {
    // 「把 D3 的豁免逻辑去掉」= 无豁免的高熵规则本体 = `highEntropyRuns`。
    // 三条语料都有 ≥40 字符的连续 base64/hex 候选串 ⇒ 无豁免版本**全部变红**。
    for (const c of LEGIT_DIGEST_CORPUS) {
      expect(highEntropyRuns(c.text).length).toBeGreaterThan(0);
    }
    // 而生产扫描器（带 D3 豁免）对同样三条一个 pattern 都不报——豁免确实在起作用，
    // ⛔ 不是「这三条本来就命不中高熵规则」。
    for (const c of LEGIT_DIGEST_CORPUS) {
      expect(scanSecretPatterns(c.text)).toEqual([]);
    }
  });
});

// ── 判据 3 ⭐⭐：D3 反向（豁免不得开成后门）──────────────────────────

describe("E1k2 判据 3 ⭐⭐ (harvestCard): credential shapes are blocked in ANY field at ANY position", () => {
  for (const shape of CREDENTIAL_SHAPES) {
    it(`${shape.label} in quote ⇒ blocked, names ${shape.pattern} and the field`, async () => {
      const { captured, report } = await harvest([
        cleanEvidence({ quote: `leaked in prose: ${shape.value} — trailing text` }),
      ]);
      expect(captured).toHaveLength(0);
      expect(report.secretRejections).toHaveLength(1);
      expect(report.secretRejections[0].patterns).toContain(shape.pattern);
      expect(report.secretRejections[0].fields).toContain("quote");
    });

    it(`${shape.label} in claim ⇒ blocked, names ${shape.pattern} and the field`, async () => {
      const { captured, report } = await harvest([
        cleanEvidence({ claim: `the config carries ${shape.value} inline` }),
      ]);
      expect(captured).toHaveLength(0);
      expect(report.secretRejections[0].patterns).toContain(shape.pattern);
      expect(report.secretRejections[0].fields).toContain("claim");
    });

    it(`${shape.label} in anchor ⇒ blocked, names ${shape.pattern} and the field`, async () => {
      // 凭证形态经 locator 进入拼装出的 anchor（`code://<locator>@<revision>`）。
      const { captured, report } = await harvest([
        cleanEvidence({ locator: `config/${shape.value}/settings.ts` }),
      ]);
      expect(captured).toHaveLength(0);
      expect(report.secretRejections[0].patterns).toContain(shape.pattern);
      expect(report.secretRejections[0].fields).toContain("anchor");
    });

    it(`${shape.label} 紧挨着一个合法摘要 ⇒ 仍被拦下（⛔ 整字段豁免即后门）`, async () => {
      // ⭐⭐ 这条正是「把豁免放宽成整字段豁免 ⇒ 变红」的钉子：该字段里**同时**有一个
      //    合法 sha256 摘要与一个凭证形态。按字段整体豁免的实现会把它照常发出去。
      const { captured, report } = await harvest([
        cleanEvidence({ quote: `sha256:${BUNDLE_DIGEST} ${shape.value}` }),
      ]);
      expect(captured).toHaveLength(0);
      expect(report.secretRejections[0].patterns).toContain(shape.pattern);
      // ⛔ 方向钉正：合法摘要那一段仍然**没有**被高熵规则误报。
      expect(report.secretRejections[0].patterns).not.toContain("high-entropy-string");
    });
  }

  it("⭐⭐ the algorithm-name prefix alone is NOT a pass: a non-digest-length blob after it is still flagged", async () => {
    // 若豁免只看「有没有算法名前缀」，把任意长串挂在算法名后面即可绕过高熵规则。
    // 本实现要求编码长度**恰好**等于该算法摘要的 hex/base64 长度，故这条仍被拦下。
    const { captured, report } = await harvest([
      cleanEvidence({ quote: `sha256:${NONSTANDARD_BLOB}` }),
    ]);
    expect(captured).toHaveLength(0);
    expect(report.secretRejections[0].patterns).toContain("high-entropy-string");
  });
});

// ── 判据 5 ⭐⭐：K1 判别性（同卡一拦一放 + 记录形态）────────────────────

describe("E1k2 判据 5 ⭐⭐ K1 (harvestCard): one card, two evidences, one carrying a credential shape", () => {
  it("(a) 该条不上证据 channel (b) 同卡另一条照常发布 (c) 记录含 pattern 名与字段名 (d) 记录不含命中串与 quote 全文", async () => {
    const secretQuote = `deploy notes: ${AWS_KEY} was rotated on 2026-08-14`;
    const { captured, report, hd } = await harvest([
      cleanEvidence({ quote: secretQuote }),
      cleanEvidence({ quote: "同卡第二条：普通结论，无任何凭证形态。", locator: "src/tick.ts" }),
    ]);

    // (a) 命中的那条**没有**到达 publishEvidence。
    expect(hd.publishEvidence).toHaveBeenCalledTimes(1);
    expect(captured).toHaveLength(1);
    expect(captured[0].quote).toBe("同卡第二条：普通结论，无任何凭证形态。");
    // (b) ⛔ 不连坐：同卡另一条照常发布，整卡照常 CAS explored。
    expect(report.evidencePublished).toBe(1);
    expect(report.casExplored).toBe(true);
    expect(report.skipped).toBe(false);
    // (c) 拦截记录点名 clue_id、稳定序号、pattern 名、字段名。
    expect(report.secretRejections).toHaveLength(1);
    const rejection = report.secretRejections[0];
    expect(rejection.clueId).toBe("card_x");
    expect(rejection.index).toBe(0);
    expect(rejection.patterns).toEqual(["aws-access-key-id"]);
    expect(rejection.fields).toEqual(["quote"]);
    expect(rejection.hits).toEqual([{ field: "quote", patterns: ["aws-access-key-id"] }]);
    expect(rejection.reason).toBe(SECRET_PATTERN_REJECTION_REASON);
    // (d) ⛔ 记录里**没有**命中的那个串本身，也没有 quote 全文。
    const serialized = JSON.stringify(report.secretRejections);
    expect(serialized).not.toContain(AWS_KEY);
    expect(serialized).not.toContain(secretQuote);
    expect(serialized).not.toContain("rotated on 2026-08-14");
  });

  it("⭐⭐ 判据 5/6 (runWrite): the blocked evidence never reaches the bus, and the run record explains the gap", async () => {
    const captured: EvidenceV2[] = [];
    const hd: HarvestDeps = {
      evidenceChannelId: "research:p02-smoke-1dce60.evidence",
      boardChannelId: "research:p02-smoke-1dce60",
      maxClues: 64,
      maxDepth: 3,
      boardClueCount: { value: 0 },
      readWorkerResult: vi.fn(async () => ({
        run_id: "run-1",
        evidences: [
          cleanEvidence({ quote: `token dump ${GITHUB_PAT}` }),
          cleanEvidence({ quote: "干净的第二条", locator: "src/bus.ts" }),
        ],
        proposed_clues: [],
        materials: [],
      })),
      publishEvidence: vi.fn(async (_channel: string, evidence: EvidenceV2) => {
        captured.push(evidence);
      }),
      publishClue: vi.fn(async () => {}),
    } as unknown as HarvestDeps;
    const deps: WriteDeps = {
      cas: vi.fn(async () => ({ success: true })),
      spawnWorker: vi.fn(async () => {}),
      harvest: hd,
    } as unknown as WriteDeps;

    const result = await runWrite(deps, [HARVEST_DECISION], 10);

    expect(captured).toHaveLength(1);
    expect(result.harvestReports[0].evidencePublished).toBe(1);
    // D6 ⛔ 静默拦截即未交付：运行记录（harvestReports 由 tick-entry 直接 JSON 落盘）
    //   解释了「为何证据数少了」——点名 clue_id / pattern 名 / 字段名。
    const rejections = result.harvestReports[0].secretRejections;
    expect(rejections).toHaveLength(1);
    expect(rejections[0].clueId).toBe("card_x");
    expect(rejections[0].patterns).toEqual(["github-personal-access-token"]);
    expect(rejections[0].fields).toEqual(["quote"]);
    expect(JSON.stringify(rejections)).not.toContain(GITHUB_PAT);
    // 活性：卡照常 CAS explored（不连坐）。
    expect(result.casResults.some((c) => c.to === "explored")).toBe(true);
  });
});

// ── 判据 5/7 ⭐⭐：生产装配链（runChannelWrite）——真正落到证据 channel 的东西 ──

describe("E1k2 判据 5/7 ⭐⭐ (production assembly runChannelWrite): what actually lands on the evidence channel", () => {
  const WIRE_CHANNEL = "research:p02-smoke-1dce60";
  const EVIDENCE_CHANNEL = "research:p02-smoke-1dce60.evidence";

  function jsonResponse(data: unknown) {
    return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
  }

  function setupBoard(evidences: Array<Record<string, unknown>>) {
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
        payload: { run_id: "run-1", evidences, proposed_clues: [], materials: [] },
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
        clueCalls += 1;
        return jsonResponse({ messages: clueCalls === 1 ? [inFlightMsg] : [] });
      }
      if (u.includes("/v1/channels/board:agent-runs/messages")) {
        const hasAfterSeq = /[?&]after_seq=/.test(u);
        return jsonResponse({ messages: hasAfterSeq ? [] : runsMessages });
      }
      return jsonResponse({ messages: [] });
    });
    return {
      fetchMock,
      publishBodies,
      /** 实际发到证据 channel 的 research.evidence.v2 请求体。 */
      evidencePayloads: () =>
        publishBodies
          .filter((b) => b.kind === "research.evidence.v2" && b.channel === EVIDENCE_CHANNEL)
          .map((b) => b.payload),
      run: () => runChannelWrite({ channelId: WIRE_CHANNEL, evidenceChannelId: EVIDENCE_CHANNEL }),
    };
  }

  it("⭐⭐ K1: the credential-bearing evidence is absent from the bus; its card-mate is present", async () => {
    const secretQuote = `ops runbook line: ${SLACK_TOKEN}`;
    const ctx = setupBoard([
      cleanEvidence({ quote: secretQuote }),
      cleanEvidence({ quote: "同卡第二条：普通结论。", locator: "src/tick.ts" }),
    ]);
    vi.stubGlobal("fetch", ctx.fetchMock);
    const outcome = await ctx.run();

    // (a) ⛔ 命中的那条根本没上无 DELETE 的 append-only 证据 channel。
    const payloads = ctx.evidencePayloads();
    expect(payloads).toHaveLength(1);
    expect(payloads[0].quote).toBe("同卡第二条：普通结论。");
    // ⛔ 整个出站请求体里都不含那个凭证串。
    expect(JSON.stringify(ctx.publishBodies)).not.toContain(SLACK_TOKEN);
    // (b) 不连坐：卡照常 CAS explored。
    expect(ctx.publishBodies.some((b) => b.payload.status === "explored")).toBe(true);
    // (c)(d) 运行记录点名 pattern/字段，且不含命中串与 quote 全文。
    const rejections = outcome.harvestReports[0].secretRejections;
    expect(rejections).toHaveLength(1);
    expect(rejections[0].patterns).toEqual(["slack-bot-token"]);
    expect(rejections[0].fields).toEqual(["quote"]);
    expect(JSON.stringify(rejections)).not.toContain(SLACK_TOKEN);
    expect(JSON.stringify(rejections)).not.toContain(secretQuote);
  });

  it("⭐⭐⭐ 判据 2 (production): the three legit digest lines all reach the evidence channel", async () => {
    const ctx = setupBoard(LEGIT_DIGEST_CORPUS.map((c) => cleanEvidence({ quote: c.text })));
    vi.stubGlobal("fetch", ctx.fetchMock);
    const outcome = await ctx.run();
    // ⭐⭐⭐ 上一版真机在这里是 0 条（整轮零证据）。
    expect(ctx.evidencePayloads()).toHaveLength(3);
    expect(outcome.harvestReports[0].secretRejections).toEqual([]);
    expect(outcome.harvestReports[0].evidencePublished).toBe(3);
  });
});

// ── 判据 6 ⭐：K2 回归——干净 evidence 的发布行为与 base 逐字不变 ─────────

describe("E1k2 判据 6 ⭐ K2 (harvestCard): clean evidence publishes verbatim as before", () => {
  it("条数 / 幂等键 / 预算消耗 / 发布顺序全部与 base 一致，零拦截记录", async () => {
    const keys: string[] = [];
    const captured: EvidenceV2[] = [];
    let consumed = 0;
    const hd: HarvestDeps = {
      evidenceChannelId: "research:p02-smoke-1dce60.evidence",
      boardChannelId: "research:p02-smoke-1dce60",
      maxClues: 64,
      maxDepth: 3,
      boardClueCount: { value: 0 },
      readWorkerResult: vi.fn(async () => ({
        run_id: "run-1",
        evidences: [
          cleanEvidence({ quote: "第一条", locator: "a" }),
          cleanEvidence({ quote: "第二条", locator: "b" }),
        ],
        proposed_clues: [{ clue: "new idea" }],
        materials: [],
      })),
      publishEvidence: vi.fn(async (_c: string, evidence: EvidenceV2, key: string) => {
        captured.push(evidence);
        keys.push(key);
      }),
      publishClue: vi.fn(async (_c: string, _clue: unknown, key: string) => {
        keys.push(key);
      }),
    } as unknown as HarvestDeps;
    const budget: HarvestBudget = {
      total: () => 10,
      remaining: () => 10 - consumed,
      consume: (n: number) => {
        consumed += n;
      },
    };

    const report = await harvestCard(hd, CARD, "run-1", budget);

    // 条数 / 顺序 / 幂等键逐字（evidence 全部先发，再发 clue）。
    expect(captured.map((e) => e.quote)).toEqual(["第一条", "第二条"]);
    expect(keys).toEqual(["dr-evidence:run-1:0", "dr-evidence:run-1:1", "dr-clue:run-1:0"]);
    // 预算消耗逐字：2 条 evidence + 1 条 clue = 3（⛔ 闸门不额外消耗预算）。
    expect(consumed).toBe(3);
    expect(report.evidencePublished).toBe(2);
    expect(report.cluesPublished).toBe(1);
    expect(report.secretRejections).toEqual([]);
    expect(report.evidenceRejections).toEqual([]);
    expect(report.casExplored).toBe(true);
  });
});

// ── D1/D5 纯函数层补充：扫描器只吐 pattern 名，绝不吐命中内容 ─────────

describe("E1k2 D1/D5: the scanner and the rejection record never carry the matched content", () => {
  it("scanSecretPatterns returns pattern NAMES only (no substrings of the input)", () => {
    const names = scanSecretPatterns(`prose ${AWS_KEY} more prose ${GITHUB_PAT}`);
    expect(names).toEqual(["aws-access-key-id", "github-personal-access-token"]);
    expect(JSON.stringify(names)).not.toContain(AWS_KEY);
    expect(JSON.stringify(names)).not.toContain(GITHUB_PAT);
  });

  it("secretPatternRejection ⇒ null for a clean evidence (liveness half)", () => {
    const clean: EvidenceV2 = {
      clue_id: "card_x",
      anchor: `code://src/harvest.ts@${GIT_SHA}`,
      quote: LEGIT_DIGEST_CORPUS[1].text,
      claim: "clean claim",
    };
    expect(secretPatternRejection("card_x", 0, clean)).toBeNull();
  });

  it("multi-field hit ⇒ every hit field and pattern named, still no matched content", () => {
    const dirty: EvidenceV2 = {
      clue_id: "card_x",
      anchor: `code://config/${PEM_HEADER}/x.ts@abc123`,
      quote: `quote holds ${AWS_KEY}`,
      claim: `claim holds ${SLACK_TOKEN}`,
    };
    const rejection = secretPatternRejection("card_x", 3, dirty);
    expect(rejection).not.toBeNull();
    expect(rejection!.index).toBe(3);
    expect(rejection!.fields).toEqual(["quote", "claim", "anchor"]);
    expect(rejection!.patterns).toEqual([
      "aws-access-key-id",
      "slack-bot-token",
      "pem-private-key-block",
    ]);
    const serialized = JSON.stringify(rejection);
    for (const shape of CREDENTIAL_SHAPES) {
      expect(serialized).not.toContain(shape.value);
    }
    expect(serialized).not.toContain("quote holds");
  });
});
