import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  evaluateDeploymentContract,
  runDeploymentPreflight,
  runBoundedChecks,
  type DeploymentContract,
} from "../src/deployment-contract";

const contract = (name: string) => JSON.parse(readFileSync(resolve("profiles/deployment-contracts", name), "utf8")) as DeploymentContract;

describe("deployment contract preflight", () => {
  it("evaluates the Deep Research declaration green", () => {
    const dr = contract("deep-research.json");
    const result = evaluateDeploymentContract(dr, {
      checkedOutCommit: "HEAD",
      readyDependencies: dr.dependencies,
      dispatchableRoles: dr.roles,
      availableChannels: dr.channels,
    });
    expect(result.passed).toBe(true);
    expect(result.checks).toHaveLength(4);
  });

  it("reports an explicit controlled Deep Research failure", () => {
    const dr = contract("deep-research.json");
    const result = evaluateDeploymentContract(dr, {
      checkedOutCommit: "HEAD",
      readyDependencies: dr.dependencies,
      dispatchableRoles: dr.roles,
      availableChannels: ["research"],
    });
    expect(result.passed).toBe(false);
    expect(result.checks.find((check) => check.id === "required-channels")).toMatchObject({
      passed: false,
      diagnostic: "missing: board:agent-runs",
    });
  });

  it("uses the same generic evaluator for a second application", () => {
    const chatgroup = contract("chatgroup.json");
    const result = evaluateDeploymentContract(chatgroup, {
      checkedOutCommit: "HEAD",
      readyDependencies: chatgroup.dependencies,
      dispatchableRoles: chatgroup.roles,
      availableChannels: chatgroup.channels,
    });
    expect(result).toMatchObject({ application: "chatgroup", passed: true });
  });

  it("turns a bounded timeout into a terminal attributable failed check", async () => {
    const [result] = await runBoundedChecks([{ id: "B2-role-probe", timeoutMs: 5, run: () => new Promise(() => {}) }]);
    expect(result).toEqual({ id: "B2-role-probe", passed: false, diagnostic: "timed out after 5ms" });
  });

  it("includes declared bounded probes in the generic preflight result", async () => {
    const dr = contract("deep-research.json");
    const result = await runDeploymentPreflight({
      ...dr,
      boundedChecks: [{ id: "B2-role-probe", timeoutMs: 5, command: ["role-probe"] }],
    }, {
      checkedOutCommit: "HEAD",
      readyDependencies: dr.dependencies,
      dispatchableRoles: dr.roles,
      availableChannels: dr.channels,
    }, async (probe, signal) => new Promise((resolve) => {
      signal.addEventListener("abort", () => resolve({ id: probe.id, passed: false, diagnostic: "aborted" }));
    }));
    expect(result).toMatchObject({ passed: false });
    expect(result.checks.at(-1)).toEqual({
      id: "B2-role-probe",
      passed: false,
      diagnostic: "timed out after 5ms",
    });
  });
});
