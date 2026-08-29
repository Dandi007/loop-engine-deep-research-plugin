/**
 * C1 —— 声明式部署契约 + 确定性 preflight（spec §3–§7 硬验收）。
 *
 * 硬验收（spec §6）：
 *  - GREEN：deep-research --preflight-only 退出码 0，输出 status=PASS、
 *           application=deep-research、冻结的解析 commit、摘要 digest。
 *  - RED  ：去掉一个 required_environment 键 ⇒ 退出码非零，输出 status=FAIL、
 *           error_code=REQUIRED_ENV_MISSING，且不含部署副作用标记（无 phase:"deploy" / effects）。
 *
 * ⛔ 本测试通过**真实入口**（vite-node 跑 src/preflight-entry.ts 子进程）驱动，捕获
 *    原始 stdout/stderr 并写入 test/fixtures/preflight/ 作为验收证据（spec §6），
 *    绝不 mock 掉 runner 入口。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { validateDeclaration, DECLARATION_SCHEMA_VERSION } from "../src/preflight";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VITE_NODE = join(ROOT, "node_modules", ".bin", "vite-node");
const ENTRY = join(ROOT, "src", "preflight-entry.ts");
const DECL_DIR = join(ROOT, "deploy", "declarations");
const FIX_DIR = join(ROOT, "test", "fixtures", "preflight");

/** 与 deploy/declarations/deep-research.json 的 required_environment 保持一致。 */
const DEEP_RESEARCH_REQUIRED_ENV = [
  "TICK_CHANNEL",
  "EVIDENCE_CHANNEL",
  "ALLOWED_ROOT",
  "CONTENT_SPOOL_ROOT",
  "MAX_WRITES",
  "RESEARCH_QUESTION",
  "DOC_CHANNEL",
  "RESEARCH_ORIGIN",
  "ANCHOR_CHECK_BIN",
  "EXPORT_ROOT",
];

function readDeclaration(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(DECL_DIR, `${name}.json`), "utf8")) as Record<string, unknown>;
}

function runCli(env: NodeJS.ProcessEnv): { code: number; stdout: string; stderr: string } {
  try {
    const stdout = execFileSync(
      VITE_NODE,
      [ENTRY, "--app", "deep-research", "--preflight-only"],
      { cwd: ROOT, encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] },
    );
    return { code: 0, stdout, stderr: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: err.status ?? -1,
      stdout: String(err.stdout ?? ""),
      stderr: String(err.stderr ?? ""),
    };
  }
}

function greenEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const k of DEEP_RESEARCH_REQUIRED_ENV) env[k] = `cc-preflight-${k}`;
  return env;
}

function redEnv(): NodeJS.ProcessEnv {
  const env = greenEnv();
  delete env.TICK_CHANNEL;
  return env;
}

function preserveFixture(name: string, stdout: string, stderr: string): void {
  mkdirSync(FIX_DIR, { recursive: true });
  writeFileSync(join(FIX_DIR, `${name}.stdout.txt`), stdout);
  writeFileSync(join(FIX_DIR, `${name}.stderr.txt`), stderr);
}

// ── 契约形状：两声明 schema 合法 ─────────────────────────────────────

describe("C1: both declarations are schema-valid instances of application-declaration.v1", () => {
  it("deep-research declaration validates", () => {
    const decl = validateDeclaration(readDeclaration("deep-research"));
    expect(decl.schema_version).toBe(DECLARATION_SCHEMA_VERSION);
    expect(decl.application).toBe("deep-research");
    expect(decl.artifact.ref).toBeTruthy();
    expect(decl.artifact.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(decl.rollback.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(decl.command.length).toBeGreaterThan(0);
    expect(decl.required_environment.length).toBeGreaterThan(0);
  });

  it("chatgroup-daemon declaration validates (declaration-only, runtime not required)", () => {
    const decl = validateDeclaration(readDeclaration("chatgroup-daemon"));
    expect(decl.schema_version).toBe(DECLARATION_SCHEMA_VERSION);
    expect(decl.application).toBe("chatgroup-daemon");
    expect(decl.artifact.commit).toMatch(/^[0-9a-f]{40}$/);
  });
});

// ── GREEN：真实入口 + 原始 stdout/stderr 证据 ────────────────────────

describe("C1 GREEN: deep-research --preflight-only exits 0 and emits PASS + commit + digest", () => {
  const res = runCli(greenEnv());
  preserveFixture("green-deep-research", res.stdout, res.stderr);

  it("exits 0", () => {
    expect(res.code).toBe(0);
  });

  it("emits a single machine-parseable JSON on stdout, nothing on stderr", () => {
    expect(res.stderr).toBe("");
    expect(() => JSON.parse(res.stdout)).not.toThrow();
  });

  it("emits status=PASS + application=deep-research + preflight phase", () => {
    const doc = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(doc.status).toBe("PASS");
    expect(doc.application).toBe("deep-research");
    expect(doc.phase).toBe("preflight");
    expect(doc.schema_version).toBe("preflight-result.v1");
    expect(doc.preflight_only).toBe(true);
  });

  it("emits the frozen resolved commit equal to the declaration artifact.commit", () => {
    const doc = JSON.parse(res.stdout) as Record<string, unknown>;
    const declaration = readDeclaration("deep-research");
    expect(doc.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(doc.commit).toBe((declaration.artifact as { commit: string }).commit);
  });

  it("emits a stable declaration digest", () => {
    const doc = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(doc.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it("contains no deployment-side-effect marker (no phase:deploy / effects)", () => {
    expect(res.stdout).not.toContain('"phase": "deploy"');
    expect(res.stdout).not.toContain('"effects"');
  });
});

// ── RED：真实入口 + 原始 stdout/stderr 证据 ─────────────────────────

describe("C1 RED: missing required environment key fails closed with REQUIRED_ENV_MISSING", () => {
  const res = runCli(redEnv());
  preserveFixture("red-missing-env", res.stdout, res.stderr);

  it("exits nonzero", () => {
    expect(res.code).not.toBe(0);
  });

  it("emits status=FAIL + error_code=REQUIRED_ENV_MISSING on stdout", () => {
    const doc = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(doc.status).toBe("FAIL");
    expect(doc.error_code).toBe("REQUIRED_ENV_MISSING");
    expect(doc.phase).toBe("preflight");
  });

  it("names the missing key", () => {
    const doc = JSON.parse(res.stdout) as Record<string, unknown>;
    expect(String(doc.error)).toContain("TICK_CHANNEL");
  });

  it("contains no deployment-side-effect marker (no phase:deploy / effects)", () => {
    expect(res.stdout).not.toContain('"phase": "deploy"');
    expect(res.stdout).not.toContain('"effects"');
  });

  it("preserved raw fixture does not silently degrade to a green run", () => {
    const fixture = readFileSync(join(FIX_DIR, "red-missing-env.stdout.txt"), "utf8");
    expect(fixture).toContain('"status": "FAIL"');
    expect(fixture).toContain('"error_code": "REQUIRED_ENV_MISSING"');
  });
});

// ── fail-closed：未知应用 ───────────────────────────────────────────

describe("C1 fail-closed: unknown application exits nonzero with UNKNOWN_APPLICATION", () => {
  it("--app does-not-exist ⇒ exit nonzero + error_code=UNKNOWN_APPLICATION", () => {
    let code = 0;
    let stdout = "";
    let stderr = "";
    try {
      const out = execFileSync(VITE_NODE, [ENTRY, "--app", "does-not-exist"], {
        cwd: ROOT,
        encoding: "utf8",
        env: greenEnv(),
        stdio: ["ignore", "pipe", "pipe"],
      });
      stdout = out;
    } catch (e) {
      const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
      code = err.status ?? -1;
      stdout = String(err.stdout ?? "");
      stderr = String(err.stderr ?? "");
    }
    expect(code).not.toBe(0);
    expect(stderr).toBe("");
    const doc = JSON.parse(stdout) as Record<string, unknown>;
    expect(doc.status).toBe("FAIL");
    expect(doc.error_code).toBe("UNKNOWN_APPLICATION");
  });
});