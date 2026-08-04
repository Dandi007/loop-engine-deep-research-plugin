/**
 * S4 —— 生成阶段编排 + 单例 lock + 终态标记
 *
 * 终止判定（decideTermination）给出非空终态之后，编排生成阶段（spec §1）：
 *   debater ×3（立论 / 反方 / 裁判，不同 route，可并行）
 *     → synthesizer（⛔ 单例 lock，任一时刻并发 = 1）
 *       → anchor-check（确定性节点，跑但不阻断导出）
 *         → 导出（确定性节点，最后）
 *
 * 结构沿用 S2/S3：编排决策是纯函数，副作用只在执行壳（runGenerate）里。
 * 本模块不 import ./bus；读 / spawn / lock 全部经 deps 注入。
 */
import type { TerminationState } from "./tick";

/** 生成阶段参数（spec §6）：debater 三 route 来自配置且必须互不相同，不得硬编码。 */
export interface GenerateConfig {
  /** debater 三立场的 route，互不相同。 */
  debaterRoutes: readonly [string, string, string];
  synthesizerRoute: string;
  anchorCheckRoute: string;
  exportRoute: string;
}

export const DEFAULT_GENERATE_CONFIG: GenerateConfig = {
  debaterRoutes: ["debater.pro", "debater.con", "debater.judge"],
  synthesizerRoute: "synthesizer",
  anchorCheckRoute: "anchor-check",
  exportRoute: "export",
};

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
    /<!--\s*dr-terminal\s+stop=(converged|capped)\s+blocked=(\d+)\s+capHit=(true|false)\s*-->/,
  );
  if (!m) return null;
  return {
    stop: m[1] as ReportMarker["stop"],
    blocked: Number(m[2]),
    capHit: m[3] === "true",
  };
}

/** 执行壳的依赖注入面：所有副作用（读 / spawn / lock）都从这里走。 */
export interface GenerateDeps {
  readTermination(): Promise<TerminationState>;
  countBlocked(): Promise<number>;
  spawnDebater(route: string): Promise<void>;
  spawnSynthesizer(route: string): Promise<void>;
  spawnAnchorCheck(route: string): Promise<{ defects: number }>;
  spawnExport(body: string): Promise<void>;
  /** 单例 lock：拿不到（他人持有）返回 null，不得并发跑 synthesizer。 */
  tryLockSynthesizer(): Promise<(() => Promise<void>) | null>;
}

/**
 * 执行壳：读终态 → 纯决策 → 严格按序执行副作用。
 * 串行边：debater 全部完成 → synthesizer（lock）→ anchor-check → 导出（spec §3）。
 * anchor-check 失败 / 报缺陷均不阻断导出（spec §4）。
 */
export async function runGenerate(
  deps: GenerateDeps,
  cfg: GenerateConfig = DEFAULT_GENERATE_CONFIG,
): Promise<void> {
  const term = await deps.readTermination();
  if (!decideGenerate(term)) return;

  const blocked = await deps.countBlocked();
  const marker = buildReportMarker(term, blocked);
  const body = renderReportBody(marker);

  // debater ×3 可并行；全部完成后才进入 synthesizer（D7）。
  await Promise.all(cfg.debaterRoutes.map((route) => deps.spawnDebater(route)));

  // synthesizer：单例 lock 守卫（D6）。拿不到锁则不跑，保证并发 = 1。
  const release = await deps.tryLockSynthesizer();
  if (release) {
    try {
      await deps.spawnSynthesizer(cfg.synthesizerRoute);
    } finally {
      await release();
    }
  }

  // anchor-check：跑，但失败/报缺陷都不得阻断导出（D9/D10）。
  try {
    await deps.spawnAnchorCheck(cfg.anchorCheckRoute);
  } catch {
    // 失败不得阻断导出
  }

  // 导出：最后（D8）。
  await deps.spawnExport(body);
}
