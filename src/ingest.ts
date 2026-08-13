/**
 * N1/E1 —— ingest 节点：按**权威 digest**全局去重 + 取材 + MinerU 转写为 doc(transcript)
 *
 * 结构沿用 S2/S3/S4：决策与纯逻辑纯函数化，IO 只在执行壳里，全部经 deps 注入。
 * 本模块不 import ./bus（spec §6 E14）：bus / HTTP 交互一律走 deps。
 *
 * E1 权威 digest（spec §1 D1/D2）：
 *   - digest 由**取回的字节**算 sha256 得出，作为唯一去重键与发布键；
 *   - ⛔ 不得再拿 worker 上报的 `digest` 当键（GT-3）：顺序变成「先 fetch，后算，再查重」；
 *   - worker 报的 `digest`（`MaterialInput.digest`）降级为可选提示，**可以完全忽略**。
 *
 * 硬约束（spec 正文）：
 *   - 同 digest 已存在 doc(transcript) ⇒ 直接返回已有 doc，绝不调 MinerU（E1/E3 / D2）
 *   - 4MB 硬护栏：超限响亮报错、不分段（E9）
 *   - 不支持的扩展名响亮失败，不得静默跳过（E10）
 *   - MinerU 失败 ⇒ 失败粒度下沉到 material（D6）：该 material 的 content-clue 出生即 blocked，
 *     ⛔ **父 clue 不连坐**（取代 GT-4 的 `markBlocked(父 clueId)` + 整体抛错）
 *   - 不并发打 MinerU：串行化，任一时刻在飞 = 1（E13 / D7）
 */
import { createHash } from "node:crypto";
import type { ClueV2, DocV2 } from "./protocol";

/** agent-bus 消息结构（E17 用例直接喂字面量数组）。 */
export interface BusMessage {
  message_id: string;
  channel_id: string;
  channel_seq: number;
  kind: string;
  payload: unknown;
  entity_id: string;
  supersedes: string | null;
  created_at: string;
}

/** 取材结果。 */
export interface FetchedMaterial {
  filename: string;
  bytes: Uint8Array;
}

/**
 * 一次 ingest 的输入：URI + 归属 clue + parent 的 depth（E1 D4：content-clue depth = parent depth）。
 * `digest` 是 worker 上报的提示值，⛔ **不再当去重键**（D1/GT-3），实现里可完全忽略。
 */
export interface MaterialInput {
  uri: string;
  /** worker 上报的 digest（降级为可选提示，D1：可完全忽略）。 */
  digest: string;
  clueId: string;
}

/**
 * 执行壳的依赖注入面：所有副作用（读 channel / 取材 / 转写 / 发布 / 落 content-clue）
 * 都从这里走，便于打桩。
 *
 * E1 D4/D5/D6：转写成功 ⇒ propose content-clue；转写失败 ⇒ content-clue 出生即 blocked。
 * `proposeContentClue` 是 content-clue 的唯一落板出口（复用路径 D2 不调它，从而 D5 幂等）。
 */
export interface IngestDeps {
  /** 查该 digest 是否已有 doc(transcript)（按权威 digest 查，D1/D2）。 */
  readExistingTranscript(digest: string): Promise<DocV2 | null>;
  /** 取材：按 URI 取回文件（http 下载 / 本地拷贝）。 */
  fetchMaterial(uri: string): Promise<FetchedMaterial>;
  /** 真实 MinerU 转写：filename + bytes → md_content（路由 / backend 在其内部）。 */
  transcribe(filename: string, bytes: Uint8Array): Promise<string>;
  /** 发布 doc(transcript) 到 research:content。 */
  publishDoc(doc: DocV2): Promise<void>;
  /**
   * E1 D4/D6——content-clue 的唯一落板出口。
   * - 转写成功（非 D2 复用路径）⇒ propose 一条 `status:"proposed"` 的 content-clue；
   * - 转写失败（D6）⇒ propose 一条 `status:"blocked"`、`rationale` 含错误详情的 content-clue；
   * - D2 复用路径（digest 已存在）⇒ **不调用**（D5 幂等：同一板同一 digest 只一条 content-clue）。
   *
   * 返回值：落板的 content-clue（成功 / blocked 均落板）；当因 maxClues 封顶（D9）未落板时返回 null。
   */
  proposeContentClue(clue: ClueV2, idempotencyKey: string): Promise<ClueV2 | null>;
}

/** 图片扩展名：硬路由一律走本机 CPU（MinerU cuDNN 对图片输入必炸，spec §2.1）。 */
export const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "bmp",
  "gif",
  "jp2",
  "jpeg",
  "jpg",
  "png",
  "tiff",
  "webp",
]);

/** 支持格式：pdf + 图片 + office(docx/pptx/xlsx)（spec §2.6）。 */
export const SUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "pdf",
  "docx",
  "pptx",
  "xlsx",
  ...IMAGE_EXTENSIONS,
]);

/** 明确不支持的扩展名：epub/mobi/chm/azw 必须响亮失败（spec §2.6）。 */
export const UNSUPPORTED_EXTENSIONS: ReadonlySet<string> = new Set([
  "epub",
  "mobi",
  "chm",
  "azw",
]);

export type Route = "gpu" | "cpu";

/**
 * 硬路由：按扩展名决定 MinerU 端点。
 * 图片 → cpu；pdf/office → gpu；不支持/未知 → 响亮抛错（spec §2.1/§2.6）。
 */
export function classifyExtension(filename: string): { route: Route; ext: string } {
  const idx = filename.lastIndexOf(".");
  const ext = idx >= 0 ? filename.slice(idx + 1).toLowerCase() : "";
  if (UNSUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`unsupported extension '.${ext}' (${filename})`);
  }
  if (!SUPPORTED_EXTENSIONS.has(ext)) {
    throw new Error(`unsupported material extension '${ext}' (${filename})`);
  }
  return { route: IMAGE_EXTENSIONS.has(ext) ? "cpu" : "gpu", ext };
}

/** MinerU results 的 key 是「去掉扩展名的文件名」，不是原 filename（spec §2.4）。 */
export function stripExtension(filename: string): string {
  const idx = filename.lastIndexOf(".");
  return idx >= 0 ? filename.slice(0, idx) : filename;
}

/** 4MB 硬护栏（spec §4）：不分段，超限响亮报错拒绝。 */
export const MAX_MATERIAL_BYTES = 4 * 1024 * 1024;

/** 纯函数：材料字节数超 4MB 即抛错（spec §6 E9 正反两例）。 */
export function assertWithinSizeLimit(byteLength: number): void {
  if (byteLength > MAX_MATERIAL_BYTES) {
    throw new Error(
      `material exceeds the 4MB guard (${byteLength} bytes > ${MAX_MATERIAL_BYTES})`,
    );
  }
}

/**
 * E1 D1——权威 digest 纯函数：对取回的字节算 sha256，作为唯一去重键与发布键。
 * ⛔ 不再拿 worker 上报的 `digest` 当键（GT-3）：先 fetch、后算、再查重。
 * 纯函数：无 IO、无时钟、无随机（spec B1），可直接喂用例。
 */
export function computeDigest(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/**
 * 纯函数：扫描消息数组并按 digest 建全量索引（spec §3 / §6 E17）。
 * 同一 digest 只留一条 doc(transcript)，后者覆盖前者。不碰网络，可直接喂用例。
 */
export function buildDigestIndex(messages: BusMessage[]): Map<string, DocV2> {
  const index = new Map<string, DocV2>();
  for (const msg of messages) {
    if (msg.kind !== "research.doc.v2") continue;
    const doc = msg.payload as DocV2 | undefined;
    if (!doc || doc.doc_kind !== "transcript") continue;
    index.set(doc.digest, doc);
  }
  return index;
}

/**
 * 分页扫描：必须带 after_seq 翻页直到取空（spec §6 E18 / §10）。
 * `GET /v1/channels/<id>/messages` 默认 limit=100 且返回最早 100 条，不翻页只看得到最早一批。
 */
export async function scanAllMessages(
  scanFn: (afterSeq: number | null) => Promise<BusMessage[]>,
): Promise<BusMessage[]> {
  const all: BusMessage[] = [];
  let afterSeq: number | null = null;
  for (;;) {
    const page = await scanFn(afterSeq);
    if (page.length === 0) break;
    all.push(...page);
    afterSeq = page[page.length - 1].channel_seq;
  }
  return all;
}

/**
 * 由「分页扫描 + 全量 digest 索引」组合实现（spec §6 E19），非抽象。
 * 查给定 digest 是否已有 doc(transcript)。
 */
export async function readExistingTranscript(
  scanFn: (afterSeq: number | null) => Promise<BusMessage[]>,
  digest: string,
): Promise<DocV2 | null> {
  const messages = await scanAllMessages(scanFn);
  return buildDigestIndex(messages).get(digest) ?? null;
}

/**
 * 串行化执行器：任一时刻并发 = 1（spec §6 E13 / D7）。
 * wait-then-run：后到的调用等前一调用完成，绝不并发打 MinerU。
 */
export function createMutex(): <T>(fn: () => Promise<T>) => Promise<T> {
  let tail: Promise<unknown> = Promise.resolve();
  return function runSerialized<T>(fn: () => Promise<T>): Promise<T> {
    const prev = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return prev.then(fn).finally(release);
  };
}

/** E1 D6——material 级失败时的 rationale 前缀（rationale 含 MinerU/取材错误详情）。 */
export const MATERIAL_BLOCKED_RATIONALE_PREFIX =
  "content-clue born blocked: material ingest failed";

/** E1 D4——content-clue 的 text 模板：携带 transcript 的 digest 与 origin URI。 */
export function contentClueText(digest: string, originUri: string): string {
  return `transcript digest=${digest} origin=${originUri}`;
}

/**
 * E1 D4——content-clue 的确定性构造（纯函数）。
 *   sources: ["content"]；parent = 原 clue id；depth = **parent 的 depth（⛔ 不 +1）**；
 *   text 携带 transcript 的 digest 与 origin URI；status 由调用方决定（proposed / blocked）。
 */
export function buildContentClue(opts: {
  parentClueId: string;
  parentDepth: number;
  digest: string;
  originUri: string;
  status: "proposed" | "blocked";
  rationale?: string;
}): ClueV2 {
  const clue: ClueV2 = {
    text: contentClueText(opts.digest, opts.originUri),
    status: opts.status,
    depth: opts.parentDepth,
    sources: ["content"],
    parent: opts.parentClueId,
  };
  if (opts.rationale !== undefined) clue.rationale = opts.rationale;
  return clue;
}

/** transcribeMaterial 的结果：带 D2 复用标记（D5 幂等判据）。 */
export interface TranscribeResult {
  doc: DocV2;
  /** true ⇒ 走了 D2 复用路径（digest 已存在），未调 MinerU；此时不应 propose content-clue（D5）。 */
  reused: boolean;
}

/**
 * 转写单个材料（E1 权威 digest 版本）：
 *   1. **先 fetch** 取回字节（GT-3：顺序变成「先 fetch，后算，再查重」）；
 *   2. **后算**：对取回的字节算 sha256 作为权威 digest（D1）；
 *   3. **再查重**：按权威 digest 查 `readExistingTranscript`，命中 ⇒ 复用已有 doc、不调 MinerU（D2）；
 *   4. 未命中 ⇒ 4MB 护栏 → 扩展名路由 → MinerU 转写 → 发布 doc(transcript)（权威 digest 作为发布键）；
 *   5. 失败粒度下沉到 material（D6）：转写/取材失败 ⇒ 该 material 的 content-clue 出生即 blocked（rationale 含详情），
 *      ⛔ **父 clue 不连坐**（取代 GT-4 的 `markBlocked(父 clueId)` + 整体抛错）。
 *
 * `input.digest` 是 worker 上报的提示，⛔ 不再当键（可完全忽略）。
 * 复用路径（D2）不 propose content-clue（D5 幂等：同一板同一 digest 只一条 content-clue）。
 */
export async function transcribeMaterial(
  deps: IngestDeps,
  input: MaterialInput,
  serialize: <T>(fn: () => Promise<T>) => Promise<T> = createMutex(),
): Promise<TranscribeResult> {
  const material = await deps.fetchMaterial(input.uri);
  assertWithinSizeLimit(material.bytes.byteLength);
  classifyExtension(material.filename);
  const authoritativeDigest = computeDigest(material.bytes);

  const existing = await deps.readExistingTranscript(authoritativeDigest);
  if (existing) {
    return { doc: existing, reused: true };
  }

  const mdContent = await serialize(() =>
    deps.transcribe(material.filename, material.bytes),
  );
  const doc: DocV2 = {
    doc_kind: "transcript",
    digest: authoritativeDigest,
    body: mdContent,
    origin: input.uri,
  };
  await deps.publishDoc(doc);
  return { doc, reused: false };
}

/**
 * E1 D3/D4/D5/D6——对一条 material 执行 ingest 并按结果落 content-clue。
 * 由 harvest 在「materials 非空」时对每条 material 调用（D3）。
 *
 *   - 转写成功（非 D2 复用）⇒ propose 一条 `status:"proposed"` 的 content-clue（D4）；
 *   - D2 复用路径 ⇒ 不 propose（D5 幂等）；
 *   - 转写/取材失败 ⇒ 该 material 的 content-clue 出生即 blocked（D6，rationale 含详情），
 *     ⛔ **父 clue 不连坐**（不抛错、不 markBlocked 父 clue）。
 *
 * @param parentDepth 父 clue 的 depth（D4：content-clue depth = parent depth，⛔ 不 +1）。
 * @returns 落板的 content-clue（成功 proposed / 失败 blocked）；D2 复用或封顶未落板 ⇒ null。
 */
export async function ingestMaterial(
  deps: IngestDeps,
  input: MaterialInput,
  parentDepth: number,
  idempotencyKey: string,
  serialize?: <T>(fn: () => Promise<T>) => Promise<T>,
): Promise<ClueV2 | null> {
  try {
    const { doc, reused } = await transcribeMaterial(deps, input, serialize);
    if (reused) {
      return null;
    }
    const clue = buildContentClue({
      parentClueId: input.clueId,
      parentDepth,
      digest: doc.digest,
      originUri: doc.origin,
      status: "proposed",
    });
    return await deps.proposeContentClue(clue, idempotencyKey);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    const clue = buildContentClue({
      parentClueId: input.clueId,
      parentDepth,
      digest: input.digest,
      originUri: input.uri,
      status: "blocked",
      rationale: `${MATERIAL_BLOCKED_RATIONALE_PREFIX}: ${detail}`,
    });
    return await deps.proposeContentClue(clue, idempotencyKey);
  }
}

/**
 * E1 D3/D7——批量 ingest：N 条 material 同时到达，任一时刻在飞 MinerU 调用 = 1。
 * 共享同一个串行化 mutex（复用 base 已有的 createMutex，D7），保证跨 material 也并发 = 1。
 */
export async function ingestBatch(
  deps: IngestDeps,
  inputs: MaterialInput[],
  parentDepth: number,
  idempotencyKeyPrefix: string,
): Promise<(ClueV2 | null)[]> {
  const serialize = createMutex();
  return Promise.all(
    inputs.map((input, i) =>
      ingestMaterial(
        deps,
        input,
        parentDepth,
        `${idempotencyKeyPrefix}:material:${i}`,
        serialize,
      ),
    ),
  );
}

/**
 * E1 D8——生产侧 `fetchMaterial` 实现（base 上只有接口，无实现，GT-1）。
 * http(s) 下载；4MB 护栏用 `assertWithinSizeLimit`；⛔ 失败必须响亮（不得取回空字节当成功）。
 *
 * filename 从 URI 路径末段派生（无扩展名时 fallback 到 "material"）。
 */
export async function fetchMaterialHttp(uri: string): Promise<FetchedMaterial> {
  const resp = await fetch(uri);
  if (!resp.ok) {
    throw new Error(
      `fetchMaterial: HTTP ${resp.status} fetching '${uri}'`,
    );
  }
  const buf = new Uint8Array(await resp.arrayBuffer());
  if (buf.byteLength === 0) {
    throw new Error(`fetchMaterial: fetched 0 bytes from '${uri}' (refusing to treat empty as success)`);
  }
  assertWithinSizeLimit(buf.byteLength);
  const filename = filenameFromUri(uri);
  return { filename, bytes: buf };
}

/** E1 D8——从 URI 路径末段派生 filename（无扩展名时 fallback 到 "material"）。 */
export function filenameFromUri(uri: string): string {
  try {
    const u = new URL(uri);
    const path = u.pathname.replace(/\/+$/, "");
    const seg = path.split("/").filter(Boolean).pop();
    if (seg && seg.includes(".")) return decodeURIComponent(seg);
    return seg ? decodeURIComponent(seg) : "material";
  } catch {
    const seg = uri.replace(/[\\/]+$/, "").split(/[\\/]/).filter(Boolean).pop();
    return seg && seg.includes(".") ? seg : "material";
  }
}
