import { describe, it, expect } from "vitest";
import { isValidTransition, CLUE_TRANSITIONS } from "../src/protocol";
import type { ClueV2, EvidenceV2, DocV2 } from "../src/protocol";

describe("protocol types", () => {
  it("valid clue payload", () => {
    const clue: ClueV2 = {
      text: "loop-mcp 的调度语义",
      status: "open",
      depth: 0,
      sources: ["code-local"],
    };
    expect(clue.status).toBe("open");
    expect(clue.depth).toBe(0);
  });

  it("evidence requires all four fields", () => {
    const ev: EvidenceV2 = {
      clue_id: "msg_001",
      anchor: "code://agent-bus@abc123:agent_bus/db.py#L422",
      quote: "if existing and existing['schema_digest'] != schema_digest: raise ProtocolConflict",
      claim: "协议注册即终身冻结",
    };
    expect(ev.clue_id).toBeTruthy();
    expect(ev.anchor).toContain("://");
    expect(ev.quote).toBeTruthy();
    expect(ev.claim).toBeTruthy();
  });

  it("doc kind must be valid", () => {
    const doc: DocV2 = {
      doc_kind: "report",
      digest: "test_report_v1",
      body: "# Test",
      origin: "research:test",
    };
    expect(["transcript", "report", "argument"]).toContain(doc.doc_kind);
  });
});

describe("clue state machine", () => {
  it("open → in_flight is valid", () => {
    expect(isValidTransition("open", "in_flight")).toBe(true);
  });

  it("in_flight → explored is valid", () => {
    expect(isValidTransition("in_flight", "explored")).toBe(true);
  });

  it("in_flight → open is valid (retry)", () => {
    expect(isValidTransition("in_flight", "open")).toBe(true);
  });

  it("explored → anything is invalid (terminal)", () => {
    expect(isValidTransition("explored", "open")).toBe(false);
    expect(isValidTransition("explored", "in_flight")).toBe(false);
  });

  it("proposed → open is valid", () => {
    expect(isValidTransition("proposed", "open")).toBe(true);
  });

  it("proposed → dropped is valid", () => {
    expect(isValidTransition("proposed", "dropped")).toBe(true);
  });

  it("blocked → anything is invalid (terminal)", () => {
    for (const to of CLUE_TRANSITIONS["open"]) {
      expect(isValidTransition("blocked", to)).toBe(false);
    }
  });

  it("open → explored is NOT valid (must go through in_flight)", () => {
    expect(isValidTransition("open", "explored")).toBe(false);
  });
});