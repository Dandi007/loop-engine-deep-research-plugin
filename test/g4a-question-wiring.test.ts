/**
 * G4a(v2) —— `--question` 生产贯通：研究主问题从部署配置一路到 tick-entry --run。
 *
 * 根因（spec §0）：`--question` 被 CLI 解析、被 usage 记录、被引擎在 triage 决策上依赖
 * （缺失 ⇒ MissingTriageQuestionError），唯独生产从不传它 ⇒ 收集段首个 triage 决策响亮失败。
 *
 * 硬验收（spec §2）：
 *  - Q1  从生产入口渲染（profile/env），fleet tick pipeline input 有 question 字段且等于配置值。
 *  - Q2  ⛔ 真正的贯通断言：渲染出的 tick.md + 假 tick-entry 记录 argv，断言 `--question` 及其值
 *        真的出现在 argv 里（Q1 单独存在时是零功率的，见变异 P1）。
 *  - Q3  ⛔ 无内置缺省：不设 env 且无 profile ⇒ 非零退出且错误消息点名该变量；且不得出现推导/编造的问题。
 *  - Q4  ⛔ 组合矩阵：evidence_channel / allowed_root / question 三者「有/无」的全部 8 种组合下，
 *        argv 都只含该有的参数、不含不该有的（证明 §1.2 增量拼 argv 重构没漏分支）。
 */
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "deep-research-loop.sh");
const FLEET = join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl");
const WORKFLOW = join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml");
const TICK_MD = join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md");
const PROFILES_DIR = join(ROOT, "profiles", "deploy");
const RELEVANT_ENV = ["TICK_CHANNEL", "EVIDENCE_CHANNEL", "ALLOWED_ROOT", "MAX_WRITES", "RESEARCH_QUESTION"];
const TEST_RESEARCH_QUESTION = "光伏并网系统的谐波治理策略研究";

function readProfile(name: string): Record<string, string> {
  const text = readFileSync(join(PROFILES_DIR, `${name}.env`), "utf8");
  const rec: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) rec[m[1]] = m[2];
  }
  return rec;
}

function cleanChildEnv(): NodeJS.ProcessEnv {
  const childEnv = { ...process.env };
  for (const k of [...RELEVANT_ENV, "DEPLOY_PROFILE", "EXPORT_ROOT"]) delete childEnv[k];
  return childEnv;
}

function render(env: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
  try {
    const out = execFileSync("bash", [BIN, "--dry-run"], {
      cwd: ROOT,
      encoding: "utf8",
      env,
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

function tickInput(out: string): Record<string, unknown> {
  const doc = parse(out) as { pipelines?: Array<{ label?: string; input?: Record<string, unknown> }> };
  const input = doc.pipelines?.find((p) => p.label === "tick")?.input;
  if (!input) throw new Error("no tick pipeline input in rendered fleet");
  return input;
}

// 渲染 tick.md 并用假 tick-entry 记录 argv（照 a10c 的 --max-writes 做法）。
function runRenderedTick(values: Record<string, string>, argvLog: string): string[] {
  const tickEntry = join(dirname(argvLog), "tick-entry");
  writeFileSync(
    tickEntry,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nprintf '%s\\n' '{"hasPendingWork": false, "decisions": [], "termination": {"state": "converged", "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}'\n`,
  );
  chmodSync(tickEntry, 0o755);
  const script = readFileSync(TICK_MD, "utf8").replace(/\{\{([a-z_]+)\}\}/g, (_m, key) => values[key] ?? "");
  const outShell = join(dirname(argvLog), "tick.sh");
  writeFileSync(outShell, script);
  chmodSync(outShell, 0o755);
  execFileSync("bash", [outShell], { cwd: ROOT, encoding: "utf8" });
  return readFileSync(argvLog, "utf8").trim().split("\n").filter((l) => l.length > 0);
}

// ── Q1：从生产入口渲染，fleet input 有 question 字段且等于配置值 ──

describe("G4a Q1: fleet input carries research_question equal to the configured value", () => {
  it("fleet.yaml.tpl declares research_question from ${RESEARCH_QUESTION}", () => {
    const tpl = readFileSync(FLEET, "utf8");
    expect(tpl).toMatch(/research_question:\s*\$\{RESEARCH_QUESTION\}/);
  });

  it("workflow.yaml carries research_question in the tick seed payload", () => {
    const wf = readFileSync(WORKFLOW, "utf8");
    expect(wf).toMatch(/research_question:\s*"\{\{research_question\}\}"/);
  });

  it("from production profile only: rendered fleet input.research_question === profile value", () => {
    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = "agent-harness";
    for (const k of RELEVANT_ENV) expect(childEnv).not.toHaveProperty(k);
    const res = render(childEnv);
    expect(res.code).toBe(0);
    const input = tickInput(res.out);
    expect(input.research_question).toBe(readProfile("agent-harness").RESEARCH_QUESTION);
  });

  it("from explicit env: rendered fleet input.research_question === the explicit value", () => {
    const childEnv = cleanChildEnv();
    childEnv.TICK_CHANNEL = "research:v1-test.index";
    childEnv.RESEARCH_QUESTION = TEST_RESEARCH_QUESTION;
    const input = tickInput(render(childEnv).out);
    expect(input.research_question).toBe(TEST_RESEARCH_QUESTION);
  });
});

// ── Q2：⛔ 真正的贯通断言：--question 及其值真的出现在 tick-entry argv ──

describe("G4a Q2: --question and its value really reach tick-entry argv", () => {
  it("rendered tick.md passes the injected research_question into tick-entry argv", () => {
    const dir = mkdtempSync(join(tmpdir(), "g4a-q2-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const values: Record<string, string> = {
      tick_entry: join(dir, "tick-entry"),
      tick_channel: "research:agent-harness.index",
      evidence_channel: "research:agent-harness.evidence",
      allowed_root: "/data/code/self/agent-runtime",
      max_writes: "96",
      research_question: TEST_RESEARCH_QUESTION,
    };
    const argv = runRenderedTick(values, argvLog);
    // ⛔ 判别性：不得只凭「fleet input 里有 question」（那是 Q1）就下结论——这里是 Q2 的
    //    真正贯通断言：--question 与其值真的到达 tick-entry --run 的 argv。
    expect(argv).toContain("--question");
    expect(argv[argv.indexOf("--question") + 1]).toBe(TEST_RESEARCH_QUESTION);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── Q3：无内置缺省，未配置即响亮失败（点名变量，无编造/推导）──────

describe("G4a Q3: RESEARCH_QUESTION has no default; unset ⇒ loud failure naming the var", () => {
  it("no env and no profile ⇒ non-zero exit naming RESEARCH_QUESTION + Refusing", () => {
    const childEnv = cleanChildEnv();
    expect(childEnv).not.toHaveProperty("RESEARCH_QUESTION");
    expect(childEnv).not.toHaveProperty("DEPLOY_PROFILE");
    // ⛔ TICK_CHANNEL 也须缺失，才能确定失败来自 RESEARCH_QUESTION 这一层语义：
    //    TICK_CHANNEL 检查先于 RESEARCH_QUESTION，故此处显式给 TICK_CHANNEL 以隔离 RESEARCH_QUESTION。
    childEnv.TICK_CHANNEL = "research:v1-test.index";
    const res = render(childEnv);
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/RESEARCH_QUESTION/);
    expect(res.err).toMatch(/Refusing/i);
    // ⛔ 不得出现被推导/编造的问题字符串（没有可回退的缺省写入）。错误消息只是拒绝并点名变量，
    //    绝不携带任何「看起来像问题」的编造内容（`?`/`=` 出现在 --profile <name> 用法提示里，属正常）。
    expect(res.err).not.toMatch(/光伏|研究主问题|谐波/);
    expect(res.err).not.toMatch(TEST_RESEARCH_QUESTION);
  });

  it("with RESEARCH_QUESTION provided ⇒ renders normally (exit 0, valid YAML)", () => {
    const childEnv = cleanChildEnv();
    childEnv.TICK_CHANNEL = "research:v1-test.index";
    childEnv.RESEARCH_QUESTION = TEST_RESEARCH_QUESTION;
    const res = render(childEnv);
    expect(res.code).toBe(0);
    expect(tickInput(res.out).research_question).toBe(TEST_RESEARCH_QUESTION);
  });
});

// ── Q4：⛔ 组合矩阵：evidence/allowed_root/question 三者全 8 种组合 ──

describe("G4a Q4: argv matrix across all 8 combinations of evidence/allowed_root/question", () => {
  const cases: Array<{ e: boolean; a: boolean; q: boolean }> = [];
  for (const e of [false, true])
    for (const a of [false, true])
      for (const q of [false, true]) cases.push({ e, a, q });

  it.each(cases)("evidence=$e allowed=$a question=$q ⇒ argv has exactly the right flags", ({ e, a, q }) => {
    const dir = mkdtempSync(join(tmpdir(), "g4a-q4-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const values: Record<string, string> = {
      tick_entry: join(dir, "tick-entry"),
      tick_channel: "research:agent-harness.index",
      evidence_channel: e ? "research:v1.evidence" : "",
      allowed_root: a ? "/data/code/self/agent-runtime" : "",
      max_writes: "64",
      research_question: q ? TEST_RESEARCH_QUESTION : "",
    };
    const argv = runRenderedTick(values, argvLog);

    // --run 与 --max-writes 始终在（固定项；假 tick-entry 的 "$@" 不含脚本名 argv[0]，故自 --run 起）。
    expect(argv).toContain("--run");
    expect(argv[argv.indexOf("--run") + 1]).toBe("research:agent-harness.index");
    expect(argv).toContain("--max-writes");
    expect(argv[argv.indexOf("--max-writes") + 1]).toBe("64");

    // 可选参数：有 ⇒ 出现且紧邻值；无 ⇒ 绝不出现。
    const flagPresent = (flag: string): boolean => argv.includes(flag);
    expect(flagPresent("--evidence-channel")).toBe(e);
    if (e) expect(argv[argv.indexOf("--evidence-channel") + 1]).toBe("research:v1.evidence");
    expect(flagPresent("--allowed-root")).toBe(a);
    if (a) expect(argv[argv.indexOf("--allowed-root") + 1]).toBe("/data/code/self/agent-runtime");
    expect(flagPresent("--question")).toBe(q);
    if (q) expect(argv[argv.indexOf("--question") + 1]).toBe(TEST_RESEARCH_QUESTION);

    rmSync(dir, { recursive: true, force: true });
  });
});
