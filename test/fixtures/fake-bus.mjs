// test fixture —— 本地受控 agent-bus（A10b B1/B2 真跑用 / E0c GT-1 GT-2 判别）。
// ⛔ 零外网：只在 127.0.0.1:<A10B_BUS_PORT> 上 listen，供产品代码经 AGENT_BUS_URL 读取/写入。
// 支持：GET /v1/channels（列表，含 head_seq）；GET /v1/channels/<id>（⛔ 无 head_seq，GT-1）；
// POST /v1/channels（创建）；GET /v1/channels/<id>/messages?limit&after_seq；
// GET /v1/entities/<id>；POST /v1/channels/<id>/publish（supersedes 语义）。
// 可选 SEED 文件（A10B_SEED）预置消息。
//
// E0c GT-1 —— 两个端点字段集不同：
//   GET /v1/channels/<id>  → 不含 head_seq
//   GET /v1/channels       → 含 head_seq，且**已创建但为空**的 channel 以 head_seq:0 列出
// ⛔ 这是判别性基础：产品代码必须从**列表端点**读 head_seq；若产品从单 channel GET 读 head_seq，
//    或列表不列出空 channel，相应测试必须变红。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.A10B_BUS_PORT ?? 0);
const SEED_FILE = process.env.A10B_SEED;
let seq = 0;
const channels = new Map();
const entities = new Map();
// 已创建 channel 名集合：用于列表端点把空 channel 也以 head_seq:0 列出（GT-1）。
const knownChannels = new Set();

function addMessage(channelId, msg) {
  const list = channels.get(channelId) ?? [];
  list.push(msg);
  channels.set(channelId, list);
  knownChannels.add(channelId);
  if (msg.entity_id) entities.set(msg.entity_id, msg);
}

function createChannel(channelId) {
  if (!knownChannels.has(channelId)) {
    knownChannels.add(channelId);
    if (!channels.has(channelId)) channels.set(channelId, []);
  }
}

function listChannelView(channelId) {
  const count = (channels.get(channelId) ?? []).length;
  return {
    channel_id: channelId,
    closed_at: null,
    created_at: new Date().toISOString(),
    delivery_mode: "fifo",
    head_seq: count, // GT-1：head_seq 只出现在列表端点
    owner_agent_id: "fake",
    visibility: "public",
  };
}

if (SEED_FILE) {
  const seed = JSON.parse(readFileSync(SEED_FILE, "utf8"));
  for (const ch of Object.keys(seed)) {
    for (const m of seed[ch]) {
      addMessage(ch, {
        message_id: m.message_id ?? `seed_${ch}_${seq++}`,
        channel_id: ch,
        channel_seq: m.channel_seq ?? 1,
        kind: m.kind,
        payload: m.payload,
        entity_id: m.entity_id ?? null,
        supersedes: m.supersedes ?? "",
        created_at: m.created_at ?? new Date().toISOString(),
      });
    }
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const path = url.pathname;
  try {
    // E0c GT-1 —— 列表端点：返回全部 channel（含 head_seq），空 channel 也以 head_seq:0 列出。
    if (req.method === "GET" && path === "/v1/channels") {
      const views = [...knownChannels].map(listChannelView);
      return send(200, { channels: views });
    }
    // E0c —— 创建 channel（e0-regression.sh 每次 run 建 per-run research board 用）。
    if (req.method === "POST" && path === "/v1/channels") {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let p;
        try {
          p = JSON.parse(body);
        } catch {
          return send(400, { code: "BAD" });
        }
        const id = String(p.channel_id ?? "");
        if (!id) return send(400, { code: "BAD" });
        createChannel(id);
        return send(201, listChannelView(id));
      });
      return;
    }
    if (req.method === "GET" && /^\/v1\/channels\/[^/]+\/messages/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]);
      const after = Number(url.searchParams.get("after_seq") ?? 0);
      const list = (channels.get(id) ?? []).filter((m) => m.channel_seq > after);
      return send(200, { messages: list });
    }
    if (req.method === "GET" && /^\/v1\/channels\/[^/]+$/.test(path)) {
      // E0c GT-1 —— 单 channel GET **不含** head_seq（字段集与列表端点不同）。
      const id = decodeURIComponent(path.split("/")[3]);
      if (!knownChannels.has(id)) return send(404, { code: "NOT_FOUND" });
      return send(200, {
        channel_id: id,
        closed_at: null,
        created_at: new Date().toISOString(),
        default_lease_ms: 60000,
        delivery_mode: "fifo",
        max_attempts: 1,
        metadata: null,
        owner_agent_id: "fake",
        refs_required: false,
        visibility: "public",
      });
    }
    if (req.method === "GET" && /^\/v1\/entities\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]);
      const h = entities.get(id);
      if (!h) return send(404, { code: "NOT_FOUND" });
      return send(200, { head: h });
    }
    if (req.method === "POST" && /^\/v1\/channels\/[^/]+\/publish/.test(path)) {
      let body = "";
      req.on("data", (d) => (body += d));
      req.on("end", () => {
        let p;
        try {
          p = JSON.parse(body);
        } catch {
          return send(400, { code: "BAD" });
        }
        const id = decodeURIComponent(path.split("/")[3]);
        const l = channels.get(id) ?? [];
        const msg = {
          message_id: `msg_${id}_${++seq}`,
          channel_id: id,
          channel_seq: l.length + 1,
          kind: p.kind,
          payload: p.payload,
          entity_id: p.entity_id ?? `msg_${id}_${seq}`,
          supersedes: p.supersedes ?? "",
          created_at: new Date().toISOString(),
        };
        if (p.supersedes) {
          const i = l.findIndex((m) => m.message_id === p.supersedes);
          if (i >= 0) l[i] = msg;
          else l.push(msg);
        } else {
          l.push(msg);
        }
        channels.set(id, l);
        if (p.entity_id) entities.set(p.entity_id, msg);
        return send(200, { message_id: msg.message_id, channel_seq: msg.channel_seq, deduplicated: false });
      });
      return;
    }
    return send(404, { code: "NOT_FOUND" });
  } catch (e) {
    return send(500, { code: "ERR", message: String(e) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`fakebus listening on ${PORT}`);
});