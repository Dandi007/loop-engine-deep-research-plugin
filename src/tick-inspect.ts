/**
 * A8a —— tick 只读 inspect 模式（读侧，零写入）
 *
 * 读真实 agent-bus channel → 解析 → 跑已交付决策 → 打印 JSON。
 * ⛔ 本模块不得发起任何非 GET 请求；不触碰真实 MinerU / vault（spec §2）。
 *
 * 决策逻辑一律从 ./tick import（decideTick / decideTermination / DEFAULT_TICK_CONFIG），
 * 不重新实现（spec §1 step 4 / H5）。本模块只做「读 + 组装 + 打印」。
 */
import type { ClueV2, EvidenceV2 } from "./protocol";
import type { WorkerResultV1 } from "./harvest";
import { getMessages } from "./bus";
import { RUNS_CHANNEL_ID } from "./run-channels";
import {
  decideTick,
  decideTermination,
  DEFAULT_TICK_CONFIG,
  type BoardCard,
  type BoardState,
  type Decision,
  type RunEvent,
  type TerminationInput,
  type TerminationState,
} from "./tick";

/** 与 bus 消息结构的最小视图（专用于本包纯逻辑，可直接喂字面量数组）。 */
export interface InspectMessage {
  message_id: string;
  channel_id: string;
  channel_seq: number;
  kind: string;
  payload: unknown;
  entity_id: string;
  supersedes: string | null;
  created_at: string;
}

/** assembleBoard 的纯输出：组装好的板面 + 决策输入 + 统计。 */
export interface InspectAssembled {
  cards: BoardCard[];
  state: BoardState;
  termInput: TerminationInput;
  /** 被显式跳过并计数的 research.*.v1 消息数（spec §3：不得静默丢弃）。 */
  skippedV1: number;
  /** 有 evidence 的 clue_id 集合（coverage 的原料）。 */
  coveredClueIds: string[];
  /** coverage = coveredClueIds 的集合大小（spec §2 / H4）。 */
  coverage: number;
  /** 按 head 折叠后的 clue 实体数（版本链按 entity 取 head，spec §3 / H1）。 */
  clueEntities: number;
  /** 卡数按 status 分布。 */
  statusDistribution: Record<string, number>;
}

/**
 * 纯函数：把原始消息数组组装成 BoardState / TerminationInput（spec §1 step 2–4）。
 * 不碰 IO，可直接喂消息数组做 H1/H2/H4 断言。
 *
 * ⛔ A8b：`runs` 不再硬编码为空——由调用方从 `board:agent-runs` 真实读取后传入
 * （spec §1.1），本函数只负责组装，不产生空的 runs 字面量。
 *
 * 规则：
 *   1. research.*.v1 消息 → 显式跳过并计数（skippedV1），不得当成 v2 解析。
 *   2. research.clue.v2 → 按 entity_id 取 channel_seq 最大的一条（版本链 head）；
 *      卡上的 `runId` 取 payload 的 `run_id`（引擎在 CAS 时写进卡，spec §1.1 退路）。
 *   3. research.evidence.v2 → 收集 payload.clue_id 为覆盖集合。
 */
export function assembleBoard(
  messages: InspectMessage[],
  runs: Record<string, RunEvent>,
): InspectAssembled {
  let skippedV1 = 0;
  const clueHeads = new Map<string, InspectMessage>();
  const covered = new Set<string>();

  for (const msg of messages) {
    if (/\.v1$/.test(msg.kind)) {
      skippedV1 += 1;
      continue;
    }
    if (msg.kind === "research.clue.v2") {
      const cur = clueHeads.get(msg.entity_id);
      if (!cur || msg.channel_seq > cur.channel_seq) {
        clueHeads.set(msg.entity_id, msg);
      }
    } else if (msg.kind === "research.evidence.v2") {
      const clueId = (msg.payload as Partial<EvidenceV2> | null)?.clue_id;
      if (clueId) covered.add(clueId);
    }
  }

  const cards: BoardCard[] = [];
  const statusDistribution: Record<string, number> = {};
  for (const msg of clueHeads.values()) {
    const p = msg.payload as ClueV2;
    const card: BoardCard = {
      clueId: msg.entity_id,
      text: p.text,
      status: p.status,
      depth: p.depth,
      sources: p.sources,
      retries: 0,
      runId: p.run_id ?? null,
    };
    cards.push(card);
    statusDistribution[p.status] = (statusDistribution[p.status] ?? 0) + 1;
  }

  const coveredClueIds = [...covered];
  const state: BoardState = { cards, runs, triageInFlight: false };
  const termInput: TerminationInput = {
    cards,
    coveredClueIds,
    prevCoverage: 0,
    prevZeroGrowthRounds: 0,
  };

  return {
    cards,
    state,
    termInput,
    skippedV1,
    coveredClueIds,
    coverage: covered.size,
    clueEntities: clueHeads.size,
    statusDistribution,
  };
}

/** --inspect 的完整观察输出。 */
export interface InspectOutput {
  channelId: string;
  messageCount: number;
  skippedV1: number;
  clueEntities: number;
  statusDistribution: Record<string, number>;
  coverage: number;
  decisions: Decision[];
  termination: TerminationState;
}

/**
 * 读真实 channel → 组装 → 跑已交付决策 → 返回观察输出（spec §1 step 1–5）。
 * 用 getMessages 分页读（after_seq 翻到取空），全程只读（spec §2 / H3 / H6）。
 */
export async function readChannelMessages(channelId: string): Promise<InspectMessage[]> {
  const all: InspectMessage[] = [];
  let afterSeq: number | undefined;
  for (;;) {
    const page = await getMessages(channelId, { limit: 100, afterSeq });
    all.push(...page);
    if (page.length === 0) break;
    const next = page[page.length - 1].channel_seq;
    if (afterSeq !== undefined && next <= afterSeq) {
      // 分页无前进守卫：避免异常后端导致死循环（正常 bus 经 after_seq 必然前进）。
      break;
    }
    afterSeq = next;
  }
  return all;
}

/** 组装 + 决策（纯逻辑，供 runInspect 与测试直接复用）。 */
export function computeInspect(
  channelId: string,
  messages: InspectMessage[],
  runs: Record<string, RunEvent>,
): InspectOutput {
  const a = assembleBoard(messages, runs);
  const decisions = decideTick(a.state, DEFAULT_TICK_CONFIG);
  const termination = decideTermination(a.termInput, DEFAULT_TICK_CONFIG);
  return {
    channelId,
    messageCount: messages.length,
    skippedV1: a.skippedV1,
    clueEntities: a.clueEntities,
    statusDistribution: a.statusDistribution,
    coverage: a.coverage,
    decisions,
    termination,
  };
}

/**
 * 从一条 `agent.run.*` 消息解析出 (run_id, RunEvent)。
 * kind 形如 `agent.run.started.v1` / `agent.run.exited.v1`，run_id 在 payload；
 * 兼容 run_id 直接拼在 kind 后缀的形态（spec §1.1：按 run_id 归集）。
 * 非 `agent.run.*` 消息返回 null（跳过）。
 */
export function parseRunEvent(
  msg: InspectMessage,
): { runId: string; event: RunEvent } | null {
  const m = /^agent\.run\.(started|exited)(?:\.(.*))?$/.exec(msg.kind);
  if (!m) return null;
  const state = m[1] as "started" | "exited";
  const suffixRunId = m[2];
  const payload = (msg.payload ?? {}) as Record<string, unknown>;
  const payloadRunId =
    typeof payload.run_id === "string" ? payload.run_id : undefined;
  // 优先 payload 的 run_id（真实 bus kind 为 `agent.run.started.v1`，后缀是协议版本）；
  // 仅当 payload 无 run_id 时才退到 kind 后缀（兼容 `agent.run.started.<run_id>` 形态）。
  const runId = payloadRunId || suffixRunId;
  if (!runId) return null;
  const exitCode =
    state === "exited" && typeof payload.exit_code === "number"
      ? payload.exit_code
      : undefined;
  return {
    runId,
    event: exitCode !== undefined ? { state, exitCode } : { state },
  };
}

/**
 * A8b —— 把 `board:agent-runs` 的消息数组按 run_id 归集成 `runs`。
 * `agent.run.started.*` / `agent.run.exited.*`（spec §1.1）；同一 run_id 多事件取最后一次
 * （分页返回最早在前，后来的覆盖）。⛔ 不硬编码空的 runs 字面量。
 * 纯函数：供 `readAgentRuns` 与 `runChannelWrite` 复用同一份已读消息列表。
 */
export function buildRunsFromMessages(
  messages: InspectMessage[],
): Record<string, RunEvent> {
  const runs: Record<string, RunEvent> = {};
  for (const msg of messages) {
    const parsed = parseRunEvent(msg);
    if (parsed) runs[parsed.runId] = parsed.event;
  }
  return runs;
}

/**
 * A8b —— 真实 `runs`：分页读 `board:agent-runs`，按 run_id 归集
 * `agent.run.started.*` / `agent.run.exited.*`（spec §1.1）。
 * ⛔ 不硬编码空的 runs 字面量。
 */
export async function readAgentRuns(
  channelId = RUNS_CHANNEL_ID,
): Promise<Record<string, RunEvent>> {
  const messages = await readChannelMessages(channelId);
  return buildRunsFromMessages(messages);
}

/**
 * A8e —— 从已读的 `board:agent-runs` 消息数组里，按 run_id 找该 run 的
 * `worker.result.v1`（收割步用，spec §1）。取 payload.run_id 匹配的**最后一条**
 * （同 run 后发覆盖先发）。找不到 ⇒ 返回 null（该 run 无产物可收割）。
 * ⛔ 纯函数：幂等/重放安全，只读不写；同 run_id 读到的结果用于稳定序号映射。
 * 供 `readWorkerResult` 与 `runChannelWrite` 复用同一份已读消息列表，
 * 避免每张 harvest 卡把 `board:agent-runs` 整个 channel 再分页一遍（评审 note）。
 */
export function findWorkerResult(
  runId: string,
  messages: InspectMessage[],
): WorkerResultV1 | null {
  let found: WorkerResultV1 | null = null;
  for (const msg of messages) {
    if (msg.kind !== "worker.result.v1") continue;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    if (payload.run_id !== runId) continue;
    found = payload as WorkerResultV1;
  }
  return found;
}

/**
 * A8e —— 按 run_id 读该 run 的 `worker.result.v1`（收割步用，spec §1）。
 * 分页读 `board:agent-runs`，取 kind 为 `worker.result.v1.message`（或含 result 语义的
 * `worker.result.v1`）且 payload.run_id 匹配的**最后一条**（同 run 后发覆盖先发）。
 * 找不到 ⇒ 返回 null（该 run 无产物可收割）。
 * ⛔ 幂等/重放安全：本函数只读，不写；同 run_id 读到的结果用于稳定序号映射。
 */
export async function readWorkerResult(
  runId: string,
  channelId = RUNS_CHANNEL_ID,
): Promise<WorkerResultV1 | null> {
  const messages = await readChannelMessages(channelId);
  return findWorkerResult(runId, messages);
}

/**
 * G4c —— 从已读的消息数组里，按 run_id 找该 run 的 `dr-doc.result.v1`。
 * 与 `findWorkerResult` 同构，但过滤 `kind === "dr-doc.result.v1"`。
 * 取 payload.run_id 匹配的**最后一条**（同 run 后发覆盖先发）。找不到 ⇒ 返回 null。
 */
export function findGenerateResult(
  runId: string,
  messages: InspectMessage[],
): { body: string } | null {
  let found: { body: string } | null = null;
  for (const msg of messages) {
    if (msg.kind !== "dr-doc.result.v1") continue;
    const payload = (msg.payload ?? {}) as Record<string, unknown>;
    if (payload.run_id !== runId) continue;
    if (typeof payload.body === "string") {
      found = { body: payload.body };
    }
  }
  return found;
}

/**
 * G4c —— 按 run_id 读该 run 的 `dr-doc.result.v1`（生成角色结果回读）。
 * ⛔ 每次重新分页读 channel（不复用 spawn 前的快照）——spawn 是异步的，
 *    结果不会立刻在 channel 上，且 `runId` 是 spawn 时才生成的，
 *    用 spawn 前读的快照确定性落空。
 */
export async function readGenerateResult(
  runId: string,
  channelId = RUNS_CHANNEL_ID,
): Promise<{ body: string } | null> {
  const messages = await readChannelMessages(channelId);
  return findGenerateResult(runId, messages);
}

/**
 * G5 —— `dr-triage.result.v1` 的一条决策（`{clue_id, action, rationale}`）。
 */
export interface TriageResultDecision {
  clue_id: string;
  action: "keep" | "drop";
  rationale: string;
}

/**
 * G5 —— 从已读的消息数组里，按 run_id 找该 run 的 `dr-triage.result.v1` 决策列表。
 * 与 `findGenerateResult` 同构，但过滤 `kind === "dr-triage.result.v1"`。
 * 取 payload.run_id 匹配的**最后一条**（同 run 后发覆盖先发）。找不到 ⇒ 返回 null。
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

/**
 * G5 —— 按 run_id 读该 run 的 `dr-triage.result.v1`（triage 角色结果回读）。
 * ⛔ 每次重新分页读 channel（不复用 spawn 前的快照）——spawn 是异步的，
 *    结果不会立刻在 channel 上，且 `runId` 是 spawn 时才生成的，
 *    用 spawn 前读的快照确定性落空。返回 null 表示「读不到结果」（与空决策区分）。
 */
export async function readTriageResult(
  runId: string,
  channelId = RUNS_CHANNEL_ID,
): Promise<TriageResultDecision[] | null> {
  const messages = await readChannelMessages(channelId);
  return findTriageResult(runId, messages);
}

/**
 * C5-fix4 —— 从已读的消息数组里，按 run_id 找该 run 的 `agent.run.exited` 事件时间戳（ms）。
 * 取最后一条 exited 事件的 `created_at`；找不到（该 run 未 exited / 时间戳不可解析）⇒ null。
 * 纯函数：供 harvest no_result 终态化的宽限判定复用同一份已读消息列表。
 */
export function findRunExitedAt(
  runId: string,
  messages: InspectMessage[],
): number | null {
  let found: number | null = null;
  for (const msg of messages) {
    const parsed = parseRunEvent(msg);
    if (!parsed) continue;
    if (parsed.runId !== runId) continue;
    if (parsed.event.state !== "exited") continue;
    const t = Date.parse(msg.created_at);
    if (!Number.isNaN(t)) found = t;
  }
  return found;
}

/**
 * E0c10 D4（GT-D）—— 从已读的消息数组里，按 run_id 找该 run 是否已有 `agent.run.exited` 事件。
 * 用于 triage / generate 轮询路径判别「run 已 exited 但无 result」（GT-D 真机：
 * `run … exited without producing a dr-doc.result.v1 after 3159ms`）。
 * 纯函数：供轮询循环复用同一份已读消息列表，避免额外分页读。
 */
export function findRunExited(
  runId: string,
  messages: InspectMessage[],
): boolean {
  for (const msg of messages) {
    const parsed = parseRunEvent(msg);
    if (!parsed) continue;
    if (parsed.runId === runId && parsed.event.state === "exited") {
      return true;
    }
  }
  return false;
}

/**
 * E0c10 D4（GT-D）—— 按 run_id 读 `board:agent-runs`，判别该 run 是否已 exited。
 * 轮询路径在每次 poll 时调用：exit 已观察到且仍无 result ⇒ 记录诊断并继续本轮 tick
 * （⛔ tick 不得非零退出；⛔ 该 doc/clue 不得静默当成功）。
 */
export async function hasRunExited(
  runId: string,
  channelId = RUNS_CHANNEL_ID,
): Promise<boolean> {
  const messages = await readChannelMessages(channelId);
  return findRunExited(runId, messages);
}

/**
 * 只读跑一次 --inspect：分页读 channel + 真实 runs → 决策 → 打印 JSON → 返回 0。
 * ⛔ 终态任何值都 exit 0（本模式是观察，不是判决，spec §1 step 6 / H10）。
 */
export async function runInspect(
  channelId: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> {
  const messages = await readChannelMessages(channelId);
  const runs = await readAgentRuns();
  const output = computeInspect(channelId, messages, runs);
  write(JSON.stringify(output, null, 2) + "\n");
  return 0;
}