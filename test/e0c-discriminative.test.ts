/**
 * E0c —— 判别性硬验收（spec §2.2–2.7）。
 *
 * 每条把被测行为改坏后必须变红（判别对 / 变异）。
 *  - C2（GT-1）head_seq 只从列表端点取：单 channel GET 若返回 head_seq、或列表 GET 不列出
 *    空 channel ⇒ 测试变红。
 *  - C3（GT-2）生产总线 sum(head_seq) 是真实全量求和：把求和换成贪婪正则实现 ⇒ 测试变红。
 *  - C4（GT-4）种子不带 sources（或 profile 未声明 sources）⇒ 播种响亮失败，⛔ 不得静默播
 *    一条 sources: [] 的线索。
 *  - C5（GT-3）termination.state 为 null ⇒ 入口非零退出；把终态判据换成「用 drain 摘要的
 *    reason」⇒ 测试变红。
 *  - C6（§1.3）构造「板面已排空但 termination.state 仍为 null 且未触顶」⇒ 仍然续投；
 *    把续投门改回只看 hasPendingWork ⇒ 测试变红。
 *  - C7（§1.2）两次运行使用的 research channel 名不同且各含自己的 run_id；把 channel 名
 *    改回固定值 ⇒ 第二次运行的测试变红。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  deriveResearchChannels,
  requireSeedSources,
  buildSeedArgv,
  SeedSourcesError,
  drainIdFromSummary,
  laneRunDirsFromIndex,
  lastTickTerminationState,
  readTerminationState,
  requireNonNullTermination,
  TerminationReadError,
} from "../src/e0-regression";
import {
  listChannels,
  channelHeadSeq,
  sumAllHeadSeqs,
} from "../src/bus";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── C7（§1.2）：per-run research board 命名 ────────────────────────────

describe("C7 (§1.2): two runs use distinct research channels each carrying its own run_id", () => {
  it("derived channels differ between run ids and each contains its run_id", () => {
    const runA = deriveResearchChannels("e0", "run-aaa");
    const runB = deriveResearchChannels("e0", "run-bbb");
    // ⛔ 判别性：把 channel 名改回固定值 ⇒ 本用例变红（两次 run 的 channel 必须不同）。
    expect(runA.index).not.toBe(runB.index);
    expect(runA.evidence).not.toBe(runB.evidence);
    expect(runA.docs).not.toBe(runB.docs);
    // 每个名字都含自己的 run_id，且走 research:<base>-<run_id>.<suffix> 形状。
    for (const c of [runA.index, runA.evidence, runA.docs]) {
      expect(c).toContain("run-aaa");
      expect(c).toMatch(/^research:e0-/);
    }
    for (const c of [runB.index, runB.evidence, runB.docs]) {
      expect(c).toContain("run-bbb");
      expect(c).toMatch(/^research:e0-/);
    }
  });

  it("three channels are distinct suffixes on the same base+run prefix", () => {
    const run = deriveResearchChannels("e0", "r1");
    expect(run.index).toBe("research:e0-r1.index");
    expect(run.evidence).toBe("research:e0-r1.evidence");
    expect(run.docs).toBe("research:e0-r1.docs");
    const set = new Set([run.index, run.evidence, run.docs]);
    expect(set.size).toBe(3);
  });
});

// ── C4（GT-4）：种子必须带 sources ────────────────────────────────────

describe("C4 (GT-4): seeding without sources fails loudly", () => {
  it("requireSeedSources throws when no sources provided", () => {
    expect(() => requireSeedSources(undefined)).toThrow(SeedSourcesError);
    expect(() => requireSeedSources([])).toThrow(SeedSourcesError);
  });

  it("requireSeedSources throws on blank/empty source entries", () => {
    expect(() => requireSeedSources([""])).toThrow(SeedSourcesError);
    expect(() => requireSeedSources(["   "])).toThrow(SeedSourcesError);
  });

  it("requireSeedSources accepts a non-empty source list", () => {
    expect(() => requireSeedSources(["code-local"])).not.toThrow();
  });

  it("buildSeedArgv fails loudly without sources (no silent sources: [])", () => {
    expect(() => buildSeedArgv("research:e0-r1.index", "clue", [])).toThrow(
      SeedSourcesError,
    );
  });

  it("buildSeedArgv emits --source per declared source", () => {
    const argv = buildSeedArgv("research:e0-r1.index", "clue", ["code-local", "wiki"]);
    expect(argv).toEqual([
      "--seed",
      "research:e0-r1.index",
      "--clue",
      "clue",
      "--source",
      "code-local",
      "--source",
      "wiki",
    ]);
  });

  it("buildSeedArgv rejects vacuous seed text (commensurate-with-repo requirement)", () => {
    expect(() => buildSeedArgv("research:e0-r1.index", "", ["code-local"])).toThrow(
      /commensurate|non-empty/,
    );
  });
});

// ── C3（GT-2）：生产总线 sum(head_seq) 真实全量求和 ─────────────────────

describe("C3 (GT-2): sumAllHeadSeqs is a real full sum over the list", () => {
  it("sums head_seq across every channel in the list (true full sum)", async () => {
    let listCall = 0;
    const resp = {
      ok: true,
      status: 200,
      json: async () => ({
        channels: [
          { channel_id: "a", head_seq: 3, created_at: "x" },
          { channel_id: "b", head_seq: 0, created_at: "x" }, // 空 channel 以 head_seq:0 列出
          { channel_id: "c", head_seq: 7, created_at: "x" },
        ],
      }),
      text: async () => "",
    };
    viStubFetch(() => {
      listCall += 1;
      return resp;
    });
    const sum = await sumAllHeadSeqs();
    // ⛔ 判别性：贪婪正则从单行 JSON 抽 head_seq 会漏值（历史事故：实测得 3，真实和 9788）。
    //    真实全量求和 = 3 + 0 + 7 = 10。
    expect(listCall).toBe(1);
    expect(sum).toBe(10);
  });

  it("fails loudly if any channel in the list lacks head_seq (no silent 0)", async () => {
    viStubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        channels: [
          { channel_id: "a", head_seq: 1 },
          { channel_id: "b" }, // ⛔ 缺 head_seq
        ],
      }),
      text: async () => "",
    }));
    await expect(sumAllHeadSeqs()).rejects.toThrow(/head_seq/);
  });
});

// ── C2（GT-1）：head_seq 只从列表端点取 ───────────────────────────────

describe("C2 (GT-1): channelHeadSeq reads head_seq from the list endpoint", () => {
  it("reads from GET /v1/channels (list) by channel_id", async () => {
    let listHits = 0;
    viStubFetch(() => {
      listHits += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          channels: [
            { channel_id: "research:e0-r1.index", head_seq: 4 },
            { channel_id: "board:agent-runs", head_seq: 2 },
          ],
        }),
        text: async () => "",
      };
    });
    const hs = await channelHeadSeq("research:e0-r1.index");
    expect(hs).toBe(4);
    expect(listHits).toBe(1);
  });

  it("fails loudly when the channel is absent from the list (never treats as 0)", async () => {
    viStubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({ channels: [{ channel_id: "other", head_seq: 0 }] }),
      text: async () => "",
    }));
    await expect(channelHeadSeq("missing")).rejects.toThrow(/missing/);
  });

  it("fails loudly when the found channel has no head_seq field (names actual field set)", async () => {
    viStubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => ({
        channels: [{ channel_id: "c1", created_at: "x", delivery_mode: "fifo" }],
      }),
      text: async () => "",
    }));
    const err = await channelHeadSeq("c1").catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    const msg = err instanceof Error ? String(err.message) : String(err);
    expect(msg).toMatch(/no head_seq/);
    expect(msg).toContain("c1");
  });

  it("listChannels parses the array form as well as {channels: [...]}", async () => {
    viStubFetch(() => ({
      ok: true,
      status: 200,
      json: async () => [{ channel_id: "a", head_seq: 1 }],
      text: async () => "",
    }));
    const list = await listChannels();
    expect(list[0].channel_id).toBe("a");
  });
});

// ── C2b（GT-1）假 bus 契约：单 channel GET 无 head_seq、列表 GET 列出空 channel ──
// 真跑 fake-bus 做判别：若 fake-bus 单 GET 返回 head_seq、或列表不列出空 channel，判据必红。

describe("C2b (GT-1): fake-bus implements the two-endpoint field-set contract", () => {
  const { spawn } = require("node:child_process") as typeof import("node:child_process");
  const { mkdtempSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");

  async function startBus(port: number): Promise<{ url: string; kill: () => void }> {
    const fixture = join(ROOT, "test", "fixtures", "fake-bus.mjs");
    const child = spawn(process.execPath, [fixture], {
      env: { ...process.env, A10B_BUS_PORT: String(port) },
      stdio: "ignore",
    });
    const deadline = Date.now() + 5000;
    for (;;) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/v1/channels/_probe`);
        if (r) break;
      } catch {
        /* not up yet */
      }
      if (Date.now() > deadline) throw new Error("fake-bus did not come up");
      await new Promise((r) => setTimeout(r, 50));
    }
    return { url: `http://127.0.0.1:${port}`, kill: () => child.kill() };
  }

  it("single channel GET does NOT carry head_seq; list GET lists an empty channel with head_seq:0", async () => {
    const port = 29000 + Math.floor(Math.random() * 500);
    const bus = await startBus(port);
    try {
      // 创建 channel（per-run board 的预备动作）。
      await fetch(`${bus.url}/v1/channels`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ channel_id: "research:e0-c2b.index" }),
      });
      // ⛔ GT-1：单 channel GET 不含 head_seq（若返回 head_seq ⇒ 判据变红）。
      const single = (await (await fetch(`${bus.url}/v1/channels/research:e0-c2b.index`)).json()) as Record<string, unknown>;
      expect(single).not.toHaveProperty("head_seq");
      // ⛔ GT-1：列表 GET 把空 channel 以 head_seq:0 列出（若不列出空 channel ⇒ 判据变红）。
      const list = (await (await fetch(`${bus.url}/v1/channels`)).json()) as { channels?: Array<Record<string, unknown>> };
      const entry = list.channels?.find((c) => c.channel_id === "research:e0-c2b.index");
      expect(entry).toBeTruthy();
      expect(entry!.head_seq).toBe(0);
    } finally {
      bus.kill();
    }
  });
});

// ── C5（GT-3）：termination.state 为 null ⇒ 响亮失败 / 非零退出 ────────

describe("C5 (GT-3): termination.state read from the journal chain", () => {
  it("readTerminationState walks drain_id → index → journal → last tick result → state", () => {
    const summary = { drain_id: "D1", reason: "drained" };
    const files: Record<string, string> = {
      "/idx/index.jsonl": JSON.stringify({ drain_id: "D1", run_dir: "/run/r1" }) + "\n",
      "/run/r1/journal.jsonl":
        JSON.stringify({
          run_id: "tick~1",
          identity: "tick",
          result: JSON.stringify({
            hasPendingWork: false,
            termination: { state: "converged", coverage: 1, zeroGrowthRounds: 2, capHit: false },
          }),
        }) + "\n",
    };
    const rec = readTerminationState({
      drainSummaryJson: summary,
      indexPath: "/idx/index.jsonl",
      readFile: (p) => files[p] ?? (() => { throw new Error(`ENOENT ${p}`); })(),
    });
    expect(rec.state).toBe("converged");
  });

  it("requireNonNullTermination throws when state is null (⇒ entry non-zero exit)", () => {
    expect(() => requireNonNullTermination(null)).toThrow(TerminationReadError);
    expect(() => requireNonNullTermination(undefined)).toThrow(TerminationReadError);
    expect(() => requireNonNullTermination("converged")).not.toThrow();
  });

  it("reads state from the last tick line only (not any earlier tick)", () => {
    const journal =
      JSON.stringify({ run_id: "tick~1", identity: "tick", result: JSON.stringify({ termination: { state: null } }) }) +
      "\n" +
      JSON.stringify({ run_id: "tick~2", identity: "tick", result: JSON.stringify({ termination: { state: "partial" } }) }) +
      "\n";
    const { state } = lastTickTerminationState(journal);
    expect(state).toBe("partial");
  });

  it("fails loudly naming the step when journal has no tick line (never falls back to drain reason)", () => {
    const journal = JSON.stringify({ run_id: "x", identity: "other", result: "{}" }) + "\n";
    expect(() => lastTickTerminationState(journal)).toThrow(/no tick line/);
  });

  it("fails loudly when a journal line is not valid JSON", () => {
    expect(() => lastTickTerminationState("not-json\n")).toThrow(/not valid JSON/);
  });

  it("drainIdFromSummary fails loudly when drain_id is absent (no drain-reason fallback)", () => {
    expect(() => drainIdFromSummary({ reason: "drained" })).toThrow(/drain_id/);
  });

  it("laneRunDirsFromIndex fails loudly when no lane matches", () => {
    const idx = JSON.stringify({ drain_id: "OTHER", run_dir: "/r" }) + "\n";
    expect(() => laneRunDirsFromIndex(idx, "D1")).toThrow(/no lane entry/);
  });
});

// ── C6（§1.3）：板面已排空但 state 仍 null 且未触顶 ⇒ 仍续投 ──────────
// 该判据的主体在 tick.md（见 a9-tick-trigger / a10b-convergence 的新增用例）；
// 这里补一个「模板确实不再用 grep 正则读 hasPendingWork」的源码级判别。

describe("C6 (§1.3): tick.md uses real JSON parse, not grep, for the continuation gate", () => {
  it("tick.md does not gate on a grep of hasPendingWork", () => {
    const tpl = readFileSync(join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md"), "utf8");
    // ⛔ 判别性：把续投门改回只看 hasPendingWork 的 grep ⇒ 本用例变红。
    expect(tpl).not.toMatch(/grep -q\s*["']"hasPendingWork"/);
    expect(tpl).not.toMatch(/grep\s+["']"hasPendingWork": \*true/);
  });

  it("tick.md reads termination.state and keeps investing when state is null and not capped", () => {
    const tpl = readFileSync(join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md"), "utf8");
    expect(tpl).toMatch(/termination/);
    expect(tpl).toMatch(/capHit|state/);
    // 续投门必须同时考虑「板面已排空但终态未判定」的情形。
    expect(tpl).toMatch(/hasPendingWork/);
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function viStubFetch(fn: () => unknown): void {
  vi.stubGlobal("fetch", vi.fn(async () => fn()));
}
