---
version: "4.1"
project:
  id: craft-protocol-v4
  repository: razumv/craft-protocol
  base_branch: main
  branch_prefix: v4
tracker:
  kind: fake-github
  active_states:
    - ready
    - retry-wait
    - claimed
    - running
    - pr-open
    - review
    - owner-gate
    - merged
    - deployed
  terminal_states:
    - done
    - failed
    - cancelled
    - preservation-unknown
polling:
  interval_ms: 30000
scheduler:
  wip_limit: 1
  claim_ttl_ms: 60000
  stale_run_ms: 120000
  max_attempts: 3
  retry_base_ms: 1000
  retry_max_ms: 4000
workspace:
  root: .v4-workspaces
model:
  connection: chatgpt-plus
  default_profile: pi/gpt-5.6-sol
  allowed_profiles:
    - pi/gpt-5.6-sol
    - pi/gpt-5.6-terra
verification:
  low:
    budget: targeted-tests-plus-one-simulator-smoke
    independent_reviews: 0
    correction_passes: 0
    owner_gate: false
  medium:
    budget: targeted-tests-one-review-one-correction-dev-scenario
    independent_reviews: 1
    correction_passes: 1
    owner_gate: false
  high:
    budget: security-review-owner-gate-exact-readback
    independent_reviews: 1
    correction_passes: 1
    owner_gate: true
---
Implement the issue contract in one fresh bounded Codex session and one isolated worktree.
Scheduler, claim, retry, reconciliation, lifecycle, and verification-budget decisions are deterministic code.
Stop at the workflow-defined PR, owner-gate, deployment, or handoff boundary; never infer completion from silence or an agent-end event.
