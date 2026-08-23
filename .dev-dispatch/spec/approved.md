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
