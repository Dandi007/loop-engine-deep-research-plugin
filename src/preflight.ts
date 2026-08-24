import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync } from "node:child_process";
import {
  runDeploymentPreflight,
  type DeploymentContract,
} from "./deployment-contract";
import { runProbe } from "./preflight-probe";

function values(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("usage: preflight <contract.json>");
  const declared = JSON.parse(readFileSync(resolve(path), "utf8")) as DeploymentContract;
  const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const result = await runDeploymentPreflight(declared, {
    checkedOutCommit,
    readyDependencies: values("PREFLIGHT_DEPENDENCIES"),
    dispatchableRoles: values("PREFLIGHT_ROLES"),
    availableChannels: values("PREFLIGHT_CHANNELS"),
  }, runProbe);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.passed ? 0 : 1;
}

void main();
