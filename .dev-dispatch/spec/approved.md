# C2 - Unified invocation surface for Deep Research (single entry, 条 6 / 条 9)

**Target:** `Dandi007/loop-engine-deep-research-plugin`
**Frozen base:** C1 merged head `f8d1cc5e6b1550fbcbe7aa6feba898fad0b15ace` (cleared of prior development metadata).

## Goal

One application declaration yields three invocation surfaces -- a programmable
MCP tool (agent), a human-invokable skill, and a CLI -- and the Deep Research
entry routes light (session-level `workflow.js`) vs heavy (full V2 orchestration)
tiers from that single entry. The heavy tier is launched by exactly one command
that auto-completes profile and channel preparation with zero manual steps.
The legacy dual-system coexistence (two parallel entries) is eliminated.

## Required deliverables

1. A unified entry command in `bin/` that, given one research topic, routes to
   the light tier (session-level `workflow.js`) or the heavy tier (V2 full
   orchestration) by an explicit, documented scale/threshold rule. The same
   invocation is used for both tiers; there is no separate parallel entry.
2. The heavy-tier path must be launchable with exactly one command: it
   auto-completes profile selection and channel preparation (create-or-reuse on
   the selected bus), with zero manual profile/channel steps. The preflight
   runner from C1 is invoked before the heavy tier is started, and a non-green
   preflight refuses to start (fail-closed).
3. A programmable MCP tool declaration for the same entry (agent-callable),
   co-located with the application declaration, so an agent can launch research
   without reading the CLI syntax.
4. A human-invokable skill declaration for the same entry, so a human uses one
   skill to reach both tiers.
5. The legacy direct-run path (the old bare entry) is retired or demoted to an
   internal implementation detail; it must not be a second user-facing entry.
6. Tests must be machine-judgeable and discriminative: (a) the same entry routes
   to light vs heavy per the scale rule; (b) the heavy path completes
   profile+channel preparation with no manual input; (c) a non-green preflight
   refuses the heavy start; (d) the legacy direct-run path is no longer a
   user-facing entry. At least one test drives the real CLI entrypoint without
   mocking it away.

## Constraints

- Implement only through dev-dispatch in the isolated worktree.
- Do not deploy, start real services, modify real production channels, or mutate
  any production checkout.
- Do not change the C1 deployment-contract schema or preflight semantics unless
  a corresponding pinned test is updated in the same change.
- The light tier internals (`workflow.js`) remain the existing implementation;
  this development only adds the routing entry, not a reimplementation of the
  light engine.

## Review bar

Reject if the entry is not single, if the heavy path requires any manual
profile/channel step, if a failing preflight can still start the heavy tier, if
the MCP tool or skill declaration is missing, or if a test mocks away the
routing/preflight entrypoint instead of driving it.

```dd-acceptance
npm ci
npm run typecheck
npm test
npm run smoke:cas
```