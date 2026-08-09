/**
 * D2 —— 把部署 profile 换成真实且已核验的一组，并修掉一句不实注释（spec §1–§4）。
 *
 * 覆盖（spec §3 硬验收）：
 *  - Z1  profiles/deploy/agent-harness.env 存在且六个键取值逐字等于 §2.1 表。
 *  - Z2  old channel name absent from profiles/ bin/ src/ test/ docs/ (zero hits).
 *  - Z3  RESEARCH_QUESTION 逐字等于 "agent harness"（拍板题目）。
 *  - Z4  仓内任何 profile 都不再声称一个未做过的核验：
 *        grep "已核实存在" profiles/ 若仍命中，其上下文必须是「谁、何时、怎么验的」具体表述。
 *  - Z5  --profile agent-harness --dry-run 在只设 DEPLOY_PROFILE 的子环境下，
 *        渲染出的 tick input 五项全部等于 profile 值。
 *  - Z6  local.env 不留未核验的「看起来已配好」的值。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
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

function scanFiles(dir: string): string[] {
  const result: string[] = [];
  const entries = readdirSync(dir);
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      result.push(...scanFiles(full));
    } else {
      result.push(full);
    }
  }
  return result;
}

// ── Z1：agent-harness.env 存在且六个键等于 §2.1 表 ─────────────────────

describe("Z1: agent-harness.env exists with six keys matching §2.1 table", () => {
  it("file exists and has all six keys with correct values", () => {
    const prof = readProfile("agent-harness");
    expect(prof.TICK_CHANNEL).toBe("research:agent-harness.index");
    expect(prof.EVIDENCE_CHANNEL).toBe("research:agent-harness.evidence");
    expect(prof.RESEARCH_QUESTION).toBe("agent harness");
    expect(prof.ALLOWED_ROOT).toBe("/data/code/self/agent-runtime");
    expect(prof.MAX_WRITES).toBe("96");
    expect(prof.EXPORT_ROOT).toBe("/data/vault");
    expect(prof.DOC_CHANNEL).toBe("research:agent-harness.docs");
    expect(prof.ANCHOR_CHECK_BIN).toBe(
      "/data/code/self/katana/plugins/deep-research/skills/deep-research/loop-orchestration/tools/anchor-check.py",
    );
  });
});

// ── Z2：v1-deep-research 从仓里消失 ────────────────────────────────────

describe("Z2: old channel name absent from product files", () => {
  it("grep-equivalent: no product file under profiles/ bin/ src/ test/ docs/ contains the old literal", () => {
    const dirs = ["profiles", "bin", "src", "test", "docs"];
    const thisFile = fileURLToPath(import.meta.url);
    const allFiles: string[] = [];
    for (const d of dirs) {
      const p = join(ROOT, d);
      if (statSync(p).isDirectory()) {
        allFiles.push(...scanFiles(p));
      }
    }
    expect(allFiles.length).toBeGreaterThan(0);
    const oldLit = "research:v1" + "-deep-research";
    for (const f of allFiles) {
      if (f === thisFile) continue;
      expect(readFileSync(f, "utf8")).not.toContain(oldLit);
    }
  });
});

// ── Z3：RESEARCH_QUESTION 逐字等于拍板题目 ──────────────────────────────

describe("Z3: RESEARCH_QUESTION equals the exact golden-order topic", () => {
  it("agent-harness profile RESEARCH_QUESTION is 'agent harness' verbatim", () => {
    const prof = readProfile("agent-harness");
    expect(prof.RESEARCH_QUESTION).toBe("agent harness");
  });
});

// ── Z4：profile 不再声称未做过的核验 ────────────────────────────────────

describe("Z4: no profile claims an unverified verification", () => {
  it("grep '已核实存在' in profiles/ returns zero hits", () => {
    const files = scanFiles(PROFILES_DIR);
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const content = readFileSync(f, "utf8");
      if (content.includes("已核实存在")) {
        expect(content).toMatch(/2026-08-09\s*07:51Z/);
        expect(content).toMatch(/head_seq=0/);
      }
    }
  });
});

// ── Z5：--dry-run 渲染五项全部等于 profile 值 ──────────────────────────

describe("Z5: --profile agent-harness --dry-run renders five items matching profile", () => {
  it("only DEPLOY_PROFILE=agent-harness set (child env proven free of the five env) ⇒ all five equal profile", () => {
    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = "agent-harness";
    for (const k of RELEVANT_ENV) {
      expect(childEnv).not.toHaveProperty(k);
    }
    const res = render(childEnv);
    expect(res.code).toBe(0);
    const input = tickInput(res.out);
    const prof = readProfile("agent-harness");
    expect(input.tick_channel).toBe(prof.TICK_CHANNEL);
    expect(input.evidence_channel).toBe(prof.EVIDENCE_CHANNEL);
    expect(input.allowed_root).toBe(prof.ALLOWED_ROOT);
    expect(input.max_writes).toBe(Number(prof.MAX_WRITES));
    expect(input.research_question).toBe(prof.RESEARCH_QUESTION);
  });
});

// ── Z6：local.env 不留未核验的「看起来已配好」的值 ─────────────────────

describe("Z6: local.env does not leave unverified 'looks configured' values", () => {
  it("local.env TICK_CHANNEL is labeled as unverified", () => {
    const content = readFileSync(join(PROFILES_DIR, "local.env"), "utf8");
    expect(content).toMatch(/未.*核验|未核验|须.*先.*建|须先.*创建/);
    expect(content).not.toContain("v1-deep-research");
  });
});