/**
 * G12 —— deploy profile 最后一个键被生产加载器静默丢弃。
 *
 * 覆盖（spec §2 硬验收）：
 *  - Z1  判别性：无结尾换行的临时 profile，其最后一行是某个键，加载后该键有值。
 *  - Z2  含空格且无引号的值不被破坏：RESEARCH_QUESTION=agent harness ⇒ 值逐字为 agent harness。
 *  - Z3  显式 env 优先语义不变：已显式设置的键不被 profile 覆盖。
 *  - Z4  断言打在真实加载路径上：直接执行 bin/deep-research-loop.sh --dry-run --profile <临时 profile>。
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "deep-research-loop.sh");
const PROFILES_DIR = join(ROOT, "profiles", "deploy");

const RELEVANT_ENV = ["TICK_CHANNEL", "EVIDENCE_CHANNEL", "ALLOWED_ROOT", "MAX_WRITES", "RESEARCH_QUESTION"];

function readProfile(name: string): Record<string, string> {
  const text = readFileSync(join(PROFILES_DIR, `${name}.env`), "utf8");
  const rec: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_]+)=(.*)$/);
    if (m) rec[m[1]] = m[2];
  }
  return rec;
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

function cleanChildEnv(): NodeJS.ProcessEnv {
  const childEnv = { ...process.env };
  for (const k of [...RELEVANT_ENV, "DEPLOY_PROFILE", "EXPORT_ROOT"]) delete childEnv[k];
  return childEnv;
}

// ── Z1：判别性 —— 无结尾换行的临时 profile，最后一行是某个键，加载后该键有值 ──

describe("Z1: last-line key in a profile without trailing newline is loaded", () => {
  const TEMP_PROFILE = "g12-test-no-newline";
  const TEMP_PATH = join(PROFILES_DIR, `${TEMP_PROFILE}.env`);
  const LAST_LINE_CHANNEL = "research:g12-test-last-line.index";

  beforeAll(() => {
    const content = [
      "RESEARCH_QUESTION=g12 test question",
      `TICK_CHANNEL=${LAST_LINE_CHANNEL}`
    ].join("\n");
    writeFileSync(TEMP_PATH, content, "utf8");
  });

  afterAll(() => {
    unlinkSync(TEMP_PATH);
  });

  it("profile without trailing newline: last-line key TICK_CHANNEL is loaded", () => {
    const raw = readFileSync(TEMP_PATH, "utf8");
    expect(raw.endsWith("\n")).toBe(false);

    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = TEMP_PROFILE;
    for (const k of RELEVANT_ENV) {
      expect(childEnv).not.toHaveProperty(k);
    }
    const res = render(childEnv);
    expect(res.code).toBe(0);
    const input = tickInput(res.out);
    expect(input.tick_channel).toBe(LAST_LINE_CHANNEL);
  });
});

// ── Z2：含空格且无引号的值不被破坏 ──

describe("Z2: space-containing unquoted value is preserved verbatim", () => {
  it("RESEARCH_QUESTION=agent harness renders as 'agent harness' (no quotes, no truncation)", () => {
    const prof = readProfile("agent-harness");
    expect(prof.RESEARCH_QUESTION).toBe("agent harness");

    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = "agent-harness";
    const input = tickInput(render(childEnv).out);
    expect(input.research_question).toBe("agent harness");
  });
});

// ── Z3：显式 env 优先语义不变 ──

describe("Z3: explicit env precedence over profile is preserved", () => {
  it("explicit TICK_CHANNEL beats profile value", () => {
    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = "agent-harness";
    childEnv.TICK_CHANNEL = "research:explicit-override.index";
    const input = tickInput(render(childEnv).out);
    expect(input.tick_channel).toBe("research:explicit-override.index");
  });

  it("without explicit env, profile value is used", () => {
    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = "agent-harness";
    const input = tickInput(render(childEnv).out);
    const prof = readProfile("agent-harness");
    expect(input.tick_channel).toBe(prof.TICK_CHANNEL);
  });
});