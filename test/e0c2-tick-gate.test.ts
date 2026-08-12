/**
 * E0c2 §1.2 / §1.3 / §2 判据 4,5,6,7 —— 续投门对齐终态判据 + 跨 drain 循环 + zsh 真跑。
 *
 * 判据 4（GT-4 判别性）：构造「板面已排空但 termination.state 仍为 null 且未触顶」⇒ **仍然续投**；
 *   把续投门改回只看 hasPendingWork ⇒ 测试变红。
 * 判据 5（GT-3 判别性）：构造「第一次 drain 后仍 null、第二次后非 null」⇒
 *   入口**继续跑第二轮并最终退出 0**；改回只跑一次 drain ⇒ 测试变红。
 * 判据 6（上限判别性）：termination.state 永远为 null ⇒ 撞到 profile 声明的上限时非零退出，
 *   且点名撞的是哪个上限。
 * 判据 7（GT-5 / zsh 判别性）：tick.md 里被本包改动的那段，必须有一条测试**用 `zsh -c` 真跑**
 *   并断言它在"有续投 body"的第二轮上成功；把其中任一处换成 bash-only 语法 ⇒ 该测试变红。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const TICK_MD = join(ROOT, "workflows", "deep-research", "tick", "templates", "tick.md");
const CHANNEL = "research:e0c2-test";

function writeFakeTickEntry(opts: {
  tickEntryPath: string;
  argvLog: string;
  fakeRunBody: string;
}): void {
  const realEntry = join(ROOT, "src", "tick-entry.ts");
  const viteNode = join(ROOT, "node_modules", ".bin", "vite-node");
  const script = `#!/usr/bin/env bash
set -euo pipefail
if [ "\${1:-}" = "--parse-trigger-body" ]; then
  exec "${viteNode}" "${realEntry}" --parse-trigger-body "$2"
fi
printf '%s\\n' "$@" > "${opts.argvLog}"
printf '%s\\n' '${opts.fakeRunBody}'
`;
  writeFileSync(opts.tickEntryPath, script);
  chmodSync(opts.tickEntryPath, 0o755);
}

function renderTickMd(values: Record<string, string>): string {
  const tpl = readFileSync(TICK_MD, "utf8");
  return tpl.replace(/\{\{([a-z_]+)\}\}/g, (_m, key) => values[key] ?? "");
}

function writeRunner(dir: string): { runner: string; runnerLog: string } {
  const runnerLog = join(dir, "puts.log");
  const runner = join(dir, "runner");
  writeFileSync(runner, `#!/usr/bin/env bash\nprintf '%s\\n' "$4" >> "${runnerLog}"\n`);
  chmodSync(runner, 0o755);
  writeFileSync(runnerLog, "");
  return { runner, runnerLog };
}

function runShell(shell: string, scriptPath: string, cwd: string): { code: number; out: string; err: string } {
  // 评审 minor 修复（attempt 2 final REJECT）：判据 7 字面要求「用 `zsh -c` 真跑」，
  //   loop-engine/src/lib/exec.ts:382-384 的真机形态是 `run("zsh", ["-c", script])`。
  //   原实现用 `execFileSync("zsh", [scriptPath])`（以 zsh 解释器执行脚本文件），就 GT-5 要判别的
  //   shell 语法而言与 `zsh -c` 等价（把 `read -r -a` 换回去仍会变红），但与判据字面尚差一层。
  //   这里对 zsh 逐字对齐真机调用形态：`zsh -c "$(cat script)"`，把脚本内容作为 -c 的操作数传入。
  if (shell === "zsh") {
    const script = readFileSync(scriptPath, "utf8");
    try {
      const out = execFileSync(shell, ["-c", script], {
        cwd,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: 0, out, err: "" };
    } catch (e) {
      const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
      return {
        code: err.status ?? -1,
        out: String(err.stdout ?? ""),
        err: String(err.stderr ?? ""),
      };
    }
  }
  try {
    const out = execFileSync(shell, [scriptPath], {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out, err: "" };
  } catch (e) {
    const err = e as { status?: number; stdout?: string | Buffer; stderr?: string | Buffer };
    return {
      code: err.status ?? -1,
      out: String(err.stdout ?? ""),
      err: String(err.stderr ?? ""),
    };
  }
}

// ── 判据 4（GT-4）：板面排空 + state null + 未触顶 ⇒ 仍然续投 ──────────────

describe("§2 判据 4 (GT-4): board drained + termination.state==null + !capHit ⇒ still continues", () => {
  it("hasPendingWork==false AND state==null AND capHit==false ⇒ continuation trigger IS written", () => {
    // 续投 body（第二轮起）：trigger_body 带 {coverage,zeroGrowthRounds}。
    // fakeRunBody：hasPendingWork=false（板面已排空）但 termination.state=null 且 capHit=false。
    //   ⛔ E0c2 §1.2：新门下 hasPendingWork==false 不再单独决定停投——
    //      state==null 且未触顶 ⇒ 仍续投（GT-4：板面排空那一刻 state 往往才 1，攒不到 2）。
    const dir = mkdtempSync(join(tmpdir(), "e0c2-gt4-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    writeFakeTickEntry({
      tickEntryPath: tickEntry,
      argvLog,
      fakeRunBody:
        '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 1, "zeroGrowthRounds": 1, "capHit": false}}',
    });
    const { runner, runnerLog } = writeRunner(dir);
    const storeDir = join(dir, "store");
    mkdirSync(storeDir, { recursive: true });
    const script = renderTickMd({
      tick_entry: tickEntry,
      tick_channel: CHANNEL,
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      research_origin: "",
      doc_channel: "",
      trigger_store_dir: storeDir,
      loop_store_cli: join(dir, "store-cli.js"),
      loop_engine_runner: runner,
      trigger_body: '{"tick":true,"coverage":1,"zeroGrowthRounds":0}',
    });
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    execFileSync("bash", [outShell], { cwd: dir, encoding: "utf8" });

    const puts = readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean);
    // ⛔ 判据 4 核心：hasPendingWork=false 但 state null & !capHit ⇒ 仍续投（写了 1 条 trigger）
    expect(puts).toHaveLength(1);
    const body = JSON.parse(puts[0]);
    expect(body.body.coverage).toBe(1);
    expect(body.body.zeroGrowthRounds).toBe(1);
    rmSync(dir, { recursive: true, force: true });
  });

  it("DISCRIMINATING: hasPendingWork==false AND state=='converged' ⇒ NO continuation (stops on terminal)", () => {
    // 对照：拿到非 null 终态后**必须停止续投**（spec §1.2：⛔ 不得无限空转）。
    const dir = mkdtempSync(join(tmpdir(), "e0c2-gt4-conv-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    writeFakeTickEntry({
      tickEntryPath: tickEntry,
      argvLog,
      fakeRunBody:
        '{"hasPendingWork": false, "decisions": [], "termination": {"state": "converged", "coverage": 1, "zeroGrowthRounds": 2, "capHit": false}}',
    });
    const { runner, runnerLog } = writeRunner(dir);
    const storeDir = join(dir, "store");
    mkdirSync(storeDir, { recursive: true });
    const script = renderTickMd({
      tick_entry: tickEntry,
      tick_channel: CHANNEL,
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      research_origin: "",
      doc_channel: "",
      trigger_store_dir: storeDir,
      loop_store_cli: join(dir, "store-cli.js"),
      loop_engine_runner: runner,
      trigger_body: '{"tick":true,"coverage":1,"zeroGrowthRounds":1}',
    });
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    execFileSync("bash", [outShell], { cwd: dir, encoding: "utf8" });

    const puts = readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean);
    // ⛔ state==converged ⇒ 停止续投（0 条 trigger）
    expect(puts).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });

  it("DISCRIMINATING: hasPendingWork==false AND capHit==true AND state==null ⇒ NO continuation (fuse not bypassed)", () => {
    // 触顶（capHit）时即便 state 仍为 null（在途排空中）也不续投——让 drain 收敛，
    // ⛔ 不得因本改动绕过熔断（spec §1.2：capped 需等在途排空）。
    const dir = mkdtempSync(join(tmpdir(), "e0c2-gt4-cap-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    writeFakeTickEntry({
      tickEntryPath: tickEntry,
      argvLog,
      fakeRunBody:
        '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 1, "zeroGrowthRounds": 0, "capHit": true}}',
    });
    const { runner, runnerLog } = writeRunner(dir);
    const storeDir = join(dir, "store");
    mkdirSync(storeDir, { recursive: true });
    const script = renderTickMd({
      tick_entry: tickEntry,
      tick_channel: CHANNEL,
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      research_origin: "",
      doc_channel: "",
      trigger_store_dir: storeDir,
      loop_store_cli: join(dir, "store-cli.js"),
      loop_engine_runner: runner,
      trigger_body: '{"tick":true,"coverage":1,"zeroGrowthRounds":0}',
    });
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);
    execFileSync("bash", [outShell], { cwd: dir, encoding: "utf8" });

    const puts = readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean);
    // ⛔ capHit==true ⇒ 不续投（让 capped 排空，不绕过熔断）
    expect(puts).toHaveLength(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ── 判据 7（GT-5 / zsh）：被改动的段落必须在 zsh -c 下真能跑 ────────────────

describe("§2 判据 7 (GT-5/zsh): changed section runs under zsh -c with continuation body (round 2+)", () => {
  it("tick.md with continuation body succeeds under zsh -c (round 2: prev_line parse + term gate)", () => {
    // ⛔ GT-5：loop-engine 的 bash 叶子恒用 zsh -c 执行 tick.md。
    //    旧的 `read -r -a prev_arr` 在 zsh 下从第二轮起必死（zsh 的 read 无 -a）。
    //    本用例用 zsh 真跑渲染后的 tick.md，喂带计数的续投 body（触发 prev_line 解析），
    //    断言 zsh 下成功（exit 0 且 --prev-* 被正确传入 + 续投 trigger 被写）。
    const dir = mkdtempSync(join(tmpdir(), "e0c2-zsh-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    writeFakeTickEntry({
      tickEntryPath: tickEntry,
      argvLog,
      fakeRunBody:
        '{"hasPendingWork": false, "decisions": [], "termination": {"state": null, "coverage": 3, "zeroGrowthRounds": 1, "capHit": false}}',
    });
    const { runner, runnerLog } = writeRunner(dir);
    const storeDir = join(dir, "store");
    mkdirSync(storeDir, { recursive: true });
    const script = renderTickMd({
      tick_entry: tickEntry,
      tick_channel: CHANNEL,
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      research_origin: "",
      doc_channel: "",
      trigger_store_dir: storeDir,
      loop_store_cli: join(dir, "store-cli.js"),
      loop_engine_runner: runner,
      trigger_body: '{"tick":true,"coverage":2,"zeroGrowthRounds":0}',
    });
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);

    // ⛔ 用 zsh 真跑（不是 bash、不是 sh）—— 判据 7 的核心要求。
    const result = runShell("zsh", outShell, dir);
    expect(result.code, `zsh stdout: ${result.out}\nzsh stderr: ${result.err}`).toBe(0);
    expect(result.err).not.toMatch(/bad option/);

    // --prev-* 被正确传入（prev_line 解析在 zsh 下成功）
    const argv = readFileSync(argvLog, "utf8").trim().split("\n");
    expect(argv).toContain("--prev-coverage");
    expect(argv[argv.indexOf("--prev-coverage") + 1]).toBe("2");
    expect(argv).toContain("--prev-zero-growth");
    expect(argv[argv.indexOf("--prev-zero-growth") + 1]).toBe("0");

    // 续投 trigger 被写（GT-4 门：state null & !capHit ⇒ 续投，在 zsh 下也成立）
    const puts = readFileSync(runnerLog, "utf8").trim().split("\n").filter(Boolean);
    expect(puts).toHaveLength(1);
    const body = JSON.parse(puts[0]);
    expect(body.body.coverage).toBe(3);
    expect(body.body.zeroGrowthRounds).toBe(1);

    rmSync(dir, { recursive: true, force: true });
  });

  it("tick.md with seed body succeeds under zsh -c (round 1: no prev_*)", () => {
    // 首轮（seed body）在 zsh 下也必须成功。
    const dir = mkdtempSync(join(tmpdir(), "e0c2-zsh-seed-"));
    const argvLog = join(dir, "tick-entry.argv.log");
    const tickEntry = join(dir, "tick-entry");
    writeFakeTickEntry({
      tickEntryPath: tickEntry,
      argvLog,
      fakeRunBody:
        '{"hasPendingWork": true, "decisions": [], "termination": {"state": null, "coverage": 0, "zeroGrowthRounds": 0, "capHit": false}}',
    });
    const { runner, runnerLog } = writeRunner(dir);
    const storeDir = join(dir, "store");
    mkdirSync(storeDir, { recursive: true });
    const script = renderTickMd({
      tick_entry: tickEntry,
      tick_channel: CHANNEL,
      evidence_channel: "",
      allowed_root: "",
      max_writes: "64",
      research_question: "",
      research_origin: "",
      doc_channel: "",
      trigger_store_dir: storeDir,
      loop_store_cli: join(dir, "store-cli.js"),
      loop_engine_runner: runner,
      trigger_body: '{"seed":true}',
    });
    const outShell = join(dir, "tick.sh");
    writeFileSync(outShell, script);
    chmodSync(outShell, 0o755);

    const result = runShell("zsh", outShell, dir);
    expect(result.code, `zsh stdout: ${result.out}\nzsh stderr: ${result.err}`).toBe(0);
    expect(result.err).not.toMatch(/bad option/);

    const argv = readFileSync(argvLog, "utf8").trim().split("\n");
    expect(argv).not.toContain("--prev-coverage");

    rmSync(dir, { recursive: true, force: true });
  });
});
