# Acceptance baseline repair - a10b B1/B2

**Target:** `Dandi007/loop-engine-deep-research-plugin`
**Frozen base:** `c76594d5f9e45a557b56044d585419a30a3113a8`

## Goal

Repair the inherited acceptance baseline that blocks C1 before implementation.
Fix the a10b-convergence B1/B2 drain failures against the supplied
`/data/worktrees/loop-engine-v1build` dependency while preserving e0c2
wall-clock-primary behavior and all existing acceptance semantics.

## Required deliverables

1. Diagnose and minimally repair a10b B1/B2 so its drain completes against
   the supplied dependency. Do not skip, delete, weaken, mock away, or mark
   the assertions pending.
2. Preserve e0c2 wall-clock-primary: its required more-than-two drain
   behavior remains asserted and green. Do not reduce its threshold or
   disable the test.
3. Add or adjust regression coverage only when it makes the repaired behavior
   mechanically distinguishable from the failed baseline.
4. Keep all production/deployment behavior unchanged. This is a test and
   deterministic scheduling compatibility repair, not a deployment change.

## Frozen acceptance

Run from the candidate worktree after dependency installation:

```bash
npm ci
npm run typecheck
npm test
npm run smoke:cas
```

All four commands must exit zero. `npm test` must show the repaired a10b B1
and B2 cases green and the e0c2 wall-clock-primary case green. A green command
that collects zero relevant tests is a failure.

## Review bar

Reject any patch that relaxes a10b/e0c2 assertions, replaces a real drain
with a mock, changes the supplied dependency path only to evade the failure,
or modifies deployment/product scope outside the minimal compatibility fix.

## Immutable predecessor feedback

Predecessor `dev_ledr_acceptance_baseline_a10b_e0c2_20260824_r7c` was cancelled during continuous review without a verdict or accepted candidate. Treat its authenticated implement handoff as immutable feedback only, never as an accepted candidate: receipt `sha256:b11212e4067ba1784952f9c8d4cdd921ae2e1da0901110d312e658976174b23b`; output commit `4bdae3ad1f9e5c279d2378a9b647f4f249ffd69a`; artifact `.dev-dispatch/handoffs/attempt_01M0REE0F8T0AS6K2XJ1MC4AMC/implement.json` digest `sha256:3cdf8c2bb29226a18e86a10aaa6348444b79a30aa41382bd0b4cbd81cb0b8598`; terminal event 8213. Reimplement and independently review all scope through dev-dispatch.

Predecessor `dev_ledr_acceptance_baseline_a10b_e0c2_20260824_r8` terminal event 8221: implement remained stalled with no handoff/event/candidate. Preserve bootstrap receipt `sha256:86e6d235cf155f2fdb98b2823e15aadda075cc666e37617651430ae831ad22d5` and terminal evidence `sha256:9d3dd68e8cff6b6f39ff611210fdcc34029adc9f0d87d3e91110f47ef3d6c1fc` as immutable feedback only.

Predecessor `dev_ledr_acceptance_baseline_a10b_e0c2_20260824_r9` terminal event 8231 is immutable feedback: `UNVERIFIED_TEST_CLAIM`; actor claimed `npm test` exit 0 while deterministic seal observed real exit 1. Re-run all three frozen commands (`npm run typecheck`, `npm test`, `npm run smoke:cas`) and preserve truthful raw exits; do not report an unverified result. Terminal evidence `sha256:01983e3abcf0fe73c1f33c2bb0a4f222e83d84437a8b6590305a8f86bf0f4fa4`.
