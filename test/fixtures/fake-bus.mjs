// test fixture —— 本地受控 agent-bus（A10b B1/B2 真跑用）。
// ⛔ 零外网：只在 127.0.0.1:<A10B_BUS_PORT> 上 listen，供产品代码经 AGENT_BUS_URL 读取/写入。
// 支持：GET /v1/channels/<id>/messages?limit&after_seq；GET /v1/channels/<id>；
// GET /v1/entities/<id>；POST /v1/channels/<id>/publish（supersedes 语义）。
// 可选 SEED 文件（A10B_SEED）预置消息。
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const PORT = Number(process.env.A10B_BUS_PORT ?? 0);
const SEED_FILE = process.env.A10B_SEED;
let seq = 0;
const channels = new Map();
const entities = new Map();

function addMessage(channelId, msg) {
  const list = channels.get(channelId) ?? [];
  list.push(msg);
  channels.set(channelId, list);
  if (msg.entity_id) entities.set(msg.entity_id, msg);
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
    if (req.method === "GET" && /^\/v1\/channels\/[^/]+\/messages/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]);
      const after = Number(url.searchParams.get("after_seq") ?? 0);
      const list = (channels.get(id) ?? []).filter((m) => m.channel_seq > after);
      return send(200, { messages: list });
    }
    // E0c2 —— GET /v1/channels (list) returns all channels with head_seq.
    if (req.method === "GET" && path === "/v1/channels") {
      const result = [];
      for (const [id, msgs] of channels) {
        result.push({ channel_id: id, head_seq: msgs.length });
      }
      return send(200, { channels: result });
    }
    // E0c2 GT-8 —— 单 channel GET（/v1/channels/<id>）在真机 bus 上不含 head_seq。
// ⛔ 假 bus 必须照此实现：单 channel GET 不返回 head_seq。
// head_seq 的唯一可信来源是列表端点 GET /v1/channels。
if (req.method === "GET" && /^\/v1\/channels\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]);
      const list = channels.get(id) ?? [];
      return send(200, {
        channel_id: id,
        closed_at: null,
        created_at: new Date().toISOString(),
        delivery_mode: "push",
        owner_agent_id: "test-agent",
        refs_required: false,
        visibility: "public",
        max_attempts: 3,
        default_lease_ms: 30000,
        metadata: {},
        // ⛔ GT-8: single channel GET does NOT include head_seq
      });
    }
    if (req.method === "GET" && /^\/v1\/entities\/[^/]+$/.test(path)) {
      const id = decodeURIComponent(path.split("/")[3]);
      const h = entities.get(id);
      if (!h) return send(404, { code: "NOT_FOUND" });
      return send(200, { head: h });
    }
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
        const id = p.channel_id;
        if (!id) return send(400, { code: "BAD", message: "channel_id required" });
        if (!channels.has(id)) channels.set(id, []);
        return send(200, { channel_id: id, created: true });
      });
      return;
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