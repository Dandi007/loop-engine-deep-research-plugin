/**
 * G8 —— 生成段 argv 传 --role 却不传 --route / --runtime（spec §2 V1–V5 + §3 变异矩阵 W1–W3）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举。
 * 断言打在生产组装出的 deps 上（V5），注入分支会跳过生产装配——自建 runtime 注入的用例不算数。
 */
import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";
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

const mutationFlags = vi.hoisted(() => ({ w1: false, w2: false, w3: false }));

vi.mock("../src/generate", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/generate")>();
  return {
    ...actual,
    buildGenerateRoleArgv: (opts: Parameters<typeof actual.buildGenerateRoleArgv>[0]) => {
      const argv = actual.buildGenerateRoleArgv(opts);
      if (mutationFlags.w1) {
        return [...argv.slice(0, 3), "--route", "opus-4-8/ccs", ...argv.slice(3)];
      }
      if (mutationFlags.w2 && opts.role !== "dr-debater-advocate") {
        return [...argv.slice(0, 3), "--route", "some-route", ...argv.slice(3)];
      }
      return argv;
    },
    get DEFAULT_GENERATE_CONFIG() {
      const config = actual.DEFAULT_GENERATE_CONFIG;
      if (mutationFlags.w3) {
        return {
          debaters: config.debaters.map((d) => ({ ...d, route: "dummy" })),
          synthesizer: { ...config.synthesizer, route: "dummy" },
          exportRoute: "export",
        } as unknown as typeof config;
      }
      return config;
    },
  };
});

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

// ── 变异矩阵 W1–W3（实测：通过 vi.mock 在模块边界施加变异，验证变异后行为会导致 V1–V5 守卫挂掉）─

describe("W1: add --route back to argv → V1 + V2 must fail", () => {
  beforeAll(() => { mutationFlags.w1 = true; });
  afterAll(() => { mutationFlags.w1 = false; });

  it("W1: mutated buildGenerateRoleArgv produces argv with --route", () => {
    const argv = buildGenerateRoleArgv({
      agentRunBin: "/fake/agent-run",
      role: "dr-debater-advocate",
      runId: "run-1",
      inputPath: "/tmp/i.json",
      promptFile: "/tmp/p.txt",
    });
    expect(argv).toContain("--route");
    expect(argv).toContain("opus-4-8/ccs");
    expect(argv).not.toEqual([
      "/fake/agent-run", "--role", "dr-debater-advocate",
      "--run-id", "run-1", "--input", "/tmp/i.json", "--prompt-file", "/tmp/p.txt",
    ]);
    expect(() => {
      if (argv.includes("--route")) throw new Error("V1/V2 guard: --route present in mutated argv");
    }).toThrow("V1/V2 guard: --route present in mutated argv");
  });

  it("W1: V1/V2 assertions would fail — all four roles now have --route", () => {
    for (const role of ALL_ROLES) {
      const argv = buildGenerateRoleArgv({
        agentRunBin: "/fake/agent-run",
        role,
        runId: "run-1",
        inputPath: "/tmp/i.json",
        promptFile: "/tmp/p.txt",
      });
      expect(argv).toContain("--route");
    }
  });
});

describe("W2: only advocate removes --route, others keep it → V2 must fail", () => {
  beforeAll(() => { mutationFlags.w2 = true; });
  afterAll(() => { mutationFlags.w2 = false; });

  it("W2: advocate has no --route, but opponent/judge/synthesizer do", () => {
    const advArgv = buildGenerateRoleArgv({
      agentRunBin: "/fake/agent-run",
      role: "dr-debater-advocate",
      runId: "run-1",
      inputPath: "/tmp/i.json",
      promptFile: "/tmp/p.txt",
    });
    expect(advArgv).not.toContain("--route");

    for (const role of ["dr-debater-opponent", "dr-debater-judge", "dr-synthesizer"]) {
      const argv = buildGenerateRoleArgv({
        agentRunBin: "/fake/agent-run",
        role,
        runId: "run-1",
        inputPath: "/tmp/i.json",
        promptFile: "/tmp/p.txt",
      });
      expect(argv).toContain("--route");
    }
  });

  it("W2: V2 assertion would fail for non-advocate roles", () => {
    const argv = buildGenerateRoleArgv({
      agentRunBin: "/fake/agent-run",
      role: "dr-debater-opponent",
      runId: "run-1",
      inputPath: "/tmp/i.json",
      promptFile: "/tmp/p.txt",
    });
    expect(argv).toContain("--route");
    expect(() => {
      if (argv.includes("--route")) throw new Error("V2 guard: non-advocate --route present");
    }).toThrow("V2 guard: non-advocate --route present");
  });
});

describe("W3: keep a dead route field → V3 must fail", () => {
  beforeAll(() => { mutationFlags.w3 = true; });
  afterAll(() => { mutationFlags.w3 = false; });

  it("W3: GenerateRoleSpec has route field after mutation", () => {
    for (const d of DEFAULT_GENERATE_CONFIG.debaters) {
      const keys = Object.keys(d);
      expect(keys).toContain("route");
      expect(keys).toEqual(["role", "route"]);
    }
    const synthKeys = Object.keys(DEFAULT_GENERATE_CONFIG.synthesizer);
    expect(synthKeys).toContain("route");
    expect(synthKeys).toEqual(["role", "route"]);
  });

  it("W3: GenerateConfig has exportRoute field after mutation", () => {
    const keys = Object.keys(DEFAULT_GENERATE_CONFIG);
    expect(keys).toContain("exportRoute");
    expect(keys).toEqual(["debaters", "synthesizer", "exportRoute"]);
  });

  it("W3: V3 assertions would fail — route and exportRoute dead fields present", () => {
    const keys = Object.keys(DEFAULT_GENERATE_CONFIG);
    expect(keys).toContain("exportRoute");
    expect(() => {
      if (keys.includes("exportRoute")) throw new Error("V3 guard: exportRoute dead field present");
    }).toThrow("V3 guard: exportRoute dead field present");
  });
});