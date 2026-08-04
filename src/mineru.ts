/**
 * MinerU 真实 HTTP 客户端（IO 层）。
 *
 * 契约（spec §2，已实测，勿按想象实现）：
 *   - 同步 POST /file_parse，multipart/form-data，一发一收，直接回 md_content
 *   - ⛔ 不走任务提交 + 轮询那套（任务态是纯内存 dict，容器重启即失）
 *   - ⛔ 必须显式传 files（复数数组字段）、backend=pipeline、return_md=true
 *   - 图片路由到 CPU 端点（硬路由，见 ./ingest routeToEndpoint）
 *
 * 本文件是唯一允许出现 fetch 的转写 IO；决策逻辑在 ./ingest（E14 不含 fetch）。
 */
import { IngestError, extractMd } from "./ingest";

export interface MineruResponse {
  backend?: string;
  version?: string;
  status?: string;
  results?: Record<string, { md_content?: string }>;
}

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export interface MineruCall {
  endpoint: string;
  filename: string;
  bytes: Uint8Array;
}

/**
 * 调用 MinerU 同步 /file_parse 并返回 md_content。
 *
 * Node 的 fetch（undici）默认不读取 http_proxy/https_proxy 环境变量，
 * 亦不经过任何代理 —— 天然满足 spec §2.1 的「--noproxy '*' / 清代理」要求。
 *
 * @param fetchImpl 注入的 fetch，便于单测捕获 URL 与表单（E4/E5）。
 */
export async function transcribeFile(
  call: MineruCall,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  const form = new FormData();
  form.append("files", new Blob([call.bytes as unknown as BlobPart]), call.filename);
  form.append("backend", "pipeline");
  form.append("return_md", "true");

  let resp: Response;
  try {
    resp = await fetchImpl(`${call.endpoint}/file_parse`, {
      method: "POST",
      body: form,
    });
  } catch {
    throw new IngestError(
      "mineru_unreachable",
      `MinerU unreachable at ${call.endpoint}`,
    );
  }

  if (!resp.ok) {
    throw new IngestError(
      "mineru_unreachable",
      `MinerU HTTP ${resp.status} at ${call.endpoint}`,
    );
  }

  const data = (await resp.json()) as MineruResponse;
  if (data.status === "failed") {
    throw new IngestError("mineru_failed", "MinerU returned status=failed");
  }
  return extractMd(data.results, call.filename);
}