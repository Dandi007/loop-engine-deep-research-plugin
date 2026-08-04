/**
 * S2 —— 调度 tick：回收 → 派 worker → 派 triage
 *
 * 结构切分（spec §1.1）：
 *   decideTick(state, cfg): Decision[]   —— 纯函数，无 IO，可重放可单测
 *   runTick(deps)                        —— 读板 → decideTick → 严格按序执行副作用
 *
 * 硬不变量（spec §2）：先 CAS 后 spawn。CAS 失败不得 spawn；spawn 同步失败当场 CAS 回 open。
 */
import type { ClueV2 } from "./protocol";

/** 封闭枚举：sources 取值只能来自这里（spec §4）。 */
export const SOURCE_ENUM = [
  "code-local",
  "code-remote",
  "wiki",
  "feishu",
  "web-search",
] as const;

/** 参数全部来自 spec §3.4，不得硬编码在逻辑里（spec §6）。 */
export interface TickConfig {
  /** K：triage 触发阈值 */
  triageThreshold: number;
  /** 并发 worker 上限 */
  maxConcurrentWorkers: number;
  /** 最大深度（条件 3：max(depth) >= maxDepth 即触顶） */
  maxDepth: number;
  /** 重试上限 */
  maxRetries: number;
  /** 最大 clue 数（条件 2：count(clue) >= maxClues 即触顶） */
  maxClues: number;
  /** 零增长轮数阈值（条件 1：zeroGrowthRounds >= 阈值） */
  zeroGrowthThreshold: number;
}

export const DEFAULT_TICK_CONFIG: TickConfig = {
  triageThreshold: 3,
  maxConcurrentWorkers: 4,
  maxDepth: 3,
  maxRetries: 2,
  maxClues: 64,
  zeroGrowthThreshold: 2,
};

/** agent.run.* 事件（spec §3）——「worker 死没死」由 exited 变为被观察到的事实。 */
export interface RunEvent {
  state: "started" | "exited";
  exitCode?: number;
}

/** 板面上一张卡的最小视图。 */
export interface BoardCard {
  clueId: string;
  status: ClueV2["status"];
  depth: number;
  sources: string[];
  retries: number;
  runId?: string | null;
}

/** decideTick 的纯输入：板面 + agent.run 事件 + triage 在途标记。 */
export interface BoardState {
  cards: BoardCard[];
  runs: Record<string, RunEvent>;
  /** triage 是否在途（由 loop-engine 命名 lock 保证，S4 接线；本包只表达该条件）。 */
  triageInFlight: boolean;
}

/** 决策——纯函数输出，副作用执行权归 runTick。 */
export type Decision =
  | { kind: "reclaim"; clueId: string; to: ClueV2["status"]; retries: number }
  | { kind: "dispatch"; clueId: string }
  | { kind: "block"; clueId: string; reason: "invalid_sources" }
  | { kind: "triage" };

/** CAS 结果（与 bus 层语义对齐：conflict = 别人抢先）。 */
export interface CasDecision {
  success: boolean;
  error?: "conflict" | "invalid_payload" | "entity_not_found";
}

/** runTick 的依赖注入面：所有副作用（读/CAS/spawn）都从这里走。 */
export interface TickDeps {
  readBoard(): Promise<BoardState>;
  cas(clueId: string, to: ClueV2["status"], retries?: number): Promise<CasDecision>;
  spawnWorker(clueId: string): Promise<void>;
  spawnTriage(): Promise<void>;
}

/** sources 必须是封闭枚举的子集（spec §4）。 */
export function isValidSources(sources: string[]): boolean {
  const allowed: readonly string[] = SOURCE_ENUM;
  return sources.every((s) => allowed.includes(s));
}

/**
 * 纯决策函数：决定一个 tick 要执行的动作序列。
 * 不碰 IO：无网络 / 无时钟 / 无随机 / 不 import ./bus（spec B1）。
 */
export function decideTick(state: BoardState, cfg: TickConfig): Decision[] {
  const decisions: Decision[] = [];

  // §3 回收：遍历 status === "in_flight" 的卡。
  for (const card of state.cards) {
    if (card.status !== "in_flight") continue;

    const run = card.runId ? state.runs[card.runId] : undefined;
    if (!run) {
      // 无对应 agent.run.started → 崩溃恢复，CAS 回 open。
      decisions.push({ kind: "reclaim", clueId: card.clueId, to: "open", retries: card.retries });
      continue;
    }
    if (run.state === "started") {
      // 仍在跑，无事可做。
      continue;
    }
    if (run.exitCode === 0) {
      decisions.push({ kind: "reclaim", clueId: card.clueId, to: "explored", retries: card.retries });
    } else if (card.retries < cfg.maxRetries) {
      decisions.push({ kind: "reclaim", clueId: card.clueId, to: "open", retries: card.retries + 1 });
    } else {
      decisions.push({ kind: "reclaim", clueId: card.clueId, to: "blocked", retries: card.retries });
    }
  }

  // §4 派 worker：n = min(maxConcurrentWorkers - 在途数, open 数)。
  const inFlight = state.cards.filter((c) => c.status === "in_flight").length;
  const open = state.cards.filter((c) => c.status === "open");
  const n = Math.min(cfg.maxConcurrentWorkers - inFlight, open.length);
  let dispatched = 0;
  for (const card of open) {
    if (dispatched >= n) break;
    if (!isValidSources(card.sources)) {
      // 枚举外取值 → 该卡 blocked，研究继续，不整体停机。
      decisions.push({ kind: "block", clueId: card.clueId, reason: "invalid_sources" });
      continue;
    }
    decisions.push({ kind: "dispatch", clueId: card.clueId });
    dispatched += 1;
  }

  // §5 派 triage：count(proposed) >= K 且 triage 无在途。
  const proposed = state.cards.filter((c) => c.status === "proposed").length;
  if (proposed >= cfg.triageThreshold && !state.triageInFlight) {
    decisions.push({ kind: "triage" });
  }

  return decisions;
}

/** 终态封闭枚举：三值互斥可判别（spec §3.1 / §3.4）。 */
export const TERMINAL_STATES = ["converged", "capped", "partial"] as const;
export type TerminalState = (typeof TERMINAL_STATES)[number];

/** 终止判定的纯输入。 */
export interface TerminationInput {
  cards: BoardCard[];
  /** 有 ≥1 条 evidence 的 clue_id 全集（内部去重）。 */
  coveredClueIds: string[];
  /** 上一 tick 的覆盖值（用于零增长判定）。 */
  prevCoverage: number;
  /** 上一 tick 结束时的零增长轮数。 */
  prevZeroGrowthRounds: number;
}

/** 终止判定的纯输出。state 为 null 表示继续，未终止。 */
export interface TerminationState {
  state: TerminalState | null;
  coverage: number;
  zeroGrowthRounds: number;
  /**
   * 触顶是否已发生（条件 2/3 的数量/深度上限已到）。
   * 为 true 但 state 为 null 表示「已触顶、仍在排空」：只拦新 clue，已 open 的跑完
   * （spec §3 line 37），待全部排空后才正式报 capped。
   */
  capHit: boolean;
}

/** 覆盖度 = 有至少一条 evidence 的 clue_id 的集合大小（spec §2，非 evidence 条数）。 */
export function computeCoverage(coveredClueIds: string[]): number {
  return new Set(coveredClueIds).size;
}

/**
 * 纯函数：算覆盖 → 判终止 → 给可区分终态（spec §3.2/§3.4）。
 * 不碰 IO：无时钟 / 无随机 / 无网络 / 不 import ./bus（spec B1）。
 *
 * 终止性（spec §4）：每个 tick 使 zeroGrowthRounds 在零增长时严格单增，
 * 或由条件 2/3 触顶，二者之一有上界，保证可终止。
 */
export function decideTermination(
  input: TerminationInput,
  cfg: TickConfig,
): TerminationState {
  const coverage = computeCoverage(input.coveredClueIds);
  const zeroGrowthRounds =
    coverage > input.prevCoverage ? 0 : input.prevZeroGrowthRounds + 1;

  const count = input.cards.length;
  const maxDepth = input.cards.reduce((m, c) => Math.max(m, c.depth), 0);
  const inFlight = input.cards.filter((c) => c.status === "in_flight").length;
  const open = input.cards.filter((c) => c.status === "open").length;
  const proposed = input.cards.filter((c) => c.status === "proposed").length;
  const blocked = input.cards.filter((c) => c.status === "blocked").length;

  // 条件 2/3：触顶 → 终态 capped（触顶 ≠ 收敛，报告不得宣称完备，§3.1）。
  // 条件 3 只拦新 clue，已 open 的跑完（spec §3 line 37）：触顶后并不立即终止，
  // 需等 在途 / 待派 / 待 triage 的工作全部排空才正式报 capped；排空期间仅置 capHit。
  const capHit = count >= cfg.maxClues || maxDepth >= cfg.maxDepth;
  const drained = inFlight === 0 && open === 0 && proposed === 0;

  let state: TerminalState | null = null;
  if (capHit) {
    if (drained) {
      state = "capped";
    }
  } else if (
    zeroGrowthRounds >= cfg.zeroGrowthThreshold &&
    inFlight === 0 &&
    proposed === 0
  ) {
    // 条件 1：零增长达标且无在途/proposed。blocked>0 一律降级为 partial（§3.2）。
    state = blocked > 0 ? "partial" : "converged";
  }

  return { state, coverage, zeroGrowthRounds, capHit };
}

/**
 * 读板 → decideTick → 严格按决策序执行副作用。
 * 先 CAS 后 spawn；CAS 失败跳过不 spawn；spawn 同步失败当场 CAS 回 open（spec §2）。
 */
export async function runTick(deps: TickDeps, cfg: TickConfig = DEFAULT_TICK_CONFIG): Promise<void> {
  const state = await deps.readBoard();
  const decisions = decideTick(state, cfg);

  for (const decision of decisions) {
    switch (decision.kind) {
      case "reclaim":
        await deps.cas(decision.clueId, decision.to, decision.retries);
        break;
      case "dispatch": {
        const result = await deps.cas(decision.clueId, "in_flight");
        if (!result.success) {
          // CAS 失败（409 = 别人抢先）→ 跳过该卡，不得 spawn。
          break;
        }
        try {
          await deps.spawnWorker(decision.clueId);
        } catch {
          // CAS 成功但 spawn 同步失败 → 当场 CAS 回 open。
          await deps.cas(decision.clueId, "open");
        }
        break;
      }
      case "block":
        await deps.cas(decision.clueId, "blocked");
        break;
      case "triage":
        await deps.spawnTriage();
        break;
    }
  }
}