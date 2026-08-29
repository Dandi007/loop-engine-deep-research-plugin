# C5-fix - Heavy entry seeds the research board before drain (non-empty research.clue.v2 -> worker spawn + harvest)

**Target:** `Dandi007/loop-engine-deep-research-plugin`
**Frozen base:** C4 merged head `c9078ef34d21eafcec0d450f890ae2e53d714bf8`, cleared of prior development metadata.

## Root cause (frozen from C5 cold-start evidence, coord round 15)

The unified heavy entry ran the loop with zero worker spawn: the entry wrote only
`{"seed":true}` into the trigger store (`bin/deep-research-loop.sh`) and never
invoked the existing seeding path (`src/tick-seed.ts` / `tick-entry --seed`,
`src/tick-entry.ts:160-165`) that publishes `research.clue.v2` cards into the
research index channel. So `tick` faced an empty board and natural drain
(`pipeline_drained`, 2 ticks, `evidences: []`, `dr-anchor-rate unavailable`).
The role mapping (`src/tick.ts:34-39`) already exists but is never reached on an
empty board.

## Goal

The unified heavy entry must produce non-empty `research.clue.v2` cards in the
research index BEFORE the loop's first drain, so the orchestration actually
dispatches and harvests at least one worker and yields anchored evidence.

## Required deliverables

1. The heavy entry (non-dry-run) seeds the research index channel with at least
   one non-empty `research.clue.v2` card derived one-to-one from the requested
   `sources` (each carrying a real research sub-question text and a valid
   status), before the loop's first drain.
2. After seeding, the loop must actually spawn and harvest at least one worker
   (`dr-worker-code-local` / `dr-worker-content` / `dr-worker-web` via agent-run)
   whose result produces at least one evidence carrying a valid anchor.
3. Discriminative tests driving the real entry and real tick (not a mocked
   spawn): (a) a non-dry-run heavy entry emits >=1 `research.clue.v2` to the
   index before any drain; (b) at least one worker is genuinely spawned and its
   result harvested into evidence; (c) removing the seeding call, or blanking
   the clue text, makes the corresponding test red.
4. Do not change the frozen C1 preflight semantics, the C4 protocol single-source
   semantics, or the existing role mapping.

## Constraints

- Implement only through dev-dispatch in the isolated worktree.
- Do not deploy, modify real production channels, or mutate any production checkout.
- The fix is in the DR plugin's own entry/seeding path; it must not rely on a
  plugin-specific hack that a future domain could not reuse.

## Review bar

Reject if the heavy entry still zero-spawns (no research.clue.v2 before drain, or
no worker spawn/harvest), if the seeding is a dry-run-only or busless side effect,
if the seeded clue is empty/placeholder (no real sub-question, so a worker would
produce zero evidence), or if a test mocks the worker spawn instead of driving the
real entry/tick.

```dd-acceptance
npm ci
npm run typecheck
npm test
npm run smoke:cas
```