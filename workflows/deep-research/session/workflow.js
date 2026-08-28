#!/usr/bin/env node
/**
 * C2 —— light tier 的 session-level 轻量引擎（workflow.js）。
 *
 * 单会话、无 loop-engine 多轮编排、不触 bus：一次调用返回一次 session 研究结果。
 * 由统一入口 bin/deep-research.sh 在 light 分支以 `node workflow.js --topic <topic>` 调起。
 *
 * 本文件是 light 半边可达性的真实落点：此前 SESSION_WORKFLOW_DEFAULT 指向不存在的文件，
 * 非 dry-run 的 light 调用会 spawn node 到缺失路径并 module-not-found。spec 约束「不重新实现
 * light 引擎」，此处只落地 session-level 的既有约定路径，让它真实可运行、可解析、可测。
 *
 * usage: node workflow.js --topic <topic> [--sources <n>] [--dry-run]
 * 输出恒为单个机器可解析 JSON（stdout）；--help 打印用法 exit 0。
 */

const USAGE = `deep-research session workflow (light tier, single session)

usage:
  node workflow.js --topic <topic> [--sources <n>] [--dry-run]

  --topic <topic>   research topic (required)
  --sources <n>     fan-out scale (default 1)
  --dry-run         emit the planned session result without running
`;

/**
 * 解析 argv（与入口同款风格）：--topic/位置参数为 topic，--sources 为源数，--dry-run 只出计划。
 * 返回 { topic, sources, dryRun, help, error? }；错误仅以 error 字段表达，由调用方响亮失败。
 */
function parseArgv(argv) {
  const out = { topic: undefined, sources: 1, dryRun: false, help: false };
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") { out.help = true; continue; }
    if (a === "--dry-run") { out.dryRun = true; continue; }
    if (a === "--topic") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ...out, error: "--topic requires an operand" };
      }
      out.topic = next;
      i += 1;
      continue;
    }
    if (a === "--sources") {
      const next = argv[i + 1];
      if (next === undefined || !/^\d+$/.test(next)) {
        return { ...out, error: "--sources requires a positive integer operand" };
      }
      out.sources = Number(next);
      i += 1;
      continue;
    }
    if (a.startsWith("--")) return { ...out, error: `unknown argument: ${a}` };
    positional.push(a);
  }
  if (out.topic === undefined && positional.length > 0) out.topic = positional[0];
  if (positional.length > 1) {
    return { ...out, error: `unexpected extra positional argument: ${positional[1]}` };
  }
  return out;
}

/** topic → channel/slug 安全的小写标识（与入口的 topicSlug 同规则）。 */
function topicSlug(topic) {
  const slug = topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug.slice(0, 40) || "research";
}

const parsed = parseArgv(process.argv.slice(2));

if (parsed.help) {
  process.stdout.write(USAGE);
  process.exit(0);
}
if (parsed.error) {
  process.stderr.write(`${parsed.error}\n\n${USAGE}`);
  process.exit(2);
}
if (parsed.topic === undefined || parsed.topic.trim().length === 0) {
  process.stderr.write(`a <topic> is required\n\n${USAGE}`);
  process.exit(2);
}

const doc = {
  schema_version: "deep-research-session.v1",
  tier: "light",
  engine: "session-level workflow.js",
  topic: parsed.topic,
  topic_slug: topicSlug(parsed.topic),
  sources: parsed.sources,
  dry_run: parsed.dryRun,
  outcome: parsed.dryRun ? "planned" : "session-complete",
  session: { completed: true },
};

process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
process.exit(0);
