# Native Symphony service (headless)

The native Symphony v4 boundary is registered by the headless server but is **disabled by default**. With no `CRAFT_SYMPHONY_CONFIG`, startup is inert and `symphony:status` reports `phase: "disabled"`.

To configure projects, set `CRAFT_SYMPHONY_CONFIG` to an **absolute** JSON path:

```json
{
  "version": 1,
  "enabled": false,
  "stopTimeoutMs": 5000,
  "projects": [
    {
      "id": "craft-protocol",
      "configPath": "/absolute/path/to/live-runner-config.json"
    }
  ]
}
```

Each `configPath` points to one explicit `LiveRunnerConfig` consumed by `@craft-agent/symphony`.

`LiveRunnerConfig.mode` selects the scope: `issue` (default) pins the runner to one explicitly authorized issue (`issueId`/`issueNumber`/`projectItemId` required); `discovery` lets the deterministic scheduler discover eligible issues across the configured repository and GitHub Project — eligibility stays label + machine-readable-contract driven, WIP=1 and atomic claim fencing unchanged. In discovery mode mutations are fenced to the claim-fence issue and to issues/Project items actually observed through the tracker's own reads; the status snapshot carries `statuses` (one per discovered issue) and the kanban board renders one tile per issue. Startup reconstructs provider-neutral status from durable GitHub/filesystem/Craft truth; it does not tick or create sessions/worktrees. `validate`, `shadow`, and `desk` are read-only. `shadow` reports `writes: 0`, the exact proposed action/run identity, the compact Project Desk readback, and a canonical SHA-256 receipt hash.

The Project Desk projection uses the existing Craft session-notes/mobile surface. It contains durable IDs and links rather than transcript excerpts: issue objective/state, branch/PR/deploy links, latest material non-heartbeat event, blocker, exact approve/reject gate commands, next completion point, run/session/context/attempt, and directive acknowledgement IDs. Archived + not-processing is reported as terminal even when a workflow badge is stale.

A live `tick` is rejected unless `enabled` is explicitly set to `true`. Enabling is an activation decision and is outside Alpha 2 Increment 2.

## Model failover chain

`model.connections` (workflow config or the live runner's `model` block) lists connections in attempt order:

```json
{ "model": { "connection": "chatgpt-plus", "connections": ["chatgpt-plus", "chatgpt-plus-2", "chatgpt-plus-3"], "defaultProfile": "pi/gpt-5.6-sol", "allowedProfiles": ["pi/gpt-5.6-sol"] } }
```

Attempt N claims on `connections[N-1]`, clamped to the last entry; absent chain → every attempt uses `connection`. A provider usage limit is a `runtime` failure, so it is retryable: with `maxAttempts: 3` and a three-account chain, an exhausted account moves the next attempt to the next account instead of burning the budget on the same quota. The pick is deterministic per attempt, so restart reconstruction rebinds the exact same connection it claimed, and the claim records it as durable evidence.

## Autonomous polling loop

An optional `loop` block turns on a service-owned polling loop:

```json
{
  "loop": { "enabled": true, "mode": "shadow", "intervalMs": 60000, "maxConsecutiveErrors": 3 }
}
```

- `mode: "shadow"` runs read-only zero-write shadow cycles — it proves the loop machinery (scheduling, serialization, error budget, stop) without mutating anything and works with `enabled: false`.
- `mode: "tick"` runs the live scheduler step and is rejected at config parse unless the top-level `enabled` is `true`.
- Cycles never overlap; each cycle serially visits every reconstructed idle project. A project failing `maxConsecutiveErrors` consecutive cycles is dropped from the loop (manual operations stay available; its `lastError` stays in `status`).
- `symphony status` reports `loop`: mode, interval, completed cycles, last cycle time, dropped projects.
- `stop` cancels the loop timer before draining in-flight work.

RPC/CLI operations:

- `symphony validate <project-id>`
- `symphony shadow <project-id>`
- `symphony desk <project-id>`
- `symphony tick <project-id>`
- `symphony status`
- `symphony stop [timeout-ms]`

`stop` immediately rejects new operations and waits only up to the configured/requested deadline for in-flight work to drain.
