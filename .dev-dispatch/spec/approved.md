# C5-fix3 - Per-worker independent harvest; exited-without-result fails promptly and loudly

**Target:** `Dandi007/loop-engine-deep-research-plugin`
**Frozen base:** C5-fix2 merged head `d58921fd67dc71da604a495a3da9b6a42abc03c9`, cleared of prior development metadata.

## Root cause (frozen from C5-fix2 cold-start re-verify, run 194cbcfc)

The `dr-worker-code-remote` worker (`run_id 194cbcfc…`) started 01:48:35 and its
`agent.run.exited` became available ~02:07:00 (~18.5 min) -- later than the tick's
900000ms result timeout (~02:03:41). The C5-fix2 tick blocks on in-flight workers
through a single sequential `pollForResultOrExit` per worker: `194cbcfc` neither
exited within the timeout (so the `RunExitedWithoutResultError` fast path never
fires) nor produced a readable `worker.result.v1`, so it hit the 900s timeout,
threw, and aborted the WHOLE tick (`TICK FAILURE exit=2`) -- including the
already-ready `worker.result.v1` of the `code-local` worker, which was never
harvested. Net: one slow/failed worker killed every other worker's harvest.

The contract failure is twofold: (1) a single worker's timeout aborts the whole
tick instead of only that worker; (2) "exited without a structured result" is not
detected promptly (short grace) and loudly.

## Goal

A generic tick contract where each in-flight worker is harvested independently,
and an exited worker with no structured result fails promptly and loudly, while
normal worker results remain collectable.

## Required deliverables

1. The tick harvests in-flight workers independently: each worker's result is
   polled and harvested as soon as it becomes readable, and one worker's
   slowness/failure must not block the harvest of the others.
2. A worker whose `agent.run.exited` is observed with no matching `worker.result.v1`
   fails PROMPTLY (a short, bounded grace after exit) and LOUDLY (names run_id and
   role) via `RunExitedWithoutResultError` -- not by waiting the full result timeout.
3. A worker that exceeds the declared result timeout is reclaimed (its clue CASed
   back to `open`) or otherwise marked per-worker, and the tick CONTINUES the other
   workers and exits normally (0) once the ready results are harvested.
4. Discriminative tests driving the real tick (not a mocked spawn): (a) a slow
   worker that has not exited does not prevent harvesting another worker's already
   readable result; (b) exited-without-result fails within the short grace (red if
   it waits the full timeout); (c) a per-worker timeout reclaims only that clue and
   the tick still exits 0 after harvesting the ready ones.

## Constraints

- Implement only through dev-dispatch in the isolated worktree.
- Do not change the seed path (C5-fix), the tick-block mechanism (C5-fix2), the C1
  preflight semantics, the C4 protocol single-source semantics, or the role mapping.
- Reuse the existing `pollForResultOrExit` / `RunExitedWithoutResultError` / timeout
  machinery; no busy spin, no unbounded wait.

## Review bar

Reject if a single worker's timeout or exit-without-result still aborts the whole
tick, if exited-without-result waits the full timeout instead of failing promptly,
if a per-worker failure is silently swallowed (must stay loud for that worker), or
if a test mocks the worker instead of driving the real tick.

```dd-acceptance
npm ci
npm run typecheck
npm test
npm run smoke:cas
```