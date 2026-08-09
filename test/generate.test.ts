import { describe, it, expect, vi } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";
import {
  runGenerate,
  decideGenerate,
  buildReportMarker,
  renderReportBody,
  parseReportMarker,
  renderReportHead,
  deriveDocKind,
  computeDocDigest,
  assertDocBodyWithinLimit,
  buildDoc,
  serializeCorpusToPositional,
  spawnGenerateRole,
  assertDistinctDebaterRoutes,
  MAX_DOC_BODY_BYTES,
  DEFAULT_GENERATE_CONFIG,
} from "../src/generate";
import type {
  GenerateConfig,
  GenerateDeps,
  GenerateSpawnRuntime,
  ReportMarker,
  DebaterCorpus,
  SynthesizerCorpus,
} from "../src/generate";
import type { DocV2 } from "../src/protocol";
import type { TerminationState } from "../src/tick";

const cfg: GenerateConfig = DEFAULT_GENERATE_CONFIG;

const DEBATER_ROLES = new Set([
  "dr-debater-advocate",
  "dr-debater-opponent",
  "dr-debater-judge",
]);

/**
 * agent-runtime（前置合入 commit efa7579）的 profiles 根目录；测试读真实 role/route 值（spec §2.1）。
 * ⛔ 不硬编码绝对主机路径：优先取 `AGENT_RUNTIME_PROFILES` 环境变量；未设时回退到常见宿主路径。
 * 若该目录不存在（非本仓环境 / CI 无此路径），相关用例**优雅跳过**而非整条 suite 变红（评审 minor）。
 */
function resolveAgentRuntimeProfiles(): string | null {
  const fromEnv = process.env.AGENT_RUNTIME_PROFILES;
  if (fromEnv) return fromEnv;
  const fallback = "/data/code/self/agent-runtime/profiles";
  return existsSync(fallback) ? fallback : null;
}

const AGENT_RUNTIME_PROFILES = resolveAgentRuntimeProfiles();
const agentRuntimeAvailable = AGENT_RUNTIME_PROFILES !== null;

/** 从 agent-runtime profiles/roles/<role>.yaml 读出该 role 的 route（spec §2.1：别照本文猜）。 */
function agentRoleRoute(role: string): string {
  const root = resolveAgentRuntimeProfiles();
  if (!root) throw new Error("agent-runtime profiles unavailable");
  const p = join(root, "roles", `${role}.yaml`);
  if (!existsSync(p)) throw new Error(`missing agent-runtime role file: ${p}`);
  const doc = parse(readFileSync(p, "utf-8")) as { route?: string };
  if (!doc.route) throw new Error(`role file ${p} has no route`);
  return doc.route;
}

/** 从 agent-runtime 读某输入 schema（debater / synthesizer）。 */
function readRoleInputSchema(name: "debater" | "synthesizer"): unknown {
  const root = resolveAgentRuntimeProfiles();
  if (!root) throw new Error("agent-runtime profiles unavailable");
  const p = join(root, "roles", "schemas", `${name}-input.v1.json`);
  if (!existsSync(p)) throw new Error(`missing agent-runtime schema file: ${p}`);
  return JSON.parse(readFileSync(p, "utf-8")) as unknown;
}

function debaterSpawns(deps: GenerateDeps): unknown[][] {
  const spawnRole = deps.spawnRole as ReturnType<typeof vi.fn>;
  return spawnRole.mock.calls.filter((c) => DEBATER_ROLES.has(c[0] as string));
}

function synthSpawns(deps: GenerateDeps): unknown[][] {
  const spawnRole = deps.spawnRole as ReturnType<typeof vi.fn>;
  return spawnRole.mock.calls.filter((c) => c[0] === "dr-synthesizer");
}

function term(over: Partial<TerminationState> = {}): TerminationState {
  return {
    state: "converged",
    coverage: 0,
    zeroGrowthRounds: 0,
    capHit: false,
    ...over,
  };
}

/** 立即完成的空 deps 骨架，测试按需覆写。 */
function baseDeps(over: Partial<GenerateDeps> = {}): GenerateDeps {
  return {
    readTermination: async () => term(),
    countBlocked: async () => 0,
    readQuestion: async () => "research question?",
    readOrigin: async () => "research-1",
    readEvidences: async () => [],
    spawnRole: vi.fn(async () => ({ body: "role output" })),
    spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: 100 })),
    spawnExport: vi.fn(async () => {}),
    writeDoc: vi.fn(async () => {}),
    lockSynthesizer: async () => async () => {},
    ...over,
  };
}

describe("S4 gate (D1/D2/D3)", () => {
  it("D1: state===null does not start the generation phase (no spawns at all)", async () => {
    const deps = baseDeps({ readTermination: async () => term({ state: null }) });
    expect(decideGenerate(term({ state: null }))).toBe(false);
    await runGenerate(deps, cfg);
    expect(deps.spawnRole).toHaveBeenCalledTimes(0);
    expect(deps.spawnAnchorCheck).toHaveBeenCalledTimes(0);
    expect(deps.spawnExport).toHaveBeenCalledTimes(0);
    expect(deps.writeDoc).toHaveBeenCalledTimes(0);
  });

  it("D2: capHit=true but state===null (draining) does not start generation", async () => {
    const deps = baseDeps({
      readTermination: async () => term({ state: null, capHit: true }),
    });
    expect(decideGenerate(term({ state: null, capHit: true }))).toBe(false);
    await runGenerate(deps, cfg);
    expect(deps.spawnRole).toHaveBeenCalledTimes(0);
    expect(deps.spawnExport).toHaveBeenCalledTimes(0);
  });

  it("D3: every non-empty terminal state starts the generation phase", async () => {
    for (const state of ["converged", "capped", "partial"] as const) {
      const deps = baseDeps({ readTermination: async () => term({ state }) });
      await runGenerate(deps, cfg);
      expect(deps.spawnRole).toHaveBeenCalledTimes(4);
      expect(deps.spawnExport).toHaveBeenCalledTimes(1);
    }
  });
});

describe("S4 debaters (D4/D5/D16)", () => {
  it("D4: exactly 3 debaters are spawned (advocate/opponent/judge) plus the synthesizer", async () => {
    const deps = baseDeps();
    await runGenerate(deps, cfg);
    expect(debaterSpawns(deps)).toHaveLength(3);
    expect(synthSpawns(deps)).toHaveLength(1);
  });

  it("D5: the three debater routes are mutually distinct (dedup size === 3)", async () => {
    const routes: string[] = [];
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string, route: string) => {
        if (DEBATER_ROLES.has(role)) routes.push(route);
        return { body: "out" };
      }),
    });
    await runGenerate(deps, cfg);
    expect(routes).toHaveLength(3);
    expect(new Set(routes).size).toBe(3);
  });

  it("D5/Q2: a caller-supplied config with duplicate debater routes is rejected (not silently accepted)", async () => {
    const bad: GenerateConfig = {
      ...cfg,
      debaters: [
        { role: "dr-debater-advocate", route: "a" },
        { role: "dr-debater-opponent", route: "a" },
        { role: "dr-debater-judge", route: "c" },
      ],
    };
    expect(() => assertDistinctDebaterRoutes(bad)).toThrow(/mutually distinct/);
    await expect(runGenerate(baseDeps(), bad)).rejects.toThrow(/mutually distinct/);
  });

  it("D16: route combination is not hardcoded — custom three routes are the ones used", async () => {
    const routes: string[] = [];
    const custom: GenerateConfig = {
      ...cfg,
      debaters: [
        { role: "dr-debater-advocate", route: "custom.one" },
        { role: "dr-debater-opponent", route: "custom.two" },
        { role: "dr-debater-judge", route: "custom.three" },
      ],
    };
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string, route: string) => {
        if (role !== "dr-synthesizer") routes.push(route);
        return { body: "out" };
      }),
    });
    await runGenerate(deps, custom);
    expect(routes).toEqual(["custom.one", "custom.two", "custom.three"]);
  });
});

describe("S4 ordering (D7/D8)", () => {
  it("D7: all 3 debaters complete before the synthesizer (shared call sequence)", async () => {
    const seq: string[] = [];
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string) => {
        seq.push(role);
        return { body: "out" };
      }),
    });
    await runGenerate(deps, cfg);
    const synIdx = seq.indexOf("dr-synthesizer");
    expect(seq.filter((r) => DEBATER_ROLES.has(r))).toHaveLength(3);
    for (const r of DEBATER_ROLES) {
      expect(seq.indexOf(r)).toBeLessThan(synIdx);
    }
  });

  it("D8: synthesizer → anchor-check → export are strictly ordered (shared sequence)", async () => {
    const seq: string[] = [];
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string) => {
        seq.push(role);
        return { body: "out" };
      }),
      spawnAnchorCheck: vi.fn(async () => {
        seq.push("anchor-check");
        return { defects: 0, verificationRate: 100 };
      }),
      spawnExport: vi.fn(async () => {
        seq.push("export");
      }),
    });
    await runGenerate(deps, cfg);
    const synIdx = seq.indexOf("dr-synthesizer");
    const anchorIdx = seq.indexOf("anchor-check");
    const exportIdx = seq.indexOf("export");
    expect(synIdx).toBeGreaterThanOrEqual(0);
    expect(synIdx).toBeLessThan(anchorIdx);
    expect(anchorIdx).toBeLessThan(exportIdx);
  });
});

describe("S4 singleton synthesizer lock (D6/serial)", () => {
  it("D6: while one synthesizer is pending, the lock serializes — no second synthesizer spawn; synthesizer is never skipped", async () => {
    let locked = false;
    let waiters: Array<() => void> = [];
    let resolveSynth!: () => void;
    const gate = new Promise<void>((r) => {
      resolveSynth = r;
    });
    const spawnRole = vi.fn(async (role: string) => {
      if (role === "dr-synthesizer") {
        await gate;
      }
      return { body: "out" };
    });
    const lockSynth = vi.fn(async () => {
      if (locked) {
        // 串行化：等待锁释放（wait-then-run），绝不跳过 synthesizer。
        await new Promise<void>((r) => waiters.push(r));
      }
      locked = true;
      let released = false;
      return async () => {
        if (released) return;
        released = true;
        locked = false;
        const w = waiters;
        waiters = [];
        w.forEach((r) => r());
      };
    });
    const deps = baseDeps({
      spawnRole,
      lockSynthesizer: lockSynth,
    });

    const first = runGenerate(deps, cfg);
    // 等第一次调用真正发起 synthesizer spawn（此刻 lock 已被持有且挂起）。
    await vi.waitFor(() => expect(synthSpawns(deps)).toHaveLength(1));

    // 挂起期间驱动第二次编排：拿不到锁必须等待，不得发起第二次 synthesizer spawn。
    const second = runGenerate(deps, cfg);
    await new Promise((r) => setTimeout(r, 20));
    expect(synthSpawns(deps)).toHaveLength(1);

    // 释放第一次后，第二次串行拿到锁并补跑 synthesizer（不跳过阶段）。
    resolveSynth();
    await first;
    await second;
    expect(synthSpawns(deps)).toHaveLength(2);
  });

  it("D4: the synthesizer is never skipped — a normal run always spawns it exactly once", async () => {
    const deps = baseDeps();
    await runGenerate(deps, cfg);
    expect(synthSpawns(deps)).toHaveLength(1);
  });
});

describe("S4 anchor-check never blocks export (D9/D10)", () => {
  it("D9: anchor-check throwing an exception does not block export", async () => {
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        throw new Error("anchor-check boom");
      }),
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, cfg);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });

  it("D10: anchor-check reporting defects (non-exception) does not block export", async () => {
    const deps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => ({ defects: 5, verificationRate: 100 })),
      spawnExport: vi.fn(async () => {}),
    });
    await runGenerate(deps, cfg);
    expect(deps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

describe("G2a D1: corpus reaches the role prompt via POSITIONAL args (production entry + fake agent-run)", () => {
  it("D1: spawnGenerateRole (production entry) places serialized evidence text in the positional args of the recorded argv", async () => {
    const recorded: string[][] = [];
    const corpus: DebaterCorpus = {
      question: "research question?",
      evidences: [
        {
          clue_id: "c1",
          anchor: "code://repo@abc123:src/foo.ts#L42",
          quote: "exact quoted text",
          claim: "one-sentence claim",
        },
      ],
    };
    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-1",
      writeInputFile: () => "/tmp/payload.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
      readBody: async () => "out",
    };
    await spawnGenerateRole("dr-debater-advocate", "opus-4-8/ccs", corpus, runtime);

    expect(recorded).toHaveLength(1);
    const argv = recorded[0];
    const dd = argv.indexOf("--");
    expect(dd).toBeGreaterThanOrEqual(0);
    const positional = argv.slice(dd + 1).join(" ");
    // ⛔ 断言序列化后的证据文本出现在【位置参数】中；只断言 `--input` 存在不算数。
    expect(positional).toContain("code://repo@abc123:src/foo.ts#L42");
    expect(positional).toContain("exact quoted text");
    expect(positional).toContain("research question?");
    // `--input` 只作 schema 守卫，指向载荷文件（内容不得只靠它注入 prompt）。
    expect(argv[argv.indexOf("--input") + 1]).toBe("/tmp/payload.json");
  });

  it("D1: runGenerate's default spawnRole turns readEvidences corpus into argv, anchor in positional", async () => {
    const evidences = [
      {
        clue_id: "c1",
        anchor: "code://repo@abc123:src/foo.ts#L42",
        quote: "exact quoted text",
        claim: "one-sentence claim",
      },
    ];
    const recorded: string[][] = [];
    const runtime: GenerateSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-1",
      writeInputFile: () => "/tmp/payload.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
      readBody: async () => "out",
    };
    // ⛔ 不注入 spawnRole —— runGenerate 走生产默认 spawnGenerateRole（语料→argv→spawn）。
    const deps = baseDeps({
      readEvidences: async () => evidences,
      spawnRole: undefined,
      spawnRuntime: runtime,
    });
    await runGenerate(deps, cfg);

    const advArgv = recorded.find((a) => a.includes("dr-debater-advocate"));
    expect(advArgv).toBeDefined();
    const dd = advArgv!.indexOf("--");
    const positional = advArgv!.slice(dd + 1).join(" ");
    expect(positional).toContain("code://repo@abc123:src/foo.ts#L42");
    expect(positional).toContain("exact quoted text");
    // 位置参数里带的语料就是序列化的 evidence（§1.1：只靠 --input 不算数）。
    expect(serializeCorpusToPositional({ question: "research question?", evidences })).toContain(
      "code://repo@abc123:src/foo.ts#L42",
    );
  });
});

describe("G2a D2: doc_kind is derived from role, never from payload", () => {
  it("D2: a DEBATER payload carrying doc_kind:'report' still yields research.doc.v2 doc_kind:'argument'", async () => {
    const written: DocV2[] = [];
    // 假 worker 返回的载荷里带一个 schema 拦不住的 stray `doc_kind: "report"`。
    const deps = baseDeps({
      spawnRole: vi.fn(async (role: string) => {
        if (role === "dr-debater-advocate") {
          return { body: "advocate argument", doc_kind: "report" } as { body: string };
        }
        return { body: "out" };
      }),
      writeDoc: vi.fn(async (doc: DocV2) => {
        written.push(doc);
      }),
    });
    await runGenerate(deps, cfg);
    const argumentDocs = written.filter((d) => d.doc_kind === "argument");
    const reportDocs = written.filter((d) => d.doc_kind === "report");
    // 三条 debater → argument；synthesizer → report。全部由 role 推出，与 payload 无关。
    expect(argumentDocs).toHaveLength(3);
    expect(reportDocs).toHaveLength(1);
    // 即便 debater 的载荷带了 doc_kind:'report'，引擎发出的仍是 argument。
    const advocateDoc = written.find((d) => d.body === "advocate argument");
    expect(advocateDoc?.doc_kind).toBe("argument");
  });

  it("D2: deriveDocKind is a pure role→kind mapping", () => {
    expect(deriveDocKind("dr-synthesizer")).toBe("report");
    expect(deriveDocKind("dr-debater-advocate")).toBe("argument");
    expect(deriveDocKind("dr-debater-opponent")).toBe("argument");
    expect(deriveDocKind("dr-debater-judge")).toBe("argument");
  });
});

describe.skipIf(!agentRuntimeAvailable)(
  "G2a D3: role/route wiring matches the real agent-runtime values",
  () => {
    it("D3: the four roles' role/route pairs equal the values read from agent-runtime role files (not guessed)", () => {
      // 每条 debater route 必须互不相同（spec §2.1 ⛔ / §2.1 表格）。
      const routes = cfg.debaters.map((d) => d.route);
      expect(routes).toHaveLength(3);
      expect(new Set(routes).size).toBe(3);

      // 从 agent-runtime profiles/roles/<role>.yaml 实际读出 route，逐一核对（spec §2.1：别照本文猜）。
      for (const d of cfg.debaters) {
        expect(agentRoleRoute(d.role)).toBe(d.route);
      }
      expect(agentRoleRoute(cfg.synthesizer.role)).toBe(cfg.synthesizer.route);
    });

    it("D3: every configured route exists in agent-runtime profiles/routes.yaml", () => {
      const root = resolveAgentRuntimeProfiles()!;
      const routesPath = join(root, "routes.yaml");
      const doc = parse(readFileSync(routesPath, "utf-8")) as { routes?: Record<string, unknown> };
      const known = new Set(Object.keys(doc.routes ?? {}));
      for (const r of [...cfg.debaters.map((d) => d.route), cfg.synthesizer.route]) {
        expect(known).toContain(r);
      }
    });
  },
);

describe.skipIf(!agentRuntimeAvailable)(
  "G2a corpus schema conformance (major finding)",
  () => {
    /** 极简 JSON-Schema 校验器：覆盖本仓语料 schema 用到的子集（type/required/properties/additionalProperties/items）。 */
    function validateSchema(value: unknown, schema: Record<string, unknown>, path = "$"): string[] {
      const errors: string[] = [];
      const type = schema.type as string | undefined;
      if (type === "object") {
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          errors.push(`${path}: expected object`);
          return errors;
        }
        const obj = value as Record<string, unknown>;
        for (const req of (schema.required as string[] | undefined) ?? []) {
          if (!(req in obj)) errors.push(`${path}: missing required "${req}"`);
        }
        const props = (schema.properties as Record<string, unknown> | undefined) ?? {};
        for (const [k, v] of Object.entries(obj)) {
          if (k in props) {
            errors.push(...validateSchema(v, props[k] as Record<string, unknown>, `${path}.${k}`));
          } else if (schema.additionalProperties === false) {
            errors.push(`${path}: unexpected property "${k}"`);
          }
        }
      } else if (type === "array") {
        if (!Array.isArray(value)) {
          errors.push(`${path}: expected array`);
          return errors;
        }
        const items = schema.items as Record<string, unknown> | undefined;
        if (items) {
          value.forEach((v, i) => errors.push(...validateSchema(v, items, `${path}[${i}]`)));
        }
      } else if (type === "string") {
        if (typeof value !== "string") errors.push(`${path}: expected string`);
      } else if (type === "integer") {
        if (typeof value !== "number" || !Number.isInteger(value)) errors.push(`${path}: expected integer`);
      } else if (type === "boolean") {
        if (typeof value !== "boolean") errors.push(`${path}: expected boolean`);
      }
      return errors;
    }

    it("debater corpus conforms to debater-input.v1.json (incl. judge prior_arguments)", () => {
      const schema = readRoleInputSchema("debater") as Record<string, unknown>;
      const evidences: DebaterCorpus["evidences"] = [
        { clue_id: "c1", anchor: "a1", quote: "q1", claim: "c1" },
      ];
      const advocate: DebaterCorpus = { question: "q?", evidences };
      expect(validateSchema(advocate, schema)).toEqual([]);
      const judge: DebaterCorpus = { question: "q?", evidences, prior_arguments: ["b1", "b2"] };
      expect(validateSchema(judge, schema)).toEqual([]);
    });

    it("synthesizer corpus conforms to synthesizer-input.v1.json (terminal_marker is an OBJECT)", () => {
      const schema = readRoleInputSchema("synthesizer") as Record<string, unknown>;
      const evidences: DebaterCorpus["evidences"] = [{ clue_id: "c1", anchor: "a1", quote: "q1", claim: "c1" }];
      // 引擎侧组装：terminal_marker = buildReportMarker 产出的结构化对象（不是渲染字符串）。
      const marker: ReportMarker = { stop: "converged", blocked: 0, capHit: false };
      const synth: SynthesizerCorpus = {
        question: "q?",
        evidences,
        arguments: ["b1", "b2"],
        terminal_marker: marker,
      };
      expect(validateSchema(synth, schema)).toEqual([]);

      // 判别性：若 terminal_marker 误传成渲染字符串（旧 bug），schema 校验必须报错。
      const buggy = { ...synth, terminal_marker: renderReportBody(marker) } as unknown as SynthesizerCorpus;
      const errs = validateSchema(buggy, schema);
      expect(errs.some((e) => e.includes("terminal_marker") && e.includes("expected object"))).toBe(true);
    });
  },
);

describe("G2a D5: 4MB body guard (both directions)", () => {
  it("D5: 4MB-1 and 4MB pass; 4MB+1 is rejected", () => {
    const oneLess = "a".repeat(MAX_DOC_BODY_BYTES - 1);
    const atLimit = "a".repeat(MAX_DOC_BODY_BYTES);
    const oneMore = "a".repeat(MAX_DOC_BODY_BYTES + 1);
    expect(() => assertDocBodyWithinLimit(oneLess)).not.toThrow();
    expect(() => assertDocBodyWithinLimit(atLimit)).not.toThrow();
    expect(() => assertDocBodyWithinLimit(oneMore)).toThrow(/exceeds/);
    expect(() => buildDoc("dr-synthesizer", { body: oneMore }, "r")).toThrow(/exceeds/);
  });
});

describe("G2a D6: report body head carries terminal marker + anchor-check rate (soft gate)", () => {
  it("D6: head contains BOTH terminal marker and anchor rate; <90% still exports with annotation", async () => {
    for (const rate of [50, 95]) {
      const written: DocV2[] = [];
      const deps = baseDeps({
        spawnAnchorCheck: vi.fn(async () => ({ defects: 0, verificationRate: rate })),
        writeDoc: vi.fn(async (doc: DocV2) => {
          written.push(doc);
        }),
        spawnExport: vi.fn(async () => {}),
      });
      await runGenerate(deps, cfg);
      const report = written.find((d) => d.doc_kind === "report");
      expect(report).toBeDefined();
      expect(report!.body).toMatch(/dr-terminal stop=converged/);
      expect(report!.body).toMatch(new RegExp(`dr-anchor-rate ${rate}`));
      // 软闸门：<90% 与 ≥90% 都照样导出。
      expect(deps.spawnExport).toHaveBeenCalledTimes(1);
    }
  });

  it("D6: renderReportHead emits the terminal line then the anchor-rate line", () => {
    const head = renderReportHead(
      { stop: "converged", blocked: 0, capHit: false },
      87,
    );
    expect(head).toMatch(/dr-terminal stop=converged blocked=0 capHit=false/);
    expect(head).toMatch(/dr-anchor-rate 87/);
    expect(parseReportMarker(head)).toEqual({
      stop: "converged",
      blocked: 0,
      capHit: false,
    });
  });

  it("D6: a genuine 0% rate renders as 0, but a crashed anchor-check renders 'unavailable' (distinguishable)", async () => {
    // 真实 0% 核验率 → 头部标 0。
    const genuine: DocV2[] = [];
    const okDeps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => ({ defects: 99, verificationRate: 0 })),
      writeDoc: vi.fn(async (doc: DocV2) => {
        genuine.push(doc);
      }),
    });
    await runGenerate(okDeps, cfg);
    expect(genuine.find((d) => d.doc_kind === "report")!.body).toContain("dr-anchor-rate 0");

    // anchor-check 崩溃 → 头部标 unavailable（评审 minor：不得伪装成 0%）。
    const crashed: DocV2[] = [];
    const crashDeps = baseDeps({
      spawnAnchorCheck: vi.fn(async () => {
        throw new Error("anchor-check boom");
      }),
      writeDoc: vi.fn(async (doc: DocV2) => {
        crashed.push(doc);
      }),
    });
    await runGenerate(crashDeps, cfg);
    expect(crashed.find((d) => d.doc_kind === "report")!.body).toContain(
      "dr-anchor-rate unavailable",
    );
    // 崩溃仍不阻断导出（D9）。
    expect(crashDeps.spawnExport).toHaveBeenCalledTimes(1);
  });
});

describe("S4 report header (D11/D12/D13/D14/D15)", () => {
  it("D11: header carries the stop reason (converged / capped)", () => {
    expect(renderReportBody({ stop: "converged", blocked: 0, capHit: false })).toContain(
      "stop=converged",
    );
    expect(renderReportBody({ stop: "capped", blocked: 2, capHit: true })).toContain(
      "stop=capped",
    );
  });

  it("D12: header carries the blocked count (blocked=12 parses to 12)", () => {
    const body = renderReportBody({ stop: "capped", blocked: 12, capHit: true });
    const marker = parseReportMarker(body);
    expect(marker?.blocked).toBe(12);
  });

  it("D13: header carries capHit", () => {
    const body = renderReportBody({ stop: "converged", blocked: 0, capHit: true });
    const marker = parseReportMarker(body);
    expect(marker?.capHit).toBe(true);
  });

  it("D14: a capped-with-blocked report header is distinguishable from a normal converged one", () => {
    const cappedBlocked = renderReportBody({ stop: "capped", blocked: 12, capHit: true });
    const converged = renderReportBody({ stop: "converged", blocked: 0, capHit: false });
    expect(cappedBlocked).not.toBe(converged);
  });

  it("D15: header is deterministically parseable — body → structured marker object", () => {
    const body = renderReportBody({ stop: "capped", blocked: 3, capHit: true });
    const marker = parseReportMarker(body);
    expect(marker).toEqual({ stop: "capped", blocked: 3, capHit: true } satisfies ReportMarker);

    // 散文/无标记 body → null
    expect(parseReportMarker("## 无结论")).toBeNull();
  });

  it("D15: parse is head-scoped — a marker embedded mid-document (not at body head) is NOT parsed", () => {
    const body = renderReportBody({ stop: "converged", blocked: 0, capHit: false });
    // 把标记嵌进正文中间（前面有散文），不得被当成头部标记解析出来。
    const midDocument = `prose intro\n${body}\nmore`;
    expect(parseReportMarker(midDocument)).toBeNull();
  });
});

describe("S4 pure decision + marker build (D17 helpers)", () => {
  it("buildReportMarker maps capped → capped, converged/partial → converged with blocked", () => {
    expect(buildReportMarker(term({ state: "capped", capHit: true }), 2)).toEqual({
      stop: "capped",
      blocked: 2,
      capHit: true,
    });
    expect(buildReportMarker(term({ state: "partial" }), 3)).toEqual({
      stop: "converged",
      blocked: 3,
      capHit: false,
    });
    expect(buildReportMarker(term({ state: "converged" }), 0)).toEqual({
      stop: "converged",
      blocked: 0,
      capHit: false,
    });
  });

  it("D17: the orchestration decision module is a pure function (no ./bus, no Date/fetch/Math.random)", () => {
    const srcPath = fileURLToPath(new URL("../src/generate.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).not.toMatch(/from\s+["']\.\/bus["']/);
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/fetch\s*\(/);
    expect(source).not.toMatch(/Math\.random/);
  });

  it("computeDocDigest is deterministic for a given body", () => {
    expect(computeDocDigest("hello")).toBe(computeDocDigest("hello"));
    expect(computeDocDigest("hello")).not.toBe(computeDocDigest("hellp"));
  });
});
