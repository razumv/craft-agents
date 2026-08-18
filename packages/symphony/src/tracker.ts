// SPDX-License-Identifier: Apache-2.0

import type {
  Claim,
  FailureClass,
  LifecycleState,
  MaterialEvidence,
  TrackerIssueSnapshot,
  WorkflowConfig,
} from "./domain";

export type Awaitable<T> = T | Promise<T>;

export interface TrackerTransitionOptions {
  fence?: string;
  message?: string;
  evidence?: MaterialEvidence;
}

/** Provider-independent durable tracker boundary used by the deterministic scheduler. */
export interface TrackerAdapter {
  fetchIssuesByStates(states: readonly LifecycleState[]): Promise<TrackerIssueSnapshot[]>;
  fetchIssuesByIds(ids: readonly string[]): Promise<TrackerIssueSnapshot[]>;
  activeClaims(): Awaitable<TrackerIssueSnapshot[]>;
  get(issueId: string): Awaitable<TrackerIssueSnapshot>;
  tryClaim(
    issueId: string,
    expectedVersion: number,
    proposed: Claim,
    nowMs: number,
  ): Awaitable<TrackerIssueSnapshot | null>;
  markRunning(fence: string, nowMs: number): Awaitable<TrackerIssueSnapshot>;
  heartbeat(fence: string, nowMs: number, ttlMs: number): Awaitable<void>;
  failClaim(
    fence: string,
    failureClass: FailureClass,
    reason: string,
    nowMs: number,
    scheduler: WorkflowConfig["scheduler"],
  ): Awaitable<TrackerIssueSnapshot>;
  transition(
    issueId: string,
    to: LifecycleState,
    nowMs: number,
    options?: TrackerTransitionOptions,
  ): Awaitable<TrackerIssueSnapshot>;
  reconcileStartup?(nowMs: number): Promise<readonly StartupReconciliation[]>;
}

export type StartupReconciliation = {
  issueId: string;
  action: "resume" | "advanced" | "preservation-unknown";
  reason: string;
};
