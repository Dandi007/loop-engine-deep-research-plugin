/**
 * A7 —— 插件装配硬验收测试（spec §4 G1–G9 / G11）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举（spec §5.1 第 2 条）。
 * 断言作用域收窄到渲染结果的具体字段 / 磁盘真实文件（spec §5.1 第 4、5 条）。
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { describe, it, expect } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

function run(argv: string[], env: NodeJS.ProcessEnv = {}): string {
  return execFileSync("bash", argv, {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

function dryRun(): string {
  return run([join(ROOT, "bin", "deep-research-loop.sh"), "--dry-run"]);
}

describe("G1 dry-run exits 0 without network", () => {
  it("renders and exits 0", () => {
    const out = dryRun();
    expect(out).toContain("max_passes:");
  });

  it("dry-run code path contains no network verb", () => {
    const files = [
      "bin/deep-research-loop.sh",
      "bin/tick-entry.sh",
      "scripts/render-template.mjs",
    ];
    const hay = files.map((f) => readFileSync(join(ROOT, f), "utf8")).join("\n");
    expect(/\bcurl\b|\bwget\b|\bfetch\s*\(/i.test(hay)).toBe(false);
  });
});

describe("G2 rendered fleet is valid YAML with max_passes and non-empty pipelines", () => {
  it("parses and carries the required fields", () => {
    const doc = parse(dryRun());
    expect(doc.max_passes).toBeTypeOf("number");
    expect(Array.isArray(doc.pipelines)).toBe(true);
    expect(doc.pipelines.length).toBeGreaterThan(0);
    expect(doc.pipelines[0].label).toBeTruthy();
  });
});

describe("G3 each rendered config_dir exists and contains workflow.yaml", () => {
  it("every pipeline config_dir is a real dir with workflow.yaml", () => {
    const doc = parse(dryRun());
    for (const p of doc.pipelines) {
      const cfgDir = resolve(p.config_dir);
      expect(existsSync(cfgDir)).toBe(true);
      expect(existsSync(join(cfgDir, "workflow.yaml"))).toBe(true);
    }
  });
});

describe("G4 seed template files exist on disk", () => {
  it("each workflow seed[].template points to a real template file", () => {
    const doc = parse(dryRun());
    for (const p of doc.pipelines) {
      const cfgDir = resolve(p.config_dir);
      const wf = parse(readFileSync(join(cfgDir, "workflow.yaml"), "utf8"));
      for (const seed of wf.seed ?? []) {
        const tpl = join(cfgDir, "templates", `${seed.template}.md`);
        expect(existsSync(tpl)).toBe(true);
      }
    }
  });
});

describe("G5 rendered fleet carries no clue-state claim.store_dir", () => {
  it("has zero clue/store_dir coupling", () => {
    const out = dryRun();
    expect(/clue.*store_dir|store_dir.*clue/i.test(out)).toBe(false);
    expect(/\bclue\b/i.test(out)).toBe(false);
  });
});

describe("G6 tick entry invocable in clean env", () => {
  it("--help exits 0 and prints usage", () => {
    const out = run([join(ROOT, "bin", "tick-entry.sh"), "--help"]);
    expect(out).toMatch(/usage/i);
    expect(out.length).toBeGreaterThan(0);
  });

  it("--selfcheck exits 0 and returns a self-check", () => {
    const out = run([join(ROOT, "bin", "tick-entry.sh"), "--selfcheck"]);
    const obj = JSON.parse(out);
    expect(obj.ok).toBe(true);
  });
});

describe("G7 no-side-effect call does not touch bus", () => {
  it("--selfcheck succeeds with bus pointed at an unreachable address", () => {
    const out = run(
      [join(ROOT, "bin", "tick-entry.sh"), "--selfcheck"],
      { AGENT_BUS_URL: "http://127.0.0.1:7490" },
    );
    const obj = JSON.parse(out);
    expect(obj.ok).toBe(true);
    expect(obj.termination.state).toBe(null);
  });

  it("tick entry has no network dependency in its source", () => {
    const src = readFileSync(join(ROOT, "src", "tick-entry.ts"), "utf8");
    expect(/fetch\s*\(/.test(src)).toBe(false);
    expect(src).not.toContain("7490");
    expect(src).not.toContain('import "./bus"');
  });
});

describe("G8 package.json exposes a real entry path", () => {
  it("exports['.'] or main points to an existing file", () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    const entry = pkg.exports?.["."] ?? pkg.main;
    expect(entry).toBeTruthy();
    expect(existsSync(join(ROOT, entry))).toBe(true);
  });
});

describe("G9 tick entry reuses src/tick, no reimplementation", () => {
  it("imports from ./tick", () => {
    const src = readFileSync(join(ROOT, "src", "tick-entry.ts"), "utf8");
    expect(src).toMatch(/from\s+["']\.\/tick["']/);
  });

  it("each decision primitive is defined exactly once in src", () => {
    const defCount = (re: RegExp): number => {
      const files = ["tick.ts", "generate.ts", "tick-entry.ts"];
      let n = 0;
      for (const f of files) {
        const body = readFileSync(join(ROOT, "src", f), "utf8");
        n += (body.match(re) ?? []).length;
      }
      return n;
    };
    expect(defCount(/function decideTick\s*\(/)).toBe(1);
    expect(defCount(/function decideTermination\s*\(/)).toBe(1);
    expect(defCount(/function runGenerate\s*\(/)).toBe(1);
  });
});

describe("G11 running evidence is written under docs/dev-notes", () => {
  it("dev-note exists and root has no IMPLEMENTATION_SUMMARY.md", () => {
    expect(
      existsSync(join(ROOT, "docs", "dev-notes", "dev_ledr_a7_plugin_wiring_01.md")),
    ).toBe(true);
    expect(existsSync(join(ROOT, "IMPLEMENTATION_SUMMARY.md"))).toBe(false);
  });
});

// ── N9：节点模板已切到真实 tick 入口，且 --selfcheck 仍保留 ──

describe("N9 template switched to real tick entry, selfcheck preserved", () => {
  it("tick.md invokes --run (real entry) and still references --selfcheck", () => {
    const tpl = readFileSync(
      join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md"),
      "utf8",
    );
    // 新入口：真实 tick 用 --run。
    expect(tpl).toMatch(/\-\-run/);
    // --selfcheck 仍保留（A7 G6/G7 需要它做无副作用自检）。
    expect(tpl).toMatch(/\-\-selfcheck/);
  });

  it("tick_channel is wired end-to-end so --run is actually reachable", () => {
    // ⛔ 判别性：不得只凭模板里出现 `--run` 就下结论（spec §0 / §4.1 纪律 8）。
    // 必须证明 channel 真的从装配系统一路流到 tick 节点：
    //   fleet.yaml.tpl 声明 tick_channel ← ${TICK_CHANNEL}（pipeline input）
    //   workflow.yaml seed payload 携带 tick_channel ← {{tick_channel}}
    //   tick.md 用非空的 tick_channel 走 --run 分支
    //   渲染后的 fleet 里 pipeline input 真的带上非空 tick_channel
    const tplText = readFileSync(
      join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl"),
      "utf8",
    );
    const loopText = readFileSync(
      join(ROOT, "bin", "deep-research-loop.sh"),
      "utf8",
    );
    const workflowText = readFileSync(
      join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml"),
      "utf8",
    );
    const tickMd = readFileSync(
      join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md"),
      "utf8",
    );
    // 1) fleet 声明 tick_channel input，且来源是 ${TICK_CHANNEL} 环境变量。
    expect(tplText).toMatch(/tick_channel:\s*\$\{TICK_CHANNEL\}/);
    // 2) 装配脚本导出 TICK_CHANNEL（有值，非空），渲染才不失败。
    expect(loopText).toMatch(/export\s+TICK_CHANNEL=/);
    // 3) workflow seed payload 把 tick_channel 从 pipeline input namespace 注入。
    expect(workflowText).toMatch(/tick_channel:\s*"\{\{tick_channel\}\}"/);
    // 4) tick.md 在非空 tick_channel 时确实执行 --run（而不是永远落 --selfcheck）。
    expect(tickMd).toMatch(/\-\-run\s+"\$tick_channel"/);
    // 5) 渲染产物：pipeline input 里 tick_channel 有非空值（真实 wiring 成立）。
    const doc = parse(dryRun());
    const tickInput = doc.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
    expect(tickInput).toBeTruthy();
    expect(typeof tickInput.tick_channel).toBe("string");
    expect(tickInput.tick_channel.length).toBeGreaterThan(0);
  });

  it("--selfcheck still exits 0 with a self-check (no side effects)", () => {
    const out = run([join(ROOT, "bin", "tick-entry.sh"), "--selfcheck"]);
    const obj = JSON.parse(out);
    expect(obj.ok).toBe(true);
  });
});

// ── A8e：evidence channel 随装配系统端到端接线（blocker finding）──

describe("A8e evidence channel wired end-to-end through the assembly", () => {
  it("`--evidence-channel` is reachable from the template down to the entry", () => {
    // ⛔ 判别性（spec §4.1 纪律 8）：不得只凭模板里出现 `--evidence-channel` 就下结论，
    //    必须证明 evidence channel 真的从装配系统一路流到 tick 节点：
    //      fleet.yaml.tpl 声明 evidence_channel ← ${EVIDENCE_CHANNEL}（pipeline input）
    //      workflow.yaml seed payload 携带 evidence_channel ← {{evidence_channel}}
    //      tick.md 在非空 evidence_channel 时把 `--evidence-channel` 传给 `--run`
    //      bin/deep-research-loop.sh 导出 EVIDENCE_CHANNEL（有值，非空）
    //      渲染后的 fleet 里 pipeline input 真的带上非空 evidence_channel
    const tplText = readFileSync(
      join(ROOT, "workflows", "deep-research", "fleet.yaml.tpl"),
      "utf8",
    );
    const loopText = readFileSync(
      join(ROOT, "bin", "deep-research-loop.sh"),
      "utf8",
    );
    const workflowText = readFileSync(
      join(ROOT, "workflows", "deep-research", "tick", "workflow.yaml"),
      "utf8",
    );
    const tickMd = readFileSync(
      join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md"),
      "utf8",
    );
    // 1) 装配脚本导出 EVIDENCE_CHANNEL（有值，渲染才不失败）。
    expect(loopText).toMatch(/export\s+EVIDENCE_CHANNEL=/);
    // 2) fleet 声明 evidence_channel input，来源是 ${EVIDENCE_CHANNEL} 环境变量。
    expect(tplText).toMatch(/evidence_channel:\s*\$\{EVIDENCE_CHANNEL\}/);
    // 3) workflow seed payload 把 evidence_channel 从 pipeline input namespace 注入。
    expect(workflowText).toMatch(/evidence_channel:\s*"\{\{evidence_channel\}\}"/);
    // 4) tick.md 在非空 evidence_channel 时确实把 --evidence-channel 传给 --run。
    expect(tickMd).toMatch(/\-\-run\s+"\$tick_channel"\s+\-\-evidence-channel\s+"\$evidence_channel"/);
    // 5) 渲染产物：pipeline input 里 evidence_channel 有非空值（真实 wiring 成立）。
    const doc = parse(dryRun());
    const tickInput = doc.pipelines.find((p: { label?: string }) => p.label === "tick")?.input;
    expect(tickInput).toBeTruthy();
    expect(typeof tickInput.evidence_channel).toBe("string");
    expect(tickInput.evidence_channel.length).toBeGreaterThan(0);
  });

  it("`--evidence-channel` reaches parseRunCliArgs on the production --run path", () => {
    // ⛔ 生产 `--run` 路径（parseRunCliArgs）必须解析 `--evidence-channel`：
    //    否则即使模板把参数传下去，入口也识别不了。
    const tickRunSrc = readFileSync(join(ROOT, "src", "tick-run.ts"), "utf8");
    expect(tickRunSrc).toMatch(/\-\-evidence-channel/);
    const tickEntrySrc = readFileSync(join(ROOT, "src", "tick-entry.ts"), "utf8");
    expect(tickEntrySrc).toMatch(/\-\-evidence-channel/);
  });
});
