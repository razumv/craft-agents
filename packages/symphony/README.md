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

## Project Desk directives

Every runner cycle reads only its configured `craft.ownerSessionId` before dispatch. A desk message is binding only when it exactly matches one of these forms:

```text
DIRECTIVE <issue node ID or repository#number>: <verbatim instruction>
APPROVE <currently open gate ID>
REJECT <currently open gate ID>: <reason>
```

All other owner messages remain conversation and are not stored. Gate IDs are matched to the issue currently in `owner-gate`; stale IDs are refused with the current mismatch, never retargeted. Accepted messages are keyed by the configured desk session plus source message ID, stored once in the immutable Craft ledger, and projected as an idempotent visible receipt on the target GitHub issue. Generic directive text is delivered but not interpreted or acted on; exact current gate decisions use the existing merge/block lifecycle paths.

Measured at the `CraftRpcTransport` boundary, an unchanged desk costs **4 provider reads per lane per cycle**: runtime identity, session index, desk transcript, and desk notes. A cycle discovering one or more new messages batches them into **5 reads plus 1 write** (the fifth read verifies the acknowledgement write), so the hard bound is **6 provider calls per lane per cycle**, independent of the number of new messages in that transcript.

## Failed-work decisions

A terminal failed attempt does not decide whether the work is still wanted. An owner may revive an **open** failed issue only by naming a demonstrably changed fact or reference; that exact justification is append-only, can be used once, and grants a fresh attempt budget starting again at attempt 1. `scheduler.max_revivals` bounds those fresh budgets. A failed issue may instead be recorded as cancelled only when supersession names the exact successor where the work continued.

Neither decision is delivery. Only the provider's own merge evidence can advance work to `merged`, `deployed`, or `done`. **Closed now means work that is not wanted**: closure remains an explicit owner decision, never an automatic fallback for a failed attempt.

## Read-only backlog grooming

`LiveV4Runner.proposeGrooming()` reads one repository's existing unmanaged backlog and returns either one parser-valid contract proposal or an exact refusal. It never labels, comments, edits, claims, or updates a Project field. Candidate order is the scheduler's upstream order: priority 1 through 4 ascending; every other value and null after; creation time oldest first with null last; then identifier.

After ordinary dispatch has first refusal, an idle discovery lane considers at most `GROOMING_CANDIDATE_LIMIT` (**10**) new candidates from that same backlog observation. It walks in the same dispatch order, remembers each refusal by provider issue revision, and stops at the first grounded proposal or the bound. At most one proposal is applied per cycle. A later unchanged cycle skips remembered refusals; a changed revision is reconsidered. Candidate decisions are pure and add no provider reads to the already-observed backlog.

The existing `LiveRunnerStatus.grooming` lane-state surface reports `candidateLimit`, `examinedCandidates`, and every revision-current refusal with its issue identifier, relation, and exact reason. This distinguishes an empty backlog, a partially walked backlog, and a fully exhausted backlog without relying on logs. See [GROOMING-WALK-MEASUREMENT.md](./GROOMING-WALK-MEASUREMENT.md) for the large-repository result.

A candidate is refused when an open blocker, open parent, or prerequisite label is present. Contract acceptance criteria are copied only from explicit issue-authored acceptance bullets and retain exact source-line mappings; unsupported additions are defects. Missing falsifiable acceptance or explicit non-goals produces a refusal rather than an invented contract.

The grooming risk rubric is deterministic and evaluated in this order:

1. **High** — credentials/secrets, authentication/authorization, payments/billing, data deletion/destructive operations, or anything described as irreversible.
2. **Low** — explicitly documentation-only or tests/fixtures-only work.
3. **Medium** — all other executable changes.

High-risk classification cannot be downgraded. Every proposal copies the exact verification budget declared by `workflow.verification[risk]` and is round-tripped through the real issue contract parser before it is returned.

## Focused verification

From this package:

```bash
bun run typecheck
bun test tests
```

These commands are the complete Increment 1 verification surface. They do not run the legacy or full monorepo suite.

## Provenance and retirement boundary

See [PROVENANCE.md](./PROVENANCE.md) for the immutable upstream release, port map, parity fixtures, deliberate monorepo adaptations, and the condition under which the standalone implementation can be retired.
