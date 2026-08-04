/**
 * N1 —— MinerU 真实 HTTP 客户端（spec §2，契约已实测，勿按想象实现）
 *
 * - 只走同步 `POST .../file_parse`，一发一收直接回 md_content；
 *   ⛔ 不做任务管理路由 + 轮询（任务态是纯内存 dict，容器重启即失）。
 * - 按扩展名硬路由：图片 → 本机 CPU（127.0.0.1:8090），pdf/office → 主 GPU（172.22.62.133:8090）。
 * - 显式传 `backend=pipeline`、`return_md=true`。
 * - results 的 key 是「去掉扩展名的文件名」，据此取值。
 * - status=failed / HTTP 非 2xx / 缺 md_content ⇒ 响亮抛错，绝不静默降级。
 */
import { classifyExtension, stripExtension } from "./ingest";
import type { Route } from "./ingest";

/** 主（GPU）端点。 */
export const GPU_BASE_URL = "http://172.22.62.133:8090";
/** backup（CPU）端点。 */
export const CPU_BASE_URL = "http://127.0.0.1:8090";

/** 硬路由：图片走 CPU，其余走 GPU。 */
export function resolveEndpoint(route: Route): string {
  return route === "cpu" ? CPU_BASE_URL : GPU_BASE_URL;
}

export interface MinerUEntry {
  md_content?: string;
}

export interface MinerUResponse {
  backend?: string;
  version?: string;
  status?: string;
  results?: Record<string, MinerUEntry>;
}

/**
 * 同步 /file_parse 转写：filename + bytes → md_content。
 * 返回的 md_content 由「去扩展名文件名」从 results 里取（spec §2.4 / §6 E8）。
 */
export async function fileParse(
  filename: string,
  bytes: Uint8Array,
): Promise<string> {
  const { route } = classifyExtension(filename);
  const url = `${resolveEndpoint(route)}/file_parse`;

  const form = new FormData();
  form.append("files", new Blob([bytes as unknown as BlobPart]), filename);
  form.append("backend", "pipeline");
  form.append("return_md", "true");

  const resp = await fetch(url, { method: "POST", body: form });
  if (!resp.ok) {
    throw new Error(`MinerU /file_parse failed: HTTP ${resp.status} for ${filename}`);
  }
  const data = (await resp.json()) as MinerUResponse;
  if (data.status === "failed") {
    throw new Error(`MinerU returned status=failed for ${filename}`);
  }
  const key = stripExtension(filename);
  const entry = data.results?.[key];
  if (!entry || typeof entry.md_content !== "string") {
    throw new Error(`MinerU response missing md_content for key '${key}'`);
  }
  return entry.md_content;
}
