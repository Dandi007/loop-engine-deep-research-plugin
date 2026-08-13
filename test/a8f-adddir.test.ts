/**
 * A8f —— `--add-dir` + `revision`（spec §2 硬验收 F1–F10）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举（spec §3.2 纪律 2）。
 * 判据核心是 F1–F4 走**完整生产入口**（runChannelWrite 未注入 spawnWorker），
 * 对真实 `agent-run` 桩读回 argv 与 `--input` 载荷文件内容求值（spec §2 F2–F4）。
 * 安全性断言（F5）配活性断言（F6 / F7）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import {
  runChannelWrite,
  buildWorkerInput,
  buildAgentRunArgv,
  resolveRevision,
  MissingAllowedRootError,
  ContentTranscriptMissingError,
  spoolFileName,
  parseDigestFromContentClue,
  CODE_LOCAL_ROLE,
  CONTENT_ROLE,
} from "../src/tick-run";
import type { WorkerInputPayload } from "../src/tick-run";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const WIRE_CHANNEL = "research:p02-smoke-1dce60";

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

// ── 共享 fixture：一个可执行 `agent-run` 桩，把每次调用的 argv 与 `--input` 内容回录 ──

interface AgentRunBlock {
  cmd: string;
  args: string[];
  inputPath?: string;
  inputContent?: string;
}

function makeAgentRunStub(marker: string): string {
  const dir = join(tmpdir(), `a8f-agent-run-dir-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  const stub = join(dir, "agent-run");
  writeFileSync(
    stub,
    `#!/bin/sh\nprintf '%s\\n' "CMD=$0" >> "${marker}"\nprev=""
for a in "$@"; do
  if [ "$prev" = "--input" ]; then
    printf '%s\\n' "INPUT_FILE=$a" >> "${marker}"
    if [ -f "$a" ]; then printf '%s\\n' "INPUT_CONTENT=$(cat "$a")" >> "${marker}"; fi
  fi
  printf '%s\\n' "$a" >> "${marker}"
  prev="$a"
done\nprintf '%s\\n' "---" >> "${marker}"\nexit 0\n`,
  );
  chmodSync(stub, 0o755);
  return stub;
}

function readAgentRunBlocks(marker: string): AgentRunBlock[] {
  if (!existsSync(marker)) return []; // E1b D5：零 spawn ⇒ marker 未创建 ⇒ 无 block。
  const blocks: AgentRunBlock[] = [];
  let current: AgentRunBlock | null = null;
  for (const line of readFileSync(marker, "utf8").split("\n")) {
    if (line === "---") {
      if (current) blocks.push(current);
      current = null;
    } else if (line.startsWith("CMD=")) {
      current = { cmd: line.slice(4), args: [] };
    } else if (line.startsWith("INPUT_FILE=")) {
      if (current) current.inputPath = line.slice("INPUT_FILE=".length);
    } else if (line.startsWith("INPUT_CONTENT=")) {
      if (current) current.inputContent = line.slice("INPUT_CONTENT=".length);
    } else if (line !== "" && current) {
      current.args.push(line);
    }
  }
  return blocks;
}

function readUntilMarker(marker: string, timeoutMs = 4000): void {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(marker)) {
    if (Date.now() > deadline) throw new Error(`agent-run stub marker not created: ${marker}`);
  }
}

function openClueMsg(clueId: string, text: string, sources: string[]) {
  return {
    message_id: `msg_${clueId}`,
    channel_id: WIRE_CHANNEL,
    channel_seq: 1,
    kind: "research.clue.v2",
    payload: { status: "open", text, depth: 0, sources },
    entity_id: clueId,
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

function stubBus(clues: unknown[], contentMessages: unknown[] = []) {
  let clueCalls = 0;
  let runsCalls = 0;
  let contentCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/entities/")) {
        return jsonResponse({ head: clues[0] });
      }
      if (u.includes(`/v1/channels/${WIRE_CHANNEL}/messages`)) {
        clueCalls += 1;
        return jsonResponse({ messages: clueCalls === 1 ? clues : [] });
      }
      if (u.includes("/v1/channels/board:agent-runs/messages")) {
        runsCalls += 1;
        return jsonResponse({ messages: [] });
      }
      // E1b D1——content channel (research:content)：spool 步骤从这里读 transcript body。
      if (u.includes("/v1/channels/research:content/messages")) {
        contentCalls += 1;
        return jsonResponse({ messages: contentCalls === 1 ? contentMessages : [] });
      }
      return jsonResponse({ messages: [] });
    }),
  );
}

interface DispatchResult {
  outcome: Awaited<ReturnType<typeof runChannelWrite>> | null;
  blocks: AgentRunBlock[];
  gitDir: string;
}

/**
 * 走生产缺省 spawn 路径（runChannelWrite 不注入 spawnWorker），跑一次 dispatch。
 * `allowedRoot` 传 undefined 表示**不配置**（F5 用）；`gitDir` 表示把 allowedRoot 做成真实 git 仓库（F4 用）。
 * `contentMessages`：research:content 上的 doc(transcript) 消息列表（E1b D1 spool 测试用）。
 * `contentSpoolRoot`：content worker 的 spool 根目录（E1b D1/D2 测试用）。
 * `clueText`：覆盖 clue 文本（E1b D3：content clue text 形如 web://<uri>@<digest>）。
 */
async function runDispatch(opts: {
  sources: string[];
  allowedRoot?: string;
  gitDir?: boolean;
  contentMessages?: unknown[];
  contentSpoolRoot?: string;
  clueText?: string;
  clueId?: string;
}): Promise<DispatchResult> {
  const marker = join(tmpdir(), `a8f-marker-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
  const stub = makeAgentRunStub(marker);
  const prevBin = process.env.AGENT_RUN_BIN;
  process.env.AGENT_RUN_BIN = stub;
  const cleanup: string[] = [dirname(stub)];

  let allowedRoot = opts.allowedRoot;
  if (opts.gitDir && !allowedRoot) {
    // 仅当调用方没有显式给 allowedRoot 时才新建仓库；否则沿用（promote）既有目录，
    // 避免用第二个新仓库静默遮蔽调用方传入的 allowedRoot（revision 必须来自同一仓库）。
    allowedRoot = makeGitDir();
    cleanup.push(allowedRoot);
  }
  // 其余情况：allowedRoot 保持调用方给定的值（undefined = 不配置，F7 用）。

  const clueId = opts.clueId ?? "clue_x";
  const clue = openClueMsg(clueId, opts.clueText ?? "investigate A8f", opts.sources);
  stubBus([clue], opts.contentMessages ?? []);

  try {
    const outcome = await runChannelWrite({
      channelId: WIRE_CHANNEL,
      allowedRoot,
      ...(opts.contentSpoolRoot ? { contentSpoolRoot: opts.contentSpoolRoot } : {}),
    });
    // E1b D5：transcript 取不到 ⇒ 零 spawn（marker 不会创建）；只在实际 spawn 时等 marker。
    if (existsSync(marker)) {
      readUntilMarker(marker);
    }
    return { outcome, blocks: readAgentRunBlocks(marker), gitDir: allowedRoot ?? "" };
  } finally {
    rmSync(marker, { force: true });
    for (const d of cleanup) rmSync(d, { recursive: true, force: true });
    if (prevBin === undefined) delete process.env.AGENT_RUN_BIN;
    else process.env.AGENT_RUN_BIN = prevBin;
  }
}

function makeGitDir(): string {
  const d = mkdtempSync(join(tmpdir(), "a8f-git-"));
  execFileSync("git", ["init", "-q", d]);
  writeFileSync(join(d, "f.txt"), "x\n");
  execFileSync("git", ["-C", d, "add", "f.txt"]);
  execFileSync("git", ["-C", d, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  return d;
}

function runShell(argv: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("bash", argv, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

// ── F1：生产链路贯通（四层各一条断言）──────────────────────────────

describe("F1: ALLOWED_ROOT wired end-to-end through the production assembly", () => {
  it("deep-research-loop.sh → fleet → workflow → tick.md → --allowed-root", () => {
    const loop = readFileSync(join(ROOT, "bin", "deep-research-loop.sh"), "utf8");
    const tpl = readFileSync(join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl"), "utf8");
    const wf = readFileSync(join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml"), "utf8");
    const tickMd = readFileSync(
      join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md"),
      "utf8",
    );
    // 1) 装配脚本导出 ALLOWED_ROOT（有值，渲染才不失败）。
    expect(loop).toMatch(/export\s+ALLOWED_ROOT=/);
    // 2) fleet 声明 allowed_root input，来源是 ${ALLOWED_ROOT}。
    expect(tpl).toMatch(/allowed_root:\s*\$\{ALLOWED_ROOT\}/);
    // 3) workflow seed payload 把 allowed_root 从 pipeline input namespace 注入。
    //    A9 评审修复：可选占位符 `{{allowed_root?}}` —— ALLOWED_ROOT 缺省为空（null）⇒ 必填
    //    `{{allowed_root}}` 填充即抛「模板填充缺值」⇒ tick 节点无法起跑；`?` 渲成空串。
    expect(wf).toMatch(/allowed_root:\s*"\{\{allowed_root\?\}\}"/);
    // 4) tick.md 在非空 allowed_root 时确实把 --allowed-root 传给 --run。
    expect(tickMd).toMatch(/\-\-allowed-root\s+"\$allowed_root"/);
  });

  it("rendered fleet pipeline input carries the explicit ALLOWED_ROOT value", () => {
    const explicit = "/data/code/self/agent-runtime";
    const rendered = runShell(
      [join(ROOT, "bin", "deep-research-loop.sh"), "--dry-run"],
      { ALLOWED_ROOT: explicit, TICK_CHANNEL: "research:v1-test.index", RESEARCH_QUESTION: "test research question" },
    );
    const doc = parse(rendered);
    const tickInput = doc.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
    expect(tickInput).toBeTruthy();
    expect(tickInput.allowed_root).toBe(explicit);
  });
});

// ── F2：生产默认 argv 含相邻对 ["--add-dir", <allowed_root>] ─────────

describe("F2: production default argv carries adjacent --add-dir pair", () => {
  it("runChannelWrite default spawn argv has [--add-dir, <allowed_root>]", async () => {
    const d = mkdtempSync(join(tmpdir(), "a8f-root-"));
    try {
      const { blocks } = await runDispatch({ sources: ["code-local"], allowedRoot: d });
      expect(blocks).toHaveLength(1);
      const argv = blocks[0].args;
      const idx = argv.indexOf("--add-dir");
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(argv[idx + 1]).toBe(d);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ── F3：生产路径写出的载荷文件含 allowed_root，值 === 配置值 ───────

describe("F3: written payload file carries allowed_root equal to config", () => {
  it("read the --input payload file: allowed_root === configured value", async () => {
    const d = mkdtempSync(join(tmpdir(), "a8f-root-"));
    try {
      const { blocks } = await runDispatch({ sources: ["code-local"], allowedRoot: d });
      expect(blocks).toHaveLength(1);
      const parsed = JSON.parse(blocks[0].inputContent ?? "{}") as WorkerInputPayload;
      expect(parsed.allowed_root).toBe(d);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ── F4：真实 git 目录 ⇒ 载荷 revision === git rev-parse HEAD ────────

describe("F4: payload revision equals git rev-parse HEAD of a real git dir", () => {
  it("read the --input payload file: revision === actual sha", async () => {
    const d = makeGitDir();
    const sha = execFileSync("git", ["-C", d, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    try {
      const { blocks } = await runDispatch({ sources: ["code-local"], allowedRoot: d });
      expect(blocks).toHaveLength(1);
      const parsed = JSON.parse(blocks[0].inputContent ?? "{}") as WorkerInputPayload;
      expect(parsed.revision).toBe(sha);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ── F5 + F6：code-local 无 root ⇒ 响亮失败零 spawn；有 root ⇒ spawn ──

describe("F5: code-local without allowed_root ⇒ loud failure naming allowed-root, zero spawn", () => {
  it("runChannelWrite rejects (text contains allowed-root) and spawns nothing", async () => {
    const marker = join(tmpdir(), `a8f-f5-${Date.now()}-${Math.random().toString(36).slice(2)}.log`);
    const stub = makeAgentRunStub(marker);
    const prevBin = process.env.AGENT_RUN_BIN;
    process.env.AGENT_RUN_BIN = stub;
    const clue = openClueMsg("clue_x", "investigate", ["code-local"]);
    stubBus([clue]);
    try {
      // 不传 allowedRoot ⇒ code-local dispatch 必须响亮失败（非零/抛错，文本含 allowed-root）。
      let err: unknown;
      try {
        await runChannelWrite({ channelId: WIRE_CHANNEL });
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(MissingAllowedRootError);
      expect((err as Error).message).toMatch(/allowed-root/);
      // 零 spawn：未拉起任何进程（marker 未创建）。
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(marker, { force: true });
      rmSync(dirname(stub), { recursive: true, force: true });
      if (prevBin === undefined) delete process.env.AGENT_RUN_BIN;
      else process.env.AGENT_RUN_BIN = prevBin;
    }
  });
});

describe("F6: code-local with allowed_root ⇒ spawns once (liveness paired with F5)", () => {
  it("runChannelWrite default spawn launches exactly one process", async () => {
    const d = mkdtempSync(join(tmpdir(), "a8f-root-"));
    try {
      const { blocks, outcome } = await runDispatch({ sources: ["code-local"], allowedRoot: d });
      expect(blocks).toHaveLength(1);
      expect(outcome?.spawns).toHaveLength(1);
      expect(outcome?.spawns[0].spawned).toBe(true);
      expect(outcome?.spawns[0].role).toBe(CODE_LOCAL_ROLE);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

// ── F7：wiki / feishu / code-remote 不因缺 allowed_root 被阻断 ───────

describe("F7: non-code-local roles are not blocked by missing allowed_root", () => {
  for (const [role, source] of [
    ["dr-worker-wiki", "wiki"],
    ["dr-worker-feishu", "feishu"],
    ["dr-worker-code-remote", "code-remote"],
  ] as const) {
    it(`${role} still spawns without allowed_root`, async () => {
      const { blocks, outcome } = await runDispatch({ sources: [source] });
      expect(blocks).toHaveLength(1);
      expect(outcome?.spawns[0].role).toBe(role);
      expect(outcome?.spawns[0].spawned).toBe(true);
    });
  }
});

// ── E1b D1/D2/D5：content worker 的 allowed_root = spool 根（⛔ 不是 --allowed-root）──
//    GT-1：content worker 拿到的 allowed_root 是代码仓根，而 transcript 根本不在那儿。
//    D1：派发前先把 transcript body 落成 spool 本地文件；D2：allowed_root = spool 根；
//    D5：transcript 取不到 ⇒ 该 clue blocked、零 spawn。

/** 造一条 research:content 上的 doc(transcript) 消息（D1 spool 取材源）。 */
function contentDocMessage(digest: string, body: string, origin = "http://127.0.0.1:50287/e1-material.png") {
  return {
    message_id: `msg_doc_${digest.slice(0, 8)}`,
    channel_id: "research:content",
    channel_seq: 1,
    kind: "research.doc.v2",
    payload: { doc_kind: "transcript", digest, body, origin },
    entity_id: `doc_${digest.slice(0, 8)}`,
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

describe("E1b D1/D2: content dispatch spools transcript + allowed_root = spool root (NOT --allowed-root)", () => {
  it("⭐⭐ D1/D2 discriminating: content clue ⇒ transcript body spooled to file under spool root, worker allowed_root === spool root (NOT --allowed-root)", async () => {
    const digest = "63ac13abaabf5726e675d8fbb5ccda36a960767ba5b860448e701ada88f5e43b";
    const body = "# transcript body\nLine1\nLine2\n";
    const spoolRoot = mkdtempSync(join(tmpdir(), "e1b-spool-"));
    // --allowed-root 指向代码仓根（GT-1 的错配值）；content worker 的 allowed_root 必须是 spool 根、而非它。
    const codeRepoRoot = mkdtempSync(join(tmpdir(), "e1b-coderepo-"));
    try {
      const { blocks, outcome } = await runDispatch({
        sources: ["content"],
        clueId: "clue_content",
        clueText: `web://http://127.0.0.1:50287/e1-material.png@${digest}`,
        contentMessages: [contentDocMessage(digest, body)],
        contentSpoolRoot: spoolRoot,
        allowedRoot: codeRepoRoot,
      });
      // (a) spool 根下真的出现了内容逐字等于 transcript body 的文件（判据 2a）。
      const spooledPath = join(spoolRoot, spoolFileName(digest));
      expect(existsSync(spooledPath)).toBe(true);
      expect(readFileSync(spooledPath, "utf8")).toBe(body);
      // (b) spawn 参数与 worker input 里的 allowed_root === spool 根、⛔ !== --allowed-root（判据 2b）。
      expect(blocks).toHaveLength(1);
      expect(outcome?.spawns[0].role).toBe(CONTENT_ROLE);
      expect(outcome?.spawns[0].spawned).toBe(true);
      const addDirIdx = blocks[0].args.indexOf("--add-dir");
      expect(addDirIdx).toBeGreaterThanOrEqual(0);
      expect(blocks[0].args[addDirIdx + 1]).toBe(spoolRoot);
      expect(blocks[0].args[addDirIdx + 1]).not.toBe(codeRepoRoot);
      const parsed = JSON.parse(blocks[0].inputContent ?? "{}") as WorkerInputPayload;
      expect(parsed.allowed_root).toBe(spoolRoot);
      expect(parsed.allowed_root).not.toBe(codeRepoRoot);
    } finally {
      rmSync(spoolRoot, { recursive: true, force: true });
      rmSync(codeRepoRoot, { recursive: true, force: true });
    }
  });

  it("⭐ D2 content revision: content worker payload omits revision (NOT code repo HEAD, GT-1)", async () => {
    const digest = "abc123def4567890abcdef1234567890abcdef1234567890abcdef1234567890";
    const spoolRoot = mkdtempSync(join(tmpdir(), "e1b-spool-rev-"));
    // 把 --allowed-root 做成真实 git 仓 ⇒ 若 content 误取了 HEAD，revision 会是非空 sha。
    const gitRepo = makeGitDir();
    try {
      const { blocks } = await runDispatch({
        sources: ["content"],
        clueText: `web://http://x/x.pdf@${digest}`,
        contentMessages: [contentDocMessage(digest, "body")],
        contentSpoolRoot: spoolRoot,
        allowedRoot: gitRepo,
        gitDir: false,
      });
      expect(blocks).toHaveLength(1);
      const parsed = JSON.parse(blocks[0].inputContent ?? "{}") as Record<string, unknown>;
      // content 的 revision 不得再取代码仓 HEAD（GT-1：那与 transcript 无关）。
      expect(parsed).not.toHaveProperty("revision");
    } finally {
      rmSync(spoolRoot, { recursive: true, force: true });
      rmSync(gitRepo, { recursive: true, force: true });
    }
  });
});

describe("E1b D5: content clue transcript not found ⇒ blocked, zero spawn", () => {
  it("⭐ D5 discriminating: digest not on research:content ⇒ clue blocked (zero spawn, spawn record false)", async () => {
    const digest = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    const spoolRoot = mkdtempSync(join(tmpdir(), "e1b-spool-miss-"));
    try {
      const { blocks, outcome } = await runDispatch({
        sources: ["content"],
        clueId: "clue_missing",
        clueText: `web://http://127.0.0.1:50287/missing.png@${digest}`,
        // research:content 上没有该 digest 的 transcript。
        contentMessages: [],
        contentSpoolRoot: spoolRoot,
      });
      expect(outcome).toBeTruthy();
      // 零 spawn（判据 6）：agent-run stub 未被调用（无 block）、spawn 记录 spawned:false。
      expect(blocks).toHaveLength(0);
      const spawnRec = outcome!.spawns.find((s) => s.clueId === "clue_missing");
      expect(spawnRec).toBeTruthy();
      expect(spawnRec!.spawned).toBe(false);
      expect(spawnRec!.role).toBe(CONTENT_ROLE);
      // D5 不静默跳过：该卡经两次 CAS（open→in_flight→blocked），writes ≥ 2（非零、非 skipped）。
      expect(outcome!.writes).toBeGreaterThanOrEqual(2);
      expect(outcome!.skipped).toBe(0);
    } finally {
      rmSync(spoolRoot, { recursive: true, force: true });
    }
  });

  it("D5 unit: ContentTranscriptMissingError carries the digest", () => {
    const e = new ContentTranscriptMissingError("deadbeef");
    expect(e.digest).toBe("deadbeef");
    expect(e.message).toMatch(/deadbeef/);
    expect(e.message).toMatch(/research:content/);
  });
});

describe("E2b W1: web-search dispatch spawns dr-worker-web (no allowed_root requirement)", () => {
  it("web-search dispatch without allowed_root ⇒ spawns once as dr-worker-web", async () => {
    const { blocks, outcome } = await runDispatch({ sources: ["web-search"] });
    expect(blocks).toHaveLength(1);
    expect(outcome?.spawns).toHaveLength(1);
    expect(outcome?.spawns[0].spawned).toBe(true);
    expect(outcome?.spawns[0].role).toBe("dr-worker-web");
  });
});

// ── F8 + F9：非 git 目录 ⇒ 省略 revision；绝不填空串 ──────────────

describe("F8: non-git allowed_root ⇒ payload omits revision but still spawns", () => {
  it("revision key absent in the written payload, spawn still happens", async () => {
    const d = mkdtempSync(join(tmpdir(), "a8f-nongit-"));
    try {
      const { blocks, outcome } = await runDispatch({ sources: ["code-local"], allowedRoot: d });
      expect(blocks).toHaveLength(1);
      expect(outcome?.spawns).toHaveLength(1);
      const parsed = JSON.parse(blocks[0].inputContent ?? "{}") as Record<string, unknown>;
      expect(parsed).not.toHaveProperty("revision");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});

describe("F9: never write an empty revision string", () => {
  it("resolveRevision on a non-git dir returns undefined, not ''", () => {
    const d = mkdtempSync(join(tmpdir(), "a8f-nongit-"));
    try {
      const rev = resolveRevision(d);
      expect(rev).toBeUndefined();
      expect(rev).not.toBe("");
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it("production payload never contains revision === '' (git and non-git)", async () => {
    const gitDir = makeGitDir();
    const nonGit = mkdtempSync(join(tmpdir(), "a8f-nongit-"));
    try {
      for (const d of [gitDir, nonGit]) {
        const { blocks } = await runDispatch({ sources: ["code-local"], allowedRoot: d });
        const parsed = JSON.parse(blocks[0].inputContent ?? "{}") as Record<string, unknown>;
        if ("revision" in parsed) {
          expect(parsed.revision).not.toBe("");
        }
      }
    } finally {
      rmSync(gitDir, { recursive: true, force: true });
      rmSync(nonGit, { recursive: true, force: true });
    }
  });

  it("buildWorkerInput without revision omits the key (not empty)", () => {
    const input = buildWorkerInput("c", "t", 0, ["wiki"]);
    expect(input).not.toHaveProperty("revision");
    const withRev = buildWorkerInput("c", "t", 0, ["wiki"], undefined, "abc");
    expect(withRev.revision).toBe("abc");
  });
});

// ── F10：无 allowed_root 时 argv 不含 --add-dir ─────────────────────

describe("F10: argv excludes --add-dir when no allowed_root", () => {
  it("non-code-local default spawn argv has no --add-dir", async () => {
    const { blocks } = await runDispatch({ sources: ["wiki"] });
    expect(blocks).toHaveLength(1);
    expect(blocks[0].args).not.toContain("--add-dir");
  });

  it("buildAgentRunArgv without allowedRoot has no --add-dir", () => {
    const argv = buildAgentRunArgv({
      agentRunBin: "/x/agent-run",
      role: "dr-worker-wiki",
      runId: "r",
      inputPath: "/tmp/in.json",
      clueText: "t",
    });
    expect(argv).not.toContain("--add-dir");
  });
});

// ── E1b D1/D3 纯函数：parseDigestFromContentClue / spoolFileName ────────

describe("E1b D1/D3 pure: parseDigestFromContentClue + spoolFileName (deterministic)", () => {
  it("parseDigestFromContentClue extracts digest from web://<uri>@<digest>", () => {
    const d = parseDigestFromContentClue("web://http://x/y.pdf@deadbeef");
    expect(d).toBe("deadbeef");
  });

  it("parseDigestFromContentClue returns null for non-content-clue text", () => {
    expect(parseDigestFromContentClue("investigate content")).toBeNull();
    expect(parseDigestFromContentClue("transcript digest=x origin=y")).toBeNull();
  });

  it("spoolFileName is deterministic: same digest ⇒ same filename, .md suffix", () => {
    const digest = "abc123";
    expect(spoolFileName(digest)).toBe(`${digest}.md`);
    expect(spoolFileName(digest)).toBe(spoolFileName(digest));
  });
});
