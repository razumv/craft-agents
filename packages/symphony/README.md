# `@craft-agent/symphony`

Repository-owned Symphony v4 scheduler, state model, schema, GitHub/Craft/workspace adapters, and explicit runner boundary for Craft Agents.

## Scope

This package is the native home for the released `craft-protocol` v4 behavior. It is deliberately **not registered** with the Craft Agents server, Electron UI, launchd, or any live project in Alpha 2 Increment 1. Importing it performs no provider access. GitHub, Craft RPC, filesystem truth, clocks, and worktree operations remain explicit injected boundaries; focused tests use in-memory transports or temporary git repositories.

The typed public boundary is the package root:

```ts
import {
  DeterministicScheduler,
  GitHubIssuesProjectsAdapter,
  CraftMobileControlPlaneAdapter,
  GitWorktreeAdapter,
  createLiveRunner,
  type TrackerAdapter,
  type CraftRpcTransport,
  type WorkflowConfig,
} from "@craft-agent/symphony";
```

The workflow schema is exported as `@craft-agent/symphony/workflow.schema.json`.

## Preserved invariants

- deterministic WIP=1 scheduling and bounded retries;
- append-only atomic GitHub claim leases and stale-fence refusal;
- provider-derived branch/PR/merge evidence, never caller-asserted completion;
- configurable model policy: the workflow config declares the connection and the exact profile allowlist (defaults preserve the alpha `chatgpt-plus` + `pi/gpt-*` behavior);
- exact immutable owner directives and gate commands;
- Craft settlement only after a persisted prompt, stopped processing, and an authoritative final assistant response;
- hard turn, context, RPC, and cancellation deadlines;
- deterministic session/worktree identity and restart reconstruction without duplicates;
- root-confined, atomic workspace claim bindings;
- fresh replacement sessions with bounded status handoff and no transcript inheritance.

## Focused verification

From this package:

```bash
bun run typecheck
bun test tests
```

These commands are the complete Increment 1 verification surface. They do not run the legacy or full monorepo suite.

## Provenance and retirement boundary

See [PROVENANCE.md](./PROVENANCE.md) for the immutable upstream release, port map, parity fixtures, deliberate monorepo adaptations, and the condition under which the standalone implementation can be retired.
