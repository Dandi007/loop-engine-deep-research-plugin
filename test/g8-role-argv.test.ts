/**
 * G8(v2) —— 生成段 argv 去掉 `--route`（spec §1 V1–V4）。
 *
 * 纯函数 `buildGenerateRoleArgv` 直接调用，零 mock。
 * ⛔ 禁止 vi.mock 被测模块（spec §0.2(a)）。
 */
import { describe, it, expect } from "vitest";
import { buildGenerateRoleArgv } from "../src/generate";

const ROLES = [
  "dr-debater-advocate",
  "dr-debater-opponent",
  "dr-debater-judge",
  "dr-synthesizer",
] as const;

describe("G8 V1: argv does not contain --route", () => {
  it("buildGenerateRoleArgv output has no --route flag", () => {
    const argv = buildGenerateRoleArgv({
      agentRunBin: "/fake/agent-run",
      role: "dr-debater-advocate",
      runId: "run-1",
      inputPath: "/tmp/input.json",
      promptFile: "/tmp/prompt.txt",
    });
    expect(argv).not.toContain("--route");
    expect(argv).toContain("--role");
    expect(argv).toContain("--run-id");
    expect(argv).toContain("--input");
    expect(argv).toContain("--prompt-file");
  });
});

describe("G8 V2: all four roles covered", () => {
  for (const role of ROLES) {
    it(`role ${role} produces argv with --role, --run-id, --input, --prompt-file and no --route`, () => {
      const argv = buildGenerateRoleArgv({
        agentRunBin: "/fake/agent-run",
        role,
        runId: `run-${role}`,
        inputPath: `/tmp/input-${role}.json`,
        promptFile: `/tmp/prompt-${role}.txt`,
      });

      expect(argv).not.toContain("--route");
      expect(argv).toContain("--role");
      expect(argv).toContain(role);
      expect(argv).toContain("--run-id");
      expect(argv).toContain(`run-${role}`);
      expect(argv).toContain("--input");
      expect(argv).toContain(`/tmp/input-${role}.json`);
      expect(argv).toContain("--prompt-file");
      expect(argv).toContain(`/tmp/prompt-${role}.txt`);
    });
  }
});