# Per-lane status provider-read measurement

Measured by `lane-scoped WIP and reconciliation > status reuses the lane ownership observation with no provider-read increase` in `tests/github-adapter.test.ts`.

The fixture has two managed issues and two configured lane fences in one repository. It compares the pre-change primitive needed to identify a lane's claim (`activeClaims()`) with the status observation that returns both that same lane-owned claim and the repository board (`statusObservation()`). Each side starts from an equivalent hydrated adapter state.

- Before: 20 provider reads
- After: 20 provider reads
- Delta: 0 provider reads per lane

The test also compares the complete provider-call multiset, not only the total. Both observations perform exactly: one issue listing, one issue-node refresh, two label reads, two blocker reads, two Project-item reads, four comment reads (two issue ledgers plus two configured lane fences), two closing-PR reads, two branch reads, two base reads, and two Project-field reads.

`statusObservation()` loads the repository once and derives both `snapshots` and lane-owned `activeClaims` from that observation. It does not perform a second repository walk for status reporting.
