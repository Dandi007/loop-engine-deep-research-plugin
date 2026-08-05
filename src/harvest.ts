/**
 * A8e —— 收割步：把 `worker.result.v1` 转成 evidence 与新 clue 写回研究板
 *
 * 位置（spec §1）：回收步之内，`exited(exit_code=0)` → CAS 到 `explored` **之前**。
 * 对每张 `status=in_flight` 且其 `run_id` 在 `board:agent-runs` 上有 `exited(0)` 的卡：
 *
 *   1. 按 run_id 找该 run 的 worker.result.v1
 *   2. 逐条 evidence → research.evidence.v2 → 发到证据 channel
 *   3. 逐条 proposed_clue → research.clue.v2 → 发到板
 *   4. 全部发完之后，才 CAS 该卡 → explored
 *
 * ⛔ 次序（§1.1）：CAS 必须是最后一步；中途崩溃 ⇒ 卡仍 in_flight ⇒ 幂等重放安全。
 * ⛔ 幂等键（§1.2）：`dr-evidence:<run_id>:<index>` / `dr-clue:<run_id>:<index>`，
 *    index 是产物内的稳定序号，不得用时间戳/随机数。
 * ⛔ 证据 channel（§1.4）无默认值、无 `.board`→`.evidence` 字符串推导；缺失即响亮报错。
 * ⛔ worker 的 `reason` 本包不落库（§1.5 / H19）。
 * ⛔ 写入预算（§1.7）：evidence+clue 发布均计入 --max-writes；不足则整卡跳过，响亮报告。
 *
 * 本模块只做「读结果 → 确定性映射 → 发布 → 报告」；CAS 到 explored 由上层
 * `runWrite` 在发布全部完成后执行（保证「先发完，才 CAS」）。
 */
import type { ClueV2, EvidenceV2 } from "./protocol";

/** worker.result.v1 里一条 evidence 的最小视图（spec §1.3 / §7）。 */
export interface WorkerEvidenceItem {
  quote: string;
  claim: string;
  source?: string;
  locator?: string;
  revision?: string;
  range?: string;
}

/** worker.result.v1 里一条 proposed_clue（worker 只产出 `{clue, reason}`，spec §1.5）。 */
export interface WorkerProposedClue {
  clue: string;
  reason?: string;
}

/**
 * worker.result.v1 的 payload（发布在 board:agent-runs，payload 带 run_id，spec §7）。
 *
 * ⛔ A10a：权威形状（已冻结的 `profiles/roles/schemas/worker-result.v1.json`）是
 *    `required: ['evidences','proposed_clues','materials']`，三者**均为数组**。
 *    旧代码写 `evidence`（单数）/ `proposed_clues:{items}` 是把 JSON Schema 的
 *    `items` 关键字误当成运行期结构——这是 F0 真跑 6 条证据被静默丢弃的根因。
 */
export interface WorkerResultV1 {
  run_id?: string;
  evidences?: WorkerEvidenceItem[];
  proposed_clues?: WorkerProposedClue[];
  materials?: unknown[];
}

/** 形状守卫失败——响亮报错，绝不当成「空产物」静默通过（A10a §1.3）。 */
export class WorkerResultShapeError extends Error {
  constructor(message: string) {
    super(`A10a: invalid worker.result.v1 shape: ${message}`);
    this.name = "WorkerResultShapeError";
  }
}

/** 冻结的 worker.result.v1 必填键（与 `profiles/roles/schemas/worker-result.v1.json` 一致）。 */
const WORKER_RESULT_REQUIRED = ["evidences", "proposed_clues", "materials"] as const;

/**
 * 形状守卫（A10a §1.3）：worker.result.v1 必须带齐全部 required 键，且三者均为数组。
 * ⛔ 缺任一（含旧的单数 `evidence`、`{items}` 嵌套形状）⇒ **响亮失败**，
 *    绝不当作「0 发布 + CAS explored」静默通过。旧错误形状在此被拒：
 *   - `evidence`（单数）⇒ `evidences` 键缺失；
 *   - `proposed_clues:{items:[...]}` ⇒ `proposed_clues` 不是数组。
 */
export function assertWorkerResultShape(result: WorkerResultV1): void {
  for (const key of WORKER_RESULT_REQUIRED) {
    const value = (result as Record<string, unknown>)[key];
    if (value === undefined || value === null) {
      throw new WorkerResultShapeError(`missing required key '${key}'`);
    }
    if (!Array.isArray(value)) {
      throw new WorkerResultShapeError(`'${key}' must be an array (got ${typeof value})`);
    }
  }
}

/** 收割所依赖的卡的最小视图（纯映射只需 clueId / depth / sources）。 */
export interface HarvestCard {
  clueId: string;
  depth: number;
  sources: string[];
}

/** 证据 channel 缺失——响亮报错，且不发任何网络请求（§1.4 / H14）。 */
export class MissingEvidenceChannelError extends Error {
  constructor() {
    super(
      "A8e: harvesting requires an explicit evidence channel (no default, no string derivation).",
    );
    this.name = "MissingEvidenceChannelError";
  }
}

/** 超过 maxDepth 的新 clue 落 blocked 的明确 rationale（§1.6 / H11：不得静默丢弃）。 */
export const OVER_MAX_DEPTH_RATIONALE =
  "clue depth exceeds maxDepth; blocked instead of silently dropped (spec §3.1)";

/**
 * 组合 evidence 的 anchor（spec §5.2 / §1.3）：
 * `<source>://<locator>@<revision>#<range>`；range 缺省时**省略 `#` 段**（§1.3 / H4）。
 */
export function composeAnchor(
  source: string,
  locator: string,
  revision: string,
  range?: string,
): string {
  const base = `${source}://${locator}@${revision}`;
  return range ? `${base}#${range}` : base;
}

/**
 * 由一条 worker evidence 生成 anchor。
 * ⛔ source/locator/revision 任一缺失/为空 ⇒ **响亮报错**（不静默塞空串）。
 *    缺失时若回退成空串会得到退化的 "://@" 锚——非空故能骗过
 *    assertEvidenceComplete 的「四必填非空」检查，随后被不可回退地发布到
 *    无 DELETE 的 append-only bus。这与本仓「解析不到 secret 不得塞空串」
 *    的纪律同源（src/tick-run.ts）；缺 anchor 组件应响亮失败，绝不落退化的空锚。
 */
export function anchorForEvidence(item: WorkerEvidenceItem): string {
  const source = item.source;
  const locator = item.locator;
  const revision = item.revision;
  if (!source || !locator || !revision) {
    throw new Error(
      "A8e: worker evidence missing source/locator/revision for anchor; refusing to derive a degenerate empty anchor (no silent empty-string fallback).",
    );
  }
  return composeAnchor(source, locator, revision, item.range);
}

/** 校验 evidence 四必填字段齐全且非空（spec §1.3 / H2）。缺任一 ⇒ 抛错（响亮，不静默落空）。 */
export function assertEvidenceComplete(evidence: EvidenceV2): void {
  if (
    !evidence.clue_id ||
    !evidence.anchor ||
    !evidence.quote ||
    !evidence.claim
  ) {
    throw new Error(
      "A8e: worker evidence missing a required field (clue_id/anchor/quote/claim).",
    );
  }
}

/**
 * evidence 的确定性映射（§1.3）：
 * `clue_id ← 卡的 entity_id`（引擎已知，worker 不产出；H5 判别性）。
 */
export function evidenceFromWorker(
  cardClueId: string,
  item: WorkerEvidenceItem,
): EvidenceV2 {
  const evidence: EvidenceV2 = {
    clue_id: cardClueId,
    anchor: anchorForEvidence(item),
    quote: item.quote,
    claim: item.claim,
  };
  assertEvidenceComplete(evidence);
  return evidence;
}

/**
 * proposed_clue 的确定性映射（§1.5 / §1.6）：
 *   text ← clue；status ← proposed（深度内）或 blocked（depth+1 > maxDepth）；
 *   depth ← 父卡 depth + 1；sources ← 继承父卡；parent ← 父卡 entity_id。
 * ⛔ 不落 `reason`（§1.5 / H19）。
 */
export function clueFromWorker(
  card: HarvestCard,
  item: WorkerProposedClue,
  maxDepth: number,
): ClueV2 {
  const depth = card.depth + 1;
  const overMaxDepth = depth > maxDepth;
  const clue: ClueV2 = {
    text: item.clue,
    status: overMaxDepth ? "blocked" : "proposed",
    depth,
    sources: [...card.sources],
    parent: card.clueId,
  };
  if (overMaxDepth) clue.rationale = OVER_MAX_DEPTH_RATIONALE;
  return clue;
}

/** 收割写侧依赖注入面（副作用都从这里走，便于打桩）。 */
export interface HarvestDeps {
  /** 证据 channel：⛔ 显式传入，无默认值、无字符串推导（§1.4 / H14 / H15）。 */
  evidenceChannelId: string;
  /** 板 channel：新 clue 发往这里（板的唯一写者 = 调度器，spec §1）。 */
  boardChannelId: string;
  /** maxClues 上限（§1.6 / H12）。 */
  maxClues: number;
  /** maxDepth 上限（§1.6 / H11）。 */
  maxDepth: number;
  /**
   * 当前板上 clue 总数（用于 maxClues 封顶判定，§1.6）。
   * ⛔ **可变计数（`{ value }`）**：runWrite 把同一个 `deps.harvest` 传给**每一张**
   *    harvest 卡，共享同一对象；新 clue 发布时实时累加 `.value`。这样不仅单张卡内封顶，
   *    多张 harvest 卡在同一 tick 内也**累计**——卡 A 发完写回共享计数，卡 B 从更新后的
   *    计数重算 headroom，板面不会冲到 maxClues 之上（attempt 2 major finding 修复）。
   */
  boardClueCount: { value: number };
  /** 按 run_id 读该 run 的 worker.result.v1（读 board:agent-runs）。 */
  readWorkerResult(runId: string): Promise<WorkerResultV1 | null>;
  /** 发一条 research.evidence.v2 到证据 channel。 */
  publishEvidence(
    channelId: string,
    evidence: EvidenceV2,
    idempotencyKey: string,
  ): Promise<void>;
  /** 发一条 research.clue.v2 到板。 */
  publishClue(
    channelId: string,
    clue: ClueV2,
    idempotencyKey: string,
  ): Promise<void>;
}

/** 写入预算接口（由上层 runWrite 提供共享计数，见 §1.7）。 */
export interface HarvestBudget {
  /**
   * A10c——本轮总预算（--max-writes，固定）。
   * ⛔ 用于区分「该卡在当前预算下**永远不可收割**」（needed > 总预算，配置错误）
   *    与「本轮预算被前面的卡用掉、下一轮可继续」（needed ≤ 总预算但 remaining 不足）。
   */
  total(): number;
  /** 剩余可用写数。 */
  remaining(): number;
  /** 消耗 n 次写预算。 */
  consume(n: number): void;
}

/** 一张卡收割后的报告（H12/H13 要求显式报告跳过数，不得无声截断）。 */
export interface HarvestReport {
  clueId: string;
  runId: string;
  /** true ⇒ 整卡被跳过（预算不足），零 publish 零 CAS（§1.7 / H13）。 */
  skipped: boolean;
  /** 整卡跳过的原因：budget（本轮预算被前面的卡用尽，下一轮可继续）/ budget_infeasible（该卡在当前预算下永不可收割，配置错误）/ no_result（该 run 无 worker.result）。 */
  skippedReason?: "budget" | "budget_infeasible" | "no_result";
  /** budget 跳过时还差多少预算（§1.7：响亮报告差量）。 */
  budgetShortfall?: number;
  evidencePublished: number;
  cluesPublished: number;
  /** 因 maxClues 封顶被跳过的 clue 条数（H12：显式报告）。 */
  skippedClues: number;
  /** true ⇒ 上层应在所有发布完成后 CAS 到 explored（§1.1 / H6）。 */
  casExplored: boolean;
}

/**
 * 收割一张卡：读结果 → 预算判定 → 发布 evidence + 新 clue → 返回报告。
 * ⛔ 若剩余预算不足以发完整张卡（含最终 CAS）→ 整卡跳过：零 publish、零 CAS（§1.7 / H13）。
 * ⛔ 板上 clue 数已达 maxClues ⇒ 不新增 clue，但 evidence 照发，并显式报告跳过条数（§1.6 / H12）。
 * ⛔ 本函数**不**执行 CAS；CAS 由上层在发布全部成功后才调用（§1.1 / H6 / H7）。
 */
export async function harvestCard(
  hd: HarvestDeps,
  card: HarvestCard,
  runId: string,
  budget: HarvestBudget,
): Promise<HarvestReport> {
  const result = await hd.readWorkerResult(runId);
  if (!result) {
    // ⛔ A10a §0.3 / §1.2：找不到 worker.result ⇒ **不得写终态**。
    //   「没找到结果」≠「worker 确实无产出」。留 in_flight、响亮报告、casExplored=false，
    //   下一 tick 幂等重放仍可再收割。只有「结果存在且 evidences 为空数组」才可置终态。
    return {
      clueId: card.clueId,
      runId,
      skipped: true,
      skippedReason: "no_result",
      evidencePublished: 0,
      cluesPublished: 0,
      skippedClues: 0,
      casExplored: false,
    };
  }

  // ⛔ A10a §1.3：result 存在 ⇒ 形状守卫查 required 键齐全（evidences/proposed_clues/materials）。
  //   缺任一或非数组 ⇒ 响亮失败，绝不静默当作空产物（丢证据的根因）。
  assertWorkerResultShape(result);
  const evItems = result.evidences ?? [];
  const clueItems = result.proposed_clues ?? [];
  // materials 是 worker 的输入/产出清单，本收割步只读取校验形状，不发布（§1）。
  // ⛔ maxClues 封顶必须随发布递增（§1.6 / H12），不能只看 pre-tick 快照：
  //    boardClueCount 是快照，clue 一条条发出时要实时累加，否则多张 harvest 卡
  //    会把板面冲到 maxClues 之上。这里先算「本卡最多还能发几条 clue」，
  //    发布循环里再用运行计数逐条校验（见下）。
  const headroom = Math.max(0, hd.maxClues - hd.boardClueCount.value);
  const cluesAllowed = Math.min(clueItems.length, headroom);
  // 整卡所需写数：evidence 条数 + 将新增的 clue 条数 + 最终 CAS（§1.7）。
  const needed = evItems.length + cluesAllowed + 1;

  if (budget.remaining() < needed) {
    // ⛔ A10c §1.2——预算不足 ⇒ 整卡跳过：不发、不 CAS，留 in_flight，响亮报告（§1.7 / H13）。
    //    必须区分两种形态（§1.2）：「本轮预算被前面的卡用掉、下一轮可继续」（needed ≤ 总预算
    //    但 remaining 不足 ⇒ 仍报 budget）与「该卡在当前预算下**永不可收割**」（needed > 总预算
    //    本身，与本轮已用无关 ⇒ 配置错误，报可辨识的 budget_infeasible）。后者绝不与前者同形。
    const infeasible = needed > budget.total();
    return {
      clueId: card.clueId,
      runId,
      skipped: true,
      skippedReason: infeasible ? "budget_infeasible" : "budget",
      budgetShortfall: needed - budget.remaining(),
      evidencePublished: 0,
      cluesPublished: 0,
      skippedClues: clueItems.length,
      casExplored: false,
    };
  }

  let evidencePublished = 0;
  let cluesPublished = 0;
  let skippedClues = clueItems.length;
  // ⛔ maxClues 运行计数：`boardClueCount` 是**共享可变对象**（runWrite 把同一 `deps.harvest`
  //    传给每张 harvest 卡）。每发一条新 clue 就把 `.value` +1，从而单张卡（或多张卡累计）
  //    都不会把板面冲到 maxClues 之上（§1.6 / H12；attempt 2 major finding：卡间必须累计）。
  //    这里取的是对共享对象的引用，跨卡持久。
  const boardClueCount = hd.boardClueCount;

  // 先发 evidence（幂等键：dr-evidence:<run_id>:<index>，§1.2 / H8 / H9）。
  for (let i = 0; i < evItems.length; i += 1) {
    const evidence = evidenceFromWorker(card.clueId, evItems[i]);
    await hd.publishEvidence(
      hd.evidenceChannelId,
      evidence,
      `dr-evidence:${runId}:${i}`,
    );
    budget.consume(1);
    evidencePublished += 1;
  }

  // 再发新 clue（幂等键：dr-clue:<run_id>:<index>，§1.2 / H8 / H9）。
  for (let i = 0; i < clueItems.length; i += 1) {
    if (boardClueCount.value >= hd.maxClues) break; // ⛔ 已达 maxClues ⇒ 不新增 clue，但 evidence 已照发（§1.6 / H12）。
    const clue = clueFromWorker(card, clueItems[i], hd.maxDepth);
    await hd.publishClue(hd.boardChannelId, clue, `dr-clue:${runId}:${i}`);
    budget.consume(1);
    boardClueCount.value += 1;
    cluesPublished += 1;
    skippedClues -= 1;
  }

  // 全部发布成功 ⇒ 由上层执行最后的 CAS 到 explored（此处仅预留其预算，§1.7）。
  return {
    clueId: card.clueId,
    runId,
    skipped: false,
    evidencePublished,
    cluesPublished,
    skippedClues,
    casExplored: true,
  };
}
