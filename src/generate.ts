/**
 * S4 —— 生成阶段编排 + 单例 lock + 终态标记（G2a 接线版）
 *
 * 终止判定（decideTermination）给出非空终态之后，编排生成阶段（spec §1）：
 *   debater（立论 / 反方 / 裁判，不同 route，advocate/opponent 并行 → judge 带 prior_arguments）
 *     → synthesizer（⛔ 单例 lock，任一时刻并发 = 1，绝不跳过）
 *       → anchor-check（确定性节点，跑但不阻断导出）
 *         → 导出（确定性节点，最后）
 *
 * G2a 把 S4 的「占位 spawn」接到真实 R2 role（dr-debater-* / dr-synthesizer）：
 *   - spawnDebater/spawnSynthesizer 只收 route 的占位形状，替换为「role + route + 语料」，
 *     返回 `{ body }`，语料由引擎侧确定性组装后放进位置参数（⛔ 不得只靠 `--input` 注入 prompt）。
 *   - 产物回写 `research.doc.v2`：doc_kind 由「派的是哪个 role」推出（⛔ 绝不读 payload.doc_kind）。
 *
 * 结构沿用 S2/S3：编排决策是纯函数，副作用只在执行壳（runGenerate）里。
 * 本模块不 import ./bus；读 / spawn / lock / 回写全部经 deps 注入。
 */
import { createHash } from "node:crypto";
import type { TerminationState } from "./tick";
import type { DocV2 } from "./protocol";

/** 单个生成角色：role（persona）+ route（模型）。 */
export interface GenerateRoleSpec {
  role: string;
  route: string;
}

/** 生成阶段参数（spec §6）：三条 debater route 必须互不相同，不得硬编码。 */
export interface GenerateConfig {
  /** debater 三立场（立论 / 反方 / 裁判）的 role+route，route 互不相同。 */
  debaters: readonly [GenerateRoleSpec, GenerateRoleSpec, GenerateRoleSpec];
  synthesizer: GenerateRoleSpec;
  anchorCheckRoute: string;
  exportRoute: string;
}

export const DEFAULT_GENERATE_CONFIG: GenerateConfig = {
  // ⛔ role/route 以 agent-runtime 实际文件为准（spec §2.1 表格）。
  debaters: [
    { role: "dr-debater-advocate", route: "opus-4-8/ccs" },
    { role: "dr-debater-opponent", route: "gpt-5.6-sol/ccs" },
    { role: "dr-debater-judge", route: "ds-v4-pro/ccs" },
  ],
  synthesizer: { role: "dr-synthesizer", route: "opus-5/ccs" },
  anchorCheckRoute: "anchor-check",
  exportRoute: "export",
};

/**
 * 纯函数：校验三条 debater route 必须互不相同（spec §6 / D5 / G2a D3）。
 * 任何调用方传入重复 route 都立即抛错，杜绝「默认配置下恰好不同、自定义配置却静默接受重复」的 Q2 形态。
 */
export function assertDistinctDebaterRoutes(cfg: GenerateConfig): void {
  const routes = cfg.debaters.map((d) => d.route);
  const distinct = new Set(routes);
  if (cfg.debaters.length !== 3 || distinct.size !== 3) {
    throw new Error(
      `GenerateConfig.debaters must have three mutually distinct routes; got ${JSON.stringify(
        routes,
      )}`,
    );
  }
}

/** 终态标记：两个正交事实（spec §5.1），由报告 body 头部承载。 */
export interface ReportMarker {
  /** 为什么停：converged / capped（partial 由 blocked>0 表达）。 */
  stop: "converged" | "capped";
  /** 未完成的工作计数（blocked ≥ 1 即 partial）。 */
  blocked: number;
  /** 是否已触顶。 */
  capHit: boolean;
}

/**
 * 纯函数：是否启动生成阶段（spec §2）。
 * ⛔ 仅当 decideTermination 给出非空 state 才启动；capHit 为 true 但 state 为 null
 * （已触顶、仍在排空）不得启动。
 */
export function decideGenerate(term: TerminationState): boolean {
  return term.state !== null;
}

/** 纯函数：由终态 + blocked 计数构造结构化标记（spec §5.1）。 */
export function buildReportMarker(term: TerminationState, blocked: number): ReportMarker {
  const stop: ReportMarker["stop"] = term.state === "capped" ? "capped" : "converged";
  return { stop, blocked, capHit: term.capHit };
}

/** 纯函数：把标记渲染成报告 body 头部的机器可解析块（spec §5.2）。 */
export function renderReportBody(marker: ReportMarker): string {
  return `<!-- dr-terminal stop=${marker.stop} blocked=${marker.blocked} capHit=${marker.capHit} -->\n`;
}

/** 纯函数：从 body 头部确定性地解析回结构化标记（spec D15）。 */
export function parseReportMarker(body: string): ReportMarker | null {
  const m = body.match(
    /^\s*<!--\s*dr-terminal\s+stop=(converged|capped)\s+blocked=(\d+)\s+capHit=(true|false)\s*-->/,
  );
  if (!m) return null;
  return {
    stop: m[1] as ReportMarker["stop"],
    blocked: Number(m[2]),
    capHit: m[3] === "true",
  };
}

/**
 * G2a §2.3 —— 报告 body 头部 = 终态标记行 + anchor-check 核验率行。
 * 保留 renderReportBody 的终态标记行格式（parseReportMarker / export 依赖它），
 * 核验率作为**紧随其后的独立行**标注（软闸门：<90% 不阻断导出，但必须标在头部）。
 */
export function renderReportHead(marker: ReportMarker, anchorRate: number): string {
  return `${renderReportBody(marker)}<!-- dr-anchor-rate ${anchorRate} -->\n`;
}

/** G2a §1.2 —— doc_kind 由「派的是哪个 role」推出，⛔ 绝不读 payload。 */
export function deriveDocKind(role: string): "report" | "argument" {
  return role === "dr-synthesizer" ? "report" : "argument";
}

/** G2a §2.3 —— digest 缺省由引擎按 body 计算（sha256）。 */
export function computeDocDigest(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/** G2a §2.3 —— 产物 body ≤ 4MB（spec §5.3）；超限响亮报错拒绝。 */
export const MAX_DOC_BODY_BYTES = 4 * 1024 * 1024;

export function assertDocBodyWithinLimit(
  body: string,
  limitBytes: number = MAX_DOC_BODY_BYTES,
): void {
  const bytes = Buffer.byteLength(body, "utf8");
  if (bytes > limitBytes) {
    throw new Error(`doc body exceeds ${limitBytes}-byte limit (actual ${bytes})`);
  }
}

/**
 * G2a §2.3 —— 由 role + 角色返回载荷 + origin 构造 research.doc.v2：
 * doc_kind 由 role 推出（⛔ 绝不读 payload.doc_kind，哪怕 schema 拦不住多余字段）；
 * digest 缺省按 body 计算；body ≤ 4MB。
 */
export function buildDoc(
  role: string,
  result: { body: string } & Record<string, unknown>,
  origin: string,
): DocV2 {
  const body = result.body;
  assertDocBodyWithinLimit(body);
  return {
    doc_kind: deriveDocKind(role),
    digest: computeDocDigest(body),
    body,
    origin,
  };
}

/** G2a §2.2 —— debater 语料：{question, evidences[]}，judge 额外带 prior_arguments。 */
export interface DebaterCorpus {
  question: string;
  evidences: EvidenceView[];
  prior_arguments?: string[];
}

/** G2a §2.2 —— synthesizer 语料：{question, evidences[], arguments[], terminal_marker}。 */
export interface SynthesizerCorpus {
  question: string;
  evidences: EvidenceView[];
  arguments: string[];
  terminal_marker: string;
}

/** evidence channel 回读的证据最小视图（anchor/quote/claim/clue_id）。 */
export interface EvidenceView {
  clue_id: string;
  anchor: string;
  quote: string;
  claim: string;
}

/**
 * G2a §1.1 —— 把语料序列化为位置参数字符串。
 * agent-run 的 prompt 只由 persona + 位置参数构成，`--input` 只作 schema 守卫、从不注入 prompt。
 * ⇒ 生成段三类角色的语料必须放进位置参数，否则角色交回空结果。
 */
export function serializeCorpusToPositional(
  corpus: DebaterCorpus | SynthesizerCorpus,
): string {
  return JSON.stringify(corpus);
}

/**
 * G2a §1.1 —— 构造真实生成角色 agent-run 的完整 argv：
 * `agent-run --role <role> --route <route> --run-id <runId> --input <inputPath> -- "<serialized corpus>"`
 * 语料序列化后放在 `--` 之后的位置参数（D1 判别点：⛔ 只断言 `--input` 存在不算数）。
 */
export function buildGenerateRoleArgv(opts: {
  agentRunBin: string;
  role: string;
  route: string;
  runId: string;
  inputPath: string;
  corpus: DebaterCorpus | SynthesizerCorpus;
}): string[] {
  return [
    opts.agentRunBin,
    "--role",
    opts.role,
    "--route",
    opts.route,
    "--run-id",
    opts.runId,
    "--input",
    opts.inputPath,
    "--",
    serializeCorpusToPositional(opts.corpus),
  ];
}

/** 执行壳的依赖注入面：所有副作用（读 / spawn / lock / 回写）都从这里走。 */
export interface GenerateDeps {
  readTermination(): Promise<TerminationState>;
  countBlocked(): Promise<number>;
  /** 研究问题（进入各类语料的 question 字段）。 */
  readQuestion(): Promise<string>;
  /** 本次研究 id（产物回写的 origin）。 */
  readOrigin(): Promise<string>;
  /** 从 evidence channel 回读证据（anchor/quote/claim/clue_id）。 */
  readEvidences(): Promise<EvidenceView[]>;
  /**
   * 按 role+route 派发一个生成角色，喂入引擎侧组装好的语料，回收 { body }。
   * ⛔ 语料必须由引擎序列化后放进位置参数（§1.1），不得只靠 `--input`。
   */
  spawnRole(
    role: string,
    route: string,
    corpus: DebaterCorpus | SynthesizerCorpus,
  ): Promise<{ body: string }>;
  /** anchor-check：返回缺陷数与核验率（核验率用于报告头部标注，软闸门 <90% 不阻断导出）。 */
  spawnAnchorCheck(route: string): Promise<{ defects: number; verificationRate: number }>;
  spawnExport(body: string): Promise<void>;
  /** 产物回写：发一条 research.doc.v2（doc_kind 由 role 推出，body ≤ 4MB，digest 缺省按 body 计算）。 */
  writeDoc(doc: DocV2, idempotencyKey: string): Promise<void>;
  /**
   * 单例 lock：串行化（wait-then-run），而不是拿不到就跳过。
   * 返回一个 release 函数；调用方拿到锁后必须跑 synthesizer，再释放。
   * 任一时刻并发 = 1（spec §3），且绝不跳过 synthesizer 阶段（spec §3 严格串行边）。
   */
  lockSynthesizer(): Promise<() => Promise<void>>;
}

/**
 * 执行壳：读终态 → 纯决策 → 严格按序执行副作用。
 * 串行边：debater（advocate/opponent 并行，judge 带 prior_arguments）→ synthesizer（lock）→
 * anchor-check → 导出（spec §3 / G2a §2.4）。
 * ⛔ 不得跳过 synthesizer；⛔ synthesizer 任一时刻并发 = 1；⛔ 不得跳过（D4）。
 * anchor-check 失败 / 报缺陷均不阻断导出（spec §4）。
 */
export async function runGenerate(
  deps: GenerateDeps,
  cfg: GenerateConfig = DEFAULT_GENERATE_CONFIG,
): Promise<void> {
  assertDistinctDebaterRoutes(cfg);

  const term = await deps.readTermination();
  if (!decideGenerate(term)) return;

  const blocked = await deps.countBlocked();
  const marker = buildReportMarker(term, blocked);

  const question = await deps.readQuestion();
  const origin = await deps.readOrigin();
  const evidences = await deps.readEvidences();

  // debater：advocate / opponent 并行；judge 需先拿到二者的 body 作为 prior_arguments（G2a §2.2）。
  const [advocate, opponent, judge] = cfg.debaters;
  const [advOut, oppOut] = await Promise.all([
    deps.spawnRole(advocate.role, advocate.route, { question, evidences }),
    deps.spawnRole(opponent.role, opponent.route, { question, evidences }),
  ]);
  const judgeOut = await deps.spawnRole(judge.role, judge.route, {
    question,
    evidences,
    prior_arguments: [advOut.body, oppOut.body],
  });

  // 产物回写：三条 debater 的 body → research.doc.v2（doc_kind=argument，由 role 推出）。
  const debaterOuts = [advOut, oppOut, judgeOut];
  for (let i = 0; i < cfg.debaters.length; i++) {
    const spec = cfg.debaters[i];
    await deps.writeDoc(
      buildDoc(spec.role, debaterOuts[i], origin),
      `dr-doc:${spec.role}:${origin}`,
    );
  }

  // synthesizer：单例 lock 串行化（wait-then-run）。拿锁后必跑，绝不跳过（D6 / spec §3）。
  const synthCorpus: SynthesizerCorpus = {
    question,
    evidences,
    arguments: debaterOuts.map((o) => o.body),
    terminal_marker: renderReportBody(marker),
  };
  const release = await deps.lockSynthesizer();
  let synthBody: string;
  try {
    synthBody = (
      await deps.spawnRole(cfg.synthesizer.role, cfg.synthesizer.route, synthCorpus)
    ).body;
  } finally {
    await release();
  }

  // anchor-check：跑，但失败/报缺陷都不得阻断导出（D9/D10 / G2a §2.3 软闸门）。
  let anchorRate = 0;
  try {
    const ac = await deps.spawnAnchorCheck(cfg.anchorCheckRoute);
    anchorRate = ac.verificationRate;
  } catch {
    // 失败不得阻断导出
  }

  // 报告 body 头部 = 终态标记 + anchor-check 核验率；核验率 <90% 仍导出，但必须标在头部。
  const reportBody = renderReportHead(marker, anchorRate) + synthBody;

  // 产物回写：synthesizer 的 report → research.doc.v2（doc_kind=report，由 role 推出）。
  await deps.writeDoc(
    buildDoc(cfg.synthesizer.role, { body: reportBody }, origin),
    `dr-doc:${cfg.synthesizer.role}:${origin}`,
  );

  // 导出：最后（D8）。
  await deps.spawnExport(reportBody);
}
