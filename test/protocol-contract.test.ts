import { describe, it, expect, afterAll } from "vitest";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadRegistrySnapshot,
  renderGeneratedProtocol,
  resolveProtocol,
  verifyConsumerContract,
  verifyRegistryRecord,
  verifyRegistrySnapshot,
  type ConsumerAllowlist,
  type RegistryProtocolRecord,
  type RegistrySnapshot,
} from "../src/protocol-contract";
import * as generated from "../src/protocol.generated";

const tmp = mkdtempSync(join(tmpdir(), "dr-protocol-"));
const tokenFile = join(tmp, "test.token");
writeFileSync(tokenFile, "test-token", "utf8");

afterAll(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function consumer(): ConsumerAllowlist {
  return {
    clueStatuses: [...generated.CLUE_STATUSES],
    docKinds: [...generated.DOC_KINDS],
    clueFields: [...generated.CLUE_FIELDS],
    evidenceFields: [...generated.EVIDENCE_FIELDS],
    docFields: [...generated.DOC_FIELDS],
    clueRequired: [...generated.CLUE_REQUIRED],
    evidenceRequired: [...generated.EVIDENCE_REQUIRED],
    docRequired: [...generated.DOC_REQUIRED],
    clueTransitions: { ...generated.CLUE_TRANSITIONS } as Record<string, readonly string[]>,
  };
}

function deepCopy<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

async function startRegistryServer(
  records: Record<string, RegistryProtocolRecord>,
): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    if (req.headers.authorization !== "Bearer test-token") {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "UNAUTHENTICATED" }));
      return;
    }
    const m = url.pathname.match(/^\/v1\/protocols\/(.+)$/);
    if (!m) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND" }));
      return;
    }
    const kind = decodeURIComponent(m[1]);
    const record = records[kind];
    if (!record) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "NOT_FOUND" }));
      return;
    }
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ protocol: record }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const port = (server.address() as AddressInfo).port;
  return {
    port,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

describe("protocol contract (single source) — committed snapshot is self-consistent and green", () => {
  it("registry snapshot passes digest integrity and the consumer contract is green", () => {
    const snapshot = loadRegistrySnapshot();
    expect(verifyRegistrySnapshot(snapshot)).toEqual([]);
    const result = verifyConsumerContract({ snapshot, consumer: consumer() });
    expect(result.ok).toBe(true);
    expect(result.drifts).toEqual([]);
  });

  it("recomputes schema/contract digests exactly like agent-bus", () => {
    const snapshot = loadRegistrySnapshot();
    for (const kind of ["research.clue.v2", "research.evidence.v2", "research.doc.v2"]) {
      const record = snapshot.protocols[kind];
      expect(verifyRegistryRecord(record)).toEqual([]);
    }
  });

  it("generated artifact is exactly what the generator renders (no hand edits)", () => {
    const snapshot = loadRegistrySnapshot();
    const rendered = renderGeneratedProtocol(snapshot);
    const committed = readFileSync(
      fileURLToPath(new URL("../src/protocol.generated.ts", import.meta.url)),
      "utf8",
    );
    expect(rendered).toBe(committed);
  });
});

describe("protocol contract — discriminative (drift must go red)", () => {
  it("local clue status allowlist drifted away → red, names kind + field", () => {
    const snapshot = loadRegistrySnapshot();
    const c = consumer();
    c.clueStatuses = c.clueStatuses.filter((s) => s !== "blocked");
    const result = verifyConsumerContract({ snapshot, consumer: c });
    expect(result.ok).toBe(false);
    expect(
      result.drifts.some((d) => d.kind === "research.clue.v2" && d.field === "status-values"),
    ).toBe(true);
  });

  it("local doc_kind allowlist drifted away → red", () => {
    const snapshot = loadRegistrySnapshot();
    const c = consumer();
    c.docKinds = ["transcript", "report"];
    const result = verifyConsumerContract({ snapshot, consumer: c });
    expect(result.ok).toBe(false);
    expect(
      result.drifts.some((d) => d.kind === "research.doc.v2" && d.field === "doc_kind-values"),
    ).toBe(true);
  });

  it("local field allowlist drifted away → red", () => {
    const snapshot = loadRegistrySnapshot();
    const c = consumer();
    c.clueFields = c.clueFields.filter((f) => f !== "rationale");
    const result = verifyConsumerContract({ snapshot, consumer: c });
    expect(result.ok).toBe(false);
    expect(
      result.drifts.some((d) => d.kind === "research.clue.v2" && d.field === "properties"),
    ).toBe(true);
  });

  it("clue transition pointing outside the registry status enum → red", () => {
    const snapshot = loadRegistrySnapshot();
    const c = consumer();
    c.clueTransitions = {
      ...c.clueTransitions,
      proposed: ["open", "dropped", "bogus-status"],
    };
    const result = verifyConsumerContract({ snapshot, consumer: c });
    expect(result.ok).toBe(false);
    expect(
      result.drifts.some((d) => d.kind === "research.clue.v2" && d.field === "transitions[proposed -> bogus-status]"),
    ).toBe(true);
  });

  it("clue transition graph drifted away from the single state-machine source → red", () => {
    const snapshot = loadRegistrySnapshot();
    const c = consumer();
    c.clueTransitions = {
      ...c.clueTransitions,
      proposed: ["open", "dropped", "explored"],
    };
    const result = verifyConsumerContract({ snapshot, consumer: c });
    expect(result.ok).toBe(false);
    expect(
      result.drifts.some((d) => d.kind === "research.clue.v2" && d.field === "transitions.source[proposed]"),
    ).toBe(true);
  });

  it("snapshot payload_schema tampered (digest drift) → red", () => {
    const snapshot = deepCopy<RegistrySnapshot>(loadRegistrySnapshot());
    const clue = snapshot.protocols["research.clue.v2"];
    const schema = clue.payload_schema as {
      properties: { text: { description: string } };
    };
    schema.properties.text.description = "tampered description";
    const drifts = verifyRegistrySnapshot(snapshot);
    expect(drifts.length).toBeGreaterThan(0);
    expect(drifts.some((d) => d.field === "schema_digest" || d.field === "contract_digest")).toBe(true);
  });

  it("verify:protocol and generate:protocol invocations are wired in package.json", () => {
    const pkg = JSON.parse(
      readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"),
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts["verify:protocol"]).toBeTruthy();
    expect(pkg.scripts["generate:protocol"]).toBeTruthy();
  });
});

describe("protocol contract — live registry source (no mock of the digest lookup)", () => {
  it("resolves a committed/live registry record over real HTTP", async () => {
    const snapshot = loadRegistrySnapshot();
    const srv = await startRegistryServer(deepCopy(snapshot.protocols));
    try {
      const proto = await resolveProtocol(
        `http://127.0.0.1:${srv.port}`,
        tokenFile,
        "research.clue.v2",
      );
      expect(proto.schema_digest).toBe(snapshot.protocols["research.clue.v2"].schema_digest);
      expect(proto.contract_digest).toBe(snapshot.protocols["research.clue.v2"].contract_digest);
    } finally {
      await srv.close();
    }
  });

  it("live registry with a drifted contract_digest → loud failure", async () => {
    const snapshot = loadRegistrySnapshot();
    const records = deepCopy(snapshot.protocols);
    records["research.clue.v2"].contract_digest = `sha256:${"0".repeat(64)}`;
    const srv = await startRegistryServer(records);
    try {
      await expect(
        resolveProtocol(`http://127.0.0.1:${srv.port}`, tokenFile, "research.clue.v2"),
      ).rejects.toThrow(/research\.clue\.v2/);
    } finally {
      await srv.close();
    }
  });

  it("unreachable registry → loud failure naming the kind (never silently green)", async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, "127.0.0.1", () => r()));
    const port = (closed.address() as AddressInfo).port;
    await new Promise<void>((r) => closed.close(() => r()));
    await expect(
      resolveProtocol(`http://127.0.0.1:${port}`, tokenFile, "research.clue.v2"),
    ).rejects.toThrow(/registry: unreachable.*research\.clue\.v2/);
  });
});