import { spawn } from "node:child_process";
import type { BoundedProbe, PreflightCheck } from "./deployment-contract";

/** Executes a probe and kills its process group when its bounded check expires. */
export function runProbe(probe: BoundedProbe, signal: AbortSignal): Promise<PreflightCheck> {
  const [command, ...args] = probe.command;
  if (!command) return Promise.resolve({ id: probe.id, passed: false, diagnostic: "probe command is empty" });
  return new Promise((resolve) => {
    const child = spawn(command, args, { detached: process.platform !== "win32", stdio: "ignore" });
    signal.addEventListener("abort", () => {
      // Kill the probe's process group so a child that ignores SIGTERM cannot retain the CLI.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch {
        // The probe may have exited while the timeout was firing.
      }
    }, { once: true });
    child.once("error", (error) => resolve({ id: probe.id, passed: false, diagnostic: error.message }));
    child.once("exit", (code, terminationSignal) => resolve({
      id: probe.id,
      passed: code === 0,
      diagnostic: code === 0 ? "probe passed" : terminationSignal ? `terminated by ${terminationSignal}` : `exited with ${code}`,
    }));
  });
}
