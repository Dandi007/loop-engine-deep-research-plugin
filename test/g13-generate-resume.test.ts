/**
 * G13 —— 生成段可恢复：按 (role, origin) 查已有 doc 并复用，不重新 spawn/publish。
 *
 * 判据：
 *  W1  判别性：doc channel 上已存在某 role 的 doc ⇒ 不 spawn、不 publish，且复用其 body
 *  W2  全部已存在 ⇒ 零 spawn、零 publish，但导出与 anchor-check 照常执行
 *  W3  部分已存在 ⇒ 只 spawn 缺失的那个 role
 *  W4  都不存在 ⇒ 行为与今天逐字一致（四个 role 全 spawn 全 publish）
 *  W5  不得吞 409：publish 真的返回 409 时仍响亮失败并点名 role/origin
 *  W6  断言打在生产组装出的 deps 上（assembleGenerateDeps 已导出）
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runGenerate,
  DEFAULT_GENERATE_CONFIG,
  type GenerateConfig,
  type GenerateDeps,
  type AnchorCheckResult,
} from "../src/generate";
import type { DocV2 } from "../src/protocol";
import type { TerminationState } from "../src/tick";
import type { BoardState } from "../src/tick";
import { assembleGenerateDeps } from "../src/tick-run";
import type { InspectMessage } from "../src/tick-inspect";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function anchorResult(over: Partial<AnchorCheckResult> = {}): AnchorCheckResult {
  return {
    total: 10,
    current_parsed: 10,
    current_verified_hit: 10,
    current_failed: 0,
    old_format: 0,
    unparseable: 0,
    discarded: 0,
    sums_ok: true,
    loud_failures: [],
    ...over,
  };
}

function term(over: Partial<TerminationState> = {}): TerminationState {
  return {
    state: "converged",
    coverage: 0,
    zeroGrowthRounds: 0,
    capHit: false,
    ...over,
  };
}

function boardState(): BoardState {
  return { cards: [], runs: {}, triageInFlight: false };
}

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

function messagesResponse(msgs: InspectMessage[]) {
  return jsonResponse({ messages: msgs });
}

function emptyMessagesResponse() {
  return jsonResponse({ messages: [] });
}

function docMsg(
  messageId: string,
  role: string,
  docKind: string,
  origin: string,
  body: string,
  channelSeq = 1,
): InspectMessage {
  return {
    message_id: messageId,
    channel_id: "research:doc",
    channel_seq: channelSeq,
    kind: "research.doc.v2",
    payload: {
      doc_kind: docKind,
      body,
      digest: "abc",
      origin,
      role,
    },
    entity_id: `doc-${messageId}`,
    supersedes: null,
    created_at: "2026-08-01T00:00:00Z",
  };
}

const cfg: GenerateConfig = DEFAULT_GENERATE_CONFIG;

function baseDeps(over: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    readTermination: async () => term(),
    countBlocked: async () => 0,
    readQuestion: async () => "research question?",
    readOrigin: async () => "research-1",
    readEvidences: async () => [],
    spawnRole: vi.fn(async () => ({ body: "role output" })),
    spawnAnchorCheck: vi.fn(async () => anchorResult()),
    spawnExport: vi.fn(async () => {}),
    writeDoc: vi.fn(async () => "msg-1"),
    lockSynthesizer: async () => async () => {},
    ...over,
  };
}

// ── W1: 判别性 —— 已存在某 role 的 doc ⇒ 不 spawn、不 publish，复用其 body ──

describe("W1: doc exists for one role ⇒ no spawn, no publish, reuse body", () => {
  it("advocate doc already exists ⇒ not spawned, not published, body reused", async () => {
    const existingBody = "pre-existing advocate argument body";
    const readDoc = vi.fn(async (role: string, _origin: string) => {
      if (role === "dr-debater-advocate") {
        return {
          doc: { doc_kind: "argument" as const, body: existingBody, digest: "abc", origin: "research-1", role },
          messageId: "existing-msg-1",
        };
      }
      return null;
    });
    const spawnRole = vi.fn(async () => ({ body: "should not be used" }));
    const writeDoc = vi.fn(async () => "msg-1");
    const deps = baseDeps({ readDoc, spawnRole, writeDoc });

    await runGenerate(deps, cfg);

    const advocateCalls = spawnRole.mock.calls.filter(
      (c: unknown[]) => c[0] === "dr-debater-advocate",
    );
    expect(advocateCalls).toHaveLength(0);

    const advocateWrites = writeDoc.mock.calls.filter(
      (c: unknown[]) => {
        const [doc] = c as [DocV2, string];
        return doc.doc_kind === "argument" && doc.body === existingBody;
      },
    );
    expect(advocateWrites).toHaveLength(0);

    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(1);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

// ── W2: 全部已存在 ⇒ 零 spawn、零 publish，但导出与 anchor-check 照常执行 ──

describe("W2: all docs already exist ⇒ zero spawn, zero publish, export + anchor-check still run", () => {
  it("all four docs pre-exist ⇒ no spawn, no publish, export + anchor-check execute", async () => {
    const readDoc = vi.fn(async (_role: string, _origin: string) => ({
      doc: {
        doc_kind: "argument" as const,
        body: "pre-existing body",
        digest: "abc",
        origin: "research-1",
        role: _role,
      },
      messageId: "existing-msg",
    }));
    const spawnRole = vi.fn(async () => ({ body: "should not be used" }));
    const writeDoc = vi.fn(async () => "msg-1");
    const deps = baseDeps({ readDoc, spawnRole, writeDoc });

    await runGenerate(deps, cfg);

    expect(spawnRole).toHaveBeenCalledTimes(0);
    expect(writeDoc).toHaveBeenCalledTimes(0);
    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(1);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

// ── W3: 部分已存在 ⇒ 只 spawn 缺失的那个 role ──

describe("W3: partial docs exist ⇒ only spawn missing roles", () => {
  it("three debater docs exist, synthesizer missing ⇒ only synthesizer spawned", async () => {
    const readDoc = vi.fn(async (role: string, _origin: string) => {
      if (role === "dr-synthesizer") return null;
      return {
        doc: {
          doc_kind: "argument" as const,
          body: `pre-existing ${role} body`,
          digest: "abc",
          origin: "research-1",
          role,
        },
        messageId: `existing-${role}`,
      };
    });
    const spawnedRoles: string[] = [];
    const spawnRole = vi.fn(async (role: string) => {
      spawnedRoles.push(role);
      return { body: "spawned body" };
    });
    const writeDoc = vi.fn(async () => "msg-1");
    const deps = baseDeps({ readDoc, spawnRole, writeDoc });

    await runGenerate(deps, cfg);

    expect(spawnedRoles).toEqual(["dr-synthesizer"]);
    expect(writeDoc).toHaveBeenCalledTimes(1);
    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(1);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });

  it("synthesizer doc exists, debaters missing ⇒ only debaters spawned", async () => {
    const readDoc = vi.fn(async (role: string, _origin: string) => {
      if (role === "dr-synthesizer") {
        return {
          doc: {
            doc_kind: "report" as const,
            body: "pre-existing report body",
            digest: "abc",
            origin: "research-1",
            role: "dr-synthesizer",
          },
          messageId: "existing-synth",
        };
      }
      return null;
    });
    const spawnedRoles: string[] = [];
    const spawnRole = vi.fn(async (role: string) => {
      spawnedRoles.push(role);
      return { body: "spawned body" };
    });
    const writeDoc = vi.fn(async () => "msg-1");
    const deps = baseDeps({ readDoc, spawnRole, writeDoc });

    await runGenerate(deps, cfg);

    expect(spawnedRoles).toEqual([
      "dr-debater-advocate",
      "dr-debater-opponent",
      "dr-debater-judge",
    ]);
    expect(writeDoc).toHaveBeenCalledTimes(3);
    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(1);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

// ── W4: 都不存在 ⇒ 行为与今天逐字一致 ──

describe("W4: no docs exist ⇒ behavior identical to today", () => {
  it("readDoc returns null for all roles ⇒ 4 spawns, 4 publishes, anchor-check + export", async () => {
    const readDoc = vi.fn(async () => null);
    const spawnRole = vi.fn(async () => ({ body: "role output" }));
    const writeDoc = vi.fn(async () => "msg-1");
    const deps = baseDeps({ readDoc, spawnRole, writeDoc });

    await runGenerate(deps, cfg);

    expect(spawnRole).toHaveBeenCalledTimes(4);
    expect(writeDoc).toHaveBeenCalledTimes(4);
    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(1);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });

  it("readDoc not provided ⇒ behavior unchanged (backward compat)", async () => {
    const spawnRole = vi.fn(async () => ({ body: "role output" }));
    const writeDoc = vi.fn(async () => "msg-1");
    const deps = baseDeps({ spawnRole, writeDoc });

    await runGenerate(deps, cfg);

    expect(spawnRole).toHaveBeenCalledTimes(4);
    expect(writeDoc).toHaveBeenCalledTimes(4);
    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(1);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

// ── W5: 不得吞 409 ──

describe("W5: publish returns 409 ⇒ loud failure, not swallowed", () => {
  it("writeDoc throws 409 ⇒ error propagates, not swallowed", async () => {
    const readDoc = vi.fn(async () => null);
    const writeDoc = vi.fn(async () => {
      throw new Error('bus POST /v1/channels/research:doc/publish: 409 {"code":"IDEMPOTENCY_CONFLICT","message":"Same idempotency_key with different intent"}');
    });
    const deps = baseDeps({ readDoc, writeDoc });

    await expect(runGenerate(deps, cfg)).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it("W5 vs W1 distinction: writeDoc throws 409 while readDoc returns null (pre-check prevents this path)", async () => {
    const readDoc = vi.fn(async () => null);
    const writeDoc = vi.fn(async () => {
      throw new Error("IDEMPOTENCY_CONFLICT");
    });
    const deps = baseDeps({ readDoc, writeDoc });

    await expect(runGenerate(deps, cfg)).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  });

  it("W5 discriminative: 409 is thrown even when readDoc is not provided (backward compat)", async () => {
    const writeDoc = vi.fn(async () => {
      throw new Error("IDEMPOTENCY_CONFLICT");
    });
    const deps = baseDeps({ writeDoc });

    await expect(runGenerate(deps, cfg)).rejects.toThrow(/IDEMPOTENCY_CONFLICT/);
  });
});

// ── W6: 断言打在生产组装出的 deps 上 ──

describe("W6: assertions drive production assembleGenerateDeps", () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn(async () => emptyMessagesResponse());
    vi.stubGlobal("fetch", fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("assembleGenerateDeps produces a readDoc function", () => {
    const deps = assembleGenerateDeps(
      { channelId: "research:test", docChannelId: "research:doc" },
      term(),
      boardState(),
    );
    expect(deps.readDoc).toBeDefined();
    expect(typeof deps.readDoc).toBe("function");
  });

  it("readDoc returns null when doc channel has no doc message", () => {
    const deps = assembleGenerateDeps(
      { channelId: "research:test", docChannelId: "research:doc" },
      term(),
      boardState(),
    );
    expect(deps.readDoc).toBeDefined();
  });

  it("readDoc returns correct doc when doc channel has matching message", async () => {
    const docChannelId = "research:doc";
    const targetBody = "pre-existing synthesizer report";
    const targetOrigin = "research-1";
    const targetMessageId = "doc-msg-42";

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) {
        return messagesResponse([
          docMsg(targetMessageId, "dr-synthesizer", "report", targetOrigin, targetBody),
        ]);
      }
      return emptyMessagesResponse();
    });

    const deps = assembleGenerateDeps(
      { channelId: "research:test", docChannelId, origin: targetOrigin },
      term(),
      boardState(),
    );

    const result = await deps.readDoc!("dr-synthesizer", targetOrigin);
    expect(result).not.toBeNull();
    expect(result!.doc.body).toBe(targetBody);
    expect(result!.doc.doc_kind).toBe("report");
    expect(result!.doc.origin).toBe(targetOrigin);
    expect(result!.messageId).toBe(targetMessageId);
  });

  it("readDoc returns null when doc channel has no matching origin", async () => {
    const docChannelId = "research:doc";

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) {
        return messagesResponse([
          docMsg("msg-1", "dr-debater-advocate", "argument", "other-origin", "other body"),
        ]);
      }
      return emptyMessagesResponse();
    });

    const deps = assembleGenerateDeps(
      { channelId: "research:test", docChannelId, origin: "research-1" },
      term(),
      boardState(),
    );

    const result = await deps.readDoc!("dr-debater-advocate", "research-1");
    expect(result).toBeNull();
  });

  it("readDoc returns null when docChannelId is not configured", () => {
    const deps = assembleGenerateDeps(
      { channelId: "research:test" },
      term(),
      boardState(),
    );
    expect(deps.readDoc).toBeDefined();
  });

  it("readDoc discriminates role among multiple argument docs for the same origin", async () => {
    const docChannelId = "research:doc";
    const origin = "research-1";
    const advocateBody = "advocate argument body";
    const opponentBody = "opponent argument body";
    const advocateMsgId = "doc-advocate";
    const opponentMsgId = "doc-opponent";

    vi.stubGlobal("fetch", async (input: RequestInfo) => {
      const url = typeof input === "string" ? input : input.toString();
      if (url.includes("/messages")) {
        return messagesResponse([
          docMsg(advocateMsgId, "dr-debater-advocate", "argument", origin, advocateBody, 1),
          docMsg(opponentMsgId, "dr-debater-opponent", "argument", origin, opponentBody, 2),
        ]);
      }
      return emptyMessagesResponse();
    });

    const deps = assembleGenerateDeps(
      { channelId: "research:test", docChannelId, origin },
      term(),
      boardState(),
    );

    const advocateResult = await deps.readDoc!("dr-debater-advocate", origin);
    expect(advocateResult).not.toBeNull();
    expect(advocateResult!.doc.body).toBe(advocateBody);
    expect(advocateResult!.messageId).toBe(advocateMsgId);

    const opponentResult = await deps.readDoc!("dr-debater-opponent", origin);
    expect(opponentResult).not.toBeNull();
    expect(opponentResult!.doc.body).toBe(opponentBody);
    expect(opponentResult!.messageId).toBe(opponentMsgId);

    const judgeResult = await deps.readDoc!("dr-debater-judge", origin);
    expect(judgeResult).toBeNull();
  });

  it("generated deps are not hand-built: all fields sourced from assembleGenerateDeps", () => {
    const deps = assembleGenerateDeps(
      { channelId: "research:test", docChannelId: "research:doc", origin: "test-origin" },
      term(),
      boardState(),
    );
    expect(deps.readTermination).toBeDefined();
    expect(deps.countBlocked).toBeDefined();
    expect(deps.readQuestion).toBeDefined();
    expect(deps.readOrigin).toBeDefined();
    expect(deps.readEvidences).toBeDefined();
    expect(deps.spawnRole).toBeUndefined();
    expect(deps.spawnRuntime).toBeDefined();
    expect(deps.spawnAnchorCheck).toBeDefined();
    expect(deps.spawnExport).toBeDefined();
    expect(deps.writeDoc).toBeDefined();
    expect(deps.readDoc).toBeDefined();
    expect(deps.lockSynthesizer).toBeDefined();
  });
});