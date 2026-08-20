// SPDX-License-Identifier: Apache-2.0

export const lifecycleStates = [
  "ready",
  "claimed",
  "running",
  "pr-open",
  "review",
  "owner-gate",
  "merged",
  "deployed",
  "done",
  "blocked",
  "retry-wait",
  "failed",
  "cancelled",
  "preservation-unknown",
] as const;

export type LifecycleState = (typeof lifecycleStates)[number];
export type RiskTier = "low" | "medium" | "high";
export type DeployAuthority = "none" | "dev" | "production-gated";
export type FailureClass = "transient" | "runtime" | "contract" | "policy" | "preservation";

export interface BlockerRef {
  id: string | null;
  identifier: string | null;
  state: string | null;
}

export interface NormalizedIssue {
  id: string;
  nativeRef: Record<string, unknown> | null;
  identifier: string;
  title: string;
  description: string | null;
  priority: number | null;
  state: LifecycleState;
  branchName: string | null;
  url: string | null;
  assigneeId: string | null;
  labels: string[];
  blockedBy: BlockerRef[];
  dispatchable: boolean;
  /**
   * Whether the tracker itself considers the issue closed. Distinct from the
   * lifecycle state: a run can end `failed` on an issue a merge then closed,
   * and a surface that cannot tell those apart keeps asking for attention that
   * nobody can act on.
   */
  closed: boolean;
  createdAt: string | null;
  updatedAt: string | null;
}

export interface IssueContract {
  id: string;
  projectId: string;
  repository: string;
  goal: string;
  acceptance: string[];
  nonGoals: string[];
  risk: RiskTier;
  deployAuthority: DeployAuthority;
  requiredBranch: string;
  baseBranch: string;
  dependencies: string[];
  ownerDirectiveRefs: string[];
  modelProfile: string;
  verificationBudget: string;
}

export interface VerificationBudget {
  budget: string;
  independentReviews: 0 | 1;
  correctionPasses: 0 | 1;
  ownerGate: boolean;
}

export interface WorkflowConfig {
  version: "4.1";
  project: {
    id: string;
    repository: string;
    baseBranch: string;
    branchPrefix: string;
  };
  tracker: {
    kind: "fake-github" | "github";
    activeStates: LifecycleState[];
    terminalStates: LifecycleState[];
  };
  polling: { intervalMs: number };
  scheduler: {
    wipLimit: 1;
    claimTtlMs: number;
    staleRunMs: number;
    maxAttempts: number;
    retryBaseMs: number;
    retryMaxMs: number;
  };
  workspace: { root: string };
  /**
   * Closing the loop without a human: when the tracker's own evidence says a
   * pull request is mergeable and its checks actually ran and passed, merge it.
   * Absent → never. `maxRisk` is a ceiling on the contract's declared risk, so
   * anything above it still waits for a person no matter how green it looks.
   */
  autoMerge?: { enabled: boolean; maxRisk: RiskTier };
  model: {
    /** Primary connection (attempt 1). */
    connection: string;
    /**
     * Optional failover chain. Attempt N uses connections[N-1] (clamped to the
     * last entry), so a provider usage limit — classified `runtime`, hence
     * retryable — moves the next attempt to the next account instead of
     * burning the retry budget on the same exhausted quota. Absent → every
     * attempt uses `connection`.
     */
    connections?: string[];
    /**
     * How the chain is used. `failover` (default) keeps attempt 1 on the
     * primary and treats the rest as reserve; `balanced` spreads the starting
     * account across issues so concurrent work does not pile onto one account.
     * Both are pure functions of durable claim inputs.
     */
    connectionStrategy?: "failover" | "balanced";
    defaultProfile: string;
    allowedProfiles: string[];
  };
  verification: Record<RiskTier, VerificationBudget>;
}

export interface WorkflowDefinition {
  config: WorkflowConfig;
  promptTemplate: string;
}

export interface RunIdentity {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  sessionId: string;
  workspaceId: string;
  workspaceKey: string;
  workspacePath: string;
}

export interface Claim {
  issueId: string;
  issueIdentifier: string;
  attempt: number;
  fence: string;
  sessionId: string;
  workspaceId: string;
  workspaceKey: string;
  workspacePath: string;
  baseSha: string;
  modelConnection: string;
  modelProfile: string;
  claimedAtMs: number;
  heartbeatAtMs: number;
  expiresAtMs: number;
}

export interface RetryMetadata {
  attempt: number;
  dueAtMs: number;
  failureClass: FailureClass;
  reason: string;
}

export interface MaterialEvidence {
  branchUrl?: string;
  branchSha?: string;
  prUrl?: string;
  mergeCommitSha?: string;
  mergedAt?: string;
  deploymentUrl?: string;
  blocker?: string;
  ownerGateId?: string;
}

export type LifecycleEventKind = "baseline" | "claim" | "running" | "heartbeat" | "failure" | "transition";

export interface MaterialEvent {
  sequence: number;
  atMs: number;
  state: LifecycleState;
  message: string;
  /** Optional for compatibility with alpha.1 fixtures; new provider events always set it. */
  kind?: LifecycleEventKind;
}

export interface TrackerIssueSnapshot {
  issue: NormalizedIssue;
  contract: IssueContract;
  version: number;
  baseSha: string;
  claim: Claim | null;
  retry: RetryMetadata | null;
  evidence: MaterialEvidence;
  events: MaterialEvent[];
}

export interface ProjectStatus {
  projectId: string;
  issueId: string;
  issueIdentifier: string;
  objective: string;
  state: LifecycleState;
  /**
   * Whether the tracker closed the issue. A terminal `failed` on a closed issue
   * is history — the work was resolved some other way — while the same state on
   * an open issue is still someone's decision to make. Surfaces need the two
   * apart to stop asking for attention nobody can give.
   */
  issueClosed: boolean;
  /** Current attempt (from durable claim or retry metadata); null before the first claim. */
  attempt: number | null;
  /** When the next bounded retry becomes due; only set in retry-wait. */
  retryDueAtMs: number | null;
  /** Most recent material (non-heartbeat) ledger events, oldest first, capped. */
  recentEvents: MaterialEvent[];
  branchUrl: string | null;
  prUrl: string | null;
  deploymentUrl: string | null;
  lastMaterialEvent: MaterialEvent | null;
  blocker: string | null;
  nextCompletionPoint: string;
  ownerGate: {
    id: string;
    /** Backward-compatible exact approve command. */
    command: `APPROVE ${string}`;
    approveCommand: `APPROVE ${string}`;
    rejectCommand: `REJECT ${string}: <reason>`;
  } | null;
}

const normalTransitions: Record<LifecycleState, readonly LifecycleState[]> = {
  ready: ["claimed", "blocked", "cancelled"],
  claimed: ["running", "retry-wait", "blocked", "failed", "cancelled", "preservation-unknown"],
  running: ["pr-open", "retry-wait", "blocked", "failed", "cancelled", "preservation-unknown"],
  "pr-open": ["review", "owner-gate", "merged", "blocked", "failed", "cancelled", "preservation-unknown"],
  review: ["owner-gate", "merged", "blocked", "failed", "cancelled", "preservation-unknown"],
  "owner-gate": ["merged", "blocked", "failed", "cancelled", "preservation-unknown"],
  merged: ["deployed", "done", "preservation-unknown"],
  deployed: ["done", "preservation-unknown"],
  done: [],
  blocked: ["ready", "cancelled"],
  "retry-wait": ["claimed", "failed", "cancelled"],
  failed: [],
  cancelled: [],
  "preservation-unknown": [],
};

export function assertLifecycleTransition(from: LifecycleState, to: LifecycleState): void {
  if (!normalTransitions[from].includes(to)) {
    throw new Error(`illegal lifecycle transition: ${from} -> ${to}`);
  }
}

export function isTerminalState(state: LifecycleState): boolean {
  return ["done", "failed", "cancelled", "preservation-unknown"].includes(state);
}

export function isRetryableFailure(failureClass: FailureClass): boolean {
  return failureClass === "transient" || failureClass === "runtime";
}
