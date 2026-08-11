#!/usr/bin/env node
/**
 * E0 —— head_seq / sum 的**唯一**取值实现（真实 JSON 解析，⛔ 绝不用贪婪正则抽多值）。
 *
 * 真实 agent-bus 契约（2026-08-12 真机实测）：
 *   GET /v1/channels/<id>   → channel_id, closed_at, created_at, default_lease_ms,
 *                             delivery_mode, max_attempts, metadata, owner_agent_id,
 *                             refs_required, visibility            ← 无 head_seq
 *   GET /v1/channels        → 每个 channel 带 head_seq                    ← head_seq 只在这里
 *
 * 因此本模块**一律只读列表端点 GET /v1/channels**，按 channel_id 在列表里定位再取 head_seq。
 * ⛔ 不依赖 GET /v1/channels/<id> 返回 head_seq。
 *
 * 用法（CLI）：
 *   node e0-metrics.mjs snapshot <baseUrl> <tokenPath> <tickChannel>
 *     → stdout 单行 JSON：{tick_channel, tick_head_seq, sum, channel_count, channels}
 *     找不到 tick channel 或该项无 head_seq ⇒ **响亮失败**（exit 1，点名 channel 与字段集），
 *     ⛔ 不得当作 0 继续（把"读不到"和"确实是 0"混为一谈会让 Z1 增长判据失效）。
 *   node e0-metrics.mjs sum <baseUrl> <tokenPath>
 *     → stdout 单行 JSON：{sum, channel_count, channels}（Z2 生产总线全量和，不要求某 channel）。
 *
 * 模块导出（供单测）：
 *   parseChannelList(json) -> {channelId: {headSeq: number|null, fieldSet: string[]}}
 *     （保留每个 channel 的**实际字段集**，供 §1.1 响亮失败点名）
 *   headSeqFor(channels, channelId) -> {found, headSeq, fieldSet}
 *     fieldSet 为该 channel 在列表项里的实际字段名；找不到 ⇒ null
 *   sumHeadSeqs(channels) -> number（对所有 channel 求和）
 *   listChannels(baseUrl, token) -> parseChannelList 结果（按名取 head_seq 的唯一 HTTP 路径）
 */
import { readFileSync } from "node:fs";

/** 从列表端点响应 JSON 里解析出 {channel_id: {headSeq, fieldSet}}。 */
export function parseChannelList(json) {
  const data = JSON.parse(json);
  const arr = Array.isArray(data) ? data : Array.isArray(data.channels) ? data.channels : null;
  if (!arr) {
    throw new Error(`GET /v1/channels returned no list (body=${JSON.stringify(data).slice(0, 200)})`);
  }
  const channels = {};
  for (const c of arr) {
    if (c && typeof c.channel_id === "string") {
      channels[c.channel_id] = {
        headSeq: typeof c.head_seq === "number" ? c.head_seq : null,
        fieldSet: Object.keys(c),
      };
    }
  }
  return channels;
}

/** 在列表里按名取某 channel 的 head_seq；找不到 ⇒ found:false，找到但无字段 ⇒ headSeq:null。 */
export function headSeqFor(channels, channelId) {
  if (!(channelId in channels)) {
    return { found: false, headSeq: null, fieldSet: null };
  }
  const entry = channels[channelId];
  return { found: true, headSeq: entry.headSeq, fieldSet: entry.fieldSet };
}

/** 对所有 channel 的 head_seq 求和（真正的全量和；head_seq 为 null 的跳过）。 */
export function sumHeadSeqs(channels) {
  let sum = 0;
  for (const k of Object.keys(channels)) {
    const v = channels[k].headSeq;
    if (typeof v === "number") sum += v;
  }
  return sum;
}

/** 把丰富的 per-channel 结构压平为 {channel_id: head_seq|null}，供 CLI 输出的 channels 字段（向后兼容）。 */
function flattenChannels(channels) {
  const flat = {};
  for (const k of Object.keys(channels)) {
    flat[k] = channels[k].headSeq;
  }
  return flat;
}

async function snapshot(baseUrl, tokenPath, tickChannel) {
  const token = readFileSync(tokenPath, "utf8").trim();
  const channels = await listChannels(baseUrl, token);
  const { found, headSeq, fieldSet } = headSeqFor(channels, tickChannel);
  if (!found) {
    console.error(
      `[e0-metrics] FAIL: could not read head_seq for channel '${tickChannel}' on ${baseUrl}: ` +
        `channel is absent from GET /v1/channels list (found=false). Refusing to treat a read-miss as 0 — ` +
        `Z1 growth would be meaningless.`,
    );
    process.exit(1);
  }
  if (headSeq === null) {
    console.error(
      `[e0-metrics] FAIL: channel '${tickChannel}' on ${baseUrl} exists but its list entry has no head_seq field. ` +
        `Actual field set=${JSON.stringify(fieldSet)}. Refusing to treat a read-miss as 0 — ` +
        `Z1 growth would be meaningless.`,
    );
    process.exit(1);
  }
  const out = {
    tick_channel: tickChannel,
    tick_head_seq: headSeq,
    sum: sumHeadSeqs(channels),
    channel_count: Object.keys(channels).length,
    channels: flattenChannels(channels),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

export async function listChannels(baseUrl, token) {
  const resp = await fetch(`${baseUrl}/v1/channels`, {
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
  });
  if (!resp.ok) {
    throw new Error(`bus GET /v1/channels: ${resp.status} ${(await resp.text()).slice(0, 200)}`);
  }
  return parseChannelList(await resp.text());
}

async function sumCmd(baseUrl, tokenPath) {
  const token = readFileSync(tokenPath, "utf8").trim();
  const channels = await listChannels(baseUrl, token);
  const out = {
    sum: sumHeadSeqs(channels),
    channel_count: Object.keys(channels).length,
    channels: flattenChannels(channels),
  };
  process.stdout.write(`${JSON.stringify(out)}\n`);
}

const [cmd, ...rest] = process.argv.slice(2);
const isMain =
  process.argv[1] &&
  (() => {
    try {
      return import.meta.url === new URL(`file://${process.argv[1]}`).href;
    } catch {
      return false;
    }
  })();

if (isMain) {
  if (cmd === "snapshot") {
    const [baseUrl, tokenPath, tickChannel] = rest;
    snapshot(baseUrl, tokenPath, tickChannel).catch((err) => {
      console.error(`[e0-metrics] ${err.message}`);
      process.exit(1);
    });
  } else if (cmd === "sum") {
    const [baseUrl, tokenPath] = rest;
    sumCmd(baseUrl, tokenPath).catch((err) => {
      console.error(`[e0-metrics] ${err.message}`);
      process.exit(1);
    });
  } else {
    console.error(`usage: node e0-metrics.mjs snapshot <baseUrl> <tokenPath> <tickChannel> | sum <baseUrl> <tokenPath>`);
    process.exit(2);
  }
}
