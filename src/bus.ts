/**
 * agent-bus HTTP 客户端封装
 *
 * 所有 mutation 必带 idempotency_key（否则 400）。
 * 读写 agent-bus 的 HTTP API (127.0.0.1:7490)。
 */
import type { ClueV2, EvidenceV2, DocV2 } from "./protocol";
import { readFileSync } from "node:fs";

// A10b —— agent-bus 基址可用 AGENT_BUS_URL 覆盖（默认本机 7490）。
// 显式覆盖保持既有语义：默认仍是 127.0.0.1:7490，不覆盖时行为不变。
const BASE_URL = process.env.AGENT_BUS_URL ?? "http://127.0.0.1:7490";
const TOKEN_PATH = "/data/agent-bus/tokens/uther-tui.token";

let _cachedToken: string | null = null;

function token(): string {
  if (_cachedToken === null) {
    _cachedToken = readFileSync(TOKEN_PATH, "utf-8").trim();
  }
  return _cachedToken;
}

/** agent-bus HTTP 错误，携带数值状态码（用于 D1 的错误分类）。 */
class BusError extends Error {
  status: number;
  constructor(method: string, path: string, status: number, body: string) {
    super(`bus ${method} ${path}: ${status} ${body.slice(0, 200)}`);
    this.status = status;
  }
}

async function busFetch(
  path: string,
  options: RequestInit = {},
): Promise<Response> {
  const url = `${BASE_URL}${path}`;
  const headers = {
    Authorization: `Bearer ${token()}`,
    "Content-Type": "application/json",
    ...(options.headers as Record<string, string> | undefined),
  };
  const resp = await fetch(url, { ...options, headers });
  if (!resp.ok) {
    const body = await resp.text();
    throw new BusError(options.method ?? "GET", path, resp.status, body);
  }
  return resp;
}

// ── 消息结构 ──

interface BusMessage {
  message_id: string;
  channel_id: string;
  channel_seq: number;
  kind: string;
  payload: unknown;
  entity_id: string;
  supersedes: string | null;
  created_at: string;
}

interface PublishRequest {
  kind: string;
  payload: unknown;
  idempotency_key: string;
  entity_id?: string;
  supersedes?: string;
}

interface PublishResponse {
  message_id: string;
  channel_seq: number;
  deduplicated?: boolean;
}

// ── 读 ──

/** 获取 channel 消息（分页，增量） */
export async function getMessages(
  channelId: string,
  opts: { limit?: number; afterSeq?: number } = {},
): Promise<BusMessage[]> {
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 100));
  if (opts.afterSeq !== undefined) params.set("after_seq", String(opts.afterSeq));
  const resp = await busFetch(
    `/v1/channels/${channelId}/messages?${params}`,
  );
  const data = await resp.json();
  return data.messages ?? [];
}

/** 获取 entity 的最新版本（D2：仅 404 视为“不存在”，其余读取失败向上抛）。 */
export async function getEntity(entityId: string): Promise<BusMessage | null> {
  try {
    const resp = await busFetch(`/v1/entities/${entityId}`);
    const data = await resp.json();
    return data.head ?? null;
  } catch (err: any) {
    if (err.status === 404) {
      return null;
    }
    throw err;
  }
}

// ── 写 ──

/** 发布消息到 channel */
export async function publish(
  channelId: string,
  req: PublishRequest,
): Promise<PublishResponse> {
  const resp = await busFetch(`/v1/channels/${channelId}/publish`, {
    method: "POST",
    body: JSON.stringify(req),
  });
  return await resp.json();
}

/** 发布 clue.v2 */
export async function publishClue(
  channelId: string,
  clue: ClueV2,
  idempotencyKey: string,
): Promise<PublishResponse> {
  return publish(channelId, {
    kind: "research.clue.v2",
    payload: clue,
    idempotency_key: idempotencyKey,
  });
}

/** 发布 evidence.v2 */
export async function publishEvidence(
  channelId: string,
  evidence: EvidenceV2,
  idempotencyKey: string,
): Promise<PublishResponse> {
  return publish(channelId, {
    kind: "research.evidence.v2",
    payload: evidence,
    idempotency_key: idempotencyKey,
  });
}

/** 发布 doc.v2 */
export async function publishDoc(
  channelId: string,
  doc: DocV2,
  idempotencyKey: string,
): Promise<PublishResponse> {
  return publish(channelId, {
    kind: "research.doc.v2",
    payload: doc,
    idempotency_key: idempotencyKey,
  });
}

// ── CAS Revision ──

interface CASResult {
  success: boolean;
  messageId?: string;
  error?: "conflict" | "invalid_payload" | "entity_not_found";
}

/**
 * CAS 认领 clue: open → in_flight
 *
 * 硬不变量：前置条件必须在「你所 supersede 的那一版」上求值。
 * 同源读 ⇒ 互斥成立；分属两次读 ⇒ CAS 退化成防丢失更新。
 *
 * @param channelId  clue 板 channel
 * @param entityId   clue 的 entity_id
 * @param head       当前 head 消息（含 channel_seq 作为 supersedes 基准）
 * @param update     要写入的更新 payload
 * @param idempotencyKey
 * @returns CASResult
 */
export async function casUpdateClue(
  channelId: string,
  entityId: string,
  head: BusMessage,
  update: Partial<ClueV2>,
  idempotencyKey: string,
): Promise<CASResult> {
  // 从 head 重建完整 payload，再合并 update
  const currentPayload = head.payload as ClueV2;
  const newPayload: ClueV2 = { ...currentPayload, ...update };

  try {
    const result = await publish(channelId, {
      kind: "research.clue.v2",
      payload: newPayload,
      idempotency_key: idempotencyKey,
      entity_id: entityId,
      supersedes: head.message_id,
    });
    return { success: true, messageId: result.message_id };
  } catch (err: any) {
    if (err.status === 409) {
      return { success: false, error: "conflict" };
    }
    if (err.status === 400 || err.status === 422) {
      return { success: false, error: "invalid_payload" };
    }
    throw err;
  }
}

/**
 * 认领原语：claim(clueId) → CAS open→in_flight
 *
 * 1. 读 head（entity 最新版）
 * 2. 验证 status === "open"
 * 3. CAS 更新 status→in_flight, assignee, run_id
 *
 * @returns CASResult
 */
export async function claimClue(
  channelId: string,
  entityId: string,
  assignee: string,
  runId: string,
  idempotencyKey: string,
): Promise<CASResult> {
  const head = await getEntity(entityId);
  if (!head) {
    return { success: false, error: "entity_not_found" };
  }

  const payload = head.payload as ClueV2;
  if (payload.status !== "open") {
    // 不是 open 状态，不能认领（409 语义——别人抢先了）
    return { success: false, error: "conflict" };
  }

  return casUpdateClue(channelId, entityId, head, {
    status: "in_flight",
    assignee,
    run_id: runId,
  }, idempotencyKey);
}

// ── 增量板面读取 ──

/**
 * 增量读板：作为 fanout 订阅者，用 cursor 推进。
 * 返回 (新消息, 新 cursor)。
 */
export async function incrementalRead(
  channelId: string,
  cursor: number | null,
): Promise<{ messages: BusMessage[]; cursor: number }> {
  const messages = await getMessages(
    channelId,
    cursor !== null ? { afterSeq: cursor, limit: 100 } : { limit: 100 },
  );
  const newCursor =
    messages.length > 0
      ? messages[messages.length - 1].channel_seq
      : cursor ?? 0;
  return { messages, cursor: newCursor };
}