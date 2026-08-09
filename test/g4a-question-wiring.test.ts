/**
 * G4a —— 研究主问题（--question）从部署配置一路贯通到 `tick-entry --run --question`
 * （spec §1 / §2 硬验收 Q1–Q4 / §3 变异矩阵 P1–P3）。
 *
 * 根因（spec §0）：`--question` 已被 CLI 解析（parseRunCliArgs）、被 usage 记录、
 * 被引擎依赖（triage 决策缺 readQuestion ⇒ MissingTriageQuestionError），但生产装配链
 * bin → fleet → workflow → tick.md **从不传** ⇒ V2 端到端一旦跑到 triage 就停。
 *
 * 本包把研究主问题照 MAX_WRITES 已经走通的那条形状（bin 导出 → fleet input → workflow
 * seed → tick.md 增量 argv → `tick-entry --run --question`）接通，且无内置缺省、未配置即响亮失败。
 *
 * ⛔ 本包的存在理由是 Q2：只断言「fleet input 里有 question」是零功率的（那是 Q1）。
 *    Q2 用假 tick-entry 记录 argv，证明 `--question` 及其值**真的到达** `tick-entry`。
 */
import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";

const ROOT = dirname(fileURLToPath(import.meta.url));
const BIN = join(ROOT, "..", "bin", "deep-research-loop.sh");
const FLEET = join(ROOT, "..", "workflows", "deep-research", "fleet.yaml.tpl");
const WORKFLOW = join(ROOT, "..", "workflows", "deep-research", "tick", "workflow.yaml");
const TICK_MD = join(ROOT, "..", "workflows", "deep-research", "tick", "templates", "tick.md");

const TEST_CHANNEL = "research:v1-test.index";
const QUESTION = "光伏并网谐波治理与电网稳定性的研究";

// 干净子环境：去掉 RESEARCH_QUESTION 与 DEPLOY_PROFILE（排除 profile 兜底），并保证 TICK_CHANNEL。
function noQuestionEnv(): NodeJS.ProcessEnv {
  const childEnv = { ...process.env };
  delete childEnv.RESEARCH_QUESTION;
  delete childEnv.DEPLOY_PROFILE;
  childEnv.TICK_CHANNEL = TEST_CHANNEL;
  return childEnv;
}

function renderResult(env: NodeJS.ProcessEnv): { code: number; out: string; err: string } {
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
    return { code: err.status ?? -1, out: String(err.stdout ?? ""), err: String(err.stderr ?? "") };
  }
}

function tickInput(out: string): Record<string, unknown> {
  const doc = parse(out) as { pipelines?: Array<{ label?: string; input?: Record<string, unknown> }> };
  const input = doc.pipelines?.find((p) => p.label === "tick")?.input;
  if (!input) throw new Error("no tick pipeline input in rendered fleet");
  return input;
}

// 渲染 tick.md 到假 tick-entry（记录 argv），返回记录的 argv。
function renderedArgv(values: Record<string, string>): string[] {
  const dir = mkdtempSync(join(tmpdir(), "g4a-"));
  const argvLog = join(dir, "tick-entry.argv.log");
  const tickEntry = join(dir, "tick-entry");
  writeFileSync(
    tickEntry,
    `#!/usr/bin/env bash\nprintf '%s\\n' "$@" > "${argvLog}"\nprintf '%s\\n' '{"hasPendingWork": false}'\n`,
  );
  chmodSync(tickEntry, 0o755);
  const tpl = readFileSync(TICK_MD, "utf8");
  const filled: Record<string, string> = { tick_entry: tickEntry, ...values };
  const script = tpl.replace(/\{\{([a-z_]+)\}\}/g, (_m, key) => filled[key] ?? "");
  const outShell = join(dir, "tick.sh");
  writeFileSync(outShell, script);
  chmodSync(outShell, 0o755);
  execFileSync("bash", [outShell], { cwd: ROOT, encoding: "utf8" });
  const argv = readFileSync(argvLog, "utf8").trim().split("\n");
  rmSync(dir, { recursive: true, force: true });
  return argv;
}

// ── Q1：从生产入口渲染，fleet tick input 里有 question 字段且等于配置值 ──

describe("Q1: production dry-run renders the configured question into fleet tick input", () => {
  it("explicit RESEARCH_QUESTION env flows into fleet input.research_question", () => {
    const res = renderResult({ ...process.env, TICK_CHANNEL: TEST_CHANNEL, RESEARCH_QUESTION: QUESTION });
    expect(res.code).toBe(0);
    expect(tickInput(res.out).research_question).toBe(QUESTION);
  });

  it("RESEARCH_QUESTION from a deploy profile flows into fleet input.research_question", () => {
    const childEnv = noQuestionEnv();
    childEnv.DEPLOY_PROFILE = "production";
    // 自证子环境确实没有 RESEARCH_QUESTION（否则是 profile 之外的东西在兜底）。
    expect(childEnv).not.toHaveProperty("RESEARCH_QUESTION");
    const res = renderResult(childEnv);
    expect(res.code).toBe(0);
    const prof = readFileSync(join(ROOT, "..", "profiles", "deploy", "production.env"), "utf8");
    const m = prof.match(/^RESEARCH_QUESTION=(.*)$/m);
    expect(m).toBeTruthy();
    expect(tickInput(res.out).research_question).toBe(m![1]);
  });
});

// ── Q2（本包存在理由）：真正的贯通断言 —— --question 及其值真的到达 tick-entry argv ──

describe("Q2: rendered tick.md passes --question and its value into tick-entry argv", () => {
  it("--question adjacent to the configured question value appears in the argv", () => {
    const argv = renderedArgv({
      tick_channel: TEST_CHANNEL,
      max_writes: "64",
      research_question: QUESTION,
    });
    const idx = argv.indexOf("--question");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe(QUESTION);
  });

  it("--max-writes is still plumbed alongside --question (refactor didn't drop it)", () => {
    const argv = renderedArgv({
      tick_channel: TEST_CHANNEL,
      max_writes: "64",
      research_question: QUESTION,
    });
    const idx = argv.indexOf("--max-writes");
    expect(idx).toBeGreaterThanOrEqual(0);
    expect(argv[idx + 1]).toBe("64");
  });
});

// ── Q3：无内置缺省；未由 profile 或显式 env 提供 ⇒ 响亮失败点名该变量 ──

describe("Q3: no built-in default; unconfigured research question fails loudly", () => {
  it("no related env and no profile ⇒ non-zero exit naming RESEARCH_QUESTION", () => {
    const childEnv = noQuestionEnv();
    expect(childEnv).not.toHaveProperty("RESEARCH_QUESTION");
    expect(childEnv).not.toHaveProperty("DEPLOY_PROFILE");
    const res = renderResult(childEnv);
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/RESEARCH_QUESTION/);
    expect(res.err).toMatch(/Refusing/i);
  });

  it("failure message contains no fabricated/derived question string", () => {
    const childEnv = noQuestionEnv();
    const res = renderResult(childEnv);
    expect(res.code).not.toBe(0);
    // ⛔ 不得出现任何被推导/编造的问题字符串（如 channel 名、topic slug 之类）。
    expect(res.err).not.toMatch(/research:v1/);
    expect(res.err).toMatch(/RESEARCH_QUESTION/);
  });

  it("positive: explicit RESEARCH_QUESTION env renders successfully (exit 0)", () => {
    const res = renderResult({ ...process.env, TICK_CHANNEL: TEST_CHANNEL, RESEARCH_QUESTION: QUESTION });
    expect(res.code).toBe(0);
  });
});

// ── Q4：组合矩阵 —— evidence_channel / allowed_root / question 有/无 的 8 种组合 ──

type Quad = [boolean, boolean, boolean];
type QuadExpect = [boolean, boolean, boolean];

// 8 种组合：[evidence, allowed, question] → [含 --question, 含 --evidence-channel, 含 --allowed-root, ...]
const Q4_CASES: Array<[Quad, QuadExpect]> = [
  [[false, false, false], [false, false, false]],
  [[true, false, false], [false, true, false]],
  [[false, true, false], [false, false, true]],
  [[true, true, false], [false, true, true]],
  [[false, false, true], [true, false, false]],
  [[true, false, true], [true, true, false]],
  [[false, true, true], [true, false, true]],
  [[true, true, true], [true, true, true]],
];

describe("Q4: combination matrix — argv carries exactly the right flags in all 8 cases", () => {
  it.each(Q4_CASES)(
    "evidence=%s allowed=%s question=%s ⇒ argv=%s",
    (combo, expected) => {
      const [ev, ar, q] = combo;
      const [expQ, expE, expA] = expected;
      const argv = renderedArgv({
        tick_channel: TEST_CHANNEL,
        max_writes: "64",
        evidence_channel: ev ? "research:v1-test.evidence" : "",
        allowed_root: ar ? "/data/code/self/agent-runtime" : "",
        research_question: q ? QUESTION : "",
      });
      // 恒在项：--run 路径的 channel 与 --max-writes 必须一直在。
      expect(argv).toContain("--max-writes");
      // 有 ⇒ 有；无 ⇒ 无（既不多也不少）。
      expect(argv.includes("--question")).toBe(expQ);
      expect(argv.includes("--evidence-channel")).toBe(expE);
      expect(argv.includes("--allowed-root")).toBe(expA);
      // --question 的值正确（若出现）。
      if (expQ) {
        const idx = argv.indexOf("--question");
        expect(argv[idx + 1]).toBe(QUESTION);
      }
    },
  );
});
