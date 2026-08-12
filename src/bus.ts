/**
 * agent-bus HTTP 客户端封装
 *
 * 所有 mutation 必带 idempotency_key（否则 400）。
 * 读写 agent-bus 的 HTTP API (127.0.0.1:7490)。
 *
 * E0c（GT-1 / GT-2）——两个 channel 端点的字段集不同：
 *   GET /v1/channels/<id>  → channel_id, closed_at, created_at, default_lease_ms,
 *                            delivery_mode, max_attempts, metadata, owner_agent_id,
 *                            refs_required, visibility          ← ⛔ 没有 head_seq
 *   GET /v1/channels       → channel_id, closed_at, created_at, delivery_mode,
 *                            head_seq, owner_agent_id, visibility ← head_seq 只在这里
 * 列表会把**已创建但为空**的 channel 以 head_seq: 0 列出（不是省略）。
 * ⛔ 凡读 head_seq 一律走列表端点 + 真 JSON 解析（GT-2），禁止从单行 JSON 用贪婪正则抽多值。
 */
import type { ClueV2, EvidenceV2, DocV2 } from "./protocol";
import { readFileSync } from "node:fs";

// A10b —— agent-bus 基址可用 AGENT_BUS_URL 覆盖（默认本机 7490）。
// 显式覆盖保持既有语义：默认仍是 127.0.0.1:7490，不覆盖时行为不变。
const BASE_URL = process.env.AGENT_BUS_URL ?? "http://127.0.0.1:7490";
// E0 —— 凭证路径可用 AGENT_BUS_TOKEN_FILE 覆盖（与 agent-runtime 的 src/agent-bus.ts:56 同名同义）。
// ⛔ 未设置该变量时行为逐字不变：仍读 /data/agent-bus/tokens/uther-tui.token。
const TOKEN_PATH =
  process.env.AGENT_BUS_TOKEN_FILE ?? "/data/agent-bus/tokens/uther-tui.token";

let _cachedToken: string | null = null;

function token(): string {
  if (_cachedToken === null) {
    let raw: string;
    try {
      raw = readFileSync(TOKEN_PATH, "utf-8").trim();
    } catch (err) {
      // E0 —— 凭证读取失败必须响亮失败并点名变量与解析到的路径，⛔ 不回退默认路径。
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(
        `AGENT_BUS_TOKEN_FILE: failed to read token file at '${TOKEN_PATH}' (${detail})`,
      );
    }
    if (!raw) {
      // E0 —— 空凭证同样响亮失败，⛔ 不返回空 token 继续跑（宪法第四条：失败必须现形）。
      throw new Error(
        `AGENT_BUS_TOKEN_FILE: token file at '${TOKEN_PATH}' is empty; refusing to continue with an empty token`,
      );
    }
    _cachedToken = raw;
  }
  return _cachedToken;
}

/** agent-bus HTTP 错误，携带数值状态码（用于 D1 的错误分类）。 */
export class BusError extends Error {
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

/**
 * E0c（GT-1）——列表端点的单条 channel 最小视图。
 * ⛔ head_seq **只**出现在 `GET /v1/channels` 列表端点；单 channel GET 没有。
 */
export interface ListChannel {
  channel_id: string;
  head_seq: number;
  /** 其余字段（created_at / delivery_mode / visibility / …）逐字透传，不作假设。 */
  [key: string]: unknown;
}

/**
 * E0c（GT-1 / GT-2）——读 `GET /v1/channels` 列表端点，返回全部 channel（含 head_seq）。
 * ⛔ 用真 JSON 解析（resp.json()），不做任何正则抽取；列表会把已创建但为空的 channel 以
 *    head_seq: 0 列出，不是省略。
 */
export async function listChannels(): Promise<ListChannel[]> {
  const resp = await busFetch("/v1/channels");
  const data = (await resp.json()) as { channels?: unknown[] } | unknown[];
  const arr = Array.isArray(data)
    ? data
    : Array.isArray((data as { channels?: unknown[] })?.channels)
      ? (data as { channels: unknown[] }).channels
      : [];
  return arr as ListChannel[];
}

/**
 * E0c（GT-1）——从**列表端点**按 channel_id 定位并取该 channel 的 head_seq。
 * ⛔ 找不到该 channel，或该 channel 项上没有 head_seq 字段 ⇒ **响亮失败**并点名 channel 与
 *    实际拿到的字段集，⛔ 不得当作 0 继续。
 */
export async function channelHeadSeq(channelId: string): Promise<number> {
  const channels = await listChannels();
  const found = channels.find((c) => c.channel_id === channelId);
  if (!found) {
    const actual = channels.map((c) => c.channel_id);
    throw new Error(
      `E0c GT-1: channel "${channelId}" not found in GET /v1/channels list. Actual channel_ids present: [${actual.join(", ")}]. Refusing to treat head_seq as 0.`,
    );
  }
  if (typeof found.head_seq !== "number") {
    const fields = Object.keys(found);
    throw new Error(
      `E0c GT-1: channel "${channelId}" in GET /v1/channels list has no head_seq field. Actual fields: [${fields.join(", ")}]. Refusing to treat head_seq as 0.`,
    );
  }
  return found.head_seq;
}

/**
 * E0c（GT-2）——生产总线 `sum(head_seq)`：对列表里**所有** channel 的 head_seq 求和。
 * ⛔ 是真实全量求和：遍历整个列表，逐项取 head_seq（真 JSON 解析，不抽正则在单行 JSON 抽多值）。
 * ⛔ 任一 channel 缺 head_seq 字段 ⇒ 响亮失败点名（不得当作 0 静默参与求和）。
 */
export async function sumAllHeadSeqs(): Promise<number> {
  const channels = await listChannels();
  let sum = 0;
  for (const c of channels) {
    if (typeof c.head_seq !== "number") {
      const fields = Object.keys(c);
      throw new Error(
        `E0c GT-2: channel "${c.channel_id}" in GET /v1/channels list has no head_seq field. Actual fields: [${fields.join(", ")}]. Refusing to silently contribute 0 to the production-bus sum.`,
      );
    }
    sum += c.head_seq;
  }
  return sum;
}

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