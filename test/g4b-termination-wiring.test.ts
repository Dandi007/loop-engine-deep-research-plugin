/**
 * G4b(v2) —— 终态贯通：生产 `--run` 计算并返回终止判定 + 跨 tick 计数经 trigger body 传递。
 *
 * 根因（spec §0）：
 *  - §0.1：生产 `--run`（runChannelWrite）从不调用 decideTermination ⇒ JSON 输出无 termination。
 *  - §0.2：prevCoverage / prevZeroGrowthRounds 无跨 tick 持久化（恒传 0/0）⇒ zeroGrowthRounds 恒 ≤ 1，
 *          阈值 2 永不达成 ⇒ 「正常收敛」不可达，唯一终态是 capped（触顶）。
 *
 * 硬验收（spec §2）：
 *  - R1  可达性：从生产入口 runChannelWrite 出发的用例，其 JSON 输出含 termination（只验 selfcheck/inspect 不算）。
 *  - R2  ⭐ 「正常收敛」可达：连续多轮零增长 ⇒ zeroGrowthRounds 能长到 ≥ 2 且 state === "converged"。
 *        ⛔ 这条在改动前必然挂——它是本包的存在理由。
 *  - R3  判别性：同样多轮但覆盖度有增长 ⇒ zeroGrowthRounds 被重置、不得收敛。
 *  - R4  跨 tick 传递真的经过 trigger body：续投写出的 trigger body 里含本轮 coverage/zeroGrowthRounds，
 *        且下一轮从渲染后的 body 读回。两端各一条。
 *  - R5  ⛔ body 缺失/损坏 ⇒ 响亮失败，不得静默回落 0/0。正反两例。
 *  - R6  capped 与 converged 仍然可区分：触顶路径产出 capped，零增长路径产出 converged。
 *
 * 变异矩阵（spec §3）：
 *  - S1  去掉跨 tick 传递（prevZeroGrowthRounds 恒传 0）⇒ R2 必须挂。
 *  - S2  body 缺失时静默回落 0/0（去掉响亮失败）⇒ R5 的失败侧必须挂。
 *  - S3  coverage 增长时不重置 zeroGrowthRounds（照单 +1）⇒ R3 必须挂。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  runChannelWrite,
  parseRunCliArgs,
  parsePrevCounters,
  InvalidTriggerBodyError,
} from "../src/tick-run";
import { decideTermination, DEFAULT_TICK_CONFIG } from "../src/tick";
import type { BoardCard } from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TICK_MD = join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md");
const cfg = DEFAULT_TICK_CONFIG;

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data, text: async () => JSON.stringify(data) };
}

function afterEachClean() {
  vi.unstubAllGlobals();
}

/**
 * 构造一个全终态板面（无 in_flight / open / proposed），用于触发终态判定。
 * coveredClueIds 控制 coverage：有 evidence 的 clue_id 全集。
 */
function clueMsg(seq: number, entityId: string, status: string, runId?: string) {
  return {
    message_id: `m${seq}`,
    channel_id: "research:test",
    channel_seq: seq,
    kind: "research.clue.v2",
    payload: { status, text: "t", depth: 0, sources: [], ...(runId ? { run_id: runId } : {}) },
    entity_id: entityId,
    supersedes: null,
    created_at: "",
  };
}

function evidenceMsg(seq: number, clueId: string) {
  return {
    message_id: `e${seq}`,
    channel_id: "research:test",
    channel_seq: seq,
    kind: "research.evidence.v2",
    payload: { clue_id: clueId },
    entity_id: `e${seq}`,
    supersedes: null,
    created_at: "",
  };
}

/**
 * 打桩 fetch：board channel 返回指定 clue/evidence 消息；board:agent-runs 返回空。
 * 用于 runChannelWrite 的读板 + 终态判定。
 */
function stubBoardFetch(opts: {
  channelId: string;
  messages: unknown[];
  publishes?: Array<Record<string, unknown>>;
}) {
  const publishes = opts.publishes ?? [];
  let clueCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/entities/")) {
        return jsonResponse({ head: { payload: { status: "explored" } } });
      }
      if (u.includes("/publish")) {
        publishes.push(JSON.parse(String(init?.body)));
        return jsonResponse({ message_id: `p_${publishes.length}`, channel_seq: 99 });
      }
      if (u.includes(`/v1/channels/${opts.channelId}/messages`)) {
        clueCalls += 1;
        return jsonResponse({ messages: clueCalls === 1 ? opts.messages : [] });
      }
      if (u.includes("/v1/channels/board:agent-runs/messages")) {
        return jsonResponse({ messages: [] });
      }
      return jsonResponse({ messages: [] });
    }),
  );
  return publishes;
}

afterEach(afterEachClean);

// ── R1：可达性——生产入口 runChannelWrite 的 JSON 输出含 termination ──────

describe("R1: production --run output carries termination (not just selfcheck/inspect)", () => {
  it("runChannelWrite on a fully-terminal board returns a non-null termination object", async () => {
    const channel = "research:r1-test";
    // 全 explored 板面（drained）+ 一条 evidence ⇒ coverage=1。
    const messages = [
      clueMsg(1, "c1", "explored"),
      evidenceMsg(2, "c1"),
    ];
    stubBoardFetch({ channelId: channel, messages });
    const outcome = await runChannelWrite({ channelId: channel });

    // ⛔ R1 判别性：termination 必须在 runChannelWrite 的输出里（spec §1.1）。
    //    只验 --selfcheck/--inspect 不算（那两条本来就有 termination）。
    expect(outcome).toHaveProperty("termination");
    expect(outcome.termination).toBeDefined();
    expect(typeof outcome.termination.coverage).toBe("number");
    expect(typeof outcome.termination.zeroGrowthRounds).toBe("number");
    expect(outcome.termination).toHaveProperty("state");
    expect(outcome.termination).toHaveProperty("capHit");
  });

  it("termination is a real decideTermination result, not a stub (coverage tracks evidence)", async () => {
    const channel = "research:r1-coverage";
    const messages = [
      clueMsg(1, "c1", "explored"),
      clueMsg(2, "c2", "explored"),
      evidenceMsg(3, "c1"),
      evidenceMsg(4, "c2"),
    ];
    stubBoardFetch({ channelId: channel, messages });
    const outcome = await runChannelWrite({ channelId: channel });
    // coverage = 有 evidence 的 clue_id 集合大小 = 2。
    expect(outcome.termination.coverage).toBe(2);
  });
});

// ── R2：⭐ 「正常收敛」可达——多轮零增长 ⇒ zeroGrowthRounds ≥ 2 且 converged ──

describe("R2: converged is reachable via multi-round zero-growth carried across ticks", () => {
  it("zeroGrowthRounds climbs to >= threshold and state becomes converged (prev counters carried)", async () => {
    const channel = "research:r2-converge";
    // 全 explored（drained）板面，无 capped（count < maxClues, depth < maxDepth）。
    // coverage 固定（只有 c1 有 evidence）⇒ 零增长。
    const messages = [
      clueMsg(1, "c1", "explored"),
      evidenceMsg(2, "c1"),
    ];

    // ⛔ 驱动多轮：每轮把上一轮的 zeroGrowthRounds 作为下一轮的 prev 传入（模拟 trigger body 传递）。
    // 这正是改动前做不到的（prevZeroGrowthRounds 恒传 0）。阈值 zeroGrowthThreshold=2。
    let prevCoverage = 0;
    let prevZeroGrowthRounds = 0;
    const rounds: Array<{ zgr: number; state: string | null }> = [];
    for (let i = 0; i < 3; i += 1) {
      stubBoardFetch({ channelId: channel, messages });
      const outcome = await runChannelWrite({
        channelId: channel,
        prevCoverage,
        prevZeroGrowthRounds,
      });
      vi.unstubAllGlobals();
      rounds.push({
        zgr: outcome.termination.zeroGrowthRounds,
        state: outcome.termination.state,
      });
      prevCoverage = outcome.termination.coverage;
      prevZeroGrowthRounds = outcome.termination.zeroGrowthRounds;
    }

    // 第 1 轮：coverage 1 > prevCoverage 0 ⇒ 增长 ⇒ zeroGrowthRounds=0。
    //   （注意：首轮 coverage 从 0→1 是增长，故第 1 轮 zgr=0。）
    expect(rounds[0].zgr).toBe(0);
    // 第 2 轮起：coverage 不变（恒 1）⇒ 零增长 ⇒ zgr 递增。
    expect(rounds[1].zgr).toBe(1);
    // ⭐ R2 关键：第 3 轮 zgr=2 ≥ 阈值 2 ⇒ state === "converged"。
    //   改动前这条必然挂（prevZeroGrowthRounds 恒 0 ⇒ zgr 恒 ≤ 1 ⇒ 永不收敛）。
    expect(rounds[2].zgr).toBeGreaterThanOrEqual(cfg.zeroGrowthThreshold);
    expect(rounds[2].state).toBe("converged");
  });
});

// ── R3：判别性——覆盖度有增长 ⇒ zeroGrowthRounds 重置、不收敛 ──────────

describe("R3: coverage growth resets zeroGrowthRounds (discriminant against R2)", () => {
  it("when coverage grows each round, zeroGrowthRounds stays 0 and never converges", async () => {
    const channel = "research:r3-growth";
    // 每轮往板面加一条新 evidence ⇒ coverage 递增 ⇒ 零增长计数被重置。
    // 模拟 trigger body 传递：即便传入非零 prevZeroGrowthRounds，增长也会重置为 0。
    const baseMessages = [clueMsg(1, "c1", "explored")];

    // 轮 1：prev zgr=5（模拟之前积累了 5 轮零增长），但本轮 coverage 从 0→1（增长）⇒ 重置为 0。
    stubBoardFetch({
      channelId: channel,
      messages: [...baseMessages, evidenceMsg(2, "c1")],
    });
    const outcome = await runChannelWrite({
      channelId: channel,
      prevCoverage: 0,
      prevZeroGrowthRounds: 5,
    });
    vi.unstubAllGlobals();
    // ⛔ R3 关键：coverage 增长 ⇒ zeroGrowthRounds 被重置为 0，不得照单 +1。
    //   变异 S3（增长时不重置）会让这条挂（zgr 会变成 6）。
    expect(outcome.termination.zeroGrowthRounds).toBe(0);
    expect(outcome.termination.state).not.toBe("converged");
  });
});

// ── R4：跨 tick 传递真的经过 trigger body（两端各一条）──────────────────

describe("R4: cross-tick carry really goes through trigger body (both ends)", () => {
  // 渲染 tick.md 并用假 tick-entry 记录 argv + 输出含 termination 的 JSON。
  // triggerBody 是从 fleet claim.bind 渲染来的 body（JSON 字符串）；fakeOutput 是 tick-entry 回显的 JSON。
  function runRenderedTick(
    triggerBody: string,
    fakeOutput: string,
  ): { argv: string[]; puts: string[] } {
    const dir = mkdtempSync(join(tmpdir(), "g4b-r4-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const putsLog = join(dir, "puts.log");
    const tickEntry = join(dir, "tick-entry");
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nprintf '%s\\n' '${fakeOutput}'\n`,
    );
    chmodSync(tickEntry, 0o755);
    const runner = join(dir, "runner");
    writeFileSync(
      runner,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${putsLog}"\n`,
    );
    chmodSync(runner, 0o755);
    const storeDir = join(dir, "store");
    writeFileSync(putsLog, "");
    const values: Record<string, string> = {
      tick_entry: tickEntry,
      tick_channel: "research:r4-test",
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      trigger_body: triggerBody,
      trigger_store_dir: storeDir,
      loop_store_cli: join(dir, "store-cli.js"),
      loop_engine_runner: runner,
    };
    const script = readFileSync(TICK_MD, "utf8").replace(
      /\{\{([a-z_]+)\}\}/g,
      (_m, key) => values[key] ?? "",
    );
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    try {
      execFileSync("bash", [outShell], { cwd: ROOT, encoding: "utf8" });
    } catch {
      // 忽略：某些 fakeOutput 可能让 grep 失败；读取日志后再决定。
    }
    const argv = readFileSync(argvLog, "utf8").trim().split("\n").filter((l) => l.length > 0);
    const puts = readFileSync(putsLog, "utf8").trim().split("\n").filter(Boolean);
    rmSync(dir, { recursive: true, force: true });
    return { argv, puts };
  }

  it("write-end: continuation trigger body contains this round's coverage/zeroGrowthRounds", () => {
    // hasPendingWork=true + termination.coverage=3, zeroGrowthRounds=7 ⇒ 续投 body 必须带这两个值。
    const fakeOutput =
      '{"hasPendingWork": true, "decisions": [], "termination": {"state": null, "coverage": 3, "zeroGrowthRounds": 7, "capHit": false}}';
    const { puts } = runRenderedTick('{"coverage":0,"zeroGrowthRounds":0}', fakeOutput);
    // ⛔ R4 写端：续投恰好一条，其 body 含本轮 coverage=3 / zeroGrowthRounds=7。
    //    只断言「函数收了参数」不算数——必须断言 body 里真带计数。
    expect(puts).toHaveLength(1);
    const put = JSON.parse(puts[0]);
    expect(put.body.coverage).toBe(3);
    expect(put.body.zeroGrowthRounds).toBe(7);
  });

  it("read-end: tick.md reads prev coverage/zeroGrowthRounds from rendered trigger body into --prev-* argv", () => {
    // trigger body 带 coverage=5, zeroGrowthRounds=9 ⇒ tick.md 解析后传入 --prev-coverage 5 / --prev-zero-growth-rounds 9。
    const fakeOutput =
      '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}';
    const { argv } = runRenderedTick('{"coverage":5,"zeroGrowthRounds":9}', fakeOutput);
    // ⛔ R4 读端：--prev-coverage / --prev-zero-growth-rounds 真的到达 tick-entry argv，
    //    值取自 trigger body。只断言「fleet input 有字段」不算数。
    expect(argv).toContain("--prev-coverage");
    expect(argv[argv.indexOf("--prev-coverage") + 1]).toBe("5");
    expect(argv).toContain("--prev-zero-growth-rounds");
    expect(argv[argv.indexOf("--prev-zero-growth-rounds") + 1]).toBe("9");
  });
});

// ── R5：⛔ body 缺失/损坏 ⇒ 响亮失败，不得静默回落 0/0（正反两例）───────

describe("R5: invalid/missing trigger body ⇒ loud failure (no silent 0/0 fallback)", () => {
  it("valid body with numeric coverage/zeroGrowthRounds parses correctly (positive case)", () => {
    const r = parsePrevCounters('{"coverage":2,"zeroGrowthRounds":1}');
    expect(r.coverage).toBe(2);
    expect(r.zeroGrowthRounds).toBe(1);
  });

  it("empty body ⇒ InvalidTriggerBodyError (loud, not 0/0)", () => {
    expect(() => parsePrevCounters("")).toThrow(InvalidTriggerBodyError);
  });

  it("non-JSON body ⇒ InvalidTriggerBodyError (loud, not 0/0)", () => {
    expect(() => parsePrevCounters("not json {")).toThrow(InvalidTriggerBodyError);
  });

  it("JSON but missing coverage field ⇒ InvalidTriggerBodyError (loud, not 0/0)", () => {
    expect(() => parsePrevCounters('{"zeroGrowthRounds":1}')).toThrow(InvalidTriggerBodyError);
  });

  it("JSON but missing zeroGrowthRounds field ⇒ InvalidTriggerBodyError (loud, not 0/0)", () => {
    expect(() => parsePrevCounters('{"coverage":1}')).toThrow(InvalidTriggerBodyError);
  });

  it("JSON but coverage is a string ⇒ InvalidTriggerBodyError (loud, not 0/0)", () => {
    expect(() => parsePrevCounters('{"coverage":"1","zeroGrowthRounds":0}')).toThrow(
      InvalidTriggerBodyError,
    );
  });

  it("JSON array (not object) ⇒ InvalidTriggerBodyError (loud, not 0/0)", () => {
    expect(() => parsePrevCounters("[1,2,3]")).toThrow(InvalidTriggerBodyError);
  });

  // 生产层（tick.md）：渲染后的 tick.md 对损坏 body 非零退出。
  it("rendered tick.md with corrupt trigger body ⇒ non-zero exit (loud failure)", () => {
    const dir = mkdtempSync(join(tmpdir(), "g4b-r5-"));
    const tickEntry = join(dir, "tick-entry");
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nprintf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}'\n`,
    );
    chmodSync(tickEntry, 0o755);
    const values: Record<string, string> = {
      tick_entry: tickEntry,
      tick_channel: "research:r5-corrupt",
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      // ⛔ 损坏 body：不是 JSON。
      trigger_body: "not-valid-json{",
      trigger_store_dir: join(dir, "store"),
      loop_store_cli: join(dir, "store-cli.js"),
      loop_engine_runner: join(dir, "runner"),
    };
    const script = readFileSync(TICK_MD, "utf8").replace(
      /\{\{([a-z_]+)\}\}/g,
      (_m, key) => values[key] ?? "",
    );
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    let code = 0;
    try {
      execFileSync("bash", [outShell], { cwd: ROOT, encoding: "utf8" });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    // ⛔ R5 生产层：损坏 body ⇒ 非零退出（响亮失败），绝不静默回落 0/0 继续跑。
    expect(code).not.toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rendered tick.md with missing coverage field ⇒ non-zero exit (loud failure)", () => {
    const dir = mkdtempSync(join(tmpdir(), "g4b-r5-missing-"));
    const tickEntry = join(dir, "tick-entry");
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nprintf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}'\n`,
    );
    chmodSync(tickEntry, 0o755);
    const values: Record<string, string> = {
      tick_entry: tickEntry,
      tick_channel: "research:r5-missing",
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      // ⛔ 缺 coverage 字段。
      trigger_body: '{"zeroGrowthRounds":1}',
      trigger_store_dir: join(dir, "store"),
      loop_store_cli: join(dir, "store-cli.js"),
      loop_engine_runner: join(dir, "runner"),
    };
    const script = readFileSync(TICK_MD, "utf8").replace(
      /\{\{([a-z_]+)\}\}/g,
      (_m, key) => values[key] ?? "",
    );
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    let code = 0;
    try {
      execFileSync("bash", [outShell], { cwd: ROOT, encoding: "utf8" });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).not.toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── R6：capped 与 converged 仍然可区分 ──────────────────────────────

describe("R6: capped and converged remain distinguishable", () => {
  it("cap-hit path (count >= maxClues) produces state=capped", async () => {
    const channel = "research:r6-capped";
    // 构造 count >= maxClues(64) 的全 explored 板面 ⇒ capHit=true，drained ⇒ capped。
    const messages: unknown[] = [];
    for (let i = 0; i < cfg.maxClues; i += 1) {
      messages.push(clueMsg(i + 1, `c${i}`, "explored"));
    }
    stubBoardFetch({ channelId: channel, messages });
    const outcome = await runChannelWrite({
      channelId: channel,
      prevCoverage: 0,
      prevZeroGrowthRounds: 100, // 即便零增长积累很久，触顶优先
    });
    // ⛔ R6：触顶路径 ⇒ capped（≠ converged）。
    expect(outcome.termination.capHit).toBe(true);
    expect(outcome.termination.state).toBe("capped");
  });

  it("zero-growth path (no cap) produces state=converged", async () => {
    const channel = "research:r6-converged";
    // 少量 explored（不触顶）+ 零增长达标 ⇒ converged。
    const messages = [clueMsg(1, "c1", "explored"), evidenceMsg(2, "c1")];
    stubBoardFetch({ channelId: channel, messages });
    const outcome = await runChannelWrite({
      channelId: channel,
      prevCoverage: 1, // coverage 不变（仍是 1）⇒ 零增长
      prevZeroGrowthRounds: cfg.zeroGrowthThreshold - 1, // 本轮 +1 ⇒ 达标
    });
    expect(outcome.termination.capHit).toBe(false);
    expect(outcome.termination.state).toBe("converged");
  });
});

// ── CLI 解析：--prev-coverage / --prev-zero-growth-rounds ──────────────

describe("parseRunCliArgs: --prev-coverage / --prev-zero-growth-rounds", () => {
  it("parses both prev counters when provided", () => {
    const opts = parseRunCliArgs([
      "research:cli-test",
      "--prev-coverage",
      "3",
      "--prev-zero-growth-rounds",
      "5",
    ]);
    expect(opts.prevCoverage).toBe(3);
    expect(opts.prevZeroGrowthRounds).toBe(5);
  });

  it("prev counters default to undefined when not provided (first-round semantics)", () => {
    const opts = parseRunCliArgs(["research:cli-test"]);
    expect(opts.prevCoverage).toBeUndefined();
    expect(opts.prevZeroGrowthRounds).toBeUndefined();
  });

  it("negative --prev-coverage ⇒ loud failure", () => {
    expect(() =>
      parseRunCliArgs(["research:cli-test", "--prev-coverage", "-1"]),
    ).toThrow(/--prev-coverage/);
  });

  it("non-numeric --prev-zero-growth-rounds ⇒ loud failure", () => {
    expect(() =>
      parseRunCliArgs([
        "research:cli-test",
        "--prev-zero-growth-rounds",
        "abc",
      ]),
    ).toThrow(/--prev-zero-growth-rounds/);
  });
});

// ── 变异矩阵（spec §3）：逐断言归因，证明每条断言有杀变异的能力 ────────
// 这些用例直接对纯函数 decideTermination 求值，用「模拟变异后的输入」证明断言的判别力。

describe("mutation matrix S1: removing cross-tick carry (prevZeroGrowthRounds always 0) kills R2", () => {
  it("S1 simulation: if prevZeroGrowthRounds is always 0, zgr never reaches threshold", () => {
    // 模拟 S1：无论上一轮 zgr 多少，下一轮传入的 prevZeroGrowthRounds 恒为 0（改动前行为）。
    // 连续 3 轮零增长（coverage 不变）。
    let prevCoverage = 1;
    const s1PrevZeroGrowthRounds = 0; // ⛔ S1 变异：恒传 0
    const zgrs: number[] = [];
    for (let i = 0; i < 3; i += 1) {
      const cards: BoardCard[] = [
        { clueId: "c1", text: "t", status: "explored", depth: 0, sources: [], retries: 0 },
      ];
      const t = decideTermination(
        {
          cards,
          coveredClueIds: ["c1"], // coverage 恒 1 ⇒ 零增长
          prevCoverage,
          prevZeroGrowthRounds: s1PrevZeroGrowthRounds,
        },
        cfg,
      );
      zgrs.push(t.zeroGrowthRounds);
      prevCoverage = t.coverage;
    }
    // ⛔ S1 下 zgr 恒为 1（0+1），永远到不了阈值 2 ⇒ R2 必挂。
    //    证明 R2 的「zgr 能长到 ≥ 2」断言对 S1 有杀变异能力。
    expect(zgrs).toEqual([1, 1, 1]);
    expect(Math.max(...zgrs)).toBeLessThan(cfg.zeroGrowthThreshold);
  });
});

describe("mutation matrix S2: silent 0/0 fallback on missing body kills R5 failure side", () => {
  it("S2 simulation: silent fallback returns 0/0 instead of throwing", () => {
    // 模拟 S2：parsePrevCounters 在 body 缺失时返回 0/0 而非抛错。
    // ⛔ S2 变异后的行为：不抛错 ⇒ R5 的失败侧（期望 throw）必挂。
    const s2Parse = (body: string): { coverage: number; zeroGrowthRounds: number } => {
      // S2: 静默回落
      if (body.length === 0) return { coverage: 0, zeroGrowthRounds: 0 };
      try {
        const p = JSON.parse(body);
        return {
          coverage: typeof p.coverage === "number" ? p.coverage : 0,
          zeroGrowthRounds: typeof p.zeroGrowthRounds === "number" ? p.zeroGrowthRounds : 0,
        };
      } catch {
        return { coverage: 0, zeroGrowthRounds: 0 };
      }
    };
    // S2 下损坏 body 不抛错 ⇒ R5 的 toThrow 断言会挂。
    expect(() => s2Parse("not-json")).not.toThrow();
    expect(s2Parse("")).toEqual({ coverage: 0, zeroGrowthRounds: 0 });
    // 对照：真实的 parsePrevCounters 必须抛错（R5 绿）。
    expect(() => parsePrevCounters("not-json")).toThrow(InvalidTriggerBodyError);
  });
});

describe("mutation matrix S3: not resetting zgr on coverage growth kills R3", () => {
  it("S3 simulation: if zgr increments even on growth, R3's reset assertion fails", () => {
    // 模拟 S3：coverage 增长时 zeroGrowthRounds 不重置，照单 prevZeroGrowthRounds+1。
    const s3Decide = (prevZgr: number, prevCov: number, curCov: number): number => {
      // ⛔ S3 变异：去掉 `coverage > prevCoverage ? 0 :` 分支，恒 +1。
      return prevZgr + 1;
    };
    // prevZgr=5, coverage 从 0→1（增长）。
    const s3Result = s3Decide(5, 0, 1);
    // ⛔ S3 下 zgr=6（不重置）⇒ R3 的「zgr===0」断言必挂。
    expect(s3Result).toBe(6);
    // 对照：真实的 decideTermination 增长时重置为 0（R3 绿）。
    const real = decideTermination(
      {
        cards: [{ clueId: "c1", text: "t", status: "explored", depth: 0, sources: [], retries: 0 }],
        coveredClueIds: ["c1"],
        prevCoverage: 0,
        prevZeroGrowthRounds: 5,
      },
      cfg,
    );
    expect(real.zeroGrowthRounds).toBe(0);
  });
});
