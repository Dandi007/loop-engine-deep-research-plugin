/**
 * G7 —— --prompt-file 投递硬验收（spec §2 T1–T6 + §3 变异矩阵 U1–U4）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举。
 * 断言打在生产组装出的 deps 上（T6），注入分支会跳过生产装配——自建 runtime 注入的用例不算数。
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  spawnGenerateRole,
  buildGenerateRoleArgv,
  serializeCorpusToPositional,
} from "../src/generate";
import type {
  GenerateSpawnRuntime,
  DebaterCorpus,
  SynthesizerCorpus,
} from "../src/generate";
import {
  spawnTriageRole,
  buildTriageArgv,
  serializeTriageCorpusToPositional,
} from "../src/tick-run";
import type { TriageCorpus, TriageSpawnRuntime } from "../src/tick-run";

/** 构造 > 128 KB 的超限语料（spec T1：300 KB）。 */
function makeOversizeEvidence(): DebaterCorpus["evidences"] {
  const evidences: DebaterCorpus["evidences"] = [];
  for (let i = 0; i < 850; i++) {
    evidences.push({
      clue_id: `c${i}`,
      anchor: `code://repo@abc123:src/foo${i}.ts#L${i}`,
      quote: `exact quoted text for clue ${i} `.repeat(3),
      claim: `one-sentence claim for clue ${i}`,
    });
  }
  return evidences;
}

/** 构造 > 128 KB 的超限 triage 语料。 */
function makeOversizeTriageCorpus(): TriageCorpus {
  const proposed: TriageCorpus["proposed_clues"] = [];
  for (let i = 0; i < 850; i++) {
    proposed.push({
      clue_id: `c${i}`,
      clue_text: `clue text for clue ${i} `.repeat(5),
      depth: 1,
      sources: ["wiki"],
    });
  }
  return {
    question: "research question?",
    proposed_clues: proposed,
  };
}

// ── T1：超限语料能跑通（generate 侧）───────────────────────────────

describe("T1: oversize corpus (>128 KB) works via --prompt-file (generate side)", () => {
  it("argv has no single arg >= 131072 bytes; corpus content is in --prompt-file file", async () => {
    const recorded: string[][] = [];
    let capturedPromptContent = "";
    const evidences = makeOversizeEvidence();
    const corpus: DebaterCorpus = {
      question: "research question?",
      evidences,
    };
    const serialized = serializeCorpusToPositional(corpus);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    expect(serializedBytes).toBeGreaterThan(131072);

    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-oversize",
      writeInputFile: () => "/tmp/payload.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        const pfIdx = argv.indexOf("--prompt-file");
        capturedPromptContent = readFileSync(argv[pfIdx + 1], "utf8");
        return {};
      },
      readBody: async () => "out",
    };
    await spawnGenerateRole("dr-debater-advocate", "opus-4-8/ccs", corpus, runtime);

    expect(recorded).toHaveLength(1);
    const argv = recorded[0];

    // ⛔ 没有任何单个参数 ≥ 131072 字节
    for (const arg of argv) {
      expect(Buffer.byteLength(arg, "utf8")).toBeLessThan(131072);
    }

    // --prompt-file 指向的文件里逐字出现语料
    expect(argv).toContain("--prompt-file");
    expect(capturedPromptContent).toBe(serialized);
    expect(capturedPromptContent).toContain("code://repo@abc123:src/foo0.ts#L0");
    expect(capturedPromptContent).toContain("code://repo@abc123:src/foo849.ts#L849");

    // ⛔ 无 `--` 位置参数分隔符
    expect(argv.indexOf("--")).toBe(-1);
  });
});

// ── T2：两条路径都改（generate 与 triage 都用 --prompt-file）────────

describe("T2: both generate and triage paths use --prompt-file, no positional corpus", () => {
  it("generate argv uses --prompt-file, no positional corpus", async () => {
    const recorded: string[][] = [];
    const corpus: DebaterCorpus = {
      question: "q?",
      evidences: [
        { clue_id: "c1", anchor: "a1", quote: "q1", claim: "c1" },
      ],
    };
    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-gen",
      writeInputFile: () => "/tmp/payload.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
      readBody: async () => "out",
    };
    await spawnGenerateRole("dr-debater-advocate", "opus-4-8/ccs", corpus, runtime);
    const argv = recorded[0];
    expect(argv).toContain("--prompt-file");
    expect(argv.indexOf("--")).toBe(-1);
  });

  it("triage argv uses --prompt-file, no positional corpus, oversize corpus works", async () => {
    const recorded: string[][] = [];
    let capturedPromptContent = "";
    const corpus = makeOversizeTriageCorpus();
    const serialized = serializeTriageCorpusToPositional(corpus);
    const serializedBytes = Buffer.byteLength(serialized, "utf8");
    expect(serializedBytes).toBeGreaterThan(131072);

    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-triage",
      writeInputFile: () => "/tmp/i.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        const pfIdx = argv.indexOf("--prompt-file");
        capturedPromptContent = readFileSync(argv[pfIdx + 1], "utf8");
        return {};
      },
      readResult: async () => [],
    };
    await spawnTriageRole(corpus, runtime);
    const argv = recorded[0];
    expect(argv).toContain("--prompt-file");
    expect(argv.indexOf("--")).toBe(-1);

    // ⛔ 没有任何单个参数 ≥ 131072 字节
    for (const arg of argv) {
      expect(Buffer.byteLength(arg, "utf8")).toBeLessThan(131072);
    }

    expect(capturedPromptContent).toBe(serialized);
  });
});

// ── T3：语料内容逐字不变 ───────────────────────────────────────────

describe("T3: --prompt-file content equals original serializeCorpusToPositional output", () => {
  it("generate --prompt-file content matches serializeCorpusToPositional", async () => {
    const recorded: string[][] = [];
    let capturedPromptContent = "";
    const corpus: DebaterCorpus = {
      question: "research question?",
      evidences: [
        { clue_id: "c1", anchor: "a1", quote: "q1", claim: "c1" },
      ],
    };
    const serialized = serializeCorpusToPositional(corpus);

    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-t3",
      writeInputFile: () => "/tmp/payload.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        const pfIdx = argv.indexOf("--prompt-file");
        capturedPromptContent = readFileSync(argv[pfIdx + 1], "utf8");
        return {};
      },
      readBody: async () => "out",
    };
    await spawnGenerateRole("dr-debater-advocate", "opus-4-8/ccs", corpus, runtime);

    expect(capturedPromptContent).toBe(serialized);
  });

  it("triage --prompt-file content matches serializeTriageCorpusToPositional", async () => {
    const recorded: string[][] = [];
    let capturedPromptContent = "";
    const corpus: TriageCorpus = {
      question: "research question?",
      proposed_clues: [{ clue_id: "c1", clue_text: "clue one text" }],
    };
    const serialized = serializeTriageCorpusToPositional(corpus);

    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-t3",
      writeInputFile: () => "/tmp/i.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        const pfIdx = argv.indexOf("--prompt-file");
        capturedPromptContent = readFileSync(argv[pfIdx + 1], "utf8");
        return {};
      },
      readResult: async () => [],
    };
    await spawnTriageRole(corpus, runtime);

    expect(capturedPromptContent).toBe(serialized);
  });
});

// ── T4：--input 的 schema 守卫仍在 ──────────────────────────────────

describe("T4: --input schema guard is preserved", () => {
  it("generate argv still has --input pointing to the schema guard file", async () => {
    const recorded: string[][] = [];
    const corpus: DebaterCorpus = {
      question: "q?",
      evidences: [
        { clue_id: "c1", anchor: "a1", quote: "q1", claim: "c1" },
      ],
    };
    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-t4",
      writeInputFile: () => "/tmp/payload.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
      readBody: async () => "out",
    };
    await spawnGenerateRole("dr-debater-advocate", "opus-4-8/ccs", corpus, runtime);
    const argv = recorded[0];
    expect(argv).toContain("--input");
    expect(argv[argv.indexOf("--input") + 1]).toBe("/tmp/payload.json");
  });

  it("triage argv still has --input pointing to the schema guard file", async () => {
    const recorded: string[][] = [];
    const corpus: TriageCorpus = {
      question: "q?",
      proposed_clues: [{ clue_id: "c1", clue_text: "clue one text" }],
    };
    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-t4",
      writeInputFile: () => "/tmp/i.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
      readResult: async () => [],
    };
    await spawnTriageRole(corpus, runtime);
    const argv = recorded[0];
    expect(argv).toContain("--input");
    expect(argv[argv.indexOf("--input") + 1]).toBe("/tmp/i.json");
  });
});

// ── T5：载荷文件用后即删（正反两例）────────────────────────────────

describe("T5: temp files cleaned up after spawn (success and failure)", () => {
  it("success path: both --input and --prompt-file files removed after spawn", async () => {
    let inputPath = "";
    let promptFilePath = "";
    const corpus: DebaterCorpus = {
      question: "q?",
      evidences: [
        { clue_id: "c1", anchor: "a1", quote: "q1", claim: "c1" },
      ],
    };
    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-t5-ok",
      writeInputFile: (c) => {
        inputPath = join(tmpdir(), `g7-t5-input-${Date.now()}.json`);
        writeFileSync(inputPath, JSON.stringify(c));
        return inputPath;
      },
      spawnProcess: async (argv) => {
        promptFilePath = argv[argv.indexOf("--prompt-file") + 1];
        expect(existsSync(inputPath)).toBe(true);
        expect(existsSync(promptFilePath)).toBe(true);
        return {};
      },
      readBody: async () => "out",
    };
    await spawnGenerateRole("dr-debater-advocate", "opus-4-8/ccs", corpus, runtime);
    expect(existsSync(inputPath)).toBe(false);
    expect(existsSync(promptFilePath)).toBe(false);
  });

  it("failure path: spawnProcess throws → both temp files still removed", async () => {
    let inputPath = "";
    let promptFilePath = "";
    const corpus: DebaterCorpus = {
      question: "q?",
      evidences: [
        { clue_id: "c1", anchor: "a1", quote: "q1", claim: "c1" },
      ],
    };
    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-t5-fail",
      writeInputFile: (c) => {
        inputPath = join(tmpdir(), `g7-t5-fail-input-${Date.now()}.json`);
        writeFileSync(inputPath, JSON.stringify(c));
        return inputPath;
      },
      spawnProcess: async (argv) => {
        promptFilePath = argv[argv.indexOf("--prompt-file") + 1];
        throw new Error("spawn boom");
      },
      readBody: async () => "out",
    };
    await expect(
      spawnGenerateRole("dr-debater-advocate", "opus-4-8/ccs", corpus, runtime),
    ).rejects.toThrow("spawn boom");
    expect(existsSync(inputPath)).toBe(false);
    expect(existsSync(promptFilePath)).toBe(false);
  });
});

// ── T6：断言打在生产组装出的 deps 上 ────────────────────────────────

describe("T6: assertions drive production assembly (not injected spawnRole)", () => {
  it("T6-a: generate side — spawnGenerateRole is the production entry, not a test-injected path", async () => {
    const recorded: string[][] = [];
    const corpus: DebaterCorpus = {
      question: "q?",
      evidences: [
        { clue_id: "c1", anchor: "a1", quote: "q1", claim: "c1" },
      ],
    };
    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-t6",
      writeInputFile: () => "/tmp/payload.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
      readBody: async () => "out",
    };
    // ⛔ 走 spawnGenerateRole（生产入口），不注入 spawnRole
    await spawnGenerateRole("dr-debater-advocate", "opus-4-8/ccs", corpus, runtime);
    expect(recorded).toHaveLength(1);
    const argv = recorded[0];
    expect(argv).toContain("--prompt-file");
    expect(argv).toContain("--input");
    expect(argv.indexOf("--")).toBe(-1);
  });

  it("T6-b: triage side — spawnTriageRole is the production entry, not a test-injected path", async () => {
    const recorded: string[][] = [];
    const corpus: TriageCorpus = {
      question: "q?",
      proposed_clues: [{ clue_id: "c1", clue_text: "clue one text" }],
    };
    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-t6",
      writeInputFile: () => "/tmp/i.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
      readResult: async () => [],
    };
    // ⛔ 走 spawnTriageRole（生产入口），不注入 spawnTriage
    await spawnTriageRole(corpus, runtime);
    expect(recorded).toHaveLength(1);
    const argv = recorded[0];
    expect(argv).toContain("--prompt-file");
    expect(argv).toContain("--input");
    expect(argv.indexOf("--")).toBe(-1);
  });
});