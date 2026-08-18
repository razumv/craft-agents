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
  model: {
    connection: "chatgpt-plus";
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
  modelConnection: "chatgpt-plus";
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

export interface MaterialEvent {
  sequence: number;
  atMs: number;
  state: LifecycleState;
  message: string;
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
  branchUrl: string | null;
  prUrl: string | null;
  deploymentUrl: string | null;
  lastMaterialEvent: MaterialEvent | null;
  blocker: string | null;
  nextCompletionPoint: string;
  ownerGate: { id: string; command: `APPROVE ${string}` } | null;
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
