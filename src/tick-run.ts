/**
 * A8b —— tick 写侧执行：CAS 认领 / 回收（**不含 spawn**）
 *
 * 对已交付的 Decision 执行写动作（spec §1.2 / §3.2 第 2–3 步）：
 *   reclaim  → CAS 该卡到目标 status（open / explored / blocked）
 *   dispatch → CAS open → in_flight，并把 `run_id` 写进卡（M7）
 *   block    → CAS 到 blocked
 *
 * ⛔ 本包不 spawn：`dispatch` CAS 成功后只记录**待 spawn**（pendingSpawns），
 *    spawn 的实际执行属 A8c。spawn dep 由调用方注入，A8b 传显式 no-op 并记录（M9）。
 * ⛔ 先 CAS 成功才算认领；CAS 失败（409）跳过该卡（M8，spec §2/S2）。
 * ⛔ 写入不可回退：`--max-writes` 默认 5，超限立即停止并响亮报错（M10）。
 * ⛔ 只对显式传入的 channel 操作（M11）；拒绝写 v1 冻结 channel（M12）。
 */
import { randomUUID } from "node:crypto";
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
  to: ClueV2["status"];
  runId?: string;
}

/** 写侧依赖注入面：所有副作用（CAS / spawn）都从这里走。 */
export interface WriteDeps {
  cas(input: WriteCasInput): Promise<CasDecision>;
  /** ⛔ 注入的 spawn dep：A8b 传入 no-op，本包只记录待 spawn，不真正调用（M9）。 */
  spawnWorker(clueId: string): Promise<void>;
}

/** runWrite 的观察输出：已执行写数 + 待 spawn 记录（安全性 + 活性配对，M9）。 */
export interface WriteResult {
  /** 已实际发起的 CAS 写次数（含失败尝试）。 */
  writes: number;
  /** 未产生写的决策数（triage / CAS 冲突跳过的 dispatch，M8）。 */
  skipped: number;
  casResults: {
    clueId: string;
    to: ClueV2["status"];
    success: boolean;
    error?: CasDecision["error"];
  }[];
  /** 待 spawn 记录：dispatch CAS 成功后登记（A8b 不真正 spawn，M9）。 */
  pendingSpawns: { clueId: string; runId: string }[];
  /** spawn dep 被调用的次数（A8b 必须为 0，M9）。 */
  spawnCalls: number;
}

function generateRunId(): string {
  return randomUUID();
}

/**
 * 纯副作用执行：按决策序执行写动作（先 CAS 后 spawn；CAS 失败跳过不 spawn，S2）。
 * ⛔ 本函数不真正 spawn——只登记 pendingSpawns（spec §1.2）。
 * ⛔ 每次写前检查 max-writes 上限，超限立即抛错（M10）。
 */
export async function runWrite(
  deps: WriteDeps,
  decisions: Decision[],
  maxWrites = DEFAULT_MAX_WRITES,
): Promise<WriteResult> {
  let writes = 0;
  let skipped = 0;
  const casResults: WriteResult["casResults"] = [];
  const pendingSpawns: WriteResult["pendingSpawns"] = [];

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
        const result = await perform({
          clueId: decision.clueId,
          to: decision.to,
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
        const result = await perform({
          clueId: decision.clueId,
          to: "in_flight",
          runId,
        });
        casResults.push({
          clueId: decision.clueId,
          to: "in_flight",
          success: result.success,
          error: result.error,
        });
        if (result.success) {
          // CAS 成功才算认领：只登记待 spawn，不真正 spawn（M7 / M9）。
          pendingSpawns.push({ clueId: decision.clueId, runId });
        } else {
          // CAS 失败（409）→ 跳过该卡，无后续动作（M8）。
          skipped += 1;
        }
        break;
      }
      case "block": {
        const result = await perform({
          clueId: decision.clueId,
          to: "blocked",
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
    pendingSpawns,
    spawnCalls: 0,
  };
}

/** runChannelWrite 的选项：channel 必须显式传入（M11）。 */
export interface RunWriteOptions {
  channelId: string;
  maxWrites?: number;
  runsChannelId?: string;
}

/** runChannelWrite 的观察输出。 */
export interface RunWriteOutcome {
  channelId: string;
  messageCount: number;
  decisions: Decision[];
  writes: number;
  skipped: number;
  pendingSpawns: { clueId: string; runId: string }[];
}

/** 真实 bus 的 CAS：读 head → 合并 update → CAS（先 CAS 成功才算认领，S2）。 */
async function realCas(
  channelId: string,
  input: WriteCasInput,
  nonce: string,
): Promise<CasDecision> {
  const head = await getEntity(input.clueId);
  if (!head) {
    return { success: false, error: "entity_not_found" };
  }
  const update: Partial<ClueV2> = { status: input.to };
  if (input.runId) update.run_id = input.runId;
  const idempotencyKey = `a8b-run:${channelId}:${input.clueId}:${input.to}:${nonce}`;
  return casUpdateClue(channelId, input.clueId, head, update, idempotencyKey);
}

/**
 * 完整写侧跑一次：校验 channel（冻结即拒，M12）→ 读板 + 真实 runs → 决策 → 执行写。
 * spawn dep 传显式 no-op（A8b 不 spawn，M9）。
 */
export async function runChannelWrite(
  opts: RunWriteOptions,
): Promise<RunWriteOutcome> {
  if (isFrozenChannel(opts.channelId)) {
    throw new FrozenChannelError(opts.channelId);
  }
  const nonce = randomUUID();
  const messages = await readChannelMessages(opts.channelId);
  const runs = await readAgentRuns(opts.runsChannelId ?? "board:agent-runs");
  const state = assembleBoard(messages, runs).state;
  const decisions = decideTick(state, DEFAULT_TICK_CONFIG);
  const deps: WriteDeps = {
    cas: (input) => realCas(opts.channelId, input, nonce),
    spawnWorker: async () => {
      // A8b no-op：spawn 属 A8c；这里不假装 spawn 成功，只记录待 spawn。
    },
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
    pendingSpawns: result.pendingSpawns,
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
