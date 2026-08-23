# C1 - Declarative deployment contract and deterministic preflight

**Target:** `Dandi007/loop-engine-deep-research-plugin`
**Frozen base:** `c76594d5f9e45a557b56044d585419a30a3113a8`
**H0 branch:** `h0/dev_ledr_c1_deployment_contract_20260824`

## Goal

Deliver a reusable, declarative deployment contract and a machine-judged,
fail-closed preflight runner. Deep Research is the first real integration.
The contract must also contain a declaration for a second application
(`chatgroup-daemon`) and permit future applications without application code
changes to the runner.

## Required deliverables

1. Versioned schema and documentation for one application declaration:
   application identity, artifact ref and immutable commit, command, working
   directory, required environment keys, health command, and rollback ref.
2. Declarations for `deep-research` and `chatgroup-daemon`. Deep Research is
   runnable by the new runner; chatgroup is schema-valid declaration-only.
3. A deterministic `preflight` command that loads a named declaration and
   emits one structured result. It must validate schema, known application,
   immutable commit format, artifact/working-directory existence, required
   environment presence, executable command availability, and health-command
   syntax before any deployment action.
4. The runner must be fail-closed: an invalid declaration, missing required
   environment key, unknown application, invalid artifact ref, or malformed
   command returns nonzero and prints a stable machine-readable error code.
   No deploy, restart, installation, network mutation, or git mutation may
   occur during preflight.
5. A `preflight-only` mode is explicit and successful only after all checks;
   it must print the resolved immutable commit and declaration digest.
6. Tests must preserve raw stdout/stderr for one green Deep Research run and
   one red missing-required-environment run. These fixtures are acceptance
   evidence, not prose-only examples.
7. Documentation must state the deployment alignment proof: declaration
   commit equals the checked artifact commit, and deployment is permitted only
   from a merged remote main commit followed by `git pull --ff-only` in the
   production checkout. The production checkout is never a development or
   verification location.

## Constraints

- Implement only through dev-dispatch in an isolated worktree.
- Do not modify existing `docs/deploy.md` semantics unless the corresponding
  pinned test is updated in the same change.
- Do not deploy, start services, modify real channels, or mutate the
  production checkout.
- Do not implement app-specific deployment behavior for chatgroup-daemon.

## Acceptance commands

```bash
npm ci
npm run typecheck
npm test
npm run smoke:cas
```

The implementation must add a focused contract test command or test coverage
that proves all of the following:

```text
GREEN: deep-research preflight-only exits 0 and emits status=PASS,
       application=deep-research, the frozen resolved commit, and a digest.
RED: a declaration with a missing required environment key exits nonzero,
     emits status=FAIL and error_code=REQUIRED_ENV_MISSING, and contains no
     deployment-side-effect marker.
```

## Review bar

Reject if preflight can mutate deployment state, if a failure falls through to
deployment, if the second declaration is missing, if output is not machine
parseable, if raw green/red evidence is absent, or if a test mocks away the
runner entrypoint.
