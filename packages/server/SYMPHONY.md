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

Each `configPath` points to one explicit `LiveRunnerConfig` consumed by `@craft-agent/symphony`. Startup reconstructs provider-neutral status from durable GitHub/filesystem/Craft truth; it does not tick or create sessions/worktrees. `validate`, `shadow`, and `desk` are read-only. `shadow` reports `writes: 0`, the exact proposed action/run identity, the compact Project Desk readback, and a canonical SHA-256 receipt hash.

The Project Desk projection uses the existing Craft session-notes/mobile surface. It contains durable IDs and links rather than transcript excerpts: issue objective/state, branch/PR/deploy links, latest material non-heartbeat event, blocker, exact approve/reject gate commands, next completion point, run/session/context/attempt, and directive acknowledgement IDs. Archived + not-processing is reported as terminal even when a workflow badge is stale.

A live `tick` is rejected unless `enabled` is explicitly set to `true`. Enabling is an activation decision and is outside Alpha 2 Increment 2.

RPC/CLI operations:

- `symphony validate <project-id>`
- `symphony shadow <project-id>`
- `symphony desk <project-id>`
- `symphony tick <project-id>`
- `symphony status`
- `symphony stop [timeout-ms]`

`stop` immediately rejects new operations and waits only up to the configured/requested deadline for in-flight work to drain.
