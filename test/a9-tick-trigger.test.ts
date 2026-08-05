/**
 * A9 —— tick 触发源 + 驱动运行器硬验收测试（spec §2 F1–F10）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举（spec §5.1 第 2 条）。
 * F7/F8 构成判别对（只差板面内容）；F9 两例（只差 hasPendingWork）；F10 连投两轮断言 id 唯一。
 * 驱动类断言用假 runner / 假 store-cli 记录 argv，⛔ 不触网、不跑真实 bus。
 */
import { execFileSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import { parse } from "yaml";
import { hasPendingWork } from "../src/tick";
import type { BoardCard, BoardState } from "../src/tick";
import { runChannelWrite } from "../src/tick-run";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

const TICK_MD = join(
  ROOT,
  "workflows",
  "deep-research",
  "tick",
  "templates",
  "tick.md",
);

function card(over: Partial<BoardCard> = {}): BoardCard {
  return {
    clueId: "clue_1",
    text: "investigate X",
    status: "open",
    depth: 0,
    sources: ["code-local"],
    retries: 0,
    ...over,
  };
}

function state(over: Partial<BoardState> = {}): BoardState {
  return { cards: [], runs: {}, triageInFlight: false, ...over };
}

// ── F7 / F8：hasPendingWork 判别对（只差板面内容）──────────────────

describe("F7: hasPendingWork === true when board has a non-terminal clue", () => {
  it("open clue ⇒ true", () => {
    expect(hasPendingWork(state({ cards: [card({ status: "open" })] }))).toBe(true);
  });
  it("in_flight clue ⇒ true", () => {
    expect(hasPendingWork(state({ cards: [card({ status: "in_flight" })] }))).toBe(true);
  });
  it("proposed clue ⇒ true", () => {
    expect(hasPendingWork(state({ cards: [card({ status: "proposed" })] }))).toBe(true);
  });
});

describe("F8: hasPendingWork === false when board is all-terminal", () => {
  it("all explored / dropped / blocked ⇒ false", () => {
    const s = state({
      cards: [
        card({ status: "explored" }),
        card({ status: "dropped" }),
        card({ status: "blocked" }),
      ],
    });
    expect(hasPendingWork(s)).toBe(false);
  });
  it("empty board ⇒ false", () => {
    expect(hasPendingWork(state({ cards: [] }))).toBe(false);
  });
});

// ── F1 / F2 / F3：驱动运行器（bun，绝不回退 node）────────────────

const SCRIPT = join(ROOT, "bin", "deep-research-loop.sh");

function runDriver(argv: string[], env: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("bash", argv, {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: err.status ?? -1,
      out: String(err.stdout ?? ""),
      err: String(err.stderr ?? ""),
    };
  }
}

function makeFakeEngine(): { dir: string; cli: string; storeCli: string; runner: string } {
  const dir = mkdtempSync(join(tmpdir(), "a9-fake-"));
  mkdirSync(join(dir, "dist", "lib"), { recursive: true });
  const cli = join(dir, "dist", "cli.js");
  const storeCli = join(dir, "dist", "lib", "store-cli.js");
  const runner = join(dir, "runner");
  writeFileSync(cli, "// fake cli");
  writeFileSync(storeCli, "// fake store-cli");
  writeFileSync(
    runner,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" >> "$RUNNER_LOG"\n`,
  );
  chmodSync(runner, 0o755);
  return { dir, cli, storeCli, runner };
}

describe("F1: driver has no hardcoded `node <cli> drain`", () => {
  it("bin/deep-research-loop.sh contains no `node \"$LOOP_ENGINE_CLI\"`", () => {
    const src = readFileSync(SCRIPT, "utf8");
    expect(src).not.toMatch(/node\s+"\$LOOP_ENGINE_CLI"\s+drain/);
    expect(src).not.toMatch(/node\s+"\$LOOP_ENGINE_CLI"/);
  });
});

describe("F2/F3: unresolvable runner ⇒ loud failure, never falls back to node", () => {
  it("LOOP_ENGINE_RUNNER points at a missing command ⇒ non-zero + text naming runner/bun", () => {
    const fake = makeFakeEngine();
    const res = runDriver([SCRIPT], {
      LOOP_ENGINE_CLI: fake.cli,
      LOOP_ENGINE_RUNNER: join(fake.dir, "does-not-exist"),
    });
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/runner|bun/i);
    expect(res.err).toMatch(/refusing|fall back to node/i);
    // 安全：绝不回退 node 执行 drain。
    expect(res.out).not.toMatch(/drain/);
    rmSync(fake.dir, { recursive: true, force: true });
  });
});

// ── F4 / F5：驱动在 drain 前投下可认领的首个触发 ──────────────────

describe("F4: driver puts a trigger into TRIGGER_STORE_DIR before drain", () => {
  it("runner log contains a put of a status:open trigger, then drain (no node)", () => {
    const fake = makeFakeEngine();
    const runRoot = mkdtempSync(join(tmpdir(), "a9-run-"));
    const log = join(fake.dir, "run.log");
    const res = runDriver([SCRIPT], {
      LOOP_ENGINE_CLI: fake.cli,
      LOOP_ENGINE_RUNNER: fake.runner,
      RUNNER_LOG: log,
      DD_RUN_ROOT: runRoot,
    });
    expect(res.code).toBe(0);
    const lines = readFileSync(log, "utf8").trim().split("\n");
    // 第一次调用：store-cli <dir> put <json>
    expect(lines[0]).toContain(fake.storeCli);
    expect(lines[1]).toContain(join(runRoot, "stores", "trigger"));
    expect(lines[2]).toBe("put");
    // 最后一次调用：cli drain（用 runner，不是 node）。
    expect(lines[4]).toContain(fake.cli);
    expect(lines[5]).toBe("drain");
    expect(lines[lines.length - 1]).toBe("deep-research");
    // 没有任何一行以 `node` 开头（绝不回退 node）。
    expect(lines.some((l) => l === "node")).toBe(false);
    rmSync(fake.dir, { recursive: true, force: true });
    rmSync(runRoot, { recursive: true, force: true });
  });
});

describe("F5: trigger record shape {id, status:'open', body} is claimable", () => {
  it("the put payload parses to an open trigger with id and body", () => {
    const fake = makeFakeEngine();
    const runRoot = mkdtempSync(join(tmpdir(), "a9-run-"));
    const log = join(fake.dir, "run.log");
    runDriver([SCRIPT], {
      LOOP_ENGINE_CLI: fake.cli,
      LOOP_ENGINE_RUNNER: fake.runner,
      RUNNER_LOG: log,
      DD_RUN_ROOT: runRoot,
    });
    const lines = readFileSync(log, "utf8").trim().split("\n");
    const payload = JSON.parse(lines[3]);
    expect(typeof payload.id).toBe("string");
    expect(payload.id.length).toBeGreaterThan(0);
    expect(payload.status).toBe("open");
    expect(payload.body).toBeTruthy();
    // id 唯一（首个触发也走 a9- 前缀）。
    expect(payload.id).toMatch(/^a9-/);
    rmSync(fake.dir, { recursive: true, force: true });
    rmSync(runRoot, { recursive: true, force: true });
  });
});

// ── F6：trigger_store_dir 四层贯通（bin → fleet → workflow → tick.md）──

describe("F6: trigger_store_dir wired end-to-end through the assembly", () => {
  it("four layers each carry trigger_store_dir", () => {
    const bin = readFileSync(SCRIPT, "utf8");
    const fleet = readFileSync(
      join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl"),
      "utf8",
    );
    const workflow = readFileSync(
      join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml"),
      "utf8",
    );
    const tickMd = readFileSync(TICK_MD, "utf8");
    // 1) bin：装配脚本导出 TRIGGER_STORE_DIR（触发存储的源头）。
    expect(bin).toMatch(/export\s+TRIGGER_STORE_DIR=/);
    // 2) fleet：声明 trigger_store_dir input，来源 ${TRIGGER_STORE_DIR}。
    expect(fleet).toMatch(/trigger_store_dir:\s*\$\{TRIGGER_STORE_DIR\}/);
    // 3) workflow：seed payload 注入 trigger_store_dir ← {{trigger_store_dir}}。
    expect(workflow).toMatch(/trigger_store_dir:\s*"\{\{trigger_store_dir\}\}"/);
    // 4) tick.md：读取 $trigger_store_dir 并据 hasPendingWork 决定续投。
    expect(tickMd).toMatch(/trigger_store_dir="\{\{trigger_store_dir\}\}"/);
    expect(tickMd).toMatch(/\$trigger_store_dir/);
    // 渲染后 input.trigger_store_dir 有非空值（真实 wiring 成立）。
    const rendered = execFileSync("bash", [SCRIPT, "--dry-run"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env },
    });
    const doc = parse(rendered);
    const tickInput = doc.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
    expect(tickInput).toBeTruthy();
    expect(typeof tickInput.trigger_store_dir).toBe("string");
    expect(tickInput.trigger_store_dir.length).toBeGreaterThan(0);
  });
});

// ── F9 / F10：tick.md 依 hasPendingWork 投下一条唯一 id 的触发 ─────

function renderTickMd(values: Record<string, string>): string {
  const tpl = readFileSync(TICK_MD, "utf8");
  return tpl.replace(/\{\{([a-z_]+)\}\}/g, (_m, key) => values[key] ?? "");
}

function makeFakeTick(values: {
  hasPendingWork: boolean;
  dir: string;
  runnerLog: string;
}): { tickEntry: string; runner: string; storeDir: string } {
  const tickEntry = join(values.dir, "tick-entry");
  writeFileSync(
    tickEntry,
    `#!/usr/bin/env bash\nprintf '%s\\n' '{"hasPendingWork": ${values.hasPendingWork}, "decisions": []}'\n`,
  );
  chmodSync(tickEntry, 0o755);
  const runner = join(values.dir, "runner");
  writeFileSync(
    runner,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${values.runnerLog}"\n`,
  );
  chmodSync(runner, 0o755);
  const storeDir = join(values.dir, "store");
  mkdirSync(storeDir, { recursive: true });
  return { tickEntry, runner, storeDir };
}

function runRenderedTick(values: Record<string, string>, outFile: string): string {
  const script = renderTickMd(values);
  writeFileSync(outFile, script);
  chmodSync(outFile, 0o755);
  return execFileSync("bash", [outFile], {
    cwd: ROOT,
    encoding: "utf8",
  });
}

describe("F9: tick.md puts a next trigger iff hasPendingWork === true", () => {
  it("hasPendingWork true ⇒ one trigger record written", () => {
    const dir = mkdtempSync(join(tmpdir(), "a9-tick-"));
    const log = join(dir, "puts.log");
    const { tickEntry, runner, storeDir } = makeFakeTick({
      hasPendingWork: true,
      dir,
      runnerLog: log,
    });
    writeFileSync(log, "");
    const out = runRenderedTick(
      {
        tick_entry: tickEntry,
        tick_channel: "research:p02-smoke-1dce60",
        evidence_channel: "",
        allowed_root: "",
        trigger_store_dir: storeDir,
        loop_store_cli: join(dir, "store-cli.js"),
        loop_engine_runner: runner,
      },
      join(dir, "tick.sh"),
    );
    const puts = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]).status).toBe("open");
    expect(out).toContain("hasPendingWork");
    rmSync(dir, { recursive: true, force: true });
  });

  it("hasPendingWork false ⇒ no trigger record written", () => {
    const dir = mkdtempSync(join(tmpdir(), "a9-tick-"));
    const log = join(dir, "puts.log");
    const { tickEntry, runner, storeDir } = makeFakeTick({
      hasPendingWork: false,
      dir,
      runnerLog: log,
    });
    writeFileSync(log, "");
    runRenderedTick(
      {
        tick_entry: tickEntry,
        tick_channel: "research:p02-smoke-1dce60",
        evidence_channel: "",
        allowed_root: "",
        trigger_store_dir: storeDir,
        loop_store_cli: join(dir, "store-cli.js"),
        loop_engine_runner: runner,
      },
      join(dir, "tick.sh"),
    );
    const puts = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    expect(puts).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("F10: trigger id is unique across rounds", () => {
  it("two consecutive puts produce two distinct ids", () => {
    const dir = mkdtempSync(join(tmpdir(), "a9-tick-"));
    const log = join(dir, "puts.log");
    const { tickEntry, runner, storeDir } = makeFakeTick({
      hasPendingWork: true,
      dir,
      runnerLog: log,
    });
    writeFileSync(log, "");
    const scriptFile = join(dir, "tick.sh");
    for (let i = 0; i < 2; i += 1) {
      runRenderedTick(
        {
          tick_entry: tickEntry,
          tick_channel: "research:p02-smoke-1dce60",
          evidence_channel: "",
          allowed_root: "",
          trigger_store_dir: storeDir,
          loop_store_cli: join(dir, "store-cli.js"),
          loop_engine_runner: runner,
        },
        scriptFile,
      );
    }
    const puts = readFileSync(log, "utf8").trim().split("\n").filter(Boolean);
    expect(puts).toHaveLength(2);
    const id0 = JSON.parse(puts[0]).id as string;
    const id1 = JSON.parse(puts[1]).id as string;
    expect(id0).not.toBe(id1);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── F9/F10 判别性：生产装配形状（裸可执行路径，无内嵌 `bash ` 前缀）────────────────
// 评审 finding：makeFakeTick 用裸路径而装配系统曾携带 `bash "…tick-entry.sh"` ⇒ 测试全绿而
// 真实调用形状是坏的。这里断言生产 TICK_ENTRY 是裸可执行路径，且 tick.md 以单个引号词直接执行它。

describe("F9/F10: production TICK_ENTRY is a bare executable path (no embedded `bash ` prefix)", () => {
  it("bin/deep-research-loop.sh exports TICK_ENTRY without a `bash ` prefix", () => {
    const src = readFileSync(SCRIPT, "utf8");
    const line = src.split("\n").find((l) => /^export\s+TICK_ENTRY=/.test(l));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/bash\s+"/);
    expect(line).toMatch(/tick-entry\.sh/);
  });

  it("tick.md invokes $tick_entry as a single quoted command word (bare path works)", () => {
    const tpl = readFileSync(TICK_MD, "utf8");
    expect(tpl).toMatch(/\$\{?tick_entry\}?/);
    expect(tpl).toMatch(/"\$tick_entry" --run/);
    expect(tpl).not.toMatch(/eval\s+\$tick_entry/);
  });
});

// ── F9（生产路径）：收割把最后一张非终态卡推进终态 + 发布新 proposed clue ⇒ hasPendingWork 仍为 true ──
// 评审 blocker：postWriteState（applyCasOutcomes）只重写写前快照里已有的卡，本 tick 经 harvest
//   新发布的 clue（status=proposed）不在其中。若被收割的卡恰是最后一张非终态卡，写后板面全为终态，
//   hasPendingWork 会错误地判 false，导致新发布的 proposed clue 被静默搁浅、续投被跳过。
//   断言生产路径 runChannelWrite 返回的 hasPendingWork 必须为 true（不得只验单元层 hasPendingWork）。

describe("F9 production path: harvest terminalizes last card + publishes clues ⇒ hasPendingWork stays true", () => {
  it("runChannelWrite reports hasPendingWork=true when harvest publishes a new proposed clue", async () => {
    const channel = "research:p02-smoke-1dce60";
    const inFlightMsg = {
      message_id: "msg_clue_1",
      channel_id: channel,
      channel_seq: 1,
      kind: "research.clue.v2",
      payload: {
        status: "in_flight",
        text: "investigate X",
        depth: 0,
        sources: ["code-local"],
        run_id: "run-1",
      },
      entity_id: "card_x",
      supersedes: null,
      created_at: "2026-01-01T00:00:00Z",
    };
    const runsMessages = [
      {
        message_id: "run_exit",
        channel_id: "board:agent-runs",
        channel_seq: 1,
        kind: "agent.run.exited.v1",
        payload: { run_id: "run-1", exit_code: 0 },
        entity_id: "run-1",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
      {
        message_id: "result_1",
        channel_id: "board:agent-runs",
        channel_seq: 2,
        kind: "worker.result.v1",
        payload: {
          run_id: "run-1",
          evidences: [
            { quote: "q1", claim: "c1", source: "code", locator: "a", revision: "r" },
          ],
          proposed_clues: [{ clue: "new idea" }],
          materials: [],
        },
        entity_id: "run-1",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    let clueCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse({ head: inFlightMsg });
        }
        if (/\/v1\/channels\/[^/]+\/publish/.test(u)) {
          return jsonResponse({ message_id: "p_x", channel_seq: 99 });
        }
        if (u.includes(`/v1/channels/${channel}/messages`)) {
          clueCalls += 1;
          return jsonResponse({ messages: clueCalls === 1 ? [inFlightMsg] : [] });
        }
        if (u.includes("/v1/channels/board:agent-runs/messages")) {
          const hasAfterSeq = /[?&]after_seq=/.test(u);
          return jsonResponse({ messages: hasAfterSeq ? [] : runsMessages });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    const outcome = await runChannelWrite({
      channelId: channel,
      evidenceChannelId: `${channel}.evidence`,
    });

    // 判别性：收割确实发布了 1 条新 proposed clue，且把最后一张非终态卡 CAS 到 explored。
    expect(outcome.harvestReports).toHaveLength(1);
    expect(outcome.harvestReports[0].cluesPublished).toBe(1);
    // ⛔ 关键断言：写后板面（仅含 explored 的旧卡）无待处理工作，但新发布的 proposed clue 必须
    //   让 hasPendingWork 仍为 true，否则该 clue 会被静默搁浅（spec §1.3 / §3.2）。
    expect(outcome.hasPendingWork).toBe(true);
  });
});
