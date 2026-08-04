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
 * ⛔ 写入不可回退：`--max-writes` 默认 5，超限立即停止并响亮报错（M10）；
 *    spawn 本身不写 bus、不计入预算，但每次 spawn 前的 CAS 计入（spec §2）。
 * ⛔ 只对显式传入的 channel 操作（M11）；拒绝写 v1 冻结 channel（M12）。
 * ⛔ CAS 一律走 A8b 的 `realCas`，不得绕过另写 CAS（spec §4.1 纪律 8）。
 */
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { ClueV2 } from "./protocol";
import {
  decideTick,
  DEFAULT_TICK_CONFIG,
  type CasDecision,
  type Decision,
} from "./tick";
import {
  assembleBoard,
  readAgentRuns,
  readChannelMessages,
} from "./tick-inspect";
import { casUpdateClue, getEntity } from "./bus";

/** --max-writes 默认值（spec §2：单次运行写入上限默认很小）。 */
export const DEFAULT_MAX_WRITES = 5;

/** v1 冻结只读 channel 前缀（spec §2 / §8：不得触碰）。 */
export const FROZEN_CHANNEL_PATTERNS = [
  /^research:loop-mcp-semantics\./,
  /^research:smoke-bus-semantics\./,
] as const;

export function isFrozenChannel(channelId: string): boolean {
  return FROZEN_CHANNEL_PATTERNS.some((re) => re.test(channelId));
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
  depth: number;
  sources: string[];
}

/**
 * A8d——按 R1c 形状构造 worker 输入载荷（spec §1.2）。
 * 只产出 `clue_id` / `clue_text` / `depth` / `sources`（及可选 `allowed_root`），
 * 绝不注入任何调度元数据。
 */
export function buildWorkerInput(
  clueId: string,
  clueText: string,
  depth: number,
  sources: string[],
  allowedRoot?: string,
): WorkerInputPayload {
  const input: WorkerInputPayload = {
    clue_id: clueId,
    clue_text: clueText,
    depth,
    sources: [...sources],
  };
  if (allowedRoot) input.allowed_root = allowedRoot;
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
          } catch {
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
      case "triage":
        // 本包不处理 triage 的 spawn 副作用；triage 决策不写卡，跳过。
        skipped += 1;
        break;
    }
  }

  return {
    writes,
    skipped,
    casResults,
    spawns,
    spawnCalls,
  };
}

/** runChannelWrite 的选项：channel 必须显式传入（M11）。 */
export interface RunWriteOptions {
  channelId: string;
  maxWrites?: number;
  runsChannelId?: string;
  /** 注入的 spawn dep（测试用）；缺省走真实 `agent-run` 子进程启动 worker。 */
  spawnWorker?: WriteDeps["spawnWorker"];
  /** `agent-run` 可执行路径（argv[0]）；缺省 `resolveAgentRunBin()`（`AGENT_RUN_BIN`/PATH）。 */
  workerCmd?: string;
}

/** runChannelWrite 的观察输出。 */
export interface RunWriteOutcome {
  channelId: string;
  messageCount: number;
  decisions: Decision[];
  writes: number;
  skipped: number;
  spawns: SpawnRecord[];
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
    child.once("error", (err) => settle(() => reject(err)));
    child.once("exit", (code) => {
      if (code === 0) {
        // worker 正常完成 ⇒ 视为已启动。
        settle(() => resolve({ pid: child.pid }));
      } else {
        // 就绪窗口内非零退出 ⇒ 未真正启动 worker，触发 N5 补偿。
        settle(() => reject(new WorkerStartupError(spec.cmd, code)));
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
 * `agent-run --role <role> --run-id <runId> --input <payloadPath> -- "<clue_text>"`
 * 返回的数组 [0] 即 argv[0]（agent-run 可执行路径），供 P1–P7 逐项断言。
 */
export function buildAgentRunArgv(opts: {
  agentRunBin: string;
  role: string;
  runId: string;
  inputPath: string;
  clueText: string;
}): string[] {
  return [
    opts.agentRunBin,
    "--role",
    opts.role,
    "--run-id",
    opts.runId,
    "--input",
    opts.inputPath,
    "--",
    opts.clueText,
  ];
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
}): Promise<SpawnedWorker> {
  const payloadPath = writeWorkerInputFile(opts.input);
  try {
    const argv = buildAgentRunArgv({
      agentRunBin: opts.agentRunBin,
      role: opts.role,
      runId: opts.runId,
      inputPath: payloadPath,
      clueText: opts.input.clue_text,
    });
    return await spawnWorkerProcess({
      cmd: argv[0],
      args: argv.slice(1),
      env: { AGENT_RUN_BIN: opts.agentRunBin },
    });
  } finally {
    rmSync(payloadPath, { force: true });
  }
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
  const runs = await readAgentRuns(runsChannelId);
  const state = assembleBoard(messages, runs).state;
  const decisions = decideTick(state, DEFAULT_TICK_CONFIG);
  const deps: WriteDeps = {
    cas: (input) => realCas(opts.channelId, input, nonce),
    spawnWorker:
      opts.spawnWorker ??
      ((clueId, role, runId, input) =>
        spawnAgentRunWorker({
          agentRunBin: opts.workerCmd ?? resolveAgentRunBin(),
          role,
          runId,
          input,
        }).then(() => undefined)),
  };
  const result = await runWrite(
    deps,
    decisions,
    opts.maxWrites ?? DEFAULT_MAX_WRITES,
  );
  return {
    channelId: opts.channelId,
    messageCount: messages.length,
    decisions,
    writes: result.writes,
    skipped: result.skipped,
    spawns: result.spawns,
  };
}

/** CLI --run 参数解析结果（channel 无默认值，M11）。 */
export interface RunCliOptions {
  channelId: string;
  maxWrites: number;
}

/**
 * 解析 `--run` 之后的参数：`[<channel_id>] [--max-writes <n>]`。
 * ⛔ 不传 channel → 抛 MissingChannelError（exit ≠ 0，M11）。
 * ⛔ 冻结 channel → 抛 FrozenChannelError（M12）。
 */
export function parseRunCliArgs(args: string[]): RunCliOptions {
  const channelId = args[0];
  if (!channelId) {
    throw new MissingChannelError();
  }
  let maxWrites = DEFAULT_MAX_WRITES;
  for (let i = 1; i < args.length; i += 1) {
    if (args[i] === "--max-writes") {
      const value = Number(args[i + 1]);
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error("A8b: invalid --max-writes (must be a positive integer).");
      }
      maxWrites = value;
      i += 1;
    }
  }
  if (isFrozenChannel(channelId)) {
    throw new FrozenChannelError(channelId);
  }
  return { channelId, maxWrites };
}
