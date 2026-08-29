# C5-fix2 - Tick blocks on in-flight workers so the loop harvests evidence before round-budget termination

**Target:** `Dandi007/loop-engine-deep-research-plugin`
**Frozen base:** C5-fix merged head `bbba0ddf5b5773a3756f0f16e022521e80c200f0`, cleared of prior development metadata.

## Root cause (frozen from C5 cold-start re-verify + manual tick harvest)

The seed -> clue -> dispatch chain now works (C5-fix): 4 non-empty `research.clue.v2`
are seeded, and the tick dispatches them `open -> in_flight` with real `run_id`s.
A manual `tick-entry --run` against that board returns 4 `harvest` decisions and
`harvestReports[0]` shows `evidencePublished: 6, cluesPublished: 3` -- the
`dr-worker-code-local` worker actually ran and produced evidence. Yet the cold-start
run terminated with `reason:"max_rounds"` after ~16 passes (~70s) with every trigger
body `{"tick":true,"coverage":0,"zeroGrowthRounds":1..16}`.

The first exclusion is the in-flight harvest timing: `decideTick` §3 emits a
`harvest` decision only for a worker already observed `agent.run.exited(0)`, and
`pollForResultOrExit` is invoked only for those already-exited cards. For a card
`status=in_flight` with `agent.run.started` observed but not yet `exited`, the tick
emits no decision, returns immediately, and re-triggers a new pass -- so `coverage`
stays 0 while the (minutes-long model) workers are still running, and the loop-engine
`max_passes=16` round budget terminates the run before any worker result is harvested.

## Goal

The tick must wait for in-flight workers within a pass, so their results are
harvested into evidence (`coverage > 0`) before the loop's round budget terminates.

## Required deliverables

1. When the board holds an `in_flight` card with `agent.run.started` observed but no
   `agent.run.exited` yet, the tick BLOCKS via the existing `pollForResultOrExit`
   (bounded by the declared result timeout) until that worker exits and its result
   is readable, and then emits the `harvest` decision -- in the same pass, instead
   of returning immediately and re-triggering.
2. After the change, a cold-start/heavy run must harvest at least one worker's
   evidence (`coverage > 0`) before any termination; it must not terminate with
   `max_rounds` while a started worker is still in flight and un-harvested.
3. A worker that never exits still fails loudly on the declared timeout (not a
   silent zero-growth), and an exited-without-result worker is still diagnosed as
   such (existing `RunExitedWithoutResultError` behavior preserved).
4. Discriminative tests driving the real tick (not a mocked spawn): (a) an
   in-flight + started + not-exited worker causes the tick to block/poll and then
   harvest its result into evidence; (b) a tick that returns immediately without
   waiting (the current behavior) is detected red; (c) a never-exiting worker is a
   loud timeout, not a silent zero-growth.

## Constraints

- Implement only through dev-dispatch in the isolated worktree.
- Do not change the seed path (C5-fix), the C1 preflight semantics, the C4 protocol
  single-source semantics, or the existing role mapping.
- The wait must reuse the existing `pollForResultOrExit`/timeout machinery; no busy
  spin, no unbounded wait.

## Review bar

Reject if the tick still returns immediately for started + not-exited workers, if
the run can still terminate `max_rounds` while a started worker is un-harvested, if
the wait bypasses the declared timeout, or if a test mocks the worker instead of
driving the real tick.

```dd-acceptance
npm ci
npm run typecheck
npm test
npm run smoke:cas
```