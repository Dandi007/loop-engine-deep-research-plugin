/**
 * N3 —— 导出节点：doc(report) → vault 只读渲染
 *
 * 报告落 doc(report) 进 research:content（bus 是 SSoT），同时由确定性导出节点
 * 导出一份到 vault 供阅读。导出件不是第二份真相，是可删可重生的只读渲染。
 *
 * 结构沿用前四包：路径派生与内容派生是纯函数，文件写入只在执行壳里、经 deps 注入。
 * 本模块不 import ./bus（与 S2/S3/S4/N1 一致的纪律）。
 *
 * 硬约束（spec §4）：路径与内容派生都是纯函数，同一输入 ⇒ 同一字节。
 * 不现取系统时钟/随机数；文件名里的日期由调用方从 report 数据（bus created_at）传入。
 */
import type { DocV2 } from "./protocol";
import { parseReportMarker, renderReportBody } from "./generate";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** 一次导出所需的纯数据（spec §2/§4：日期从 report 数据派生，由调用方经参数传入）。 */
export interface ExportInput {
  /** doc(report)，SSoT 上的报告对象。 */
  report: DocV2;
  /** doc(report) 在 bus 上的 message_id（source_message_id）。 */
  sourceMessageId: string;
  /** bus 消息的 created_at —— 文件名日期由此派生，不得现取系统时钟。 */
  createdAt: string;
  /** 报告 topic，用于确定性派生 topic-slug。 */
  topic: string;
}

/** 执行壳的依赖注入面：唯一副作用是写文件。 */
export interface ExportDeps {
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * 纯函数：由 topic 确定性派生 slug（spec §2/§4）。
 * 不含时钟/随机，同一 topic ⇒ 同一 slug。
 */
export function slugify(topic: string): string {
  const slug = topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.length > 0 ? slug : "untitled";
}

/**
 * 纯函数：路径派生（spec §2 落点 + §4 幂等）。
 * 落点 `<vaultRoot>/DeepThought/<topic-slug>/<YYYY-MM-DD>-<topic-slug>.md`。
 * （2026-08-09 用户拍板：导出件落 `DeepThought/<主题>/`，带 `source_message_id` 与终态标记，
 * 与旧产物区分；vaultRoot 由部署配置注入，不得硬编码。）
 * 给定同一输入 + 同一 vaultRoot ⇒ 同一路径。不依赖任何桩。
 */
export function deriveExportPath(input: ExportInput, vaultRoot: string): string {
  const date = input.createdAt.slice(0, 10);
  const slug = slugify(input.topic);
  return `${vaultRoot}/DeepThought/${slug}/${date}-${slug}.md`;
}

/**
 * 纯函数：内容派生（spec §3 头部 + §4 幂等）。
 * 复用 S4 的 parseReportMarker（⛔ 不再另写解析器），终态标记原样带出。
 */
export function renderExportContent(input: ExportInput): string {
  const marker = parseReportMarker(input.report.body);
  if (!marker) {
    throw new Error("report body has no terminal marker at head");
  }
  const markerLine = renderReportBody(marker).trim();
  return [
    `# ${input.topic}`,
    "",
    "<!-- 本文件是渲染产物，可删可重生，请勿直接编辑 -->",
    `<!-- source_message_id: ${input.sourceMessageId} -->`,
    markerLine,
    "",
    input.report.body.trim(),
    "",
  ].join("\n");
}

/**
 * 执行壳：纯路径 + 纯内容 → 写文件（spec §5.5）。
 * 写入失败 ⇒ 响亮抛错，不得静默吞掉（F13）。
 * ⛔ 父目录自动创建（mkdirSync recursive），首次真导出必满足。
 * ⛔ EXPORT_ROOT 未配置 ⇒ 响亮失败。
 */
export async function runExport(
  deps: ExportDeps,
  input: ExportInput,
  vaultRoot: string,
): Promise<string> {
  if (!vaultRoot) {
    throw new Error(
      "EXPORT_ROOT is not configured. Refusing to silently skip the export — the export is a mandatory deliverable.",
    );
  }
  const path = deriveExportPath(input, vaultRoot);
  mkdirSync(dirname(path), { recursive: true });
  const content = renderExportContent(input);
  await deps.writeFile(path, content);
  return path;
}
