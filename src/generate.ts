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
import { createHash, randomUUID } from "node:crypto";
import { writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
export function renderReportHead(marker: ReportMarker, anchorRate: number | null, anchorSumsOkFalse?: boolean): string {
  const rate = anchorRate === null
    ? (anchorSumsOkFalse ? "unavailable sums_ok=false" : "unavailable")
    : String(anchorRate);
  return `${renderReportBody(marker)}<!-- dr-anchor-rate ${rate} -->\n`;
}

/**
 * G2a §1.2 —— doc_kind 由「派的是哪个 role」推出，⛔ 绝不读 payload。
 * ⚠️ 未知 role 立即响亮抛错（评审 minor）：改名/拼错的 synthesizer role 不得静默降级为 argument，
 * 而是让派发在产物回写前就失败。
 */
export function deriveDocKind(role: string): "report" | "argument" {
  switch (role) {
    case "dr-synthesizer":
      return "report";
    case "dr-debater-advocate":
    case "dr-debater-opponent":
    case "dr-debater-judge":
      return "argument";
    default:
      throw new Error(`unknown generation role "${role}"; cannot derive doc_kind`);
  }
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
  /**
   * 终态标记：**结构化对象**（`{stop, blocked, capHit}`），由 `buildReportMarker()` 产出。
   * ⛔ 不得用 `renderReportBody()` 的字符串——agent-runtime `synthesizer-input.v1.json` 把
   *    `terminal_marker` 声明为 `{"type":"object"}`，字符串会在 `--input` 的 schema 守卫处
   *    报 CONTRACT_ERROR（评审 blocker：`expected object, got string`）。
   */
  terminal_marker: ReportMarker;
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

/**
 * G2a §1.1 —— 把语料写成 `--input` 载荷文件。
 * `--input` 只作 schema 守卫（校验完就扔、从不注入 prompt），⛔ 语料正文必须走位置参数。
 */
export function writeGenerateInputFile(corpus: DebaterCorpus | SynthesizerCorpus): string {
  const file = join(tmpdir(), `g2a-generate-input-${randomUUID()}.json`);
  writeFileSync(file, JSON.stringify(corpus));
  return file;
}

/** 生产默认 agent-run 派发所需的运行时（agent-run 定位 / spawn / body 回填）。 */
export interface GenerateSpawnRuntime {
  agentRunBin: string;
  runId: string;
  /** 写 `--input` 载荷文件；缺省 `writeGenerateInputFile`。 */
  writeInputFile?: (corpus: DebaterCorpus | SynthesizerCorpus) => string;
  /**
   * 真实 spawn；测试注入假 agent-run 记录 argv。
   * ⛔ **必填**：任何 generation 派发都必须真正启动子进程（评审 major）。
   *    缺省/缺失即响亮失败，绝不静默构建 argv 后丢弃、返回一个从未启动的假成功。
   */
  spawnProcess: (argv: string[], env: Record<string, string>) => Promise<{ pid?: number }>;
  /** 从 worker 结果读回 role 的 body。 */
  readBody: (runId: string) => Promise<string>;
}

/**
 * G2a §1.1 —— 生产默认 agent-run 派发（类比 tick-run 的 `spawnAgentRunWorker`）：
 * 语料 → `--input` 载荷文件 → `buildGenerateRoleArgv` 把序列化语料放进位置参数 → spawn agent-run。
 * 这是 `buildGenerateRoleArgv` 的**唯一生产调用点**，杜绝「语料→argv」成为死代码（评审 blocker）。
 * ⛔ `spawnProcess` 必填且**无条件调用**（评审 major）：缺失即编译/调用期失败，绝不静默丢弃 argv
 *    返回「从未启动」的假成功。载荷文件的寿命绑定到本次派发：读回 body 后**随即移除**（评审 minor，
 *    类比 tick-run 的 `onExit` unlink），防止每个 generation role 泄漏一个 tmp 文件。
 */
export async function spawnGenerateRole(
  role: string,
  route: string,
  corpus: DebaterCorpus | SynthesizerCorpus,
  runtime: GenerateSpawnRuntime,
): Promise<{ body: string }> {
  const inputPath = runtime.writeInputFile
    ? runtime.writeInputFile(corpus)
    : writeGenerateInputFile(corpus);
  try {
    const argv = buildGenerateRoleArgv({
      agentRunBin: runtime.agentRunBin,
      role,
      route,
      runId: runtime.runId,
      inputPath,
      corpus,
    });
    // ⛔ 无条件 spawn：runtime 缺 spawnProcess 在类型层即不可通过（必填），杜绝零-spawn 假成功。
    await runtime.spawnProcess(argv, { AGENT_RUN_BIN: runtime.agentRunBin });
    return { body: await runtime.readBody(runtime.runId) };
  } finally {
    // 载荷文件用后即删，不泄漏 tmp（评审 minor）。
    rmSync(inputPath, { force: true });
  }
}

/** anchor-check --json 输出的完整形状（spec §2）。 */
export interface AnchorCheckResult {
  total: number;
  current_parsed: number;
  current_verified_hit: number;
  current_failed: number;
  old_format: number;
  unparseable: number;
  discarded: number;
  sums_ok: boolean;
  loud_failures: Array<{ anchor: string; error: string }>;
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
   * 缺省（不注入）走生产路径 `spawnGenerateRole`（语料→argv→spawn），经 `spawnRuntime` 提供运行时。
   */
  spawnRole?(
    role: string,
    route: string,
    corpus: DebaterCorpus | SynthesizerCorpus,
  ): Promise<{ body: string }>;
  /** 缺省 spawnRole 的生产运行时（不注入 spawnRole 时使用）。 */
  spawnRuntime?: GenerateSpawnRuntime;
  /** anchor-check：运行确定性锚点校验器，返回其完整 --json 输出。 */
  spawnAnchorCheck(): Promise<AnchorCheckResult>;
  spawnExport(body: string, sourceMessageId: string): Promise<void>;
  /** anchor-check JSON 落盘：写到导出件同目录（软闸门，失败不阻断导出）。 */
  writeAnchorCheckJson?(json: string): Promise<void>;
  /** 产物回写：发一条 research.doc.v2（doc_kind 由 role 推出，body ≤ 4MB，digest 缺省按 body 计算）。
   *  返回发布出的 message_id。 */
  writeDoc(doc: DocV2, idempotencyKey: string): Promise<string>;
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

  // 缺省 spawnRole = 生产 agent-run 派发（语料→argv→spawn，经 spawnGenerateRole）。
  const spawnRole: NonNullable<GenerateDeps["spawnRole"]> =
    deps.spawnRole ??
    ((role, route, corpus) => {
      if (!deps.spawnRuntime) {
        throw new Error(
          "GenerateDeps.spawnRole has no default: provide spawnRole or a spawnRuntime",
        );
      }
      return spawnGenerateRole(role, route, corpus, deps.spawnRuntime);
    });

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
    spawnRole(advocate.role, advocate.route, { question, evidences }),
    spawnRole(opponent.role, opponent.route, { question, evidences }),
  ]);
  const judgeOut = await spawnRole(judge.role, judge.route, {
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
  // ⛔ terminal_marker 传 `buildReportMarker()` 产出的结构化对象，不是渲染字符串（评审 blocker）。
  const synthCorpus: SynthesizerCorpus = {
    question,
    evidences,
    arguments: debaterOuts.map((o) => o.body),
    terminal_marker: marker,
  };
  const release = await deps.lockSynthesizer();
  let synthBody: string;
  try {
    synthBody = (await spawnRole(cfg.synthesizer.role, cfg.synthesizer.route, synthCorpus)).body;
  } finally {
    await release();
  }

  // anchor-check：跑，但失败/报缺陷都不得阻断导出（D9/D10 / G2a §2.3 软闸门）。
  // ⛔ 崩溃与真实 0% 核验率要可区分：崩溃时头部标 unavailable（评审 minor），而非伪装成 0。
  // ⛔ 核验率 = current_verified_hit / total（分母必须是 total，不得用 current_parsed）。
  // ⛔ total === 0 ⇒ unavailable（非「全部核验通过」）。
  // ⛔ sums_ok === false ⇒ unavailable 且点名 sums_ok=false（须与崩溃可区分）。
  let anchorRate: number | null = null;
  let anchorSumsOkFalse = false;
  let anchorCheckJson: string | null = null;
  try {
    const ac = await deps.spawnAnchorCheck();
    anchorCheckJson = JSON.stringify(ac);
    if (ac.total === 0) {
      // total === 0 ⇒ unavailable (V3)
    } else if (!ac.sums_ok) {
      // sums_ok === false ⇒ unavailable + name it (V4)
      anchorSumsOkFalse = true;
    } else {
      anchorRate = (ac.current_verified_hit / ac.total) * 100;
    }
  } catch {
    // 失败不得阻断导出；anchorRate 保持 null → 头部标 unavailable。
  }

  // anchor-check JSON 落盘（软闸门：失败不阻断导出）
  if (anchorCheckJson !== null && deps.writeAnchorCheckJson) {
    try {
      await deps.writeAnchorCheckJson(anchorCheckJson);
    } catch {
      // 落盘失败不阻断导出
    }
  }

  // 报告 body 头部 = 终态标记 + anchor-check 核验率；核验率 <90% 仍导出，但必须标在头部。
  const reportBody = renderReportHead(marker, anchorRate, anchorSumsOkFalse) + synthBody;

  // 产物回写：synthesizer 的 report → research.doc.v2（doc_kind=report，由 role 推出）。
  const synthDocMessageId = await deps.writeDoc(
    buildDoc(cfg.synthesizer.role, { body: reportBody }, origin),
    `dr-doc:${cfg.synthesizer.role}:${origin}`,
  );

  // 导出：最后（D8），带 source_message_id。
  await deps.spawnExport(reportBody, synthDocMessageId);
}
