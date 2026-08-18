# Symphony v4 provenance and parity

## Immutable source

The initial native implementation was ported from the Apache-2.0 released source:

- repository: `razumv/craft-protocol`
- tag: `v4.0.0-alpha.1`
- commit: `0767d0f2565d7f10a9ab5d46d7986162f20ab694`
- release subject: `feat(v4): add opt-in end-to-end canary runner (#54)`
- source package: `v4/`

Representative release hashes:

- `v4/src/github-adapter.ts`: `34321740e96993fa728443cd53e3a4ede4c84defe598fb8e692580b2bfc5e45d`
- `v4/src/craft-adapter.ts`: `703294468d5547972e61dd679c3378a8b98416c3178fbf7dd4534ce8e167663a`

All 20 released `v4/src/*.ts` modules, all six focused `v4/tests/*.test.ts` suites, and `v4/workflow.schema.json` were used as the port baseline. Durable protocol markers such as `craft-protocol-v4` remain unchanged so reconstruction is compatible with released evidence.

## Repository adaptations

The port preserves accepted scheduler semantics while adapting packaging and applying two fail-closed corrections found by the one approved Codex review:

1. Ownership/name moves from the standalone private `@craft-protocol/v4-scheduler-core` package to repository workspace package `@craft-agent/symphony`.
2. TypeScript and dev dependency versions follow the Craft Agents monorepo; Bun and Node remain the native runtime primitives.
3. The released root `WORKFLOW.md` is copied to `tests/fixtures/WORKFLOW.md`, so package tests do not depend on another repository root.
4. Public imports are exposed through `src/index.ts`; the JSON workflow schema is a package subpath export.
5. The live CLI source is retained for semantic parity but is not registered as a workspace command, server service, UI control, launchd job, or package bin.
6. Provider tests remain injected/in-memory. The git worktree test uses only a temporary repository and never the selected Craft Agents worktree.
7. `LiveV4Runner.transitionToPrOpen` now enforces the already-declared true-settlement invariant instead of relying only on its evidence message: `running → pr-open` requires exact Craft `settled` readback.
8. `ScopedGitHubTransport.replaceLabels` now fences both repository and issue number, preventing the same numeric issue in another repository from entering the mutation scope.

No live Craft or GitHub transport is constructed or called by import, typecheck, or test execution.

## Behavioral parity evidence

`tests/fixtures/v4.0.0-alpha.1-parity.json` freezes the accepted release contract for:

- exact lifecycle transitions;
- claim/evidence fencing;
- Codex-only model policy;
- directive immutability and exact gate parsing;
- settlement versus response-less `agent_end`/completion;
- turn/context/cancellation deadlines;
- deterministic restart reconstruction with one session and one worktree.

`tests/parity-fixtures.test.ts` consumes the fixture directly. The ported scheduler, GitHub, Craft, runner, status, and workspace suites preserve the deeper provider and integration scenarios.

## Standalone retirement boundary

`craft-agents` becomes the implementation owner once this package and the later native server/control-plane increments are merged and their integrated canary passes. After that release is the sole deployed v4 implementation and migration compatibility is proven, `razumv/craft-protocol/v4` may shrink to:

- immutable release/tag history;
- compatibility and migration fixtures;
- protocol documentation.

Until those conditions are met, the standalone release remains the comparison oracle. New runtime behavior must not be implemented independently in both repositories: change the owner implementation, update the parity fixture with explicit provenance, and keep compatibility tooling only where required.
