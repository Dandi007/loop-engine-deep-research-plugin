/**
 * C1 —— 声明式部署契约的核心：确定性 preflight（失败即关断）。
 *
 * 只读、确定性、零部署副作用：不部署、不重启、不安装、不发网络、不做 git 变更。
 * 校验内容（spec §3 / §4，逐项前置、任一项失败即 non-zero + 稳定 error_code）：
 *   schema、known application、不可变 commit 格式、artifact/工作目录存在性、
 *   必需环境键存在性、可执行命令可用性、健康命令语法。
 *
 * 成功时输出的单个机器可解析 JSON 含 `commit`（解析出的不可变 commit）与
 * `digest`（声明对象的规范化 sha256），供部署对齐证明使用（见 deploy/README.md §5）。
 */
import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DECLARATION_SCHEMA_VERSION = "application-declaration.v1";
export const REGISTRY_SCHEMA_VERSION = "application-registry.v1";
export const RESULT_SCHEMA_VERSION = "preflight-result.v1";

/** preflight 恒以 phase:"preflight" 输出。 */
export const PREFLIGHT_PHASE = "preflight";
/** 部署动作发生才会出现的 phase 标记；preflight 从不输出它（供无副作用断言）。 */
export const DEPLOY_PHASE = "deploy";

export const ERROR_CODES = [
  "UNKNOWN_APPLICATION",
  "DECLARATION_NOT_FOUND",
  "SCHEMA_INVALID",
  "INVALID_COMMIT_FORMAT",
  "ARTIFACT_NOT_FOUND",
  "WORKING_DIRECTORY_NOT_FOUND",
  "REQUIRED_ENV_MISSING",
  "COMMAND_MALFORMED",
  "COMMAND_UNRESOLVABLE",
  "HEALTH_COMMAND_SYNTAX_INVALID",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/** deploy/ 契约根目录（src/preflight.ts 的上一级为 src，再上一级为仓根）。 */
const CONTRACT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "deploy");
const REPO_ROOT = resolve(CONTRACT_ROOT, "..");

export interface ArtifactPin {
  ref: string;
  commit: string;
}

export interface ApplicationDeclaration {
  schema_version: string;
  application: string;
  artifact: ArtifactPin;
  command: string[];
  working_directory: string;
  required_environment: string[];
  health: { command: string[] };
  rollback: ArtifactPin;
}

export interface ApplicationRegistry {
  schema_version: string;
  applications: Record<string, string>;
}

export interface PreflightResult {
  schema_version: string;
  phase: string;
  status: "PASS" | "FAIL";
  application: string;
  preflight_only: boolean;
  commit?: string;
  digest?: string;
  error_code?: ErrorCode;
  error?: string;
}

const COMMIT_RE = /^[0-9a-f]{40}$/;

/** 40 位小写十六进制 = 合法「不可变 commit」格式。 */
export function isValidCommit(value: string): boolean {
  return COMMIT_RE.test(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((x) => typeof x === "string");
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return isStringArray(value) && value.length > 0 && value.every((x) => x.length > 0);
}

function isArtifactPin(value: unknown): value is ArtifactPin {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const r = value as Record<string, unknown>;
  return typeof r.ref === "string" && typeof r.commit === "string";
}

/**
 * 校验一份声明满足 application-declaration.v1 schema（字段齐全、类型正确）。
 * 不校验 commit 格式（由 preflight 单独做，作为独立的 INVALID_COMMIT_FORMAT 关断码）。
 * 失败抛出带原因的 Error（preflight 捕获后映射为 SCHEMA_INVALID）。
 */
export function validateDeclaration(value: unknown): ApplicationDeclaration {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("declaration must be a JSON object");
  }
  const d = value as Record<string, unknown>;
  if (d.schema_version !== DECLARATION_SCHEMA_VERSION) {
    throw new Error(`schema_version must be "${DECLARATION_SCHEMA_VERSION}"`);
  }
  if (typeof d.application !== "string" || d.application.length === 0) {
    throw new Error("application must be a non-empty string");
  }
  if (!isArtifactPin(d.artifact)) {
    throw new Error("artifact must be an object with string ref/commit");
  }
  if (!isNonEmptyStringArray(d.command)) {
    throw new Error("command must be a non-empty array of non-empty strings");
  }
  if (typeof d.working_directory !== "string" || d.working_directory.length === 0) {
    throw new Error("working_directory must be a non-empty string");
  }
  if (!isStringArray(d.required_environment)) {
    throw new Error("required_environment must be an array of strings");
  }
  if (typeof d.health !== "object" || d.health === null || Array.isArray(d.health)) {
    throw new Error("health must be an object");
  }
  if (!isNonEmptyStringArray((d.health as Record<string, unknown>).command)) {
    throw new Error("health.command must be a non-empty array of non-empty strings");
  }
  if (!isArtifactPin(d.rollback)) {
    throw new Error("rollback must be an object with string ref/commit");
  }
  return d as unknown as ApplicationDeclaration;
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 声明摘要：对象按 key 递归排序后 sha256（`sha256:<64hex>`），与文件空格/逗号无关。 */
export function declarationDigest(decl: ApplicationDeclaration): string {
  return "sha256:" + createHash("sha256").update(JSON.stringify(sortKeys(decl))).digest("hex");
}

/** 相对 ref/工作目录按仓根解析，绝对路径原样返回。 */
function resolveAgainstRepoRoot(p: string): string {
  return isAbsolute(p) ? p : resolve(REPO_ROOT, p);
}

/** 解析可执行文件：含 `/` 视作路径（可执行位），否则查 PATH。 */
function resolveExecutable(prog: string): string | null {
  if (prog.includes("/")) {
    const abs = isAbsolute(prog) ? prog : resolve(REPO_ROOT, prog);
    try {
      fs.accessSync(abs, fs.constants.X_OK);
      return abs;
    } catch {
      return null;
    }
  }
  const pathEnv = process.env.PATH ?? "";
  for (const dir of pathEnv.split(":")) {
    if (dir === "") continue;
    const candidate = join(dir, prog);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* 继续搜下一段 PATH */
    }
  }
  return null;
}

export interface PreflightOptions {
  app: string;
  preflightOnly: boolean;
  /** 注入环境（默认为 process.env；测试可直接喂受控 env）。 */
  env?: NodeJS.ProcessEnv;
  /** 覆盖契约根/仓根（留空用仓库内实际路径）。 */
  contractRoot?: string;
  repoRoot?: string;
}

export interface PreflightOutcome {
  code: number;
  result: PreflightResult;
}

/** 确定性 preflight：载入命名声明并输出单个结构化结果（退出码 0=PASS，非 0=FAIL）。 */
export function runPreflight(opts: PreflightOptions): PreflightOutcome {
  const contractRoot = opts.contractRoot ?? CONTRACT_ROOT;
  const repoRoot = opts.repoRoot ?? resolve(contractRoot, "..");
  const env = opts.env ?? process.env;

  const base: PreflightResult = {
    schema_version: RESULT_SCHEMA_VERSION,
    phase: PREFLIGHT_PHASE,
    status: "FAIL",
    application: opts.app,
    preflight_only: opts.preflightOnly,
  };

  const fail = (errorCode: ErrorCode, error: string): PreflightOutcome => ({
    code: 1,
    result: { ...base, error_code: errorCode, error },
  });

  // 1. 注册表 → known application。
  let registry: ApplicationRegistry;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(join(contractRoot, "applications.json"), "utf8"),
    ) as ApplicationRegistry;
    if (parsed.schema_version !== REGISTRY_SCHEMA_VERSION) {
      return fail(
        "SCHEMA_INVALID",
        `application registry schema_version must be "${REGISTRY_SCHEMA_VERSION}"`,
      );
    }
    if (typeof parsed.applications !== "object" || parsed.applications === null) {
      return fail("SCHEMA_INVALID", "application registry must expose an applications map");
    }
    registry = parsed;
  } catch (err) {
    return fail(
      "SCHEMA_INVALID",
      `application registry is unreadable or not valid JSON: ${(err as Error).message}`,
    );
  }

  const declarationRel = registry.applications[opts.app];
  if (typeof declarationRel !== "string" || declarationRel.length === 0) {
    return fail(
      "UNKNOWN_APPLICATION",
      `unknown application "${opts.app}"; known applications: ${Object.keys(registry.applications).sort().join(", ")}`,
    );
  }

  // 2. 载入声明。
  let decl: ApplicationDeclaration;
  try {
    const raw = fs.readFileSync(join(contractRoot, declarationRel), "utf8");
    decl = validateDeclaration(JSON.parse(raw));
  } catch (err) {
    const detail = (err as Error).message;
    if (detail.includes("ENOENT") || detail.includes("no such file")) {
      return fail("DECLARATION_NOT_FOUND", `declaration not found: ${declarationRel}`);
    }
    return fail("SCHEMA_INVALID", `declaration schema invalid (${declarationRel}): ${detail}`);
  }

  if (decl.application !== opts.app) {
    return fail(
      "SCHEMA_INVALID",
      `declaration application "${decl.application}" does not match requested "${opts.app}"`,
    );
  }

  // 3. 不可变 commit 格式（artifact + rollback）。
  if (!isValidCommit(decl.artifact.commit)) {
    return fail(
      "INVALID_COMMIT_FORMAT",
      `artifact.commit is not a 40-hex-lowercase immutable commit: "${decl.artifact.commit}"`,
    );
  }
  if (!isValidCommit(decl.rollback.commit)) {
    return fail(
      "INVALID_COMMIT_FORMAT",
      `rollback.commit is not a 40-hex-lowercase immutable commit: "${decl.rollback.commit}"`,
    );
  }

  // 4. artifact ref 存在性。
  const artifactPath = resolveAgainstRepoRoot(decl.artifact.ref);
  if (!fs.existsSync(artifactPath)) {
    return fail(
      "ARTIFACT_NOT_FOUND",
      `artifact ref does not resolve to an existing path: "${decl.artifact.ref}" -> ${artifactPath}`,
    );
  }

  // 5. 工作目录存在性。
  const wdPath = resolveAgainstRepoRoot(decl.working_directory);
  if (!fs.existsSync(wdPath)) {
    return fail(
      "WORKING_DIRECTORY_NOT_FOUND",
      `working_directory does not resolve to an existing path: "${decl.working_directory}" -> ${wdPath}`,
    );
  }

  // 6. command 语法（空已在 schema 捕获，此处保险）。
  if (decl.command.length === 0 || decl.command.some((c) => c.length === 0)) {
    return fail("COMMAND_MALFORMED", "command is empty or contains an empty argv element");
  }

  // 7. 可执行命令可用性。
  if (resolveExecutable(decl.command[0]) === null) {
    return fail(
      "COMMAND_UNRESOLVABLE",
      `command executable is not available on PATH: "${decl.command[0]}"`,
    );
  }

  // 8. 健康命令语法。
  if (decl.health.command.length === 0 || decl.health.command.some((c) => c.length === 0)) {
    return fail("HEALTH_COMMAND_SYNTAX_INVALID", "health.command is empty or has an empty element");
  }

  // 9. 必需环境键存在且非空。
  const missing: string[] = [];
  for (const key of decl.required_environment) {
    const value = env[key];
    if (value === undefined || value === "") missing.push(key);
  }
  if (missing.length > 0) {
    return fail(
      "REQUIRED_ENV_MISSING",
      `required environment key(s) missing or empty: ${missing.join(", ")}`,
    );
  }

  return {
    code: 0,
    result: {
      ...base,
      status: "PASS",
      commit: decl.artifact.commit,
      digest: declarationDigest(decl),
    },
  };
}