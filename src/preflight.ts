import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { evaluateDeploymentContract, type DeploymentContract } from "./deployment-contract";

function values(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

const path = process.argv[2];
if (!path) throw new Error("usage: preflight <contract.json>");
const contract = JSON.parse(readFileSync(resolve(path), "utf8")) as DeploymentContract;
const checkedOutCommit = contract.deploymentCommit === "HEAD"
  ? "HEAD"
  : execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const result = evaluateDeploymentContract(contract, {
  checkedOutCommit,
  readyDependencies: values("PREFLIGHT_DEPENDENCIES"),
  dispatchableRoles: values("PREFLIGHT_ROLES"),
  availableChannels: values("PREFLIGHT_CHANNELS"),
});
process.stdout.write(`${JSON.stringify(result)}\n`);
process.exitCode = result.passed ? 0 : 1;
