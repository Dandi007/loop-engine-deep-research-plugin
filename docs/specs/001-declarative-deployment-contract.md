# 001 - Declarative deployment contract

This document is the durable copy of the C1 frozen contract. The executable
source of the H0 is `.dev-dispatch/spec/approved.md`.

The contract describes deployment intent; it does not authorize deployment.
Every deployment must bind a declared immutable commit to the artifact being
used, complete preflight with no side effects, and be promoted through a
merged remote main commit. A production checkout may only update by
`git pull --ff-only` after that merge.

The first integration is Deep Research. `chatgroup-daemon` is a valid second
declaration without runner-side application logic. Future applications add
declarations that conform to the same versioned schema.
