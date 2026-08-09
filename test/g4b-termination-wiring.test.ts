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
    expect(parsed).toEqual({ prevCoverage: 3, prevZeroGrowthRounds: 2 });
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
    });
  });

  it("tick.md reads {{trigger_body}} and writes {coverage,zeroGrowthRounds} into next trigger body", () => {
    // 端到端 bash 层：渲染 tick.md，喂一个带计数的 trigger_body，
    // 断言假 tick-entry 收到 --prev-coverage/--prev-zero-growth，且续投 trigger body 含本轮计数。
    const dir = mkdtempSync(join(tmpdir(), "g4b-r4-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const runnerLog = join(dir, "puts.log");
    const tickEntry = join(dir, "tick-entry");
    // 假 tick-entry：记录 argv，输出含 termination 的 JSON，hasPendingWork=true 触发续投
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nprintf '%s\\n' '{"hasPendingWork": true, "decisions": [], "termination": {"state": null, "coverage": 7, "zeroGrowthRounds": 3, "capHit": false}}'\n`,
    );
    chmodSync(tickEntry, 0o755);
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
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nprintf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}'\n`,
    );
    chmodSync(tickEntry, 0o755);
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
    // ⛔ 首轮不传 --prev-*（seed body 无计数字段）
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
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nprintf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}'\n`,
    );
    chmodSync(tickEntry, 0o755);
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
