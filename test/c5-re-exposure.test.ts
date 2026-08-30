/**
 * C5（再暴露）——「干净 exit 0 零报告」新失败签名：判别性测试（spec §判别性测试 1–4）。
 *
 * 根因（spec §根因链）：fleet.yaml.tpl 硬编码 `max_passes: 16` ⇒ loop-engine maxRounds=16 ⇒
 *   收敛所需轮数 > 16 的 heavy run 在终态 generate tick 前被截断 ⇒ report 永不落盘；而旧哨兵
 *   （check-drain-failures.mjs）只把 `running + outstanding>0`、drain 无 run.end、轮次未闭合判为
 *   sentinel_lost ⇒ `status=done + outstanding=1 + run.end 有 + 轮次全闭合` 被误当成功 ⇒ 静默 exit 0。
 *
 * 判别性规格（不可放宽）：
 *   1. heavy run 终局恰有其一：(a) 报告已生成+publish+export；或 (b) 响亮失败（非零 + 命名 reason）。
 *      「干净 exit 0 且零报告」被禁止。
 *   2. round 预算有界但充分（由 tick 配置确定性推导，非固定 16；终止 tick/generate 必在预算内可达）。
 *   3. 哨兵扩展：drain 后若「status=done 且 outstanding>0（未消费续投 trigger）」或「docs channel 空」
 *      ⇒ 响亮零报告终态（类比 sentinel_lost，非零 + 点名 drain_id/outstanding/缺报告）。
 *   4. 既有测试与 smoke:cas 不得回退；partial/capped 终态报告头部 anchor-rate 行不丢失。
 */
import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, vi } from "vitest";
import { parse } from "yaml";
import { deriveMaxPasses, DEFAULT_MAX_PASSES_MARGIN } from "../src/max-passes";
import { DEFAULT_TICK_CONFIG } from "../src/tick";
import { runGenerate, renderReportHead, DEFAULT_GENERATE_CONFIG } from "../src/generate";
import type { GenerateDeps, AnchorCheckResult } from "../src/generate";
import type { TerminationState } from "../src/tick";
import type { DocV2 } from "../src/protocol";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(ROOT, "bin", "deep-research-loop.sh");
const FLEET_TPL = join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl");
const MAX_PASSES_SRC = join(ROOT, "src", "max-passes.ts");

// ══════════════════════════════════════════════════════════════════════
// 辅助：驱动真实 bin/deep-research-loop.sh + 假 CLI/store + 预构造 registry
// ══════════════════════════════════════════════════════════════════════

interface FakeEnv {
  dir: string;
  cli: string;
  storeCli: string;
  engineRoot: string;
  runsRoot: string;
  runDir: string;
}

function setUp(label: string): FakeEnv {
  const dir = mkdtempSync(join(tmpdir(), `c5re-${label}-`));
  mkdirSync(join(dir, "dist", "lib"), { recursive: true });
  const cli = join(dir, "dist", "cli.sh");
  const storeCli = join(dir, "dist", "lib", "store-cli.sh");
  const engineRoot = join(dir, "engine-root");
  mkdirSync(engineRoot, { recursive: true });
  const runsRoot = join(engineRoot, "runs", `run-${label}`);
  mkdirSync(runsRoot, { recursive: true });
  const runDir = join(runsRoot, `tick-run-${label}`);
  mkdirSync(runDir, { recursive: true });
  return { dir, cli, storeCli, engineRoot, runsRoot, runDir };
}

function writeFakeCli(cli: string, summaryFile: string, exitCode = 0): void {
  writeFileSync(
    cli,
    `#!/usr/bin/env bash\ncat '${summaryFile}'\nexit ${exitCode}\n`,
  );
  chmodSync(cli, 0o755);
}

function writeFakeStoreCli(storeCli: string): void {
  writeFileSync(storeCli, "#!/usr/bin/env bash\n# no-op\n");
  chmodSync(storeCli, 0o755);
}

function writeSummary(summaryFile: string, drainId: string, runsRoot: string, reason = "drained"): void {
  writeFileSync(
    summaryFile,
    JSON.stringify({
      reason,
      rounds: 1,
      ticksByLabel: { tick: 1 },
      runs_root: runsRoot,
      drain_id: drainId,
    }),
  );
}

function drainRunStart(indexPath: string, drainId: string, runsRoot: string, fleet: string): void {
  writeFileSync(
    indexPath,
    JSON.stringify({
      schema: "lei/1",
      kind: "run.start",
      run_id: drainId,
      label: "deep-research",
      fleet,
      caller: "manual",
      run_dir: runsRoot,
      ts: new Date().toISOString(),
      pid: 12345,
    }) + "\n",
  );
}

function drainRunEnd(indexPath: string, drainId: string): void {
  appendFileSync(
    indexPath,
    JSON.stringify({
      schema: "lei/1",
      kind: "run.end",
      run_id: drainId,
      status: "ok",
      exit_code: 0,
      duration_ms: 1,
      ts: new Date().toISOString(),
    }) + "\n",
  );
}

function laneRunStart(indexPath: string, drainId: string, runDir: string, runId: string): void {
  appendFileSync(
    indexPath,
    JSON.stringify({
      schema: "lei/1",
      kind: "run.start",
      run_id: runId,
      label: "tick",
      fleet: "workflows/deep-research/tick",
      caller: "drain",
      run_dir: runDir,
      ts: new Date().toISOString(),
      pid: 12345,
      drain_id: drainId,
      lane: "tick",
      tick: 1,
    }) + "\n",
  );
}

function writeJournal(journalPath: string, result: string): void {
  writeFileSync(
    journalPath,
    JSON.stringify({ run_id: "tick~1", identity: "tick", result }) + "\n",
  );
}

function writeDrainJson(runsRoot: string, drainId: string, over: Record<string, unknown>): void {
  writeFileSync(
    join(runsRoot, "drain.json"),
    JSON.stringify(
      {
        contract_version: 2,
        drain_id: drainId,
        runs_root: runsRoot,
        fleet_config: "fleet.yaml",
        pid: 12345,
        started: 0,
        status: "running",
        loop_events: "loop-events.jsonl",
        last_heartbeat: 0,
        outstanding: 1,
        ...over,
      },
      null,
      2,
    ),
  );
}

function writeBalancedLoopEvents(runsRoot: string): void {
  const lines = [
    JSON.stringify({ ts: 0, kind: "round_start", detail: { round: 1 } }),
    JSON.stringify({ ts: 0, kind: "round_end", detail: { round: 1 } }),
  ];
  writeFileSync(join(runsRoot, "loop-events.jsonl"), lines.join("\n") + "\n");
}

function runScript(env: Record<string, string>): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("bash", [SCRIPT], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30000,
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

function baseEnv(engineRoot: string, channel: string): Record<string, string> {
  return {
    LOOP_ENGINE_RUNNER: "bash",
    LOOP_ENGINE_RUNTIME_ROOT: engineRoot,
    TICK_CHANNEL: channel,
    RESEARCH_QUESTION: "test research question",
  };
}

/** 生成段一次性标记文件路径（与 src/tick-run.ts runChannelWrite 逐字对齐）。 */
function reportMarkerPath(oneShotDir: string, origin: string, channel: string): string {
  const markerHash = createHash("sha256")
    .update(`${origin}:${channel}`)
    .digest("hex")
    .slice(0, 16);
  return join(oneShotDir, `generated-${markerHash}`);
}

// ══════════════════════════════════════════════════════════════════════
// 判别性规格 1/2 + 判别测试 1：round 预算在终态 tick 前耗尽（done+outstanding>0）
// ⇒ 非「exit 0 无报告」：要么报告已产出，要么响亮失败（命名 zero_report）。
// ══════════════════════════════════════════════════════════════════════

describe("C5-re-exposure 1: round budget exhausted before terminal tick ⇒ NOT silent exit 0", () => {
  it("done + outstanding=1 + run.end present + rounds closed + no report ⇒ non-zero + zero_report named reason", () => {
    const drainId = "c5re-budget-a";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } = setUp("budget-a");
    const summaryFile = join(dir, "summary.json");
    writeSummary(summaryFile, drainId, runsRoot, "drained");
    writeFakeCli(cli, summaryFile, 0);
    writeFakeStoreCli(storeCli);
    // 预算耗尽后的 registry：drain 干净收尾（done）但 outstanding=1（未消费续投 trigger），
    // run.end 有、轮次闭合 —— 旧哨兵 sentinelLost=false ⇒ 静默 exit 0（修复前红）。
    writeDrainJson(runsRoot, drainId, { status: "done", outstanding: 1, ended: 1 });
    writeBalancedLoopEvents(runsRoot);
    const indexPath = join(engineRoot, "index.jsonl");
    drainRunStart(indexPath, drainId, runsRoot, "fleet.yaml");
    laneRunStart(indexPath, drainId, runDir, "tick-run-budget-a");
    drainRunEnd(indexPath, drainId);
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      ...baseEnv(engineRoot, "research:test-c5re-budget-a"),
    });

    // ⛔ 判别性规格 1/3：非「exit 0 无报告」——必须响亮失败（命名 reason）。
    expect(res.code).not.toBe(0);
    expect(res.err).toContain("zero_report");
    expect(res.err).toContain(drainId);
    expect(res.err).toContain("outstanding=1");

    rmSync(dir, { recursive: true, force: true });
  });

  it("健康对照：done + outstanding=0 + run.end 有 + 无 origin ⇒ 维持 exit 0（防误报）", () => {
    const drainId = "c5re-budget-healthy";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } = setUp("budget-healthy");
    const summaryFile = join(dir, "summary.json");
    writeSummary(summaryFile, drainId, runsRoot, "drained");
    writeFakeCli(cli, summaryFile, 0);
    writeFakeStoreCli(storeCli);
    writeDrainJson(runsRoot, drainId, { status: "done", outstanding: 0, ended: 1 });
    writeBalancedLoopEvents(runsRoot);
    const indexPath = join(engineRoot, "index.jsonl");
    drainRunStart(indexPath, drainId, runsRoot, "fleet.yaml");
    laneRunStart(indexPath, drainId, runDir, "tick-run-budget-healthy");
    drainRunEnd(indexPath, drainId);
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      ...baseEnv(engineRoot, "research:test-c5re-budget-healthy"),
    });

    expect(res.code).toBe(0);
    expect(res.err).not.toContain("zero_report");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判别测试 2：哨兵直接判定——「docs channel 为空」registry 形态 ⇒ 响亮零报告
// ══════════════════════════════════════════════════════════════════════

describe("C5-re-exposure 2: sentinel catches docs channel empty after clean drain", () => {
  it("done + outstanding=0 + run.end 有 + RESEARCH_ORIGIN 已配置但报告标记缺失 ⇒ non-zero + zero_report", () => {
    const drainId = "c5re-docsempty-a";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } = setUp("docsempty-a");
    const summaryFile = join(dir, "summary.json");
    writeSummary(summaryFile, drainId, runsRoot, "drained");
    writeFakeCli(cli, summaryFile, 0);
    writeFakeStoreCli(storeCli);
    // 干净收尾（done + outstanding 0 + run.end + 轮次闭合）但报告未生成（标记缺失）。
    writeDrainJson(runsRoot, drainId, { status: "done", outstanding: 0, ended: 1 });
    writeBalancedLoopEvents(runsRoot);
    const indexPath = join(engineRoot, "index.jsonl");
    drainRunStart(indexPath, drainId, runsRoot, "fleet.yaml");
    laneRunStart(indexPath, drainId, runDir, "tick-run-docsempty-a");
    drainRunEnd(indexPath, drainId);
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");

    const oneShotDir = join(dir, "one-shot");
    mkdirSync(oneShotDir, { recursive: true });

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      ...baseEnv(engineRoot, "research:test-c5re-docsempty-a"),
      RESEARCH_ORIGIN: "c5re-origin-a",
      DR_ONE_SHOT_DIR: oneShotDir,
    });

    expect(res.code).not.toBe(0);
    expect(res.err).toContain("zero_report");
    expect(res.err).toContain(drainId);
    expect(res.err).toMatch(/report not generated|docs channel empty/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("健康对照：报告标记存在（报告已生成）⇒ exit 0（防误报）", () => {
    const drainId = "c5re-docsempty-healthy";
    const { dir, cli, storeCli, engineRoot, runsRoot, runDir } = setUp("docsempty-healthy");
    const summaryFile = join(dir, "summary.json");
    writeSummary(summaryFile, drainId, runsRoot, "drained");
    writeFakeCli(cli, summaryFile, 0);
    writeFakeStoreCli(storeCli);
    writeDrainJson(runsRoot, drainId, { status: "done", outstanding: 0, ended: 1 });
    writeBalancedLoopEvents(runsRoot);
    const indexPath = join(engineRoot, "index.jsonl");
    drainRunStart(indexPath, drainId, runsRoot, "fleet.yaml");
    laneRunStart(indexPath, drainId, runDir, "tick-run-docsempty-healthy");
    drainRunEnd(indexPath, drainId);
    writeJournal(join(runDir, "journal.jsonl"), "OK: all fine");

    const oneShotDir = join(dir, "one-shot");
    mkdirSync(oneShotDir, { recursive: true });
    // 报告已生成：生成一次性标记文件存在。
    const marker = reportMarkerPath(oneShotDir, "c5re-origin-healthy", "research:test-c5re-docsempty-healthy");
    writeFileSync(marker, "");

    const res = runScript({
      LOOP_ENGINE_CLI: cli,
      LOOP_STORE_CLI: storeCli,
      ...baseEnv(engineRoot, "research:test-c5re-docsempty-healthy"),
      RESEARCH_ORIGIN: "c5re-origin-healthy",
      DR_ONE_SHOT_DIR: oneShotDir,
    });

    expect(res.code).toBe(0);
    expect(res.err).not.toContain("zero_report");

    rmSync(dir, { recursive: true, force: true });
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判别测试 3：round 预算非固定 16（有界但充分，终止 tick 必在预算内可达）
// ══════════════════════════════════════════════════════════════════════

describe("C5-re-exposure 3: round budget derived (not fixed 16), bounded-but-sufficient", () => {
  it("deriveMaxPasses >= 使 zeroGrowthRounds 达阈所需轮数的下界（zeroGrowthThreshold）且非固定 16", () => {
    const budget = deriveMaxPasses({
      maxClues: DEFAULT_TICK_CONFIG.maxClues,
      zeroGrowthThreshold: DEFAULT_TICK_CONFIG.zeroGrowthThreshold,
    });
    // 非固定 16。
    expect(budget).not.toBe(16);
    // 下界：zeroGrowthRounds 达阈至少需要 zeroGrowthThreshold 轮。
    expect(budget).toBeGreaterThanOrEqual(DEFAULT_TICK_CONFIG.zeroGrowthThreshold);
    // 有界但充分：coverage 增长上界 = maxClues，加上零增长确认轮与余量。
    expect(budget).toBeGreaterThanOrEqual(
      DEFAULT_TICK_CONFIG.maxClues +
        DEFAULT_TICK_CONFIG.zeroGrowthThreshold +
        DEFAULT_MAX_PASSES_MARGIN,
    );
    expect(Number.isInteger(budget)).toBe(true);
  });

  it("fleet.yaml.tpl 不再硬编码 max_passes: 16，渲染出的 max_passes 与推导公式一致", () => {
    const tpl = readFileSync(FLEET_TPL, "utf8");
    // ⛔ 判别性：固定 16 已从模板移除，改用推导占位符 ${MAX_PASSES}。
    expect(tpl).not.toMatch(/max_passes:\s*16\b/);
    expect(tpl).toMatch(/max_passes:\s*\$\{MAX_PASSES\}/);

    // 真实 dry-run 渲染：MAX_PASSES 由 bin 脚本推导（vite-node 调 src/max-passes.ts）。
    const rendered = execFileSync("bash", [SCRIPT, "--dry-run"], {
      cwd: ROOT,
      encoding: "utf8",
      env: {
        ...process.env,
        TICK_CHANNEL: "research:test-c5re-render",
        RESEARCH_QUESTION: "test research question",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const doc = parse(rendered) as { max_passes?: unknown };
    expect(typeof doc.max_passes).toBe("number");
    expect(doc.max_passes).not.toBe(16);
    const derived = deriveMaxPasses({
      maxClues: DEFAULT_TICK_CONFIG.maxClues,
      zeroGrowthThreshold: DEFAULT_TICK_CONFIG.zeroGrowthThreshold,
    });
    expect(doc.max_passes).toBe(derived);
  });

  it("src/max-passes.ts CLI（MAX_PASSES_CLI=1）输出推导预算且非 16", () => {
    const out = execFileSync(
      process.execPath,
      [join(ROOT, "node_modules", ".bin", "vite-node"), MAX_PASSES_SRC],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, MAX_PASSES_CLI: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    const value = Number(out.trim());
    expect(Number.isInteger(value)).toBe(true);
    expect(value).not.toBe(16);
    expect(value).toBe(
      deriveMaxPasses({
        maxClues: DEFAULT_TICK_CONFIG.maxClues,
        zeroGrowthThreshold: DEFAULT_TICK_CONFIG.zeroGrowthThreshold,
      }),
    );
  });
});

// ══════════════════════════════════════════════════════════════════════
// 判别测试 4：partial/capped 终态报告头部 anchor-rate 行不丢失（回归护栏）
// ══════════════════════════════════════════════════════════════════════

describe("C5-re-exposure 4: partial/capped report head keeps anchor-rate line (regression guard)", () => {
  function anchorResult(over: Partial<AnchorCheckResult> = {}): AnchorCheckResult {
    return {
      total: 10,
      current_parsed: 10,
      current_verified_hit: 8,
      current_failed: 0,
      old_format: 0,
      unparseable: 0,
      discarded: 0,
      sums_ok: true,
      loud_failures: [],
      ...over,
    };
  }

  function term(over: Partial<TerminationState> = {}): TerminationState {
    return {
      state: "converged",
      coverage: 0,
      zeroGrowthRounds: 0,
      capHit: false,
      boardComposition: { proposed: 0, open: 0, inFlight: 0, explored: 0, blocked: 0 },
      ...over,
    };
  }

  function baseDeps(over: Partial<GenerateDeps> = {}): GenerateDeps {
    return {
      readTermination: async () => term(),
      countBlocked: async () => 0,
      readQuestion: async () => "research question?",
      readOrigin: async () => "research-1",
      readEvidences: async () => [],
      spawnRole: vi.fn(async () => ({ body: "role output" })),
      spawnAnchorCheck: vi.fn(async () => anchorResult()),
      spawnExport: vi.fn(async () => {}),
      writeDoc: vi.fn(async () => "msg-1"),
      lockSynthesizer: async () => async () => {},
      ...over,
    };
  }

  it("partial（blocked>0）与 capped 终态都生成报告，且报告头部含 dr-anchor-rate 行", async () => {
    for (const state of ["capped", "partial"] as const) {
      const written: DocV2[] = [];
      const deps = baseDeps({
        readTermination: async () => term({ state, capHit: state === "capped" }),
        countBlocked: async () => (state === "partial" ? 3 : 0),
        writeDoc: vi.fn(async (doc: DocV2) => {
          written.push(doc);
          return "msg-1";
        }),
      });
      await runGenerate(deps, DEFAULT_GENERATE_CONFIG);
      const report = written.find((d) => d.doc_kind === "report");
      expect(report).toBeDefined();
      // ⛔ 判别性：partial/capped 报告头部必须保留 anchor-rate 行（不得丢失）。
      expect(report!.body).toContain("dr-anchor-rate");
      expect(report!.body).toMatch(/dr-terminal stop=/);
      expect(deps.spawnExport).toHaveBeenCalledTimes(1);
    }
  });

  it("renderReportHead 对 partial/capped 标记也始终输出 anchor-rate 行", () => {
    for (const stop of ["capped", "converged"] as const) {
      const head = renderReportHead({ stop, blocked: 3, capHit: stop === "capped" }, 80);
      expect(head).toContain("dr-anchor-rate 80");
    }
  });
});
