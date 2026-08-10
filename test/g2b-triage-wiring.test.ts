/**
 * G2b —— triage 接线硬验收（spec §3 T1–T7 + §4 变异矩阵 N1–N3）。
 *
 * 每个 describe 对应一个判据 ID，不跨判据枚举（spec §5.1 第 2 条）。
 * T1/T7 走**生产默认 spawnTriage 路径**（注入 triageSpawnRuntime、不注入 spawnTriage），
 * 从而让 `spawnTriageRole → buildTriageArgv → spawnProcess` 真跑（T7：读代码到行号）。
 */
import { describe, it, expect, vi } from "vitest";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Decision } from "../src/tick";
import {
  runWrite,
  spawnTriageRole,
  buildTriageArgv,
  TRIAGE_ROLE,
  TRIAGE_ACTIONS,
  InvalidTriageActionError,
  OutOfScopeTriageClueError,
  MissingTriageQuestionError,
} from "../src/tick-run";
import type {
  WriteDeps,
  WriteCasInput,
  TriageCorpus,
  TriageSpawnRuntime,
} from "../src/tick-run";
import type { TriageResultDecision } from "../src/tick-inspect";

const ROOT = dirname(fileURLToPath(import.meta.url));

/** 构造一个 triage 决策（G2b 起带 proposedClues / exploredSummaries）。 */
function triageDecision(
  proposed: Array<{ clueId: string; clueText: string; depth?: number; sources?: string[] }> = [
    { clueId: "c1", clueText: "clue one text", depth: 1, sources: ["wiki"] },
    { clueId: "c2", clueText: "clue two text" },
  ],
  explored: string[] = ["explored summary one"],
): Decision {
  return { kind: "triage", proposedClues: proposed, exploredSummaries: explored };
}

/** 空 WriteDeps 骨架，测试按需覆写（triage 分支用到 readQuestion / spawnTriage）。 */
function baseDeps(over: Partial<WriteDeps> = {}): WriteDeps {
  return {
    cas: vi.fn(async (input: WriteCasInput) => ({ success: true })),
    spawnWorker: vi.fn(async () => {}),
    readQuestion: async () => "research question?",
    ...over,
  };
}

// ── agent-runtime triage-input.v1.json 的可用性解析（env + 回退 + 守卫，不硬编码主机路径）──

function resolveAgentRuntimeProfiles(): string | null {
  const fromEnv = process.env.AGENT_RUNTIME_PROFILES;
  if (fromEnv) return fromEnv;
  const fallback = "/data/code/self/agent-runtime/profiles";
  return existsSync(fallback) ? fallback : null;
}

const agentRuntimeAvailable = resolveAgentRuntimeProfiles() !== null;

function readTriageInputSchema(): unknown {
  const root = resolveAgentRuntimeProfiles();
  if (!root) throw new Error("agent-runtime profiles unavailable");
  const p = join(root, "roles", "schemas", "triage-input.v1.json");
  if (!existsSync(p)) throw new Error(`missing agent-runtime schema file: ${p}`);
  return JSON.parse(readFileSync(p, "utf-8")) as unknown;
}

/** 极简 JSON-Schema 校验器：覆盖 triage-input.v1.json 用到的子集（type/required/properties/additionalProperties/items）。 */
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
  }
  return errors;
}

// ── T1：位置参数承载板面快照（只断言 --input 不算数）────────────────────────

describe("T1: production triage dispatch puts the board snapshot via --prompt-file", () => {
  it("runWrite production default spawnTriage records argv; --prompt-file present, no positional corpus", async () => {
    const recorded: string[][] = [];
    let capturedPromptContent = "";
    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "run-triage-1",
      writeInputFile: () => "/tmp/g2b-input.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        const pfIdx = argv.indexOf("--prompt-file");
        capturedPromptContent = readFileSync(argv[pfIdx + 1], "utf8");
        return {};
      },
      readResult: async () => [],
    };
    const deps = baseDeps({ triageSpawnRuntime: runtime });
    await runWrite(deps, [triageDecision()], 10);

    expect(recorded).toHaveLength(1);
    const argv = recorded[0];
    expect(argv).toContain("--role");
    expect(argv[argv.indexOf("--role") + 1]).toBe(TRIAGE_ROLE);
    expect(argv).toContain("--input");
    expect(argv[argv.indexOf("--input") + 1]).toBe("/tmp/g2b-input.json");
    expect(argv).toContain("--prompt-file");
    expect(capturedPromptContent).toContain("clue one text");
    expect(capturedPromptContent).toContain("clue two text");
    // ⛔ 语料不在位置参数中：无 `--` 分隔符
    expect(argv.indexOf("--")).toBe(-1);
  });

  it("buildTriageArgv uses --prompt-file (unit, discriminant)", () => {
    const argv = buildTriageArgv({
      agentRunBin: "/fake/agent-run",
      runId: "r",
      inputPath: "/tmp/i.json",
      promptFile: "/tmp/prompt.txt",
    });
    expect(argv.indexOf("--prompt-file")).toBeGreaterThan(-1);
    expect(argv[argv.indexOf("--prompt-file") + 1]).toBe("/tmp/prompt.txt");
    expect(argv.indexOf("--")).toBe(-1);
  });
});

// ── T2：跨仓契约断言（引擎组装的快照能过 triage-input.v1.json）────────────────

describe.skipIf(!agentRuntimeAvailable)(
  "T2: engine-assembled triage snapshot conforms to agent-runtime triage-input.v1.json",
  () => {
    it("the corpus assembled by runWrite passes the schema (question/proposed_clues required)", async () => {
      let captured: TriageCorpus | undefined;
      const deps = baseDeps({
        spawnTriage: vi.fn(async (corpus: TriageCorpus) => {
          captured = corpus;
          return { decisions: [], runId: "t2-test" };
        }),
      });
      await runWrite(deps, [triageDecision()], 10);
      expect(captured).toBeDefined();
      // 引擎组装的快照必须能通过 triage-input.v1.json（跨仓契约断言）。
      expect(validateSchema(captured!, readTriageInputSchema() as Record<string, unknown>)).toEqual([]);
    });

    it("a corpus missing required 'question'/'proposed_clues' is rejected by the schema (discriminant)", () => {
      const bad = { proposed_clues: [] } as unknown as TriageCorpus;
      const errs = validateSchema(bad, readTriageInputSchema() as Record<string, unknown>);
      expect(errs.some((e) => e.includes('missing required "question"'))).toBe(true);
    });
  },
);

// ── T3：keep ⇒ proposed→open；drop ⇒ proposed→dropped；rationale 落卡 ─────────

describe("T3: triage decisions CAS proposed→open / proposed→dropped with rationale", () => {
  it("keep→open and drop→dropped, each with rationale written onto the card", async () => {
    const captured: WriteCasInput[] = [];
    const deps = baseDeps({
      cas: vi.fn(async (input: WriteCasInput) => {
        captured.push(input);
        return { success: true };
      }),
      spawnTriage: vi.fn(async () => ({
        decisions: [
          { clue_id: "c1", action: "keep", rationale: "keep it" },
          { clue_id: "c2", action: "drop", rationale: "drop it" },
        ] as TriageResultDecision[],
        runId: "t3-test",
      })),
    });
    const result = await runWrite(deps, [triageDecision()], 10);

    expect(captured).toHaveLength(2);
    // keep ⇒ proposed→open
    const keep = captured.find((c) => c.clueId === "c1");
    expect(keep?.from).toBe("proposed");
    expect(keep?.to).toBe("open");
    expect(keep?.rationale).toBe("keep it");
    // drop ⇒ proposed→dropped
    const drop = captured.find((c) => c.clueId === "c2");
    expect(drop?.from).toBe("proposed");
    expect(drop?.to).toBe("dropped");
    expect(drop?.rationale).toBe("drop it");
    expect(result.triageReports[0].budgetSkipped).toBe(false);
    expect(result.triageReports[0].casCount).toBe(2);
  });
});

// ── T4：非法 action 被响亮拒绝（既不当 keep 也不当 drop）────────────────────

describe("T4: invalid action is rejected loudly, never treated as keep/drop", () => {
  it("action 'maybe' ⇒ InvalidTriageActionError thrown, zero CAS", async () => {
    const cas = vi.fn(async (input: WriteCasInput) => ({ success: true }));
    const deps = baseDeps({
      cas,
      spawnTriage: vi.fn(async () => ({
        decisions: [
          { clue_id: "c1", action: "maybe", rationale: "x" },
        ] as unknown as TriageResultDecision[],
        runId: "t4-test",
      })),
    });
    await expect(runWrite(deps, [triageDecision()], 10)).rejects.toBeInstanceOf(
      InvalidTriageActionError,
    );
    expect(cas).toHaveBeenCalledTimes(0);
  });

  it("TRIAGE_ACTIONS domain is exactly keep/drop", () => {
    expect(TRIAGE_ACTIONS).toEqual(["keep", "drop"]);
  });
});

// ── T5：越界 clue_id 被丢弃并响亮记录，且不改任何卡 ─────────────────────────

describe("T5: out-of-scope clue_id is discarded loudly and CASes nothing", () => {
  it("clue_id not in this round's proposed set ⇒ OutOfScopeTriageClueError, CAS count = 0", async () => {
    const cas = vi.fn(async (input: WriteCasInput) => ({ success: true }));
    const deps = baseDeps({
      cas,
      spawnTriage: vi.fn(async () => ({
        decisions: [
          { clue_id: "c1", action: "keep", rationale: "in scope" },
          { clue_id: "ghost", action: "keep", rationale: "not mine" },
        ] as TriageResultDecision[],
        runId: "t5-test",
      })),
    });
    await expect(runWrite(deps, [triageDecision()], 10)).rejects.toBeInstanceOf(
      OutOfScopeTriageClueError,
    );
    // ⛔ 查得到 ≠ 有权改：越界存在 ⇒ 整批零 CAS，绝不据此改一张不该动的卡。
    expect(cas).toHaveBeenCalledTimes(0);
  });
});

// ── T6：预算不足 ⇒ 整批跳过并响亮报告，不做半批 ────────────────────────────

describe("T6: insufficient write budget skips the whole batch loudly, no half batch", () => {
  it("budget sufficient ⇒ all CAS performed, budgetSkipped=false", async () => {
    const cas = vi.fn(async (input: WriteCasInput) => ({ success: true }));
    const deps = baseDeps({
      cas,
      spawnTriage: vi.fn(async () => ({
        decisions: [
          { clue_id: "c1", action: "keep", rationale: "r1" },
          { clue_id: "c2", action: "drop", rationale: "r2" },
          { clue_id: "c3", action: "keep", rationale: "r3" },
        ] as TriageResultDecision[],
        runId: "t6-sufficient",
      })),
    });
    const decision = triageDecision([
      { clueId: "c1", clueText: "a" },
      { clueId: "c2", clueText: "b" },
      { clueId: "c3", clueText: "c" },
    ]);
    const result = await runWrite(deps, [decision], 10);
    expect(cas).toHaveBeenCalledTimes(3);
    expect(result.triageReports[0].budgetSkipped).toBe(false);
    expect(result.triageReports[0].casCount).toBe(3);
  });

  it("budget insufficient ⇒ whole batch skipped (budgetSkipped=true), zero CAS, no half batch", async () => {
    const cas = vi.fn(async (input: WriteCasInput) => ({ success: true }));
    const deps = baseDeps({
      cas,
      spawnTriage: vi.fn(async () => ({
        decisions: [
          { clue_id: "c1", action: "keep", rationale: "r1" },
          { clue_id: "c2", action: "keep", rationale: "r2" },
          { clue_id: "c3", action: "keep", rationale: "r3" },
        ] as TriageResultDecision[],
        runId: "t6-insufficient",
      })),
    });
    const decision = triageDecision([
      { clueId: "c1", clueText: "a" },
      { clueId: "c2", clueText: "b" },
      { clueId: "c3", clueText: "c" },
    ]);
    // maxWrites=2 < 3 条 CAS ⇒ 整批跳过，绝不半批。
    const result = await runWrite(deps, [decision], 2);
    expect(cas).toHaveBeenCalledTimes(0);
    expect(result.triageReports[0].budgetSkipped).toBe(true);
    expect(result.triageReports[0].casCount).toBe(0);
  });
});

// ── T7：spawn 必填且无条件调用；临时载荷文件在 finally 清理 ─────────────────

describe("T7: spawn is required & unconditionally called; temp file cleaned in finally", () => {
  it("production spawnTriage calls spawnProcess exactly once (never a silent zero-spawn)", async () => {
    const recorded: string[][] = [];
    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "r",
      writeInputFile: () => "/tmp/i.json",
      spawnProcess: async (argv) => {
        recorded.push(argv);
        return {};
      },
      readResult: async () => [],
    };
    const deps = baseDeps({ triageSpawnRuntime: runtime });
    await runWrite(deps, [triageDecision()], 10);
    expect(recorded).toHaveLength(1);
  });

  it("missing spawnTriage AND triageSpawnRuntime with a triage decision ⇒ loud failure, not a silent skip", async () => {
    // 不注入 spawnTriage / triageSpawnRuntime（但仍给 readQuestion，确保错误点名 spawn 依赖）。
    const deps = baseDeps({});
    await expect(runWrite(deps, [triageDecision()], 10)).rejects.toThrow(/spawnTriage has no default/);
  });

  it("missing readQuestion with a triage decision ⇒ loud failure (no empty-question dispatch)", async () => {
    const deps: WriteDeps = {
      cas: vi.fn(async () => ({ success: true })),
      spawnWorker: vi.fn(async () => {}),
      spawnTriage: vi.fn(async () => ({ decisions: [], runId: "t7-test" })),
      // ⛔ 不提供 readQuestion
    };
    await expect(runWrite(deps, [triageDecision()], 10)).rejects.toBeInstanceOf(
      MissingTriageQuestionError,
    );
  });

  it("spawnTriageRole removes the temp input file in finally (even when readResult throws)", async () => {
    const filePath = join(tmpdir(), `g2b-cleanup-${Date.now()}-${Math.random()}.json`);
    const runtime: TriageSpawnRuntime = {
      agentRunBin: "/fake/agent-run",
      runId: "r",
      writeInputFile: () => {
        writeFileSync(filePath, "{}");
        return filePath;
      },
      spawnProcess: async () => {
        expect(existsSync(filePath)).toBe(true);
        return {};
      },
      readResult: async () => {
        throw new Error("boom");
      },
    };
    await expect(
      spawnTriageRole({ question: "q", proposed_clues: [] }, runtime),
    ).rejects.toThrow("boom");
    // ⛔ 载荷文件在 finally 里清理，绝不泄漏 tmp（§1.3）。
    expect(existsSync(filePath)).toBe(false);
    rmSync(filePath, { force: true });
  });
});
