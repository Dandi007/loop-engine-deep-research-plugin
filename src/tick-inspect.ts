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
import { getMessages } from "./bus";
import {
  decideTick,
  decideTermination,
  DEFAULT_TICK_CONFIG,
  type BoardCard,
  type BoardState,
  type Decision,
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
 * 规则：
 *   1. research.*.v1 消息 → 显式跳过并计数（skippedV1），不得当成 v2 解析。
 *   2. research.clue.v2 → 按 entity_id 取 channel_seq 最大的一条（版本链 head）。
 *   3. research.evidence.v2 → 收集 payload.clue_id 为覆盖集合。
 */
export function assembleBoard(messages: InspectMessage[]): InspectAssembled {
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
      status: p.status,
      depth: p.depth,
      sources: p.sources,
      retries: 0,
    };
    cards.push(card);
    statusDistribution[p.status] = (statusDistribution[p.status] ?? 0) + 1;
  }

  const coveredClueIds = [...covered];
  const state: BoardState = { cards, runs: {}, triageInFlight: false };
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
export function computeInspect(channelId: string, messages: InspectMessage[]): InspectOutput {
  const a = assembleBoard(messages);
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
 * 只读跑一次 --inspect：分页读 channel → 决策 → 打印 JSON → 返回 0。
 * ⛔ 终态任何值都 exit 0（本模式是观察，不是判决，spec §1 step 6 / H10）。
 */
export async function runInspect(
  channelId: string,
  write: (s: string) => void = (s) => process.stdout.write(s),
): Promise<number> {
  const messages = await readChannelMessages(channelId);
  const output = computeInspect(channelId, messages);
  write(JSON.stringify(output, null, 2) + "\n");
  return 0;
}