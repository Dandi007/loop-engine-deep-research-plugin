/**
 * D1 —— 部署固化：把「靠手工 env 搀扶」变成受版本管理的部署配置（spec §1 / §2 E1–E7）。
 *
 * 覆盖（spec §2 硬验收）：
 *  - E1  TICK_CHANNEL 无 profile 且无显式 env ⇒ 响亮失败拒绝启动；有 profile ⇒ 正常渲染。
 *  - E2  `research:p02-smoke-1dce60` 从 bin/ 与 src/ 消失（grep 零命中）。
 *  - E3  只设 DEPLOY_PROFILE 的子环境跑 --dry-run，渲染出的 tick input 四项全等于 profile 值，
 *        且自证子环境不含那些 env（照 G1 的 D1b 写法）。
 *  - E4  加载优先级：显式 env > profile > 内置缺省，三层各一例。
 *  - E5  EVIDENCE_CHANNEL 仍「无默认 + 响亮失败」，本包不给它编缺省。
 *  - E6  导出落点走配置、源码不硬编码 vault 路径；导出件含 source_message_id 与终态标记。
 *  - E7  docs/deploy.md 四步齐全，第 3 步是「用例数 > 0 且全绿」而不是只看 exit 0。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { deriveExportPath, renderExportContent } from "../src/export";
import type { ExportInput } from "../src/export";
import type { DocV2 } from "../src/protocol";
import { renderReportBody } from "../src/generate";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const BIN = join(ROOT, "bin", "deep-research-loop.sh");
const PROFILES_DIR = join(ROOT, "profiles", "deploy");
const RELEVANT_ENV = ["TICK_CHANNEL", "EVIDENCE_CHANNEL", "ALLOWED_ROOT", "MAX_WRITES"];

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

function report(body: string): DocV2 {
  return { doc_kind: "report", digest: "rep-1", body, origin: "research-1" };
}

function exportInput(): ExportInput {
  return {
    report: report(renderReportBody({ stop: "capped", blocked: 12, capHit: true })),
    sourceMessageId: "msg_report_d1",
    createdAt: "2026-03-15T10:00:00Z",
    topic: "光伏并网 谐波治理",
  };
}

// ── E1：TICK_CHANNEL 不再回落 smoke channel ──────────────────────────

describe("E1: TICK_CHANNEL default is a loud failure, not the smoke channel", () => {
  it("no profile and no explicit TICK_CHANNEL ⇒ non-zero exit naming TICK_CHANNEL", () => {
    const childEnv = cleanChildEnv();
    // ⛔ 自证子环境确实没有相关 env（否则本用例毫无判别力）。
    expect(childEnv).not.toHaveProperty("TICK_CHANNEL");
    expect(childEnv).not.toHaveProperty("DEPLOY_PROFILE");
    const res = render(childEnv);
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/TICK_CHANNEL/);
    expect(res.err).toMatch(/Refusing/i);
  });

  it("with a profile ⇒ renders normally (exit 0, valid YAML)", () => {
    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = "production";
    const res = render(childEnv);
    expect(res.code).toBe(0);
    const input = tickInput(res.out);
    expect(input.tick_channel).toBe(readProfile("production").TICK_CHANNEL);
  });

  it("--profile with a missing operand fails loudly instead of degrading silently", () => {
    const childEnv = cleanChildEnv();
    let res: { code: number; out: string; err: string };
    try {
      const out = execFileSync("bash", [BIN, "--dry-run", "--profile"], {
        cwd: ROOT,
        encoding: "utf8",
        env: childEnv,
        stdio: ["ignore", "pipe", "pipe"],
      });
      res = { code: 0, out, err: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
      res = { code: err.status ?? -1, out: String(err.stdout ?? ""), err: String(err.stderr ?? "") };
    }
    expect(res.code).not.toBe(0);
    expect(res.err).toMatch(/--profile/);
  });
});

// ── E2：smoke channel 字面从生产路径消失 ─────────────────────────────

describe("E2: research:p02-smoke-1dce60 absent from bin/ and src/", () => {
  it("grep-equivalent: no file under bin/ or src/ contains the literal", () => {
    const scan = (dir: string) =>
      readdirSync(dir).map((f) => join(dir, f)).filter((p) => !statSync(p).isDirectory());
    const files = [...scan(join(ROOT, "bin")), ...scan(join(ROOT, "src"))];
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      expect(readFileSync(f, "utf8")).not.toContain("research:p02-smoke-1dce60");
    }
  });
});

// ── E3：从 profile 出发的端到端渲染断言 ───────────────────────────────

describe("E3: from profile, dry-run renders all four input fields equal to profile values", () => {
  it("only DEPLOY_PROFILE set (child env proven free of the four env) ⇒ all four equal profile", () => {
    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = "production";
    // ⛔ 照 G1 D1b：自证子环境里没有那些 env，否则会重蹈「声称删了、实际没删 ⇒ 恒绿」。
    for (const k of RELEVANT_ENV) {
      expect(childEnv).not.toHaveProperty(k);
    }
    const res = render(childEnv);
    expect(res.code).toBe(0);
    const input = tickInput(res.out);
    const prof = readProfile("production");
    expect(input.tick_channel).toBe(prof.TICK_CHANNEL);
    expect(input.evidence_channel).toBe(prof.EVIDENCE_CHANNEL);
    expect(input.allowed_root).toBe(prof.ALLOWED_ROOT);
    expect(input.max_writes).toBe(Number(prof.MAX_WRITES));
  });
});

// ── E4：加载优先级（显式 env > profile > 内置缺省）──────────────────

describe("E4: precedence explicit env > profile > built-in default", () => {
  it("explicit env beats profile", () => {
    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = "production";
    childEnv.TICK_CHANNEL = "research:explicit-wins.index";
    const input = tickInput(render(childEnv).out);
    expect(input.tick_channel).toBe("research:explicit-wins.index");
  });

  it("profile beats built-in default", () => {
    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = "production";
    const input = tickInput(render(childEnv).out);
    expect(input.tick_channel).toBe(readProfile("production").TICK_CHANNEL);
  });

  it("built-in default used when neither profile nor explicit env supplies the value", () => {
    const childEnv = cleanChildEnv();
    // TICK_CHANNEL 是渲染硬前提（无默认、响亮失败），必须显式给；MAX_WRITES 则无显式值，
    // 演示「内置缺省」层：不设 profile 也不设 MAX_WRITES ⇒ 内置缺省 64 直达渲染。
    childEnv.TICK_CHANNEL = "research:v1-test.index";
    const input = tickInput(render(childEnv).out);
    expect(input.max_writes).toBe(64);
  });
});

// ── E5：EVIDENCE_CHANNEL 仍「无默认 + 响亮失败」──────────────────────

describe("E5: EVIDENCE_CHANNEL keeps no default; downstream loud failure preserved", () => {
  it("script still exports EVIDENCE_CHANNEL with an empty default (no invented value)", () => {
    const src = readFileSync(BIN, "utf8");
    expect(src).toMatch(/export\s+EVIDENCE_CHANNEL="\$\{EVIDENCE_CHANNEL:-\}"/);
  });

  it("profile without EVIDENCE_CHANNEL renders evidence_channel empty (not fabricated)", () => {
    const childEnv = cleanChildEnv();
    childEnv.DEPLOY_PROFILE = "local";
    expect(readProfile("local")).not.toHaveProperty("EVIDENCE_CHANNEL");
    const res = render(childEnv);
    expect(res.code).toBe(0);
    const input = tickInput(res.out);
    expect(input.evidence_channel ?? "").toBe("");
  });

  it("downstream loud failure for a missing evidence channel is preserved", () => {
    const src = readFileSync(join(ROOT, "src", "tick-run.ts"), "utf8");
    expect(src).toMatch(/MissingEvidenceChannelError/);
  });
});

// ── E6：导出落点走配置；导出件含 source_message_id 与终态标记 ────────

describe("E6: export root is config-driven; content carries source_message_id + terminal marker", () => {
  it("profile carries an export root and export.ts is parameterized (no hardcoded vault path)", () => {
    const prof = readProfile("production");
    expect(prof.EXPORT_ROOT).toBeTruthy();
    const src = readFileSync(join(ROOT, "src", "export.ts"), "utf8");
    // 落点根是参数（vaultRoot），不是源码里写死的绝对路径。
    expect(src).toMatch(/vaultRoot/);
    expect(src).not.toMatch(/\/data\//);
    const path = deriveExportPath(exportInput(), prof.EXPORT_ROOT);
    // ⛔ 反双嵌套：EXPORT_ROOT 必须是 vault 根（不含 DeepThought 段）。若 profile 写成
    //   …/DeepThought，deriveExportPath 再追加 'DeepThought/' ⇒ 双重嵌套；此断言能抓住它。
    expect(prof.EXPORT_ROOT).not.toMatch(/DeepThought\s*$/);
    const slug = exportInput().topic.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-").replace(/^-+|-+$/g, "");
    const date = exportInput().createdAt.slice(0, 10);
    expect(path).toBe(`${prof.EXPORT_ROOT}/DeepThought/${slug}/${date}-${slug}.md`);
  });

  it("export content carries source_message_id and the terminal marker", () => {
    const content = renderExportContent(exportInput());
    expect(content).toContain("msg_report_d1");
    expect(content).toMatch(/stop=capped/);
    expect(content).toMatch(/capHit=true/);
  });
});

// ── E7：docs/deploy.md 四步齐全，第 3 步是「用例数 > 0 且全绿」──────

describe("E7: docs/deploy.md documents 4 deploy steps with verifiable checks", () => {
  it("has the four steps: git pull / npm ci / npm test / --dry-run", () => {
    const md = readFileSync(join(ROOT, "docs", "deploy.md"), "utf8");
    expect(md).toMatch(/git pull/);
    expect(md).toMatch(/npm ci/);
    expect(md).toMatch(/npm test/);
    expect(md).toMatch(/--dry-run/);
  });

  it("step 3 asserts collected test count > 0 AND all green, not just exit 0", () => {
    const md = readFileSync(join(ROOT, "docs", "deploy.md"), "utf8");
    expect(md).toMatch(/用例数/);
    expect(md).toMatch(/>\s*0/);
    expect(md).toMatch(/全绿/);
  });
});
