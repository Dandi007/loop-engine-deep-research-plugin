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
 * E0c1 GT-1 —— channel 列表项的最小视图。
 *
 * 真机 bus 的两个 channel 端点**字段集不同**（spec §0 GT-1，逐字实测）：
 *   GET /v1/channels/<id>  → channel_id, closed_at, created_at, default_lease_ms,
 *                            delivery_mode, max_attempts, metadata, owner_agent_id,
 *                            refs_required, visibility          ← ⛔ 没有 head_seq
 *   GET /v1/channels       → channel_id, closed_at, created_at, delivery_mode,
 *                            head_seq, owner_agent_id, visibility ← head_seq 只在这里
 *
 * 列表把**已创建但为空**的 channel 以 `head_seq: 0` 列出（不是省略）。
 * 因此 `head_seq` 的唯一可信来源是**列表端点**；单 channel GET 即便返回也属本包不依赖的形状。
 */
export interface ChannelListItem {
  channel_id: string;
  head_seq: number;
}

/**
 * E0c1 GT-1 —— 读 `GET /v1/channels`，返回**所有** channel（分页拉满）。
 *
 * 真实 JSON 一律真解析（仓内已依赖 Node，`JSON.parse` 即可，⛔ 不新增依赖）。
 * ⛔ 禁止用贪婪正则从单行 JSON 抽多值（spec §0 GT-3：该写法每行只捕获最后一个，
 *    算出来的是 3 而真实 `sum(head_seq)` 是 9788）。
 *
 * 读模块级 `BASE_URL`（受 `AGENT_BUS_URL` 覆盖，测试总线即此）。生产总线独立读数
 * 见 `readProdBusHeadSeqSum` / `listChannelsAt`。
 */
export async function listChannels(): Promise<ChannelListItem[]> {
  return listChannelsAt(BASE_URL, TOKEN_PATH);
}

/**
 * E0c1 §1.2 —— 对**指定** bus 实例读 `GET /v1/channels` 真解析求和。
 *
 * 与 `listChannels()` 同形，但 base/token 由参数显式传入（不读模块级 `BASE_URL`/`token()`），
 * 供 `readProdBusHeadSeqSum` 在测试总线覆盖 `AGENT_BUS_URL` 时仍能独立读生产总线，
 * 也供单测直接注入假 base/token。全程只发 GET。
 *
 * ⛔ 真解析（`resp.json()`）；禁止贪婪正则抽多值（GT-3）。
 * 列表端点对空 channel 也列 `head_seq: 0`（GT-1），非数字即结构性异常 ⇒ 响亮失败。
 */
export async function listChannelsAt(
  baseUrl: string,
  tokenPath: string,
): Promise<ChannelListItem[]> {
  let bearer: string;
  try {
    bearer = readFileSync(tokenPath, "utf-8").trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `E0c1: failed to read bus token at '${tokenPath}' (${detail}). The head_seq list read is mandatory; refusing to skip it.`,
    );
  }
  if (!bearer) {
    throw new Error(
      `E0c1: bus token at '${tokenPath}' is empty. The head_seq list read is mandatory; refusing to skip it.`,
    );
  }
  const items: ChannelListItem[] = [];
  let cursor: string | undefined;
  for (;;) {
    const path = cursor ? `/v1/channels?${cursor}` : "/v1/channels";
    const url = `${baseUrl}${path}`;
    const resp = await fetch(url, {
      headers: {
        Authorization: `Bearer ${bearer}`,
        "Content-Type": "application/json",
      },
    });
    if (!resp.ok) {
      const body = await resp.text();
      throw new BusError("GET", path, resp.status, body);
    }
    const data = (await resp.json()) as {
      channels?: unknown;
      next_cursor?: unknown;
    };
    const channels = Array.isArray(data.channels) ? data.channels : [];
    for (const raw of channels) {
      const obj = raw as Record<string, unknown>;
      const channelId = obj.channel_id;
      const headSeq = obj.head_seq;
      if (typeof channelId !== "string") continue;
      if (typeof headSeq !== "number" || !Number.isFinite(headSeq)) {
        // E0c1 §1.1 —— 响亮失败须点名 channel 与**实际拿到的字段集**（spec §1.1），
        // 以便真机形状改变时从错误本身即可诊断（评审 minor：原仅打印 head_seq 的 JSON.stringify）。
        const observedKeys = Object.keys(obj).sort().join(", ");
        throw new Error(
          `E0c1: list endpoint at ${baseUrl} returned channel "${channelId}" without a finite numeric head_seq (got ${JSON.stringify(headSeq)}). Observed fields on the list item: [${observedKeys || "<none>"}]. The list endpoint is the sole source of head_seq per GT-1; refusing to fabricate 0.`,
        );
      }
      items.push({ channel_id: channelId, head_seq: headSeq });
    }
    const next = data.next_cursor;
    if (typeof next !== "string" || next.length === 0) break;
    cursor = next;
  }
  return items;
}

/**
 * E0c1 GT-1 / §1.1 —— 按 channel_id 从**列表端点**取 head_seq。
 *
 * 找不到该 channel、或该 channel 在列表里没有 `head_seq` 字段 ⇒
 * **响亮失败并点名 channel 与实际拿到的字段集**（spec §1.1）。
 * ⛔ 不得当作 0 继续（把「读不到」和「确实是 0」混为一谈会让增长判据失效）。
 *
 * 单 channel GET 端点（`GET /v1/channels/<id>`）在真机 bus 上**不含 head_seq**
 * （GT-1），所以这里只读列表端点、按 channel_id 定位。
 */
export async function getChannelHeadSeq(channelId: string): Promise<number> {
  const channels = await listChannels();
  const found = channels.find((c) => c.channel_id === channelId);
  if (!found) {
    const present = channels.map((c) => c.channel_id).sort().join(", ");
    throw new Error(
      `E0c1: channel "${channelId}" not found on the list endpoint (GET /v1/channels). Present channel_ids: [${present || "<empty>"}]. Refusing to treat a missing channel as head_seq=0.`,
    );
  }
  // listChannels 已对每条做 finite-number 校验；这里直接返回。
  return found.head_seq;
}

/**
 * E0c1 GT-3 / §1.2 —— 对列表里**所有** channel 的 head_seq 真实全量求和。
 *
 * ⛔ 真解析（`JSON.parse`），⛔ 禁止贪婪正则抽多值（GT-3）。
 * 返回 { sum, byChannel }：sum 是真实全量和，byChannel 供运行记录归档与派发方独立复算。
 * 纯函数：消费已读列表，不发起 IO（IO 由 listChannels 完成，可单独注入测试）。
 */
export function sumHeadSeqAcrossChannels(
  channels: ChannelListItem[],
): { sum: number; byChannel: Array<{ channel_id: string; head_seq: number }> } {
  let sum = 0;
  const byChannel: Array<{ channel_id: string; head_seq: number }> = [];
  for (const c of channels) {
    if (typeof c.head_seq !== "number" || !Number.isFinite(c.head_seq)) {
      throw new Error(
        `E0c1: non-finite head_seq on channel "${c.channel_id}" (${JSON.stringify(c.head_seq)}); refusing to sum.`,
      );
    }
    sum += c.head_seq;
    byChannel.push({ channel_id: c.channel_id, head_seq: c.head_seq });
  }
  return { sum, byChannel };
}

/**
 * E0c1 §1.2 —— 读生产总线 `sum(head_seq)`（`http://127.0.0.1:7490`，只读 GET）。
 *
 * 用 `listChannels()` 真实求和（GT-3）；返回 { sum, byChannel } 供入口在跑前/跑后
 * 各读一次并写进运行记录。读失败即失败（⛔ 不得跳过检查）。
 *
 * ⛔ 生产总线读数与测试总线（`AGENT_BUS_URL`）**完全独立**：本函数始终读
 *    `http://127.0.0.1:7490` + 生产 token（`/data/agent-bus/tokens/uther-tui.token`），
 *    不受 `AGENT_BUS_URL` / `AGENT_BUS_TOKEN_FILE` 覆盖影响——因为入口会把这两个变量
 *    改指向测试总线（7495），而 §1.2 要的是**生产**总线在跑前/跑后的零增长读数。
 *    可用 `E0C1_PROD_BUS_URL` / `E0C1_PROD_BUS_TOKEN_FILE` 显式覆盖（测试注入用，
 *    生产路径不变）。
 */
export async function readProdBusHeadSeqSum(): Promise<{
  sum: number;
  byChannel: Array<{ channel_id: string; head_seq: number }>;
}> {
  const prodUrl = process.env.E0C1_PROD_BUS_URL ?? "http://127.0.0.1:7490";
  const prodTokenPath =
    process.env.E0C1_PROD_BUS_TOKEN_FILE ??
    "/data/agent-bus/tokens/uther-tui.token";
  const channels = await listChannelsAt(prodUrl, prodTokenPath);
  return sumHeadSeqAcrossChannels(channels);
}

/**
 * E0c11 —— 对**指定** bus 实例读 `GET /v1/channels/<id>/messages`（分页拉满）。
 *
 * 与 `getMessages` 同形，但 base/token 由参数显式传入（不读模块级 `BASE_URL`/`token()`），
 * 供生产总线身份判定在测试总线覆盖 `AGENT_BUS_URL` 时仍能独立读生产总线。
 * 全程只发 GET。
 */
export async function getMessagesAt(
  baseUrl: string,
  tokenPath: string,
  channelId: string,
  opts: { limit?: number; afterSeq?: number } = {},
): Promise<BusMessage[]> {
  let bearer: string;
  try {
    bearer = readFileSync(tokenPath, "utf-8").trim();
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `E0c11: failed to read bus token at '${tokenPath}' (${detail}). The production-bus message read is mandatory; refusing to skip it.`,
    );
  }
  if (!bearer) {
    throw new Error(
      `E0c11: bus token at '${tokenPath}' is empty. The production-bus message read is mandatory; refusing to skip it.`,
    );
  }
  const params = new URLSearchParams();
  params.set("limit", String(opts.limit ?? 100));
  if (opts.afterSeq !== undefined) params.set("after_seq", String(opts.afterSeq));
  const path = `/v1/channels/${channelId}/messages?${params}`;
  const resp = await fetch(`${baseUrl}${path}`, {
    headers: {
      Authorization: `Bearer ${bearer}`,
      "Content-Type": "application/json",
    },
  });
  if (!resp.ok) {
    const body = await resp.text();
    throw new BusError("GET", path, resp.status, body);
  }
  const data = (await resp.json()) as { messages?: unknown };
  return Array.isArray(data.messages) ? (data.messages as BusMessage[]) : [];
}

/**
 * 把指定 bus 实例上的某 channel 消息分页拉满（与 `readChannelMessages` 同形，
 * 但读生产总线）。全程只读 GET。
 */
export async function readAllMessagesAt(
  baseUrl: string,
  tokenPath: string,
  channelId: string,
): Promise<BusMessage[]> {
  const all: BusMessage[] = [];
  let afterSeq: number | undefined;
  for (;;) {
    const page = await getMessagesAt(baseUrl, tokenPath, channelId, {
      limit: 100,
      afterSeq,
    });
    all.push(...page);
    if (page.length === 0) break;
    const next = page[page.length - 1].channel_seq;
    if (afterSeq !== undefined && next <= afterSeq) break;
    afterSeq = next;
  }
  return all;
}

/**
 * E0c11 §1 / GT-P2 —— 判定一条 bus 消息是否「属于本次运行」。
 *
 * 判据（任一命中即算本次运行写的）：
 *   - `payload.run_id === runId`（agent.run.* / worker.result.v1 / research.* 系列都在 payload 带 run_id）；
 *   - 消息发在**本次 run 派生的** research channel 上（channel_id 命中该 run 的派生 channel 名集合）。
 *
 * ⛔ 不依赖 `sum(head_seq)` 全量相等（GT-P1：别人往生产总线写不能让本次 run 失败）。
 * ⛔ 纯函数：消费已读消息数组，不发起 IO，可直接喂字面量数组做判别性断言。
 */
export function messageBelongsToRun(
  msg: BusMessage,
  runId: string,
  runChannelIds: ReadonlySet<string>,
): boolean {
  if (runChannelIds.has(msg.channel_id)) return true;
  const payload = (msg.payload ?? null) as Record<string, unknown> | null;
  if (payload !== null && typeof payload === "object") {
    const rid = payload.run_id;
    if (typeof rid === "string" && rid === runId) return true;
  }
  return false;
}

/**
 * E0c11 §1 / GT-P2 —— 在已读消息数组里挑出属于本次运行的违规消息。
 *
 * 返回每条违规消息的最小诊断视图（channel_id / kind / message_id / channel_seq + payload run_id），
 * 供入口点名「哪条 channel / 哪条消息」非零退出（spec §1：⛔ 不得删/降级，必须点名）。
 * 纯函数。
 */
export function findRunMessages(
  messages: readonly BusMessage[],
  runId: string,
  runChannelIds: ReadonlySet<string>,
): Array<{
  channel_id: string;
  kind: string;
  message_id: string;
  channel_seq: number;
  run_id: string | null;
}> {
  const offenders: Array<{
    channel_id: string;
    kind: string;
    message_id: string;
    channel_seq: number;
    run_id: string | null;
  }> = [];
  for (const msg of messages) {
    if (!messageBelongsToRun(msg, runId, runChannelIds)) continue;
    const payload = (msg.payload ?? null) as Record<string, unknown> | null;
    const rid =
      payload !== null && typeof payload === "object" &&
      typeof payload.run_id === "string"
        ? payload.run_id
        : null;
    offenders.push({
      channel_id: msg.channel_id,
      kind: msg.kind,
      message_id: msg.message_id,
      channel_seq: msg.channel_seq,
      run_id: rid,
    });
  }
  return offenders;
}

/**
 * E0c11 §1 —— 生产总线「本次运行零写入」身份判定（GT-P1 / GT-P2）。
 *
 * 判据（任一命中 ⇒ 本次运行往生产总线写了 ⇒ 违规）：
 *   1. **按 channel 存在性**：本次 run 派生的 research channel 在生产总线上**不得存在**
 *      （spec §1 第二条可行做法：本 run 派生的 research channel 名在生产总线上不得存在）。
 *   2. **按 run 身份过滤**：在生产总线 `board:agent-runs` 上不得有任何消息属于本次运行
 *      （`payload.run_id === runId` 即算违规，spec §1 第一条可行做法）。
 *
 * ⛔ 不依赖 `sum(head_seq)` 全量相等（GT-P1：别人往生产总线写不能让本次 run 失败）。
 * ⛔ 不得删/降级：本次 run 真的写了 ⇒ verdict.wrote === true，入口据此非零退出并点名（GT-P2）。
 *
 * 运行记录仍保留跑前/跑后的生产总线 `sum(head_seq)` 读数（由 `readProdBusHeadSeqSum` 完成），
 * 但**判定不再依赖两者相等**（spec §1 末段）。
 *
 * `runsChannelId` 是 `board:agent-runs` 的单一真相源（src/run-channels.ts:RUNS_CHANNEL_ID）。
 * `runChannelIds` 是本次 run 派生的 research channel 名集合（不应在生产总线上存在）。
 */
export async function readProdBusRunWriteVerdict(opts: {
  runId: string;
  runsChannelId: string;
  runChannelIds: ReadonlySet<string>;
}): Promise<{
  wrote: boolean;
  existingRunChannels: string[];
  offenders: Array<{
    channel_id: string;
    kind: string;
    message_id: string;
    channel_seq: number;
    run_id: string | null;
  }>;
}> {
  const prodUrl = process.env.E0C1_PROD_BUS_URL ?? "http://127.0.0.1:7490";
  const prodTokenPath =
    process.env.E0C1_PROD_BUS_TOKEN_FILE ??
    "/data/agent-bus/tokens/uther-tui.token";

  // (1) 按 channel 存在性：本次 run 派生的 research channel 在生产总线上不得存在。
  const channels = await listChannelsAt(prodUrl, prodTokenPath);
  const presentIds = new Set(channels.map((c) => c.channel_id));
  const existingRunChannels = opts.runChannelIds.size
    ? [...opts.runChannelIds].filter((id) => presentIds.has(id))
    : [];

  // (2) 按 run 身份过滤：board:agent-runs 上不得有任何消息属于本次运行。
  const runsMessages = await readAllMessagesAt(
    prodUrl,
    prodTokenPath,
    opts.runsChannelId,
  );
  const offenders = findRunMessages(
    runsMessages,
    opts.runId,
    opts.runChannelIds,
  );

  return {
    wrote: existingRunChannels.length > 0 || offenders.length > 0,
    existingRunChannels,
    offenders,
  };
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

/**
 * C2 —— create-or-reuse channel 原语：POST /v1/channels。
 *
 * 幂等（fake/真机 bus 对已存在的 channel 返回已存在而非报错）；但调用方仍应先用
 * `listChannels()` 判复用，避免无谓写调用（见 ensureChannel）。
 * ⛔ 不删除/清空已有 channel（bus append-only 无 DELETE）。
 */
export async function createChannel(channelId: string): Promise<void> {
  await busFetch(`/v1/channels`, {
    method: "POST",
    body: JSON.stringify({ channel_id: channelId }),
  });
}

/**
 * C2 —— create-or-reuse：channel 已存在 ⇒ 复用（不写）；不存在 ⇒ 创建。
 *
 * `knownIds` 可选：调用方若已持有 list 结果可传入（省一次 GET）；否则读 `listChannels()`。
 * 返回本次实际动作，供入口/测试断言「无手工 channel 步骤、且 create-or-reuse 真发生」。
 */
export async function ensureChannel(
  channelId: string,
  knownIds?: readonly string[],
): Promise<{ channelId: string; created: boolean; reused: boolean }> {
  const existing =
    knownIds ?? (await listChannels()).map((c) => c.channel_id);
  if (existing.includes(channelId)) {
    return { channelId, created: false, reused: true };
  }
  await createChannel(channelId);
  return { channelId, created: true, reused: false };
}

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