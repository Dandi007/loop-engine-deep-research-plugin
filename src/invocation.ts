/**
 * C2 —— Deep Research 统一调用面（single entry）的纯逻辑层。
 *
 * 三条调用面（MCP tool / skill / CLI）共用同一入口，入口按「显式、文档化的 scale 阈值规则」
 * 将一次研究请求路由到 light tier（session-level `workflow.js`）或 heavy tier（V2 全编排）。
 *
 * 本模块**只含确定性、无副作用的纯函数**：路由判定、channel 名派生、channel 创建/复用计划、
 * profile 加载（读文件，不写、不触 bus）。实际 IO（创建 channel / 起 loop）由入口
 * （src/deep-research-entry.ts）调用。
 */
import * as fs from "node:fs";
import { createHash } from "node:crypto";

/** 调用面结果 schema 版本。 */
export const INVOCATION_SCHEMA_VERSION = "deep-research-invocation.v1";

/**
 * scale 阈值规则（文档化的硬阈值）：
 *   研究请求声明的源数（fan-out scale）`sources < HEAVY_TIER_MIN_SOURCES` ⇒ light tier
 *   （session-level `workflow.js`，小规模、单会话即够）；`sources >= HEAVY_TIER_MIN_SOURCES`
 *   ⇒ heavy tier（V2 全编排，需 loop-engine 多轮调度）。
 *
 * ⛔ 不得由模型自由裁量：本规则是确定性代码（宪法 条 9）。显式 `--tier light|heavy` 覆盖
 *   自动判定（不变更阈值本身）。
 */
export const HEAVY_TIER_MIN_SOURCES = 4;

/** 自动选择的默认部署 profile（无 `--profile` / `DEEP_RESEARCH_PROFILE` 时用）。
 *  语义：heavy tier 的 profile 选择无需手工步骤。 */
export const DEFAULT_PROFILE = "agent-harness";

/** session-level 轻量引擎（light tier）的约定路径。外部部署可用
 *  DEEP_RESEARCH_SESSION_WORKFLOW 覆盖（指向既有 workflow.js 的落地位置）。
 *  ⛔ 本仓不重新实现 light 引擎（spec 约束），只路由到它。 */
export const SESSION_WORKFLOW_DEFAULT = "workflows/deep-research/session/workflow.js";

export type Tier = "light" | "heavy";

export interface RouteDecision {
  tier: Tier;
  reason: string;
  sources: number;
  threshold: number;
}

/**
 * scale 阈值路由：sources < 阈值 ⇒ light；>= 阈值 ⇒ heavy。
 * `tierOverride`（"light" | "heavy"）显式覆盖自动判定（仍记录原因）。
 */
export function decideTier(
  topic: string,
  sources: number,
  tierOverride?: "light" | "heavy",
): RouteDecision {
  if (typeof topic !== "string" || topic.trim().length === 0) {
    throw new Error("decideTier requires a non-empty research topic");
  }
  if (!Number.isInteger(sources) || sources < 1) {
    throw new Error(`decideTier requires a positive integer source count (got ${sources})`);
  }
  if (tierOverride === "light" || tierOverride === "heavy") {
    return {
      tier: tierOverride,
      reason: `explicit --tier ${tierOverride} override (sources=${sources})`,
      sources,
      threshold: HEAVY_TIER_MIN_SOURCES,
    };
  }
  if (sources >= HEAVY_TIER_MIN_SOURCES) {
    return {
      tier: "heavy",
      reason:
        `sources ${sources} >= heavy-tier threshold ${HEAVY_TIER_MIN_SOURCES} => ` +
        `full V2 orchestration (loop-engine)`,
      sources,
      threshold: HEAVY_TIER_MIN_SOURCES,
    };
  }
  return {
    tier: "light",
    reason:
      `sources ${sources} < heavy-tier threshold ${HEAVY_TIER_MIN_SOURCES} => ` +
      `session-level workflow.js`,
    sources,
    threshold: HEAVY_TIER_MIN_SOURCES,
  };
}

/** 把研究主题规范成 channel 名安全的 slug（小写、去特殊字符、截断）。 */
export function topicSlug(topic: string): string {
  const slug = topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 40) || "research";
}

/**
 * heavy tier 的 per-topic channel 名派生（create-or-reuse 宿主）：
 *   同一 profile + 同一 topic ⇒ 同一组 channel（可复用），不同 topic ⇒ 不同组（不串板）。
 * 形如 `research:<profile>-<topicHash>.{index,evidence,docs}`；`<topicHash>` 是
 *   sha256(`<profile>\n<topic>`) 的前 12 hex（确定性、channel_id 合法子集）。
 *
 * 纯函数：不触 IO，只做命名推导。供入口与测试复用。
 */
export function deriveTopicChannels(
  profileName: string,
  topic: string,
): { index: string; evidence: string; docs: string } {
  if (!profileName) {
    throw new Error("deriveTopicChannels requires a non-empty profile name");
  }
  if (!topic || !topic.trim()) {
    throw new Error("deriveTopicChannels requires a non-empty topic");
  }
  const hash = createHash("sha256")
    .update(`${profileName}\n${topic}`)
    .digest("hex")
    .slice(0, 12);
  const prefix = `research:${profileName}-${hash}`;
  return {
    index: `${prefix}.index`,
    evidence: `${prefix}.evidence`,
    docs: `${prefix}.docs`,
  };
}

export interface ChannelPrepPlan {
  /** 需要在 bus 上新建的 channel。 */
  create: string[];
  /** 已在 bus 上存在、按原样复用的 channel。 */
  reuse: string[];
}

/**
 * create-or-reuse 计划：给定 bus 上已存在的 channel 集合与期望集合，
 * 把期望集合划分成「需创建」与「可复用」。
 *
 * 纯函数：不触 bus，只做集合划分。实际创建由 bus.ts:ensureChannel 完成。
 */
export function planChannelPrep(
  existingIds: readonly string[],
  desiredIds: readonly string[],
): ChannelPrepPlan {
  const existing = new Set(existingIds);
  const create: string[] = [];
  const reuse: string[] = [];
  for (const id of desiredIds) {
    if (existing.has(id)) reuse.push(id);
    else create.push(id);
  }
  return { create, reuse };
}

/**
 * 加载受版本管理的部署 profile（profiles/deploy/<name>.env）。
 * 解析 `KEY=VALUE`（跳过空行与 `#` 注释）；同名键**后者覆盖前者**（与 bin 侧语义一致）。
 * 只读，不写文件、不触 bus。
 */
export function loadProfileEnv(
  profileName: string,
  profilesDir: string,
): Record<string, string> {
  const file = `${profilesDir}/${profileName}.env`;
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(`unknown deploy profile "${profileName}" (${file}): ${detail}`);
  }
  const rec: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) rec[m[1]] = m[2];
  }
  return rec;
}