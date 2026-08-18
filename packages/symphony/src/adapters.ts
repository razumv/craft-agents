// SPDX-License-Identifier: Apache-2.0

import {
  assertLifecycleTransition,
  isRetryableFailure,
  isTerminalState,
  type Claim,
  type FailureClass,
  type IssueContract,
  type LifecycleState,
  type MaterialEvidence,
  type NormalizedIssue,
  type RunIdentity,
  type TrackerIssueSnapshot,
  type WorkflowConfig,
} from "./domain";

function clone<T>(value: T): T {
  return structuredClone(value);
}

export class FakeGitHubAdapter {
  readonly #issues = new Map<string, TrackerIssueSnapshot>();
  #eventSequence = 0;
  claimSuccessCount = 0;

  seed(issue: NormalizedIssue, contract: IssueContract, baseSha = "0".repeat(40)): void {
    if (this.#issues.has(issue.id)) throw new Error(`duplicate fake GitHub issue ${issue.id}`);
    this.#issues.set(issue.id, {
      issue: clone(issue),
      contract: clone(contract),
      version: 1,
      baseSha,
      claim: null,
      retry: null,
      evidence: {},
      events: [{ sequence: ++this.#eventSequence, atMs: 0, state: issue.state, message: "issue seeded" }],
    });
  }

  async fetchIssuesByStates(states: readonly LifecycleState[]): Promise<TrackerIssueSnapshot[]> {
    if (states.length === 0) return [];
    const wanted = new Set(states);
    return [...this.#issues.values()].filter((entry) => wanted.has(entry.issue.state)).map(clone);
  }

  async fetchIssuesByIds(ids: readonly string[]): Promise<TrackerIssueSnapshot[]> {
    if (ids.length === 0) return [];
    return [...new Set(ids)].flatMap((id) => {
      const entry = this.#issues.get(id);
      return entry ? [clone(entry)] : [];
    });
  }

  activeClaims(): TrackerIssueSnapshot[] {
    return [...this.#issues.values()].filter((entry) => entry.claim !== null).map(clone);
  }

  get(issueId: string): TrackerIssueSnapshot {
    const entry = this.#issues.get(issueId);
    if (!entry) throw new Error(`unknown fake GitHub issue ${issueId}`);
    return clone(entry);
  }

  tryClaim(issueId: string, expectedVersion: number, proposed: Claim, nowMs: number): TrackerIssueSnapshot | null {
    const entry = this.#issues.get(issueId);
    if (!entry || entry.version !== expectedVersion || entry.claim !== null) return null;
    if (this.activeClaims().length >= 1) return null;
    if (entry.issue.state !== "ready" && entry.issue.state !== "retry-wait") return null;
    if (entry.issue.state === "retry-wait" && (!entry.retry || entry.retry.dueAtMs > nowMs)) return null;
    if (proposed.issueId !== issueId || proposed.attempt !== (entry.retry?.attempt ?? 1)) return null;

    assertLifecycleTransition(entry.issue.state, "claimed");
    entry.issue.state = "claimed";
    entry.claim = clone(proposed);
    entry.retry = null;
    entry.version += 1;
    this.claimSuccessCount += 1;
    this.event(entry, nowMs, "claimed", `attempt ${proposed.attempt} atomically claimed`);
    return clone(entry);
  }

  markRunning(fence: string, nowMs: number): TrackerIssueSnapshot {
    const entry = this.byFence(fence);
    assertLifecycleTransition(entry.issue.state, "running");
    entry.issue.state = "running";
    entry.claim!.heartbeatAtMs = nowMs;
    entry.claim!.expiresAtMs = nowMs + (entry.claim!.expiresAtMs - entry.claim!.claimedAtMs);
    entry.version += 1;
    this.event(entry, nowMs, "running", `attempt ${entry.claim!.attempt} running`);
    return clone(entry);
  }

  heartbeat(fence: string, nowMs: number, ttlMs: number): void {
    const entry = this.byFence(fence);
    entry.claim!.heartbeatAtMs = nowMs;
    entry.claim!.expiresAtMs = nowMs + ttlMs;
    entry.version += 1;
  }

  failClaim(
    fence: string,
    failureClass: FailureClass,
    reason: string,
    nowMs: number,
    scheduler: WorkflowConfig["scheduler"],
  ): TrackerIssueSnapshot {
    const entry = this.byFence(fence);
    const claim = entry.claim!;
    const retryable = isRetryableFailure(failureClass) && claim.attempt < scheduler.maxAttempts;
    const nextState: LifecycleState = retryable ? "retry-wait" : "failed";
    assertLifecycleTransition(entry.issue.state, nextState);
    entry.issue.state = nextState;
    entry.claim = null;
    if (retryable) {
      const delay = Math.min(scheduler.retryBaseMs * 2 ** (claim.attempt - 1), scheduler.retryMaxMs);
      entry.retry = {
        attempt: claim.attempt + 1,
        dueAtMs: nowMs + delay,
        failureClass,
        reason,
      };
    } else {
      entry.retry = null;
    }
    entry.version += 1;
    this.event(entry, nowMs, nextState, retryable ? `retry scheduled: ${reason}` : `attempt failed: ${reason}`);
    return clone(entry);
  }

  transition(
    issueId: string,
    to: LifecycleState,
    nowMs: number,
    options: { fence?: string; message?: string; evidence?: MaterialEvidence } = {},
  ): TrackerIssueSnapshot {
    const entry = this.#issues.get(issueId);
    if (!entry) throw new Error(`unknown fake GitHub issue ${issueId}`);
    if (entry.claim && options.fence !== entry.claim.fence) throw new Error("claim fence mismatch");
    assertLifecycleTransition(entry.issue.state, to);
    const evidence = { ...entry.evidence, ...clone(options.evidence ?? {}) };
    if (to === "pr-open" && !evidence.prUrl) throw new Error("pr-open requires PR evidence");
    if (to === "owner-gate" && !evidence.ownerGateId) throw new Error("owner-gate requires an immutable gate ID");
    if (to === "merged" && entry.contract.risk === "high" && entry.issue.state !== "owner-gate") {
      throw new Error("high-risk merge requires owner-gate state");
    }
    if (to === "deployed" && !evidence.deploymentUrl) throw new Error("deployed requires deployment evidence");
    if (to === "done" && entry.contract.deployAuthority !== "none" && entry.issue.state !== "deployed") {
      throw new Error(`${entry.contract.deployAuthority} work requires deployed state before done`);
    }
    entry.issue.state = to;
    entry.evidence = evidence;
    if (isTerminalState(to) || to === "blocked") entry.claim = null;
    entry.version += 1;
    this.event(entry, nowMs, to, options.message ?? `transitioned to ${to}`);
    return clone(entry);
  }

  private byFence(fence: string): TrackerIssueSnapshot {
    const entry = [...this.#issues.values()].find((candidate) => candidate.claim?.fence === fence);
    if (!entry) throw new Error("claim fence is stale or unknown");
    return entry;
  }

  private event(entry: TrackerIssueSnapshot, atMs: number, state: LifecycleState, message: string): void {
    entry.events.push({ sequence: ++this.#eventSequence, atMs, state, message });
  }
}

export interface FakeWorkspace {
  workspaceId: string;
  workspacePath: string;
  issueId: string;
  attempt: number;
}

export class FakeWorkspaceAdapter {
  readonly #byId = new Map<string, FakeWorkspace>();
  readonly #byAttempt = new Map<string, FakeWorkspace>();

  async ensure(identity: RunIdentity): Promise<FakeWorkspace> {
    const attemptKey = `${identity.issueId}:${identity.attempt}`;
    const existing = this.#byAttempt.get(attemptKey);
    if (existing) {
      if (existing.workspaceId !== identity.workspaceId || existing.workspacePath !== identity.workspacePath) {
        throw new Error("attempt already has a different workspace identity");
      }
      return clone(existing);
    }
    if (this.#byId.has(identity.workspaceId)) throw new Error("workspace identity collision");
    const workspace = {
      workspaceId: identity.workspaceId,
      workspacePath: identity.workspacePath,
      issueId: identity.issueId,
      attempt: identity.attempt,
    };
    this.#byId.set(workspace.workspaceId, workspace);
    this.#byAttempt.set(attemptKey, workspace);
    return clone(workspace);
  }

  count(): number {
    return this.#byId.size;
  }
}

export type FakeSessionStatus = "running" | "succeeded" | "failed";
export interface FakeCraftSession {
  sessionId: string;
  issueId: string;
  attempt: number;
  workspaceId: string;
  status: FakeSessionStatus;
}

export class FakeCraftAdapter {
  readonly #byId = new Map<string, FakeCraftSession>();
  readonly #byAttempt = new Map<string, FakeCraftSession>();

  async ensure(identity: RunIdentity): Promise<FakeCraftSession> {
    const attemptKey = `${identity.issueId}:${identity.attempt}`;
    const existing = this.#byAttempt.get(attemptKey);
    if (existing) {
      if (existing.sessionId !== identity.sessionId || existing.workspaceId !== identity.workspaceId) {
        throw new Error("attempt already has a different session identity");
      }
      return clone(existing);
    }
    if (this.#byId.has(identity.sessionId)) throw new Error("session identity collision");
    const session = {
      sessionId: identity.sessionId,
      issueId: identity.issueId,
      attempt: identity.attempt,
      workspaceId: identity.workspaceId,
      status: "running" as const,
    };
    this.#byId.set(session.sessionId, session);
    this.#byAttempt.set(attemptKey, session);
    return clone(session);
  }

  get(sessionId: string): FakeCraftSession | null {
    const session = this.#byId.get(sessionId);
    return session ? clone(session) : null;
  }

  setStatus(sessionId: string, status: FakeSessionStatus): void {
    const session = this.#byId.get(sessionId);
    if (!session) throw new Error(`unknown fake Craft session ${sessionId}`);
    session.status = status;
  }

  count(): number {
    return this.#byId.size;
  }
}
