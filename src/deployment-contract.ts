/** A domain-neutral declaration and deterministic evaluator for deployment readiness. */
export interface DeploymentContract {
  application: string;
  deploymentCommit: string;
  dependencies: string[];
  roles: string[];
  channels: string[];
}

export interface PreflightEnvironment {
  checkedOutCommit: string;
  readyDependencies: Iterable<string>;
  dispatchableRoles: Iterable<string>;
  availableChannels: Iterable<string>;
}

export interface PreflightCheck {
  id: string;
  passed: boolean;
  diagnostic: string;
}

export interface PreflightResult {
  application: string;
  passed: boolean;
  checks: PreflightCheck[];
}

function missing(required: string[], available: Iterable<string>): string[] {
  const present = new Set(available);
  return required.filter((value) => !present.has(value));
}

/** Evaluates declarations without application-specific branches or side effects. */
export function evaluateDeploymentContract(
  contract: DeploymentContract,
  environment: PreflightEnvironment,
): PreflightResult {
  const dependencyMissing = missing(contract.dependencies, environment.readyDependencies);
  const roleMissing = missing(contract.roles, environment.dispatchableRoles);
  const channelMissing = missing(contract.channels, environment.availableChannels);
  const checks: PreflightCheck[] = [
    {
      id: "checked-out-commit",
      passed: contract.deploymentCommit === environment.checkedOutCommit,
      diagnostic:
        contract.deploymentCommit === environment.checkedOutCommit
          ? `checked out ${environment.checkedOutCommit}`
          : `expected ${contract.deploymentCommit}; found ${environment.checkedOutCommit}`,
    },
    {
      id: "dependencies",
      passed: dependencyMissing.length === 0,
      diagnostic: dependencyMissing.length === 0 ? "all dependencies ready" : `missing: ${dependencyMissing.join(", ")}`,
    },
    {
      id: "dispatchable-roles",
      passed: roleMissing.length === 0,
      diagnostic: roleMissing.length === 0 ? "all roles dispatchable" : `missing: ${roleMissing.join(", ")}`,
    },
    {
      id: "required-channels",
      passed: channelMissing.length === 0,
      diagnostic: channelMissing.length === 0 ? "all channels available" : `missing: ${channelMissing.join(", ")}`,
    },
  ];
  return { application: contract.application, passed: checks.every((check) => check.passed), checks };
}

export interface BoundedCheck {
  id: string;
  timeoutMs: number;
  run: () => Promise<PreflightCheck>;
}

/** Runs asynchronous probes with a terminal diagnostic instead of an unbounded wait. */
export async function runBoundedChecks(checks: BoundedCheck[]): Promise<PreflightCheck[]> {
  return Promise.all(checks.map(async (check) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        check.run(),
        new Promise<PreflightCheck>((resolve) => {
          timer = setTimeout(
            () => resolve({ id: check.id, passed: false, diagnostic: `timed out after ${check.timeoutMs}ms` }),
            check.timeoutMs,
          );
        }),
      ]);
    } catch (error) {
      return { id: check.id, passed: false, diagnostic: error instanceof Error ? error.message : String(error) };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }));
}
