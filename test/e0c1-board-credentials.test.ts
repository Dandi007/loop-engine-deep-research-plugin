/**
 * E0c1 —— 板面与凭证域回归基线（spec §1.1–§1.4 / §0 GT-1/GT-2/GT-3）。
 *
 * 每条判别性测试都把被测行为改坏后必须变红（spec §3 验收判据 2/3/4/5/6）：
 *  - GT-1  head_seq 只从列表端点取；单 channel GET 返回 head_seq ⇒ 红；
 *         列表不列出空 channel ⇒ 红。
 *  - GT-3  sum(head_seq) 真解析真求和；贪婪正则实现 ⇒ 红。
 *  - GT-2  播种未传 --source（sources=[]）⇒ 响亮失败（在 g4e-seed.test.ts 同断言）。
 *  - §1.3  两次运行的 research channel 名不同且各含 run_id；channel 名改回固定值 ⇒ 第二次红。
 *  - §1.3  board:agent-runs 在仓内只有一处真相源（src/）。
 *  - §1.2  生产总线跑前跑后两读数写进记录且相等；不等 ⇒ 失败。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  listChannelsAt,
  sumHeadSeqAcrossChannels,
  type ChannelListItem,
} from "../src/bus";
import {
  RUNS_CHANNEL_ID,
  perRunResearchChannels,
  runSegment,
} from "../src/run-channels";

const ROOT = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(ROOT, "..");
const BIN = join(REPO_ROOT, "bin", "e0-regression.sh");

// ── fetch stub helpers（与 bus.test.ts 同构）──────────────────────────────

type FetchHandler = (url: string, init?: RequestInit) => Promise<unknown>;

function stubFetch(handler: FetchHandler): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => handler(String(url), init)),
  );
}

function jsonResponse(status: number, data: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => data,
    text: async () => JSON.stringify(data),
  } as Response;
}

function makeTokenFile(content = "tok"): string {
  const dir = mkdtempSync(join(tmpdir(), "e0c1-tok-"));
  const p = join(dir, "token");
  writeFileSync(p, content);
  return p;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

// ── GT-1：head_seq 只从列表端点取 ─────────────────────────────────────────

describe("GT-1 / §1.1: head_seq only from the list endpoint", () => {
  it("listChannelsAt reads head_seq from GET /v1/channels (list endpoint)", async () => {
    const tok = makeTokenFile();
    let fetchedUrls: string[] = [];
    stubFetch(async (url) => {
      fetchedUrls.push(url);
      if (url.endsWith("/v1/channels")) {
        return jsonResponse(200, {
          channels: [
            { channel_id: "research:a", head_seq: 5 },
            { channel_id: "research:b", head_seq: 0 }, // 空 channel 也列 head_seq:0
          ],
        });
      }
      return jsonResponse(404, {});
    });
    const channels = await listChannelsAt("http://bus.example", tok);
    expect(channels).toContainEqual({ channel_id: "research:a", head_seq: 5 });
    expect(channels).toContainEqual({ channel_id: "research:b", head_seq: 0 });
    // 只读了列表端点，没读单 channel GET（GT-1：head_seq 只在列表端点）。
    expect(fetchedUrls.some((u) => u.endsWith("/v1/channels"))).toBe(true);
    expect(fetchedUrls.some((u) => /\/v1\/channels\/[^/]+$/.test(u))).toBe(false);
  });

  it("DISCRIMINATING: single-channel GET returning head_seq is NOT relied upon (list is the sole source)", async () => {
    // 即便单 channel GET 返回 head_seq（真机不会，但假设它返回），listChannelsAt 仍只读列表。
    // 判别性：如果把实现改成读单 channel GET 取 head_seq，本测试会因列表未被读而失败。
    const tok = makeTokenFile();
    const fetchedUrls: string[] = [];
    stubFetch(async (url) => {
      fetchedUrls.push(url);
      if (url.endsWith("/v1/channels")) {
        return jsonResponse(200, { channels: [{ channel_id: "research:a", head_seq: 7 }] });
      }
      // 单 channel GET 假装返回 head_seq（GT-1 说真机不返回；这里测我们根本不依赖它）。
      if (/\/v1\/channels\/[^/]+$/.test(url)) {
        return jsonResponse(200, { channel_id: "research:a", head_seq: 999, visibility: "private" });
      }
      return jsonResponse(404, {});
    });
    const channels = await listChannelsAt("http://bus.example", tok);
    // 取到的是列表端点的 7，不是单 channel GET 的 999。
    expect(channels).toEqual([{ channel_id: "research:a", head_seq: 7 }]);
    expect(fetchedUrls.some((u) => /\/v1\/channels\/[^/]+$/.test(u))).toBe(false);
  });

  it("DISCRIMINATING: list endpoint omitting empty channels ⇒ the empty channel is not fabricated as head_seq=0", async () => {
    // 判别性：如果列表不列出空 channel（违反 GT-1「列表把空 channel 以 head_seq:0 列出」），
    // getChannelHeadSeq 该 channel ⇒ 找不到 ⇒ 响亮失败（不假装 head_seq=0）。
    const tok = makeTokenFile();
    stubFetch(async (url) => {
      if (url.endsWith("/v1/channels")) {
        // 假装列表**省略**了空 channel（违反 GT-1）。
        return jsonResponse(200, { channels: [{ channel_id: "research:nonempty", head_seq: 3 }] });
      }
      return jsonResponse(404, {});
    });
    const channels = await listChannelsAt("http://bus.example", tok);
    const { getChannelHeadSeq } = await import("../src/bus");
    await expect(getChannelHeadSeq("research:empty")).rejects.toThrow(/not found/);
    expect(channels.find((c) => c.channel_id === "research:empty")).toBeUndefined();
  });

  it("non-numeric head_seq on the list endpoint ⇒ loud failure (no fabricate 0)", async () => {
    const tok = makeTokenFile();
    stubFetch(async (url) => {
      if (url.endsWith("/v1/channels")) {
        return jsonResponse(200, { channels: [{ channel_id: "research:x", head_seq: "oops" }] });
      }
      return jsonResponse(404, {});
    });
    await expect(listChannelsAt("http://bus.example", tok)).rejects.toThrow(/finite numeric head_seq/);
  });

  it("missing token ⇒ loud failure naming the token path (read failure is failure, §1.2)", async () => {
    const missing = join(mkdtempSync(join(tmpdir(), "e0c1-missing-")), "no-such-token");
    stubFetch(async () => jsonResponse(200, { channels: [] }));
    await expect(listChannelsAt("http://bus.example", missing)).rejects.toThrow(/failed to read bus token/);
    await expect(listChannelsAt("http://bus.example", missing)).rejects.toThrow(missing);
  });

  it("empty token ⇒ loud failure (no silent skip)", async () => {
    const empty = makeTokenFile("\n  \n");
    stubFetch(async () => jsonResponse(200, { channels: [] }));
    await expect(listChannelsAt("http://bus.example", empty)).rejects.toThrow(/empty/);
  });
});

// ── GT-3：sum(head_seq) 真解析真求和，禁止贪婪正则 ──────────────────────────

describe("GT-3 / §1.2: sum(head_seq) is a real full sum, not a greedy-regex extraction", () => {
  it("sumHeadSeqAcrossChannels sums ALL channels (real sum)", () => {
    // 真实形状：多 channel，sum 真实全量求和。
    const channels: ChannelListItem[] = [
      { channel_id: "a", head_seq: 9788 },
      { channel_id: "b", head_seq: 0 },
      { channel_id: "c", head_seq: 12 },
    ];
    const { sum } = sumHeadSeqAcrossChannels(channels);
    expect(sum).toBe(9800);
  });

  it("DISCRIMINATING: greedy-regex extraction would yield 3, real sum yields 9788 (GT-3 ground truth)", () => {
    // GT-3 实测：bus 返回单行 JSON，贪婪正则 sed 's/.*"head_seq"[^0-9]*\([0-9]*\).*/\1/p'
    // 每行只捕获**最后一个** head_seq，算出 3；真实 sum(head_seq) 是 9788。
    // 这里用真解析构造的反例：若实现退化为「取最后一条 channel 的 head_seq」，sum 会是 3 而非 9788。
    const channels: ChannelListItem[] = [
      { channel_id: "big", head_seq: 9788 },
      { channel_id: "tail", head_seq: 3 }, // 贪婪正则会只抓到这个
    ];
    const { sum } = sumHeadSeqAcrossChannels(channels);
    expect(sum).toBe(9791); // 9788 + 3
    expect(sum).not.toBe(3); // 贪婪正则的错答案
  });

  it("byChannel preserves every channel for the record archive (派发方独立复算)", () => {
    const channels: ChannelListItem[] = [
      { channel_id: "a", head_seq: 10 },
      { channel_id: "b", head_seq: 20 },
    ];
    const { sum, byChannel } = sumHeadSeqAcrossChannels(channels);
    expect(sum).toBe(30);
    expect(byChannel).toEqual(channels);
    // 派发方独立复算：sum === Σ byChannel[].head_seq
    const recomputed = byChannel.reduce((acc, c) => acc + c.head_seq, 0);
    expect(recomputed).toBe(sum);
  });

  it("non-finite head_seq in the list ⇒ loud failure (no silent NaN sum)", () => {
    const channels = [{ channel_id: "a", head_seq: Number.NaN }] as ChannelListItem[];
    expect(() => sumHeadSeqAcrossChannels(channels)).toThrow(/non-finite head_seq/);
  });

  it("listChannelsAt paginates through next_cursor and sums the full set (no truncation)", async () => {
    const tok = makeTokenFile();
    let firstPage = true;
    stubFetch(async (url) => {
      if (url.endsWith("/v1/channels") && firstPage) {
        firstPage = false;
        return jsonResponse(200, {
          channels: [{ channel_id: "a", head_seq: 100 }],
          next_cursor: "cursor=xyz",
        });
      }
      // 第二页（带 next_cursor）
      if (url.includes("/v1/channels?cursor=xyz")) {
        return jsonResponse(200, {
          channels: [{ channel_id: "b", head_seq: 200 }],
        });
      }
      return jsonResponse(404, {});
    });
    const channels = await listChannelsAt("http://bus.example", tok);
    const { sum } = sumHeadSeqAcrossChannels(channels);
    expect(sum).toBe(300); // 两页都算进
  });
});

// ── §1.3：per-run research channels 派生 + board:agent-runs 单一真相源 ───────

describe("§1.3: per-run research channels derived from profile base + run_id", () => {
  it("derives three channels of the form research:<base>-<runSegment>.{index,evidence,docs}", () => {
    const ch = perRunResearchChannels("e0", "run-abc");
    const seg = runSegment("run-abc");
    expect(ch.index).toBe(`research:e0-${seg}.index`);
    expect(ch.evidence).toBe(`research:e0-${seg}.evidence`);
    expect(ch.docs).toBe(`research:e0-${seg}.docs`);
  });

  it("DISCRIMINATING: two different run_ids produce different channel names (each run uses its own board)", () => {
    // 判据 5：两次运行使用的 research channel 名不同且各含自己的 run_id；
    // 把 channel 名改回固定值 ⇒ 第二次运行的测试变红。
    const a = perRunResearchChannels("e0", "run-one");
    const b = perRunResearchChannels("e0", "run-two");
    expect(a.index).not.toBe(b.index);
    expect(a.evidence).not.toBe(b.evidence);
    expect(a.docs).not.toBe(b.docs);
    // 派生段是 run_id 的确定性哈希前缀（两次 run_id 不同 ⇒ 段不同）。
    expect(runSegment("run-one")).not.toBe(runSegment("run-two"));
  });

  it("idempotent: same (base, run_id) ⇒ same channels (幂等创建的前提)", () => {
    const a = perRunResearchChannels("e0", "run-same");
    const b = perRunResearchChannels("e0", "run-same");
    expect(a).toEqual(b);
  });

  it("runSegment is deterministic and only contains [0-9a-f] (channel-id-safe)", () => {
    const seg = runSegment("anything");
    expect(seg).toMatch(/^[0-9a-f]{16}$/);
    expect(runSegment("anything")).toBe(seg);
  });

  it("empty profileBase ⇒ loud failure (no deriving from empty base)", () => {
    expect(() => perRunResearchChannels("", "run-x")).toThrow(/profileBase/);
  });

  it("empty runId ⇒ loud failure (each run must derive from its own run_id)", () => {
    expect(() => perRunResearchChannels("e0", "")).toThrow(/runId/);
  });
});

describe("§1.3 / 判据 6: board:agent-runs has exactly one source of truth in src/", () => {
  it("the literal \"board:agent-runs\" appears in src/ only inside run-channels.ts (the single source)", () => {
    // 扫 src/ 下所有 .ts，统计字面量 "board:agent-runs" 的出现位置；
    // 唯一允许的源是 src/run-channels.ts 的 RUNS_CHANNEL_ID 定义。
    const srcDir = join(ROOT, "..", "src");
    const offenders: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const full = join(d, name);
        if (statSync(full).isDirectory()) walk(full);
        else if (name.endsWith(".ts")) {
          const text = readFileSync(full, "utf8");
          // 匹配字符串字面量 "board:agent-runs"（含单/双引号、模板串）。
          const lines = text.split("\n");
          lines.forEach((line, i) => {
            // 跳过注释行（以 *、//、/* 开头的文档/注释）。
            const trimmed = line.trim();
            if (trimmed.startsWith("*") || trimmed.startsWith("//") || trimmed.startsWith("/*")) return;
            // 匹配字面量赋值或传参（含 "board:agent-runs" 字符串）。
            if (/["'`]board:agent-runs["'`]/.test(line)) {
              offenders.push(`${full}:${i + 1}: ${line.trim()}`);
            }
          });
        }
      }
    };
    walk(srcDir);
    // 唯一允许：run-channels.ts 里 `export const RUNS_CHANNEL_ID = "board:agent-runs";`
    const allowed = offenders.filter((o) =>
      o.includes("src/run-channels.ts") && o.includes("RUNS_CHANNEL_ID"),
    );
    const disallowed = offenders.filter(
      (o) => !(o.includes("src/run-channels.ts") && o.includes("RUNS_CHANNEL_ID")),
    );
    expect(allowed.length, "RUNS_CHANNEL_ID definition must exist in run-channels.ts").toBeGreaterThanOrEqual(1);
    expect(disallowed, "no other literal board:agent-runs in src/ outside the single source").toEqual([]);
  });

  it("RUNS_CHANNEL_ID constant value is exactly board:agent-runs", () => {
    expect(RUNS_CHANNEL_ID).toBe("board:agent-runs");
  });
});

// ── §1.2：生产总线跑前/跑后两读数写进记录且相等 ──────────────────────────────

describe("§1.2: production bus before/after read (readProdBusHeadSeqSum)", () => {
  it("readProdBusHeadSeqSum reads E0C1_PROD_BUS_URL independently of AGENT_BUS_URL", async () => {
    // 入口会把 AGENT_BUS_URL 改指向测试总线（7495），但 §1.2 要的是生产总线（7490）。
    // 判别性：readProdBusHeadSeqSum 必须读 E0C1_PROD_BUS_URL，不受 AGENT_BUS_URL 影响。
    vi.stubEnv("AGENT_BUS_URL", "http://127.0.0.1:7495"); // 测试总线（应被忽略）
    vi.stubEnv("E0C1_PROD_BUS_URL", "http://127.0.0.1:7490"); // 生产总线
    const tok = makeTokenFile();
    vi.stubEnv("E0C1_PROD_BUS_TOKEN_FILE", tok);
    let hitUrl = "";
    stubFetch(async (url) => {
      hitUrl = url;
      return jsonResponse(200, { channels: [{ channel_id: "prod:ch", head_seq: 42 }] });
    });
    const { readProdBusHeadSeqSum } = await import("../src/bus");
    const result = await readProdBusHeadSeqSum();
    expect(result.sum).toBe(42);
    // 命中的是生产总线（7490），不是测试总线（7495）。
    expect(hitUrl).toContain("7490");
    expect(hitUrl).not.toContain("7495");
  });

  it("read failure ⇒ loud failure (no silent skip of the mandatory before/after read)", async () => {
    vi.stubEnv("E0C1_PROD_BUS_URL", "http://127.0.0.1:7490");
    const tok = makeTokenFile();
    vi.stubEnv("E0C1_PROD_BUS_TOKEN_FILE", tok);
    stubFetch(async () => jsonResponse(500, { message: "prod bus down" }));
    const { readProdBusHeadSeqSum } = await import("../src/bus");
    await expect(readProdBusHeadSeqSum()).rejects.toThrow();
  });
});

// ── 入口集成：bin/e0-regression.sh 派生 per-run channel + 预备 board:agent-runs + §1.2 读数 ──
// 用 detached spawn（非 execFileSync）跑入口脚本：脚本的 `exec 1> >(tee …)` 会让 execFileSync
// 的管道在 tee 子进程上挂住（wait for EOF）；detached spawn + 显式 kill 不受此影响。

function runEntryDetached(env: NodeJS.ProcessEnv, timeoutMs = 30000): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn("bash", [BIN], {
      cwd: REPO_ROOT,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });
    const timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch (_) {}
      reject(new Error(`entry script timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    let stdout = "";
    let stderr = "";
    child.stdout?.on("data", (c) => (stdout += c));
    child.stderr?.on("data", (c) => (stderr += c));
    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

function startFakeBus(): Promise<{
  base: string;
  createdChannels: () => string[];
  setProdSum: (n: number) => void;
  close: () => void;
}> {
  return new Promise((resolve) => {
    const created: string[] = [];
    let prodSum = 0;
    const server = createServer((req, res) => {
      const url = req.url ?? "";
      const method = req.method ?? "GET";
      if (method === "POST" && url === "/v1/channels") {
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try {
            const obj = JSON.parse(body);
            if (typeof obj.channel_id === "string" && !created.includes(obj.channel_id)) {
              created.push(obj.channel_id);
            }
          } catch (_) {}
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ channel_id: "ok" }));
        });
        return;
      }
      if (method === "GET" && url === "/v1/channels") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ channels: [{ channel_id: "fake:prod", head_seq: prodSum }] }));
        return;
      }
      if (method === "GET" && url.startsWith("/v1/channels/")) {
        const chId = decodeURIComponent(url.slice("/v1/channels/".length));
        if (created.includes(chId)) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ channel_id: chId, visibility: "private" }));
        } else {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ message: "not found" }));
        }
        return;
      }
      if (method === "POST" && url.includes("/publish")) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ message_id: "m", channel_seq: 1 }));
        return;
      }
      res.writeHead(404);
      res.end("{}");
    });
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        createdChannels: () => [...created],
        setProdSum: (n: number) => {
          prodSum = n;
        },
        close: () => server.close(),
      });
    });
  });
}

function makeTokenFileE0c1(content = "faketoken"): string {
  const dir = mkdtempSync(join(tmpdir(), "e0c1-entry-tok-"));
  const p = join(dir, "token");
  writeFileSync(p, content);
  return p;
}

describe("E0c1 entry integration: per-run channels + board:agent-runs prep + §1.2 prod reads", () => {
  it("entry creates 3 per-run derived channels AND board:agent-runs (判据 6: in prep list)", async () => {
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c1-entry-rec-"));
    const tokFile = makeTokenFileE0c1();
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: "e0c1-entry-channels-001",
        // loop-engine CLI 不存在 ⇒ loop 步骤快速失败（exit 3），仍完成 channel 预备 + §1.2 读数 + 归档。
        LOOP_ENGINE_CLI: "/nonexistent/loop-engine/cli.js",
      };
      await runEntryDetached(env);
      const created = bus.createdChannels();
      // 判据 6：board:agent-runs 在预备清单内（单一真相源 RUNS_CHANNEL_ID）。
      expect(created).toContain(RUNS_CHANNEL_ID);
      // §1.3 / 判据 5：三条 per-run channel 名含本 run_id 的派生段，且形如 research:e0-<seg>.{...}。
      const seg = createHash("sha256").update("e0c1-entry-channels-001").digest("hex").slice(0, 16);
      expect(created).toContain(`research:e0-${seg}.index`);
      expect(created).toContain(`research:e0-${seg}.evidence`);
      expect(created).toContain(`research:e0-${seg}.docs`);
      // 判别性：不是固定 channel 名（不同 run 不同）。
      expect(created).not.toContain("research:e0-regression.index");
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
      rmSync(dirname(tokFile), { recursive: true, force: true });
    }
  }, 45000);

  it("§1.2: entry records prod_bus_sum_before in run.meta + prod_bus_sum_before.json", async () => {
    const bus = await startFakeBus();
    bus.setProdSum(42);
    const recRoot = mkdtempSync(join(tmpdir(), "e0c1-entry-rec2-"));
    const tokFile = makeTokenFileE0c1();
    const runId = "e0c1-entry-prodbefore-002";
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        LOOP_ENGINE_CLI: "/nonexistent/loop-engine/cli.js",
      };
      await runEntryDetached(env);
      const meta = readFileSync(join(recRoot, runId, "run.meta"), "utf8");
      expect(meta).toMatch(/prod_bus_sum_before=42/);
      // prod_bus_sum_before.json 落盘（真解析 JSON，含 sum + byChannel，供派发方独立复算）。
      const beforeJson = JSON.parse(readFileSync(join(recRoot, runId, "prod_bus_sum_before.json"), "utf8"));
      expect(beforeJson.sum).toBe(42);
      expect(Array.isArray(beforeJson.byChannel)).toBe(true);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
      rmSync(dirname(tokFile), { recursive: true, force: true });
    }
  }, 45000);

  it("§1.2 DISCRIMINATING: prod_bus_delta != 0 ⇒ entry exits 3 and records the delta", async () => {
    const bus = await startFakeBus();
    bus.setProdSum(10);
    const recRoot = mkdtempSync(join(tmpdir(), "e0c1-entry-rec3-"));
    const tokFile = makeTokenFileE0c1();
    const runId = "e0c1-entry-delta-003";
    // loop 失败快（CLI 不存在）；bumpTimer 在 loop 期间把 prodSum 改大，模拟生产总线被写入。
    const bumpTimer = setTimeout(() => bus.setProdSum(99), 600);
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        LOOP_ENGINE_CLI: "/nonexistent/loop-engine/cli.js",
      };
      const res = await runEntryDetached(env);
      // 判别性：生产总线零写入是硬不变量；delta != 0 ⇒ 入口判失败（exit 3）。
      const meta = readFileSync(join(recRoot, runId, "run.meta"), "utf8");
      expect(meta).toMatch(/prod_bus_delta=89/);
      expect(res.code).toBe(3);
    } finally {
      clearTimeout(bumpTimer);
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
      rmSync(dirname(tokFile), { recursive: true, force: true });
    }
  }, 45000);

  it("§1.4 / GT-2: entry refuses to start when SEED_SOURCES is empty", async () => {
    const bus = await startFakeBus();
    const recRoot = mkdtempSync(join(tmpdir(), "e0c1-entry-rec4-"));
    const tokFile = makeTokenFileE0c1();
    const runId = "e0c1-entry-seedfail-004";
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        AGENT_BUS_URL: bus.base,
        AGENT_BUS_TOKEN_FILE: tokFile,
        E0C1_PROD_BUS_URL: bus.base,
        E0C1_PROD_BUS_TOKEN_FILE: tokFile,
        E0_RECORD_ROOT: recRoot,
        DD_RUN_ID: runId,
        SEED_SOURCES: "", // GT-2：空 sources 必须响亮失败（不静默播 sources:[]）
        LOOP_ENGINE_CLI: "/nonexistent/loop-engine/cli.js",
      };
      const res = await runEntryDetached(env);
      expect(res.code).not.toBe(0);
      expect(res.stderr).toMatch(/SEED_SOURCES/);
    } finally {
      bus.close();
      rmSync(recRoot, { recursive: true, force: true });
      rmSync(dirname(tokFile), { recursive: true, force: true });
    }
  }, 45000);
});
