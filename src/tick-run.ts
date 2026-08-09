/**
 * A8b/A8c —— tick 写侧执行：CAS 认领 / 回收 + spawn（接线判别）
 *
 * 对已交付的 Decision 执行写动作（spec §1.2 / §3.2 第 2–3 步）：
 *   reclaim  → CAS 该卡到目标 status（open / explored / blocked）
 *   dispatch → CAS open → in_flight，把 `run_id` 写进卡（M7），CAS 成功后按 role 真正 spawn（A8c）
 *   block    → CAS 到 blocked（invalid_sources / web_unimplemented / unmapped_source）
 *
 * ⛔ 先 CAS 成功才算认领；CAS 失败（409）跳过该卡且不 spawn（M8 / N4）。
 * ⛔ spawn 同步失败 ⇒ 当场 CAS 回 open（S2 补偿，N5）。
 * ⛔ 写入不可回退：`--max-writes` 默认 DEFAULT_MAX_WRITES（A10c 起足以收割一张真实卡），超限立即停止并响亮报错（M10）；
 *    spawn 本身不写 bus、不计入预算，但每次 spawn 前的 CAS 计入（spec §2）。
 * ⛔ 只对显式传入的 channel 操作（M11）；拒绝写 v1 冻结 channel（M12）。
 * ⛔ CAS 一律走 A8b 的 `realCas`，不得绕过另写 CAS（spec §4.1 纪律 8）。
 */
import { randomUUID } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ClueV2 } from "./protocol";
import {
  decideTick,
  decideTermination,
  hasPendingWork,
  DEFAULT_TICK_CONFIG,
  type BoardState,
  type CasDecision,
  type Decision,
  type TerminationInput,
  type TerminationState,
} from "./tick";
import {
  assembleBoard,
  buildRunsFromMessages,
  findWorkerResult,
  readChannelMessages,
  type InspectMessage,
} from "./tick-inspect";
import {
  harvestCard,
  MissingEvidenceChannelError,
  type HarvestDeps,
  type HarvestReport,
} from "./harvest";
import { casUpdateClue, getEntity, publishClue, publishEvidence } from "./bus";

/**
 * --max-writes 默认值。⛔ A10c §1.1——缺省值必须**足以收割一张真实卡**（真实 worker 产出
 * 实测 6~10 条 evidence，加上新 clue 与最终 CAS）。真实产出量 > 旧默认 5 ⇒ 卡永远收割不了、
 * 恒 max_rounds 死锁，这是本包根因。取 64：明显高于单张真实卡的 needed，仍是**有限**护栏
 * （非无穷大），绝不因 D1 而放开成不限。
 */
export const DEFAULT_MAX_WRITES = 64;

/** v1 冻结只读 channel 前缀（spec §2 / §8：不得触碰）。 */
export const FROZEN_CHANNEL_PATTERNS = [
  /^research:loop-mcp-semantics\./,
  /^research:smoke-bus-semantics\./,
] as const;

export function isFrozenChannel(channelId: string): boolean {
  return FROZEN_CHANNEL_PATTERNS.some((re) => re.test(channelId));
}

/** A8f——`code-local` role：唯一需要 `allowed_root` 的 worker（spec §1.2）。 */
export const CODE_LOCAL_ROLE = "dr-worker-code-local";

/** G2b —— triage role（agent-runtime 已交付 `dr-triage`）。 */
export const TRIAGE_ROLE = "dr-triage";

/** G2b —— `dr-triage.result.v1` 的 action 值域（§2.3(a)）。 */
export const TRIAGE_ACTIONS = ["keep", "drop"] as const;

/**
 * G2b —— 板面快照语料（形状对齐 agent-runtime `profiles/roles/schemas/triage-input.v1.json`）。
 * `question` / `proposed_clues` 必填；`explored_summaries` 可选。
 */
export interface TriageCorpus {
  question: string;
  proposed_clues: Array<{
    clue_id: string;
    clue_text: string;
    depth?: number;
    sources?: string[];
  }>;
  explored_summaries?: string[];
}

/** G2b —— `dr-triage.result.v1` 的一条决策（`{clue_id, action, rationale}`）。 */
export interface TriageResultDecision {
  clue_id: string;
  action: "keep" | "drop";
  rationale: string;
}

/** G2b —— 一次 triage 的收割报告（整批预算跳过的判别点 / 校验拒绝计数）。 */
export interface TriageReport {
  runId: string;
  /** 是否因 `--max-writes` 预算不足而整批跳过（§2.4：不做半批）。 */
  budgetSkipped: boolean;
  /** 被响亮拒绝的非法 action 条数（§2.3(a)：不当 keep 也不当 drop）。 */
  invalidActions: number;
  /** 被丢弃并响亮记录的越界 clue_id 条数（§2.3(b)：不改任何卡）。 */
  outOfScopeDropped: number;
  /** 实际执行的 CAS 数。 */
  casCount: number;
  /** 实际发出的 CAS 结果（budget 跳过时为空）。 */
  casResults: { clueId: string; to: ClueV2["status"]; success: boolean; error?: CasDecision["error"] }[];
}

/**
 * G2b §1.1 —— 把 triage 语料序列化为位置参数字符串。
 * agent-run 的 prompt 只由 persona + 位置参数构成，`--input` 只作 schema 守卫、从不注入 prompt。
 * ⇒ 板面快照必须放进位置参数，否则 role 交回空结果（照 G2a `serializeCorpusToPositional` 形状）。
 */
export function serializeTriageCorpusToPositional(corpus: TriageCorpus): string {
  return JSON.stringify(corpus);
}

/**
 * G2b §1.1 —— 构造真实 triage agent-run 的完整 argv：
 * `agent-run --role dr-triage --run-id <id> --input <file> -- "<serialized board snapshot>"`
 * 快照序列化后放在 `--` 之后的位置参数（T1 判别点：⛔ 只断言 `--input` 存在不算数）。
 */
export function buildTriageArgv(opts: {
  agentRunBin: string;
  runId: string;
  inputPath: string;
  corpus: TriageCorpus;
}): string[] {
  return [
    opts.agentRunBin,
    "--role",
    TRIAGE_ROLE,
    "--run-id",
    opts.runId,
    "--input",
    opts.inputPath,
    "--",
    serializeTriageCorpusToPositional(opts.corpus),
  ];
}

/**
 * G2b §1.1 —— 把 triage 语料写成 `--input` 载荷文件。
 * `--input` 只作 schema 守卫（校验完就扔、从不注入 prompt），⛔ 语料正文必须走位置参数。
 */
export function writeTriageInputFile(corpus: TriageCorpus): string {
  const file = join(tmpdir(), `g2b-triage-input-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(corpus));
  return file;
}

/** G2b §1.3 / T7 —— triage 派发所需的运行时（agent-run 定位 / spawn / 结果回读）。 */
export interface TriageSpawnRuntime {
  agentRunBin: string;
  runId: string;
  /** 写 `--input` 载荷文件；缺省 `writeTriageInputFile`。 */
  writeInputFile?: (corpus: TriageCorpus) => string;
  /**
   * 真实 spawn；测试注入假 agent-run 记录 argv。
   * ⛔ **必填**：任何 triage 派发都必须真正启动子进程（评审 major）。
   *    缺省/缺失即响亮失败，绝不静默构建 argv 后丢弃、返回一个从未启动的假成功。
   */
  spawnProcess: (argv: string[], env: Record<string, string>) => Promise<{ pid?: number }>;
  /** 从 worker 结果读回 `dr-triage.result.v1` 的决策列表。 */
  readResult: (runId: string) => Promise<TriageResultDecision[]>;
}

/**
 * G2b §1.1 —— 生产默认 triage 派发（照 G2a `spawnGenerateRole` 形状）：
 * 语料 → `--input` 载荷文件 → `buildTriageArgv` 把序列化快照放进位置参数 → spawn agent-run。
 * 这是 `buildTriageArgv` 的**唯一生产调用点**，杜绝「快照→argv」成为死代码（T7 判别点）。
 * ⛔ `spawnProcess` 必填且**无条件调用**（§1.3）：缺失即编译/调用期失败，绝不静默丢弃 argv
 *    返回「从未启动」的假成功。载荷文件的寿命绑定到本次派发：读回结果后**随即移除**（§1.3）。
 */
export async function spawnTriageRole(
  corpus: TriageCorpus,
  runtime: TriageSpawnRuntime,
): Promise<TriageResultDecision[]> {
  const inputPath = runtime.writeInputFile
    ? runtime.writeInputFile(corpus)
    : writeTriageInputFile(corpus);
  try {
    const argv = buildTriageArgv({
      agentRunBin: runtime.agentRunBin,
      runId: runtime.runId,
      inputPath,
      corpus,
    });
    // ⛔ 无条件 spawn：runtime 缺 spawnProcess 在类型层即不可通过（必填），杜绝零-spawn 假成功。
    await runtime.spawnProcess(argv, { AGENT_RUN_BIN: runtime.agentRunBin });
    return await runtime.readResult(runtime.runId);
  } finally {
    // 载荷文件用后即删，不泄漏 tmp（§1.3）。
    rmSync(inputPath, { force: true });
  }
}

/**
 * G2b §2.3(b) —— 从已读的 `board:agent-runs` 消息数组里，按 run_id 找该 run 的
 * `dr-triage.result.v1` 决策列表。找不到 ⇒ 返回 null。
 */
export function findTriageResult(
  runId: string,
  messages: InspectMessage[],
): TriageResultDecision[] | null {
  let found: unknown = null;
  for (const msg of messages) {
    if (msg.kind !== "dr-triage.result.v1") continue;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    if (payload.run_id !== runId) continue;
    found = payload;
  }
  if (found === null) return null;
  const decisions = (found as { decisions?: unknown }).decisions;
  return Array.isArray(decisions) ? (decisions as TriageResultDecision[]) : [];
}

/** G2b §2.3(a) —— 非法 action 被响亮拒绝（bus `openSchema()` 会剥掉 enum，bus 拦不住）。 */
export class InvalidTriageActionError extends Error {
  constructor(clueId: string, action: unknown) {
    super(
      `G2b: triage returned invalid action "${String(action)}" for clue "${clueId}" — must be "keep" or "drop". Rejecting this decision loudly (not treating it as keep or drop).`,
    );
    this.name = "InvalidTriageActionError";
  }
}

/** G2b §2.3(b) —— clue_id 越界（不在本轮 proposed 集合）被丢弃并响亮记录（查得到 ≠ 有权改）。 */
export class OutOfScopeTriageClueError extends Error {
  constructor(clueId: string) {
    super(
      `G2b: triage returned clue_id "${clueId}" which is not in this round's proposed set — dropping the decision loudly and refusing to CAS an unowned card.`,
    );
    this.name = "OutOfScopeTriageClueError";
  }
}

/** G2b —— triage 决策存在但 `readQuestion` 未接线 ⇒ 响亮失败（不得用空 question 静默派发）。 */
export class MissingTriageQuestionError extends Error {
  constructor() {
    super(
      "G2b: triage decision present but no question source wired (provide readQuestion / --question). Refusing to dispatch a triage with an empty question.",
    );
    this.name = "MissingTriageQuestionError";
  }
}

/**
 * A8f——一个 dispatch 决策映射到 `dr-worker-code-local` 而 `allowed_root` 未配置 ⇒
 * 当场响亮失败（spec §1.2），⛔ 绝不照常 spawn（那会产出零证据且看起来正常）。
 * 错误文本点名 `allowed-root`。
 */
export class MissingAllowedRootError extends Error {
  constructor(role: string) {
    super(
      `A8f: dispatch mapped to "${role}" requires --allowed-root (the code-local worker reads sources from the repo root). Refusing to spawn a zero-evidence worker.`,
    );
    this.name = "MissingAllowedRootError";
  }
}

/**
 * A8f——在 `allowed_root` 下执行 `git rev-parse HEAD`，取引擎权威的 `revision`（spec §1.3）。
 * ⛔ 失败（非 git 目录等）⇒ 返回 `undefined`（**省略**该可选字段），⛔ **绝不返回空串**
 *   （空串会通过下游「非空」检查，与 A8e 的 `"://@"` 退化 anchor 同族）；
 *   ⛔ 也绝不因 git 失败而阻断派发（`revision` 是可选字段，persona 有 Read 回退路径）。
 * ⛔ 用 `execFileSync` 读退出码（非零即抛），命令后不接管道（spec §6）。
 */
export function resolveRevision(allowedRoot: string): string | undefined {
  try {
    const out = execFileSync(
      "git",
      ["-C", allowedRoot, "rev-parse", "HEAD"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    ).trim();
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** 写入上限已到——响亮报错，非静默截断（M10）。 */
export class MaxWritesExceededError extends Error {
  constructor(maxWrites: number) {
    super(
      `A8b: max-writes exceeded (${maxWrites}). Refusing further irreversible bus writes; stopping immediately.`,
    );
    this.name = "MaxWritesExceededError";
  }
}

/** 对 v1 冻结 channel 写——拒绝且不发出任何请求（M12）。 */
export class FrozenChannelError extends Error {
  constructor(channelId: string) {
    super(
      `A8b: refusing to write to v1 frozen channel "${channelId}" (read-only, spec §2/§8).`,
    );
    this.name = "FrozenChannelError";
  }
}

/** --run 未传 channel——无默认值，必须显式传入（M11）。 */
export class MissingChannelError extends Error {
  constructor() {
    super("A8b: --run requires an explicit <channel_id> (no default channel).");
    this.name = "MissingChannelError";
  }
}

/**
 * G4b —— trigger body 解析失败 / 字段缺失 ⇒ 响亮失败（spec §1.2 / R5）。
 * ⛔ 不得静默回落到 0/0：静默回落 = 计数器被无声重置 = 本缺陷原样复发，而且更难查。
 * body 必须是 JSON 对象，且含数值字段 `coverage` 与 `zeroGrowthRounds`。
 */
export class InvalidTriggerBodyError extends Error {
  constructor(reason: string) {
    super(
      `G4b: invalid trigger body (${reason}). The continuation trigger body must be a JSON object with numeric fields "coverage" and "zeroGrowthRounds". Refusing to silently fall back to 0/0 (that would silently reset the zero-growth counter and resurrect this very defect).`,
    );
    this.name = "InvalidTriggerBodyError";
  }
}

/**
 * G4b —— 解析 trigger body JSON 并提取 prevCoverage / prevZeroGrowthRounds（spec §1.2）。
 * ⛔ body 缺失/非 JSON/字段缺失/字段非数值 ⇒ 抛 `InvalidTriggerBodyError`（响亮失败，R5）。
 * ⛔ 首轮 body 由 bin 写成 `{"seed":true,"coverage":0,"zeroGrowthRounds":0}`，
 *    因此首轮也走显式 0/0，不靠「字段缺失时静默回落」（spec §1.2 明令禁止后者）。
 * 纯函数：供 `runChannelWrite` 与测试复用。
 */
export function parsePrevCounters(triggerBody: string): {
  coverage: number;
  zeroGrowthRounds: number;
} {
  if (triggerBody.length === 0) {
    throw new InvalidTriggerBodyError("empty body");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(triggerBody);
  } catch (e) {
    throw new InvalidTriggerBodyError(`not valid JSON: ${(e as Error).message}`);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new InvalidTriggerBodyError("not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  const coverage = obj.coverage;
  const zeroGrowthRounds = obj.zeroGrowthRounds;
  if (typeof coverage !== "number" || !Number.isFinite(coverage)) {
    throw new InvalidTriggerBodyError(
      `field "coverage" missing or not a finite number (got ${typeof coverage})`,
    );
  }
  if (
    typeof zeroGrowthRounds !== "number" ||
    !Number.isFinite(zeroGrowthRounds)
  ) {
    throw new InvalidTriggerBodyError(
      `field "zeroGrowthRounds" missing or not a finite number (got ${typeof zeroGrowthRounds})`,
    );
  }
  return { coverage, zeroGrowthRounds };
}

/** 一次 CAS 写动作的最小输入。 */
export interface WriteCasInput {
  clueId: string;
  /** 目标 status（CAS 之后要写成的状态）。 */
  to: ClueV2["status"];
  /**
   * 前置条件：CAS 前 head 必须处于的当前 status。
   * ⛔ 决策是在板快照上算的；CAS 前必须用**同一次 head 读**校验该前置条件，
   *    否则若别人已抢先改状态，realCas 会 CAS 掉活 worker 的认领（spec §0 破坏场景）。
   */
  from: ClueV2["status"];
  runId?: string;
  /** block 时写入卡的明确 rationale（spec §1.2 N7：blocked 且 rationale 非空）。 */
  rationale?: string | null;
}

/** 写侧依赖注入面：所有副作用（CAS / spawn）都从这里走。 */
export interface WriteDeps {
  cas(input: WriteCasInput): Promise<CasDecision>;
  /**
   * ⛔ 注入的 spawn dep：CAS 成功后才调用。
   * A8d——签名已加宽（spec §1.3）：除 role/runId 外还携带 worker 输入载荷
   * `deep-research.worker-input/v1`（clue_id / clue_text / depth / sources），
   * 供真实 `agent-run` 的 `--input` 与位置 prompt 使用。
   */
  spawnWorker(
    clueId: string,
    role: string,
    runId: string,
    input: WorkerInputPayload,
  ): Promise<void>;
  /**
   * A8e——收割写依赖（可选）：仅在存在 `harvest` 决策（exited(0)）时使用。
   * 缺省（未接线）⇒ 遇到 harvest 决策时抛 `MissingEvidenceChannelError`（§1.4 / H14）。
   */
  harvest?: HarvestDeps;
  /**
   * G2b —— triage 派发（可选，缺省走生产 `spawnTriageRole`）。
   * 喂入引擎组装的板面快照语料，回收 `dr-triage.result.v1` 决策列表。
   * ⛔ 遇 triage 决策必须**无条件调用**（§1.3 / T7）；缺省经 `triageSpawnRuntime`
   *   （其 `spawnProcess` 必填）。两者都不提供时遇 triage 决策 ⇒ 响亮失败，绝不静默跳过。
   */
  spawnTriage?: (corpus: TriageCorpus) => Promise<TriageResultDecision[]>;
  /** G2b —— 缺省 spawnTriage 的生产运行时（不注入 spawnTriage 时使用）。 */
  triageSpawnRuntime?: TriageSpawnRuntime;
  /**
   * G2b —— 研究主问题（进入 triage 语料 `question`）。
   * 生产经 `runChannelWrite` 的 `--question` 提供；缺省时遇 triage 决策 ⇒ 响亮失败。
   */
  readQuestion?: () => Promise<string>;
}

/** 一次 spawn 的观察记录：role/runId 由决策注入，spawned 表示 spawnWorker 是否成功返回。 */
export interface SpawnRecord {
  clueId: string;
  role: string;
  runId: string;
  spawned: boolean;
}

/** runWrite 的观察输出：已执行写数 + spawn 记录（安全性 + 活性配对）。 */
export interface WriteResult {
  /** 已实际发起的 CAS 写次数（含失败尝试）。 */
  writes: number;
  /** 未产生写的决策数（triage / CAS 冲突跳过的 dispatch）。 */
  skipped: number;
  casResults: {
    clueId: string;
    to: ClueV2["status"];
    success: boolean;
    error?: CasDecision["error"];
  }[];
  /** spawn 记录：dispatch CAS 成功后真正调用 spawnWorker（A8c）。 */
  spawns: SpawnRecord[];
  /** spawn dep 被调用的次数。 */
  spawnCalls: number;
  /** A8e——收割报告（每张 exited(0) 卡一条；H12/H13 显式报告跳过数）。 */
  harvestReports: HarvestReport[];
  /** G2b——triage 收割报告（一次 triage 一条；含整批预算跳过/校验拒绝计数）。 */
  triageReports: TriageReport[];
}

function generateRunId(): string {
  return randomUUID();
}

/**
 * A8d——真实 `agent-run` 的 `--input` 载荷，形状由 R1c 的
 * `deep-research.worker-input/v1` 硬验收 T3–T6 钉死（spec §1.2）。
 * ⛔ 不得含 `attempt_id` / `development_id` / `spec_commit` / `run_id`
 * （`run_id` 由 `--run-id` 单独传递，放进 input 会成为第二真相源）。
 */
export interface WorkerInputPayload {
  clue_id: string;
  clue_text: string;
  allowed_root?: string;
  /** A8f——引擎权威 `git rev-parse HEAD`（spec §1.3）；失败时**省略**、绝不填空串。 */
  revision?: string;
  depth: number;
  sources: string[];
}

/**
 * A8d——按 R1c 形状构造 worker 输入载荷（spec §1.2）。
 * 只产出 `clue_id` / `clue_text` / `depth` / `sources`（及可选 `allowed_root` / `revision`），
 * 绝不注入任何调度元数据。
 */
export function buildWorkerInput(
  clueId: string,
  clueText: string,
  depth: number,
  sources: string[],
  allowedRoot?: string,
  revision?: string,
): WorkerInputPayload {
  const input: WorkerInputPayload = {
    clue_id: clueId,
    clue_text: clueText,
    depth,
    sources: [...sources],
  };
  if (allowedRoot) input.allowed_root = allowedRoot;
  if (revision) input.revision = revision;
  return input;
}

/** A8d——`agent-run` 解析不到 ⇒ 响亮失败（spec §1.4 / P8），绝不静默回退占位 worker。 */
export class AgentRunUnresolvedError extends Error {
  constructor() {
    super(
      "A8d: cannot resolve the 'agent-run' binary (set AGENT_RUN_BIN to an existing agent-run path, or add its directory to PATH). Refusing to fall back to a placeholder worker.",
    );
    this.name = "AgentRunUnresolvedError";
  }
}

/**
 * A8d——解析 `agent-run` 可执行路径（spec §1.4 / P8 / P10）：
 * 允许 `AGENT_RUN_BIN` 覆盖；否则按 PATH 解析。
 * ⛔ 解析不到（含 `AGENT_RUN_BIN` 指向不存在路径）⇒ 当场抛 `AgentRunUnresolvedError`，
 *    绝不静默回退占位 worker（与「解析不到 secret 不得塞空串」同源）。
 */
export function resolveAgentRunBin(): string {
  const override = process.env.AGENT_RUN_BIN;
  if (override) {
    if (existsSync(override)) return override;
    throw new AgentRunUnresolvedError();
  }
  const pathDirs = (process.env.PATH ?? "").split(delimiter);
  for (const dir of pathDirs) {
    if (!dir) continue;
    const candidate = join(dir, "agent-run");
    if (existsSync(candidate)) return candidate;
  }
  throw new AgentRunUnresolvedError();
}

/**
 * 纯副作用执行：按决策序执行写动作（先 CAS 后 spawn；CAS 失败跳过不 spawn，S2）。
 * ⛔ 先 CAS 成功才 spawn；spawn 同步失败 → 当场 CAS 回 open（spec §1.2 / S2 补偿）。
 * ⛔ 每次写前检查 max-writes 上限，超限立即抛错（M10）。spawn 本身不写 bus、不计入预算；
 *    但每次 spawn 前的 CAS 计入（spec §2）。
 */
export async function runWrite(
  deps: WriteDeps,
  decisions: Decision[],
  maxWrites = DEFAULT_MAX_WRITES,
): Promise<WriteResult> {
  let writes = 0;
  let skipped = 0;
  const casResults: WriteResult["casResults"] = [];
  const spawns: WriteResult["spawns"] = [];
  const harvestReports: WriteResult["harvestReports"] = [];
  const triageReports: WriteResult["triageReports"] = [];
  // ⛔ spawnCalls 是观测计数，不是硬编码字面量：包装 deps.spawnWorker 递增。
  let spawnCalls = 0;
  const spawnWorker = async (
    clueId: string,
    role: string,
    runId: string,
    input: WorkerInputPayload,
  ): Promise<void> => {
    spawnCalls += 1;
    await deps.spawnWorker(clueId, role, runId, input);
  };

  const perform = async (input: WriteCasInput): Promise<CasDecision> => {
    if (writes >= maxWrites) {
      throw new MaxWritesExceededError(maxWrites);
    }
    const result = await deps.cas(input);
    writes += 1;
    return result;
  };

  for (const decision of decisions) {
    switch (decision.kind) {
      case "reclaim": {
        // reclaim 决策源自 in_flight 卡 ⇒ 前置条件为 in_flight。
        const result = await perform({
          clueId: decision.clueId,
          to: decision.to,
          from: "in_flight",
        });
        casResults.push({
          clueId: decision.clueId,
          to: decision.to,
          success: result.success,
          error: result.error,
        });
        break;
      }
      case "harvest": {
        // A8e——收割步：把 worker.result.v1 转成 evidence + 新 clue 发回研究板，
        // 全部发布成功后才 CAS 到 explored（§1.1：先发完，才 CAS；H6/H7）。
        const hd = deps.harvest;
        // ⛔ 证据 channel 无默认值：未接线/缺失 ⇒ 响亮报错，且零网络请求（§1.4 / H14 / H15）。
        if (!hd || !hd.evidenceChannelId) {
          throw new MissingEvidenceChannelError();
        }
        // 无 runId（极端状态）⇒ 无从收割，直接 CAS 到 explored（与 no_result 同语义）。
        if (!decision.runId) {
          const result = await perform({
            clueId: decision.clueId,
            to: "explored",
            from: "in_flight",
          });
          casResults.push({
            clueId: decision.clueId,
            to: "explored",
            success: result.success,
            error: result.error,
          });
          break;
        }
        // ⛔ v1 冻结证据 channel 拒写，零请求（§2 / H16）。
        if (isFrozenChannel(hd.evidenceChannelId)) {
          throw new FrozenChannelError(hd.evidenceChannelId);
        }
        // §1.7——evidence+clue 发布均计入 --max-writes；不足则整卡跳过。
        const budget = {
          total: () => maxWrites,
          remaining: () => maxWrites - writes,
          consume: (n: number) => {
            writes += n;
          },
        };
        const report = await harvestCard(
          hd,
          {
            clueId: decision.clueId,
            depth: decision.depth,
            sources: decision.sources,
          },
          decision.runId,
          budget,
        );
        harvestReports.push(report);
        if (report.casExplored) {
          // 全部发布成功 ⇒ 最后 CAS 到 explored（§1.1 / H6）。
          const result = await perform({
            clueId: decision.clueId,
            to: "explored",
            from: "in_flight",
          });
          casResults.push({
            clueId: decision.clueId,
            to: "explored",
            success: result.success,
            error: result.error,
          });
        }
        break;
      }
      case "dispatch": {
        const runId = generateRunId();
        // dispatch 决策源自 open 卡 ⇒ 前置条件为 open。
        const result = await perform({
          clueId: decision.clueId,
          to: "in_flight",
          from: "open",
          runId,
        });
        casResults.push({
          clueId: decision.clueId,
          to: "in_flight",
          success: result.success,
          error: result.error,
        });
        if (result.success) {
          // CAS 成功才算认领：按决策注入的 role/runId 真正 spawn，并把 clue 文本/depth/sources
          // 以 worker 输入载荷传下去（A8d spec §1.3 —— `--input` 与 prompt 都需要它）。
          const input = buildWorkerInput(
            decision.clueId,
            decision.text ?? "",
            decision.depth ?? 0,
            decision.sources ?? [],
          );
          try {
            await spawnWorker(decision.clueId, decision.role, runId, input);
            spawns.push({
              clueId: decision.clueId,
              role: decision.role,
              runId,
              spawned: true,
            });
          } catch (err) {
            // ⛔ spec §1.4 / P8：`agent-run` 解析不到 ⇒ **响亮失败**（非零退出 + 点名 agent-run），
            //    绝不静默 CAS 回 open（评审 finding：静默回退会让调度器看到 spawned:false、exit 0，
            //    而实际什么都没跑，形成 §0.1 的震荡危害）。仅对**其他** spawn 失败做 S2 补偿。
            //    A8f：`code-local` 无 `allowed_root` 同样属配置错误 ⇒ 响亮失败（点名 allowed-root），
            //    不 CAS 回 open、不静默产出零证据（spec §1.2 / F5）。
            if (
              err instanceof AgentRunUnresolvedError ||
              err instanceof MissingAllowedRootError
            ) {
              throw err;
            }
            // ⛔ spawn 同步失败 ⇒ 当场 CAS 回 open（S2 补偿规则，真实路径兑现 N5）。
            const rollback = await perform({
              clueId: decision.clueId,
              to: "open",
              from: "in_flight",
              runId,
            });
            casResults.push({
              clueId: decision.clueId,
              to: "open",
              success: rollback.success,
              error: rollback.error,
            });
            spawns.push({
              clueId: decision.clueId,
              role: decision.role,
              runId,
              spawned: false,
            });
          }
        } else {
          // CAS 失败（409）→ 跳过该卡，无后续动作、不 spawn（M8 / N4）。
          skipped += 1;
        }
        break;
      }
      case "block": {
        // block 决策源自 open 卡（invalid_sources / web_unimplemented / unmapped_source）⇒ 前置条件为 open。
        // ⛔ 把 decision.rationale 写进卡（spec §1.2 N7：blocked 且 rationale 非空）。
        const result = await perform({
          clueId: decision.clueId,
          to: "blocked",
          from: "open",
          rationale: decision.rationale,
        });
        casResults.push({
          clueId: decision.clueId,
          to: "blocked",
          success: result.success,
          error: result.error,
        });
        break;
      }
      case "triage": {
        // G2b —— triage 生产派发：组装板面快照 → spawn dr-triage → 收割逐条 CAS。
        // ⛔ 快照语料必须进位置参数（§1.1）；spawn 必填且无条件调用（§1.3 / T7）。
        const question = deps.readQuestion
          ? await deps.readQuestion()
          : (() => {
              throw new MissingTriageQuestionError();
            })();
        const corpus: TriageCorpus = {
          question,
          proposed_clues: decision.proposedClues.map((c) => ({
            clue_id: c.clueId,
            clue_text: c.clueText,
            ...(c.depth !== undefined && c.depth !== 0 ? { depth: c.depth } : {}),
            ...(c.sources !== undefined && c.sources.length > 0 ? { sources: [...c.sources] } : {}),
          })),
          ...(decision.exploredSummaries.length > 0
            ? { explored_summaries: [...decision.exploredSummaries] }
            : {}),
        };
        // 缺省 spawnTriage = 生产 agent-run 派发（语料→argv→spawn，经 spawnTriageRole）。
        const spawnTriage: NonNullable<WriteDeps["spawnTriage"]> =
          deps.spawnTriage ??
          ((corp) => {
            if (!deps.triageSpawnRuntime) {
              throw new Error(
                "WriteDeps.spawnTriage has no default: provide spawnTriage or a triageSpawnRuntime",
              );
            }
            return spawnTriageRole(corp, deps.triageSpawnRuntime);
          });
        const result = await spawnTriage(corpus);
        const proposedIds = new Set(decision.proposedClues.map((c) => c.clueId));
        const applied = await applyTriageBatch(
          deps,
          { writes, maxWrites },
          proposedIds,
          result,
        );
        writes = applied.writes;
        triageReports.push(applied.report);
        break;
      }
    }
  }

  return {
    writes,
    skipped,
    casResults,
    spawns,
    spawnCalls,
    harvestReports,
    triageReports,
  };
}

/**
 * G2b —— 收割一次 triage 返回的决策列表：逐条校验值域/越界，然后整批 CAS。
 *
 * 校验（先于任何 CAS，保证「不做半批」）：
 *   (a) action 值域（§2.3(a)）：非 keep/drop ⇒ 响亮拒绝（不当 keep 也不当 drop）。
 *   (b) clue_id 越界（§2.3(b)）：不在本轮 proposed 集合 ⇒ 丢弃并响亮记录，不改任何卡。
 * 上述任一校验失败 ⇒ 响亮抛错，整个批次零 CAS（⛔ 不得据此去改一张不该动的卡）。
 *
 * 写入预算（§2.4）：CAS 写入计入 `--max-writes`；不足 ⇒ **整批跳过**并响亮报告（`budgetSkipped`），
 * 不做半批。budget 充足时对每条 `keep → proposed→open`、`drop → proposed→dropped` 执行 CAS，
 * 并把 `rationale` 写进该卡（版本链留痕，spec §2.2）。⛔ clue 的唯一写者仍是调度器（引擎按 decision CAS）。
 */
async function applyTriageBatch(
  deps: WriteDeps,
  ctx: { writes: number; maxWrites: number },
  proposedIds: Set<string>,
  decisions: TriageResultDecision[],
): Promise<{ writes: number; report: TriageReport }> {
  // (a) action 值域：bus `openSchema()` 会剥掉 enum ⇒ bus 拦不住，引擎消费侧必须自校验。
  let invalidActions = 0;
  const inDomain: TriageResultDecision[] = [];
  for (const d of decisions) {
    if (d.action !== "keep" && d.action !== "drop") {
      invalidActions += 1;
      throw new InvalidTriageActionError(d.clue_id, d.action);
    }
    inDomain.push(d);
  }

  // (b) clue_id 越界：不在本轮 proposed 集合 ⇒ 丢弃并响亮记录（查得到 ≠ 有权改）。
  let outOfScopeDropped = 0;
  const inScope: TriageResultDecision[] = [];
  for (const d of inDomain) {
    if (!proposedIds.has(d.clue_id)) {
      outOfScopeDropped += 1;
      throw new OutOfScopeTriageClueError(d.clue_id);
    }
    inScope.push(d);
  }

  // 写入预算：不足 ⇒ 整批跳过并响亮报告（不做半批）。
  if (inScope.length > ctx.maxWrites - ctx.writes) {
    return {
      writes: ctx.writes,
      report: {
        runId: "",
        budgetSkipped: true,
        invalidActions,
        outOfScopeDropped,
        casCount: 0,
        casResults: [],
      },
    };
  }

  let writes = ctx.writes;
  const casResults: TriageReport["casResults"] = [];
  for (const d of inScope) {
    const to: ClueV2["status"] = d.action === "keep" ? "open" : "dropped";
    const result = await deps.cas({
      clueId: d.clue_id,
      to,
      from: "proposed",
      rationale: d.rationale,
    });
    writes += 1;
    casResults.push({ clueId: d.clue_id, to, success: result.success, error: result.error });
  }
  return {
    writes,
    report: {
      runId: "",
      budgetSkipped: false,
      invalidActions,
      outOfScopeDropped,
      casCount: inScope.length,
      casResults,
    },
  };
}

/** runChannelWrite 的选项：channel 必须显式传入（M11）。 */
export interface RunWriteOptions {
  channelId: string;
  maxWrites?: number;
  runsChannelId?: string;
  /**
   * A8e——证据 channel：⛔ 显式传入、无默认值、无 `.board`→`.evidence` 字符串推导（§1.4 / H14 / H15）。
   * 仅当存在 harvest 决策（exited(0) 卡）时才必需；缺失 ⇒ 抛 `MissingEvidenceChannelError`（零请求）。
   */
  evidenceChannelId?: string;
  /** A8e——maxDepth（§1.6 / H11）；缺省用 DEFAULT_TICK_CONFIG.maxDepth。 */
  maxDepth?: number;
  /** A8e——maxClues（§1.6 / H12）；缺省用 DEFAULT_TICK_CONFIG.maxClues。 */
  maxClues?: number;
  /** 注入的 spawn dep（测试用）；缺省走真实 `agent-run` 子进程启动 worker。 */
  spawnWorker?: WriteDeps["spawnWorker"];
  /** `agent-run` 可执行路径（argv[0]）；缺省 `resolveAgentRunBin()`（`AGENT_RUN_BIN`/PATH）。 */
  workerCmd?: string;
  /** A8f——worker 可读的 repo 根（`code-local` 必需；经 `--add-dir` 授予目录读）。 */
  allowedRoot?: string;
  /** G2b——研究主问题（进入 triage 语料 question）。缺省时遇 triage 决策 ⇒ 响亮失败。 */
  question?: string;
  /** G2b——注入的 triage spawn dep（测试用）；缺省走真实 `agent-run` 子进程派发。 */
  spawnTriage?: WriteDeps["spawnTriage"];
  /** G2b——注入的 triage spawn 运行时（缺省 spawnTriage 用）。 */
  triageSpawnRuntime?: TriageSpawnRuntime;
  /**
   * G4b —— 上一 tick 的覆盖度（spec §1.2：跨 tick 经 trigger body 传递）。
   * ⛔ 生产经 `--prev-coverage` 提供（tick.md 解析 `{{trigger_body}}` 后传入）；
   *    测试可直接注入。缺省 0（与首轮语义一致；生产首轮 body 也显式带 0）。
   */
  prevCoverage?: number;
  /**
   * G4b —— 上一 tick 结束时的零增长轮数（spec §1.2：跨 tick 经 trigger body 传递）。
   * 同 `prevCoverage`：生产经 `--prev-zero-growth-rounds` 提供；缺省 0。
   */
  prevZeroGrowthRounds?: number;
}

/** runChannelWrite 的观察输出。 */
export interface RunWriteOutcome {
  channelId: string;
  messageCount: number;
  decisions: Decision[];
  writes: number;
  skipped: number;
  spawns: SpawnRecord[];
  /** A8e——收割报告（exited(0) 卡的 evidence/clue 发布与跳过情况）。 */
  harvestReports: HarvestReport[];
  /** G2b——triage 收割报告（一次 triage 一条；含整批预算跳过/校验拒绝计数）。 */
  triageReports: TriageReport[];
  /**
   * A9 —— 板面是否仍有非终态 clue（proposed / open / in_flight），由板面状态确定性推出。
   * tick 依它决定是否 `loop-store put` 下一条触发（spec §1.3 / F7/F8）。
   */
  hasPendingWork: boolean;
  /**
   * G4b —— 本轮终态判定（spec §1.1 / R1）。`--run` 用本轮真实板面 + 跨 tick 传递的
   * prevCoverage / prevZeroGrowthRounds 调用已交付的 `decideTermination`，并把结果
   * 与 `hasPendingWork` 并列放进 JSON 输出。state 非 null 即终态
   *（converged / capped / partial），null 表示继续。`coverage` / `zeroGrowthRounds`
   * 供 tick.md 写进下一条 trigger 的 body（spec §1.2）。
   */
  termination: TerminationState;
}

/**
 * 真实 bus 的 CAS：读 head → 校验前置条件 → 合并 update → CAS（先 CAS 成功才算认领，S2）。
 * ⛔ CAS 互斥不变量：前置条件必须在**同一次 head 读**上求值。
 *    决策虽在板快照上算，但 CAS 前用 getEntity 读最新 head 并校验 `from`；
 *    若 head 状态 ≠ `from`（别人已抢先改状态，例如把 open 认领成 in_flight），
 *    则返回 conflict 并**不 publish**，绝不 CAS 掉活 worker 的认领（spec §0 破坏场景）。
 *    supersedes 一律取这同一次 head 的 message_id（与 claimClue 同源读语义一致）。
 */
export async function realCas(
  channelId: string,
  input: WriteCasInput,
  nonce: string,
): Promise<CasDecision> {
  const head = await getEntity(input.clueId);
  if (!head) {
    return { success: false, error: "entity_not_found" };
  }
  const current = (head.payload as ClueV2).status;
  if (current !== input.from) {
    return { success: false, error: "conflict" };
  }
  const update: Partial<ClueV2> = { status: input.to };
  if (input.runId) update.run_id = input.runId;
  if (input.rationale !== undefined) update.rationale = input.rationale;
  const idempotencyKey = `a8b-run:${channelId}:${input.clueId}:${input.to}:${nonce}`;
  return casUpdateClue(channelId, input.clueId, head, update, idempotencyKey);
}

/**
 * 真实 spawn 动作（spec §1.2 / A8c）：CAS 成功后**真正启动一个 worker 子进程**。
 *
 * ⛔ spawn 本身不写 agent-bus（spec §2：spawn 不写 bus，仅每次 spawn 前的 CAS 计入）。
 * ⛔ 本包**不伪造** `agent.run.started` —— 该生命周期事实必须由真正启动的 worker 自行发布；
 *    若没有进程却发布 started，decideTick 会把在飞卡永久钉死在 in_flight（评审 blocker）。
 *    worker 的实际产出（worker.result.v1 未注册）属 V1，本包不注册（spec §7）。
 *
 * 启动失败（如命令不存在）⇒ reject ⇒ 上层（N5 / S2 补偿）当场把卡 CAS 回 open。
 */
export interface WorkerSpawnSpec {
  /** worker 启动命令（argv[0]）。 */
  cmd: string;
  /** worker 启动参数（追加 role/clueId/runId 之外的可配置固定参数）。 */
  args: string[];
  /** 透传给 worker 的环境变量。 */
  env?: Record<string, string>;
  /**
   * ⛔ worker 真正退出（或启动失败）时回调，用于释放 worker 独占的资源。
   * A8d 评审 finding：`--input` 载荷文件的寿命必须绑定到**子进程的消费/退出**，
   * 而不是一个无关的就绪计时器——真实 `agent-run` 是长驻进程，就绪窗口（2000ms）之后
   * 仍在运行，若此时删除载荷文件，worker 读取 `--input` 会 ENOENT（spec §1.1 的 CONTRACT_ERROR）。
   * 该回调只在子进程 exit / error 时触发一次，保证载荷在 worker 存活期间一直可用。
   */
  onExit?: () => void;
}

export interface SpawnedWorker {
  pid: number | undefined;
}

/** worker 进程在就绪窗口内即非零退出 —— 启动失败（如缺省命令退出 127），触发 N5 回滚。 */
export class WorkerStartupError extends Error {
  constructor(cmd: string, code: number | null) {
    super(
      `A8c: worker failed to start (${cmd}) — exited with code ${code}.`,
    );
    this.name = "WorkerStartupError";
  }
}

/**
 * worker 就绪窗口（ms）：进程存活超过该窗口即视为「已真实启动」。
 * 在此窗口内非零退出（如命令不存在退出 127）⇒ 拒绝 ⇒ 上层 N5 当场 CAS 回 open。
 * 窗口取足够大，避免在并发/负载下把「尚未来得及退出的坏命令」误判为已启动。
 */
export const SPAWN_READY_GRACE_MS = 2000;

/**
 * 真实 spawn 进程序（spec §1.2 / A8c）：CAS 成功后**真正启动一个 worker 子进程**，
 * 并确认 worker 已真实启动（不是只在 `spawn` 事件上就断言成功，评审 finding 2）。
 *
 * ⛔ 只认「进程存活超过就绪窗口」或「正常退出（exit 0）」为启动成功；
 *    就绪窗口内非零退出（如 `bash <缺失脚本>` 退出 127）⇒ reject ⇒ 上层 N5 不回滚。
 *    spawned:true 由此只在 worker 确实起来时成立，不再是无意义的占位。
 */
export async function spawnWorkerProcess(
  spec: WorkerSpawnSpec,
): Promise<SpawnedWorker> {
  return await new Promise((resolve, reject) => {
    const child = spawn(spec.cmd, spec.args, {
      env: { ...process.env, ...spec.env },
      stdio: "ignore",
      detached: false,
    });
    let settled = false;
    let timer: NodeJS.Timeout | undefined;
    const settle = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn();
    };
    child.once("error", (err) =>
      settle(() => {
        // 启动失败（如命令不存在）⇒ 释放 worker 独占资源（onExit 只触发一次）。
        spec.onExit?.();
        reject(err);
      }),
    );
    child.once("exit", (code) => {
      if (code === 0) {
        // worker 正常完成 ⇒ 视为已启动，并释放 worker 独占资源（onExit）。
        settle(() => {
          spec.onExit?.();
          resolve({ pid: child.pid });
        });
      } else {
        // 就绪窗口内非零退出 ⇒ 未真正启动 worker，触发 N5 补偿；同时释放资源。
        settle(() => {
          spec.onExit?.();
          reject(new WorkerStartupError(spec.cmd, code));
        });
      }
    });
    // worker 存活超过就绪窗口 ⇒ 确认已真实启动。
    timer = setTimeout(() => {
      settle(() => {
        child.unref();
        resolve({ pid: child.pid });
      });
    }, SPAWN_READY_GRACE_MS);
  });
}

/**
 * A8d——缺省 worker 启动命令：真实 `agent-run`（spec §1.1）。
 * 由 `resolveAgentRunBin()` 解析（`AGENT_RUN_BIN` 覆盖 / PATH），
 * ⛔ 解析不到 ⇒ 抛 `AgentRunUnresolvedError`，**绝不回退占位 worker**。
 * 不再是 A8c 的 `bin/worker-launcher.sh`（占位链路只保留给测试）。
 */
export function defaultWorkerCmd(): string {
  return resolveAgentRunBin();
}

/**
 * A8d——构造真实 `agent-run` 的完整 argv（spec §1.1）：
 * `agent-run --role <role> --run-id <runId> [--add-dir <allowed_root>] --input <payloadPath> -- "<clue_text>"`
 * A8f——`--add-dir <allowed_root>` 仅当有值时追加（spec §1.3 / F2 / F10）。
 * 返回的数组 [0] 即 argv[0]（agent-run 可执行路径），供 P1–P7 逐项断言。
 */
export function buildAgentRunArgv(opts: {
  agentRunBin: string;
  role: string;
  runId: string;
  inputPath: string;
  clueText: string;
  allowedRoot?: string;
}): string[] {
  const args = [
    opts.agentRunBin,
    "--role",
    opts.role,
    "--run-id",
    opts.runId,
  ];
  if (opts.allowedRoot) {
    args.push("--add-dir", opts.allowedRoot);
  }
  args.push("--input", opts.inputPath, "--", opts.clueText);
  return args;
}

/**
 * A8d——把 worker 输入载荷写成 JSON 文件，返回 `--input` 要指向的路径（spec §1.2）。
 * 文件内容即 `deep-research.worker-input/v1` 载荷（P4/P5 直接读该文件断言）。
 */
export function writeWorkerInputFile(input: WorkerInputPayload): string {
  const file = join(tmpdir(), `a8d-worker-input-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(input));
  return file;
}

/**
 * A8d——真实 `agent-run` spawn 动作（spec §1.1/§1.2）：
 * 把载荷写成 `--input` 文件 → 以 `agent-run --role <role> --run-id <runId>
 * --input <path> -- "<clue_text>"` 启动子进程。
 * ⛔ `agent-run` 解析不到 ⇒ `resolveAgentRunBin` 先抛（P8/P9），根本不会走到 spawn，
 *    也绝不回退占位 worker。spawn 的启动成败判定仍走 A8c 的 `spawnWorkerProcess`。
 */
export async function spawnAgentRunWorker(opts: {
  agentRunBin: string;
  role: string;
  runId: string;
  input: WorkerInputPayload;
  allowedRoot?: string;
}): Promise<SpawnedWorker> {
  const payloadPath = writeWorkerInputFile(opts.input);
  const argv = buildAgentRunArgv({
    agentRunBin: opts.agentRunBin,
    role: opts.role,
    runId: opts.runId,
    inputPath: payloadPath,
    clueText: opts.input.clue_text,
    allowedRoot: opts.allowedRoot,
  });
  // ⛔ 载荷文件的寿命绑定到**子进程退出**（onExit），而不是就绪计时器。
  //    `spawnWorkerProcess` 在 SPAWN_READY_GRACE_MS 后就 unref 并 resolve，真实 `agent-run`
  //    是长驻进程，此时仍在运行且可能尚未读取 `--input`。若在 finally 里随即删除，
  //    worker 会 ENOENT 撞上 dispatch.ts:795 强制的 `--input` ⇒ CONTRACT_ERROR（评审 finding）。
  //    onExit 只在子进程 exit/error 时触发，保证载荷在 worker 存活期间一直可用。
  return await spawnWorkerProcess({
    cmd: argv[0],
    args: argv.slice(1),
    env: { AGENT_RUN_BIN: opts.agentRunBin },
    onExit: () => rmSync(payloadPath, { force: true }),
  });
}

/**
 * 完整写侧跑一次：校验 channel（冻结即拒，M12）→ 读板 + 真实 runs → 决策 → 执行写 + spawn。
 * ⛔ CAS 一律走 A8b 的 `realCas`（不得绕过另写 CAS，spec §4.1 纪律 8）。
 * spawn 为真实路径实现：CAS 成功后**缺省走真实 `agent-run`**（spec §1.1，A8d）；
 * ⛔ spawn 不写 agent-bus、不伪造 `agent.run.started`（spec §2 / 评审 blocker）；
 *    缺省命令解析不到 agent-run ⇒ 响亮失败（P8/P9），绝不回退占位 worker。
 *    注入 `spawnWorker` 时解析不触发（惰性，仅缺省分支用到）。
 */
export async function runChannelWrite(
  opts: RunWriteOptions,
): Promise<RunWriteOutcome> {
  if (isFrozenChannel(opts.channelId)) {
    throw new FrozenChannelError(opts.channelId);
  }
  const nonce = randomUUID();
  const runsChannelId = opts.runsChannelId ?? "board:agent-runs";
  const messages = await readChannelMessages(opts.channelId);
  // A8e——`board:agent-runs` 只分页读一次，同时喂给 runs 归集与每张卡的 worker.result
  //   查询（评审 note：readWorkerResult 原先每张 harvest 卡把整个 channel 再分页一遍，
  //   这是 O(cards x channel) 的读放大；这里复用同一份已读消息列表）。
  const runsMessages = await readChannelMessages(runsChannelId);
  const runs = buildRunsFromMessages(runsMessages);
  const assembled = assembleBoard(messages, runs);
  const state = assembled.state;
  const decisions = decideTick(state, DEFAULT_TICK_CONFIG);
  // A8e——maxDepth/maxClues 取配置（不硬编码，spec §6）。
  const maxDepth = opts.maxDepth ?? DEFAULT_TICK_CONFIG.maxDepth;
  const maxClues = opts.maxClues ?? DEFAULT_TICK_CONFIG.maxClues;
  const deps: WriteDeps = {
    cas: (input) => realCas(opts.channelId, input, nonce),
    spawnWorker:
      opts.spawnWorker ??
      ((clueId, role, runId, input) => {
        // A8f——`code-local` 无 `allowed_root` ⇒ 当场响亮失败（spec §1.2 / F5），零 spawn。
        const allowedRoot = opts.allowedRoot;
        if (role === CODE_LOCAL_ROLE && !allowedRoot) {
          throw new MissingAllowedRootError(role);
        }
        // A8f——生产调用点真实传入 allowedRoot，并取引擎权威 revision（spec §1.3 / F3/F4）。
        const augmented = buildWorkerInput(
          input.clue_id,
          input.clue_text,
          input.depth,
          input.sources,
          allowedRoot,
          allowedRoot ? resolveRevision(allowedRoot) : undefined,
        );
        return spawnAgentRunWorker({
          agentRunBin: opts.workerCmd ?? resolveAgentRunBin(),
          role,
          runId,
          input: augmented,
          allowedRoot,
        }).then(() => undefined);
      }),
    // A8e——收割写依赖：证据 channel 显式传入（无默认值）；readWorkerResult 读 board:agent-runs。
    harvest: {
      evidenceChannelId: opts.evidenceChannelId ?? "",
      boardChannelId: opts.channelId,
      maxClues,
      maxDepth,
      // ⛔ maxClues 运行计数：`{ value }` 是可变的共享计数器。runWrite 把同一
      //    `deps.harvest` 传给**每一张** harvest 卡，harvestCard 发布新 clue 时实时
      //    累加 `.value`，从而多张卡在同一 tick 内累计后板面也不超 maxClues（§1.6）。
      boardClueCount: { value: assembled.clueEntities },
      readWorkerResult: async (runId) => findWorkerResult(runId, runsMessages),
      publishEvidence: (channelId, evidence, key) =>
        publishEvidence(channelId, evidence, key).then(() => undefined),
      publishClue: (channelId, clue, key) =>
        publishClue(channelId, clue, key).then(() => undefined),
    },
    // G2b —— triage：研究主问题（--question）；缺省走生产 spawnTriageRole（真实 agent-run）。
    readQuestion: async () => {
      if (opts.question !== undefined) return opts.question;
      throw new MissingTriageQuestionError();
    },
    spawnTriage:
      opts.spawnTriage ??
      ((corpus) => {
        const runtime: TriageSpawnRuntime =
          opts.triageSpawnRuntime ?? {
            agentRunBin: opts.workerCmd ?? resolveAgentRunBin(),
            runId: randomUUID(),
            // ⛔ 无条件真实 spawn：真正启动 agent-run 子进程（本包不注册 dr-triage.result.v1，
            //     E2E 真发留 Phase 6；spawn 仍是生产路径，绝非空操作/静默零-spawn 假成功）。
            spawnProcess: async (argv, env) => {
              await spawnWorkerProcess({
                cmd: argv[0],
                args: argv.slice(1),
                env,
                onExit: () => {},
              });
              return {};
            },
            readResult: async (runId) => findTriageResult(runId, runsMessages) ?? [],
          };
        return spawnTriageRole(corpus, runtime);
      }),
  };
  const result = await runWrite(
    deps,
    decisions,
    opts.maxWrites ?? DEFAULT_MAX_WRITES,
  );
  // A9 —— hasPendingWork 必须反映**写后**板面（本 tick 已把某些非终态卡推进到终态），
  //   而不是写前快照 `state`：否则一个把最后一张非终态卡推到终态的 tick 仍会报 true，
  //   多投一条触发（下一 tick 才消掉）。用成功 CAS 的写后 status 重建板面再判定（spec §1.3）。
  //   G2b —— triage 的 CAS（proposed→open/dropped）一并计入写后重建，否则 triage 收割的
  //   proposed→dropped 不会被反映，hasPendingWork 仍把已裁走的卡算作待处理（spec §3.2）。
  const triageCasResults = result.triageReports.flatMap((r) => r.casResults);
  const postWriteState = applyCasOutcomes(state, [...result.casResults, ...triageCasResults]);
  // ⛔（attempt 2 blocker）写后板面重建（applyCasOutcomes）只重写**已存在于写前快照**的卡，
  //   本 tick 经 harvest 新发布的 clue（status=proposed，非终态）不在其中。若被收割的卡恰好是
  //   最后一张非终态卡，postWriteState 会全为终态而 hasPendingWork=false，导致新发布的 proposed
  //   clue 被**静默搁浅**（spec §3.2 禁止静默零结果 = 假装完成）。因此 hasPendingWork 必须把本 tick
  //   新发布的 clue 一并计入：任一张卡发布了 clue（harvestReports[].cluesPublished>0）即视为仍有待处理
  //   工作（新 clue 非终态 proposed，须由下一 tick 探索），不得只依赖写前快照上的旧卡重建。
  const cluesPublished = result.harvestReports.reduce(
    (n, r) => n + r.cluesPublished,
    0,
  );
  // G4b —— 用本轮真实板面（写后，含本 tick 的 CAS 推进）+ 跨 tick 传递的
  //   prevCoverage / prevZeroGrowthRounds 调用已交付的 `decideTermination`（spec §1.1）。
  //   ⛔ 不新造判定逻辑：decideTermination / computeCoverage 是已交付纯函数，只调用它们。
  //   ⛔ 写后板面用于终态判定：本 tick 已把卡推进终态的事实必须反映在 coverage / drained 上，
  //      否则终态永远滞后一 tick（与 hasPendingWork 同一重建理由，spec §1.3）。
  //   coverage 原料（coveredClueIds）取写前组装的覆盖集合：evidence 是 append-only，
  //      本 tick 的 harvest 发布的 evidence 已计入该集合（assembleBoard 在读板时已读全）。
  const prevCoverage = opts.prevCoverage ?? 0;
  const prevZeroGrowthRounds = opts.prevZeroGrowthRounds ?? 0;
  const termInput: TerminationInput = {
    cards: postWriteState.cards,
    coveredClueIds: assembled.coveredClueIds,
    prevCoverage,
    prevZeroGrowthRounds,
  };
  const termination = decideTermination(termInput, DEFAULT_TICK_CONFIG);
  return {
    channelId: opts.channelId,
    messageCount: messages.length,
    decisions,
    writes: result.writes,
    skipped: result.skipped,
    spawns: result.spawns,
    harvestReports: result.harvestReports,
    triageReports: result.triageReports,
    hasPendingWork: hasPendingWork(postWriteState) || cluesPublished > 0,
    termination,
  };
}

/**
 * A9 —— 把一次 tick 的成功 CAS 写结果应用到写前板面，重建**写后**板面。
 * 仅对 `success` 的 CAS 更新对应卡的 status；失败的 CAS（conflict 等）不改动，
 * 保持写前状态（该卡未被本 tick 认领）。纯函数：不碰 IO、不修改入参。
 */
function applyCasOutcomes(
  state: BoardState,
  casResults: WriteResult["casResults"],
): BoardState {
  const statusById = new Map<string, ClueV2["status"]>();
  for (const r of casResults) {
    if (r.success) statusById.set(r.clueId, r.to);
  }
  const cards = state.cards.map((c) =>
    statusById.has(c.clueId)
      ? { ...c, status: statusById.get(c.clueId)! }
      : c,
  );
  return { ...state, cards };
}

/** CLI --run 参数解析结果（channel 无默认值，M11）。 */
export interface RunCliOptions {
  channelId: string;
  maxWrites: number;
  /** A8e——证据 channel（--evidence-channel）；可选，缺失时仅当有 harvest 决策才报错（§1.4 / H14）。 */
  evidenceChannelId?: string;
  /** A8f——worker 可读 repo 根（--allowed-root）；`code-local` 必需（§1.2 / F5）。 */
  allowedRoot?: string;
  /** G2b——研究主问题（--question）；进入 triage 语料 question（缺省遇 triage 决策即响亮失败）。 */
  question?: string;
  /**
   * G4b —— 上一 tick 的覆盖度（--prev-coverage）。生产经 tick.md 解析 `{{trigger_body}}` 后传入；
   * 缺省 0（与首轮语义一致，且首轮 body 也由 bin 显式带 coverage:0，spec §1.2）。
   */
  prevCoverage?: number;
  /**
   * G4b —— 上一 tick 结束时的零增长轮数（--prev-zero-growth-rounds）。
   * 同 `prevCoverage`：生产经 tick.md 传入；缺省 0。
   */
  prevZeroGrowthRounds?: number;
}

/**
 * 解析 `--run` 之后的参数：
 * `[<channel_id>] [--max-writes <n>] [--evidence-channel <evidence_channel_id>] [--allowed-root <path>] [--question <研究主问题>] [--prev-coverage <n>] [--prev-zero-growth-rounds <n>]`。
 * ⛔ 不传 channel → 抛 MissingChannelError（exit ≠ 0，M11）。
 * ⛔ 冻结 channel → 抛 FrozenChannelError（M12）。
 * G4b：`--prev-coverage` / `--prev-zero-growth-rounds` 缺省 0（首轮语义）；生产链路始终由
 *   tick.md 从 `{{trigger_body}}` 解析后显式传入（body 解析失败在 tick.md 层即响亮失败，spec §1.2 / R5）。
 */
export function parseRunCliArgs(args: string[]): RunCliOptions {
  const channelId = args[0];
  if (!channelId) {
    throw new MissingChannelError();
  }
  let maxWrites = DEFAULT_MAX_WRITES;
  let evidenceChannelId: string | undefined;
  let allowedRoot: string | undefined;
  let question: string | undefined;
  let prevCoverage: number | undefined;
  let prevZeroGrowthRounds: number | undefined;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--max-writes") {
      const value = Number(args[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("A8b: invalid --max-writes (must be a positive integer).");
      }
      maxWrites = value;
      i += 1;
    } else if (args[i] === "--evidence-channel") {
      evidenceChannelId = args[i + 1];
      if (!evidenceChannelId) {
        throw new Error(
          "A8e: invalid --evidence-channel (must specify a channel id).",
        );
      }
      i += 1;
    } else if (args[i] === "--allowed-root") {
      allowedRoot = args[i + 1];
      if (!allowedRoot) {
        throw new Error(
          "A8f: invalid --allowed-root (must specify a repo root path).",
        );
      }
      i += 1;
    } else if (args[i] === "--question") {
      question = args[i + 1];
      if (!question) {
        throw new Error(
          "G2b: invalid --question (must specify the research question).",
        );
      }
      i += 1;
    } else if (args[i] === "--prev-coverage") {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(
          "G4b: invalid --prev-coverage (must be a non-negative finite number).",
        );
      }
      prevCoverage = value;
      i += 1;
    } else if (args[i] === "--prev-zero-growth-rounds") {
      const value = Number(args[i + 1]);
      if (!Number.isFinite(value) || value < 0) {
        throw new Error(
          "G4b: invalid --prev-zero-growth-rounds (must be a non-negative finite number).",
        );
      }
      prevZeroGrowthRounds = value;
      i += 1;
    }
  }
  if (isFrozenChannel(channelId)) {
    throw new FrozenChannelError(channelId);
  }
  return {
    channelId,
    maxWrites,
    evidenceChannelId,
    allowedRoot,
    question,
    prevCoverage,
    prevZeroGrowthRounds,
  };
}
