/**
 * A8b/A8c —— tick 写侧执行：CAS 认领 / 回收 + spawn（接线判别）
 *
 * 对已交付的 Decision 执行写动作（spec §1.2 / §3.2 第 2–3 步）：
 *   reclaim  → CAS 该卡到目标 status（open / explored / blocked）
 *   dispatch → CAS open → in_flight，把 `run_id` 写进卡（M7），CAS 成功后按 role 真正 spawn（A8c）
 *   block    → CAS 到 blocked（invalid_sources / unmapped_source）
 *
 * ⛔ 先 CAS 成功才算认领；CAS 失败（409）跳过该卡且不 spawn（M8 / N4）。
 * ⛔ spawn 同步失败 ⇒ 当场 CAS 回 open（S2 补偿，N5）。
 * ⛔ 写入不可回退：`--max-writes` 默认 DEFAULT_MAX_WRITES（A10c 起足以收割一张真实卡），超限立即停止并响亮报错（M10）；
 *    spawn 本身不写 bus、不计入预算，但每次 spawn 前的 CAS 计入（spec §2）。
 * ⛔ 只对显式传入的 channel 操作（M11）；拒绝写 v1 冻结 channel（M12）。
 * ⛔ CAS 一律走 A8b 的 `realCas`，不得绕过另写 CAS（spec §4.1 纪律 8）。
 */
import { randomUUID, createHash } from "node:crypto";
import { execFileSync, spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync, openSync, closeSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ClueV2, DocV2 } from "./protocol";
import {
  decideTick,
  decideTermination,
  hasPendingWork,
  roleForSources,
  DEFAULT_TICK_CONFIG,
  type BoardCard,
  type BoardState,
  type CasDecision,
  type Decision,
  type TerminationState,
} from "./tick";
import {
  assembleBoard,
  buildRunsFromMessages,
  findRunExitedAt,
  findTriageResult,
  findWorkerResult,
  hasRunExited,
  readChannelMessages,
  readGenerateResult,
  readTriageResult,
  readWorkerResult,
  type InspectMessage,
  type TriageResultDecision,
} from "./tick-inspect";
import {
  harvestCard,
  MissingEvidenceChannelError,
  type HarvestDeps,
  type HarvestReport,
  type WorkerMaterialItem,
  type WorkerResultV1,
} from "./harvest";
import { casUpdateClue, getEntity, getMessages, publishClue, publishEvidence, publishDoc } from "./bus";
import {
  ingestMaterial as ingestMaterialImpl,
  readExistingTranscript,
  fetchMaterialHttp,
  createMutex,
  parseContentClueText,
  type IngestDeps,
} from "./ingest";
import { fileParse } from "./mineru";
import {
  RunExitedWithoutResultError,
  RunResultTimeoutError,
  decideDrainExit,
  isRunExitedWithoutResultError,
  isRunResultTimeoutError,
  type DrainExitContractResult,
  type RunExitWithoutResultDiagnostic,
} from "./run-exit-diagnostic";
import {
  runGenerate,
  decideGenerate,
  DEFAULT_GENERATE_CONFIG,
  buildReportMarker,
  type EvidenceView,
  type GenerateDeps,
  type GenerateSpawnRuntime,
  type AnchorCheckResult,
  type ExistingDoc,
  MissingAnchorCheckRepoRootError,
} from "./generate";
import { runExport, slugify, type ExportInput } from "./export";
import { RUNS_CHANNEL_ID, CONTENT_CHANNEL_ID } from "./run-channels";

/**
 * --max-writes 默认值。⛔ A10c §1.1——缺省值必须**足以收割一张真实卡**（真实 worker 产出
 * 实测 6~10 条 evidence，加上新 clue 与最终 CAS）。真实产出量 > 旧默认 5 ⇒ 卡永远收割不了、
 * 恒 max_rounds 死锁，这是本包根因。取 64：明显高于单张真实卡的 needed，仍是**有限**护栏
 * （非无穷大），绝不因 D1 而放开成不限。
 */
export const DEFAULT_MAX_WRITES = 64;

/**
 * G6 —— 等待 agent 结果的总时间预算（ms），缺省 15 分钟。
 * 观测最大值 390s（dr-triage），900s ≈ 2.3× 最大值，覆盖 triage 与 worker 两个分布的全部样本。
 * 可由 `AGENT_RESULT_TIMEOUT_MS` 环境变量覆盖。
 */
export const DEFAULT_AGENT_RESULT_TIMEOUT_MS = 900_000;

/**
 * G6 —— 轮询 agent 结果的间隔（ms），缺省 3 秒。
 * 1s 轮询在 15 分钟预算下会产生 900 次无谓请求，3s 足够。
 * 可由 `AGENT_RESULT_POLL_MS` 环境变量覆盖。
 */
export const DEFAULT_AGENT_RESULT_POLL_MS = 3_000;

/**
 * G6 —— 从环境变量读取超时与轮询配置。
 * 返回值：{ timeoutMs, pollMs }，均为正整数；缺省 `DEFAULT_AGENT_RESULT_TIMEOUT_MS` / `DEFAULT_AGENT_RESULT_POLL_MS`。
 * 测试可注入极小值（`AGENT_RESULT_TIMEOUT_MS` / `AGENT_RESULT_POLL_MS`），
 * 从而不靠真实等待把用例拖慢（R5）。
 */
export function resolveAgentResultTimeout(): { timeoutMs: number; pollMs: number } {
  const timeoutMs = Number(process.env.AGENT_RESULT_TIMEOUT_MS) || DEFAULT_AGENT_RESULT_TIMEOUT_MS;
  const pollMs = Number(process.env.AGENT_RESULT_POLL_MS) || DEFAULT_AGENT_RESULT_POLL_MS;
  return { timeoutMs, pollMs };
}

/**
 * E0c10 D4（GT-D）—— run exited 无 result 的判定宽限窗口（ms）。
 *
 * 真机（GT-D）：`exited without producing a dr-doc.result.v1 after 3159ms — refusing
 * to wait the full timeout`。一旦观察到 `agent.run.exited`，再宽限一段时间等 result 落到
 * channel（exit 与 result 发布之间有竞态：worker 先发 result 再 exited，或 exited 先到）。
 * 宽限后仍无 result ⇒ 判「exited without result」，记录诊断并继续本轮 tick。
 *
 * 缺省 4000ms（覆盖 GT-D 观测的 3159ms 并留余量）；可用 `RUN_EXIT_GRACE_MS` 覆盖（测试注入极小值）。
 * ⛔ 不得为 0：exit 与 result 的发布有竞态，立刻判会误报「exited 无 result」。
 */
export const DEFAULT_RUN_EXIT_GRACE_MS = 4000;

export function resolveRunExitGraceMs(): number {
  const v = Number(process.env.RUN_EXIT_GRACE_MS);
  if (Number.isFinite(v) && v > 0) return v;
  return DEFAULT_RUN_EXIT_GRACE_MS;
}

/**
 * E0c10 D4（GT-D）—— 轮询 agent 结果，区分三种结局：
 *   1. result 到达 ⇒ 返回 result（正常路径）。
 *   2. run 已 exited 且宽限后仍无 result ⇒ 抛 `RunExitedWithoutResultError`（上层捕获 ⇒
 *      记录诊断、标失败、继续本轮 tick；tick 仍以 0 退出）。GT-D 的核心情形。
 *   3. 超时且 run 未 exited ⇒ 抛 timeout 错误（bus 不可达 / 真挂起，判据 4 反向 ⇒ tick 非零退出）。
 *
 * triage（readResult）与 generate（readBody）两条生产轮询路径都走本函数（判据 4：两条路径都要）。
 * ⛔ 测试必须驱动真实的轮询读取路径，不得只 new 一个异常再自己 catch、不得只断言纯谓词（spec §2 判据 4）。
 *
 * @param readResult 每次 poll 读 result；返回非 null 即视为到达（null = 暂未到达）。
 * @param readExited 每次 poll 读 `agent.run.exited` 事件是否已观察到该 runId。
 * @param role 角色（诊断用：dr-triage / dr-debater-* / dr-synthesizer）。
 * @param buildTimeoutMessage 超时（run 未 exited，bus 不可达/真挂起）的错误消息构造器。
 *   保留各路径旧消息形态以兼容既有测试（R3a/R3b）。
 */
export async function pollForResultOrExit<T>(
  runId: string,
  role: string,
  opts: {
    readResult: () => Promise<T | null>;
    readExited: () => Promise<boolean>;
    timeoutMs: number;
    pollMs: number;
    exitGraceMs: number;
    buildTimeoutMessage: (runId: string, timeoutMs: number) => string;
  },
): Promise<T> {
  const start = Date.now();
  let exitedObservedAt: number | null = null;
  while (true) {
    const result = await opts.readResult();
    if (result !== null && result !== undefined) {
      return result;
    }
    const exited = await opts.readExited();
    const now = Date.now();
    if (exited && exitedObservedAt === null) {
      exitedObservedAt = now;
    }
    if (exitedObservedAt !== null && now - exitedObservedAt >= opts.exitGraceMs) {
      // GT-D：run 已 exited，宽限后仍无 result ⇒ 记录诊断并交上层处理（tick 继续以 0 退出）。
      throw new RunExitedWithoutResultError(runId, role, now - start);
    }
    if (now - start >= opts.timeoutMs) {
      // 判据 4 反向：bus 不可达 / 真挂起（run 未 exited，纯超时）⇒ 强类型超时错误。
      //    triage / generate 路径捕获到非 RunExitedWithoutResultError 一律 rethrow ⇒ tick 非零退出；
      //    worker（C5-fix3）路径捕获 RunResultTimeoutError 后逐 worker 回收并继续（tick 仍 0 退出）。
      throw new RunResultTimeoutError(
        runId,
        role,
        now - start,
        opts.buildTimeoutMessage(runId, opts.timeoutMs),
      );
    }
    await new Promise((r) => setTimeout(r, opts.pollMs));
  }
}

/**
 * C5-fix2 —— 识别「已 started 但尚未 exited」的在飞卡：板面持有 in_flight 卡、
 * runs 上观察到 `agent.run.started` 却还没有 `agent.run.exited` ⇒ 该 worker 仍在跑，
 * 其结果尚不可收割。若 tick 对这些卡直接返回（旧行为），round budget 会在 worker
 * （分钟级）出结果前耗尽，coverage 恒 0。纯函数：不碰 IO（spec B1）。
 */
function startedInFlightCards(state: BoardState): BoardCard[] {
  return state.cards.filter((c) => {
    if (c.status !== "in_flight") return false;
    if (!c.runId) return false;
    const run = state.runs[c.runId];
    return run !== undefined && run.state === "started";
  });
}

/**
 * C5-fix2 —— 对一张「已 started 未 exited」的在飞卡，复用既有 `pollForResultOrExit`/
 * 超时机制阻塞等待其 `worker.result.v1` 可读（bounded by 声明的结果超时），
 * 使本轮 tick 就能在结果落定后收割，而不是返回空手并触发下一轮。
 *
 * ⛔ 无忙等、无无限等待：由 `resolveAgentResultTimeout` / `resolveRunExitGraceMs` 约束。
 * ⛔ 结果到达 ⇒ 正常返回（上层据此置 exited(0) 并收割）。
 * ⛔ run 已 exited 但宽限后仍无 result ⇒ 抛 `RunExitedWithoutResultError`（上层诊断，tick 仍 0 退出）。
 * ⛔ run 未 exited、纯超时（bus 不可达 / 真挂起）⇒ 抛 timeout 错误（tick 非零退出，响亮失败）。
 */
async function waitForStartedWorker(card: BoardCard): Promise<void> {
  const runId = card.runId!;
  const role = roleForSources(card.sources) ?? "dr-worker";
  const { timeoutMs, pollMs } = resolveAgentResultTimeout();
  const exitGraceMs = resolveRunExitGraceMs();
  await pollForResultOrExit<WorkerResultV1>(runId, role, {
    readResult: () => readWorkerResult(runId),
    readExited: () => hasRunExited(runId),
    timeoutMs,
    pollMs,
    exitGraceMs,
    buildTimeoutMessage: (rid, tms) =>
      `C5-fix2: timed out waiting for worker result for run ${rid} — no worker.result.v1 found on board:agent-runs after ${tms}ms`,
  });
}

/**
 * C5-fix3 —— 一张 started 在飞 worker 的**逐 worker 结局**。与 C5-fix2 的
 * `waitForStartedWorker`（抛错形态）不同，本函数把三类结局折叠成值类型，**绝不因单个
 * worker 的 exit-without-result 或超时而抛出**，从而使 `runChannelWrite` 能以
 * `Promise.all` 并行轮询所有在飞 worker 且不互相连坐：
 *   - `ready`               —— worker.result.v1 已可读 ⇒ 上层标记 exited(0) 并收割；
 *   - `exited-without-result` —— run 已 exited、宽限后仍无 result ⇒ 上层记录诊断（响亮）；
 *   - `timed-out`           —— run 未 exited、超声明结果超时 ⇒ 上层记录诊断 + 回收该 clue。
 * ⛔ 其它意外错误（bus 不可达等）仍**原样抛出**（响亮失败、tick 非零退出），不会被吞成超时。
 */
type StartedWorkerOutcome =
  | { kind: "ready" }
  | { kind: "exited-without-result"; role: string; elapsedMs: number }
  | { kind: "timed-out"; role: string; elapsedMs: number };

async function pollStartedWorker(card: BoardCard): Promise<StartedWorkerOutcome> {
  const runId = card.runId!;
  const role = roleForSources(card.sources) ?? "dr-worker";
  try {
    await waitForStartedWorker(card);
    return { kind: "ready" };
  } catch (e) {
    if (isRunExitedWithoutResultError(e)) {
      return { kind: "exited-without-result", role: e.role, elapsedMs: e.elapsedMs };
    }
    if (isRunResultTimeoutError(e)) {
      return { kind: "timed-out", role: e.role, elapsedMs: e.elapsedMs };
    }
    throw e;
  }
}

/** v1 冻结只读 channel 前缀（spec §2 / §8：不得触碰）。 */
export const FROZEN_CHANNEL_PATTERNS = [
  /^research:loop-mcp-semantics\./,
  /^research:smoke-bus-semantics\./,
] as const;

export function isFrozenChannel(channelId: string): boolean {
  return FROZEN_CHANNEL_PATTERNS.some((re) => re.test(channelId));
}

/** A8f——`code-local` role（spec §1.2）。 */
export const CODE_LOCAL_ROLE = "dr-worker-code-local";

/** E2b——`content` role（E2b §1.1：content worker 要读 spool 文件，需 `allowed_root`）。 */
export const CONTENT_ROLE = "dr-worker-content";

// E1c D5 —— 原 `ROLES_REQUIRING_ALLOWED_ROOT`（= [code-local, content]）已删除：
//   E1b D2 之后 content 分支不再查它（content worker 的 allowed_root 是 spool 根，
//   由 `spoolContentTranscript` 现算，⛔ 不是 `--allowed-root`），code-local 分支直接比
//   `role === CODE_LOCAL_ROLE`。该常量既无引用点，其「content 需要 --allowed-root」的
//   注释又与现行契约（D2）矛盾——留着就是一个没人用又说错话的常量，故清除。

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
 * G7 —— 把 triage 语料序列化为字符串（`--prompt-file` 的文件内容）。
 * agent-run 的 prompt 只由 persona + `--prompt-file` 内容构成，`--input` 只作 schema 守卫、从不注入 prompt。
 * ⇒ 板面快照必须经 `--prompt-file` 投递，否则 role 交回空结果。
 * ⛔ 语料不进位置参数：Linux 单参数上限 128 KB（MAX_ARG_STRLEN），真实规模语料会触发 E2BIG。
 */
export function serializeTriageCorpusToPositional(corpus: TriageCorpus): string {
  return JSON.stringify(corpus);
}

/**
 * G7 —— 构造真实 triage agent-run 的完整 argv：
 * `agent-run --role dr-triage --run-id <id> --input <file> --prompt-file <promptFile>`
 * `--input` 只作 schema 守卫（校验完就扔、从不注入 prompt），语料正文经 `--prompt-file` 投递。
 * ⛔ 语料不进位置参数：Linux 单参数上限 128 KB（MAX_ARG_STRLEN），真实规模语料会触发 E2BIG。
 */
export function buildTriageArgv(opts: {
  agentRunBin: string;
  runId: string;
  inputPath: string;
  promptFile: string;
}): string[] {
  return [
    opts.agentRunBin,
    "--role",
    TRIAGE_ROLE,
    "--run-id",
    opts.runId,
    "--input",
    opts.inputPath,
    "--prompt-file",
    opts.promptFile,
  ];
}

/**
 * G7 —— 把 triage 语料写成 `--input` 载荷文件。
 * `--input` 只作 schema 守卫（校验完就扔、从不注入 prompt），⛔ 语料正文必须经 `--prompt-file` 投递。
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
 * G7 —— 生产默认 triage 派发：
 * 语料 → `--input` 载荷文件（schema 守卫） + `--prompt-file` 文件（语料正文）→ spawn agent-run。
 * 这是 `buildTriageArgv` 的**唯一生产调用点**。
 * ⛔ `spawnProcess` 必填且**无条件调用**。
 * 两个临时文件（`--input` + `--prompt-file`）的寿命绑定到本次派发：读回结果后**随即移除**。
 */
export async function spawnTriageRole(
  corpus: TriageCorpus,
  runtime: TriageSpawnRuntime,
): Promise<TriageResultDecision[]> {
  const inputPath = runtime.writeInputFile
    ? runtime.writeInputFile(corpus)
    : writeTriageInputFile(corpus);
  const serialized = serializeTriageCorpusToPositional(corpus);
  const promptFile = join(tmpdir(), `g7-triage-prompt-${randomUUID()}.txt`);
  writeFileSync(promptFile, serialized, "utf8");
  try {
    const argv = buildTriageArgv({
      agentRunBin: runtime.agentRunBin,
      runId: runtime.runId,
      inputPath,
      promptFile,
    });
    await runtime.spawnProcess(argv, { AGENT_RUN_BIN: runtime.agentRunBin });
    return await runtime.readResult(runtime.runId);
  } finally {
    rmSync(inputPath, { force: true });
    rmSync(promptFile, { force: true });
  }
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
 * A8f——一个 dispatch 决策映射到 `dr-worker-code-local`（读 repo 根下的源文件）而
 * `--allowed-root` 未配置 ⇒ 当场响亮失败（spec §1.2 / F5），
 * ⛔ 绝不照常 spawn（那会产出零证据且看起来正常）。错误文本点名 `allowed-root`。
 *
 * ⛔ E1b D2 / E1c D5——`dr-worker-content` **不**属于本错误的适用范围：content worker 的
 *    `allowed_root` 是 spool 根（由 `spoolContentTranscript` 现算），与 `--allowed-root` 无关；
 *    它的失败形态是 `ContentTranscriptMissingError`（该卡 blocked、零 spawn）。
 */
export class MissingAllowedRootError extends Error {
  constructor(role: string) {
    super(
      `A8f: dispatch mapped to "${role}" requires --allowed-root (the ${role} worker reads sources/spool files under the repo root). Refusing to spawn a zero-evidence worker.`,
    );
    this.name = "MissingAllowedRootError";
  }
}

/**
 * E1b D5——派发一条 `sources:["content"]` 的 clue 时，按 clue 携带的 digest 从
 * `research:content` 读不到 transcript（GT-2：transcript 从未被落到磁盘；D1 spool 取材失败）。
 *
 * 与 `MissingAllowedRootError` 的响亮纪律同构（spec §1 D5）：⛔ 不得静默跳过、⛔ 不得派一个
 * 必然产出零证据的 worker。该 clue 出生即/转为 `blocked`（rationale 点名 digest 与失败原因）、
 * 零 spawn。由 `runWrite` 的 dispatch catch 识别本错误后 CAS 该卡 → blocked（不 CAS 回 open）。
 */
export class ContentTranscriptMissingError extends Error {
  /** clue text 里携带的 digest（解析自 `web://<uri>@<digest>`，D3）。 */
  readonly digest: string;
  constructor(digest: string) {
    super(
      `E1b D5: content clue carries digest "${digest}" but no doc(transcript) found on research:content — cannot spool transcript for dr-worker-content. Blocking this clue (zero spawn) instead of dispatching a zero-evidence worker.`,
    );
    this.name = "ContentTranscriptMissingError";
    this.digest = digest;
  }
}

/**
 * E1b D1/D2——content worker 的 spool 根目录缺省（只在 opts.contentSpoolRoot 未配置时兜底）。
 *
 * ⛔ D7：spool 目录归属本 run，生产须由 profile 声明（`CONTENT_SPOOL_ROOT`），⛔ 不得写死
 *    绝对路径、⛔ 不得落 vault 根、⛔ 不得与 `.dd-evidence/**` / `.dev-dispatch/**` 冲突。
 *    本缺省仅用于「未配置时的可观测兜底」，生产装配（runChannelWrite）与测试均可显式注入。
 */
export const DEFAULT_CONTENT_SPOOL_ROOT = join(tmpdir(), "deep-research-content-spool");

/**
 * E1b D1——由 digest 派生 spool 文件名（确定性、跨 run 幂等：同 digest ⇒ 同文件名）。
 * 文件名只含 `[0-9a-f]` + 后缀，是任意文件系统安全的子集。
 */
export function spoolFileName(digest: string): string {
  return `${digest}.md`;
}

/**
 * E1b D1——spool 步骤的产物：transcript 落成本地文件后的路径（= content worker 的 allowed_root 指向的根下的文件）。
 * `spoolRoot` 即 content worker 的 `allowed_root`（D2）；`filePath` 是 transcript body 落点。
 */
export interface ContentSpoolResult {
  /** spool 根目录（= content worker 的 allowed_root，D2）。 */
  spoolRoot: string;
  /** transcript body 落成的本地文件绝对路径（D1）。 */
  filePath: string;
  /** 该 transcript 的 digest（来自 clue text，D3）。 */
  digest: string;
}

/**
 * E1b D1/D5——spool 步骤纯逻辑（无 IO 读取决策）：由 clue text 解析 digest。
 *
 * 派发一条 `sources:["content"]` 的 clue 前，先从 clue text（`web://<uri>@<digest>`，D3）
 * 解析出 digest。解析失败（非 content-clue 形态）⇒ 视为 transcript 不可定位 ⇒ D5 block。
 *
 * 纯函数（无 IO）：只做文本解析，便于直接断言。读取 transcript body 的 IO 在 `spoolContentTranscript`。
 */
export function parseDigestFromContentClue(clueText: string): string | null {
  const parsed = parseContentClueText(clueText);
  return parsed ? parsed.digest : null;
}

/**
 * E1b D1/D2/D5——spool 步骤：按 clue 携带的 digest 从 `research:content` 读 transcript body，
 * 落成 `<spoolRoot>/<digest>.md` 本地文件；返回 spool 结果（spool 根 = content worker 的 allowed_root）。
 *
 * 派发一条 `sources:["content"]` 的 clue **前**执行（GT-2：全仓原先零处把 transcript 落地）：
 *   1. 从 clue text 解析 digest（`web://<uri>@<digest>`，D3）；解析失败 ⇒ D5（抛 ContentTranscriptMissingError）。
 *   2. 按 digest 从 content channel 读 doc(transcript)（D1 取材）。
 *   3. 取不到 ⇒ D5（抛 ContentTranscriptMissingError，零 spawn，由 dispatch catch CAS → blocked）。
 *   4. 取到 ⇒ 把 body 落成 spool 文件（D1 落地）；返回 spool 根（= content worker 的 allowed_root，D2）。
 *
 * ⛔ D7：spoolRoot 归属本 run，须由 profile 声明（⛔ 不得落 vault 根 / `.dev-dispatch/**`）。
 *    本函数只在该目录下创建 `<digest>.md`，不向上越界。
 * ⛔ 幂等：同 digest ⇒ 同文件路径（spoolFileName 确定性），重复派发覆盖写同一文件（不堆积）。
 */
export async function spoolContentTranscript(opts: {
  clueText: string;
  contentChannelId: string;
  spoolRoot: string;
}): Promise<ContentSpoolResult> {
  const digest = parseDigestFromContentClue(opts.clueText);
  if (!digest) {
    // clue text 非content-clue 形态 ⇒ 无法定位 transcript ⇒ D5 block（rationale 点名失败原因）。
    throw new ContentTranscriptMissingError("");
  }
  const doc = await readExistingTranscript(
    (afterSeq) =>
      getMessages(
        opts.contentChannelId,
        afterSeq !== null ? { afterSeq } : {},
      ),
    digest,
  );
  if (!doc) {
    // transcript 取不到 ⇒ D5：零 spawn，由 dispatch catch CAS 该卡 → blocked（rationale 点名 digest）。
    throw new ContentTranscriptMissingError(digest);
  }
  const spoolRoot = opts.spoolRoot;
  mkdirSync(spoolRoot, { recursive: true });
  const filePath = join(spoolRoot, spoolFileName(digest));
  writeFileSync(filePath, doc.body, "utf8");
  return { spoolRoot, filePath, digest };
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
 * G4b —— trigger body 缺失/损坏 ⇒ 响亮失败（spec §1.2）。
 * ⛔ 静默回落到 0/0 = 计数器被无声重置 = 本缺陷（zeroGrowthRounds 无跨 tick 记忆）原样复发，
 *    而且更难查。首轮无前值由调用方显式传 0/0；body 一旦声称承载计数就必须可解析、字段齐全。
 */
export class TriggerBodyTerminationError extends Error {
  constructor(reason: string) {
    super(
      `G4b: trigger_body is missing or malformed termination counters (${reason}). Refusing to silently fall back to 0/0 — that would silently reset zeroGrowthRounds and re-introduce the very defect this package fixes. Pass valid {coverage, zeroGrowthRounds} (first tick legitimately uses 0/0, via a {"seed":true} body).`,
    );
    this.name = "TriggerBodyTerminationError";
  }
}

/** G4c —— --origin 未配置 ⇒ 响亮失败。 */
export class MissingOriginError extends Error {
  constructor() {
    super(
      "G4c: --origin is not configured. Refusing to silently skip the generation phase.",
    );
    this.name = "MissingOriginError";
  }
}

/** G4c —— --doc-channel 未配置 ⇒ 响亮失败。 */
export class MissingDocChannelError extends Error {
  constructor() {
    super(
      "G4c: --doc-channel is not configured. Refusing to silently default to a board channel.",
    );
    this.name = "MissingDocChannelError";
  }
}

/** G4c —— EXPORT_ROOT 未配置 ⇒ 响亮失败。 */
export class MissingExportRootError extends Error {
  constructor() {
    super(
      "G4c: EXPORT_ROOT is not configured. Refusing to silently skip the export.",
    );
    this.name = "MissingExportRootError";
  }
}

// E0c10 D4 —— 「run exited 无 result」的错误与诊断类型定义在 ./run-exit-diagnostic（避免
//   generate.ts ↔ tick-run.ts 循环 import）。此处 re-export，保持调用方 import 路径不变。
export {
  RunExitedWithoutResultError,
  type RunExitWithoutResultDiagnostic,
  isRunExitedWithoutResultError,
} from "./run-exit-diagnostic";

/**
 * G4b —— 从 trigger body 字符串解析 {coverage, zeroGrowthRounds}（spec §1.2）。
 *
 * 约定（spec §1.2 表）：
 *   - 续投写出的 trigger body 形如 `{"tick":true,"coverage":<n>,"zeroGrowthRounds":<m>}`。
 *   - 首个 seed 触发的 body 形如 `{"seed":true}`（无计数字段）⇒ 首轮语义（prev=0/0）。
 *
 * ⛔ 本函数是 trigger body 计数的**唯一权威解析器**（attempt 2 评审 minor finding：
 *    生产路径原先用 tick.md 内嵌的 node 脚本另写一份解析，与本 TS 解析器可静默发散。
 *    attempt 2 起 tick.md 改为通过 tick-entry `--parse-trigger-body` 调用本函数，单源真相）。
 *
 * ⛔ 首轮判定基于 **seed 标记**，而非「无计数字段」（attempt 2 评审 minor finding）：
 *    一个丢了计数器的续投 body（如 `{"tick":true}`）不再被静默当作首轮 0/0——
 *    那会让 zeroGrowthRounds 被无声重置，正是 R5 禁止的静默回落形态。只有显式
 *    `seed:true` 才认定首轮；其余无计数 body 一律响亮失败。
 *
 * 契约（spec §1.2 R5）：
 *   - body 空/undefined ⇒ 抛。
 *   - body 非 JSON / 非对象 ⇒ 抛。
 *   - body 含 `seed:true` ⇒ 首轮语义，返回 `{prevCoverage:0, prevZeroGrowthRounds:0, firstRound:true}`。
 *   - body 不含 `seed:true` 时，`coverage` / `zeroGrowthRounds` **必须齐全且为非负整数**，否则抛。
 *
 * @param body trigger body 字符串（loop-engine `claim.bind` 把 `body` 绑进 pipeline input）。
 * @returns 解析出的 {prevCoverage, prevZeroGrowthRounds, firstRound}。
 */
export function parseTerminationFromBody(
  body: string | undefined | null,
): { prevCoverage: number; prevZeroGrowthRounds: number; firstRound: boolean } {
  if (body === undefined || body === null || body === "") {
    throw new TriggerBodyTerminationError("body is empty/undefined");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch (e) {
    throw new TriggerBodyTerminationError(
      `body is not valid JSON: ${(e as Error).message}`,
    );
  }
  if (parsed === null || typeof parsed !== "object") {
    throw new TriggerBodyTerminationError("body is not a JSON object");
  }
  const obj = parsed as Record<string, unknown>;
  // ⛔ 首轮判定基于 seed 标记：只有显式 {"seed":true} 才认定首轮（返回 0/0 + firstRound:true）。
  //    续投 body 丢了计数器（如 {"tick":true}）不被当成首轮 ⇒ 落到下面的字段校验并响亮失败。
  if (obj.seed === true) {
    return { prevCoverage: 0, prevZeroGrowthRounds: 0, firstRound: true };
  }
  const cov = obj.coverage;
  const zgr = obj.zeroGrowthRounds;
  if (cov === undefined || zgr === undefined) {
    throw new TriggerBodyTerminationError(
      "body is missing coverage/zeroGrowthRounds fields (and is not a seed body {seed:true}); a continuation body that lost its counters would silently reset zeroGrowthRounds — refusing",
    );
  }
  if (
    typeof cov !== "number" ||
    !Number.isFinite(cov) ||
    cov < 0 ||
    !Number.isInteger(cov)
  ) {
    throw new TriggerBodyTerminationError(
      `coverage is not a non-negative finite integer (got ${JSON.stringify(cov)})`,
    );
  }
  if (
    typeof zgr !== "number" ||
    !Number.isFinite(zgr) ||
    zgr < 0 ||
    !Number.isInteger(zgr)
  ) {
    throw new TriggerBodyTerminationError(
      `zeroGrowthRounds is not a non-negative finite integer (got ${JSON.stringify(zgr)})`,
    );
  }
  return { prevCoverage: cov, prevZeroGrowthRounds: zgr, firstRound: false };
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
   * 喂入引擎组装的板面快照语料，回收 `dr-triage.result.v1` 决策列表与 runId。
   * ⛔ 遇 triage 决策必须**无条件调用**（§1.3 / T7）；缺省经 `triageSpawnRuntime`
   *   （其 `spawnProcess` 必填）。两者都不提供时遇 triage 决策 ⇒ 响亮失败，绝不静默跳过。
   */
  spawnTriage?: (corpus: TriageCorpus) => Promise<{ decisions: TriageResultDecision[]; runId: string }>;
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
            // E1c D1——把**调度器侧**的 clue 文本一并下传：content-clue 的 text 携带
            //   `web://<uri>@<digest>`，是 content evidence 锚点的唯一可信来源（GT-1b）。
            text: decision.text,
            depth: decision.depth,
            sources: decision.sources,
          },
          decision.runId,
          budget,
        );
        harvestReports.push(report);
        if (report.noResultBlocked) {
          // C5-fix4 ⭐⭐⭐——该卡 run 已 exit（exit 0）且宽限窗口内仍无 worker.result.v1：
          //   no_result 必须终态化，绝不无限 in_flight（否则 decideTermination 被 inFlight>0
          //   永久卡死、generate 永不触发 —— C5 冷启动判别签名）。CAS in_flight → blocked，
          //   rationale 点名 run_id / exit_code / 缺 result / 宽限时长（机器可读，判别性规格 §四.1）。
          //   ⛔ 不 CAS 到 explored（找不到结果 ≠ 无产出，A10a §0.3）：blocked 才是响亮终态。
          const result = await perform({
            clueId: decision.clueId,
            to: "blocked",
            from: "in_flight",
            rationale: report.noResultRationale,
          });
          casResults.push({
            clueId: decision.clueId,
            to: "blocked",
            success: result.success,
            error: result.error,
          });
          break;
        }
        if (report.isolated) {
          // C5 ⭐⭐⭐——本卡含退化 evidence（缺 source/locator/revision 的条目已被单条隔离、
          //   不发布）：**该卡**隔离为 blocked（判据 3），绝不 CAS 到 explored。
          //   rationale 点名缺失字段与 run_id/clue_id（harvestCard 已装配好）。
          //   ⛔ 单卡语义：只 CAS 本卡到 blocked，同 tick 其余 harvest 卡照常收割/explored。
          const result = await perform({
            clueId: decision.clueId,
            to: "blocked",
            from: "in_flight",
            rationale: report.isolationRationale,
          });
          casResults.push({
            clueId: decision.clueId,
            to: "blocked",
            success: result.success,
            error: result.error,
          });
          break;
        }
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
            //    A8f/E2b：需要 `allowed_root` 的 role（code-local / content）无 `allowed_root`
            //    同样属配置错误 ⇒ 响亮失败（点名 allowed-root），不 CAS 回 open、不静默产出零证据
            //    （spec §1.2 / F5 / E2b §1.1 W3）。
            if (
              err instanceof AgentRunUnresolvedError ||
              err instanceof MissingAllowedRootError
            ) {
              throw err;
            }
            // E1b D5——content clue 的 transcript 取不到 ⇒ 该 clue 转为 blocked（rationale 点名
            //    digest 与失败原因）、⛔ 零 spawn（与既有 MissingAllowedRootError 的响亮纪律同构，
            //    但这里是「单卡 blocked」而非「整轮响亮抛错」：transcript 缺失是该卡自己的问题，
            //    不应阻断同 tick 其余卡）。CAS in_flight → blocked；⛔ 不 CAS 回 open（那会重派一个
            //    必然零证据的 worker）。spawned:false 记录零 spawn。
            if (err instanceof ContentTranscriptMissingError) {
              const rationale =
                err.digest === ""
                  ? "content clue text is not in the web://<uri>@<digest> form; cannot locate transcript (spec E1b D5)"
                  : `content clue carries digest "${err.digest}" but no doc(transcript) found on research:content; cannot spool transcript for dr-worker-content (spec E1b D5)`;
              const block = await perform({
                clueId: decision.clueId,
                to: "blocked",
                from: "in_flight",
                rationale,
              });
              casResults.push({
                clueId: decision.clueId,
                to: "blocked",
                success: block.success,
                error: block.error,
              });
              spawns.push({
                clueId: decision.clueId,
                role: decision.role,
                runId,
                spawned: false,
              });
              break;
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
        // block 决策源自 open 卡（invalid_sources / unmapped_source）⇒ 前置条件为 open。
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
            return spawnTriageRole(corp, deps.triageSpawnRuntime).then(
              (decisions) => ({ decisions, runId: deps.triageSpawnRuntime!.runId }),
            );
          });
        const { decisions: triageDecisions, runId: triageRunId } = await spawnTriage(corpus);
        const proposedIds = new Set(decision.proposedClues.map((c) => c.clueId));
        const applied = await applyTriageBatch(
          deps,
          { writes, maxWrites },
          proposedIds,
          triageDecisions,
          triageRunId,
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
  runId: string,
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
        runId,
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
      runId,
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
   * G4b —— 上一 tick 的覆盖度（spec §1.2：跨 tick 传递 `prevCoverage`）。
   * 生产由 tick.md 从 `{{trigger_body}}` 解析后以 `--prev-coverage` 传入；首轮无前值传 0。
   * ⛔ 一旦 trigger body 声称承载计数就必须可解析（见 parseTerminationFromBody），
   *    不得静默回落 0/0（会无声重置 zeroGrowthRounds，本包根因复发）。
   */
  prevCoverage?: number;
  /**
   * G4b —— 上一 tick 结束时的零增长轮数（spec §1.2：跨 tick 传递 `prevZeroGrowthRounds`）。
   * 生产由 tick.md 从 `{{trigger_body}}` 解析后以 `--prev-zero-growth` 传入；首轮无前值传 0。
   */
  prevZeroGrowthRounds?: number;
  /**
   * G4c —— 研究 origin（report 的 origin 字段；进入 runGenerate 的 readOrigin）。
   * 生产由 tick.md 从 `{{research_origin}}` 以 `--origin` 传入。
   * ⛔ 缺失时生成段不执行。
   */
  origin?: string;
  /**
   * G4c —— doc channel（research.doc.v2 的发布 channel）。
   * 生产由 tick.md 从 `{{doc_channel}}` 以 `--doc-channel` 传入。
   * ⛔ 不得静默回退到板 channel（append-only 不可回退）。
   */
  docChannelId?: string;
  /**
   * E1 D2/D4——content channel（doc(transcript) 的发布/去重 channel）。
   * 缺省 `CONTENT_CHANNEL_ID`（`research:content`）。
   * ingest 把 doc(transcript) 发到这条 channel，并以权威 digest 做全局去重（D2）。
   */
  contentChannelId?: string;
  /**
   * E1b D1/D2/D7——content worker 的 spool 根目录（= content worker 的 allowed_root）。
   *
   * 派发一条 `sources:["content"]` 的 clue 前，按 clue 携带的 digest 从 `research:content`
   * 读到 transcript body，落成 `<contentSpoolRoot>/<digest>.md` 本地文件（D1）；content worker
   * 的 `allowed_root` 就是这个 spool 根（D2：⛔ 不是 `--allowed-root` 那个代码仓根）。
   *
   * 生产由 profile 声明（`CONTENT_SPOOL_ROOT`，D7：⛔ 不得落 vault 根 / `.dev-dispatch/**`），
   * 经 tick-entry `--content-spool-root` 传入；缺省 `DEFAULT_CONTENT_SPOOL_ROOT`（tmpdir 下，
   * 仅供未配置时的可观测兜底）。
   */
  contentSpoolRoot?: string;
  /**
   * G4c —— 一次性标记文件目录（跨进程持久）。
   * 缺省 `join(tmpdir(), "deep-research-generated")`。
   */
  oneShotDir?: string;
  /**
   * G4c —— 注入的 generate deps（测试用）；缺省走生产 `assembleGenerateDeps`。
   * 注入后 `assembleGenerateDeps` 不执行。
   */
  generateDeps?: GenerateDeps;
  /**
   * E0c3b §1.1 —— triage 触发阈值（--triage-threshold）；缺省 DEFAULT_TICK_CONFIG.triageThreshold。
   */
  triageThreshold?: number;
  /**
   * C5 —— 本轮是否为 round 预算耗尽（最后一轮，max_passes 推导预算已触顶）。
   * 为 true 时：
   *   - decideTick 把「started 但超预算仍未 exit」的在飞卡 bounded-terminalize 到 blocked；
   *   - decideTermination 在板面未排空时产出响亮非收敛 reason（点名 in_flight/proposed/open）；
   *   - 生成段依此收口（有报告则出口 0，无报告则 drain 层按退出契约响亮非零）。
   * 生产由 bin/deep-research-loop.sh 在撞预算的最后一轮导出（BUDGET_EXHAUSTED=1 →
   * tick.md → tick-entry --budget-exhausted）；测试直接注入。
   */
  budgetExhausted?: boolean;
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
   * G4b —— 本 tick 的终止判定（spec §1.1：用本轮真实板面调用 decideTermination）。
   * 与 `hasPendingWork` 并列出现在 `--run` 的 JSON 输出里。续投时把
   * `termination.coverage` / `termination.zeroGrowthRounds` 写进下一条 trigger 的 body。
   */
  termination: TerminationState;
  /**
   * C5 —— 本轮生效的 drain 退出契约（预算耗尽 + 未排空 + 报告未生成 ⇒ 非零退出 + reason）。
   * run 级响亮收口：预算耗尽的最后一轮产出，供 drain/哨兵据此写非零退出 + reason 落盘
   * （判别性规格 §四.1；判别测试 3 直接驱动 decideDrainExit 断言三个计数 + exit_code!=0）。
   */
  drainExit: DrainExitContractResult;
  /**
   * E0c3b §1.1 —— 本轮生效的 triage 触发阈值（来自 profile 或缺省值）。
   */
  triageThreshold: number;
  /**
   * E1c D6 —— 本轮**实际生效**的 content spool 根（`--content-spool-root`，缺省
   * `DEFAULT_CONTENT_SPOOL_ROOT`）。E1b D7 要求 spool 落位写进 profile **与运行记录**；
   * profile 侧已交付，但运行记录此前看不出 transcript 落在哪。本字段随 `--run` 的 JSON
   * 输出（tick-entry 直接 `JSON.stringify(outcome)`）落进运行记录，使人能定位 spool 文件。
   */
  contentSpoolRoot: string;
  /**
   * E0c10 D4（GT-D）—— 本轮观察到的「run exited 无 result」诊断列表。
   * 每条含 run_id / role / 已等时长 / phase（triage|generate）。tick 仍以 0 退出；
   * 该 doc/clue 被标成失败（未发布 / 未 CAS），不静默当成功（GT-D）。
   */
  diagnostics: RunExitWithoutResultDiagnostic[];
  /**
   * E0c10 D6 —— 本轮 tick 的分阶段耗时（ms）。覆盖整个 tick（含 generate 段），
   * 用于 D1 的依据溯源（spec §2 判据 7：数字必须可溯源到具体字段）。
   */
  timings: TickTimings;
}

/**
 * E0c10 D6 —— 一次 tick 的分阶段耗时（ms）。各阶段可溯源到具体字段（spec §2 判据 7）。
 * `total` 覆盖整个 tick（从 runChannelWrite 入口到返回），含 generate 段；用于 D1 依据。
 */
export interface TickTimings {
  /** 读板 + 组装（readChannelMessages / assembleBoard）耗时。 */
  readBoardMs: number;
  /** 决策（decideTick）耗时。 */
  decideMs: number;
  /** 写侧执行（runWrite：CAS/spawn/收割/triage）耗时。 */
  writeMs: number;
  /** 终止判定（decideTermination）耗时。 */
  terminationMs: number;
  /** 生成段（runGenerate，含 anchor-check/export）耗时；未运行 generate 为 0。 */
  generateMs: number;
  /** 整个 tick 的总耗时（从 runChannelWrite 入口到返回前）。≥ 上述各项之和。 */
  totalMs: number;
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
 * G4c —— 组装生成段的生产依赖注入。
 * 提供 runGenerate 所需的全部副作用（读终态/blocked 计数/question/origin/evidences、
 * spawnRole/spawnRuntime、anchorCheck/export/writeDoc/lockSynthesizer）。
 */
export function assembleGenerateDeps(
  opts: RunWriteOptions,
  termination: TerminationState,
  postWriteState: BoardState,
): GenerateDeps {
  const synthLockDir = opts.oneShotDir ?? join(tmpdir(), "deep-research-generated");
  // E0c10 D4 —— runId → role 映射：spawnProcess 抽取 argv 的 --role/--run-id 存入，
  //   供 readBody 在 run exited 无 result 时抛出带 role 的诊断（GT-D）。
  const roleByRunId = new Map<string, string>();
  return {
    readTermination: async () => termination,
    countBlocked: async () =>
      postWriteState.cards.filter((c) => c.status === "blocked").length,
    readQuestion: async () => {
      if (opts.question) return opts.question;
      throw new Error("G4c: no question configured for the generation phase");
    },
    readOrigin: async () => {
      if (!opts.origin) throw new MissingOriginError();
      return opts.origin;
    },
    readEvidences: async (): Promise<EvidenceView[]> => {
      if (!opts.evidenceChannelId) return [];
      const msgs = await readChannelMessages(opts.evidenceChannelId);
      return msgs
        .filter((m) => m.kind === "research.evidence.v2")
        .map((m) => {
          const p = (m.payload ?? {}) as Record<string, unknown>;
          return {
            clue_id: String(p.clue_id ?? ""),
            anchor: String(p.anchor ?? ""),
            quote: String(p.quote ?? ""),
            claim: String(p.claim ?? ""),
          };
        });
    },
    spawnRole: undefined,
    spawnRuntime: {
      get agentRunBin() { return opts.workerCmd ?? resolveAgentRunBin(); },
      newRunId: () => randomUUID(),
      // E0c10 D4 —— 记录每个 runId 对应的 role，供 readBody 在抛 RunExitedWithoutResultError 时
      //   带上 role（诊断必含，GT-D）。spawnProcess 的 argv 含 --role <role> --run-id <runId>，
      //   在此抽出来存进 roleByRunId；readBody 据此查 role。
      spawnProcess: async (argv, env) => {
        const roleIdx = argv.indexOf("--role");
        const runIdIdx = argv.indexOf("--run-id");
        if (roleIdx >= 0 && runIdIdx >= 0) {
          roleByRunId.set(argv[runIdIdx + 1], argv[roleIdx + 1]);
        }
        await spawnWorkerProcess({
          cmd: argv[0],
          args: argv.slice(1),
          env,
          onExit: () => {},
        });
        return {};
      },
      readBody: async (runId: string) => {
        const { timeoutMs, pollMs } = resolveAgentResultTimeout();
        const exitGraceMs = resolveRunExitGraceMs();
        const role = roleByRunId.get(runId) ?? "dr-generate";
        return await pollForResultOrExit(runId, role, {
          readResult: async () => {
            const r = await readGenerateResult(runId);
            return r ? r.body : null;
          },
          readExited: () => hasRunExited(runId),
          timeoutMs,
          pollMs,
          exitGraceMs,
          buildTimeoutMessage: (rid, _tms) =>
            `G4c: timed out waiting for generate result for run ${rid}`,
        });
      },
    },
    spawnAnchorCheck: async (): Promise<AnchorCheckResult> => {
      const anchorCheckBin = process.env.ANCHOR_CHECK_BIN;
      if (!anchorCheckBin) {
        throw new Error(
          "G4d: ANCHOR_CHECK_BIN is not configured — anchor-check is unavailable",
        );
      }
      const allowedRoot = opts.allowedRoot;
      if (!allowedRoot) {
        throw new MissingAnchorCheckRepoRootError();
      }
      const corpusFile = join(tmpdir(), `anchor-check-corpus-${randomUUID()}.json`);
      try {
        const evidences = await (async (): Promise<EvidenceView[]> => {
          if (!opts.evidenceChannelId) return [];
          const msgs = await readChannelMessages(opts.evidenceChannelId);
          return msgs
            .filter((m) => m.kind === "research.evidence.v2")
            .map((m) => {
              const p = (m.payload ?? {}) as Record<string, unknown>;
              return {
                clue_id: String(p.clue_id ?? ""),
                anchor: String(p.anchor ?? ""),
                quote: String(p.quote ?? ""),
                claim: String(p.claim ?? ""),
              };
            });
        })();
        writeFileSync(corpusFile, JSON.stringify(evidences), "utf8");
        return (() => {
          let stdout: string;
          let exitCode: number | null;
          try {
            stdout = execFileSync(anchorCheckBin, [
              "--corpus", corpusFile,
              "--repo-root", allowedRoot,
              "--json",
            ], {
              encoding: "utf8",
              stdio: ["ignore", "pipe", "pipe"],
              timeout: 30000,
            });
            exitCode = 0;
          } catch (e: any) {
            if (e.stdout != null) {
              try {
                return JSON.parse(e.stdout) as AnchorCheckResult;
              } catch (_) {}
            }
            exitCode = e.status != null ? e.status : null;
            const stderrTail = e.stderr != null ? String(e.stderr).slice(-200) : "";
            const exitLabel = exitCode != null ? `exit ${exitCode}` : "killed";
            const cause = e.message ? `: ${String(e.message).slice(0, 200)}` : "";
            throw new Error(`anchor-check ${exitLabel}${cause} stderr:${stderrTail}`);
          }
          try {
            return JSON.parse(stdout) as AnchorCheckResult;
          } catch (_) {
            throw new Error(`anchor-check exit ${exitCode}: stdout is not valid JSON`);
          }
        })();
      } finally {
        rmSync(corpusFile, { force: true });
      }
    },
    writeAnchorCheckJson: async (json: string) => {
      const exportRoot = process.env.EXPORT_ROOT;
      if (!exportRoot) {
        throw new MissingExportRootError();
      }
      const topic = opts.question ?? "untitled";
      const slug = slugify(topic);
      const dir = join(exportRoot, "DeepThought", slug);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "anchor-check.json"), json, "utf8");
    },
    spawnExport: async (reportBody: string, sourceMessageId: string) => {
      const exportRoot = process.env.EXPORT_ROOT;
      if (!exportRoot) throw new MissingExportRootError();
      if (!opts.docChannelId) throw new MissingDocChannelError();
      if (!opts.question) {
        throw new Error(
          "G4c: no question configured for the export topic — refusing to fabricate a stand-in topic",
        );
      }
      const docMessages = await readChannelMessages(opts.docChannelId);
      const docMsg = docMessages.find((m) => m.message_id === sourceMessageId);
      if (!docMsg) {
        throw new Error(
          `G4c: cannot find doc message ${sourceMessageId} in channel ${opts.docChannelId} for export createdAt`,
        );
      }
      const report: DocV2 = {
        doc_kind: "report",
        body: reportBody,
        digest: createHash("sha256").update(reportBody).digest("hex"),
        origin: opts.origin!,
      };
      const input: ExportInput = {
        report,
        sourceMessageId,
        createdAt: docMsg.created_at,
        topic: opts.question,
      };
      await runExport(
        {
          writeFile: async (path: string, content: string) => {
            writeFileSync(path, content, "utf8");
          },
        },
        input,
        exportRoot,
      );
    },
    writeDoc: async (doc, idempotencyKey) => {
      if (!opts.docChannelId) throw new MissingDocChannelError();
      const result = await publishDoc(opts.docChannelId, doc, idempotencyKey);
      return result.message_id;
    },
    lockSynthesizer: async () => {
      mkdirSync(synthLockDir, { recursive: true });
      const lockPath = join(synthLockDir, "synthesizer.lock");
      while (true) {
        try {
          closeSync(openSync(lockPath, "wx"));
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      return async () => {
        rmSync(lockPath, { force: true });
      };
    },
    readDocs: async (origin: string) => {
      if (!opts.docChannelId) return [];
      const msgs = await readChannelMessages(opts.docChannelId);
      return msgs
        .filter((m) => m.kind === "research.doc.v2")
        .map((m) => {
          const p = (m.payload ?? {}) as DocV2;
          return { doc: p, messageId: m.message_id };
        })
        .filter((d) => d.doc.origin === origin);
    },
  };
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
  // E0c10 D6 —— 分阶段耗时（ms），覆盖整个 tick（含 generate 段）。各字段可溯源（spec §2 判据 7）。
  const _t0 = Date.now();
  let _tReadBoard = 0;
  let _tDecide = 0;
  let _tWrite = 0;
  let _tTerm = 0;
  let _tGen = 0;
  if (isFrozenChannel(opts.channelId)) {
    throw new FrozenChannelError(opts.channelId);
  }
  // E0c10 D4 —— 收集「run exited 无 result」诊断（triage / generate 两路径）。
  const diagnostics: RunExitWithoutResultDiagnostic[] = [];
  const nonce = randomUUID();
  const runsChannelId = opts.runsChannelId ?? RUNS_CHANNEL_ID;
  const messages = await readChannelMessages(opts.channelId);
  // A8e——`board:agent-runs` 只分页读一次，同时喂给 runs 归集与每张卡的 worker.result
  //   查询（评审 note：readWorkerResult 原先每张 harvest 卡把整个 channel 再分页一遍，
  //   这是 O(cards x channel) 的读放大；这里复用同一份已读消息列表）。
  let runsMessages = await readChannelMessages(runsChannelId);
  let runs = buildRunsFromMessages(runsMessages);
  const assembled = assembleBoard(messages, runs);
  // ⛔（attempt 2 major finding）coverage 的原料 coveredClueIds 必须取自**证据真正发布到的
  //   channel**。生产 harvest 把 research.evidence.v2 发到独立的 EVIDENCE_CHANNEL
  //   （profiles/deploy/agent-harness.env: research:agent-harness.evidence，与板 channel
  //   research:agent-harness.index 不同），而 --run 路径原先只读板 channel ⇒ 覆盖度
  //   在生产结构性恒为 0、'coverage > prevCoverage' 永不成立、zeroGrowthRounds 无条件递增，
  //   R3 断言的「覆盖增长 ⇒ 重置」分支在生产不可达。这里显式读证据 channel 并把其
  //   research.evidence.v2 的 clue_id 并入覆盖集合；证据 channel 未配置时退化为仅板 channel
  //   的覆盖（保持单 channel 测试场景的既有行为；生产配置总是显式传入 evidence channel）。
  const evidenceChannelId = opts.evidenceChannelId;
  let coveredClueIds = assembled.coveredClueIds;
  if (evidenceChannelId && evidenceChannelId !== opts.channelId) {
    const evidenceMessages = await readChannelMessages(evidenceChannelId);
    const extra = collectEvidenceClueIds(evidenceMessages);
    if (extra.length > 0) {
      const merged = new Set([...coveredClueIds, ...extra]);
      coveredClueIds = [...merged];
    }
  }
  const state = assembled.state;

  // C5-fix2 —— 对「已 started 未 exited」的在飞卡阻塞等待其结果，使本轮 tick 就能收割，
  // 而不是返回空手再触发下一轮（旧行为 ⇒ round budget 耗尽、coverage 恒 0、max_rounds 死锁）。
  // C5-fix3 —— 逐 worker 独立收割：并行轮询每张在飞卡，任一 worker 的 exit-without-result
  // 或声明超时**只回收/标败它自己**，绝不毙掉整 tick 或阻塞其它 worker 的收割（根因：
  // 一个慢 worker 超时曾让整 tick 以 exit=2 失败，连带丢失已就绪 worker 的结果）。
  const startedCards = startedInFlightCards(state);
  if (startedCards.length > 0) {
    const exited0 = new Set<string>();
    const timedOut = new Set<string>();
    const outcomes = await Promise.all(
      startedCards.map((card) => pollStartedWorker(card)),
    );
    for (let i = 0; i < outcomes.length; i += 1) {
      const card = startedCards[i];
      const runId = card.runId!;
      const outcome = outcomes[i];
      if (outcome.kind === "ready") {
        exited0.add(runId);
      } else if (outcome.kind === "exited-without-result") {
        // run 已 exited 但宽限后仍无 result ⇒ 诊断并继续（tick 仍 0 退出，GT-D 同构）。
        diagnostics.push({
          runId,
          role: outcome.role,
          elapsedMs: outcome.elapsedMs,
          phase: "worker",
          reason: "exited-without-result",
        });
      } else {
        // 声明结果超时（run 未 exited）⇒ 响亮诊断 + 逐 worker 回收（标记为 exited(1)，
        //    使 decideTick 走既有 reclaim 路径把它 CAS 回 open），tick 继续收割其它就绪结果。
        diagnostics.push({
          runId,
          role: outcome.role,
          elapsedMs: outcome.elapsedMs,
          phase: "worker",
          reason: "result-timeout",
        });
        timedOut.add(runId);
      }
    }
    // 结果 / exited 事件是异步落 channel 的：重新读一次 runs channel，拿到等待期间抵达的
    // worker.result.v1 与 agent.run.exited；并对「已拿到结果的卡」权威补 exited(0)
    // （worker 可能先发 result 再发 exited，此竞态下由我们先补齐，decideTick 才发 harvest）、
    // 对「声明超时的卡」标记 exited(1)（使 decideTick 逐 worker 回收其 clue）。
    runsMessages = await readChannelMessages(runsChannelId);
    runs = buildRunsFromMessages(runsMessages);
    for (const id of exited0) {
      runs[id] = { state: "exited", exitCode: 0 };
    }
    for (const id of timedOut) {
      runs[id] = { state: "exited", exitCode: 1 };
    }
    state.runs = runs;
  }

  _tReadBoard = Date.now() - _t0;
  // E0c10 D5 —— maxClues 也进 tickConfig（不仅喂 harvest 的封顶），否则 decideTermination
  //   的 capHit 判定（count >= cfg.maxClues）永远用缺省 64，--max-clues 对终态毫无影响，
  //   装配链只接到一半（spec §2 判据 5：断言 max_clues 真的传到了 tick，含终态判定）。
  const maxDepth = opts.maxDepth ?? DEFAULT_TICK_CONFIG.maxDepth;
  const maxClues = opts.maxClues ?? DEFAULT_TICK_CONFIG.maxClues;
  // E1c D6 —— 本轮生效的 spool 根只解析**一次**：派发 content clue 时用它落 transcript，
  //   运行记录（RunWriteOutcome.contentSpoolRoot）报的也是它。⛔ 两处不得各自 `??` 兜底，
  //   否则运行记录可能报一个与实际落盘位置不同的路径（那比不报还坏）。
  const contentSpoolRoot = opts.contentSpoolRoot ?? DEFAULT_CONTENT_SPOOL_ROOT;
  const tickConfig = {
    ...DEFAULT_TICK_CONFIG,
    ...(opts.triageThreshold !== undefined ? { triageThreshold: opts.triageThreshold } : {}),
    ...(opts.maxClues !== undefined ? { maxClues: opts.maxClues } : {}),
    ...(opts.maxDepth !== undefined ? { maxDepth: opts.maxDepth } : {}),
  };
  const _tDecideStart = Date.now();
  // C5 —— round 预算耗尽时，把 started-超预算在飞卡 bounded-terminalize 到 blocked（判别性规格 §四.2）。
  const decisions = decideTick(
    state,
    tickConfig,
    opts.budgetExhausted === true ? { budgetExhausted: true } : undefined,
  );
  _tDecide = Date.now() - _tDecideStart;
  // E1 D7——本 tick 内所有 material 的 MinerU 调用共享同一个 createMutex（spec §1 D7：
  //   「N 条 material 同时到达，任一时刻在飞 MinerU 调用 = 1」）。⚠️ 评审 major finding：
  //   原实现把 serialize 参数省略 ⇒ ingestMaterialImpl 为每条 material 各 new 一个 createMutex，
  //   in-flight===1 仅靠 harvest for-loop 的顺序 await 成立，starred D7 断言只覆盖 ingestBatch
  //   （无生产调用者）。这里把单一 mutex 注入生产装配链，使 D7 的串行化真正由 base 的 createMutex
  //   语义保证（删除它 ⇒ 并发 > 1）。
  const ingestSerialize = createMutex();
  // A8e——maxDepth/maxClues 取配置（不硬编码，spec §6）。
  const deps: WriteDeps = {
    cas: (input) => realCas(opts.channelId, input, nonce),
    spawnWorker:
      opts.spawnWorker ??
      (async (clueId, role, runId, input) => {
        // E1b D1/D2/D5——content role：派发前先把 transcript 落成本地文件（spool），content worker
        //    的 allowed_root = spool 根（D2：⛔ 不是 --allowed-root 那个代码仓根）；transcript 取不到 ⇒ 抛
        //    ContentTranscriptMissingError，由 runWrite 的 dispatch catch CAS 该卡 → blocked、零 spawn（D5）。
        //    ⛔ content 的 revision 不得再取代码仓的 HEAD（GT-1：那与 transcript 无关）；transcript 的
        //      内容指纹已由 clue text 携带（`web://<uri>@<digest>`，D3），spool 文件即权威可复读来源。
        if (role === CONTENT_ROLE) {
          const spool = await spoolContentTranscript({
            clueText: input.clue_text,
            contentChannelId: opts.contentChannelId ?? CONTENT_CHANNEL_ID,
            spoolRoot: contentSpoolRoot,
          });
          // D2：content worker 的 allowed_root = spool 根（⛔ 不是 opts.allowedRoot）。
          //   revision 省略（⛔ 不取代码仓 HEAD：GT-1）；content worker 读 spool 文件即可定位 transcript。
          const augmented = buildWorkerInput(
            input.clue_id,
            input.clue_text,
            input.depth,
            input.sources,
            spool.spoolRoot,
          );
          return spawnAgentRunWorker({
            agentRunBin: opts.workerCmd ?? resolveAgentRunBin(),
            role,
            runId,
            input: augmented,
            allowedRoot: spool.spoolRoot,
          }).then(() => undefined);
        }
        // A8f——code-local 需要 allowed_root（读 repo 根下源文件）；未配置 ⇒ 响亮失败零 spawn
        //    （spec §1.2 / F5）。⛔ code-local 的 allowed_root / revision 行为逐字不变（仍是代码仓根
        //    + git rev-parse HEAD，D2 回归）。其余 role（wiki / feishu / code-remote / web-search）
        //    不需要 allowed_root，照常 spawn（F7）。
        if (role === CODE_LOCAL_ROLE) {
          const allowedRoot = opts.allowedRoot;
          if (!allowedRoot) {
            throw new MissingAllowedRootError(role);
          }
          const augmented = buildWorkerInput(
            input.clue_id,
            input.clue_text,
            input.depth,
            input.sources,
            allowedRoot,
            resolveRevision(allowedRoot),
          );
          return spawnAgentRunWorker({
            agentRunBin: opts.workerCmd ?? resolveAgentRunBin(),
            role,
            runId,
            input: augmented,
            allowedRoot,
          }).then(() => undefined);
        }
        // 非 code-local / 非 content 的 role（wiki / feishu / code-remote / web-search）：
        // 不需要 allowed_root，照常 spawn（F7）。clue 文本/depth/sources 仍以 worker 输入载荷传下去。
        const augmented = buildWorkerInput(
          input.clue_id,
          input.clue_text,
          input.depth,
          input.sources,
        );
        return spawnAgentRunWorker({
          agentRunBin: opts.workerCmd ?? resolveAgentRunBin(),
          role,
          runId,
          input: augmented,
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
      // C5-fix4 —— no_result 终态化的 exit 时间戳 + 宽限窗口（生产装配恒提供）：
      //   run 已 exit（含 exit 0）且宽限内仍无 worker.result.v1 ⇒ harvestCard 报
      //   noResultBlocked，runWrite 把该卡 CAS 到 blocked（绝不无限 in_flight）。
      readRunExitedAt: async (runId) => findRunExitedAt(runId, runsMessages),
      noResultGraceMs: resolveRunExitGraceMs(),
      publishEvidence: (channelId, evidence, key) =>
        publishEvidence(channelId, evidence, key).then(() => undefined),
      publishClue: (channelId, clue, key) =>
        publishClue(channelId, clue, key).then(() => undefined),
      // E1 D3——对该卡 worker 结果里的每条 material 调 ingest（D1 权威 digest / D2 复用 /
      //   D4 propose content-clue / D5 复用不 propose / D6 失败出生即 blocked）。
      //   生产装配：用真实 bus（research:content）+ MinerU + 生产 fetchMaterialHttp。
      //   ⛔ D9 maxClues 封顶由 harvest 在调用本 dep 之前判定（与既有 clue 封顶同构、同 boardClueCount），
      //      并计入 harvestReport.skippedContentClues（可观测报告）；本装配不再二次封顶，
      //      使封顶判定有唯一权威源、且删除即变红（spec §2 判据 9）。
      //   ⛔ D7 串行化：把本 tick 共享的 ingestSerialize 注入 ingestMaterialImpl，
      //      保证跨 material 的 MinerU 在飞 = 1（base createMutex 语义，非 for-loop 副作用）。
      ingestMaterial: (material, parentClueId, parentDepth, key) => {
        const contentChannel = opts.contentChannelId ?? CONTENT_CHANNEL_ID;
        const ingestDeps: IngestDeps = {
          readExistingTranscript: (digest) =>
            readExistingTranscript(
              (afterSeq) =>
                getMessages(
                  contentChannel,
                  afterSeq !== null ? { afterSeq } : {},
                ),
              digest,
            ),
          fetchMaterial: (uri) => fetchMaterialHttp(uri),
          transcribe: (filename, bytes) => fileParse(filename, bytes),
          // ⛔ 幂等键命名空间隔离（评审 minor finding）：doc(transcript) 发往 content channel，
          //    content-clue 发往 board channel，二者 kind/channel 均不同；为避免对「bus 按 channel
          //    隔离幂等键」的未文档化假设，给两键加可区分后缀（:doc / :clue），使跨 channel 也不碰撞。
          publishDoc: (doc) =>
            publishDoc(contentChannel, doc, `${key}:doc`).then(() => undefined),
          proposeContentClue: (clue) =>
            publishClue(opts.channelId, clue, `${key}:clue`).then(() => clue),
        };
        return ingestMaterialImpl(
          ingestDeps,
          { uri: material.uri, digest: material.digest ?? "", clueId: parentClueId },
          parentDepth,
          `${key}:clue`,
          ingestSerialize,
        );
      },
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
            readResult: async (runId) => {
              const { timeoutMs, pollMs } = resolveAgentResultTimeout();
              const exitGraceMs = resolveRunExitGraceMs();
              return await pollForResultOrExit<TriageResultDecision[]>(runId, TRIAGE_ROLE, {
                readResult: () => readTriageResult(runId),
                readExited: () => hasRunExited(runId),
                timeoutMs,
                pollMs,
                exitGraceMs,
                buildTimeoutMessage: (rid, tms) =>
                  `G5: timed out waiting for triage result for run ${rid} — no dr-triage.result.v1 found on board:agent-runs after ${tms}ms`,
              });
            },
          };
        return spawnTriageRole(corpus, runtime).then(
            (decisions) => ({ decisions, runId: runtime.runId }),
          );
      }),
  };
  // E0c10 D4 —— 包裹默认 spawnTriage：run exited 无 result ⇒ 记录诊断、返回空决策（proposed
  //   clues 不被 CAS，保持 proposed，⛔ 不静默当成功）；tick 继续以 0 退出（GT-D）。
  //   仅包裹「生产缺省」分支（opts.spawnTriage 未注入时）；测试注入的 spawnTriage 保持原样，
  //   由测试自行决定如何处理（判别性测试据此驱动真实轮询读取路径，spec §2 判据 4）。
  if (deps.spawnTriage && opts.spawnTriage === undefined) {
    const _injectedTriadge = deps.spawnTriage;
    deps.spawnTriage = async (corpus) => {
      try {
        return await _injectedTriadge(corpus);
      } catch (e) {
        if (e instanceof RunExitedWithoutResultError) {
          diagnostics.push({
            runId: e.runId,
            role: e.role,
            elapsedMs: e.elapsedMs,
            phase: "triage",
          });
          // ⛔ 不静默当成功：返回的 decisions 经 applyTriageBatch 后零 CAS，
          //   proposed clues 保持 proposed（待下一 tick 重派），与「triage 失败」语义一致。
          //   诊断已进 diagnostics（GT-D：记录 run_id/role/已等时长）。
          return { decisions: [], runId: e.runId };
        }
        throw e;
      }
    };
  }
  const _tWriteStart = Date.now();
  const result = await runWrite(
    deps,
    decisions,
    opts.maxWrites ?? DEFAULT_MAX_WRITES,
  );
  _tWrite = Date.now() - _tWriteStart;
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
    (n, r) => n + r.cluesPublished + (r.contentCluesPublished - r.contentCluesBlocked),
    0,
  );
  // G4b —— 用本轮真实（写后）板面调用 decideTermination（spec §1.1）。
  //   ⛔ 不得新造判定逻辑：decideTermination / computeCoverage 是已交付纯函数，调用它们。
  //   ⛔ prevCoverage / prevZeroGrowthRounds 跨 tick 传递（spec §1.2）：本轮从 opts 读取
  //      （生产由 tick.md 从 {{trigger_body}} 经 tick-entry --parse-trigger-body 解析后
  //       以 --prev-coverage/--prev-zero-growth 传入；首轮无前值传 0）。
  //   ⛔（attempt 2 blocker finding）写后板面 postWriteState 只重写**已存在于写前快照**的卡，
  //      本 tick 经 harvest 新发布的 proposed clue 不在其中。若被收割的卡恰为最后一张非终态卡，
  //      postWriteState 会全为终态（inFlight=0, proposed=0），decideTermination 一旦
  //      zeroGrowthRounds 达阈就会在本 tick（正创建新待处理工作）报 state==='converged' ——
  //      正是 spec §0.2/§3.4 禁止的完备性误报。hasPendingWork 已为此补偿（cluesPublished>0），
  //      终止判定必须同样补偿：把本 tick 新发布的 clue 作为 proposed 卡并入终止输入板面
  //      （任一 proposed>0 ⇒ converged/capped-drained 均不成立 ⇒ 不会假收敛）。
  //      合成卡只参与 status 计数（proposed++）；depth 取 0（新 proposed clue 不应虚假抬高
  //      maxDepth 触顶判定——其真实 depth 要等下一 tick 读回板 channel 才纳入）。
  const termCards =
    cluesPublished > 0
      ? [
          ...postWriteState.cards,
          ...synthesizePublishedClueCards(cluesPublished),
        ]
      : postWriteState.cards;
  //   coverage 取本轮 evidence 已覆盖的 clue_id 集合大小（coveredClueIds 已并入证据 channel
  //      的覆盖；经 Set 去重后的大小，与 decideTermination 内部 computeCoverage 一致）。
  const _tTermStart = Date.now();
  const termination = decideTermination(
    {
      cards: termCards,
      coveredClueIds,
      prevCoverage: opts.prevCoverage ?? 0,
      prevZeroGrowthRounds: opts.prevZeroGrowthRounds ?? 0,
      // C5 —— round 预算耗尽：板面未排空时产出响亮非收敛 reason（判别性规格 §四.1）。
      budgetExhausted: opts.budgetExhausted === true,
    },
    tickConfig,
  );
  _tTerm = Date.now() - _tTermStart;

  // C5 —— run 级响亮收口（判别性规格 §四.1/§四.3）：预算耗尽 + 板面未排空 +
  // 报告未生成 ⇒ drain 退出契约非零。判别测试 3 直接驱动 decideDrainExit 断言
  // reason 点名三个计数（outstanding/in_flight/proposed）且 exit_code != 0。
  // reportGenerated 由 generate 一次性标记是否已落盘判定（与哨兵逐字对齐）：
  //   <oneShotDir>/generated-<sha256(origin:channel)[:16]>；未配置 origin 视为无报告预期。
  const reportGenerated = (() => {
    if (!opts.origin) return false;
    const oneShotDir = opts.oneShotDir ?? join(tmpdir(), "deep-research-generated");
    const markerKey = `${opts.origin}:${opts.channelId}`;
    const markerHash = createHash("sha256").update(markerKey).digest("hex").slice(0, 16);
    return existsSync(join(oneShotDir, `generated-${markerHash}`));
  })();
  const drainExit = decideDrainExit({
    budgetExhausted: opts.budgetExhausted === true,
    boardComposition: termination.boardComposition,
    outstanding: 0,
    reportGenerated,
  });

  // G4c —— 生成段接线：终态非 null + origin 已配置 ⇒ 调用 runGenerate。
  if (opts.origin) {
    if (decideGenerate(termination)) {
      const oneShotDir = opts.oneShotDir ?? join(tmpdir(), "deep-research-generated");
      const markerKey = `${opts.origin}:${opts.channelId}`;
      const markerHash = createHash("sha256").update(markerKey).digest("hex").slice(0, 16);
      const markerPath = join(oneShotDir, `generated-${markerHash}`);
      if (!existsSync(markerPath)) {
        // E0c10 D4 —— 生产 generate deps 注入 onRunExitedWithoutResult：任一角色 run exited 无
        //   result ⇒ 记录诊断、跳过该 doc、终止本次 generate（tick 继续以 0 退出，GT-D）。
        //   仅在生产装配（opts.generateDeps 未注入）时注入；测试注入的 generateDeps 保持原样。
        const generateDeps = opts.generateDeps ?? assembleGenerateDeps(opts, termination, postWriteState);
        if (opts.generateDeps === undefined && !generateDeps.onRunExitedWithoutResult) {
          generateDeps.onRunExitedWithoutResult = ({ role, runId, elapsedMs }) => {
            diagnostics.push({ runId, role, elapsedMs, phase: "generate" });
          };
        }
        const _tGenStart = Date.now();
        await runGenerate(generateDeps, DEFAULT_GENERATE_CONFIG);
        _tGen = Date.now() - _tGenStart;
        mkdirSync(oneShotDir, { recursive: true });
        writeFileSync(markerPath, "");
      }
    }
  }

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
    drainExit,
    triageThreshold: tickConfig.triageThreshold,
    // E1c D6——本轮生效的 spool 根进运行记录（tick 的 JSON 输出），使人能看出 transcript 落在哪。
    contentSpoolRoot,
    diagnostics,
    timings: {
      readBoardMs: _tReadBoard,
      decideMs: _tDecide,
      writeMs: _tWrite,
      terminationMs: _tTerm,
      generateMs: _tGen,
      totalMs: Date.now() - _t0,
    },
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

/**
 * G4b（attempt 2 major finding）—— 从证据 channel 的消息里收集 research.evidence.v2 的
 * clue_id 集合。生产 harvest 把 evidence 发到独立的 EVIDENCE_CHANNEL（与板 channel 不同），
 * --run 路径必须读证据 channel 才能算出非零覆盖度。纯函数：不碰 IO，只折叠已读消息数组。
 */
function collectEvidenceClueIds(messages: InspectMessage[]): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (msg.kind !== "research.evidence.v2") continue;
    const clueId = (msg.payload as Partial<{ clue_id: string }> | null)?.clue_id;
    if (typeof clueId === "string" && clueId.length > 0) ids.push(clueId);
  }
  return ids;
}

/**
 * G4b（attempt 2 blocker finding）—— 合成 n 张「本 tick 新发布、写后板面不可见」的 proposed 卡。
 * 用于把 harvest 本 tick 发布的 proposed clue 并入 decideTermination 的输入板面，避免在
 * 「被收割卡恰为最后一张非终态卡」时假报 converged（spec §0.2/§3.4 完备性误报）。
 *
 * 合成卡只参与 status 计数（让 proposed>0 ⇒ converged/capped-drained 均不成立）；depth 取 0
 * 以免虚假抬高 maxDepth 触顶判定（真实 depth 待下一 tick 读回板 channel 才纳入）。clueId
 * 仅需在板面内唯一（decideTermination 不依赖其值，只数 status）。
 */
function synthesizePublishedClueCards(n: number): BoardCard[] {
  const cards: BoardCard[] = [];
  for (let i = 0; i < n; i += 1) {
    cards.push({
      clueId: `__g4b_published_${i}__`,
      text: "",
      status: "proposed",
      depth: 0,
      sources: [],
      retries: 0,
      runId: null,
    });
  }
  return cards;
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
   * G4b —— 上一 tick 的覆盖度（--prev-coverage）；生产由 tick.md 从 `{{trigger_body}}` 解析后传入。
   * 首轮无前值时不传（parseRunCliArgs 不给该字段），runChannelWrite 缺省 0（spec §1.2）。
   */
  prevCoverage?: number;
  /**
   * G4b —— 上一 tick 结束时的零增长轮数（--prev-zero-growth）；生产由 tick.md 从 `{{trigger_body}}` 解析后传入。
   * 首轮无前值时不传，runChannelWrite 缺省 0。
   */
  prevZeroGrowthRounds?: number;
  /** G4c —— 研究 origin（--origin）；进入 runGenerate 的 readOrigin。 */
  origin?: string;
  /** G4c —— doc channel（--doc-channel）；research.doc.v2 的发布 channel。 */
  docChannelId?: string;
  /** G4c —— 一次性标记文件目录（--one-shot-dir）；跨进程持久。 */
  oneShotDir?: string;
  /** E0c3b §1.1 —— triage 触发阈值（--triage-threshold）；缺省 DEFAULT_TICK_CONFIG.triageThreshold。 */
  triageThreshold?: number;
  /**
   * E0c10 D5 —— 板面 clue 上限（--max-clues）；缺省 DEFAULT_TICK_CONFIG.maxClues(64)。
   * 生产由 tick.md 从 `{{max_clues}}` 注入；空串/不传 ⇒ runChannelWrite 用缺省 64。
   * 影响 harvest 封顶与 decideTermination 的 capHit 判定（spec §2 判据 5）。
   */
  maxClues?: number;
  /**
   * E1b D1/D7——content worker 的 spool 根目录（--content-spool-root）。
   * 派发 content clue 前把 transcript body 落成 `<spoolRoot>/<digest>.md`（D1）；
   * content worker 的 allowed_root = spool 根（D2）。生产由 profile `CONTENT_SPOOL_ROOT` 经
   * tick.md `{{content_spool_root}}` 注入；缺省 DEFAULT_CONTENT_SPOOL_ROOT（tmpdir 下兜底）。
   * ⛔ D7：归属本 run，不得落 vault 根 / `.dev-dispatch/**`。
   */
  contentSpoolRoot?: string;
  /** E1b D1——content channel（--content-channel）；缺省 CONTENT_CHANNEL_ID（research:content）。 */
  contentChannelId?: string;
  /** C5 —— round 预算耗尽（--budget-exhausted，末轮响亮收口）。缺省 false。 */
  budgetExhausted?: boolean;
}

/**
 * 解析 `--run` 之后的参数：
 * `[<channel_id>] [--max-writes <n>] [--evidence-channel <evidence_channel_id>] [--allowed-root <path>] [--question <研究主问题>] [--prev-coverage <n>] [--prev-zero-growth <n>]`。
 * ⛔ 不传 channel → 抛 MissingChannelError（exit ≠ 0，M11）。
 * ⛔ 冻结 channel → 抛 FrozenChannelError（M12）。
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
  let origin: string | undefined;
  let docChannelId: string | undefined;
  let oneShotDir: string | undefined;
  let triageThreshold: number | undefined;
  let maxClues: number | undefined;
  let contentSpoolRoot: string | undefined;
  let contentChannelId: string | undefined;
  let budgetExhausted: boolean | undefined;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--budget-exhausted") {
      budgetExhausted = true;
    } else if (args[i] === "--max-writes") {
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
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(
          "G4b: invalid --prev-coverage (must be a non-negative integer).",
        );
      }
      prevCoverage = value;
      i += 1;
    } else if (args[i] === "--prev-zero-growth") {
      const value = Number(args[i + 1]);
      if (!Number.isInteger(value) || value < 0) {
        throw new Error(
          "G4b: invalid --prev-zero-growth (must be a non-negative integer).",
        );
      }
      prevZeroGrowthRounds = value;
      i += 1;
    } else if (args[i] === "--origin") {
      origin = args[i + 1];
      if (!origin) {
        throw new Error(
          "G4c: invalid --origin (must specify the research origin).",
        );
      }
      i += 1;
    } else if (args[i] === "--doc-channel") {
      docChannelId = args[i + 1];
      if (!docChannelId) {
        throw new Error(
          "G4c: invalid --doc-channel (must specify a doc channel id).",
        );
      }
      i += 1;
    } else if (args[i] === "--one-shot-dir") {
      oneShotDir = args[i + 1];
      if (!oneShotDir) {
        throw new Error(
          "G4c: invalid --one-shot-dir (must specify a directory path).",
        );
      }
      i += 1;
    } else if (args[i] === "--triage-threshold") {
      const value = Number(args[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(
          "E0c3b: invalid --triage-threshold (must be a positive integer).",
        );
      }
      triageThreshold = value;
      i += 1;
    } else if (args[i] === "--max-clues") {
      const value = Number(args[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(
          "E0c10: invalid --max-clues (must be a positive integer).",
        );
      }
      maxClues = value;
      i += 1;
    } else if (args[i] === "--content-spool-root") {
      contentSpoolRoot = args[i + 1];
      if (!contentSpoolRoot) {
        throw new Error(
          "E1b: invalid --content-spool-root (must specify a directory path).",
        );
      }
      i += 1;
    } else if (args[i] === "--content-channel") {
      contentChannelId = args[i + 1];
      if (!contentChannelId) {
        throw new Error(
          "E1b: invalid --content-channel (must specify a channel id).",
        );
      }
      i += 1;
    }
  }
  if (isFrozenChannel(channelId)) {
    throw new FrozenChannelError(channelId);
  }
  const result: RunCliOptions = {
    channelId,
    maxWrites,
    evidenceChannelId,
    allowedRoot,
    question,
    origin,
    docChannelId,
    oneShotDir,
    triageThreshold,
    maxClues,
    contentSpoolRoot,
    contentChannelId,
    budgetExhausted,
  };
  // G4b —— 仅在 CLI 显式传入时才放进结果（缺省 = 首轮无前值，runChannelWrite 内部用 0）。
  if (prevCoverage !== undefined) result.prevCoverage = prevCoverage;
  if (prevZeroGrowthRounds !== undefined)
    result.prevZeroGrowthRounds = prevZeroGrowthRounds;
  return result;
}
