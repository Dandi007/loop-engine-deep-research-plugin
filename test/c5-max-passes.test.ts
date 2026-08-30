/**
 * C5（再暴露）—— round 预算**有界但充分**（非固定 16）（判别性规格 2 / 判别测试 3）。
 *
 * 根因（spec §根因链）：fleet.yaml.tpl 硬编码 `max_passes: 16` ⇒ 收敛所需轮数 > 16 的
 * heavy run 在第 16 轮后被截断，终态 generate tick 永不执行 ⇒ 报告永不落盘、哨兵又只认
 * running+outstanding>0 ⇒ done+outstanding>0 静默 exit 0。
 *
 * 判别性规格 2 选项 1（本实现取此）：round 预算**有界但充分**，由 tick 配置确定性推导
 * （deriveMaxPasses = maxClues + zeroGrowthThreshold + margin），保证「终止 tick/generate
 * 必在预算内可达」：coverage 至多增长 maxClues 次（每次重置 zeroGrowthRounds），之后
 * zeroGrowthThreshold 轮零增长确认，加 margin 兜底排空/派发/triage。
 *
 * 判别测试 3（可测形态）：推导出的预算 >= 使 zeroGrowthRounds 达阈所需轮数的下界，
 * 且 != 固定 16。修复前（max_passes=16）⇒ 本文件用例必须红；修复后必须绿。
 *
 * 单一真相源：bash（bin/deep-research-loop.sh）经 vite-node 调 src/max-passes.ts 的 main()
 * 取推导值，测试 import deriveMaxPasses 断言同一公式——两份不发散（本文件校验 CLI 输出
 * 与纯函数一致）。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect } from "vitest";
import {
  deriveMaxPasses,
  DEFAULT_MAX_PASSES_MARGIN,
} from "../src/max-passes";
import { DEFAULT_TICK_CONFIG } from "../src/tick";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const MAX_PASSES_SRC = join(ROOT, "src", "max-passes.ts");
const LOOP_SH = join(ROOT, "bin", "deep-research-loop.sh");
const FLEET_TPL = join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl");

describe("C5-MP-1（判别测试 3）: 推导预算 != 固定 16 且充分", () => {
  it("deriveMaxPasses 对默认 tick 配置不等于固定 16（修复前红）", () => {
    const budget = deriveMaxPasses({
      maxClues: DEFAULT_TICK_CONFIG.maxClues,
      zeroGrowthThreshold: DEFAULT_TICK_CONFIG.zeroGrowthThreshold,
    });
    expect(budget).not.toBe(16);
  });

  it("推导预算 >= 使 zeroGrowthRounds 达阈所需轮数的下界（可测形态）", () => {
    const zgt = DEFAULT_TICK_CONFIG.zeroGrowthThreshold;
    const maxClues = DEFAULT_TICK_CONFIG.maxClues;
    const budget = deriveMaxPasses({ maxClues, zeroGrowthThreshold: zgt });
    // coverage 至多增长 maxClues 次 + zgt 轮零增长确认 + margin 兜底 ⇒ 必达终态。
    expect(budget).toBeGreaterThanOrEqual(maxClues + zgt);
    expect(budget).toBeGreaterThanOrEqual(zgt);
  });

  it("公式 = maxClues + zeroGrowthThreshold + margin，且默认 margin 为 2", () => {
    const zgt = DEFAULT_TICK_CONFIG.zeroGrowthThreshold;
    const maxClues = DEFAULT_TICK_CONFIG.maxClues;
    expect(deriveMaxPasses({ maxClues, zeroGrowthThreshold: zgt })).toBe(
      maxClues + zgt + DEFAULT_MAX_PASSES_MARGIN,
    );
    expect(DEFAULT_MAX_PASSES_MARGIN).toBe(2);
  });
});

describe("C5-MP-2（判别测试 3）: 预算推导随 tick 配置确定性变化（heavy 规模更大）", () => {
  it("maxClues 越大预算越大（sources 4 / code-remote heavy 有更大板面上界）", () => {
    const zgt = DEFAULT_TICK_CONFIG.zeroGrowthThreshold;
    const light = deriveMaxPasses({ maxClues: 16, zeroGrowthThreshold: zgt });
    const heavy = deriveMaxPasses({ maxClues: 64, zeroGrowthThreshold: zgt });
    expect(heavy).toBeGreaterThan(light);
    expect(heavy).not.toBe(16);
  });

  it("zeroGrowthThreshold 越大预算越大", () => {
    const mc = DEFAULT_TICK_CONFIG.maxClues;
    const low = deriveMaxPasses({ maxClues: mc, zeroGrowthThreshold: 2 });
    const high = deriveMaxPasses({ maxClues: mc, zeroGrowthThreshold: 5 });
    expect(high).toBeGreaterThan(low);
  });
});

describe("C5-MP-3（判别测试 3）: bash 侧与 TS 纯函数单一真相源（CLI 输出 == deriveMaxPasses）", () => {
  it("vite-node main() 输出与 deriveMaxPasses(DEFAULT_TICK_CONFIG) 一致", () => {
    const expected = String(
      deriveMaxPasses({
        maxClues: DEFAULT_TICK_CONFIG.maxClues,
        zeroGrowthThreshold: DEFAULT_TICK_CONFIG.zeroGrowthThreshold,
      }),
    );
    const out = execFileSync(
      join(ROOT, "node_modules", ".bin", "vite-node"),
      [MAX_PASSES_SRC],
      { cwd: ROOT, encoding: "utf8", env: { ...process.env, MAX_PASSES_CLI: "1" } },
    ).trim();
    expect(out).toBe(expected);
    expect(out).not.toBe("16");
  });

  it("MAX_CLUES 显式覆盖改变推导（bash 渲染所用值由此而来）", () => {
    const out = execFileSync(
      join(ROOT, "node_modules", ".bin", "vite-node"),
      [MAX_PASSES_SRC],
      {
        cwd: ROOT,
        encoding: "utf8",
        env: {
          ...process.env,
          MAX_PASSES_CLI: "1",
          MAX_CLUES: "24",
        },
      },
    ).trim();
    expect(out).toBe(
      String(
        deriveMaxPasses({ maxClues: 24, zeroGrowthThreshold: DEFAULT_TICK_CONFIG.zeroGrowthThreshold }),
      ),
    );
  });

  it("非法 MAX_CLUES ⇒ CLI 响亮失败（exit 1），绝不静默推导", () => {
    let code = 0;
    try {
      execFileSync(join(ROOT, "node_modules", ".bin", "vite-node"), [MAX_PASSES_SRC], {
        cwd: ROOT,
        encoding: "utf8",
        env: { ...process.env, MAX_PASSES_CLI: "1", MAX_CLUES: "abc" },
      });
    } catch (e) {
      code = (e as { status?: number }).status ?? -1;
    }
    expect(code).not.toBe(0);
  });
});

describe("C5-MP-4: fleet 模板不再硬编码固定 16", () => {
  it("fleet.yaml.tpl 用 ${MAX_PASSES} 占位符而非字面 16", () => {
    const tpl = readFileSync(FLEET_TPL, "utf8");
    expect(tpl).toContain("max_passes: ${MAX_PASSES}");
    expect(tpl).not.toMatch(/max_passes:\s*16\s*$/m);
  });

  it("loop 脚本从 src/max-passes.ts 推导 MAX_PASSES（单一真相源），推导失败响亮失败", () => {
    const sh = readFileSync(LOOP_SH, "utf8");
    expect(sh).toContain("src/max-passes.ts");
    expect(sh).toContain("MAX_PASSES_CLI=1");
    expect(sh).toContain("refusing to fall back to a fixed 16");
  });
});
