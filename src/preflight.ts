import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { execFileSync, spawn } from "node:child_process";
import {
  runDeploymentPreflight,
  type BoundedProbe,
  type DeploymentContract,
  type PreflightCheck,
} from "./deployment-contract";

function values(name: string): string[] {
  return (process.env[name] ?? "").split(",").map((value) => value.trim()).filter(Boolean);
}

function runProbe(probe: BoundedProbe, signal: AbortSignal): Promise<PreflightCheck> {
  const [command, ...args] = probe.command;
  if (!command) return Promise.resolve({ id: probe.id, passed: false, diagnostic: "probe command is empty" });
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "ignore" });
    signal.addEventListener("abort", () => child.kill(), { once: true });
    child.once("error", (error) => resolve({ id: probe.id, passed: false, diagnostic: error.message }));
    child.once("exit", (code, terminationSignal) => resolve({
      id: probe.id,
      passed: code === 0,
      diagnostic: code === 0 ? "probe passed" : terminationSignal ? `terminated by ${terminationSignal}` : `exited with ${code}`,
    }));
  });
}

async function main(): Promise<void> {
  const path = process.argv[2];
  if (!path) throw new Error("usage: preflight <contract.json>");
  const declared = JSON.parse(readFileSync(resolve(path), "utf8")) as DeploymentContract;
  const checkedOutCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const contract = {
    ...declared,
    deploymentCommit: execFileSync("git", ["rev-parse", declared.deploymentCommit], { encoding: "utf8" }).trim(),
  };
  const result = await runDeploymentPreflight(contract, {
    checkedOutCommit,
    readyDependencies: values("PREFLIGHT_DEPENDENCIES"),
    dispatchableRoles: values("PREFLIGHT_ROLES"),
    availableChannels: values("PREFLIGHT_CHANNELS"),
  }, runProbe);
  process.stdout.write(`${JSON.stringify(result)}\n`);
  process.exitCode = result.passed ? 0 : 1;
}

void main();
