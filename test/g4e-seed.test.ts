/**
 * G4e —— 播种入口硬验收测试（spec §2 X1–X5）。
 *
 * 每个 describe 对应一个判据 ID。
 * 驱动生产的 runSeed，用假 bus 记录 publish 调用。
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runSeed,
  buildSeedIdempotencyKey,
  parseSeedCliArgs,
  SeedError,
  type SeedDeps,
} from "../src/tick-seed";
import { main } from "../src/tick-entry";
import type { ClueV2 } from "../src/protocol";

function fakePublishDeps(): {
  deps: SeedDeps;
  calls: Array<{ channelId: string; clue: ClueV2; key: string }>;
} {
  const calls: Array<{ channelId: string; clue: ClueV2; key: string }> = [];
  const deps: SeedDeps = {
    publishClue: vi.fn(
      async (channelId: string, clue: ClueV2, key: string) => {
        calls.push({ channelId, clue: { ...clue }, key });
        return { message_id: `msg-${calls.length}`, channel_seq: calls.length };
      },
    ),
  };
  return { deps, calls };
}

function fakePublishDeps404(): SeedDeps {
  return {
    publishClue: vi.fn(async () => {
      const err = new Error("bus POST /v1/channels/nonexistent/publish: 404 {") as any;
      err.status = 404;
      throw err;
    }),
  };
}

describe("G4e X1: seeding N clues really publishes N research.clue.v2", () => {
  it("publishes 3 clues with correct status=open, depth=0, text verbatim", async () => {
    const { deps, calls } = fakePublishDeps();
    const result = await runSeed(
      { channelId: "research:test", clues: ["clue A", "clue B", "clue C"], sources: ["code-local"] },
      deps,
    );
    expect(result.published).toBe(3);
    expect(calls).toHaveLength(3);
    for (let i = 0; i < calls.length; i++) {
      const c = calls[i];
      expect(c.channelId).toBe("research:test");
      expect(c.clue.status).toBe("open");
      expect(c.clue.depth).toBe(0);
      expect(c.clue.text).toBe(["clue A", "clue B", "clue C"][i]);
    }
  });

  it("publishes clues with sources when provided", async () => {
    const { deps, calls } = fakePublishDeps();
    await runSeed(
      {
        channelId: "research:test",
        clues: ["clue X"],
        sources: ["code-local", "web"],
      },
      deps,
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].clue.sources).toEqual(["code-local", "web"]);
  });

  it("E0c1 GT-2: seeding without --source fails loudly (no silent sources:[] clue)", async () => {
    const { deps } = fakePublishDeps();
    await expect(
      runSeed({ channelId: "research:test", clues: ["clue Y"] }, deps),
    ).rejects.toThrow(SeedError);
    await expect(
      runSeed({ channelId: "research:test", clues: ["clue Y"] }, deps),
    ).rejects.toThrow(/--source/);
    // ⛔ 不静默播种：publishClue 不被调用。
    expect(deps.publishClue).not.toHaveBeenCalled();
  });

  it("E0c1 GT-2: seeding with explicit empty sources array also fails loudly", async () => {
    const { deps } = fakePublishDeps();
    await expect(
      runSeed({ channelId: "research:test", clues: ["clue Z"], sources: [] }, deps),
    ).rejects.toThrow(SeedError);
    expect(deps.publishClue).not.toHaveBeenCalled();
  });
});

describe("G4e X2: idempotency — same clues twice ⇒ same keys", () => {
  it("two runs of same clues produce identical key sequences", async () => {
    const clues = ["clue 1", "clue 2", "clue 3"];
    const channelId = "research:test";

    const { deps: deps1, calls: calls1 } = fakePublishDeps();
    await runSeed({ channelId, clues, sources: ["code-local"] }, deps1);

    const { deps: deps2, calls: calls2 } = fakePublishDeps();
    await runSeed({ channelId, clues, sources: ["code-local"] }, deps2);

    expect(calls1).toHaveLength(3);
    expect(calls2).toHaveLength(3);
    for (let i = 0; i < 3; i++) {
      expect(calls2[i].key).toBe(calls1[i].key);
    }
  });

  it("idempotency key is deterministic from input", () => {
    const key1 = buildSeedIdempotencyKey("ch", 0, "hello");
    const key2 = buildSeedIdempotencyKey("ch", 0, "hello");
    expect(key1).toBe(key2);
  });

  it("different clues produce different keys", () => {
    const keyA = buildSeedIdempotencyKey("ch", 0, "hello");
    const keyB = buildSeedIdempotencyKey("ch", 0, "world");
    expect(keyA).not.toBe(keyB);
  });

  it("different indexes produce different keys", () => {
    const keyA = buildSeedIdempotencyKey("ch", 0, "same");
    const keyB = buildSeedIdempotencyKey("ch", 1, "same");
    expect(keyA).not.toBe(keyB);
  });

  it("different channels produce different keys", () => {
    const keyA = buildSeedIdempotencyKey("ch-a", 0, "same");
    const keyB = buildSeedIdempotencyKey("ch-b", 0, "same");
    expect(keyA).not.toBe(keyB);
  });
});

describe("G4e X3: channel not found ⇒ loud failure, no channel creation", () => {
  it("404 from publishClue throws SeedError naming the channel", async () => {
    const deps = fakePublishDeps404();
    await expect(
      runSeed({ channelId: "nonexistent", clues: ["clue"], sources: ["code-local"] }, deps),
    ).rejects.toThrow(SeedError);
    await expect(
      runSeed({ channelId: "nonexistent", clues: ["clue"], sources: ["code-local"] }, deps),
    ).rejects.toThrow(/nonexistent/);
  });

  it("publishClue is called exactly once before throwing (no automatic creation)", async () => {
    const deps = fakePublishDeps404();
    await expect(
      runSeed({ channelId: "nonexistent", clues: ["clue"], sources: ["code-local"] }, deps),
    ).rejects.toThrow(SeedError);
    expect(deps.publishClue).toHaveBeenCalledTimes(1);
  });
});

describe("G4e X4: zero clues ⇒ non-zero exit, not 'published 0 and success'", () => {
  it("empty clues array throws SeedError", async () => {
    const { deps } = fakePublishDeps();
    await expect(
      runSeed({ channelId: "research:test", clues: [] }, deps),
    ).rejects.toThrow(SeedError);
    await expect(
      runSeed({ channelId: "research:test", clues: [] }, deps),
    ).rejects.toThrow(/zero clues/);
  });

  it("zero clues does not call publishClue", async () => {
    const { deps } = fakePublishDeps();
    await expect(
      runSeed({ channelId: "research:test", clues: [] }, deps),
    ).rejects.toThrow(SeedError);
    expect(deps.publishClue).not.toHaveBeenCalled();
  });

  it("parseSeedCliArgs with no --clue throws SeedError", () => {
    expect(() => parseSeedCliArgs(["research:test"])).toThrow(SeedError);
    expect(() => parseSeedCliArgs(["research:test"])).toThrow(/zero clues/);
  });

  it("parseSeedCliArgs with missing channel throws SeedError", () => {
    expect(() => parseSeedCliArgs([])).toThrow(SeedError);
    expect(() => parseSeedCliArgs([])).toThrow(/channel/);
  });
});

describe("G4e X4: --seed CLI branch exits non-zero on loud failure", () => {
  it("main --seed with zero clues returns exit code 2", async () => {
    const exitCode = await main(["--seed", "research:test"]);
    expect(exitCode).toBe(2);
  });

  it("main --seed with missing channel returns exit code 2", async () => {
    const exitCode = await main(["--seed"]);
    expect(exitCode).toBe(2);
  });
});

describe("G4e X5: --seed visible in --help and npm scripts", () => {
  it("main --help output contains --seed", async () => {
    const chunks: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const exitCode = await main(["--help"]);
      expect(exitCode).toBe(0);
      const output = chunks.join("");
      expect(output).toContain("--seed");
    } finally {
      spy.mockRestore();
    }
  });

  it("main -h output contains --seed", async () => {
    const chunks: string[] = [];
    const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => {
      chunks.push(String(chunk));
      return true;
    });
    try {
      const exitCode = await main(["-h"]);
      expect(exitCode).toBe(0);
      expect(chunks.join("")).toContain("--seed");
    } finally {
      spy.mockRestore();
    }
  });

  it("package.json contains tick:seed script", () => {
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
    expect(pkg.scripts).toHaveProperty("tick:seed");
  });
});