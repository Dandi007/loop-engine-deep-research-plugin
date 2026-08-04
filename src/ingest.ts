/**
 * N1 —— ingest 节点：取材 + MinerU 转写 + 按 digest 全局去重
 *
 * 结构沿用 S2/S3/S4：决策逻辑纯函数化，IO 只在执行壳里，全部经 deps 注入以便打桩。
 *
 * ⛔ E14：本模块不 import ./bus，且不含 fetch / 时钟 / 随机。
 * 真实 MinerU 的 HTTP 客户端在 ./mineru（唯一允许出现 fetch 的 IO 层）。
 */
import type { DocV2 } from "./protocol";

// ── MinerU 端点（spec §2.1）──

/** 主（GPU）端点 */
export const MINERU_GPU_URL = "http://172.22.62.133:8090";
/** backup（CPU）端点 */
export const MINERU_CPU_URL = "http://127.0.0.1:8090";

// ── 扩展名（spec §2.1 / §2.6）──

/** 图片扩展名 —— 一律硬路由到本机 CPU（图片输入必炸 GPU cuDNN） */
export const IMAGE_EXTS = [
  "bmp",
  "gif",
  "jp2",
  "jpeg",
  "jpg",
  "png",
  "tiff",
  "webp",
] as const;
const OFFICE_EXTS = ["docx", "pptx", "xlsx"] as const;
export const SUPPORTED_EXTS = [...IMAGE_EXTS, "pdf", ...OFFICE_EXTS] as const;
/** 明确不支持 —— 遇到必须响亮失败，不得静默跳过 */
export const UNSUPPORTED_EXTS = ["epub", "mobi", "chm", "azw"] as const;

// ── 4MB 硬护栏（spec §4）──

export const MAX_DOC_BYTES = 4 * 1024 * 1024;

// ── 错误分类（spec §5：响亮失败 + 标 blocked）──

export type IngestErrorKind =
  | "unsupported_extension"
  | "too_large"
  | "mineru_unreachable"
  | "mineru_failed";

export class IngestError extends Error {
  readonly kind: IngestErrorKind;
  constructor(kind: IngestErrorKind, message: string) {
    super(message);
    this.name = "IngestError";
    this.kind = kind;
  }
}

// ── 纯决策：扩展名 / 端点 / 大小 / 响应键（E6/E7/E8/E9/E10）──

/** 取 filename 的小写扩展名（无扩展名返回空串）。 */
export function extractExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? "" : filename.slice(dot + 1).toLowerCase();
}

export function isImageExt(ext: string): boolean {
  return (IMAGE_EXTS as readonly string[]).includes(ext);
}

export function isSupportedExt(ext: string): boolean {
  return (SUPPORTED_EXTS as readonly string[]).includes(ext);
}

/** 去掉扩展名的文件名 —— MinerU 响应 results 的 key 就是它（spec §2.4）。 */
export function stripExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot < 0 ? filename : filename.slice(0, dot);
}

/** E6/E7：图片 → CPU 端点；其余 → GPU 端点。硬路由，不做探错重试。 */
export function routeToEndpoint(ext: string): string {
  return isImageExt(ext) ? MINERU_CPU_URL : MINERU_GPU_URL;
}

/** E10：不支持的扩展名必须响亮失败。 */
export function assertSupportedExt(ext: string): void {
  if (!isSupportedExt(ext)) {
    throw new IngestError(
      "unsupported_extension",
      `unsupported extension: "${ext}"`,
    );
  }
}

/** E9：超 4MB 报错拒绝（> 4MB 抛错，恰 4MB 通过）。 */
export function assertUnder4MB(size: number): void {
  if (size > MAX_DOC_BYTES) {
    throw new IngestError(
      "too_large",
      `document exceeds 4MB guard (${size} bytes)`,
    );
  }
}

/** E8：按「去扩展名文件名」取 md_content；取不到即 mineru_failed。 */
export function extractMd(
  results: Record<string, { md_content?: string }> | undefined,
  filename: string,
): string {
  const key = stripExtension(filename);
  const content = results?.[key]?.md_content;
  if (typeof content !== "string") {
    throw new IngestError("mineru_failed", `no md_content for key "${key}"`);
  }
  return content;
}

// ── 执行壳（IO 全经 deps 注入）──

export interface IngestInput {
  uri: string;
  digest: string;
  filename: string;
  clueId: string;
}

export interface FetchMaterialRequest {
  uri: string;
  filename: string;
}

export interface TranscribeRequest {
  uri: string;
  filename: string;
  endpoint: string;
  bytes: Uint8Array;
}

export interface IngestDeps {
  /** 查 research:content：该 digest 的 doc(transcript) 是否已存在（E1/E3）。 */
  readExistingTranscript(digest: string): Promise<DocV2 | null>;
  /** 取材（http / 本地拷贝）；下载逻辑只实现这一份。 */
  fetchMaterial(req: FetchMaterialRequest): Promise<{ bytes: Uint8Array }>;
  /** 调 MinerU 转写 → md_content。不可达/失败以 IngestError 抛出（E11/E12）。 */
  transcribe(req: TranscribeRequest): Promise<string>;
  /** 发布 doc(transcript)（E2）。 */
  publishDoc(doc: DocV2): Promise<void>;
  /** 把该 clue 置 blocked（E11/E12）。 */
  markClueBlocked(clueId: string): Promise<void>;
}

// ── 并发限制：MinerU 并发实际为 1，只能排队，不得并发打它（spec §2.5 / E13）──

let mineruTail: Promise<void> = Promise.resolve();

/** 串行化对 MinerU 的转写调用：任一时刻在飞 ≤ 1。 */
export function withSerializedTranscribe<T>(fn: () => Promise<T>): Promise<T> {
  const prev = mineruTail;
  let release!: () => void;
  mineruTail = new Promise<void>((r) => (release = r));
  return prev.then(fn).finally(release);
}

/**
 * ingest 主流程（spec §3）：
 *   收到 URI + digest → 查该 digest 的 doc(transcript) → 存在则直接返回（不调 MinerU）
 *   → 不存在则取材 → 4MB 护栏 → 硬路由端点 → 转写 → 发布 doc(transcript)。
 *
 * 响亮失败（spec §5）：MinerU 不可达 / 返回 failed ⇒ 抛错并把该 clue 置 blocked。
 */
export async function runIngest(
  deps: IngestDeps,
  input: IngestInput,
): Promise<DocV2 | null> {
  const existing = await deps.readExistingTranscript(input.digest);
  if (existing) {
    return existing;
  }

  const ext = extractExtension(input.filename);
  try {
    assertSupportedExt(ext);
    const { bytes } = await deps.fetchMaterial({
      uri: input.uri,
      filename: input.filename,
    });
    assertUnder4MB(bytes.byteLength);
    const endpoint = routeToEndpoint(ext);
    const body = await withSerializedTranscribe(() =>
      deps.transcribe({
        uri: input.uri,
        filename: input.filename,
        endpoint,
        bytes,
      }),
    );
    const doc: DocV2 = {
      doc_kind: "transcript",
      digest: input.digest,
      body,
      origin: input.uri,
    };
    await deps.publishDoc(doc);
    return doc;
  } catch (err) {
    if (
      err instanceof IngestError &&
      (err.kind === "mineru_unreachable" || err.kind === "mineru_failed")
    ) {
      await deps.markClueBlocked(input.clueId);
    }
    throw err;
  }
}