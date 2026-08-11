/**
 * E0a §1.3/§1.4 —— 实证判据（bin/e0-verify.sh）的判别性硬验收。
 *
 * 核心：入口退出码**不得**再是 loop 退出码的透传。判据全过才退出 0；任意一条不成立
 * ⇒ 非零退出并点名。本测试驱动 e0-verify.sh 本体（bin 里的唯一判据权威），
 * 构造「loop 退出 0 但零写入 / 板面无终态」等情形，断言判据确实拒绝。
 *
 * ⛔ 判别性（spec §3 判据 2）：把「只看 loop 退出码」这条改成成功 ⇒ 本测试必须变红。
 *    —— 具体由 term=null + 有写入 的用例承担：若实现退化成只看 loop 退出码，
 *       该用例会误判成功，测试随即失败。
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const VERIFY = join(ROOT, "bin", "e0-verify.sh");

function runVerify(
  loopExit: number,
  tickPre: number,
  tickPost: number,
  term: string,
  prodPre: number,
  prodPost: number,
): { code: number; err: string } {
  try {
    execFileSync("bash", [VERIFY, String(loopExit), String(tickPre), String(tickPost), term, String(prodPre), String(prodPost)], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, err: "" };
  } catch (e) {
    const err = e as { status?: number; stderr?: string | Buffer };
    return { code: err.status ?? -1, err: String(err.stderr ?? "") };
  }
}

describe("E0a §1.3 empirical criteria reject the idle/silent-success shape", () => {
  it("loop exit 0, no growth, no terminal state ⇒ non-zero exit naming the situation", () => {
    const r = runVerify(0, 5, 5, "null", 10, 10);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/head_seq/);
    expect(r.err).toMatch(/termination/i);
  });

  it("loop exit 0 with board growth but NO terminal state ⇒ non-zero exit naming termination (discriminability core)", () => {
    // ⛔ 若实现退化成「只看 loop 退出码」或「只看有没有写入」，此用例会误判成功 → 测试变红。
    const r = runVerify(0, 5, 6, "null", 10, 10);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/termination/i);
    expect(r.err).not.toMatch(/head_seq did not strictly grow/);
  });

  it("loop exit 0 with terminal state but zero board writes ⇒ non-zero exit naming no growth", () => {
    const r = runVerify(0, 5, 5, "converged", 10, 10);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/head_seq did not strictly grow/);
  });

  it("loop non-zero exit ⇒ non-zero exit naming loop exit code", () => {
    const r = runVerify(3, 5, 6, "converged", 10, 10);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/loop exit code/);
  });
});

describe("E0a §1.4 production bus readings in the criteria", () => {
  it("prod sum changed ⇒ non-zero exit naming production pollution", () => {
    const r = runVerify(0, 5, 6, "converged", 10, 11);
    expect(r.code).not.toBe(0);
    expect(r.err).toMatch(/production bus/);
  });

  it("all criteria pass ⇒ exit 0", () => {
    const r = runVerify(0, 5, 6, "converged", 10, 10);
    expect(r.code).toBe(0);
    expect(r.err).toBe("");
  });
});
