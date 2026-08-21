# Incremental repository scan measurement

Measured on 2026-08-21 against `razumv/lineage2-classic-ue`, the largest repository in the fleet. GitHub reported **580 issues**, satisfying the greater-than-500 requirement; 424 were open backlog issues during the run.

## Exact command

Run from the repository root with the same authenticated `gh` credential used by Symphony:

```bash
bun packages/symphony/scripts/measure-incremental-scan.ts razumv/lineage2-classic-ue
```

The harness runs the same adapter instance twice. The first tick has no in-memory watermark and therefore represents the old steady-state behavior: a full issue listing and full backlog reconstruction. The second tick retains the provider-reported watermark and represents the new steady state. Each GraphQL request asks GitHub for its own `rateLimit.cost`; the harness sums those provider-reported values, so concurrent activity on the same credential cannot contaminate the result.

## Provider-reported result

```json
{
  "repository": "razumv/lineage2-classic-ue",
  "issueCount": 580,
  "cold": {
    "label": "before / cold full scan",
    "providerCost": 438,
    "providerQueries": 431,
    "managedIssues": 0,
    "backlogIssues": 424
  },
  "warm": {
    "label": "after / incremental scan",
    "providerCost": 2,
    "providerQueries": 1,
    "managedIssues": 0,
    "backlogIssues": 424
  }
}
```

- **Before:** 438 GraphQL points per tick.
- **After:** 2 GraphQL points per unchanged tick.
- **Saving:** 436 points, or **99.54%**.

The saving is much larger than half. This is a successful reduction, not a marginal result.

At the configured 30-minute cadence, the measured unchanged steady-state cost for a full eight-project fleet cycle is:

- 2 points/project × 8 projects = **16 points per cycle**
- 16 points/cycle × 2 cycles/hour = **32 GraphQL points per hour**

That 32-point figure is the unchanged-repository floor demonstrated by this measurement. A changed issue or an issue holding a claim intentionally adds its own refresh/hydration cost; active claims are never hidden behind the watermark.

## Correctness boundary

The watermark is in-memory only. A restart discards it and the next read pays the full recovery cost. It advances only after the complete provider read succeeds and is derived solely from the maximum `updatedAt` GitHub returned. Every known claimed issue and every explicit ID read is refreshed by node ID on every later scan, so pull-request merges and check-rollup changes are observed even when the issue timestamp does not move. Existing per-operation write invalidation remains unchanged.
