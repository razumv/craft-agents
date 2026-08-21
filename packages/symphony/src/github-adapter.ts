// SPDX-License-Identifier: Apache-2.0

import {
  assertLifecycleTransition,
  isRetryableFailure,
  isTerminalState,
  lifecycleStates,
  type Claim,
  type FailureClass,
  type IssueContract,
  type LifecycleState,
  type MaterialEvidence,
  type NormalizedIssue,
  type RetryMetadata,
  type TrackerIssueSnapshot,
  type WorkflowConfig,
} from "./domain";
import { parseIssueContract } from "./contract";
import {
  appliedGroomingBody,
  groomingAttributionComment,
  type GroomingApplyReport,
  type GroomingApplyStep,
  type GroomingProposal,
} from "./grooming";
import type {
  GitHubComment,
  GitHubIssueLink,
  GitHubIssueRecord,
  GitHubProjectFieldValue,
  GitHubProjectItem,
  GitHubPullRequestEvidence,
  GitHubTransport,
  Page,
} from "./github-transport";
import {
  ciRepairAttemptComment,
  parseCiRepairAttemptComment,
  type CiFailureDetail,
  type CiRepairAttempt,
} from "./ci-repair";
import type {
  LifecycleDecisionResult,
  StartupReconciliation,
  TrackerAdapter,
  TrackerBacklogIssue,
  TrackerTransitionOptions,
} from "./tracker";
import { claimBindingsEqual, type WorkspaceTruthReader } from "./workspace-truth";

const eventPrefix = "<!-- craft-protocol-v4:event\n";
const fencePrefix = "<!-- craft-protocol-v4:wip-fence\n";
const eventSuffix = "\n-->";
const ledgerSchema = "craft-protocol/v4/github-event@1";
const fenceSchema = "craft-protocol/v4/wip-fence@1";

export interface GitHubStateProjection {
  label: string;
  projectStatusOptionId: string;
}

export interface GitHubAdapterConfig {
  repository: string;
  projectId: string;
  claimFenceIssueId: string;
  statusFieldId: string;
  gateFieldId: string;
  requiredLabels: string[];
  states: Record<LifecycleState, GitHubStateProjection>;
  workflow: WorkflowConfig;
  eventAuthorLogin?: string;
  onDiagnostic?: (message: string) => void;
}

interface LedgerEvent {
  schema: typeof ledgerSchema;
  issueId: string;
  expectedVersion: number;
  operation: "claim" | "running" | "heartbeat" | "failure" | "transition" | "revival" | "supersession";
  from: LifecycleState;
  to: LifecycleState;
  atMs: number;
  fence: string | null;
  claim: Claim | null;
  retry: RetryMetadata | null;
  evidence: MaterialEvidence;
  message: string;
  /** Null on ordinary events and on pre-revival ledgers. */
  justification?: string | null;
  /** Null on ordinary events and on pre-supersession ledgers. */
  successor?: string | null;
}

interface SharedFenceEvent {
  schema: typeof fenceSchema;
  operation: "acquire" | "heartbeat" | "release";
  issueId: string;
  fence: string;
  atMs: number;
  expiresAtMs: number;
}

interface SharedFenceState {
  lease: SharedFenceEvent | null;
  acceptedCommentIds: Set<number>;
}

interface Hydrated {
  snapshot: TrackerIssueSnapshot;
  providerEvidence: MaterialEvidence;
  record: GitHubIssueRecord;
  item: GitHubProjectItem;
  labels: string[];
  acceptedCommentIds: Set<number>;
  projectionDrift: boolean;
}

interface CoreHydrated extends Hydrated {
  contract: IssueContract;
  nativeBlockers: GitHubIssueLink[];
}

export class GitHubIssuesProjectsAdapter implements TrackerAdapter {
  readonly #managedLabels: Set<string>;
  /** In-memory only: a restart deliberately pays for a complete recovery read. */
  #watermark: string | null = null;
  #records = new Map<string, GitHubIssueRecord>();
  #hydrated = new Map<string, CoreHydrated>();
  #backlog = new Map<string, TrackerBacklogIssue>();
  /** Serializes the shared in-memory observation used by parallel status reads. */
  #stateTail: Promise<void> = Promise.resolve();

  constructor(
    readonly config: GitHubAdapterConfig,
    readonly transport: GitHubTransport,
    readonly workspaceTruth: WorkspaceTruthReader,
  ) {
    if (config.repository !== config.workflow.project.repository) {
      throw new Error("GitHub adapter repository must match workflow project repository");
    }
    if (!config.claimFenceIssueId.trim()) throw new Error("GitHub adapter requires a shared claim-fence issue ID");
    const labels = lifecycleStates.map((state) => normalizeLabel(config.states[state]?.label));
    if (labels.some((label) => !label)) {
      throw new Error("every lifecycle state requires a non-empty GitHub label");
    }
    if (lifecycleStates.some((state) => !config.states[state]?.projectStatusOptionId.trim())) {
      throw new Error("every lifecycle state requires an exact Project status option ID");
    }
    this.#managedLabels = new Set(labels);
  }

  async fetchIssuesByStates(states: readonly LifecycleState[]): Promise<TrackerIssueSnapshot[]> {
    if (states.length === 0) return [];
    const wanted = new Set(states);
    const hydrated = await this.loadAll(false);
    return [...hydrated.values()].map((entry) => entry.snapshot).filter((entry) => wanted.has(entry.issue.state));
  }

  /**
   * Open issues the lane does not manage, built from the same repository listing
   * that discovery uses. Labels, body, creation time, priority and parent ride
   * on that listing; native blocker edges are read only for the resulting
   * backlog candidates. Unknown/truncated labels are omitted rather than
   * guessed at, so a managed issue can never be mistaken for backlog.
   */
  async applyGrooming(proposal: GroomingProposal): Promise<GroomingApplyReport> {
    if (proposal.outcome === "refused") {
      return { outcome: "refused", writes: 0, reason: proposal.refusal.message };
    }
    const identifier = proposal.candidate.identifier;
    let writes = 0;
    const failed = (step: GroomingApplyStep, error: unknown): GroomingApplyReport => ({
      outcome: "failed", writes, issueIdentifier: identifier, step, error: errorMessage(error),
    });

    try {
      if (proposal.repository !== this.config.repository || proposal.contract.repository !== this.config.repository) {
        throw new Error("grooming proposal repository does not match adapter repository");
      }
      const [fresh] = await this.transport.getIssuesByNodeIds([proposal.candidate.id]);
      if (!fresh || fresh.number !== proposal.candidate.number || fresh.state !== "OPEN") {
        throw new Error("grooming candidate is missing, changed identity, or no longer open");
      }
      const labels = await collectPages((cursor) => this.transport.listLabels(fresh.id, cursor));
      try {
        parseIssueContract(fresh.body, identifier, this.config.workflow);
        return { outcome: "already-present", writes: 0, issueIdentifier: identifier };
      } catch {
        // No parser-valid contract exists yet. Apply may proceed only if the
        // issue text used to ground the proposal has not changed meanwhile.
      }
      const lifecycle = labels.filter((label) => this.#managedLabels.has(normalizeLabel(label)));
      if (lifecycle.length) {
        return { outcome: "lifecycle-present", writes: 0, issueIdentifier: identifier, labels: lifecycle };
      }
      if (fresh.body !== proposal.candidate.description) {
        throw new Error("grooming candidate body changed after proposal");
      }
      const items = (await collectPages((cursor) => this.transport.listProjectItems(fresh.id, cursor)))
        .filter((item) => item.projectId === this.config.projectId);
      if (items.length !== 1) throw new Error(`expected exactly one configured Project item, found ${items.length}`);
      const baselineSha = await this.transport.getBaseSha(this.config.repository, proposal.contract.baseBranch);
      const body = appliedGroomingBody(fresh.body, proposal.contractMarkdown);

      try {
        const updated = await this.transport.updateIssueBody(
          this.config.repository, fresh.number, body, fresh.updatedAt,
        );
        if (!updated) throw new Error("grooming body compare-and-set conflict");
        writes += 1;
      } catch (error) { return failed("body", error); }

      let readback: GitHubIssueRecord | null = null;
      try {
        [readback] = await this.transport.getIssuesByNodeIds([fresh.id]);
        if (!readback || readback.body !== body) throw new Error("written grooming body did not read back exactly");
        parseIssueContract(readback.body, identifier, this.config.workflow);
      } catch (error) { return failed("readback", error); }

      try {
        await this.transport.appendComment(fresh.id, groomingAttributionComment(identifier, this.config.repository, baselineSha));
        writes += 1;
      } catch (error) { return failed("attribution", error); }

      try {
        await this.transport.updateProjectSingleSelect(
          this.config.projectId,
          items[0]!.id,
          this.config.statusFieldId,
          this.config.states.ready.projectStatusOptionId,
        );
        writes += 1;
      } catch (error) { return failed("status", error); }

      try {
        await this.transport.replaceLabels(
          this.config.repository,
          fresh.number,
          [...labels, this.config.states.ready.label],
        );
        writes += 1;
      } catch (error) { return failed("label", error); }

      return { outcome: "applied", writes: 4, issueIdentifier: identifier, baselineSha };
    } catch (error) {
      return failed("preflight", error);
    }
  }

  async fetchBacklog(): Promise<TrackerBacklogIssue[]> {
    return this.#withStateLock(async () => {
      const scan = await this.#scanRecords(new Set());
      const backlog = new Map(this.#backlog);
      const candidateIds = new Set<string>();
      for (const record of scan.records.values()) {
        const candidate = record.id !== this.config.claimFenceIssueId
          && record.state === "OPEN"
          && this.#listingHasNoLifecycleLabel(record);
        if (!candidate) {
          backlog.delete(record.id);
          continue;
        }
        candidateIds.add(record.id);
        const cached = backlog.get(record.id);
        if (!scan.changedIds.has(record.id) && cached?.updatedAt === record.updatedAt) continue;
        const blockedBy = await collectPages((cursor) => this.transport.listBlockedBy(record.id, cursor));
        const relation = (issue: GitHubIssueLink) => ({
          id: issue.id,
          identifier: `${this.config.repository}#${issue.number}`,
          state: issue.state,
          title: issue.title,
          url: issue.url,
        });
        backlog.set(record.id, {
          id: record.id,
          identifier: `${this.config.repository}#${record.number}`,
          number: record.number,
          title: record.title,
          description: record.body,
          url: record.url ?? null,
          labels: [...(record.labelNames ?? [])],
          priority: Number.isInteger(record.priority) ? record.priority! : null,
          createdAt: record.createdAt ?? null,
          updatedAt: record.updatedAt ?? null,
          blockedBy: blockedBy.map(relation),
          parent: record.parent ? relation(record.parent) : null,
        });
      }
      for (const id of backlog.keys()) {
        if (!candidateIds.has(id)) backlog.delete(id);
      }
      // Commit only after every provider read needed for this backlog succeeds.
      this.#records = scan.records;
      this.#backlog = backlog;
      this.#watermark = scan.watermark;
      return [...backlog.values()];
    });
  }

  /**
   * Merge the open closing PR for an issue, refusing unless the provider's own
   * evidence justifies it. Every refusal names itself: an auto-merge that stays
   * quiet about declining is indistinguishable from one that is not running.
   */
  /**
   * The same evidence the merge path requires, reported without merging. One
   * definition of "landable" for both, so a gate can never be raised on a pull
   * request that auto-merge would have refused, and vice versa.
   */
  async ciRepairAttempts(issueId: string, pullRequestId?: string): Promise<CiRepairAttempt[]> {
    const comments = await collectPages((cursor) => this.transport.listComments(issueId, cursor));
    const records = comments.flatMap((comment) => {
      if (this.config.eventAuthorLogin && comment.authorLogin !== this.config.eventAuthorLogin) return [];
      const record = parseCiRepairAttemptComment(comment.body);
      if (!record || record.issueId !== issueId || (pullRequestId && record.pullRequestId !== pullRequestId)) return [];
      return [record];
    });
    const attempts = records.map((record) => record.attempt).sort((left, right) => left.attempt - right.attempt);
    for (let index = 0; index < attempts.length; index += 1) {
      if (attempts[index]!.attempt !== index + 1) throw new Error("CI repair attempt ledger is duplicated or non-sequential");
    }
    return attempts;
  }

  async recordCiRepairAttempt(issueId: string, pullRequestId: string, attempt: CiRepairAttempt): Promise<void> {
    return this.#withStateLock(async () => {
      const existing = await this.ciRepairAttempts(issueId, pullRequestId);
      if (attempt.attempt !== existing.length + 1 || existing.length >= 2) {
        throw new Error("CI repair attempt is duplicated, out of sequence, or above the two-attempt cap");
      }
      const body = ciRepairAttemptComment(issueId, pullRequestId, attempt);
      const written = await this.transport.appendComment(issueId, body);
      if (written.body !== body || (this.config.eventAuthorLogin && written.authorLogin !== this.config.eventAuthorLogin)) {
        throw new Error("CI repair attempt record did not read back exactly from the configured provider author");
      }
    });
  }

  async ciFailure(issueId: string): Promise<CiFailureDetail | null> {
    const detailed = await this.detailed(issueId);
    const contract = detailed.snapshot.contract;
    const prs = (await collectPages((cursor) => this.transport.listClosingPullRequests(issueId, cursor))).filter((pr) => (
      pr.state === "OPEN"
      && pr.headRefName === contract.requiredBranch
      && pr.baseRefName === contract.baseBranch
    ));
    if (prs.length !== 1) return null;
    const pr = prs[0]!;
    if (pr.checkRollupState !== "FAILURE" && pr.checkRollupState !== "ERROR") return null;
    const failures = await this.transport.listFailedCheckDetails(this.config.repository, pr.headRefOid);
    if (failures.length === 0) return null;
    const failure = failures[0]!;
    return {
      pullRequestId: pr.id,
      pullRequestUrl: pr.url,
      headBranch: pr.headRefName,
      headSha: pr.headRefOid,
      checkName: failure.checkName,
      checkUrl: failure.checkUrl,
      command: failure.command,
      output: failure.output,
    };
  }

  async mergeReadiness(issueId: string): Promise<{ ready: boolean; reason: string; headSha: string }> {
    const verdict = await this.landableClosingPullRequest(issueId);
    return verdict.pr
      ? { ready: verdict.ready, reason: verdict.reason, headSha: verdict.pr.headRefOid }
      : { ready: false, reason: verdict.reason, headSha: "" };
  }

  private async landableClosingPullRequest(issueId: string): Promise<{ ready: boolean; reason: string; pr: GitHubPullRequestEvidence | null }> {
    const detailed = await this.detailed(issueId);
    const contract = detailed.snapshot.contract;
    const prs = await collectPages((cursor) => this.transport.listClosingPullRequests(issueId, cursor));
    const candidates = prs.filter((pr) => (
      pr.headRefName === contract.requiredBranch
      && pr.baseRefName === contract.baseBranch
    ));
    if (candidates.length !== 1) return { ready: false, reason: `expected exactly one closing PR, found ${candidates.length}`, pr: null };
    const pr = candidates[0]!;
    if (pr.state === "MERGED") return { ready: false, reason: "already merged", pr };
    if (pr.state !== "OPEN") return { ready: false, reason: `pull request is ${pr.state}`, pr };
    if (pr.mergeable !== "MERGEABLE") return { ready: false, reason: `mergeability is ${pr.mergeable}`, pr };
    // Today's lesson, encoded: a repository whose workflow does not trigger on
    // this base branch reports NO checks, and reading that as green merges an
    // unverified change. Absence of checks is never success.
    if (pr.checkCount < 1) return { ready: false, reason: "no checks ran on the head commit", pr };
    if (pr.checkRollupState !== "SUCCESS") return { ready: false, reason: `checks are ${pr.checkRollupState ?? "absent"}`, pr };
    return { ready: true, reason: "mergeable with passing checks", pr };
  }

  async mergeClosingPullRequest(issueId: string): Promise<{ merged: boolean; reason: string }> {
    const verdict = await this.landableClosingPullRequest(issueId);
    if (!verdict.ready || !verdict.pr) return { merged: false, reason: verdict.reason };
    const detailed = await this.detailed(issueId);
    await this.transport.mergePullRequest(
      verdict.pr.id,
      `${detailed.snapshot.contract.goal.slice(0, 60)} (${detailed.snapshot.issue.identifier})`,
    );
    return { merged: true, reason: verdict.reason };
  }


  async fetchIssuesByIds(ids: readonly string[]): Promise<TrackerIssueSnapshot[]> {
    if (ids.length === 0) return [];
    const unique = [...new Set(ids)];
    const hydrated = await this.loadAll(true, new Set(unique));
    const snapshots = unique.flatMap((id) => {
      const entry = hydrated.get(id);
      return entry ? [entry.snapshot] : [];
    });
    if (snapshots.length !== unique.length) throw new Error("GitHub ID refresh omitted a requested issue");
    return snapshots;
  }

  async activeClaims(): Promise<TrackerIssueSnapshot[]> {
    // Active reconciliation is strict: omitting a malformed active item could release WIP and duplicate a run.
    const wanted = new Set(this.config.workflow.tracker.activeStates);
    const active = [...(await this.loadAll(true)).values()]
      .map((entry) => entry.snapshot)
      .filter((entry) => wanted.has(entry.issue.state));
    for (const entry of active) {
      if (entry.issue.state === "retry-wait" && !entry.retry) {
        throw new Error(`active GitHub issue ${entry.issue.identifier} lacks durable retry metadata`);
      }
      if (!["ready", "retry-wait", "done"].includes(entry.issue.state) && !entry.claim) {
        throw new Error(`active GitHub issue ${entry.issue.identifier} lacks a durable claim binding`);
      }
    }
    return active.filter((entry) => entry.claim !== null);
  }

  async get(issueId: string): Promise<TrackerIssueSnapshot> {
    const [snapshot] = await this.fetchIssuesByIds([issueId]);
    if (!snapshot) throw new Error(`unknown GitHub issue ${issueId}`);
    return snapshot;
  }

  async tryClaim(
    issueId: string,
    expectedVersion: number,
    proposed: Claim,
    nowMs: number,
  ): Promise<TrackerIssueSnapshot | null> {
    const current = await this.detailed(issueId);
    if (current.snapshot.version !== expectedVersion || current.snapshot.claim !== null) return null;
    if (current.snapshot.issue.state !== "ready" && current.snapshot.issue.state !== "retry-wait") return null;
    if (current.snapshot.issue.state === "retry-wait" && (!current.snapshot.retry || current.snapshot.retry.dueAtMs > nowMs)) return null;
    if (proposed.issueId !== issueId || proposed.issueIdentifier !== current.snapshot.issue.identifier) return null;
    if (proposed.attempt !== (current.snapshot.retry?.attempt ?? 1)) return null;
    if (!await this.acquireSharedFence(proposed, nowMs)) return null;
    try {
      const event = nextEvent(current.snapshot, "claim", "claimed", nowMs, proposed.fence, {
        claim: proposed,
        retry: null,
        evidence: current.snapshot.evidence,
        message: `attempt ${proposed.attempt} atomically claimed`,
      });
      const claimed = await this.commit(current, event, true);
      if (!claimed) await this.releaseSharedFence(proposed, nowMs);
      return claimed;
    } catch (error) {
      await this.releaseSharedFence(proposed, nowMs);
      throw error;
    }
  }

  async markRunning(fence: string, nowMs: number): Promise<TrackerIssueSnapshot> {
    const current = await this.byFence(fence);
    if (current.snapshot.issue.state !== "claimed" || !current.snapshot.claim) throw new Error("claim is not startable");
    const claim = { ...current.snapshot.claim, heartbeatAtMs: nowMs };
    const event = nextEvent(current.snapshot, "running", "running", nowMs, fence, {
      claim,
      retry: null,
      evidence: current.snapshot.evidence,
      message: `attempt ${claim.attempt} running`,
    });
    return this.requiredCommit(current, event);
  }

  async heartbeat(fence: string, nowMs: number, ttlMs: number): Promise<void> {
    const current = await this.byFence(fence);
    const claim = current.snapshot.claim;
    if (!claim) throw new Error("claim fence is stale or unknown");
    const event = nextEvent(current.snapshot, "heartbeat", current.snapshot.issue.state, nowMs, fence, {
      claim: { ...claim, heartbeatAtMs: nowMs, expiresAtMs: nowMs + ttlMs },
      retry: current.snapshot.retry,
      evidence: current.snapshot.evidence,
      message: `attempt ${claim.attempt} heartbeat`,
    });
    const updated = await this.requiredCommit(current, event);
    await this.heartbeatSharedFence(updated.claim!, nowMs);
  }

  async failClaim(
    fence: string,
    failureClass: FailureClass,
    reason: string,
    nowMs: number,
    scheduler: WorkflowConfig["scheduler"],
  ): Promise<TrackerIssueSnapshot> {
    const current = await this.byFence(fence);
    const claim = current.snapshot.claim!;
    const retryable = isRetryableFailure(failureClass) && claim.attempt < scheduler.maxAttempts;
    const to: LifecycleState = retryable ? "retry-wait" : "failed";
    const delay = Math.min(scheduler.retryBaseMs * 2 ** (claim.attempt - 1), scheduler.retryMaxMs);
    const retry: RetryMetadata | null = retryable ? {
      attempt: claim.attempt + 1,
      dueAtMs: nowMs + delay,
      failureClass,
      reason,
    } : null;
    const event = nextEvent(current.snapshot, "failure", to, nowMs, fence, {
      claim: null,
      retry,
      evidence: current.snapshot.evidence,
      message: retryable ? `retry scheduled: ${reason}` : `attempt failed: ${reason}`,
    });
    const failed = await this.requiredCommit(current, event);
    await this.releaseSharedFence(claim, nowMs);
    return failed;
  }

  async reviveFailed(issueId: string, justification: string, nowMs: number): Promise<LifecycleDecisionResult> {
    const current = await this.detailed(issueId);
    const namedChange = decisionReference(justification);
    if (!namedChange) {
      return { accepted: false, snapshot: current.snapshot, reason: "revival refused: a named change is required" };
    }
    if (current.snapshot.evidence.mergedAt && current.snapshot.evidence.mergeCommitSha) {
      return {
        accepted: false,
        snapshot: current.snapshot,
        reason: "revival refused: provider merge evidence already records delivery",
      };
    }
    const revivals = current.snapshot.events.filter((event) => event.kind === "revival");
    if (revivals.some((event) => event.justification === namedChange)) {
      return {
        accepted: false,
        snapshot: current.snapshot,
        reason: `revival refused: change already used: ${namedChange}`,
      };
    }
    if (current.snapshot.issue.state !== "failed") {
      return {
        accepted: false,
        snapshot: current.snapshot,
        reason: `revival refused: issue is ${current.snapshot.issue.state}, not failed`,
      };
    }
    if (current.snapshot.issue.closed) {
      return { accepted: false, snapshot: current.snapshot, reason: "revival refused: issue is closed" };
    }
    if (revivals.length >= this.config.workflow.scheduler.maxRevivals) {
      return {
        accepted: false,
        snapshot: current.snapshot,
        reason: `revival refused: configured limit of ${this.config.workflow.scheduler.maxRevivals} reached; issue remains failed`,
      };
    }
    const message = `revived with a fresh attempt budget because ${namedChange}`;
    const event = nextEvent(current.snapshot, "revival", "ready", nowMs, null, {
      claim: null,
      retry: null,
      evidence: current.snapshot.evidence,
      message,
      justification: namedChange,
    });
    return { accepted: true, snapshot: await this.requiredCommit(current, event), reason: message };
  }

  async supersedeFailed(issueId: string, successor: string, nowMs: number): Promise<LifecycleDecisionResult> {
    const current = await this.detailed(issueId);
    const successorRef = decisionReference(successor);
    if (!successorRef) {
      return {
        accepted: false,
        snapshot: current.snapshot,
        reason: "supersession refused: a successor reference is required",
      };
    }
    if (current.snapshot.evidence.mergedAt && current.snapshot.evidence.mergeCommitSha) {
      return {
        accepted: false,
        snapshot: current.snapshot,
        reason: "supersession refused: provider merge evidence already records delivery",
      };
    }
    if (current.snapshot.issue.state !== "failed") {
      return {
        accepted: false,
        snapshot: current.snapshot,
        reason: `supersession refused: issue is ${current.snapshot.issue.state}, not failed`,
      };
    }
    if (current.snapshot.issue.closed) {
      return { accepted: false, snapshot: current.snapshot, reason: "supersession refused: issue is closed" };
    }
    const message = `cancelled because work continued at ${successorRef}`;
    const event = nextEvent(current.snapshot, "supersession", "cancelled", nowMs, null, {
      claim: null,
      retry: null,
      evidence: current.snapshot.evidence,
      message,
      successor: successorRef,
    });
    return { accepted: true, snapshot: await this.requiredCommit(current, event), reason: message };
  }

  async transition(
    issueId: string,
    to: LifecycleState,
    nowMs: number,
    options: TrackerTransitionOptions = {},
  ): Promise<TrackerIssueSnapshot> {
    const current = await this.detailed(issueId);
    if (current.snapshot.issue.state === "failed" && (to === "ready" || to === "cancelled")) {
      throw new Error(`failed -> ${to} requires the explicit revival or supersession decision API`);
    }
    const priorClaim = current.snapshot.claim;
    if (priorClaim && options.fence !== priorClaim.fence) throw new Error("claim fence mismatch");
    const callerEvidence = structuredClone(options.evidence ?? {});
    delete callerEvidence.branchUrl;
    delete callerEvidence.branchSha;
    delete callerEvidence.prUrl;
    delete callerEvidence.mergedAt;
    delete callerEvidence.mergeCommitSha;
    let evidence = { ...current.snapshot.evidence, ...callerEvidence, ...current.providerEvidence };
    if (to === "pr-open" || to === "merged") {
      if (!current.providerEvidence.prUrl) throw new Error(`${to} requires exact provider PR evidence`);
      if (to === "merged" && (!current.providerEvidence.mergedAt || !current.providerEvidence.mergeCommitSha)) {
        throw new Error("merged requires exact provider merge evidence");
      }
      evidence = { ...evidence, ...current.providerEvidence };
    }
    validateTransitionEvidence(current.snapshot, to, evidence);
    const event = nextEvent(current.snapshot, "transition", to, nowMs, options.fence ?? null, {
      claim: isTerminalState(to) || to === "blocked" ? null : priorClaim,
      retry: current.snapshot.retry,
      evidence,
      message: options.message ?? `transitioned to ${to}`,
    });
    const transitioned = await this.requiredCommit(current, event);
    if (priorClaim && !transitioned.claim) await this.releaseSharedFence(priorClaim, nowMs);
    return transitioned;
  }

  async reconcileStartup(nowMs: number): Promise<readonly StartupReconciliation[]> {
    const results: StartupReconciliation[] = [];
    const active = await this.activeClaims();
    for (const snapshot of active.sort((a, b) => a.issue.id.localeCompare(b.issue.id))) {
      const claim = snapshot.claim!;
      const truth = await this.workspaceTruth.inspect(claim);
      if (truth.kind === "ambiguous" || (truth.kind === "bound" && !claimBindingsEqual(claim, truth.binding))) {
        const reason = truth.kind === "ambiguous" ? truth.reason : "filesystem claim binding does not match GitHub claim";
        await this.transition(snapshot.issue.id, "preservation-unknown", nowMs, { fence: claim.fence, message: reason });
        results.push({ issueId: snapshot.issue.id, action: "preservation-unknown", reason });
        continue;
      }
      if (truth.kind === "absent" && snapshot.issue.state !== "claimed") {
        const reason = `${snapshot.issue.state} claim has no durable workspace`;
        await this.transition(snapshot.issue.id, "preservation-unknown", nowMs, { fence: claim.fence, message: reason });
        results.push({ issueId: snapshot.issue.id, action: "preservation-unknown", reason });
        continue;
      }
      // Startup reconciliation used to carry its own copy of the evidence hops,
      // and a copy drifts: every rule added to the real table since — high-risk
      // work merged without its gate going to blocked, a merge after a failed
      // attempt, an issue closed by hand — was missing here. razumv/lineage2-server#94
      // hit exactly that: this path insisted on `merged` for a high-risk contract,
      // the ledger's guard refused it every cycle, and after three refusals the
      // whole project was dropped from the autonomous loop for the night.
      const step = nextEvidenceStep(snapshot);
      if (step) {
        await this.transition(snapshot.issue.id, step.to, nowMs, {
          fence: claim.fence,
          message: `startup reconciliation observed ${step.reason}`,
          evidence: snapshot.evidence,
        });
        results.push({ issueId: snapshot.issue.id, action: "advanced", reason: step.reason });
        continue;
      }
      results.push({ issueId: snapshot.issue.id, action: "resume", reason: truth.kind === "absent" ? "claimed workspace not created yet" : "claim binding matches" });
    }
    return results;
  }

  /**
   * Advances every active claim as far as its durable evidence exactly proves,
   * without consulting the executing session. A dead Craft session used to
   * strand an issue in `pr-open` forever even though the ledger already carried
   * `mergedAt`/`mergeCommitSha`; this runs on every ordinary reconcile instead
   * of once per scheduler lifetime. Fail-closed and idempotent: the hop table
   * only fires on exact evidence, so a second pass is a no-op.
   */
  async advanceByEvidence(nowMs: number): Promise<readonly StartupReconciliation[]> {
    const results: StartupReconciliation[] = [];
    const active = await this.activeClaims();
    for (const snapshot of active.sort((a, b) => a.issue.id.localeCompare(b.issue.id))) {
      results.push(...await this.advanceClaimByEvidence(snapshot, nowMs));
    }
    // An attempt failing and the work landing are different facts, and the state
    // must report the second one. A failure released the claim, so these issues
    // are not "active" and nothing here used to look at them again — leaving
    // razumv/magicmarkets#146 labelled failed with its pull request merged, which
    // is the board telling the owner the opposite of what happened. The failed
    // attempt stays in the ledger history, where a failure belongs.
    for (const entry of [...(await this.loadAll(false)).values()].sort((a, b) => a.snapshot.issue.id.localeCompare(b.snapshot.issue.id))) {
      const snapshot = entry.snapshot;
      if (landedWithoutSaying(snapshot)) {
        if (snapshot.claim) continue;
        results.push(...await this.advanceClaimByEvidence(snapshot, nowMs));
        continue;
      }
      // A person closing an issue is a decision the lane has to respect. It can
      // never be dispatched again — closed is not dispatchable — so an in-flight
      // label on it is a badge that will never change on its own, which is how
      // razumv/lineage2-classic-ue#783 sat closed and labelled retry-wait. There
      // is no merge, so the honest terminal state is cancelled, not done.
      if (!closedWhileInFlight(snapshot)) continue;
      const claim = snapshot.claim;
      await this.transition(snapshot.issue.id, "cancelled", nowMs, {
        ...(claim ? { fence: claim.fence } : {}),
        message: "issue was closed with no merge evidence while its lifecycle state was still in flight",
      });
      results.push({ issueId: snapshot.issue.id, action: "advanced", reason: "closed by hand without a merge" });
    }
    return results;
  }

  private async advanceClaimByEvidence(start: TrackerIssueSnapshot, nowMs: number): Promise<StartupReconciliation[]> {
    const results: StartupReconciliation[] = [];
    let snapshot = start;
    // Bounded so a hypothetical evidence cycle can never spin the tick.
    for (let hop = 0; hop < lifecycleStates.length; hop += 1) {
      const step = nextEvidenceStep(snapshot);
      if (!step) break;
      const from = snapshot.issue.state;
      // A terminal issue has no claim and needs none: there is no run to fence
      // against, only a merge that already happened and a state that has not
      // caught up with it.
      const fence = snapshot.claim?.fence;
      snapshot = await this.transition(snapshot.issue.id, step.to, nowMs, {
        ...(fence ? { fence } : {}),
        message: `durable ${step.reason} advanced ${from} to ${step.to}`,
        evidence: snapshot.evidence,
      });
      results.push({ issueId: snapshot.issue.id, action: "advanced", reason: step.reason });
    }
    return results;
  }

  private async requiredCommit(current: Hydrated, event: LedgerEvent): Promise<TrackerIssueSnapshot> {
    const result = await this.commit(current, event, false);
    if (!result) throw new Error("GitHub compare-and-set conflict");
    return result;
  }

  private async commit(current: Hydrated, event: LedgerEvent, conflictReturnsNull: boolean): Promise<TrackerIssueSnapshot | null> {
    const comment = await this.transport.appendComment(event.issueId, serializeEvent(event));
    const refreshed = await this.detailed(event.issueId);
    if (!refreshed.acceptedCommentIds.has(comment.databaseId)) {
      if (conflictReturnsNull) return null;
      throw new Error("GitHub compare-and-set conflict");
    }
    try {
      await this.project(refreshed);
    } catch (error) {
      throw new Error(`GitHub ledger committed but projection failed: ${errorMessage(error)}`);
    }
    return (await this.detailed(event.issueId)).snapshot;
  }

  private async project(entry: Hydrated): Promise<void> {
    const state = entry.snapshot.issue.state;
    const unmanaged = entry.labels.filter((label) => !this.#managedLabels.has(normalizeLabel(label)));
    await this.transport.replaceLabels(this.config.repository, entry.record.number, [...unmanaged, this.config.states[state].label]);
    await this.transport.updateProjectSingleSelect(
      this.config.projectId,
      entry.item.id,
      this.config.statusFieldId,
      this.config.states[state].projectStatusOptionId,
    );
    if (state === "owner-gate") {
      const gateId = entry.snapshot.evidence.ownerGateId;
      if (!gateId) throw new Error("owner-gate projection lacks exact gate ID");
      await this.transport.updateProjectText(this.config.projectId, entry.item.id, this.config.gateFieldId, gateId);
    }
  }

  private async acquireSharedFence(claim: Claim, nowMs: number): Promise<boolean> {
    const event: SharedFenceEvent = {
      schema: fenceSchema,
      operation: "acquire",
      issueId: claim.issueId,
      fence: claim.fence,
      atMs: nowMs,
      expiresAtMs: claim.expiresAtMs,
    };
    const comment = await this.transport.appendComment(this.config.claimFenceIssueId, serializeFenceEvent(event));
    const state = await this.sharedFenceState();
    return state.acceptedCommentIds.has(comment.databaseId)
      && state.lease?.issueId === claim.issueId
      && state.lease.fence === claim.fence;
  }

  private async heartbeatSharedFence(claim: Claim, nowMs: number): Promise<void> {
    const event: SharedFenceEvent = {
      schema: fenceSchema,
      operation: "heartbeat",
      issueId: claim.issueId,
      fence: claim.fence,
      atMs: nowMs,
      expiresAtMs: claim.expiresAtMs,
    };
    const comment = await this.transport.appendComment(this.config.claimFenceIssueId, serializeFenceEvent(event));
    const state = await this.sharedFenceState();
    if (!state.acceptedCommentIds.has(comment.databaseId) || state.lease?.fence !== claim.fence) {
      throw new Error("shared GitHub WIP fence is stale or owned by another issue");
    }
  }

  private async releaseSharedFence(claim: Claim, nowMs: number): Promise<void> {
    const event: SharedFenceEvent = {
      schema: fenceSchema,
      operation: "release",
      issueId: claim.issueId,
      fence: claim.fence,
      atMs: nowMs,
      expiresAtMs: Math.max(claim.expiresAtMs, nowMs),
    };
    await this.transport.appendComment(this.config.claimFenceIssueId, serializeFenceEvent(event));
    await this.sharedFenceState();
  }

  private async sharedFenceState(): Promise<SharedFenceState> {
    const comments = await collectPages((cursor) => this.transport.listComments(this.config.claimFenceIssueId, cursor));
    return reduceSharedFence(comments, this.config.eventAuthorLogin);
  }

  private async byFence(fence: string): Promise<Hydrated> {
    const all = await this.loadAll(true);
    const found = [...all.values()].find((entry) => entry.snapshot.claim?.fence === fence);
    if (!found) throw new Error("claim fence is stale or unknown");
    return found;
  }

  private async detailed(issueId: string): Promise<Hydrated> {
    const all = await this.loadAll(true, new Set([issueId]));
    const found = all.get(issueId);
    if (!found) throw new Error(`unknown GitHub issue ${issueId}`);
    return found;
  }

  private loadAll(strict: boolean, requested = new Set<string>()): Promise<Map<string, Hydrated>> {
    return this.#withStateLock(async () => {
      const scan = await this.#scanRecords(requested);
      // Work on clones so a failed strict read cannot partially mutate the last
      // successful observation or advance its watermark.
      const cores = new Map<string, CoreHydrated>(
        [...this.#hydrated].map(([id, core]) => [id, structuredClone(core)]),
      );
      let skippedUnmanaged = 0;
      for (const record of scan.records.values()) {
        if (record.id === this.config.claimFenceIssueId) {
          cores.delete(record.id);
          continue;
        }
        const cached = cores.get(record.id);
        const mustRefresh = scan.changedIds.has(record.id)
          || scan.forcedIds.has(record.id)
          || !cached
          || cached.record.updatedAt !== record.updatedAt;
        if (!mustRefresh) continue;
        // Hydration costs six further queries per issue. An unchanged issue is
        // retained from the last successful scan; only changed issues, explicit
        // reads and every durable claim are refreshed.
        if (!requested.has(record.id) && this.#listingHasNoLifecycleLabel(record)) {
          cores.delete(record.id);
          skippedUnmanaged += 1;
          continue;
        }
        try {
          cores.set(record.id, await this.hydrateCore(record));
        } catch (error) {
          cores.delete(record.id);
          if (strict && (requested.size === 0 || requested.has(record.id))) {
            // Strict loads protect WIP reconciliation: silently omitting a
            // malformed issue that actually holds an active claim could release
            // WIP and duplicate a run. Unmanaged issues cannot hold a claim.
            if (!(await this.hasNoLifecycleLabel(record))) throw error;
          }
          this.config.onDiagnostic?.(`omitting malformed GitHub issue ${record.id}: ${errorMessage(error)}`);
        }
      }
      if (skippedUnmanaged > 0) {
        this.config.onDiagnostic?.(`skipped ${skippedUnmanaged} GitHub issues with no lifecycle label from the listing`);
      }
      const byContract = indexUnique(cores, (entry) => entry.contract.id);
      const byIdentifier = indexUnique(cores, (entry) => entry.snapshot.issue.identifier);
      const output = new Map<string, Hydrated>();
      for (const [id, core] of cores) {
        try {
          const dependencies = core.contract.dependencies.map((dependency) => resolveDependency(dependency, byContract, byIdentifier));
          const native = core.nativeBlockers.map((blocker) => {
            const target = cores.get(blocker.id);
            return {
              id: blocker.id,
              identifier: `${this.config.repository}#${blocker.number}`,
              state: target?.snapshot.issue.state ?? (blocker.state === "CLOSED" ? "done" : "unknown"),
            };
          });
          core.snapshot.issue.blockedBy = dedupeBlockers([...native, ...dependencies]);
          // Reset the provider-derived base before applying blockers. A cached
          // issue may have been non-dispatchable only because a dependency was
          // blocked on the previous read and must be allowed to become ready.
          core.snapshot.issue.dispatchable = core.record.state === "OPEN"
            && this.config.requiredLabels.every((required) => issueHasLabel(core.labels, required))
            && !core.snapshot.issue.blockedBy.some((blocker) => blocker.state !== "done");
          output.set(id, core);
        } catch (error) {
          if (strict && (requested.size === 0 || requested.has(id))) throw error;
          this.config.onDiagnostic?.(`omitting GitHub issue ${id} with ambiguous dependencies: ${errorMessage(error)}`);
        }
      }
      // Commit all in-memory scan state together, and only after every provider
      // read required by this operation has succeeded.
      this.#records = scan.records;
      this.#hydrated = new Map([...output].map(([id, core]) => [id, core as CoreHydrated]));
      this.#watermark = scan.watermark;
      return output;
    });
  }

  async #scanRecords(requested: ReadonlySet<string>): Promise<{
    records: Map<string, GitHubIssueRecord>;
    changedIds: Set<string>;
    forcedIds: Set<string>;
    watermark: string | null;
  }> {
    const since = this.#watermark;
    const changed = await collectPages((cursor) => this.transport.listIssues(this.config.repository, cursor, since));
    const records = since === null ? new Map<string, GitHubIssueRecord>() : new Map(this.#records);
    for (const record of changed) records.set(record.id, mergeListingRecord(records.get(record.id), record));

    // GitHub does not touch an issue when a closing PR merges or a check turns
    // green. Node-refresh every known durable claim on every scan so that its
    // PR/check evidence is hydrated even when it falls behind the watermark.
    const forcedIds = new Set<string>(requested);
    if (since !== null) {
      for (const [id, core] of this.#hydrated) {
        if (core.snapshot.claim) forcedIds.add(id);
      }
      const ids = [...forcedIds];
      for (let offset = 0; offset < ids.length; offset += 100) {
        const batch = ids.slice(offset, offset + 100);
        const refreshed = await this.transport.getIssuesByNodeIds(batch);
        if (refreshed.length !== batch.length) throw new Error("GitHub ID refresh returned the wrong number of issues");
        for (let index = 0; index < batch.length; index += 1) {
          const record = refreshed[index];
          const id = batch[index]!;
          if (!record) throw new Error(`GitHub issue node ${id} is missing`);
          records.set(id, mergeListingRecord(records.get(id), record));
        }
      }
    }

    // The bound is exclusively provider evidence. No local clock participates,
    // and failure before the caller commits this scan leaves the old bound intact.
    return {
      records,
      changedIds: new Set(changed.map((record) => record.id)),
      forcedIds,
      watermark: providerWatermark(since, changed),
    };
  }

  #withStateLock<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.#stateTail.then(operation, operation);
    this.#stateTail = run.then(() => undefined, () => undefined);
    return run;
  }

  /** True only when the issue verifiably carries zero managed lifecycle labels. */
  /**
   * Whether the repository listing itself proves this issue carries no managed
   * lifecycle label. Returns false whenever the labels are unknown, so an
   * uncertain case is hydrated rather than skipped.
   */
  #listingHasNoLifecycleLabel(record: GitHubIssueRecord): boolean {
    const names = record.labelNames;
    if (!names) return false;
    return !names.map(normalizeLabel).some((label) => this.#managedLabels.has(label));
  }

  private async hasNoLifecycleLabel(record: GitHubIssueRecord): Promise<boolean> {
    if (record.labelNames) return this.#listingHasNoLifecycleLabel(record);
    try {
      const labels = await collectPages((cursor) => this.transport.listLabels(record.id, cursor));
      return !labels.map(normalizeLabel).some((label) => this.#managedLabels.has(label));
    } catch {
      // Cannot verify — keep the strict failure.
      return false;
    }
  }

  private async hydrateCore(record: GitHubIssueRecord): Promise<CoreHydrated> {
    validateIssueRecord(record);
    const contract = parseIssueContract(record.body, `${this.config.repository}#${record.number}`, this.config.workflow);
    const [labels, nativeBlockers, projectItems, comments, pullRequests, branch, baseSha] = await Promise.all([
      collectPages((cursor) => this.transport.listLabels(record.id, cursor)),
      collectPages((cursor) => this.transport.listBlockedBy(record.id, cursor)),
      collectPages((cursor) => this.transport.listProjectItems(record.id, cursor)),
      collectPages((cursor) => this.transport.listComments(record.id, cursor)),
      collectPages((cursor) => this.transport.listClosingPullRequests(record.id, cursor)),
      this.transport.getBranch(this.config.repository, contract.requiredBranch),
      this.transport.getBaseSha(this.config.repository, contract.baseBranch),
    ]);
    const matchingItems = projectItems.filter((item) => item.projectId === this.config.projectId);
    if (matchingItems.length !== 1) throw new Error(`issue must have exactly one item in Project ${this.config.projectId}`);
    const item = matchingItems[0]!;
    const fields = await collectPages((cursor) => this.transport.listProjectFieldValues(item.id, cursor));
    const managedLabels = labels.map(normalizeLabel).filter((label) => this.#managedLabels.has(label));
    if (managedLabels.length !== 1) throw new Error("issue must have exactly one lifecycle label");
    // An item whose status field carries no value has simply never had a state
    // projected onto it — which is exactly how an item arrives when a Project
    // auto-adds new repository issues. That is not ambiguity, and refusing it
    // stopped a whole project on one unprojected card. Duplicates still fail.
    const status = optionalExactField(fields, this.config.statusFieldId);
    if (status && status.kind !== "single-select") throw new Error("Project status field is not single-select");
    const gate = optionalExactStringField(fields, this.config.gateFieldId);
    const parsedEvents = parseLedgerComments(comments, record.id, this.config.eventAuthorLogin);
    if (parsedEvents.length > 0 && parsedEvents[0]!.event.expectedVersion !== 1) {
      throw new Error("ledger does not begin at baseline version 1");
    }
    // With a status value both the label and the option must agree. Without
    // one the label alone decides, and only a label shared by several states is
    // genuinely ambiguous — that still fails closed below.
    // A status the lane does not own is not a disagreement, it is a human column.
    // A board sets its own default when an issue is added — "Backlog", "Todo" —
    // and treating that as ambiguity refused a freshly written contract until
    // someone set the field by hand. The lane owns exactly the options it was
    // configured with; anything else is as good as unprojected, and the next
    // commit projects the real state over it.
    const laneOptionIds = new Set(lifecycleStates.map((state) => this.config.states[state].projectStatusOptionId));
    const laneStatus = status && status.optionId !== null && laneOptionIds.has(status.optionId) ? status : null;
    const projectedCandidates = lifecycleStates.filter((state) => (
      normalizeLabel(this.config.states[state].label) === managedLabels[0]
      && (laneStatus === null || this.config.states[state].projectStatusOptionId === laneStatus.optionId)
    ));
    const ledgerBaselineState = parsedEvents[0]?.event.from;
    if (!ledgerBaselineState && projectedCandidates.length !== 1) {
      throw new Error("baseline lifecycle projection is absent or ambiguous without a ledger");
    }
    const baselineState = ledgerBaselineState ?? projectedCandidates[0]!;
    const issue: NormalizedIssue = {
      id: record.id,
      nativeRef: { repository: this.config.repository, number: record.number, projectItemId: item.id },
      identifier: `${this.config.repository}#${record.number}`,
      title: record.title,
      description: record.body,
      priority: null,
      state: baselineState,
      branchName: branch?.name ?? null,
      url: record.url,
      assigneeId: record.assigneeId,
      labels: [...new Set(labels.map(normalizeLabel).filter(Boolean))],
      blockedBy: [],
      dispatchable: record.state === "OPEN" && this.config.requiredLabels.every((required) => issueHasLabel(labels, required)),
      closed: record.state === "CLOSED",
      createdAt: isoTimestamp(record.createdAt),
      updatedAt: isoTimestamp(record.updatedAt),
    };
    let snapshot: TrackerIssueSnapshot = {
      issue,
      contract,
      version: 1,
      baseSha,
      claim: null,
      retry: null,
      evidence: branch ? { branchUrl: branch.url, branchSha: branch.oid } : {},
      events: [{ sequence: 0, atMs: Date.parse(record.createdAt), state: baselineState, message: "GitHub baseline", kind: "baseline" }],
    };
    if (baselineState === "owner-gate") {
      if (!gate) throw new Error("owner-gate baseline lacks an exact Gate field value");
      snapshot.evidence.ownerGateId = gate;
    }
    const acceptedCommentIds = new Set<number>();
    for (const parsed of parsedEvents) {
      const reduced = reduceLedgerEvent(snapshot, parsed.event, parsed.comment.databaseId);
      if (!reduced) continue;
      snapshot = reduced;
      acceptedCommentIds.add(parsed.comment.databaseId);
    }
    // An absent status value is drift by definition: the item does not yet show
    // the state the ledger settled on, so the next commit's projection repairs it.
    const projectionDrift = managedLabels[0] !== normalizeLabel(this.config.states[snapshot.issue.state].label)
      || laneStatus === null
      || laneStatus.optionId !== this.config.states[snapshot.issue.state].projectStatusOptionId;
    if (snapshot.issue.state === "owner-gate") {
      const expected = snapshot.evidence.ownerGateId;
      if (!expected) throw new Error("owner-gate ledger event lacks immutable gate ID");
      if (gate && gate !== expected) throw new Error(`Project Gate value does not exactly match ${expected}`);
      if (!gate && !projectionDrift) throw new Error("owner-gate Project Gate field is empty");
    }
    const matchingPrs = pullRequests.filter((pr) => pr.headRefName === contract.requiredBranch && pr.baseRefName === contract.baseBranch);
    if (matchingPrs.length > 1) throw new Error("multiple pull requests match the exact required branch/base");
    const matchingPr = matchingPrs[0];
    const durableHeadSha = branch?.oid
      ?? (matchingPr?.state === "MERGED" ? snapshot.evidence.branchSha : undefined);
    const providerEvidence: MaterialEvidence = branch
      ? { branchUrl: branch.url, branchSha: branch.oid }
      : durableHeadSha
        ? { branchUrl: snapshot.evidence.branchUrl, branchSha: durableHeadSha }
        : {};
    // Identity of the pull request comes from the exact deterministic branch and
    // base NAMES filtered above, plus its head commit matching the one the ledger
    // recorded. Two deliberate exclusions:
    //
    // The base ref's oid is never compared: it points at the tip of the base
    // branch, so the first commit landing after the claim — including this pull
    // request's own merge — differs from the claim's base forever. That stranded
    // Dirty-play/general#76 in pr-open with its work merged, holding the lane's
    // only WIP slot against every later issue.
    //
    // And when the ledger holds no branch SHA at all, the head commit cannot be
    // required: a run that died before recording branch evidence has none to
    // offer, while its pull request may still have merged afterwards. There is
    // nothing to contradict, and the branch name is derived from this issue, so
    // whatever merged on it is this issue's outcome. razumv/craft-agents#15 read
    // as failed for a day with its work in main because of that. A ledger SHA
    // that EXISTS and disagrees still refuses — that is a different commit, not
    // a missing one.
    let headMatchesLedger = durableHeadSha
      ? matchingPr?.headRefOid === durableHeadSha
      : !snapshot.evidence.branchSha;
    // An exact match is the common case. When it fails, the question is whether
    // the work GREW from what the ledger recorded or is a different lineage —
    // and only the second one is a reason to refuse. A branch updated from the
    // base to pick up a fix is the first: the attempt's commit is still in there.
    // Without this, a pull request that needed a rebase could never be recorded
    // as merged, so its issue sat in pr-open with delivered work and a held WIP
    // slot, and the only way to land it was by hand.
    if (!headMatchesLedger && matchingPr && durableHeadSha && this.transport.containsCommit) {
      headMatchesLedger = await this.transport.containsCommit(
        this.config.repository,
        durableHeadSha,
        matchingPr.headRefOid,
      );
    }
    if (matchingPr && headMatchesLedger) {
      Object.assign(providerEvidence, prEvidence(matchingPr));
    }
    snapshot.evidence = { ...snapshot.evidence, ...providerEvidence };
    return { snapshot, providerEvidence, record, item, labels, acceptedCommentIds, projectionDrift, contract, nativeBlockers };
  }
}

function providerWatermark(current: string | null, records: readonly GitHubIssueRecord[]): string | null {
  let latest = current;
  let latestMs = latest === null ? Number.NEGATIVE_INFINITY : Date.parse(latest);
  if (!Number.isFinite(latestMs) && latest !== null) throw new Error("stored GitHub provider watermark is invalid");
  for (const record of records) {
    const candidateMs = Date.parse(record.updatedAt);
    if (!Number.isFinite(candidateMs)) throw new Error(`GitHub issue ${record.id} has invalid provider updatedAt`);
    if (candidateMs > latestMs) {
      latest = record.updatedAt;
      latestMs = candidateMs;
    }
  }
  return latest;
}

/** Preserve listing-only metadata when a direct node refresh omits it. */
function mergeListingRecord(previous: GitHubIssueRecord | undefined, next: GitHubIssueRecord): GitHubIssueRecord {
  return {
    ...previous,
    ...next,
    labelNames: next.labelNames ?? previous?.labelNames ?? null,
    priority: next.priority ?? previous?.priority ?? null,
    parent: next.parent ?? previous?.parent ?? null,
  };
}

/**
 * The exact evidence hops. `undefined` means "no proof, stay put" — never a
 * guess. `merged` -> `done` fires only when the contract itself declares no
 * deployment authority; anything deployable stays in `merged` for the real
 * deployment to prove.
 */
/**
 * A terminal-unsuccessful issue whose own pull request merged. The attempt
 * failed; the work did not.
 */
function landedWithoutSaying(snapshot: TrackerIssueSnapshot): boolean {
  if (!["failed", "cancelled"].includes(snapshot.issue.state)) return false;
  return Boolean(snapshot.evidence.mergedAt && snapshot.evidence.mergeCommitSha);
}

/**
 * An issue a person closed while the ledger still had it in flight, with nothing
 * merged. Not a failure of the run and not a delivery — a decision taken outside
 * the lane, which the lane must record rather than wait on forever.
 */
function closedWhileInFlight(snapshot: TrackerIssueSnapshot): boolean {
  if (!snapshot.issue.closed) return false;
  if (snapshot.evidence.mergedAt) return false;
  return ["ready", "claimed", "running", "pr-open", "review", "owner-gate", "retry-wait"].includes(snapshot.issue.state);
}

function nextEvidenceStep(snapshot: TrackerIssueSnapshot): { to: LifecycleState; reason: string } | undefined {
  const state = snapshot.issue.state;
  const evidence = snapshot.evidence;
  if (state === "running" && evidence.prUrl) return { to: "pr-open", reason: "pull request evidence" };
  if (["pr-open", "review", "owner-gate"].includes(state) && evidence.mergedAt && evidence.mergeCommitSha) {
    // A high-risk contract owes an owner gate BEFORE it merges. Auto-merge refuses
    // high risk on its own, so a merge here was performed by a person — and the
    // ledger must not record it as `merged`, because `merged` for high-risk work
    // asserts the gate was honoured. Weakening that to tidy up after a bypass
    // would turn the gate into a note.
    //
    // Nor may the issue sit in pr-open forever: its work landed and its WIP slot
    // is held. So it goes to `blocked`, which says exactly what is true — the work
    // is in, the gate it owed was skipped, and only the owner can settle that. The
    // claim is released with the transition, so the lane keeps moving.
    if (snapshot.contract.risk === "high" && state !== "owner-gate") {
      return { to: "blocked", reason: "high-risk work merged without passing its owner gate" };
    }
    return { to: "merged", reason: "merge evidence" };
  }
  // The gate that a high-risk contract owes is a gate before merging. Once the
  // merge is a fact, refusing to record it does not un-merge anything; it only
  // keeps the board reporting a failure over delivered work.
  if (["failed", "cancelled"].includes(state) && evidence.mergedAt && evidence.mergeCommitSha) {
    return { to: "merged", reason: "merge evidence after a failed attempt" };
  }
  if (state === "merged" && snapshot.contract.deployAuthority === "none") {
    return { to: "done", reason: "merge evidence with no deployment authority" };
  }
  return undefined;
}

function nextEvent(
  snapshot: TrackerIssueSnapshot,
  operation: LedgerEvent["operation"],
  to: LifecycleState,
  atMs: number,
  fence: string | null,
  next: Pick<LedgerEvent, "claim" | "retry" | "evidence" | "message">
    & Partial<Pick<LedgerEvent, "justification" | "successor">>,
): LedgerEvent {
  return {
    schema: ledgerSchema,
    issueId: snapshot.issue.id,
    expectedVersion: snapshot.version,
    operation,
    from: snapshot.issue.state,
    to,
    atMs,
    fence,
    claim: structuredClone(next.claim),
    retry: structuredClone(next.retry),
    evidence: structuredClone(next.evidence),
    message: next.message,
    justification: next.justification ?? null,
    successor: next.successor ?? null,
  };
}

function reduceLedgerEvent(snapshot: TrackerIssueSnapshot, event: LedgerEvent, sequence: number): TrackerIssueSnapshot | null {
  if (event.issueId !== snapshot.issue.id) throw new Error("ledger event issue binding mismatch");
  if (event.expectedVersion < snapshot.version) return null;
  if (event.expectedVersion > snapshot.version) throw new Error("ledger version gap or deleted event detected");
  if (event.from !== snapshot.issue.state) throw new Error("ledger compare-and-set source state mismatch");
  if (!Number.isFinite(event.atMs) || event.atMs < 0) throw new Error("ledger timestamp is invalid");
  const claim = snapshot.claim;
  switch (event.operation) {
    case "claim":
      if (claim || (snapshot.issue.state !== "ready" && snapshot.issue.state !== "retry-wait") || event.to !== "claimed" || !event.claim) {
        throw new Error("invalid claim ledger event");
      }
      if (event.claim.issueId !== snapshot.issue.id || event.claim.issueIdentifier !== snapshot.issue.identifier) throw new Error("claim binding mismatch");
      if (event.claim.attempt !== (snapshot.retry?.attempt ?? 1) || event.fence !== event.claim.fence) throw new Error("claim attempt or fence mismatch");
      break;
    case "running":
      if (!claim || snapshot.issue.state !== "claimed" || event.to !== "running" || event.fence !== claim.fence || !event.claim) throw new Error("invalid running ledger event");
      break;
    case "heartbeat":
      if (!claim || event.to !== snapshot.issue.state || event.fence !== claim.fence || !event.claim) throw new Error("invalid heartbeat ledger event");
      if (!claimBindingsStable(claim, event.claim)) throw new Error("heartbeat changed durable claim identity");
      break;
    case "failure":
      if (!claim || event.fence !== claim.fence || event.claim !== null || (event.to !== "retry-wait" && event.to !== "failed")) throw new Error("invalid failure ledger event");
      assertLifecycleTransition(snapshot.issue.state, event.to);
      break;
    case "transition":
      if (claim && event.fence !== claim.fence) throw new Error("transition claim fence mismatch");
      if (snapshot.issue.state === "failed" && (event.to === "ready" || event.to === "cancelled")) {
        throw new Error("failed lifecycle decision used a generic transition");
      }
      assertLifecycleTransition(snapshot.issue.state, event.to);
      validateTransitionEvidence(snapshot, event.to, event.evidence);
      break;
    case "revival": {
      if (claim || snapshot.issue.state !== "failed" || event.to !== "ready" || event.fence !== null || event.claim !== null || event.retry !== null) {
        throw new Error("invalid revival ledger event");
      }
      const justification = decisionReference(event.justification ?? "");
      if (!justification || justification !== event.justification) throw new Error("revival requires an exact named change");
      const prior = snapshot.events.filter((entry) => entry.kind === "revival");
      if (prior.some((entry) => entry.justification === justification)) throw new Error("revival change was already used");
      break;
    }
    case "supersession": {
      if (claim || snapshot.issue.state !== "failed" || event.to !== "cancelled" || event.fence !== null || event.claim !== null || event.retry !== null) {
        throw new Error("invalid supersession ledger event");
      }
      const successor = decisionReference(event.successor ?? "");
      if (!successor || successor !== event.successor) throw new Error("supersession requires an exact successor reference");
      break;
    }
  }
  return {
    ...snapshot,
    issue: { ...snapshot.issue, state: event.to },
    version: snapshot.version + 1,
    claim: structuredClone(event.claim),
    retry: structuredClone(event.retry),
    evidence: structuredClone(event.evidence),
    events: event.operation === "heartbeat"
      ? snapshot.events
      : [...snapshot.events, {
          sequence,
          atMs: event.atMs,
          state: event.to,
          message: event.message,
          kind: event.operation,
          ...(event.justification ? { justification: event.justification } : {}),
          ...(event.successor ? { successor: event.successor } : {}),
        }],
  };
}

function validateTransitionEvidence(snapshot: TrackerIssueSnapshot, to: LifecycleState, evidence: MaterialEvidence): void {
  assertLifecycleTransition(snapshot.issue.state, to);
  if (to === "pr-open" && !evidence.prUrl) throw new Error("pr-open requires PR evidence");
  if (to === "owner-gate" && !evidence.ownerGateId) throw new Error("owner-gate requires an immutable gate ID");
  if (snapshot.evidence.ownerGateId && evidence.ownerGateId !== snapshot.evidence.ownerGateId) throw new Error("owner gate ID is immutable");
  if (to === "merged" && snapshot.contract.risk === "high" && snapshot.issue.state !== "owner-gate") throw new Error("high-risk merge requires owner-gate state");
  if (to === "merged" && (!evidence.mergedAt || !evidence.mergeCommitSha)) throw new Error("merged requires exact GitHub merge evidence");
  if (to === "deployed" && !evidence.deploymentUrl) throw new Error("deployed requires deployment evidence");
  if (to === "done" && snapshot.contract.deployAuthority !== "none" && snapshot.issue.state !== "deployed") {
    throw new Error(`${snapshot.contract.deployAuthority} work requires deployed state before done`);
  }
}

function parseLedgerComments(comments: GitHubComment[], issueId: string, author?: string): { comment: GitHubComment; event: LedgerEvent }[] {
  const sorted = [...comments].sort((a, b) => a.databaseId - b.databaseId);
  const seen = new Set<number>();
  return sorted.flatMap((comment) => {
    if (!comment.body.startsWith(eventPrefix)) return [];
    if (seen.has(comment.databaseId) || !Number.isSafeInteger(comment.databaseId) || comment.databaseId < 1) throw new Error("ambiguous GitHub comment ordering");
    seen.add(comment.databaseId);
    if (comment.createdAt !== comment.updatedAt) throw new Error("ledger event comment was edited");
    if (author && comment.authorLogin !== author) throw new Error("ledger event author is not allowed");
    if (!comment.body.endsWith(eventSuffix)) throw new Error("malformed ledger event marker");
    let raw: unknown;
    try {
      raw = JSON.parse(comment.body.slice(eventPrefix.length, -eventSuffix.length));
    } catch (error) {
      throw new Error(`malformed ledger event JSON: ${errorMessage(error)}`);
    }
    const event = validateLedgerShape(raw);
    if (event.issueId !== issueId) throw new Error("ledger event belongs to another issue");
    return [{ comment, event }];
  });
}

function validateLedgerShape(value: unknown): LedgerEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("ledger event must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== ledgerSchema) throw new Error("unsupported ledger event schema");
  if (typeof raw.issueId !== "string" || !raw.issueId || !Number.isInteger(raw.expectedVersion)) throw new Error("ledger binding/version is invalid");
  if (!["claim", "running", "heartbeat", "failure", "transition", "revival", "supersession"].includes(String(raw.operation))) throw new Error("ledger operation is invalid");
  if (!lifecycleStates.includes(raw.from as LifecycleState) || !lifecycleStates.includes(raw.to as LifecycleState)) throw new Error("ledger lifecycle state is invalid");
  if (typeof raw.atMs !== "number" || typeof raw.message !== "string" || !raw.message) throw new Error("ledger event metadata is invalid");
  if (raw.fence !== null && typeof raw.fence !== "string") throw new Error("ledger fence is invalid");
  if (!raw.evidence || typeof raw.evidence !== "object" || Array.isArray(raw.evidence)) throw new Error("ledger evidence is invalid");
  if (raw.justification !== undefined && raw.justification !== null && typeof raw.justification !== "string") {
    throw new Error("ledger revival justification is invalid");
  }
  if (raw.successor !== undefined && raw.successor !== null && typeof raw.successor !== "string") {
    throw new Error("ledger successor reference is invalid");
  }
  return raw as unknown as LedgerEvent;
}

function serializeEvent(event: LedgerEvent): string {
  return `${eventPrefix}${JSON.stringify(event)}${eventSuffix}`;
}

function serializeFenceEvent(event: SharedFenceEvent): string {
  return `${fencePrefix}${JSON.stringify(event)}${eventSuffix}`;
}

function reduceSharedFence(comments: GitHubComment[], author?: string): SharedFenceState {
  let lease: SharedFenceEvent | null = null;
  const acceptedCommentIds = new Set<number>();
  const sorted = [...comments].sort((a, b) => a.databaseId - b.databaseId);
  const seen = new Set<number>();
  for (const comment of sorted) {
    if (!comment.body.startsWith(fencePrefix)) continue;
    if (seen.has(comment.databaseId) || !Number.isSafeInteger(comment.databaseId) || comment.databaseId < 1) {
      throw new Error("ambiguous shared-fence comment ordering");
    }
    seen.add(comment.databaseId);
    if (comment.createdAt !== comment.updatedAt) throw new Error("shared-fence comment was edited");
    if (author && comment.authorLogin !== author) throw new Error("shared-fence author is not allowed");
    if (!comment.body.endsWith(eventSuffix)) throw new Error("malformed shared-fence marker");
    let raw: unknown;
    try {
      raw = JSON.parse(comment.body.slice(fencePrefix.length, -eventSuffix.length));
    } catch (error) {
      throw new Error(`malformed shared-fence JSON: ${errorMessage(error)}`);
    }
    const event = validateFenceShape(raw);
    if (event.operation === "acquire") {
      if (lease && event.atMs < lease.expiresAtMs) continue;
      lease = event;
      acceptedCommentIds.add(comment.databaseId);
    } else if (lease?.issueId === event.issueId && lease.fence === event.fence) {
      acceptedCommentIds.add(comment.databaseId);
      lease = event.operation === "release" ? null : event;
    }
  }
  return { lease, acceptedCommentIds };
}

function validateFenceShape(value: unknown): SharedFenceEvent {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("shared-fence event must be an object");
  const raw = value as Record<string, unknown>;
  if (raw.schema !== fenceSchema || !["acquire", "heartbeat", "release"].includes(String(raw.operation))) {
    throw new Error("shared-fence schema or operation is invalid");
  }
  if (typeof raw.issueId !== "string" || !raw.issueId || typeof raw.fence !== "string" || !raw.fence) {
    throw new Error("shared-fence binding is invalid");
  }
  if (typeof raw.atMs !== "number" || typeof raw.expiresAtMs !== "number"
    || !Number.isFinite(raw.atMs) || !Number.isFinite(raw.expiresAtMs) || raw.atMs < 0 || raw.expiresAtMs < raw.atMs) {
    throw new Error("shared-fence lease timestamps are invalid");
  }
  return raw as unknown as SharedFenceEvent;
}

async function collectPages<T>(load: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
  const output: T[] = [];
  const seen = new Set<string>();
  let cursor: string | null = null;
  do {
    const result = await load(cursor);
    output.push(...result.nodes);
    if (result.nextCursor !== null) {
      if (!result.nextCursor || seen.has(result.nextCursor)) throw new Error("GitHub pagination cursor is empty or repeated");
      seen.add(result.nextCursor);
    }
    cursor = result.nextCursor;
  } while (cursor !== null);
  return output;
}

function exactField(values: GitHubProjectFieldValue[], fieldId: string): GitHubProjectFieldValue {
  const matches = values.filter((value) => value.fieldId === fieldId);
  if (matches.length !== 1) throw new Error(`Project field ${fieldId} must have exactly one value`);
  return matches[0]!;
}

/** The single value for a field, or null when the item carries none. Duplicates are ambiguous. */
function optionalExactField(values: GitHubProjectFieldValue[], fieldId: string): GitHubProjectFieldValue | null {
  const matches = values.filter((value) => value.fieldId === fieldId);
  if (matches.length > 1) throw new Error(`Project field ${fieldId} has ambiguous duplicate values`);
  return matches[0] ?? null;
}

function optionalExactStringField(values: GitHubProjectFieldValue[], fieldId: string): string | null {
  const matches = values.filter((value) => value.fieldId === fieldId);
  if (matches.length > 1) throw new Error(`Project field ${fieldId} has ambiguous duplicate values`);
  const match = matches[0];
  if (!match) return null;
  if (match.kind !== "text" && match.kind !== "single-select") throw new Error(`Project field ${fieldId} is not text-like`);
  return match.value === null || match.value === "" ? null : match.value;
}

function indexUnique(values: Map<string, CoreHydrated>, key: (value: CoreHydrated) => string): Map<string, CoreHydrated | null> {
  const output = new Map<string, CoreHydrated | null>();
  for (const value of values.values()) {
    const index = key(value);
    output.set(index, output.has(index) ? null : value);
  }
  return output;
}

function resolveDependency(
  dependency: string,
  byContract: Map<string, CoreHydrated | null>,
  byIdentifier: Map<string, CoreHydrated | null>,
) {
  const value = byContract.get(dependency) ?? byIdentifier.get(dependency);
  if (value === null) throw new Error(`dependency ${dependency} is ambiguous`);
  if (!value) return { id: null, identifier: dependency, state: "unknown" };
  return { id: value.snapshot.issue.id, identifier: value.snapshot.issue.identifier, state: value.snapshot.issue.state };
}

function dedupeBlockers<T extends { id: string | null; identifier: string | null; state: string | null }>(values: T[]): T[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = `${value.id ?? ""}\n${value.identifier ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function prEvidence(pr: GitHubPullRequestEvidence): MaterialEvidence {
  return {
    prUrl: pr.url,
    ...(pr.mergedAt ? { mergedAt: pr.mergedAt } : {}),
    ...(pr.mergeCommitSha ? { mergeCommitSha: pr.mergeCommitSha } : {}),
  };
}

function validateIssueRecord(record: GitHubIssueRecord): void {
  if (!record.id || !Number.isInteger(record.number) || record.number < 1 || !record.title || typeof record.body !== "string") {
    throw new Error("GitHub issue record is malformed");
  }
  isoTimestamp(record.createdAt);
  isoTimestamp(record.updatedAt);
}

function isoTimestamp(value: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new Error(`invalid GitHub timestamp ${value}`);
  return new Date(value).toISOString();
}

function normalizeLabel(value: string): string {
  return value.trim().toLowerCase();
}

function decisionReference(value: string): string {
  return value.trim();
}

function issueHasLabel(labels: string[], required: string): boolean {
  const wanted = normalizeLabel(required);
  return labels.some((label) => normalizeLabel(label) === wanted);
}

function claimBindingsStable(left: Claim, right: Claim): boolean {
  return left.issueId === right.issueId
    && left.issueIdentifier === right.issueIdentifier
    && left.attempt === right.attempt
    && left.fence === right.fence
    && left.sessionId === right.sessionId
    && left.workspaceId === right.workspaceId
    && left.workspaceKey === right.workspaceKey
    && left.workspacePath === right.workspacePath
    && left.baseSha === right.baseSha
    && left.modelConnection === right.modelConnection
    && left.modelProfile === right.modelProfile
    && left.claimedAtMs === right.claimedAtMs;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
