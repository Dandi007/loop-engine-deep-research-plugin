/**
 * G8 —— 生成段 argv 传 --role 却不传 --route / --runtime（spec §2 V1–V5）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举。
 * 断言打在生产组装出的 deps 上（V5），注入分支会跳过生产装配——自建 runtime 注入的用例不算数。
 * ⛔ 不 mock spawnGenerateRole：走生产入口，fake runtime 的 spawnProcess 记录 argv。
 */
import { describe, it, expect } from "vitest";
import {
  spawnGenerateRole,
  buildGenerateRoleArgv,
  DEFAULT_GENERATE_CONFIG,
} from "../src/generate";
import type {
  GenerateSpawnRuntime,
  DebaterCorpus,
  SynthesizerCorpus,
  GenerateRoleSpec,
} from "../src/generate";
import {
  spawnTriageRole,
  buildTriageArgv,
} from "../src/tick-run";
import type { TriageCorpus, TriageSpawnRuntime } from "../src/tick-run";

const ALL_ROLES = [
  "dr-debater-advocate",
  "dr-debater-opponent",
  "dr-debater-judge",
  "dr-synthesizer",
] as const;

function makeCorpus(role: "dr-synthesizer" | "debater"): DebaterCorpus | SynthesizerCorpus {
  const evidences: DebaterCorpus["evidences"] = [
    { clue_id: "c1", anchor: "a1", quote: "q1", claim: "c1" },
  ];
  if (role === "dr-synthesizer") {
    return {
      question: "q?",
      evidences,
      arguments: ["b1", "b2"],
      terminal_marker: { stop: "converged", blocked: 0, capHit: false },
    };
  }
  return { question: "q?", evidences };
}

function fakeRuntime(over?: Partial<GenerateSpawnRuntime>): GenerateSpawnRuntime {
  return {
    agentRunBin: "/fake/agent-run",
    runId: "run-g8",
    writeInputFile: () => "/tmp/payload.json",
    spawnProcess: async () => ({}),
    readBody: async () => "out",
    ...over,
  };
}

// ── V1：argv 合法 ──────────────────────────────────────────────────

describe("V1: argv is legal — no --route, has --role / --run-id / --input / --prompt-file", () => {
  it("V1: generate argv does NOT contain --route, does contain the four required flags", async () => {
    const recorded: string[][] = [];
    const runtime = fakeRuntime({
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
    });
    await spawnGenerateRole("dr-debater-advocate", makeCorpus("debater") as DebaterCorpus, runtime);

    expect(recorded).toHaveLength(1);
    const argv = recorded[0];

    expect(argv).toContain("--role");
    expect(argv).toContain("--run-id");
    expect(argv).toContain("--input");
    expect(argv).toContain("--prompt-file");
    expect(argv).not.toContain("--route");
    expect(argv).not.toContain("--runtime");
  });

  it("V1: --role arg equals the role passed to spawnGenerateRole", async () => {
    const recorded: string[][] = [];
    const runtime = fakeRuntime({
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
    });
    await spawnGenerateRole("dr-synthesizer", makeCorpus("dr-synthesizer") as SynthesizerCorpus, runtime);

    const argv = recorded[0];
    const roleIdx = argv.indexOf("--role");
    expect(argv[roleIdx + 1]).toBe("dr-synthesizer");
  });
});

// ── V2：四个 role 都走同一形状 ─────────────────────────────────────

describe("V2: all four roles use the same argv shape — no --route in any", () => {
  for (const role of ALL_ROLES) {
    it(`V2: ${role} argv has no --route`, async () => {
      const recorded: string[][] = [];
      const runtime = fakeRuntime({
        spawnProcess: async (argv) => {
          recorded.push(argv);
          return {};
        },
      });
      if (role === "dr-synthesizer") {
        await spawnGenerateRole(role, makeCorpus("dr-synthesizer") as SynthesizerCorpus, runtime);
      } else {
        await spawnGenerateRole(role, makeCorpus("debater") as DebaterCorpus, runtime);
      }

      expect(recorded).toHaveLength(1);
      const argv = recorded[0];
      expect(argv).not.toContain("--route");
      expect(argv).toContain("--role");
      expect(argv).toContain("--run-id");
      expect(argv).toContain("--input");
      expect(argv).toContain("--prompt-file");
    });
  }
});

// ── V3：无死字段 ───────────────────────────────────────────────────

describe("V3: no dead route fields in GenerateConfig", () => {
  it("V3: GenerateRoleSpec has no route property", () => {
    const spec: GenerateRoleSpec = { role: "dr-debater-advocate" };
    const keys = Object.keys(spec);
    expect(keys).toEqual(["role"]);
  });

  it("V3: DEFAULT_GENERATE_CONFIG debaters and synthesizer have no route", () => {
    for (const d of DEFAULT_GENERATE_CONFIG.debaters) {
      expect(Object.keys(d)).toEqual(["role"]);
    }
    expect(Object.keys(DEFAULT_GENERATE_CONFIG.synthesizer)).toEqual(["role"]);
  });

  it("V3: GenerateConfig has no exportRoute field", () => {
    const keys = Object.keys(DEFAULT_GENERATE_CONFIG);
    expect(keys).not.toContain("exportRoute");
    expect(keys).toEqual(["debaters", "synthesizer"]);
  });

  it("V3: buildGenerateRoleArgv opts type has no route field", () => {
    const argv = buildGenerateRoleArgv({
      agentRunBin: "/fake/agent-run",
      role: "dr-debater-advocate",
      runId: "run-1",
      inputPath: "/tmp/i.json",
      promptFile: "/tmp/p.txt",
    });
    expect(argv).not.toContain("--route");
  });
});

// ── V4：triage argv 保持原样 ───────────────────────────────────────

describe("V4: triage argv unchanged (it was always correct — only --role, no --route)", () => {
  it("V4: triage argv has --role but no --route", async () => {
    const recorded: string[][] = [];
    const corpus: TriageCorpus = {
      question: "q?",
      proposed_clues: [{ clue_id: "c1", clue_text: "clue one text" }],
    };
    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-v4",
      writeInputFile: () => "/tmp/i.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
      readResult: async () => [],
    };
    await spawnTriageRole(corpus, runtime);
    const argv = recorded[0];
    expect(argv).toContain("--role");
    expect(argv).not.toContain("--route");
    expect(argv).toContain("--prompt-file");
    expect(argv).toContain("--input");
  });

  it("V4: buildTriageArgv produces no --route", () => {
    const argv = buildTriageArgv({
      agentRunBin: "/fake/agent-run",
      runId: "run-1",
      inputPath: "/tmp/i.json",
      promptFile: "/tmp/p.txt",
    });
    expect(argv).not.toContain("--route");
  });
});

// ── V5：断言打在生产组装出的 deps 上 ───────────────────────────────

describe("V5: assertions drive production assembly (not injected spawnRole)", () => {
  it("V5-a: spawnGenerateRole is the production entry — argv recorded from real spawnProcess", async () => {
    const recorded: string[][] = [];
    const runtime = fakeRuntime({
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
    });
    await spawnGenerateRole("dr-debater-advocate", makeCorpus("debater") as DebaterCorpus, runtime);
    expect(recorded).toHaveLength(1);
    const argv = recorded[0];
    expect(argv).not.toContain("--route");
    expect(argv).toContain("--role");
    expect(argv).toContain("--run-id");
    expect(argv).toContain("--input");
    expect(argv).toContain("--prompt-file");
  });

  it("V5-b: buildGenerateRoleArgv is a pure function returning the expected shape", () => {
    const argv = buildGenerateRoleArgv({
      agentRunBin: "/fake/agent-run",
      role: "dr-synthesizer",
      runId: "run-1",
      inputPath: "/tmp/i.json",
      promptFile: "/tmp/p.txt",
    });
    expect(argv).toEqual([
      "/fake/agent-run",
      "--role",
      "dr-synthesizer",
      "--run-id",
      "run-1",
      "--input",
      "/tmp/i.json",
      "--prompt-file",
      "/tmp/p.txt",
    ]);
    expect(argv).not.toContain("--route");
  });
});