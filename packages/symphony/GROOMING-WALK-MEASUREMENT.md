# Bounded grooming-walk measurement

Measured on 2026-08-22 at 04:07 GMT+2 against the live `lineage-client` lane for `razumv/lineage2-classic-ue`. The service snapshot contained **420 open unmanaged backlog issues** with provider-derived bodies, labels, priorities, timestamps, blocked-by relations, and parent relations.

## Exact command

The first command reads the lane state already held by the native Symphony service. It performs no grooming mutation. The second command applies the repository's production ordering and grounding code to that captured backlog and also performs no provider write.

```bash
~/.local/lib/craft-agent-headless/current/bin/craft-cli symphony status --json > status.json
bun packages/symphony/scripts/measure-grooming-walk.ts status.json lineage-client
```

The measurement harness uses `proposeBacklogGrooming` and `GROOMING_CANDIDATE_LIMIT` from the package under test. The status snapshot supplies the real candidates and provider relations; the package's parser-valid fixture supplies only the policy shell needed to run the pure proposal builder. No contract is applied.

## Result

```json
{
  "projectId": "lineage-client",
  "repository": "razumv/lineage2-classic-ue",
  "observedBacklogIssues": 420,
  "candidateLimit": 10,
  "examinedToFirstGroomableOrExhaustion": 420,
  "firstGroomable": null,
  "cyclesToFirstGroomable": null,
  "cyclesToExhaustion": 42,
  "priorOneCandidateCyclesToSamePoint": 420,
  "relationCounts": {
    "grounding": 5,
    "blocked-by": 411,
    "parent": 4
  }
}
```

There is **no first groomable issue in this exact live snapshot** under the unchanged rules, so the honest cycle count to a first groomable issue is `null`, not an invented success. All 420 candidates were examined. The new ten-candidate bound reaches the truthful `exhausted` result in **42 cycles**; the prior one-candidate behavior needed **420 cycles** to reach the same point. At the configured 15-minute fleet interval, that is 10.5 hours instead of 105 hours.

The first refusal was `razumv/lineage2-classic-ue#45`: it was missing an explicit Acceptance Criteria section with issue-authored criteria. Later observed refusals named their open blocked-by or parent issue. The lane-state `grooming.refusals` surface retains each exact issue and reason, so this absence of groomable work is now distinguishable from an empty backlog or a broken grooming loop.

## Interpretation boundary

This measurement does not loosen groundability and does not predict that one of these issues will become groomable. If an issue revision adds the required falsifiable acceptance and non-goals sections or removes an open relation, revision reconciliation makes it eligible again. In any snapshot whose first grounded candidate is at one-based dispatch position `n`, the bounded walk reaches it in `ceil(n / 10)` idle cycles while applying at most one contract in the successful cycle.
