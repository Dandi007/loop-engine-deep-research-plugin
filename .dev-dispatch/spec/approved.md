# C1: Reusable Deployment Contract and Machine-Decidable Preflight

## Status

Frozen for dev-dispatch implementation and review. Target baseline is
`6be18739ded225f6991c7227f97498d729d3b1c4`.

## Objective

Provide a reusable deployment-contract and preflight capability for an
orchestrated application. Deep Research (DR) is the first consumer, not a
special case. The capability must also be declarable by a second application
and be reusable by DR, chatgroup, dev-dispatch, and future domains.

## Required Behavior

1. An application can declare its deployment preconditions in a structured,
   machine-readable contract. The contract covers checked-out deployment
   commit, dependency readiness, dispatchable roles, and required channels.
2. A generic preflight runner evaluates that contract deterministically and
   returns a machine-readable pass/fail result with per-check diagnostics.
3. DR supplies a real declaration and demonstrates both a green preflight and
   a controlled red preflight whose failed predicate is explicit.
4. At least one second application supplies a declaration that the same
   generic preflight machinery can parse and evaluate. The implementation may
   not embed DR-specific assumptions in the shared runner.
5. Eliminate the B2 timeout: bounded preflight execution must report the
   timeout as a terminal, attributable failed check rather than hanging or
   leaving an ambiguous result.

## Regression and Acceptance

- Add focused tests for valid DR evaluation, controlled DR failure, second
  application declaration, generic cross-domain reuse, and B2 timeout.
- In a dev-dispatch isolated candidate workspace run, without substitutions:

  ```text
  npm ci && npm run typecheck && npm test && npm run smoke:cas
  ```

- All commands exit zero. Record the exact candidate commit and output in
  acceptance evidence.
- Require continuous and final dev-dispatch review. A reviewer rejection must
  be resolved before acceptance.

## Boundaries

- Implementation and all code review belong exclusively to dev-dispatch.
- The H0 worktree and every candidate/acceptance workspace must remain under
  `/data/worktrees` or the engine-provided isolated workspace.
- No production checkout mutation, validation, checkout, switch, reset, or
  detach is permitted.
- Durable MR base must be non-main. Promotion remains outside this development
  and requires remote main merge before production may run `git pull --ff-only`.
