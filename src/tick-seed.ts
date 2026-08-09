/**
 * G4e —— 播种入口：把初始线索发布到研究板。
 *
 * 复用 src/bus.ts 的 publishClue，每条线索发一条 research.clue.v2，
 * status: "open"、depth: 0。idempotency key 由输入确定性派生，
 * 重复播种不会翻倍。
 */
import { createHash } from "node:crypto";
import { publishClue } from "./bus";
import type { ClueV2 } from "./protocol";

export class SeedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SeedError";
  }
}

export function buildSeedIdempotencyKey(
  channelId: string,
  index: number,
  clueText: string,
): string {
  const digest = createHash("sha256").update(clueText).digest("hex").slice(0, 16);
  return `dr-seed:${channelId}:${index}:${digest}`;
}

export interface SeedOptions {
  channelId: string;
  clues: string[];
  sources?: string[];
}

export interface SeedResult {
  channelId: string;
  published: number;
  messageIds: string[];
}

export interface SeedDeps {
  publishClue: typeof publishClue;
}

export async function runSeed(
  opts: SeedOptions,
  deps: SeedDeps = { publishClue },
): Promise<SeedResult> {
  if (opts.clues.length === 0) {
    throw new SeedError(
      "G4e: --seed requires at least one --clue. Refusing to seed zero clues.",
    );
  }

  const sources = opts.sources ?? [];
  const messageIds: string[] = [];

  for (let i = 0; i < opts.clues.length; i++) {
    const clue: ClueV2 = {
      text: opts.clues[i],
      status: "open",
      depth: 0,
      sources,
    };
    const key = buildSeedIdempotencyKey(opts.channelId, i, opts.clues[i]);
    try {
      const result = await deps.publishClue(opts.channelId, clue, key);
      messageIds.push(result.message_id);
    } catch (err) {
      if ((err as Record<string, unknown>)?.status === 404) {
        throw new SeedError(
          `G4e: channel "${opts.channelId}" not found (404). Refusing to implicitly create it.`,
        );
      }
      throw err;
    }
  }

  return {
    channelId: opts.channelId,
    published: messageIds.length,
    messageIds,
  };
}

export function parseSeedCliArgs(
  args: string[],
): { channelId: string; clues: string[]; sources: string[] } {
  const channelId = args[0];
  if (!channelId) {
    throw new SeedError(
      "G4e: --seed requires a <channel_id>. Refusing to seed without a target channel.",
    );
  }

  const clues: string[] = [];
  const sources: string[] = [];

  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--clue") {
      const clue = args[i + 1];
      if (clue === undefined || clue === "") {
        throw new SeedError(
          "G4e: --clue requires a non-empty clue text.",
        );
      }
      clues.push(clue);
      i += 1;
    } else if (args[i] === "--source") {
      const source = args[i + 1];
      if (source === undefined || source === "") {
        throw new SeedError(
          "G4e: --source requires a non-empty name.",
        );
      }
      sources.push(source);
      i += 1;
    }
  }

  if (clues.length === 0) {
    throw new SeedError(
      "G4e: --seed requires at least one --clue. Refusing to seed zero clues.",
    );
  }

  return { channelId, clues, sources };
}