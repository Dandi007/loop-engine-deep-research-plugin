/**
 * G4b(v3) —— 终态贯通：生产 --run 计算并返回终止判定；prevCoverage / prevZeroGrowthRounds 跨 tick 传递。
 *
 * 根因（spec §0）：
 *  - §0.1 生产 --run 路径从不调用 decideTermination（grep termination src/tick-run.ts 零命中）。
 *  - §0.2 prevCoverage / prevZeroGrowthRounds 没有任何跨 tick 持久化，恒为 0/0 ⇒
 *    zeroGrowthRounds 恒为 0 或 1，阈值 2 永不达到 ⇒ 唯一可达终态是 capped（触顶）。
 *
 * 硬验收（spec §2 R1–R6）：
 *  - R1 ⛔ 可达性：从生产入口 tick-entry --run 出发的用例，其 JSON 输出含 termination。
 *        只验 --selfcheck / --inspect 不算数（那两条本来就有）。
 *  - R2 ⭐ 正常收敛可达：构造连续多轮零增长，断言 zeroGrowthRounds 能长到 ≥ 2 且 state === "converged"。
 *        ⛔ 这条在改动前必然挂——它是本包的存在理由。
 *  - R3 ⛔ 判别性：同样多轮但覆盖度有增长 ⇒ zeroGrowthRounds 被重置、不得收敛。
 *  - R4 ⛔ 跨 tick 传递真的经过 trigger body：断言续投写出的 trigger body 里含本轮的
 *        coverage / zeroGrowthRounds，且下一轮从 {{trigger_body}} 读回。两端各一条。
 *  - R5 ⛔ body 缺失/损坏 ⇒ 响亮失败，不得静默回落 0/0。
 *  - R6 capped 与 converged 仍然可区分：触顶路径产出 capped，零增长路径产出 converged。
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
  parseTerminationFromBody,
  TriggerBodyTerminationError,
} from "../src/tick-run";
import type { InspectMessage } from "../src/tick-inspect";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TICK_MD = join(
  ROOT,
  "workflows",
  "deep-research",
  "tick",
  "templates",
  "tick.md",
);

afterEach(() => {
  vi.unstubAllGlobals();
});

function jsonResponse(data: unknown) {
  return {
    ok: true,
    status: 200,
    json: async () => data,
    text: async () => JSON.stringify(data),
  };
}

const CHANNEL = "research:p02-smoke-1dce60";

/**
 * 构造一条 research.clue.v2 消息（板面上一张卡）。
 */
function clueMsg(
  clueId: string,
  over: Record<string, unknown> = {},
  seq = 1,
): InspectMessage {
  return {
    message_id: `msg_${clueId}`,
    channel_id: CHANNEL,
    channel_seq: seq,
    kind: "research.clue.v2",
    payload: {
      status: "explored",
      text: `clue ${clueId}`,
      depth: 0,
      sources: ["code-local"],
      ...over,
    },
    entity_id: clueId,
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

/**
 * 写一个「假 tick-entry」脚本到 dir/tick-entry：
 *  - `--parse-trigger-body <body>` 分支委托给**真实** tick-entry（vite-node 跑 src/tick-entry.ts），
 *    这样 bash 层用例跑的是权威 parseTerminationFromBody（attempt 2 评审 minor：单源真相，不再
 *    让 tick.md 内嵌的第二份解析器与 TS 端静默发散）。
 *  - 其余分支（`--run …`）按 fakeRunBody 的 JSON 输出 + 把 argv 记进 argvLog，用于断言 --prev-*。
 *
 * G4b（attempt 2）：tick.md 现在通过 `$tick_entry --parse-trigger-body` 解析 trigger body，
 * 故 fake tick-entry 必须尊重同一契约；否则 tick.md 拿不到 --prev-* 参数。
 */
function writeFakeTickEntry(opts: {
  tickEntryPath: string;
  argvLog: string;
  fakeRunBody: string;
}): void {
  const realEntry = join(ROOT, "src", "tick-entry.ts");
  const viteNode = join(ROOT, "node_modules", ".bin", "vite-node");
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--parse-trigger-body" ]; then
  exec "${viteNode}" "${realEntry}" --parse-trigger-body "$2"
fi
printf '%s\\n' "$@" > "${opts.argvLog}"
printf '%s\\n' '${opts.fakeRunBody}'
`;
  writeFileSync(opts.tickEntryPath, script);
  chmodSync(opts.tickEntryPath, 0o755);
}

/**
 * 构造一条 research.evidence.v2 消息（覆盖某 clue_id）。
 */
function evidenceMsg(clueId: string, seq: number): InspectMessage {
  return {
    message_id: `ev_${clueId}_${seq}`,
    channel_id: CHANNEL,
    channel_seq: seq,
    kind: "research.evidence.v2",
    payload: { clue_id: clueId, quote: "q", claim: "c", source: "code", locator: "l", revision: "r" },
    entity_id: clueId,
    supersedes: null,
    created_at: "2026-01-01T00:00:00Z",
  };
}

/**
 * 桩 fetch：clue channel 返回给定的 clue + evidence 消息；board:agent-runs 空；
 * publish/entity 返回最小合法响应。所有 clue 都 explored（无 pending work），
 * 让 decideTick 不产生写决策，从而把视线集中在 termination 上。
 */
function stubBoard(clueMessages: InspectMessage[]): void {
  let clueCalls = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: unknown, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/entities/")) {
        return jsonResponse({ head: clueMessages[0] ?? {} });
      }
      if (u.includes("/publish")) {
        return jsonResponse({ message_id: "p", channel_seq: 99 });
      }
      if (u.includes(`/v1/channels/${CHANNEL}/messages`)) {
        clueCalls += 1;
        return jsonResponse({ messages: clueCalls === 1 ? clueMessages : [] });
      }
      if (u.includes("/v1/channels/board:agent-runs/messages")) {
        return jsonResponse({ messages: [] });
      }
      return jsonResponse({ messages: [] });
    }),
  );
}

// ── R1：可达性 —— 生产入口 tick-entry --run 的 JSON 输出含 termination ──

describe("R1: production --run path emits termination in JSON output", () => {
  it("runChannelWrite outcome has a termination field (not just selfcheck/inspect)", async () => {
    // 全 explored 板面（无 pending work）⇒ decideTick 无写决策，但 termination 仍被计算并返回。
    const msgs = [clueMsg("c1", { status: "explored" })];
    stubBoard(msgs);

    const outcome = await runChannelWrite({ channelId: CHANNEL });

    // ⛔ R1 核心：termination 字段存在且是对象（从生产 --run 路径可达）。
    expect(outcome).toHaveProperty("termination");
    expect(outcome.termination).toBeInstanceOf(Object);
    expect(outcome.termination).toHaveProperty("state");
    expect(outcome.termination).toHaveProperty("coverage");
    expect(outcome.termination).toHaveProperty("zeroGrowthRounds");
    expect(outcome.termination).toHaveProperty("capHit");
  });

  it("parseRunCliArgs parses --prev-coverage / --prev-zero-growth into RunCliOptions", () => {
    // 生产入口的可达性另一面：CLI 能接收这两个跨 tick 计数参数。
    const opts = parseRunCliArgs([
      CHANNEL,
      "--prev-coverage",
      "3",
      "--prev-zero-growth",
      "2",
    ]);
    expect(opts.prevCoverage).toBe(3);
    expect(opts.prevZeroGrowthRounds).toBe(2);
  });

  it("parseRunCliArgs without --prev-* leaves them undefined (first-round semantics)", () => {
    const opts = parseRunCliArgs([CHANNEL]);
    expect(opts.prevCoverage).toBeUndefined();
    expect(opts.prevZeroGrowthRounds).toBeUndefined();
  });
});

// ── R2 ⭐：正常收敛可达 —— 多轮零增长后 zeroGrowthRounds ≥ 2 且 state === converged ──

describe("R2: converged reachable — multi-round zero growth drives zeroGrowthRounds to threshold", () => {
  it("zero growth across rounds ⇒ zeroGrowthRounds accumulates to ≥ 2 and state === converged", async () => {
    // 板面：1 张 explored 卡 + 1 条 evidence 覆盖它 ⇒ coverage=1。无 pending work（全终态）。
    // 首轮：prevCoverage=0, prevZeroGrowthRounds=0 ⇒ coverage(1) > 0 ⇒ zeroGrowthRounds=0, 不收敛（首轮）。
    // 第二轮：prevCoverage=1, prevZeroGrowthRounds=0 ⇒ coverage(1) 不 > 1 ⇒ zeroGrowthRounds=1, 仍 < 2。
    // 第三轮：prevCoverage=1, prevZeroGrowthRounds=1 ⇒ coverage(1) 不 > 1 ⇒ zeroGrowthRounds=2 ≥ 2 ⇒ converged。
    const msgs = [
      clueMsg("c1", { status: "explored" }, 1),
      evidenceMsg("c1", 2),
    ];

    // 首轮（无前值 ⇒ 0/0）
    stubBoard(msgs);
    const r1 = await runChannelWrite({ channelId: CHANNEL });
    expect(r1.termination.coverage).toBe(1);
    expect(r1.termination.zeroGrowthRounds).toBe(0); // 1 > 0 ⇒ 重置为 0
    expect(r1.termination.state).toBeNull(); // 0 < 2，不收敛
    vi.unstubAllGlobals();

    // 第二轮（prevCoverage=1, prevZeroGrowthRounds=0）
    stubBoard(msgs);
    const r2 = await runChannelWrite({
      channelId: CHANNEL,
      prevCoverage: r1.termination.coverage,
      prevZeroGrowthRounds: r1.termination.zeroGrowthRounds,
    });
    expect(r2.termination.coverage).toBe(1);
    expect(r2.termination.zeroGrowthRounds).toBe(1); // 1 不 > 1 ⇒ +1
    expect(r2.termination.state).toBeNull(); // 1 < 2，不收敛
    vi.unstubAllGlobals();

    // 第三轮（prevCoverage=1, prevZeroGrowthRounds=1）⇒ ⭐ 收敛！
    stubBoard(msgs);
    const r3 = await runChannelWrite({
      channelId: CHANNEL,
      prevCoverage: r2.termination.coverage,
      prevZeroGrowthRounds: r2.termination.zeroGrowthRounds,
    });
    expect(r3.termination.coverage).toBe(1);
    expect(r3.termination.zeroGrowthRounds).toBe(2); // ≥ 阈值 2
    // ⛔ R2 关键断言：state === "converged"（改动前这条必然挂——zeroGrowthRounds 恒 ≤ 1）
    expect(r3.termination.state).toBe("converged");
  });

  it("single round with prevZeroGrowthRounds forced to 0 never converges (defect re-introduction check)", async () => {
    // ⛔ 这条是变异 S1 的「绿色对照」：如果 prevZeroGrowthRounds 恒传 0（= 改动前），
    //    即使连续多轮零增长也永不收敛。用真实的跨 tick 传递驱动时第三轮必收敛（见上）；
    //    若把 prevZeroGrowthRounds 恒传 0，第三轮仍 state===null。这证明 R2 有判别力。
    const msgs = [
      clueMsg("c1", { status: "explored" }, 1),
      evidenceMsg("c1", 2),
    ];
    stubBoard(msgs);
    // 模拟「改动前」：每轮 prevZeroGrowthRounds 恒传 0
    const r3defect = await runChannelWrite({
      channelId: CHANNEL,
      prevCoverage: 1,
      prevZeroGrowthRounds: 0, // ⛔ 恒为 0
    });
    expect(r3defect.termination.zeroGrowthRounds).toBe(1); // 永远只到 1
    expect(r3defect.termination.state).toBeNull(); // 永不收敛
  });
});

// ── R3 ⛔：判别性 —— 覆盖度有增长时 zeroGrowthRounds 重置、不收敛 ──

describe("R3: discriminative — coverage growth resets zeroGrowthRounds, no convergence", () => {
  it("growing coverage across rounds ⇒ zeroGrowthRounds stays 0, never converges", async () => {
    // 板面 A：1 张 explored + 1 evidence（coverage=1）
    // 板面 B：2 张 explored + 2 evidence（coverage=2，增长）
    // 第二轮（prevCoverage=1）：coverage=2 > 1 ⇒ zeroGrowthRounds 重置为 0，不收敛。
    const msgsA = [
      clueMsg("c1", { status: "explored" }, 1),
      evidenceMsg("c1", 2),
    ];
    const msgsB = [
      clueMsg("c1", { status: "explored" }, 1),
      evidenceMsg("c1", 2),
      clueMsg("c2", { status: "explored" }, 3),
      evidenceMsg("c2", 4),
    ];

    // 首轮：coverage=1
    stubBoard(msgsA);
    const r1 = await runChannelWrite({ channelId: CHANNEL });
    expect(r1.termination.coverage).toBe(1);
    expect(r1.termination.zeroGrowthRounds).toBe(0);

    // 第二轮：coverage=2（增长）⇒ 即使上一轮 zeroGrowthRounds=1 也被重置
    stubBoard(msgsB);
    const r2 = await runChannelWrite({
      channelId: CHANNEL,
      prevCoverage: 1,
      prevZeroGrowthRounds: 1, // 假设上一轮已经累积到 1
    });
    expect(r2.termination.coverage).toBe(2);
    // ⛔ R3 关键断言：coverage 增长 ⇒ zeroGrowthRounds 重置为 0（而非照单 +1 到 2）
    expect(r2.termination.zeroGrowthRounds).toBe(0);
    expect(r2.termination.state).toBeNull(); // 不得收敛
  });
});

// ── R4 ⛔：跨 tick 传递真的经过 trigger body（两端各一条） ──

describe("R4: cross-tick counters really traverse trigger body (both ends)", () => {
  it("parseTerminationFromBody reads coverage/zeroGrowthRounds from trigger body string", () => {
    // 端 1（读回）：续投写出的 trigger body 字符串能被 parseTerminationFromBody 解析。
    const parsed = parseTerminationFromBody(
      JSON.stringify({ tick: true, coverage: 3, zeroGrowthRounds: 2 }),
    );
    expect(parsed).toEqual({
      prevCoverage: 3,
      prevZeroGrowthRounds: 2,
      firstRound: false,
    });
  });

  it("runChannelWrite outcome.termination carries the values to write into next trigger body", async () => {
    // 端 2（写出）：本轮的 termination.coverage / zeroGrowthRounds 可从 outcome 取出，
    // 序列化成下一条 trigger body。这里直接断言 runChannelWrite 产出的值可被
    // parseTerminationFromBody 回读（端到端闭环）。
    const msgs = [
      clueMsg("c1", { status: "explored" }, 1),
      evidenceMsg("c1", 2),
    ];
    stubBoard(msgs);
    const r = await runChannelWrite({
      channelId: CHANNEL,
      prevCoverage: 1,
      prevZeroGrowthRounds: 1,
    });
    // 把 outcome 的 termination 值写进下一条 trigger body 的形态
    const nextBody = JSON.stringify({
      tick: true,
      coverage: r.termination.coverage,
      zeroGrowthRounds: r.termination.zeroGrowthRounds,
    });
    // 回读必须一致（闭环）
    expect(parseTerminationFromBody(nextBody)).toEqual({
      prevCoverage: r.termination.coverage,
      prevZeroGrowthRounds: r.termination.zeroGrowthRounds,
      firstRound: false,
    });
  });

  it("tick.md reads {{trigger_body}} and writes {coverage,zeroGrowthRounds} into next trigger body", () => {
    // 端到端 bash 层：渲染 tick.md，喂一个带计数的 trigger_body，
    // 断言假 tick-entry 收到 --prev-coverage/--prev-zero-growth，且续投 trigger body 含本轮计数。
    const dir = mkdtempSync(join(tmpdir(), "g4b-r4-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const runnerLog = join(dir, "puts.log");
    const tickEntry = join(dir, "tick-entry");
    // 假 tick-entry：--parse-trigger-body 委托真实解析器；--run 记录 argv 并输出含 termination 的
    // JSON（hasPendingWork=true 触发续投，使 tick.md 把本轮计数写进下一条 trigger body）。
    writeFakeTickEntry({
      tickEntryPath: tickEntry,
      argvLog,
      fakeRunBody:
        '{"hasPendingWork": true, "decisions": [], "termination": {"state": null, "coverage": 7, "zeroGrowthRounds": 3, "capHit": false}}',
    });
    const runner = join(dir, "runner");
    writeFileSync(
      runner,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${runnerLog}"\n`,
    );
    chmodSync(runner, 0o755);
    const storeDir = join(dir, "store");
    writeFileSync(runnerLog, "");
    // 渲染 tick.md，trigger_body 带上一轮计数 {coverage:4, zeroGrowthRounds:1}
    const tpl = readFileSync(TICK_MD, "utf8");
    const script = tpl
      .replace(/\{\{tick_entry\}\}/g, tickEntry)
      .replace(/\{\{tick_channel\}\}/g, CHANNEL)
      .replace(/\{\{evidence_channel\}\}/g, "")
      .replace(/\{\{allowed_root\}\}/g, "")
      .replace(/\{\{max_writes\}\}/g, "64")
      .replace(/\{\{research_question\}\}/g, "")
      .replace(/\{\{trigger_store_dir\}\}/g, storeDir)
      .replace(/\{\{loop_store_cli\}\}/g, join(dir, "store-cli.js"))
      .replace(/\{\{loop_engine_runner\}\}/g, runner)
      .replace(/\{\{trigger_body\}\}/g, '{"tick":true,"coverage":4,"zeroGrowthRounds":1}');
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    execFileSync("bash", [outShell], { cwd: dir, encoding: "utf8" });

    // ⛔ 端 1（读回）：假 tick-entry 收到了从 trigger_body 解析出的 --prev-coverage/--prev-zero-growth
    const argv = readFileSync(argvLog, "utf8").trim().split("\n");
    expect(argv).toContain("--prev-coverage");
    expect(argv[argv.indexOf("--prev-coverage") + 1]).toBe("4");
    expect(argv).toContain("--prev-zero-growth");
    expect(argv[argv.indexOf("--prev-zero-growth") + 1]).toBe("1");

    // ⛔ 端 2（写出）：续投 trigger body 含本轮 termination 的 coverage/zeroGrowthRounds
    const puts = readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean);
    expect(puts).toHaveLength(1);
    const body = JSON.parse(puts[0]);
    expect(body.body.coverage).toBe(7);
    expect(body.body.zeroGrowthRounds).toBe(3);

    rmSync(dir, { recursive: true, force: true });
  });

  it("tick.md seed body {\"seed\":true} passes no --prev-* (first-round semantics)", () => {
    // 首个 seed trigger body 无计数字段 ⇒ tick.md 不传 --prev-*（tick-entry 缺省 0）。
    const dir = mkdtempSync(join(tmpdir(), "g4b-r4-seed-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    writeFakeTickEntry({
      tickEntryPath: tickEntry,
      argvLog,
      fakeRunBody:
        '{"hasPendingWork": false, "decisions": [], "termination": {"state": "converged", "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}',
    });
    const tpl = readFileSync(TICK_MD, "utf8");
    const script = tpl
      .replace(/\{\{tick_entry\}\}/g, tickEntry)
      .replace(/\{\{tick_channel\}\}/g, CHANNEL)
      .replace(/\{\{evidence_channel\}\}/g, "")
      .replace(/\{\{allowed_root\}\}/g, "")
      .replace(/\{\{max_writes\}\}/g, "64")
      .replace(/\{\{research_question\}\}/g, "")
      .replace(/\{\{trigger_store_dir\}\}/g, "/tmp/x")
      .replace(/\{\{loop_store_cli\}\}/g, "/tmp/c")
      .replace(/\{\{loop_engine_runner\}\}/g, "/tmp/r")
      .replace(/\{\{trigger_body\}\}/g, '{"seed":true}');
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    execFileSync("bash", [outShell], { cwd: dir, encoding: "utf8" });
    const argv = readFileSync(argvLog, "utf8").trim().split("\n");
    // ⛔ 首轮不传 --prev-*（seed body 由 parseTerminationFromBody 判为 firstRound）
    expect(argv).not.toContain("--prev-coverage");
    expect(argv).not.toContain("--prev-zero-growth");
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── R5 ⛔：body 缺失/损坏 ⇒ 响亮失败，不得静默回落 0/0 ──

describe("R5: trigger body missing/malformed ⇒ loud failure (no silent 0/0 fallback)", () => {
  it("parseTerminationFromBody throws on undefined body", () => {
    expect(() => parseTerminationFromBody(undefined)).toThrow(TriggerBodyTerminationError);
  });

  it("parseTerminationFromBody throws on empty string", () => {
    expect(() => parseTerminationFromBody("")).toThrow(TriggerBodyTerminationError);
  });

  it("parseTerminationFromBody throws on invalid JSON", () => {
    expect(() => parseTerminationFromBody("not-json")).toThrow(TriggerBodyTerminationError);
  });

  it("parseTerminationFromBody throws on JSON missing coverage field", () => {
    expect(() =>
      parseTerminationFromBody(JSON.stringify({ zeroGrowthRounds: 1 })),
    ).toThrow(TriggerBodyTerminationError);
  });

  it("parseTerminationFromBody throws on JSON missing zeroGrowthRounds field", () => {
    expect(() =>
      parseTerminationFromBody(JSON.stringify({ coverage: 3 })),
    ).toThrow(TriggerBodyTerminationError);
  });

  it("parseTerminationFromBody throws on non-integer coverage", () => {
    expect(() =>
      parseTerminationFromBody(JSON.stringify({ coverage: 1.5, zeroGrowthRounds: 1 })),
    ).toThrow(TriggerBodyTerminationError);
  });

  it("parseTerminationFromBody throws on negative zeroGrowthRounds", () => {
    expect(() =>
      parseTerminationFromBody(JSON.stringify({ coverage: 1, zeroGrowthRounds: -1 })),
    ).toThrow(TriggerBodyTerminationError);
  });

  it("parseTerminationFromBody throws on string coverage", () => {
    expect(() =>
      parseTerminationFromBody(JSON.stringify({ coverage: "x", zeroGrowthRounds: 1 })),
    ).toThrow(TriggerBodyTerminationError);
  });

  it("tick.md with malformed trigger body exits non-zero naming trigger_body", () => {
    // bash 层：损坏的 trigger body ⇒ tick.md 非零退出，错误消息点名 trigger_body / G4b。
    const dir = mkdtempSync(join(tmpdir(), "g4b-r5-"));
    const tickEntry = join(dir, "tick-entry");
    // --parse-trigger-body 委托真实解析器：not-valid-json ⇒ 真实 parseTerminationFromBody 抛
    // TriggerBodyTerminationError（消息含 trigger_body/G4b）⇒ tick.md exit 1。
    writeFakeTickEntry({
      tickEntryPath: tickEntry,
      argvLog: join(dir, "tick-entry.argv.log"),
      fakeRunBody:
        '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}',
    });
    const tpl = readFileSync(TICK_MD, "utf8");
    const script = tpl
      .replace(/\{\{tick_entry\}\}/g, tickEntry)
      .replace(/\{\{tick_channel\}\}/g, CHANNEL)
      .replace(/\{\{evidence_channel\}\}/g, "")
      .replace(/\{\{allowed_root\}\}/g, "")
      .replace(/\{\{max_writes\}\}/g, "64")
      .replace(/\{\{research_question\}\}/g, "")
      .replace(/\{\{trigger_store_dir\}\}/g, "/tmp/x")
      .replace(/\{\{loop_store_cli\}\}/g, "/tmp/c")
      .replace(/\{\{loop_engine_runner\}\}/g, "/tmp/r")
      .replace(/\{\{trigger_body\}\}/g, "not-valid-json");
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    let errCode = 0;
    let errText = "";
    try {
      execFileSync("bash", [outShell], { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      const ee = e as { status?: number; stderr?: string | Buffer };
      errCode = ee.status ?? -1;
      errText = String(ee.stderr ?? "");
    }
    // ⛔ R5 bash 层：非零退出 + 点名 trigger_body（不得静默回落 0/0）
    expect(errCode).not.toBe(0);
    expect(errText).toMatch(/G4b.*trigger_body/i);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── R6：capped 与 converged 可区分 ──

describe("R6: capped and converged remain distinguishable", () => {
  it("capping (count >= maxClues) on a drained board ⇒ state === 'capped'", async () => {
    // 构造触顶板面：clue 数 >= maxClues（DEFAULT_TICK_CONFIG.maxClues=64）。
    // 全 explored（drained），无 pending。触顶且 drained ⇒ state='capped'。
    const msgs: InspectMessage[] = [];
    for (let i = 0; i < 64; i += 1) {
      msgs.push(clueMsg(`c${i}`, { status: "explored" }, i + 1));
    }
    stubBoard(msgs);

    const r = await runChannelWrite({
      channelId: CHANNEL,
      prevCoverage: 0,
      prevZeroGrowthRounds: 0,
    });
    expect(r.termination.capHit).toBe(true);
    // ⛔ R6：触顶 drained ⇒ capped（不是 converged）
    expect(r.termination.state).toBe("capped");
    expect(r.termination.state).not.toBe("converged");
  });

  it("zero-growth convergence on a small drained board ⇒ state === 'converged'", async () => {
    // 小板面（远未触顶）+ 多轮零增长达标 ⇒ converged（不是 capped）。
    const msgs = [
      clueMsg("c1", { status: "explored" }, 1),
      evidenceMsg("c1", 2),
    ];
    stubBoard(msgs);
    const r = await runChannelWrite({
      channelId: CHANNEL,
      prevCoverage: 1,
      prevZeroGrowthRounds: 1, // 达到阈值 2
    });
    expect(r.termination.capHit).toBe(false);
    // ⛔ R6：零增长收敛 ⇒ converged（不是 capped）
    expect(r.termination.state).toBe("converged");
    expect(r.termination.state).not.toBe("capped");
  });
});

// ── R7（attempt 2 blocker）：harvest 本 tick 发布新 proposed clue 时不得假报 converged ──
// 评审 blocker（src/tick-run.ts:1300-1308）：runChannelWrite 原先用 postWriteState.cards（不含
//   本 tick 经 harvest 新发布的 proposed clue）调用 decideTermination。当被收割的卡恰为最后一张
//   非终态卡（in_flight→explored，inFlight 变 0），新发布的 proposed clue 又不可见 ⇒ 终止输入看到
//   inFlight===0 && proposed===0，一旦 zeroGrowthRounds 达阈就在「正创建新待处理工作」的 tick 报
//   state==='converged' —— 正是 spec §0.2/§3.4 禁止的完备性误报。hasPendingWork 已为此补偿
//   （cluesPublished>0），终止判定 attempt 1 未补偿 ⇒ 本用例钉死该补偿。

describe("R7 (attempt 2 blocker): harvest publishing new clues must not falsely report converged", () => {
  it("harvest terminalizes the last in_flight card AND publishes a proposed clue ⇒ termination.state !== 'converged'", async () => {
    // 板面：1 张 in_flight 卡（run-1，已 exited(0)，有待收割的 worker.result）。
    //   - decideTick 产生 harvest 决策；runWrite 把 evidence 发到 evidence channel、把新 proposed clue
    //     发到板 channel、把该卡 CAS 到 explored。
    //   - 写后板面（applyCasOutcomes）只剩 explored 的旧卡；本 tick 新发的 proposed clue 不在写前快照里。
    //   - 传 prevCoverage/prevZeroGrowthRounds 使其「本应达阈」（prevZgr=1 ⇒ 本轮 +1 = 2 ≥ 阈值）。
    // ⛔ 改动前（attempt 1）：termination 看到全终态板面 ⇒ 假报 state==='converged'。
    //    改动后（attempt 2）：终止板面并入本 tick 新发的 proposed clue（proposed>0）⇒ 不得收敛。
    const EVIDENCE_CHANNEL = `${CHANNEL}.evidence`;
    const inFlightMsg: InspectMessage = {
      message_id: "msg_clue_inflight",
      channel_id: CHANNEL,
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
    const runsMessages: InspectMessage[] = [
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
          materials: [{ uri: "m1" }],
        },
        entity_id: "run-1",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    let boardCalls = 0;
    let evidenceCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown, _init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse({ head: inFlightMsg });
        }
        if (/\/v1\/channels\/[^/]+\/publish/.test(u)) {
          return jsonResponse({ message_id: "p_x", channel_seq: 99 });
        }
        if (u.includes(`/v1/channels/${CHANNEL}/messages`)) {
          boardCalls += 1;
          return jsonResponse({ messages: boardCalls === 1 ? [inFlightMsg] : [] });
        }
        if (u.includes(`/v1/channels/${EVIDENCE_CHANNEL}/messages`)) {
          evidenceCalls += 1;
          return jsonResponse({ messages: evidenceCalls === 1 ? [] : [] });
        }
        if (u.includes("/v1/channels/board:agent-runs/messages")) {
          const hasAfterSeq = /[?&]after_seq=/.test(u);
          return jsonResponse({ messages: hasAfterSeq ? [] : runsMessages });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    const outcome = await runChannelWrite({
      channelId: CHANNEL,
      evidenceChannelId: EVIDENCE_CHANNEL,
      prevCoverage: 1,
      prevZeroGrowthRounds: 1, // 本轮零增长 ⇒ zgr=2 ≥ 阈值（若板面误判全终态则会假收敛）
    });

    // 前置判别：确实发生了「最后一张非终态卡被收割 + 发布新 proposed clue」。
    expect(outcome.harvestReports).toHaveLength(1);
    expect(outcome.harvestReports[0].cluesPublished).toBe(1);
    expect(outcome.hasPendingWork).toBe(true); // F9 已钉死
    // ⛔ R7 核心断言：本 tick 创建了新待处理工作 ⇒ 终态不得为 converged（完备性不得被误报）。
    expect(outcome.termination.state).not.toBe("converged");
    // 终态同样不得误判 capped（板面远未触顶，capHit=false）。
    expect(outcome.termination.state).not.toBe("capped");
  });
});

// ── R8（attempt 2 major）：生产证据 channel 与板 channel 分离时覆盖度仍可算 ──
// 评审 major（src/tick-run.ts:1188-1194）：--run 原先只读板 channel，而生产 harvest 把
//   research.evidence.v2 发到独立 EVIDENCE_CHANNEL（profiles/deploy/production.env）。
//   ⇒ 生产覆盖度结构性恒 0，「coverage > prevCoverage」永不成立、zeroGrowthRounds 无条件递增、
//   R3 的「覆盖增长 ⇒ 重置」分支在生产不可达。本用例把 evidence 放到独立 channel，断言覆盖度被读到。

describe("R8 (attempt 2 major): coverage reads the separate production evidence channel", () => {
  it("evidence on a distinct evidence channel drives coverage (>0) and resets zeroGrowthRounds on growth", async () => {
    // 板 channel：1 张 explored 卡（无 evidence）。evidence channel：1 条覆盖它的 evidence。
    // 生产拓扑：板 channel ≠ evidence channel。改动前只读板 channel ⇒ coverage=0。
    const EVIDENCE_CHANNEL = "research:agent-harness.evidence";
    const boardMsgs: InspectMessage[] = [
      clueMsg("c1", { status: "explored" }, 1),
    ];
    const evidenceMsgs: InspectMessage[] = [
      {
        message_id: "ev_c1_1",
        channel_id: EVIDENCE_CHANNEL,
        channel_seq: 1,
        kind: "research.evidence.v2",
        payload: { clue_id: "c1", quote: "q", claim: "c", source: "code", locator: "l", revision: "r" },
        entity_id: "c1",
        supersedes: null,
        created_at: "2026-01-01T00:00:00Z",
      },
    ];
    let boardCalls = 0;
    let evCalls = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/entities/")) {
          return jsonResponse({ head: boardMsgs[0] });
        }
        if (u.includes("/publish")) {
          return jsonResponse({ message_id: "p", channel_seq: 99 });
        }
        if (u.includes(`/v1/channels/${CHANNEL}/messages`)) {
          boardCalls += 1;
          return jsonResponse({ messages: boardCalls === 1 ? boardMsgs : [] });
        }
        if (u.includes(`/v1/channels/${EVIDENCE_CHANNEL}/messages`)) {
          evCalls += 1;
          return jsonResponse({ messages: evCalls === 1 ? evidenceMsgs : [] });
        }
        if (u.includes("/v1/channels/board:agent-runs/messages")) {
          return jsonResponse({ messages: [] });
        }
        return jsonResponse({ messages: [] });
      }),
    );

    // prevCoverage=0，本轮 coverage=1（增长）⇒ zeroGrowthRounds 重置为 0（R3 分支在生产可达）。
    const r = await runChannelWrite({
      channelId: CHANNEL,
      evidenceChannelId: EVIDENCE_CHANNEL,
      prevCoverage: 0,
      prevZeroGrowthRounds: 2, // 即便上一轮已达阈，本轮覆盖增长 ⇒ 重置
    });
    // ⛔ R8 核心断言：独立 evidence channel 的覆盖被读到 ⇒ coverage=1（不是结构性 0）。
    expect(r.termination.coverage).toBe(1);
    // 覆盖增长 ⇒ zeroGrowthRounds 重置为 0、不收敛（R3 在生产拓扑下可达）。
    expect(r.termination.zeroGrowthRounds).toBe(0);
    expect(r.termination.state).not.toBe("converged");
  });

  it("without evidenceChannelId, coverage falls back to board-channel-only (single-channel test topology)", async () => {
    // 未配 evidence channel（单 channel 拓扑，如既有 R2/R3 用例）⇒ 退化为只读板 channel 的覆盖，
    // 保持既有行为（evidence 与 clue 同 channel）。evidence 在板 channel 上 ⇒ coverage=1。
    const msgs = [
      clueMsg("c1", { status: "explored" }, 1),
      evidenceMsg("c1", 2),
    ];
    stubBoard(msgs);
    const r = await runChannelWrite({
      channelId: CHANNEL,
      prevCoverage: 0,
      prevZeroGrowthRounds: 0,
    });
    expect(r.termination.coverage).toBe(1);
  });
});

// ── R9（attempt 2 minor 4）：丢了计数器的续投 body 不得被静默当作首轮 ──
// 评审 minor（tick.md:71-76）：解析器原先只特殊处理「两字段都缺」= 首轮，从不检查 seed 标记 ⇒
//   一个丢了计数器的续投 body（如 {"tick":true}）被静默当作首轮 0/0，zeroGrowthRounds 被无声重置
//   —— 正是 R5 禁止的静默回落形态。改动后首轮判定基于 seed 标记，其余无计数 body 响亮失败。

describe("R9 (attempt 2 minor): continuation body that lost its counters fails loudly (no silent first-round reset)", () => {
  it('parseTerminationFromBody throws on {"tick":true} (continuation body missing counters, no seed)', () => {
    // ⛔ 改动前：两字段都缺 ⇒ 被当成首轮 ⇒ 静默 0/0（zeroGrowthRounds 被无声重置）。
    //    改动后：无 seed 标记 ⇒ 响亮失败。
    expect(() =>
      parseTerminationFromBody(JSON.stringify({ tick: true })),
    ).toThrow(TriggerBodyTerminationError);
  });

  it('parseTerminationFromBody accepts {"seed":true} as first-round (returns 0/0 + firstRound:true)', () => {
    // 显式 seed 标记 ⇒ 首轮语义（合法）。
    expect(parseTerminationFromBody(JSON.stringify({ seed: true }))).toEqual({
      prevCoverage: 0,
      prevZeroGrowthRounds: 0,
      firstRound: true,
    });
  });

  it('parseTerminationFromBody treats {seed:true} with extraneous counters still as first-round', () => {
    // seed 标记优先：即便带上计数字段，seed:true 仍认定首轮（seed 是权威的首轮信号）。
    expect(
      parseTerminationFromBody(JSON.stringify({ seed: true, coverage: 9, zeroGrowthRounds: 9 })),
    ).toEqual({ prevCoverage: 0, prevZeroGrowthRounds: 0, firstRound: true });
  });

  it('tick.md with a lost-counters continuation body {"tick":true} exits non-zero naming trigger_body', () => {
    // bash 层：丢了计数器的续投 body ⇒ tick-entry --parse-trigger-body 抛 ⇒ tick.md 非零退出，
    // stderr 点名 trigger_body/G4b（不得静默回落 0/0）。
    const dir = mkdtempSync(join(tmpdir(), "g4b-r9-"));
    const tickEntry = join(dir, "tick-entry");
    writeFakeTickEntry({
      tickEntryPath: tickEntry,
      argvLog: join(dir, "tick-entry.argv.log"),
      fakeRunBody:
        '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}',
    });
    const tpl = readFileSync(TICK_MD, "utf8");
    const script = tpl
      .replace(/\{\{tick_entry\}\}/g, tickEntry)
      .replace(/\{\{tick_channel\}\}/g, CHANNEL)
      .replace(/\{\{evidence_channel\}\}/g, "")
      .replace(/\{\{allowed_root\}\}/g, "")
      .replace(/\{\{max_writes\}\}/g, "64")
      .replace(/\{\{research_question\}\}/g, "")
      .replace(/\{\{trigger_store_dir\}\}/g, "/tmp/x")
      .replace(/\{\{loop_store_cli\}\}/g, "/tmp/c")
      .replace(/\{\{loop_engine_runner\}\}/g, "/tmp/r")
      .replace(/\{\{trigger_body\}\}/g, JSON.stringify({ tick: true }));
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    let errCode = 0;
    let errText = "";
    try {
      execFileSync("bash", [outShell], {
        cwd: dir,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (e) {
      const ee = e as { status?: number; stderr?: string | Buffer };
      errCode = ee.status ?? -1;
      errText = String(ee.stderr ?? "");
    }
    expect(errCode).not.toBe(0);
    expect(errText).toMatch(/G4b.*trigger_body/i);
    rmSync(dir, { recursive: true, force: true });
  });
});
