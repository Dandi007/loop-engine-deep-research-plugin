// test fixture —— 本地受控 agent-bus（E0a 入口级集成测试用）。
// ⛔ 零外网：只在 127.0.0.1:<E0A_BUS_PORT> 上 listen，供产品代码经 AGENT_BUS_URL 读取/写入。
// 以**独立子进程**运行（入口脚本经 execFileSync 同步执行会阻塞测试进程事件循环；
// 若总线与入口同进程，入口里的 curl/fetch 会因事件循环被阻塞而互相死锁——仓库既有
// fake-bus.mjs 同款范式）。
//
// 支持：
//   GET  /v1/channels                       —— channel 列表（含 head_seq，供生产总线 sum 取证）
//   GET  /v1/channels/<id>                  —— 单 channel head_seq
//   POST /v1/channels                       —— 创建 channel
//   POST /v1/channels/<id>/publish          —— 发布（head_seq 递增；计数 research.clue.v2）
//   GET  /_debug/headseq/<channel>          —— 测试断言用：head_seq
//   GET  /_debug/clues/<channel>            —— 测试断言用：research.clue.v2 条数
//
// 可选 env：
//   E0A_BUS_PORT   端口（0 = 随机，打印实际端口到 stdout）
//   E0A_INIT       "ch:n,ch2:m" 预置若干 channel 及初始消息数（测试构造非空板 / 生产读数）
//   E0A_GROW_LIST  1 = 每次 GET /v1/channels 使返回的 sum 递增（测试生产污染判据）
import { createServer } from "node:http";

const PORT = Number(process.env.E0A_BUS_PORT ?? 0);
const messages = new Map();
if (process.env.E0A_INIT) {
  for (const part of process.env.E0A_INIT.split(",")) {
    const [ch, n] = part.split(":");
    const count = Number(n ?? 0);
    messages.set(ch, Array.from({ length: count }, () => ({ kind: "research.clue.v2" })));
  }
}
const growList = process.env.E0A_GROW_LIST === "1";
let listTick = 0;

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://127.0.0.1:${PORT}`);
  const path = url.pathname;
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  const hs = path.match(/^\/_debug\/headseq\/(.+)$/);
  const cl = path.match(/^\/_debug\/clues\/(.+)$/);
  if (req.method === "GET" && hs) {
    const id = decodeURIComponent(hs[1]);
    return send(200, { head_seq: (messages.get(id) ?? []).length });
  }
  if (req.method === "GET" && cl) {
    const id = decodeURIComponent(cl[1]);
    return send(200, { clues: (messages.get(id) ?? []).filter((m) => m.kind === "research.clue.v2").length });
  }
  const single = path.match(/^\/v1\/channels\/([^/]+)\/?$/);
  const pub = path.match(/^\/v1\/channels\/([^/]+)\/publish$/);
  if (req.method === "GET" && path === "/v1/channels") {
    const channels = [...messages.entries()].map(([channel_id, msgs]) => ({
      channel_id,
      head_seq: msgs.length + (growList ? listTick : 0),
    }));
    if (growList) listTick += 1;
    return send(200, { channels });
  }
  if (req.method === "GET" && single) {
    const id = decodeURIComponent(single[1]);
    return send(200, { head_seq: (messages.get(id) ?? []).length });
  }
  if (req.method === "POST" && path === "/v1/channels") {
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      try {
        const p = JSON.parse(b);
        if (p.channel_id) messages.set(p.channel_id, messages.get(p.channel_id) ?? []);
      } catch {
        /* ignore */
      }
      send(200, { ok: true });
    });
    return;
  }
  if (req.method === "POST" && pub) {
    const id = decodeURIComponent(pub[1]);
    let b = "";
    req.on("data", (d) => (b += d));
    req.on("end", () => {
      let kind = "unknown";
      try {
        const p = JSON.parse(b);
        kind = p.kind ?? "unknown";
      } catch {
        /* ignore */
      }
      const arr = messages.get(id) ?? [];
      arr.push({ kind });
      messages.set(id, arr);
      send(200, { message_id: `m${arr.length}`, channel_seq: arr.length, deduplicated: false });
    });
    return;
  }
  return send(404, { code: "NOT_FOUND" });
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`e0a-fake-bus listening on ${server.address().port}`);
});
