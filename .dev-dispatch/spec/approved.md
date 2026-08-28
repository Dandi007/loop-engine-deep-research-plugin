# C4 - Single-source typed contract for the DR protocol consumer (no hand-copied allowlist)

**Target:** `Dandi007/loop-engine-deep-research-plugin`
**Frozen base:** C2 merged head `ec40fed72d45a0091710ff39027f35e2178eee27`, cleared of prior development metadata.

## Goal

The Deep Research protocol consumer-side schemas (`research.clue.v2`,
`research.evidence.v2`, `research.doc.v2`, and the clue state-machine allowlist in
`src/protocol.ts`) must be derived from, or mechanically verified against, the
agent-bus protocol registry's `contract_digest` -- not hand-copied. Produce a
reusable derive/verify component that any consumer (deep-research, chatgroup,
future domains) can use.

## Required deliverables

1. A reusable, machine-runnable derive/verify component: for each protocol kind
   the app consumes, it resolves the authoritative schema from the bus registry
   (by `contract_digest`) and either derives the local consumer schema from it, or
   mechanically verifies the local schema is byte/structurally consistent with the
   registry digest. It must not maintain a hand-copied allowlist of field names,
   kinds, or transitions as the source of truth.
2. Deep Research consumes it: `src/protocol.ts` (or its replacement) obtains the
   ClueV2/EvidenceV2/DocV2 shapes and the clue state-machine transitions from the
   single source, with the hand-copied allowlist removed or demoted to a
   checked-generated artifact.
3. A single reproducible check command that runs the dual-source diff for every
   protocol kind this app consumes and exits 0 (green) only when all of them match
   the registry; a mismatch exits non-zero and names the kind + the drift.
4. If the registry is unreachable the check must fail loudly (non-zero + named
   error), never silently pass or silently skip to a green.
5. Tests are discriminative: editing the local schema (or the generated allowlist)
   away from the registry digest, or removing the check invocation, must make the
   verify run red.

## Constraints

- Implement only through dev-dispatch in the isolated worktree.
- Do not change the C1 preflight / C2 unified-entry semantics unless a
  corresponding pinned test is updated in the same change.
- Do not deploy, modify real channels, or mutate any production checkout.
- The dd production engine's in-repo counterpart of this change is explicitly OUT
  of this development's scope; the coordinator files it to the wf-d726aa line
  separately (recorded in the work-folder progress outside the repo).

## Review bar

Reject if a hand-copied allowlist remains the source of truth, if the dual-source
diff is not machine-runnable or not green, if an unreachable registry silently
greens, or if a test mocks away the registry digest lookup instead of exercising a
committed/live registry source.

```dd-acceptance
npm ci
npm run typecheck
npm test
npm run smoke:cas
```