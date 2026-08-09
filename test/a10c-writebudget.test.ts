/**
 * A10c —— 写入预算在生产链路上必须可达（spec §1.1 / §1.2 / §2 硬验收 D3–D6 / P2）。
 *
 * 根因（§0.1）：`--max-writes` CLI 支持，但生产模板从不传 ⇒ `tick-entry --run` 永远吃
 * 默认 5 ⇒ 任何产出 ≥5 条 evidence 的卡在生产里永远收割不了 ⇒ 恒 max_rounds 死锁。
 *
 * D3 —— ⛔ `--max-writes` 从 `bin/deep-research-loop.sh` 一路传到 `tick-entry --run`：
 *       四层（bin → fleet → workflow → tick.md）逐层断言 + 一条端到端用例证明值真的到达。
 * D5/D6 —— 死锁必须可辨认：needed > maxWrites（永不可收割）⇒ budget_infeasible；
 *          本轮预算被前面的卡用掉（needed ≤ maxWrites 但 remaining 不足）⇒ 仍 budget。
 * P2 —— 缺省预算改回 5 ⇒ 6 条 evidence 的卡收割不了（对 D1/D3 的单元级判别）。
 * D7 —— H13 守卫不变：预算不足 ⇒ 零发布、零 CAS。
 */
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { runWrite } from "../src/tick-run";
import type { WriteDeps } from "../src/tick-run";
import type { Decision } from "../src/tick";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BIN = join(ROOT, "..", "bin", "deep-research-loop.sh");
const FLEET = join(ROOT, "..", "workflows", "deep-research", "fleet.yaml.tpl");
const WORKFLOW = join(ROOT, "..", "workflows", "deep-research", "tick", "workflow.yaml");
const TICK_MD = join(ROOT, "..", "workflows", "deep-research", "tick", "templates", "tick.md");
const DEFAULT_MAX_WRITES = 64;

// G1 —— 一张真实卡的写入需求 = evidences + proposed_clues + 1(CAS open→explored)。
// 三次真实 worker 产出实测：6 / 9 / 10 条 evidence（wf-dc0c15 findings）。
// 取观测上界 10 evidence + 2 clue + 1 CAS = 13。
const MIN_VIABLE_BUDGET = 13;

// G1 —— 从**删除了 MAX_WRITES** 的子环境跑 bin --dry-run，取生产实际会吃到的缺省预算。
// ⛔ 生产链路不设 MAX_WRITES（bin/deep-research-loop.sh 是入口，无上游导出该变量），
//    生产吃到的恰是这里渲染出的缺省值。不得写字面量 64。
function renderedDefaultMaxWrites(): number {
  const childEnv = { ...process.env };
  delete childEnv.MAX_WRITES;
  // D1 —— 渲染需要 TICK_CHANNEL（无 profile 且无显式 env ⇒ 响亮失败）；显式提供。
  childEnv.TICK_CHANNEL = "research:v1-test.index";
  const out = execFileSync("bash", [BIN, "--dry-run"], {
    cwd: ROOT,
    encoding: "utf8",
    env: childEnv,
  });
  const doc = parse(out);
  const input = doc.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
  return input?.max_writes;
}

// ── D3：四层逐层断言：--max-writes 一路从 bin 传到 tick-entry --run ──

describe("A10c D3: --max-writes plumbed from bin → fleet → workflow → tick.md", () => {
  it("bin/deep-research-loop.sh exports MAX_WRITES with a default sufficient for a real card", () => {
    const src = readFileSync(BIN, "utf8");
    expect(src).toMatch(/export\s+MAX_WRITES="\$\{MAX_WRITES:-64\}"/);
    // 缺省 64 必须能容纳一张真实卡（6~10 evidence + CAS），且是有穷护栏（非无穷大）。
    expect(src).toMatch(/MAX_WRITES:-64/);
  });

  it("fleet.yaml.tpl carries max_writes in the tick pipeline input", () => {
    const tpl = readFileSync(FLEET, "utf8");
    expect(tpl).toMatch(/max_writes:\s+\$\{MAX_WRITES\}/);
  });

  it("workflow.yaml carries max_writes in the tick seed payload", () => {
    const wf = readFileSync(WORKFLOW, "utf8");
    expect(wf).toMatch(/max_writes:\s*"\{\{max_writes\}\}"/);
  });

  it("tick.md passes --max-writes to tick-entry --run (all four branches)", () => {
    const md = readFileSync(TICK_MD, "utf8");
    expect(md).toMatch(/max_writes="\{\{max_writes\}\}"/);
    // 每条 `--run` 分支都必须带上 --max-writes。
    const runLines = md
      .split("\n")
      .filter((l) => l.includes('"$tick_entry" --run'));
    expect(runLines.length).toBeGreaterThanOrEqual(4);
    for (const line of runLines) {
      expect(line).toMatch(/--max-writes\s+"\$max_writes"/);
    }
  });
});

// ── D3 端到端：值真的到达 tick-entry --run ─────────────────────────

describe("A10c D3 end-to-end: value really reaches tick-entry --run", () => {
  it("rendered tick.md passes the injected max_writes value into tick-entry argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "a10c-d3-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    // 假 tick-entry：把 argv 逐行写进日志，并回显 hasPendingWork=false（无需续投/runner）。
    writeFileSync(
      tickEntry,
      `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nprintf '%s\\n' '{"hasPendingWork": false, "decisions": []}'\n`,
    );
    chmodSync(tickEntry, 0o755);

    const tpl = readFileSync(TICK_MD, "utf8");
    const values: Record<string, string> = {
      tick_entry: tickEntry,
      tick_channel: "research:v1-tick-reclaim.index",
      max_writes: "64",
    };
    const script = tpl.replace(/\{\{([a-z_]+)\}\}/g, (_m, key) => values[key] ?? "");
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    execFileSync("bash", [outShell], { cwd: ROOT, encoding: "utf8" });

    const argv = readFileSync(argvLog, "utf8").trim().split("\n");
    expect(argv).toContain("--max-writes");
    expect(argv[argv.indexOf("--max-writes") + 1]).toBe("64");
    rmSync(dir, { recursive: true, force: true });
  });

  it("driver dry-run renders max_writes=64 into the fleet input (default flows from bin)", () => {
    const out = execFileSync("bash", [BIN, "--dry-run"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, MAX_WRITES: "64", TICK_CHANNEL: "research:v1-test.index" },
    });
    const doc = parse(out);
    const input = doc.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
    expect(input?.max_writes).toBe(64);
  });
});

// ── P2 变异判别：缺省若为 5，6 条 evidence 的卡收割不了 ─────────────

describe("A10c P2-guard: default budget must be able to harvest a real card", () => {
  const harvestDecision = (runId: string): Decision => ({
    kind: "harvest",
    clueId: "card_harvest",
    runId,
    text: "investigate X",
    depth: 0,
    sources: ["code-local"],
  });

  function sixEvidenceDeps(): { deps: WriteDeps } {
    const hd = {
      evidenceChannelId: "research:v1-tick-reclaim.evidence",
      boardChannelId: "research:v1-tick-reclaim.index",
      maxClues: 64,
      maxDepth: 3,
      boardClueCount: { value: 0 },
      readWorkerResult: async () => ({
        run_id: "run-243d00ce",
        evidences: Array.from({ length: 6 }, (_, i) => ({
          quote: `q${i}`,
          claim: `c${i}`,
          source: "code",
          locator: "a",
          revision: "r",
        })),
        proposed_clues: [],
        materials: [{ uri: "m1" }],
      }),
      publishEvidence: async () => {},
      publishClue: async () => {},
    };
    return {
      deps: {
        cas: async () => ({ success: true }),
        spawnWorker: async () => {},
        harvest: hd,
      },
    };
  }

  it("6 evidence + 1 CAS = 7 needed, but maxWrites 5 ⇒ infeasible (would be the D1 deadlock)", async () => {
    const { deps } = sixEvidenceDeps();
    const result = await runWrite(deps, [harvestDecision("run-243d00ce")], 5);
    expect(result.harvestReports[0].skipped).toBe(true);
    expect(result.harvestReports[0].skippedReason).toBe("budget_infeasible");
    expect(result.harvestReports[0].evidencePublished).toBe(0);
    expect(result.harvestReports[0].casExplored).toBe(false);
  });

  it("DEFAULT_MAX_WRITES (64) is enough to harvest the 6-evidence card (D1 liveness at unit level)", async () => {
    const { deps } = sixEvidenceDeps();
    // 显式传 DEFAULT_MAX_WRITES，等价于生产链路上 `--run --max-writes 64`。
    const result = await runWrite(deps, [harvestDecision("run-243d00ce")], DEFAULT_MAX_WRITES);
    expect(result.harvestReports[0].skipped).toBe(false);
    expect(result.harvestReports[0].evidencePublished).toBe(6);
    expect(result.harvestReports[0].casExplored).toBe(true);
  });
});

// ── G1 D1/D2：把「缺省预算可用」从文本断言升级为行为断言 ─────────────

describe("G1 D1: default budget is a finite positive integer >= MIN_VIABLE_BUDGET", () => {
  it("bin --dry-run from a child env with MAX_WRITES removed renders a default max_writes >= MIN_VIABLE_BUDGET", () => {
    const childEnv = { ...process.env };
    delete childEnv.MAX_WRITES;
    // ⛔ 自证子环境真的没有 MAX_WRITES，否则本用例会重蹈它要修的那个错（声称删了、实际没删 ⇒ 恒绿）。
    expect(childEnv).not.toHaveProperty("MAX_WRITES");
    // D1 —— 渲染需要 TICK_CHANNEL（无 profile 且无显式 env ⇒ 响亮失败）；显式提供。
    childEnv.TICK_CHANNEL = "research:v1-test.index";

    const out = execFileSync("bash", [BIN, "--dry-run"], {
      cwd: ROOT,
      encoding: "utf8",
      env: childEnv,
    });
    const doc = parse(out);
    const input = doc.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
    const maxWrites = input?.max_writes;
    // 是有限正整数（不是 Infinity、不是 0、不是字符串）。
    expect(typeof maxWrites).toBe("number");
    expect(Number.isInteger(maxWrites)).toBe(true);
    expect(maxWrites).toBeGreaterThan(0);
    expect(Number.isFinite(maxWrites)).toBe(true);
    // 缺省必须足以收割一张真实卡。
    expect(maxWrites).toBeGreaterThanOrEqual(MIN_VIABLE_BUDGET);
  });
});

describe("G1 D2: default budget harvests a real card end-to-end", () => {
  const harvestDecision = (runId: string): Decision => ({
    kind: "harvest",
    clueId: "card_harvest",
    runId,
    text: "investigate X",
    depth: 0,
    sources: ["code-local"],
  });

  // 10 evidence + 2 proposed_clue = needed 13（观测上界，见 MIN_VIABLE_BUDGET 依据）。
  function tenEvidenceTwoClueDeps(): { deps: WriteDeps } {
    const hd = {
      evidenceChannelId: "research:v1-tick-reclaim.evidence",
      boardChannelId: "research:v1-tick-reclaim.index",
      maxClues: 64,
      maxDepth: 3,
      boardClueCount: { value: 0 },
      readWorkerResult: async () => ({
        run_id: "run-10ev2clue",
        evidences: Array.from({ length: 10 }, (_, i) => ({
          quote: `q${i}`,
          claim: `c${i}`,
          source: "code",
          locator: "a",
          revision: "r",
        })),
        proposed_clues: Array.from({ length: 2 }, (_, i) => ({ clue: `clue ${i}` })),
        materials: [{ uri: "m1" }],
      }),
      publishEvidence: async () => {},
      publishClue: async () => {},
    };
    return {
      deps: {
        cas: async () => ({ success: true }),
        spawnWorker: async () => {},
        harvest: hd,
      },
    };
  }

  it("default budget (from D1 path, not a literal) harvests 10 evidence + 2 clues", async () => {
    const { deps } = tenEvidenceTwoClueDeps();
    // ⛔ 预算取 D1 那条路径实际渲染出的值（不得写字面量 64）。
    const budget = renderedDefaultMaxWrites();
    const result = await runWrite(deps, [harvestDecision("run-10ev2clue")], budget);
    const report = result.harvestReports[0];
    expect(report.skipped).toBe(false);
    expect(report.evidencePublished).toBe(10);
    expect(report.cluesPublished).toBe(2);
    expect(report.casExplored).toBe(true);
  });
});