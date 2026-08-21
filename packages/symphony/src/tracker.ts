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

export type LifecycleDecisionResult =
  | { accepted: true; snapshot: TrackerIssueSnapshot; reason: string }
  | { accepted: false; snapshot: TrackerIssueSnapshot; reason: string };

/** Provider-independent durable tracker boundary used by the deterministic scheduler. */
/**
 * An open issue in the configured repository that the lane does NOT manage: no
 * lifecycle label, so no contract, no claim, and nothing the scheduler can
 * dispatch. It exists so a surface can show the repository as it is instead of
 * only the slice that has already been contracted — a board that shows nothing
 * but the lane's own queue quietly reports an empty project as a finished one.
 */
export interface TrackerBacklogIssue {
  id: string;
  identifier: string;
  number: number;
  title: string;
  /** The issue's own text. Grooming may quote it, but must not augment it. */
  description: string;
  url: string | null;
  labels: string[];
  priority: number | null;
  createdAt: string | null;
  updatedAt: string | null;
  /** Native open/closed blocker relations, read directly from the tracker. */
  blockedBy: { id: string; identifier: string; state: "OPEN" | "CLOSED"; title: string; url: string }[];
  /** Native parent relation when the tracker exposes one. */
  parent: { id: string; identifier: string; state: "OPEN" | "CLOSED"; title: string; url: string } | null;
}

export interface TrackerAdapter {
  fetchIssuesByStates(states: readonly LifecycleState[]): Promise<TrackerIssueSnapshot[]>;
  /** Open, unmanaged issues. Optional: a tracker may have no notion of them. */
  fetchBacklog?(): Promise<TrackerBacklogIssue[]>;
  /**
   * Merge the open pull request that closes this issue, when the tracker's own
   * evidence says it is safe to: mergeable, and covered by checks that actually
   * ran and passed. Returns why it declined, so a caller can say so out loud
   * rather than silently doing nothing. Optional capability.
   */
  mergeClosingPullRequest?(issueId: string): Promise<{ merged: boolean; reason: string }>;

  /**
   * Whether the closing pull request could be merged right now, and the head
   * commit it would land. Asked separately from merging, so an owner gate can be
   * raised on the provider's own evidence without anything being landed.
   */
  mergeReadiness?(issueId: string): Promise<{ ready: boolean; reason: string; headSha: string }>;
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
  /** Owner decision: failed work gets a fresh attempt budget because this exact fact changed. */
  reviveFailed(issueId: string, justification: string, nowMs: number): Awaitable<LifecycleDecisionResult>;
  /** Owner decision: failed work intentionally continued at this exact successor reference. */
  supersedeFailed(issueId: string, successor: string, nowMs: number): Awaitable<LifecycleDecisionResult>;
  transition(
    issueId: string,
    to: LifecycleState,
    nowMs: number,
    options?: TrackerTransitionOptions,
  ): Awaitable<TrackerIssueSnapshot>;
  reconcileStartup?(nowMs: number): Promise<readonly StartupReconciliation[]>;
  /**
   * Ordinary-tick counterpart of {@link reconcileStartup}: advances active
   * claims purely on durable provider evidence, so terminal synchronization no
   * longer depends on a live executing session. Idempotent and fail-closed —
   * nothing moves without exact evidence.
   */
  advanceByEvidence?(nowMs: number): Promise<readonly StartupReconciliation[]>;
}

export type StartupReconciliation = {
  issueId: string;
  action: "resume" | "advanced" | "preservation-unknown";
  reason: string;
};
