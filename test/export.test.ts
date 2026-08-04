import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  deriveExportPath,
  renderExportContent,
  runExport,
} from "../src/export";
import type { ExportDeps, ExportInput } from "../src/export";
import type { DocV2 } from "../src/protocol";
import { renderReportBody } from "../src/generate";

function report(body: string): DocV2 {
  return { doc_kind: "report", digest: "rep-1", body, origin: "research-1" };
}

function input(over: Partial<ExportInput> = {}): ExportInput {
  return {
    report: report(
      renderReportBody({ stop: "capped", blocked: 12, capHit: true }),
    ),
    sourceMessageId: "msg_report_1",
    createdAt: "2026-03-15T10:00:00Z",
    topic: "光伏并网 谐波治理",
    ...over,
  };
}

describe("N3 path derivation is pure (F1)", () => {
  it("given literal doc + vaultRoot + createdAt, returns a path string without stubs", () => {
    const path = deriveExportPath(input(), "/tmp/vault");
    expect(typeof path).toBe("string");
    expect(path).toContain("2026-03-15");
    expect(path).toContain("光伏并网-谐波治理");
    expect(path.endsWith(".md")).toBe(true);
  });
});

describe("N3 content derivation is pure (F2)", () => {
  it("given literal doc + messageId, returns a content string without stubs", () => {
    const content = renderExportContent(input());
    expect(typeof content).toBe("string");
    expect(content).toContain("# 光伏并网 谐波治理");
  });
});

describe("N3 export is idempotent (F3)", () => {
  it("same input renders byte-identical path and content", () => {
    const i = input();
    const root = "/tmp/vault";
    expect(deriveExportPath(i, root)).toBe(deriveExportPath(i, root));
    expect(renderExportContent(i)).toBe(renderExportContent(i));
  });
});

describe("N3 no clock/random in source (F4)", () => {
  it("src/export.ts has no Date / Date.now / Math.random and no ./bus import", () => {
    const srcPath = fileURLToPath(new URL("../src/export.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).not.toMatch(/\bDate\b/);
    expect(source).not.toMatch(/Date\.now/);
    expect(source).not.toMatch(/Math\.random/);
    expect(source).not.toMatch(/from\s+["']\.\/bus["']/);
  });
});

describe("N3 header carries source_message_id (F5)", () => {
  it("content contains the given message_id", () => {
    const content = renderExportContent(input({ sourceMessageId: "msg_report_1" }));
    expect(content).toContain("msg_report_1");
  });
});

describe("N3 header carries terminal marker verbatim (F6)", () => {
  it("all three marker values from the report body head appear in the export header", () => {
    const body = renderReportBody({ stop: "capped", blocked: 12, capHit: true });
    const content = renderExportContent(input({ report: report(body) }));
    expect(content).toContain("stop=capped");
    expect(content).toContain("blocked=12");
    expect(content).toContain("capHit=true");
  });
});

describe("N3 reuses parseReportMarker (F7)", () => {
  it("src/export.ts imports parseReportMarker and declares no new dr-terminal regex", () => {
    const srcPath = fileURLToPath(new URL("../src/export.ts", import.meta.url));
    const source = readFileSync(srcPath, "utf-8");
    expect(source).toMatch(/parseReportMarker/);
    expect(source).not.toMatch(/dr-terminal/);
  });
});

describe("N3 header carries read-only declaration (F8)", () => {
  it("content states it is a render and asks not to edit directly", () => {
    const content = renderExportContent(input());
    expect(content).toContain("渲染");
    expect(content).toContain("勿直接编辑");
  });
});

describe("N3 location under vaultRoot/研究报告 (F9)", () => {
  it("path starts with the vaultRoot/研究报告 prefix", () => {
    const root = "/tmp/vault";
    expect(deriveExportPath(input(), root)).toMatch(new RegExp(`^${root}/研究报告/`));
  });
});

describe("N3 vaultRoot not hardcoded (F10)", () => {
  it("two different vaultRoots yield two different paths", () => {
    const a = deriveExportPath(input(), "/tmp/vault-a");
    const b = deriveExportPath(input(), "/tmp/vault-b");
    expect(a).not.toBe(b);
    expect(a).toContain("/tmp/vault-a");
    expect(b).toContain("/tmp/vault-b");
  });
});

describe("N3 not under docs/ or Zettelkasten/ (F11)", () => {
  it("path does not contain docs/ or Zettelkasten/", () => {
    const path = deriveExportPath(input(), "/tmp/vault");
    expect(path).not.toContain("docs/");
    expect(path).not.toContain("Zettelkasten/");
  });
});

describe("N3 execution shell writes the file (F12)", () => {
  it("writeFile is called exactly once with the derived path and rendered content", async () => {
    const root = "/tmp/vault";
    const i = input();
    const writeFile = vi.fn(async () => {});
    const deps: ExportDeps = { writeFile };
    const path = await runExport(deps, i, root);
    expect(writeFile).toHaveBeenCalledTimes(1);
    expect(writeFile).toHaveBeenCalledWith(
      deriveExportPath(i, root),
      renderExportContent(i),
    );
    expect(path).toBe(deriveExportPath(i, root));
  });
});

describe("N3 write failure is loud (F13)", () => {
  it("a write error propagates instead of being swallowed", async () => {
    const writeFile = vi.fn(async () => {
      throw new Error("disk full");
    });
    const deps: ExportDeps = { writeFile };
    await expect(runExport(deps, input(), "/tmp/vault")).rejects.toThrow(
      /disk full/,
    );
  });
});
