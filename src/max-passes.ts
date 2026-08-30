/**
 * C5（再暴露）—— round 预算推导：有界但充分，非固定 16。
 *
 * 缺陷根因（spec §根因链）：fleet.yaml.tpl 硬编码 `max_passes: 16` ⇒ loop-engine
 * `runResident` 的 maxRounds=16 ⇒ 第 16 轮后无论板面是否已到终态都不再投递 ⇒
 * 「终态 generate tick」（本应见 inFlight=0 且 zeroGrowthRounds 达阈 → state 非空 →
 * runGenerate）被预算截断，报告永不落盘，而哨兵又只认 running+outstanding>0 ⇒
 * `status=done + outstanding=1` 静默 exit 0（spec §判别性规格 2/3）。
 *
 * 本模块把轮次预算做成**有界但充分**的确定性推导（spec §2 选项 1）：
 *   - coverage（有证据的 clue 数）上界 = maxClues（板面封顶，capHit 在 count>=maxClues）；
 *   - 每轮要么 coverage 增长（重置 zeroGrowthRounds），要么 zeroGrowthRounds 单增；
 *   - 终止需 zeroGrowthRounds >= zeroGrowthThreshold 且 inFlight==0 && proposed==0
 *     （或 capHit && drained），故最坏轮数 ≈ maxClues 次增长 + zeroGrowthThreshold 次
 *     零增长确认 + margin 覆盖排空/派发/triage 轮次。
 * ⇒ 推导出的预算必 >= 使 zeroGrowthRounds 达阈所需轮数的下界（判别性测试 3 的可测形态）。
 *
 * 单一真相源：bash（bin/deep-research-loop.sh）经 vite-node 调本模块 main() 取推导值，
 * 测试直接 import deriveMaxPasses 断言同一公式——两份不发散。
 */
import { DEFAULT_TICK_CONFIG } from "./tick";
export interface MaxPassesConfig {
  /** 板面 clue 封顶（capHit 阈值）。 */
  maxClues: number;
  /** zeroGrowthRounds 达阈所需的零增长轮数。 */
  zeroGrowthThreshold: number;
  /** 排空/派发/triage 余量轮数（保守上界）。 */
  margin?: number;
}

/** 缺省余量：覆盖覆盖度增长之后的排空/派发/triage 轮次。 */
export const DEFAULT_MAX_PASSES_MARGIN = 2;

/**
 * 纯函数：由 tick 配置确定性推导轮次预算（有界但充分，非固定 16）。
 * 保证「终止 tick/generate 必在预算内可达」：coverage 至多增长 maxClues 次，
 * 之后 zeroGrowthThreshold 轮零增长确认，加 margin 兜底。
 */
export function deriveMaxPasses(cfg: MaxPassesConfig): number {
  const margin = cfg.margin ?? DEFAULT_MAX_PASSES_MARGIN;
  return cfg.maxClues + cfg.zeroGrowthThreshold + margin;
}

/**
 * CLI 入口：读 MAX_CLUES（缺省 DEFAULT_TICK_CONFIG.maxClues），把推导出的
 * max_passes 打到 stdout（供 bin/deep-research-loop.sh 渲染 fleet.yaml.tpl 的
 * `${MAX_PASSES}` 占位符）。读失败/推导非法 ⇒ stderr 报错并 exit 1。
 */
export function main(): number {
  const raw = process.env.MAX_CLUES;
  let maxClues = DEFAULT_TICK_CONFIG.maxClues;
  if (raw !== undefined && raw !== "") {
    const parsed = Number(raw);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      process.stderr.write(
        `max-passes: invalid MAX_CLUES "${raw}" (must be a positive integer); refusing to derive an invalid budget\n`,
      );
      return 1;
    }
    maxClues = parsed;
  }
  const budget = deriveMaxPasses({
    maxClues,
    zeroGrowthThreshold: DEFAULT_TICK_CONFIG.zeroGrowthThreshold,
  });
  if (!Number.isInteger(budget) || budget <= 0) {
    process.stderr.write(`max-passes: derived invalid budget ${budget}\n`);
    return 1;
  }
  process.stdout.write(String(budget));
  return 0;
}

// 仅当被当作 CLI 入口执行（bin/deep-research-loop.sh 经 vite-node 调用并设 MAX_PASSES_CLI=1）
// 时才跑 main()；被测试 import 取 deriveMaxPasses 时无副作用（G17 无副作用自检纪律）。
if (typeof process !== "undefined" && process.env.MAX_PASSES_CLI === "1") {
  process.exitCode = main();
}
