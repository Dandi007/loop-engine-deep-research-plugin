/**
 * N1 —— ingest 节点：按 digest 全局去重 + 取材 + MinerU 转写为 doc(transcript)
 *
 * 结构沿用 S2/S3/S4：决策与纯逻辑纯函数化，IO 只在执行壳里，全部经 deps 注入。
 * 本模块不 import ./bus（spec §6 E14）：bus / HTTP 交互一律走 deps。
 *
 * 硬约束（spec 正文）：
 *   - 同 digest 已存在 doc(transcript) ⇒ 直接返回已有 doc，绝不调 MinerU（E1/E3）
 *   - 4MB 硬护栏：超限响亮报错、不分段（E9）
 *   - 不支持的扩展名响亮失败，不得静默跳过（E10）
 *   - MinerU 失败 ⇒ 响亮失败且把对应 clue 标 blocked（E11/E12）
 *   - 不并发打 MinerU：串行化，任一时刻在飞 = 1（E13）
 */
import type { DocV2 } from "./protocol";

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

/** 一次 ingest 的输入：URI + digest + 归属 clue。 */
export interface MaterialInput {
  uri: string;
  digest: string;
  clueId: string;
}

/**
 * 执行壳的依赖注入面：所有副作用（读 channel / 取材 / 转写 / 发布 / 标 blocked）
 * 都从这里走，便于打桩。
 */
export interface IngestDeps {
  /** 查该 digest 是否已有 doc(transcript)。 */
  readExistingTranscript(digest: string): Promise<DocV2 | null>;
  /** 取材：按 URI 取回文件（http 下载 / 本地拷贝）。 */
  fetchMaterial(uri: string): Promise<FetchedMaterial>;
  /** 真实 MinerU 转写：filename + bytes → md_content（路由 / backend 在其内部）。 */
  transcribe(filename: string, bytes: Uint8Array): Promise<string>;
  /** 发布 doc(transcript) 到 research:content。 */
  publishDoc(doc: DocV2): Promise<void>;
  /** MinerU 失败时把该 clue 标 blocked。 */
  markBlocked(clueId: string): Promise<void>;
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
 * 串行化执行器：任一时刻并发 = 1（spec §6 E13）。
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

/**
 * 转写单个材料：
 *   1. digest 已存在 ⇒ 直接返回已有 doc，不调 MinerU（E1/E3）
 *   2. 取材 → 4MB 护栏 → 扩展名路由 → MinerU 转写 → 发布 doc(transcript)（E2）
 * 任一失败 ⇒ 响亮抛错且把该 clue 标 blocked（E11/E12）。
 */
export async function transcribeMaterial(
  deps: IngestDeps,
  input: MaterialInput,
  serialize: <T>(fn: () => Promise<T>) => Promise<T> = createMutex(),
): Promise<DocV2> {
  const existing = await deps.readExistingTranscript(input.digest);
  if (existing) {
    return existing;
  }
  try {
    const material = await deps.fetchMaterial(input.uri);
    assertWithinSizeLimit(material.bytes.byteLength);
    classifyExtension(material.filename);
    const mdContent = await serialize(() =>
      deps.transcribe(material.filename, material.bytes),
    );
    const doc: DocV2 = {
      doc_kind: "transcript",
      digest: input.digest,
      body: mdContent,
      origin: input.uri,
      role: "dr-transcriber",
    };
    await deps.publishDoc(doc);
    return doc;
  } catch (err) {
    await deps.markBlocked(input.clueId);
    throw err;
  }
}

/**
 * 批量转写：共享同一个串行化 mutex，保证跨材料也并发 = 1（spec §6 E13）。
 * 不同材料并行提交，但 MinerU 调用严格排队。
 */
export async function transcribeBatch(
  deps: IngestDeps,
  inputs: MaterialInput[],
): Promise<DocV2[]> {
  const serialize = createMutex();
  return Promise.all(inputs.map((input) => transcribeMaterial(deps, input, serialize)));
}
