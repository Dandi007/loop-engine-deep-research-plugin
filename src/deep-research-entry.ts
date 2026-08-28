/**
 * C2 —— Deep Research 统一调用面（single entry）可执行入口（CLI）。
 *
 * 一个入口、三条调用面（MCP tool / skill / CLI 都指向它），按**显式、文档化的 scale 阈值**
 * 把一次研究请求路由到 light tier（session-level `workflow.js`）或 heavy tier（V2 全编排）。
 *
 * usage（CLI）：
 *   ... <topic> [--sources <n>] [--tier auto|light|heavy] [--profile <name>] [--dry-run]
 *
 *   <topic>          研究主题（位置参数，必填；亦可用 --topic <topic>）。
 *   --sources <n>    fan-out scale（源数，缺省 1）。sources < 4 ⇒ light，>= 4 ⇒ heavy。
 *   --tier ...       显式覆盖自动路由（不变更阈值本身）。
 *   --profile <name> heavy tier 的部署 profile（缺省自动选 agent-harness）。
 *   --dry-run        只做路由 + profile/channel 计划 + preflight 闸（不建 channel、不起 loop）。
 *
 * heavy tier：
 *   1. 自动选 profile（无 --profile 时用缺省 agent-harness）；
 *   2. 由 profile + topic 确定性派生 per-topic research channel（create-or-reuse 宿主）；
 *   3. 调用 C1 的 preflight（runPreflight）闸门：非 PASS 即响亮拒绝（fail-closed，不起 loop）；
 *   4. 非 dry-run：create-or-reuse channel，再以一条命令起 heavy loop
 *      （bin/deep-research-loop.sh --profile <profile>）。
 *
 * 输出恒为单个机器可解析 JSON（stdout）。--help 打印用法 exit 0。
 */
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runPreflight } from "./preflight";
import { ensureChannel, listChannels } from "./bus";
import { RUNS_CHANNEL_ID } from "./run-channels";
import {
  decideTier,
  deriveTopicChannels,
  loadProfileEnv,
  HEAVY_TIER_MIN_SOURCES,
  DEFAULT_PROFILE,
  INVOCATION_SCHEMA_VERSION,
  SESSION_WORKFLOW_DEFAULT,
} from "./invocation";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const PROFILES_DIR = join(REPO_ROOT, "profiles", "deploy");
const LOOP_SCRIPT = join(REPO_ROOT, "bin", "deep-research-loop.sh");

const USAGE = `deep-research unified entry (single entry, light/heavy routing)

one application declaration, three invocation surfaces (MCP tool / skill / CLI), one entry.
routes a research request to the light tier (session-level workflow.js) or the heavy tier
(full V2 loop-engine orchestration) by an explicit, documented scale threshold.

usage:
  ... <topic> [--sources <n>] [--tier auto|light|heavy] [--profile <name>] [--dry-run]

  <topic>          research topic (positional, required; alias --topic <topic>)
  --sources <n>    fan-out scale / number of sources (default 1)
                   scale rule: sources < ${HEAVY_TIER_MIN_SOURCES} => light (workflow.js);
                   sources >= ${HEAVY_TIER_MIN_SOURCES} => heavy (V2 orchestration)
  --tier SCHED     explicit override: light | heavy (auto otherwise)
  --profile <name> heavy-tier deploy profile (default: ${DEFAULT_PROFILE})
  --dry-run        route + profile/channel plan + preflight gate only (no channel create,
                   no loop launch)

The heavy tier auto-completes profile selection and channel preparation (create-or-reuse),
with zero manual profile/channel steps. The C1 preflight runner gate refuses a non-green start.
`;

interface ParsedArgs {
  topic?: string;
  sources: number;
  tierOverride?: "light" | "heavy";
  profile?: string;
  dryRun: boolean;
  help: boolean;
  error?: string;
}

function parseArgs(argv: string[]): ParsedArgs {
  const out: ParsedArgs = { sources: 1, dryRun: false, help: false };
  const positional: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") return { ...out, help: true };
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
    if (a === "--tier") {
      const next = argv[i + 1];
      if (next !== "light" && next !== "heavy") {
        return { ...out, error: "--tier requires 'light' or 'heavy'" };
      }
      out.tierOverride = next;
      i += 1;
      continue;
    }
    if (a === "--profile") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) {
        return { ...out, error: "--profile requires an operand" };
      }
      out.profile = next;
      i += 1;
      continue;
    }
    if (a.startsWith("--")) {
      return { ...out, error: `unknown argument: ${a}` };
    }
    positional.push(a);
  }
  if (out.topic === undefined && positional.length > 0) out.topic = positional[0];
  if (positional.length > 1) return { ...out, error: `unexpected extra positional argument: ${positional[1]}` };
  return out;
}

export async function main(argv: string[]): Promise<number> {
  const parsed = parseArgs(argv);
  if (parsed.help) {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n\n${USAGE}`);
    return 2;
  }
  if (parsed.topic === undefined || parsed.topic.trim().length === 0) {
    process.stderr.write(`a <topic> is required\n\n${USAGE}`);
    return 2;
  }

  const decision = decideTier(parsed.topic, parsed.sources, parsed.tierOverride);

  if (decision.tier === "light") {
    const workflow =
      process.env.DEEP_RESEARCH_SESSION_WORKFLOW ?? SESSION_WORKFLOW_DEFAULT;
    const doc = {
      schema_version: INVOCATION_SCHEMA_VERSION,
      tier: "light",
      topic: parsed.topic,
      sources: parsed.sources,
      reason: decision.reason,
      session_workflow: workflow,
      dry_run: parsed.dryRun,
    };
    process.stdout.write(JSON.stringify(doc, null, 2) + "\n");
    if (parsed.dryRun) return 0;
    const child = spawn("node", [workflow, "--topic", parsed.topic], {
      cwd: REPO_ROOT,
      stdio: "inherit",
    });
    return await new Promise<number>((resolve) => {
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    });
  }

  // ── heavy tier ──
  const profile = parsed.profile ?? process.env.DEEP_RESEARCH_PROFILE ?? DEFAULT_PROFILE;
  const profileEnv = loadProfileEnv(profile, PROFILES_DIR);
  const channels = deriveTopicChannels(profile, parsed.topic);

  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const [k, v] of Object.entries(profileEnv)) {
    if (env[k] === undefined || env[k] === "") env[k] = v;
  }
  // C2 —— 入口拥有 research channel 命名（topic 级 create-or-reuse），零手工 channel 步骤。
  env.TICK_CHANNEL = channels.index;
  env.EVIDENCE_CHANNEL = channels.evidence;
  env.DOC_CHANNEL = channels.docs;

  // preflight 闸门（fail-closed）：非 PASS 即拒绝起 heavy loop。
  const preflight = runPreflight({ app: "deep-research", preflightOnly: true, env });

  const baseDoc = {
    schema_version: INVOCATION_SCHEMA_VERSION,
    tier: "heavy",
    topic: parsed.topic,
    sources: parsed.sources,
    reason: decision.reason,
    profile,
    channels,
    dry_run: parsed.dryRun,
    preflight: preflight.result,
  };

  if (preflight.code !== 0 || preflight.result.status !== "PASS") {
    process.stdout.write(
      JSON.stringify(
        { ...baseDoc, outcome: "refused", error: `preflight gate refused start: ${preflight.result.error_code ?? "FAIL"}` },
        null,
        2,
      ) + "\n",
    );
    return preflight.code;
  }

  if (parsed.dryRun) {
    process.stdout.write(
      JSON.stringify({ ...baseDoc, outcome: "planned" }, null, 2) + "\n",
    );
    return 0;
  }

  // create-or-reuse：派生出的三条 research channel + 全局 board:agent-runs。
  const existing = (await listChannels()).map((c) => c.channel_id);
  const desired = [channels.index, channels.evidence, channels.docs, RUNS_CHANNEL_ID];
  const prep: Array<{ channelId: string; created: boolean; reused: boolean }> = [];
  for (const id of desired) {
    prep.push(await ensureChannel(id, existing));
  }
  process.stdout.write(
    JSON.stringify({ ...baseDoc, outcome: "prepared", channels_prepared: prep }, null, 2) + "\n",
  );

  const child = spawn(
    "bash",
    [LOOP_SCRIPT, "--profile", profile],
    { cwd: REPO_ROOT, env, stdio: "inherit" },
  );
  return await new Promise<number>((resolve) => {
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}

process.exitCode = await main(process.argv.slice(2)).catch((err) => {
  const msg = err instanceof Error ? err.message : String(err);
  process.stdout.write(
    JSON.stringify({ schema_version: INVOCATION_SCHEMA_VERSION, outcome: "fail", error: msg }, null, 2) + "\n",
  );
  return 1;
});