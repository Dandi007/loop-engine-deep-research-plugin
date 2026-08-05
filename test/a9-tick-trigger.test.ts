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
import { describe, it, expect } from "vitest";
import { parse } from "yaml";
import { hasPendingWork } from "../src/tick";
import type { BoardCard, BoardState } from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
