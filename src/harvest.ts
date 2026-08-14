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
import { parseContentClueText } from "./ingest";
import {
  scanSecretFields,
  type SecretFieldHit,
  type SecretPatternName,
  type SecretScanField,
} from "./secret-scan";

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
 * E1 D3——worker.result.v1 里一条 material（profiles/roles/schemas/worker-result.v1.json）。
 * `digest` 是 worker 上报的提示，⛔ 不再当去重键（D1/GT-3）。
 */
export interface WorkerMaterialItem {
  uri: string;
  digest?: string;
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
  materials?: WorkerMaterialItem[];
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

/**
 * 收割所依赖的卡的最小视图。
 *
 * E1c D1——`text` 是**调度器侧**的 clue 文本（decideTick 从板上读出、随 harvest 决策下传）。
 * content-clue 的 text 形如 `web://<uri>@<digest>`（`contentClueText`，E1b D3），是本包
 * 唯一可信的 anchor 三件套来源：该 clue 由调度器自己 propose、transcript 由调度器按 digest
 * 从 `research:content` 取回并 spool，⛔ 与 worker 现编的 `locator`/`revision` 无关（GT-1b）。
 */
export interface HarvestCard {
  clueId: string;
  /** 卡的 clue 文本（调度器侧权威元数据；content-clue 携带 `web://<uri>@<digest>`）。 */
  text: string;
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
 *
 * ⛔ E1c D1——本函数**只**做机械拼装，⛔ 不再嗅探 locator 的字符串前缀。
 *    E1b 曾在这里加过一条 `locator.startsWith("web://")` 的分支，把「该不该前置 scheme」
 *    的判定交回给了 worker 吐出来的字符串形态；GT-1b 三次真跑证明 worker 每次现编
 *    （`web://<uri>` / `<digest>.md` / 裸 URI 三种形态），该分支**没命中**，16 条证据全部
 *    以畸形的 `content://http://…` 发到了无 DELETE 的 append-only 证据 channel 上。
 *    按宪法第十一条（闸门归代码），content 的锚点判定已上移到 `harvestCard`。
 * ⛔ E1d D1——闸门**只**取自卡侧事实（`cardAnchorPolicy`）：E1c 曾把它钉在 `source` 这个
 *    「schema 约束、形态稳定」的语义字段上，GT-1 第四次真跑证明它同样不稳定
 *    （整个 URI 跑进了 `source`、行号跑进了 `locator`），10 条证据又一次被本函数拼成
 *    `web://…e1-material4.png://L3@…`。**worker 回传的任何字段都不再参与判定**。
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
 * content 这条来源的名字。**它的权威用法是卡侧的 `card.sources`**——
 * 调度器自己把一条 `sources:["content"]` 的 clue 经 triage → dispatch 派给 `dr-worker-content`
 * （`buildContentClue`），所以「这张卡是不是 content 卡」全程是调度器自己的事实。
 *
 * ⛔ E1d D1（GT-3）——E1c 曾拿它去比 worker 回传的 `item.source`，把闸门交回给了 worker：
 *    GT-1 第四次真跑里 `source` 变成了 `"web://http://127.0.0.1:50287/e1-material4.png"`，
 *    闸门不命中、10 条证据全部落回通用模板发上了 append-only bus。
 *    ⇒ **闸门判定只读 `card.sources`（见 `isContentCard` / `cardAnchorPolicy`）**；
 *    与 `item.source` 的比较只剩两处非路由用途：D2 的不一致**记录**与非 content 卡上的**拒发**。
 */
export const CONTENT_SOURCE = "content";

/** E1c D1——content 证据的 anchor scheme（E3 核验器认的形态：`web://<uri>@<digest>#<range>`）。 */
export const CONTENT_ANCHOR_SCHEME = "web://";

/**
 * E1c D1 ⭐⭐ —— 一条 content-clue 的**调度器侧权威** anchor 元数据。
 * 该 content-clue 是调度器自己 propose 的（`buildContentClue`），transcript 是调度器按
 * 这个 digest 从 `research:content` 取回并 spool 的（`spoolContentTranscript`）——
 * 两个值全程在调度器手里，⛔ 与 worker 的回报无关。
 */
export interface ContentAnchorAuthority {
  /** transcript 的来源 URI（content-clue text 里的 `<uri>`）。 */
  uri: string;
  /** transcript 的权威 digest（content-clue text 里的 `<digest>`，= sha256(取回字节)）。 */
  digest: string;
}

/**
 * E1c D1 ⭐⭐ —— 从卡（调度器侧）解析出 content 证据的权威 `<uri>@<digest>`。
 *
 * 判据全部落在调度器侧的事实上：卡的 `sources` 含 `content`（该卡是 content-clue，
 * 由 `buildContentClue` 落板）且其 text 是 `web://<uri>@<digest>` 形态（`contentClueText`）。
 * ⛔ 不看 worker 回报的任何字段。派发侧 `spoolContentTranscript` 用的是同一份 clue text
 * 解析出的同一个 digest，故收割侧拼出的锚点与实际喂给 worker 的 transcript 严格同源。
 *
 * @returns 非 content-clue（或 text 非该形态）⇒ null。
 */
export function contentAnchorAuthority(card: HarvestCard): ContentAnchorAuthority | null {
  if (!isContentCard(card)) return null;
  const parsed = parseContentClueText(card.text ?? "");
  return parsed ? { uri: parsed.originUri, digest: parsed.digest } : null;
}

/**
 * E1d D1 ⭐⭐⭐ —— 「这张 harvest 卡是不是 content 卡」——**纯卡侧事实**。
 *
 * 该卡的 `sources` 是调度器自己写的：content-clue 由 `buildContentClue` 以 `sources:["content"]`
 * 落板，triage → dispatch 也是按这个字段把它派给 `dr-worker-content` 的。
 * ⛔ 不读 worker 回传的 `source`/`locator`/`revision` 中的任何一个（GT-3）。
 */
export function isContentCard(card: HarvestCard): boolean {
  return card.sources.includes(CONTENT_SOURCE);
}

/**
 * E1d D1 ⭐⭐⭐ —— 一张卡的锚点策略：**content 锚点路径的触发信号，整体取自卡自身**。
 *
 * 这是本包的全部改动面。此前两次都栽在「把闸门钉在某个 worker 可控字段上」：
 *   - E1b 钉 `locator` 的 `web://` 前缀 ⇒ worker 换成 `<digest>.md` / 裸 URI ⇒ 绕过；
 *   - E1c 钉 `source === "content"` ⇒ worker 把整个 URI 塞进 `source` ⇒ 绕过（GT-1 第四次）。
 * 每绕过一次，就有一批畸形锚点被不可回退地发到无 DELETE 的证据 channel 上。
 * ⇒ 触发信号改为调度器自己知道的事实，worker 再怎么换字段布局都不影响路由（GT-3）。
 */
export interface CardAnchorPolicy {
  /** 该卡是 content 卡（`card.sources` 含 `content`）⇒ 其 evidence **一律**走 content 锚点路径。 */
  isContent: boolean;
  /**
   * 该卡的调度器侧权威 `<uri>@<digest>`（`contentAnchorAuthority`）。
   * content 卡而 text 不是 `web://<uri>@<digest>` 形态 ⇒ null ⇒ 响亮失败（D3），
   * ⛔ 绝不回退去用 worker 字段兜底。非 content 卡恒为 null。
   */
  authority: ContentAnchorAuthority | null;
}

/** E1d D1 ⭐⭐⭐ —— 由卡（且只由卡）算出锚点策略。⛔ 入参里没有、也不得有 worker 的回报。 */
export function cardAnchorPolicy(card: HarvestCard): CardAnchorPolicy {
  return { isContent: isContentCard(card), authority: contentAnchorAuthority(card) };
}

/**
 * E1c D2b —— `range` 形态归一。
 *
 * GT-1b：同一份 input 的三次真跑，worker 分别回了 `"L9"` / `"9"` / `"L3:1-43"`。
 * 最终 anchor 里必须是统一形态（与 `code://` 现行的 `#L<a>[-L<b>]` 同构）：
 * 补齐 `L` 前缀即可，⛔ range 的其余部分**原样保留**（`L3:1-43` 的行:字符起-止不得被改写）。
 *
 * @returns 归一后的 range；空/缺省 ⇒ undefined（调用方据此省略整个 `#` 段，H4）。
 */
export function normalizeAnchorRange(range?: string): string | undefined {
  const trimmed = (range ?? "").trim();
  if (!trimmed) return undefined;
  // 已带 L/l 前缀 ⇒ 只把前缀归一成大写 L；不带 ⇒ 补上 L。其余字符逐字保留。
  return `L${trimmed.replace(/^[Ll]/, "")}`;
}

/**
 * E1c D1 ⭐⭐ —— 由**调度器侧权威值**拼出 content 证据的 anchor：
 * `web://<uri>@<digest>#<range>`（range 缺省时省略 `#` 段，H4）。
 * range 经 `normalizeAnchorRange` 归一（D2b）；⛔ worker 的 locator/revision 不参与拼装。
 */
export function contentAnchor(
  authority: ContentAnchorAuthority,
  range?: string,
): string {
  const base = `${CONTENT_ANCHOR_SCHEME}${authority.uri}@${authority.digest}`;
  const normalized = normalizeAnchorRange(range);
  return normalized ? `${base}#${normalized}` : base;
}

/**
 * 由一条 worker evidence 生成 anchor。
 *
 * E1d D1 ⭐⭐⭐——**路由信号是 `policy`（卡侧事实），不是这条 evidence 的任何字段**：
 * 卡是 content 卡 ⇒ **一律**走 `contentAnchor`（调度器侧权威 `<uri>@<digest>`），worker 只提供
 * `range`。⛔ content 卡而 `policy.authority` 缺失 ⇒ **响亮报错**（D3）：绝不回退成
 * `<worker source>://<worker locator>@<worker revision>`——那正是 GT-1/GT-2 里两批证据
 * （16 条 `content://http://…` 与 10 条 `web://….png://L3@…`）被以畸形形态发上
 * 无 DELETE 的 append-only bus 的成因。
 *
 * ⛔ 非 content 卡（`code://` / `wiki://` …）逐字不变：source/locator/revision 任一缺失/为空
 *    ⇒ 响亮报错（不静默塞空串）。缺失时若回退成空串会得到退化的 "://@" 锚——非空故能骗过
 *    assertEvidenceComplete 的「四必填非空」检查，随后被不可回退地发布到无 DELETE 的
 *    append-only bus。这与本仓「解析不到 secret 不得塞空串」的纪律同源（src/tick-run.ts）。
 */
export function anchorForEvidence(
  item: WorkerEvidenceItem,
  policy?: CardAnchorPolicy | null,
): string {
  // E1d D1：闸门只看卡侧事实（⛔ 不读 item.source / item.locator / item.revision）。
  if (policy?.isContent) {
    if (!policy.authority) {
      throw new Error(
        "E1d D1: this content card has no dispatcher-side anchor authority (uri@digest from the content-clue text); refusing to fall back to the worker-reported source/locator/revision (GT-1: the worker re-invents that field layout every run).",
      );
    }
    return contentAnchor(policy.authority, item.range);
  }
  const source = item.source;
  const locator = item.locator;
  const revision = item.revision;
  // ⛔ 纵深防御（非路由）：非 content 卡上 worker 自称 content ⇒ 卡侧根本没有权威值可用，
  //    通用模板会拼出 `content://<worker locator>@<worker revision>` 这种 E3 永远核验不了的锚。
  //    这里只**拒发**，不改变路由——content 锚点路径只由卡侧的 `policy.isContent` 触发。
  if ((source ?? "").trim() === CONTENT_SOURCE) {
    throw new Error(
      "E1d D1: worker claims a content-sourced evidence on a card that is not a content card; there is no dispatcher-side authority to anchor on, and falling back to the worker-reported locator/revision is forbidden.",
    );
  }
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
 * E1d D1——`policy` 是**卡侧**算出的锚点策略（`cardAnchorPolicy`）：content 卡 ⇒ 权威
 * `<uri>@<digest>`；非 content 卡不传 ⇒ 走既有 `<source>://<locator>@<revision>` 路径。
 */
export function evidenceFromWorker(
  cardClueId: string,
  item: WorkerEvidenceItem,
  policy?: CardAnchorPolicy | null,
): EvidenceV2 {
  const evidence: EvidenceV2 = {
    clue_id: cardClueId,
    anchor: anchorForEvidence(item, policy),
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
  /**
   * E1 D3——对一条 material 执行 ingest 并按结果落 content-clue（D4/D5/D6）。
   * 由 harvest 在「materials 非空」时对每条 material 调用（D3）。
   * ⛔ 未接线（undefined）⇒ 行为与 base 逐字一致：materials 数组只读校验形状、不发布（GT-2）。
   * 该 dep 已在内部负责 maxClues 封顶（D9：content-clue 也走同一个 boardClueCount 实时累加）。
   */
  ingestMaterial?: (
    material: WorkerMaterialItem,
    parentClueId: string,
    parentDepth: number,
    idempotencyKey: string,
  ) => Promise<ClueV2 | null>;
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

/**
 * E2b §1.3 ⭐ —— 一条 web 类 evidence 被机械拒发的判据（本包最重要的一条）。
 *
 * 真机实证：`dr-worker-web` 会把活 URL 当证据出处交差（`source:"web"` + `locator:"https://…"`
 * + 空 `revision` + 引文直接摘自实时页面）。按宪法第十一条（闸门归代码），这道闸必须机械化
 * 在发布路径上。本函数是**形态**判定（不查存在性——存在性核验属 E3）：
 *
 *   - source 为 web 类（含 "web"、"web-search"）且 `revision` 非内容指纹形态 ⇒ 拒发；
 *   - locator 为裸 `http(s)://` URL 而 `revision` 为空（"直接引用活页面"的形状）⇒ 拒发；
 *   - 命中 ⇒ 该条 evidence 不发布，⛔ 不连坐整张卡的其余 evidence（与既有失败粒度纪律同构）。
 *
 * 「内容指纹形态」= 纯十六进制、长度落在常见内容摘要（sha256=64 / sha1=40 / md5=32）语义内。
 * 空串、日期、URL、"latest" 一类一律视为非指纹形态。
 *
 * @returns 拒发原因（字符串，不含 quote 全文）；返回 null 表示合规、可发布。
 */
export function webEvidenceRejectionReason(item: WorkerEvidenceItem): string | null {
  const source = (item.source ?? "").trim();
  const locator = (item.locator ?? "").trim();
  const revision = (item.revision ?? "").trim();
  const isWebClass = source === "web" || source === "web-search" || source === "web-search-engine";
  const isHttpLocator = /^https?:\/\//i.test(locator);

  // 判据 A：web 类 source 的 revision 必须是内容指纹形态。
  if (isWebClass) {
    if (!isContentFingerprint(revision)) {
      return "web evidence revision is not a content fingerprint (hex, sha256/sha1/md5 length); refusing to publish a live-URL-sourced evidence with no replayable snapshot";
    }
  }

  // 判据 B：裸 http(s):// locator + 空 revision ⇒ 正是"直接引用活页面"的形状，拒发。
  if (isHttpLocator && revision === "") {
    return "evidence locator is a bare http(s) URL with empty revision (live-page citation shape); refusing to publish without a replayable snapshot";
  }

  return null;
}

/**
 * E2b §1.3 —— 判定一个字符串是否为「内容指纹形态」：纯小写十六进制、长度落在常见摘要算法范围内。
 * sha256=64、sha1=40、md5=32（以及其它偶数长度 32..64 的纯十六进制串一律放行，留出向后兼容）。
 * ⛔ 空串、日期、URL、"latest"、含非十六进制字符的串一律视为非指纹形态。
 */
export function isContentFingerprint(s: string): boolean {
  if (!s) return false;
  // 纯小写十六进制（允许大写归一化为小写比较）。
  if (!/^[0-9a-fA-F]+$/.test(s)) return false;
  const len = s.length;
  // 常见摘要长度：md5(32) / sha1(40) / sha256(64)；以及偶数长度 32..64 的纯十六进制兼容放行。
  if (len === 32 || len === 40 || len === 64) return true;
  if (len >= 32 && len <= 64 && len % 2 === 0) return true;
  return false;
}

/**
 * E2b §1.3 ⭐ —— 一条 evidence 被机械拒发的记录（写进运行记录，便于排障）。
 * ⛔ 不得回抄 quote 全文（避免把未经核验的内容再落一遍）。只记 clue_id / 判据 / source/locator 形态摘要。
 */
export interface EvidenceRejection {
  /** 被拒发的 evidence 所属的卡（点名 clue_id，spec §1.3）。 */
  clueId: string;
  /** 该条 evidence 在 worker.result.v1.evidences 中的稳定序号（便于回查，不回抄 quote）。 */
  index: number;
  /** 拒发原因（与 webEvidenceRejectionReason 返回值一致，点名失败的判据）。 */
  reason: string;
  /** source 字段值（用于排障；非 quote 正文）。 */
  source: string;
  /** locator 形态摘要（仅记是否 http(s) URL，不回抄完整 URL 正文，避免再落活链接）。 */
  locatorShape: "http-url" | "other";
  /** revision 形态摘要（是否为指纹形态、长度；不回抄 revision 正文）。 */
  revisionShape: "empty" | "fingerprint" | "other";
}

/**
 * E1k2 D5 ⭐ —— 一条 evidence 因命中凭证形态而被拒发的固定原因。
 * ⛔ 固定文案：拦截记录里**不得**出现命中的内容本身（那等于把凭证换个地方再落一遍）。
 */
export const SECRET_PATTERN_REJECTION_REASON =
  "evidence field matches a credential-shaped pattern (see patterns/fields); refusing to publish it to the append-only evidence channel, which has no DELETE";

/**
 * E1k2 D5 ⭐⭐ —— 一条 evidence 被凭证形态闸门拦下的记录（条目级，⛔ 不连坐同卡其余证据）。
 *
 * 记录内容严格限定为「**哪张卡、第几条、命中了哪些 pattern、在哪些字段**」：
 * ⛔ 不含命中的串本身、⛔ 不回抄 `quote` 全文（与 `EvidenceRejection` 同纪律）。
 * 否则这道闸门就成了「把凭证从证据 channel 搬进运行记录」的搬运工——两边都是留痕介质。
 */
export interface SecretPatternRejection {
  /** 被拒发的 evidence 所属的卡（点名 clue_id，D5）。 */
  clueId: string;
  /** 该条 evidence 在 worker.result.v1.evidences 中的稳定序号（便于回查，⛔ 不回抄 quote）。 */
  index: number;
  /** 固定拒发原因（`SECRET_PATTERN_REJECTION_REASON`）。 */
  reason: string;
  /** 逐字段的命中明细：字段名 + 该字段命中的 pattern 名。 */
  hits: SecretFieldHit[];
  /** 命中的字段名（去重，便于聚合；D5 要求点名字段）。 */
  fields: SecretScanField[];
  /** 命中的 pattern 名（去重，便于聚合；D5 要求点名 pattern）。 */
  patterns: SecretPatternName[];
}

/**
 * E1k2 D4/D5 ⭐⭐ —— 发布前的凭证形态判定：扫 `quote` / `claim` / `anchor` 三字段。
 *
 * ⛔ 在 `publishEvidence` **之前**调用：证据 channel 是 append-only、没有 DELETE，
 *    发出去就不可撤回（GT-1）。
 *
 * @returns 命中 ⇒ 一条拒发记录（⛔ 不含命中内容）；返回 null 表示三字段干净、可发布。
 */
export function secretPatternRejection(
  clueId: string,
  index: number,
  evidence: EvidenceV2,
): SecretPatternRejection | null {
  const hits = scanSecretFields({
    quote: evidence.quote,
    claim: evidence.claim,
    anchor: evidence.anchor,
  });
  if (hits.length === 0) return null;
  return {
    clueId,
    index,
    reason: SECRET_PATTERN_REJECTION_REASON,
    hits,
    fields: hits.map((h) => h.field),
    patterns: [...new Set(hits.flatMap((h) => h.patterns))],
  };
}

/**
 * E1c D1 / E1d D3——一条证据因**卡上没有权威元数据**而被拒发的原因（条目级，不连坐整卡）。
 * 两种命中形态，字面原因相同（都是"这张卡拼不出可核验的 content 锚点"）：
 *   - content 卡但 text 不是 `web://<uri>@<digest>` 形态 ⇒ D3 响亮失败；
 *   - 非 content 卡而 worker 自称 `source="content"` ⇒ 纵深防御拒发。
 * ⛔ 两种形态都绝不回退去用 worker 现编的 source/locator/revision（GT-1 / GT-3）。
 */
export const CONTENT_AUTHORITY_MISSING_REASON =
  "content evidence has no dispatcher-side anchor authority (the card is not a content-clue carrying web://<uri>@<digest>); refusing to anchor on worker-reported locator/revision";

/**
 * E1c D2 ⭐ —— worker 回报的 `locator`/`revision` 与调度器侧权威值不一致的**可观测记录**。
 *
 * GT-1b：worker 每次现编锚点三件套（`<digest>.md` + 截断 16 位 digest / 裸 URI + 完整 sha256 …）。
 * 本包以调度器侧的值为准继续发布（`quote` 是对的，锚点由调度器补正即可），但**不得静默丢弃**
 * 这个不一致——它是持续观察 worker 行为的唯一窗口。
 *
 * ⛔ 不回抄 `quote` 全文（与 `EvidenceRejection` 同纪律：不把未经核验的内容再落一遍）。
 */
export interface AnchorAuthorityMismatch {
  /** 不一致所属的卡（点名 clue_id，D2）。 */
  clueId: string;
  /** 该条 evidence 在 worker.result.v1.evidences 中的稳定序号（便于回查）。 */
  index: number;
  /** 命中不一致的字段（source / locator / revision，可同时命中）。 */
  fields: Array<"source" | "locator" | "revision">;
  /**
   * E1d D2 ⭐——worker 回报的 `source`（原样记录）。
   * GT-1 第四次真跑把整个 URI 塞进了这个字段；它已不再参与任何判定，
   * 但**必须留痕**——这是持续观察 worker 字段布局漂移的唯一窗口。
   */
  workerSource: string;
  /** 该卡的语义 source（`content`）——worker 本应回的值。 */
  authoritativeSource: string;
  /** worker 回报的 locator（原样记录，便于观察 worker 行为；⛔ 非 quote 正文）。 */
  workerLocator: string;
  /** 调度器侧权威 URI（实际进 anchor 的值）。 */
  authoritativeUri: string;
  /** worker 回报的 revision（原样记录）。 */
  workerRevision: string;
  /** 调度器侧权威 digest（实际进 anchor 的值）。 */
  authoritativeDigest: string;
}

/**
 * E1c D2 ⭐ —— 交叉核对 worker 回报的锚点三件套与调度器侧权威值。
 *
 * 核对规则（只做**等值**核对，不做形态嗅探）：
 *   - source：与该卡的语义 source（`content`）逐字比较（E1d D2：GT-1 第四次把整个 URI
 *     塞进了 source ⇒ 不相等 ⇒ 记录）；
 *   - locator：允许 worker 自带 `web://` 前缀（persona 期望的形态），去掉后与权威 uri 逐字比较；
 *   - revision：与权威 digest 逐字比较（截断的 16 位前缀 ⇒ 不相等 ⇒ 记录）。
 *
 * ⛔ E1d——本函数只**记录**，不参与路由：不管命中几个字段，该条 evidence 都照常以权威锚点发布。
 *
 * @returns 三侧全一致 ⇒ null（⛔ 不产生记录，判据 3 的活性半边）；否则 ⇒ 一条不一致记录。
 */
export function anchorAuthorityMismatch(
  clueId: string,
  index: number,
  item: WorkerEvidenceItem,
  authority: ContentAnchorAuthority,
): AnchorAuthorityMismatch | null {
  const workerSource = (item.source ?? "").trim();
  const workerLocator = (item.locator ?? "").trim();
  const workerRevision = (item.revision ?? "").trim();
  const bareLocator = workerLocator.startsWith(CONTENT_ANCHOR_SCHEME)
    ? workerLocator.slice(CONTENT_ANCHOR_SCHEME.length)
    : workerLocator;
  const fields: Array<"source" | "locator" | "revision"> = [];
  if (workerSource !== CONTENT_SOURCE) fields.push("source");
  if (bareLocator !== authority.uri) fields.push("locator");
  if (workerRevision !== authority.digest) fields.push("revision");
  if (fields.length === 0) return null;
  return {
    clueId,
    index,
    fields,
    workerSource,
    authoritativeSource: CONTENT_SOURCE,
    workerLocator,
    authoritativeUri: authority.uri,
    workerRevision,
    authoritativeDigest: authority.digest,
  };
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
  /**
   * E1 D3/D4——本卡 ingest 落板的 content-clue 数（含 proposed 与 blocked）。
   * D2 复用路径不计（D5 幂等）；maxClues 封顶未落板不计（D9）。
   */
  contentCluesPublished: number;
  /**
   * E1 D6——本卡因 ingest 失败而出生即 blocked 的 content-clue 数。
   * 父 clue 不连坐（照常 explored）；该计数便于排障。
   */
  contentCluesBlocked: number;
  /**
   * E1 D9——本卡因 maxClues 封顶而被跳过（未调 ingest、未落板）的 content-clue 条数。
   * 与既有 clue 封顶（`skippedClues`）同构：封顶必须有可观测的报告，不得无声截断。
   * D2 复用路径不计入此字段（复用是幂等静默，不是封顶）。
   */
  skippedContentClues: number;
  /**
   * E1 E2b §1.3 ⭐ —— 被机械拒发的 evidence 记录（条目级，不连坐整卡）。
   * 每条点名 clue_id、稳定序号、失败的判据；⛔ 不含 quote 全文。
   */
  evidenceRejections: EvidenceRejection[];
  /**
   * E1k2 D6 ⭐⭐ —— 被凭证形态闸门拦下的 evidence 记录（条目级，与 `evidenceRejections` 并列同构）。
   *
   * ⛔ 静默拦截即未交付：本数组是「这一轮为什么证据数少了」的唯一解释——
   *    每条点名 clue_id、命中的 pattern 名与字段名（⛔ 不含命中内容、⛔ 不回抄 quote）。
   *    `HarvestReport` 由 tick-entry 直接 JSON 落进运行记录，故拦截天然可观测。
   */
  secretRejections: SecretPatternRejection[];
  /**
   * E1c D2 ⭐ —— worker 回报的锚点三件套与调度器侧权威值不一致的记录（条目级）。
   * ⛔ 不一致**不拒发**该条 evidence（quote 是对的，锚点由调度器补正）；
   * ⛔ 也不得静默丢弃这个不一致（那是持续观察 worker 行为的唯一窗口）。
   */
  anchorMismatches: AnchorAuthorityMismatch[];
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
      contentCluesPublished: 0,
      contentCluesBlocked: 0,
      skippedContentClues: 0,
      evidenceRejections: [],
      secretRejections: [],
      anchorMismatches: [],
      casExplored: false,
    };
  }

  // ⛔ A10a §1.3：result 存在 ⇒ 形状守卫查 required 键齐全（evidences/proposed_clues/materials）。
  //   缺任一或非数组 ⇒ 响亮失败，绝不静默当作空产物（丢证据的根因）。
  assertWorkerResultShape(result);
  const evItems = result.evidences ?? [];
  const clueItems = result.proposed_clues ?? [];
  const matItems = result.materials ?? [];
  // E1 D3——materials 接线时逐条 ingest；未接线 ⇒ 与 base 逐字一致（GT-2：只读校验形状，不发布）。
  const ingestEnabled = typeof hd.ingestMaterial === "function" && matItems.length > 0;
  // ⛔ maxClues 封顶必须随发布递增（§1.6 / H12），不能只看 pre-tick 快照：
  //    boardClueCount 是快照，clue 一条条发出时要实时累加，否则多张 harvest 卡
  //    会把板面冲到 maxClues 之上。这里先算「本卡最多还能发几条 clue」，
  //    发布循环里再用运行计数逐条校验（见下）。
  const headroom = Math.max(0, hd.maxClues - hd.boardClueCount.value);
  // 整卡所需写数：evidence 条数 + 将新增的 clue 条数 + 最终 CAS（§1.7）。
  // E1 D3/D9——content-clue 也是 clue，与普通 clue 共享同一 boardClueCount/headroom。
  //   最坏情况下本卡新增的 clue 写数（普通 + content）上界 = min(总待发, headroom)，
  //   而非「普通 clue 取满 headroom 之外再单独算 content」——两者竞争同一计数器。
  // E1b D6 / GT-5——一份**新** transcript 实际耗 **2 次 bus 写**（publishDoc 到 research:content
  //   ＋ content-clue 落板），原 `needed` 只预留 1 ⇒ --max-writes 可被超出「每份新转写 1 次」。
  //   这里按 worst case（每条被 ingest 的 material 都是新 transcript）给每条预留 2 次写
  //   （doc + clue）；复用路径在发布循环里实际只 consume 0（返回 null），不会写超。
  //   ⛔ 不得一律 +1：复用路径（不新发 doc）仍只算它实际要写的次数（0），由循环按返回值精确 consume。
  const regularClueWrites = Math.min(clueItems.length, headroom);
  const contentClueWrites = ingestEnabled
    ? Math.min(matItems.length, Math.max(0, headroom - regularClueWrites))
    : 0;
  // D6：每条被 ingest 的 material（worst case 新 transcript）= 1 doc 写 + 1 clue 写。
  const contentDocWrites = contentClueWrites;
  const needed = evItems.length + regularClueWrites + contentClueWrites + contentDocWrites + 1;

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
      contentCluesPublished: 0,
      contentCluesBlocked: 0,
      skippedContentClues: 0,
      evidenceRejections: [],
      secretRejections: [],
      anchorMismatches: [],
      casExplored: false,
    };
  }

  let evidencePublished = 0;
  let cluesPublished = 0;
  let skippedClues = clueItems.length;
  let contentCluesPublished = 0;
  let contentCluesBlocked = 0;
  let skippedContentClues = 0;
  const evidenceRejections: EvidenceRejection[] = [];
  const secretRejections: SecretPatternRejection[] = [];
  const anchorMismatches: AnchorAuthorityMismatch[] = [];
  // E1d D1 ⭐⭐⭐——本卡的锚点策略（是不是 content 卡 + 调度器侧权威 `<uri>@<digest>`）。
  //   ⛔ 在循环外算一次，且**只**由卡算出：它是本卡所有 evidence 的路由信号，
  //      与逐条 worker evidence 的字段布局无关（GT-3：worker 的字段布局每跑都在变）。
  const policy = cardAnchorPolicy(card);
  // ⛔ maxClues 运行计数：`boardClueCount` 是**共享可变对象**（runWrite 把同一 `deps.harvest`
  //    传给每张 harvest 卡）。每发一条新 clue 就把 `.value` +1，从而单张卡（或多张卡累计）
  //    都不会把板面冲到 maxClues 之上（§1.6 / H12；attempt 2 major finding：卡间必须累计）。
  //    这里取的是对共享对象的引用，跨卡持久。
  const boardClueCount = hd.boardClueCount;

  // 先发 evidence（幂等键：dr-evidence:<run_id>:<index>，§1.2 / H8 / H9）。
  // E2b §1.3 ⭐——条目级机械拒发：活 URL evidence 不发布，但**不连坐**整张卡的其余 evidence。
  //    命中 ⇒ 该条不发布，把拒发原因写进 evidenceRejections（点名 clue_id 与失败判据），
  //    ⛔ 不回抄 quote 全文；同卡合规 evidence 照常发布。
  for (let i = 0; i < evItems.length; i += 1) {
    const item = evItems[i];
    // E1d D1 ⭐⭐⭐——闸门取自**卡自身**（`policy.isContent` ← `card.sources`，调度器侧事实）。
    //   ⛔ 不读 `item.source` / `item.locator` / `item.revision` 中的任何一个：GT-1 四次真跑
    //   四种字段布局，钉在任何 worker 可控字段上都会被下一种形态绕过（E1b 钉 locator 前缀、
    //   E1c 钉 source 语义字段，各被绕过一次，两批畸形锚点已不可回退地上了 append-only bus）。
    //   ⇒ 本卡是 content 卡 ⇒ 其 evidence **一律**走权威锚点，worker 只提供 quote 与 range。
    if (policy.isContent) {
      if (!policy.authority) {
        // D3——content 卡却没有权威元数据（text 非 `web://<uri>@<digest>` 形态）⇒ 无从拼出
        // 可核验的锚点。条目级响亮拒发（不连坐整卡），
        // ⛔ 绝不回退去用 worker 现编的 source/locator/revision 拼一个 E3 永远核验不了的锚点。
        evidenceRejections.push({
          clueId: card.clueId,
          index: i,
          reason: CONTENT_AUTHORITY_MISSING_REASON,
          source: (item.source ?? "").slice(0, 32),
          locatorShape: /^https?:\/\//i.test((item.locator ?? "").trim())
            ? "http-url"
            : "other",
          revisionShape: (item.revision ?? "").trim() === ""
            ? "empty"
            : isContentFingerprint((item.revision ?? "").trim())
              ? "fingerprint"
              : "other",
        });
        continue;
      }
      // D2——交叉核对 source/locator/revision 三个维度：不一致 ⇒ 留一条可观测记录
      //   （点名 clue_id 与两侧的值，⛔ 不含 quote 全文），但**照常发布**，
      //   且 anchor 以调度器侧权威值为准（⛔ 不因不一致拒发整条证据）。
      const mismatch = anchorAuthorityMismatch(card.clueId, i, item, policy.authority);
      if (mismatch) anchorMismatches.push(mismatch);
      // D1/D4——`web://<uri>@<digest>#<归一 range>`：worker 只提供 range。
      // ⛔ E2b 的活 URL 拒发判据在此路径**不适用**：锚点里的 `<digest>` 是调度器 spool 下来的
      //    transcript 的权威摘要，本身就是可回放快照（E2b 要防的正是"无快照的活页面引用"）。
      const evidence = evidenceFromWorker(card.clueId, item, policy);
      // E1k2 D4 ⭐⭐——凭证形态闸门：扫 quote/claim/anchor 三字段，命中 ⇒ 该条不发布。
      //   ⛔ 必须在 publishEvidence **之前**：证据 channel 是 append-only、没有 DELETE。
      //   ⛔ 条目级（continue），不连坐同卡其余 evidence 与 clue（复用 E2b 的失败粒度纪律）。
      //   注：content 锚点里的 `<digest>` 是标准摘要形态，D3 豁免使其不会被高熵规则误伤。
      const contentSecret = secretPatternRejection(card.clueId, i, evidence);
      if (contentSecret) {
        secretRejections.push(contentSecret);
        continue;
      }
      await hd.publishEvidence(
        hd.evidenceChannelId,
        evidence,
        `dr-evidence:${runId}:${i}`,
      );
      budget.consume(1);
      evidencePublished += 1;
      continue;
    }
    // ⛔ 纵深防御（**非路由**，E1d D1）：非 content 卡上 worker 自称 content ——
    //    卡侧根本没有权威 `<uri>@<digest>` 可用，通用模板只会拼出 `content://<worker
    //    locator>@<worker revision>` 这种 E3 永远核验不了的锚点。条目级拒发（不连坐整卡），
    //    与 E1c 逐字同形。⛔ 这里读 `item.source` 不构成闸门：它只能让证据**发不出去**，
    //    不能让任何证据走上 content 锚点路径——那条路径只由 `policy.isContent` 打开。
    const claimsContentSource = (item.source ?? "").trim() === CONTENT_SOURCE;
    const rejection = claimsContentSource
      ? CONTENT_AUTHORITY_MISSING_REASON
      : webEvidenceRejectionReason(item);
    if (rejection) {
      evidenceRejections.push({
        clueId: card.clueId,
        index: i,
        reason: rejection,
        source: (item.source ?? "").slice(0, 32),
        locatorShape: /^https?:\/\//i.test((item.locator ?? "").trim())
          ? "http-url"
          : "other",
        revisionShape: (item.revision ?? "").trim() === ""
          ? "empty"
          : isContentFingerprint((item.revision ?? "").trim())
            ? "fingerprint"
            : "other",
      });
      continue;
    }
    const evidence = evidenceFromWorker(card.clueId, item);
    // E1k2 D4 ⭐⭐——凭证形态闸门（非 content 路径，与上方 content 路径同一道闸）。
    //   ⛔ 在 publishEvidence 之前；命中 ⇒ 条目级拒发，不连坐整卡。
    const secret = secretPatternRejection(card.clueId, i, evidence);
    if (secret) {
      secretRejections.push(secret);
      continue;
    }
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

  // E1 D3——对该卡 worker 结果里的**每条 material** 调 ingest（D3）。
  //   接线（hd.ingestMaterial）且 materials 非空才执行；否则与 base 逐字一致（GT-2）。
  //   ingestMaterial 内部负责 D1（权威 digest）/ D2（复用）/ D4（propose）/ D5（复用不 propose）/
  //   D6（失败出生即 blocked，父 clue 不连坐）。
  //   ⛔ D9 maxClues 封顶在**此处**判定（与既有 clue 封顶同构、同计数器 boardClueCount）：
  //   达到 maxClues ⇒ 该 material 不调 ingest、不落板，计入 skippedContentClues（可观测报告），
  //   绝不无声截断。这与 D2 复用路径（ingestMaterial 返回 null）形态不同：复用是幂等静默、
  //   不计入 skippedContentClues；封顶是显式跳过、必须报告（spec §2 判据 9）。
  //   落板的 content-clue 计入 boardClueCount（D9：content-clue 也是 clue）与 budget。
  if (ingestEnabled) {
    for (let i = 0; i < matItems.length; i += 1) {
      // D9：封顶判定在调用 ingest 之前（与上方普通 clue 的 `boardClueCount.value >= maxClues` 同构）。
      if (boardClueCount.value >= hd.maxClues) {
        skippedContentClues += matItems.length - i;
        break;
      }
      const m = matItems[i];
      const clue = await hd.ingestMaterial!(m, card.clueId, card.depth, `dr-content:${runId}:${i}`);
      if (clue) {
        contentCluesPublished += 1;
        if (clue.status === "blocked") contentCluesBlocked += 1;
        // D9：content-clue 落板 ⇒ 计入 boardClueCount（与既有 clue 封顶同构）。
        boardClueCount.value += 1;
        // E1b D6 / GT-5——一份**新** transcript 实际耗 2 次 bus 写（publishDoc 到 research:content
        //   ＋ content-clue 落板，都在 ingestMaterial 内部完成）。返回非 null ⇒ 是新 transcript
        //   （复用路径返回 null，D5 幂等）⇒ consume 2（doc + clue）。⛔ 原 consume(1) 漏算 doc 写。
        budget.consume(2);
      }
    }
  }

  // 全部发布成功 ⇒ 由上层执行最后的 CAS 到 explored（此处仅预留其预算，§1.7）。
  return {
    clueId: card.clueId,
    runId,
    skipped: false,
    evidencePublished,
    cluesPublished,
    skippedClues,
    contentCluesPublished,
    contentCluesBlocked,
    skippedContentClues,
    evidenceRejections,
    secretRejections,
    anchorMismatches,
    casExplored: true,
  };
}
