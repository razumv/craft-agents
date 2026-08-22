// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CraftExecutionSession, CraftRpcSession, ProjectDeskReadback } from "./craft-adapter";
import { decideCiRepair, recordCiRepairAttempt, type CiRepairDecision, type CiRepairProposal } from "./ci-repair";
import { CraftMobileControlPlaneAdapter } from "./craft-adapter";
import { CraftCliRpcTransport, type CraftCliTransportConfig } from "./craft-transport";
import { lifecycleStates, type LifecycleState, type ProjectStatus, type TrackerIssueSnapshot, type WorkflowConfig } from "./domain";
import type { DeadlineSuccessorApplyReport } from "./deadline-apply";
import { proposeDeadlineSuccessor, type DeadlineSuccessorProposal } from "./deadline-triage";
import { GitHubIssuesProjectsAdapter, type GitHubStateProjection } from "./github-adapter";
import {
  GhCliTransport,
  type GitHubBranchEvidence,
  type GitHubComment,
  type GitHubFailedCheckDetail,
  type GitHubIssueLink,
  type GitHubIssueRecord,
  type GitHubProjectFieldValue,
  type GitHubProjectItem,
  type GitHubPullRequestEvidence,
  type GitHubTransport,
  type Page,
} from "./github-transport";
import { ModelPolicy } from "./policy";
import {
  proposeBacklogGrooming,
  type GroomingApplyReport,
  type GroomingProposal,
  type GroomingRefusalRelation,
} from "./grooming";
import { ReadScopeGitHubTransport } from "./read-scope-transport";
import { compareForDispatch, DeterministicScheduler, type Clock, type CrashPoint, type ShadowProposal } from "./scheduler";
import type { FailedLifecycleDecision, TrackerBacklogIssue } from "./tracker";
import { projectStatus } from "./status";
import { loadWorkflow } from "./workflow";
import { GitWorktreeAdapter } from "./workspace-adapter";
import { FilesystemWorkspaceTruthReader } from "./workspace-truth";

export interface LiveRunnerConfig {
  workflowPath: string;
  repositoryRoot: string;
  workspaceRoot: string;
  /**
   * Bounded retry budget per issue. Default 1 (single attempt, then owner
   * handoff) — the Alpha 2 canary invariant. Product projects set 2-3: each
   * retry is a fresh session with a fresh fence, WIP=1 and claim fencing
   * unchanged. Owner decision 2026-08-20: product default is 3.
   */
  maxAttempts?: number;
  /**
   * `issue` (default) pins the runner to one explicitly authorized issue via
   * ScopedGitHubTransport. `discovery` lets the scheduler discover eligible
   * issues across the configured repository/Project (labels + contract decide
   * dispatchability); mutations stay fenced to the repository, the configured
   * Project fields, and issues actually observed through the tracker.
   */
  mode?: "issue" | "discovery";
  issueId?: string;
  issueNumber?: number;
  projectItemId?: string;
  claimFenceIssueId: string;
  /** Runtime-derived peer fences for lanes configured on the same repository. */
  configuredClaimFenceIssueIds?: string[];
  verificationBudget: string;
  github: {
    executable: string;
    repository: string;
    eventAuthorLogin: string;
    projectId: string;
    statusFieldId: string;
    gateFieldId: string;
    requiredLabels: string[];
    states: Record<LifecycleState, GitHubStateProjection>;
  };
  git: { executable: string };
  /**
   * Close low-risk work without a person: merge a mergeable pull request whose
   * checks actually ran and passed. Absent → never merges anything.
   */
  autoMerge?: { enabled: boolean; maxRisk: "low" | "medium" | "high" };
  model?: {
    connection: string;
    /** Account chain. How it is consumed depends on connectionStrategy. */
    connections?: string[];
    /** `failover` (default) or `balanced` — see ConnectionStrategy. */
    connectionStrategy?: "failover" | "balanced";
    defaultProfile: string;
    allowedProfiles: string[];
  };
  craft: {
    workspaceId: string;
    projectId: string;
    projectWorkingDirectory: string;
    ownerSessionId: string;
    repositoryInstructions: string;
    issueLabelId: string;
    runLabelId: string;
    promptLabelId: string;
    cli: CraftCliTransportConfig;
    deadlines: {
      rpcMs: number;
      turnMs: number;
      cancelMs: number;
      pollMs: number;
      maxContextTokens: number;
    };
    maxHandoffChars: number;
  };
}

export interface GroomingRefusalRecord {
  issueId: string;
  issueNumber: number;
  issueIdentifier: string;
  relation: GroomingRefusalRelation;
  reason: string;
}

export const GROOMING_CANDIDATE_LIMIT = 10;

export interface GroomingReport {
  /** Empty needs new work; exhausted needs the named backlog issues repaired. */
  state: "backlog-empty" | "groomable" | "exhausted";
  backlogIssueNumbers: number[];
  /** Hard bound on newly considered candidates in one idle-lane cycle. */
  candidateLimit: typeof GROOMING_CANDIDATE_LIMIT;
  /** Candidates actually considered by the most recent idle-lane cycle. */
  examinedCandidates: number;
  refusals: GroomingRefusalRecord[];
}

export interface LiveRunnerStatus {
  snapshot: TrackerIssueSnapshot | null;
  status: ProjectStatus | null;
  execution: CraftExecutionSession | null;
  /** Discovery mode only: one status per issue discovered in the repository. */
  statuses?: ProjectStatus[];
  /**
   * Discovery mode only: open issues the lane does not manage. Present so a
   * surface can show the repository as it is, rather than only the slice that
   * has already been contracted.
   */
  backlog?: TrackerBacklogIssue[];
  /** Discovery mode only: why unmanaged backlog can or cannot yield work. */
  grooming?: GroomingReport;
}

export const SHADOW_RECEIPT_SCHEMA = "craft-agent/symphony-shadow@1" as const;

export interface LiveShadowReceipt {
  /** Explicit schema identifier for the public receipt shape. */
  schema: typeof SHADOW_RECEIPT_SCHEMA;
  /** Explicit public projection: no issue body, messages, or final response. */
  projectDesk: ProjectDeskReadback | null;
  proposal: ShadowProposal | null;
  writes: 0;
  /** SHA-256 over every public receipt field except this hash itself. */
  receiptHash: string;
}

class SystemClock implements Clock {
  nowMs(): number { return Date.now(); }
}

/** One explicitly scoped live composition. No provider is touched until a method is called. */
export class LiveV4Runner {
  /** Refusals are revision-scoped: the same issue is reconsidered only after GitHub reports it changed. */
  readonly #groomingRefusals = new Map<string, GroomingRefusalRecord & { revision: string }>();
  #examinedGroomingCandidates = 0;

  constructor(
    readonly config: LiveRunnerConfig,
    readonly workflow: WorkflowConfig,
    readonly tracker: GitHubIssuesProjectsAdapter,
    readonly craft: CraftMobileControlPlaneAdapter,
    readonly craftTransport: CraftCliRpcTransport,
    readonly scheduler: DeterministicScheduler,
    readonly workspaces?: GitWorktreeAdapter,
    readonly intake?: GhCliTransport,
    /**
     * Per-operation read memo. Present in production; optional so tests and
     * simulators can build a runner from bare adapters.
     */
    readonly readScope?: { clear(): void },
    /** Non-fatal autonomous decisions must remain visible without failing a cycle. */
    readonly onDiagnostic: (message: string) => void = (message) => console.warn(`[symphony] ${message}`),
  ) {}

  /**
   * One operation is one observation. Clearing here means no decision is ever
   * taken from reads gathered for a previous one, while everything inside a
   * single operation shares the reads it already paid for.
   */
  #beginOperation(): void {
    this.readScope?.clear();
  }

  async preflight(): Promise<{
    runtime: Awaited<ReturnType<CraftCliRpcTransport["identity"]>>;
    issue: TrackerIssueSnapshot;
    projectId: string;
    workspace: Awaited<ReturnType<GitWorktreeAdapter["preflight"]>> | null;
  }> {
    this.#beginOperation();
    return this.#preflightInScope();
  }

  /** preflight without starting a new scope, for callers already inside one. */
  async #preflightInScope(): Promise<{
    runtime: Awaited<ReturnType<CraftCliRpcTransport["identity"]>>;
    issue: TrackerIssueSnapshot;
    projectId: string;
    workspace: Awaited<ReturnType<GitWorktreeAdapter["preflight"]>> | null;
  }> {
    const [runtime, workspace] = await Promise.all([
      this.craftTransport.identity(this.config.craft.cli.rpcDeadlineMs),
      this.workspaces?.preflight() ?? Promise.resolve(null),
    ]);
    const project = await this.craftTransport.invoke<{ config?: { id?: string; workingDirectory?: string } } | null>(
      "projects:getOne",
      [this.config.craft.workspaceId, this.config.craft.projectId],
      this.config.craft.deadlines.rpcMs,
    );
    if (
      !project
      || project.config?.id !== this.config.craft.projectId
      || project.config?.workingDirectory !== this.config.craft.projectWorkingDirectory
    ) throw new Error("dedicated Craft Protocol project preflight failed exact readback");
    const issue = this.config.mode === "discovery"
      ? await (async () => {
          const status = await this.readDiscoveryStatus();
          if (!status.snapshot) throw new Error("discovery preflight found no issues in the configured repository");
          return status.snapshot;
        })()
      : await this.tracker.get(this.#pinnedIssueId());
    return { runtime, issue, projectId: project.config.id, workspace };
  }

  async tick(crashAfter?: CrashPoint): Promise<LiveRunnerStatus> {
    this.#beginOperation();
    // Owner input is part of this cycle's frozen context. Poll before dispatch
    // so a directive addressed to a ready issue reaches the session created by
    // this tick. Failure is diagnostic-only: an unreadable desk cannot stop the
    // lane, and the fleet service can continue operating its other runners.
    await this.#pollOwnerDesk();
    await this.#pollFailedDecisionReceipts();
    // Dispatch always gets first refusal after owner input: an existing ready
    // issue must consume the lane before autonomous grooming is considered.
    await this.scheduler.tick(crashAfter);
    await this.#groomIdleLaneAfterDispatch();
    return this.#readStatusInScope();
  }

  async #pollOwnerDesk(): Promise<void> {
    try {
      const snapshots = this.config.mode === "discovery"
        ? await this.tracker.fetchIssuesByStates(lifecycleStates)
        : [await this.tracker.get(this.#pinnedIssueId())];
      const poll = await this.craft.pollOwnerDesk(snapshots.map((snapshot) => {
        const revivals = snapshot.events.filter((event) => event.kind === "revival");
        return {
          issueId: snapshot.issue.id,
          issueIdentifier: snapshot.issue.identifier,
          state: snapshot.issue.state,
          closed: snapshot.issue.closed,
          providerMerged: Boolean(snapshot.evidence.mergedAt && snapshot.evidence.mergeCommitSha),
          usedRevivalFacts: revivals.flatMap((event) => event.justification ? [event.justification] : []),
          revivalLimitReached: revivals.length >= (this.workflow.scheduler?.maxRevivals ?? Number.MAX_SAFE_INTEGER),
          ...(snapshot.issue.state === "owner-gate" && snapshot.evidence.ownerGateId
            ? { gateId: snapshot.evidence.ownerGateId }
            : {}),
        };
      }));
      for (const refusal of poll.refusals) this.onDiagnostic(`owner directive refused: ${refusal}`);
      for (const item of poll.directives) {
        let current = item.gateDecision || item.failedDecision ? await this.tracker.get(item.directive.issueId) : null;
        if (item.gateDecision && (current?.issue.state !== "owner-gate" || current.evidence.ownerGateId !== item.gateDecision.gateId)) {
          const actual = current?.evidence.ownerGateId ?? "none";
          throw new Error(`owner decision gate ${item.gateDecision.gateId} does not match the currently open gate (${actual})`);
        }
        if (item.failedDecision) {
          const precondition = await this.#failedDecisionPrecondition(current!, item.failedDecision);
          if (precondition) {
            this.onDiagnostic(`failed decision ${item.failedDecision.kind} ${current!.issue.identifier} refused: ${precondition}`);
            continue;
          }
        }
        if (!this.tracker.recordOwnerDirective) throw new Error("tracker cannot persist owner directive receipts");
        await this.tracker.recordOwnerDirective(item.directive);
        if (item.failedDecision) {
          await this.#applyFailedDecision(item.failedDecision, `Project Desk directive ${item.directive.id}`);
          continue;
        }
        if (!item.gateDecision || !current) continue;
        // The receipt write is external. Re-read before acting so a gate changed
        // concurrently cannot inherit a decision for the prior gate.
        current = await this.tracker.get(item.directive.issueId);
        if (current.issue.state !== "owner-gate" || current.evidence.ownerGateId !== item.gateDecision.gateId) {
          const actual = current.evidence.ownerGateId ?? "none";
          throw new Error(`owner decision gate ${item.gateDecision.gateId} does not match the currently open gate (${actual})`);
        }
        if (item.gateDecision.kind === "approve") {
          if (!this.tracker.mergeClosingPullRequest) throw new Error("tracker cannot apply an owner gate approval");
          const outcome = await this.tracker.mergeClosingPullRequest(current.issue.id);
          this.onDiagnostic(`owner gate approval ${outcome.merged ? "merged" : "declined"} ${current.issue.identifier}: ${outcome.reason}`);
        } else {
          await this.tracker.transition(current.issue.id, "blocked", Date.now(), {
            ...(current.claim ? { fence: current.claim.fence } : {}),
            evidence: { ...current.evidence, blocker: `owner rejected ${item.gateDecision.gateId}: ${item.gateDecision.reason}` },
            message: `owner rejected ${item.gateDecision.gateId}: ${item.gateDecision.reason}`,
          });
        }
      }
    } catch (error) {
      this.onDiagnostic(`Project Desk read failed; cycle continues: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #pollFailedDecisionReceipts(): Promise<void> {
    if (!this.tracker.pollFailedDecisionReceipts) return;
    try {
      const poll = await this.tracker.pollFailedDecisionReceipts();
      for (const refusal of poll.refusals) this.onDiagnostic(`failed decision receipt refused: ${refusal}`);
      for (const decision of poll.decisions) await this.#applyFailedDecision(decision, decision.evidenceId);
    } catch (error) {
      this.onDiagnostic(`failed decision receipt read failed; cycle continues: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async #failedDecisionPrecondition(snapshot: TrackerIssueSnapshot, decision: FailedLifecycleDecision): Promise<string | null> {
    if (snapshot.issue.id !== decision.issueId) return "decision source does not match exact issue readback";
    if (snapshot.evidence.mergedAt && snapshot.evidence.mergeCommitSha) return "provider merge evidence already records delivery";
    if (snapshot.issue.state !== "failed") return `source lifecycle is ${snapshot.issue.state}, not failed`;
    if (snapshot.issue.closed) return "source issue is closed";
    if (decision.kind === "revive") {
      const revivals = snapshot.events.filter((event) => event.kind === "revival");
      if (revivals.some((event) => event.justification === decision.justification)) return `change already used: ${decision.justification}`;
      const limit = this.workflow.scheduler?.maxRevivals ?? Number.MAX_SAFE_INTEGER;
      if (revivals.length >= limit) return `configured revival limit of ${limit} is reached`;
    } else {
      let successor: TrackerIssueSnapshot;
      try {
        successor = await this.tracker.get(decision.successorIssueId);
      } catch (error) {
        return `successor ${decision.successor} exact readback failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (successor.issue.id !== decision.successorIssueId || successor.issue.identifier !== decision.successor) {
        return `successor ${decision.successor} does not match exact configured repository and Project readback`;
      }
      if (successor.issue.closed) return `successor ${decision.successor} is closed`;
    }
    return null;
  }

  async #applyFailedDecision(decision: FailedLifecycleDecision, source: string): Promise<void> {
    const before = await this.tracker.get(decision.issueId);
    const precondition = await this.#failedDecisionPrecondition(before, decision);
    if (precondition) {
      this.onDiagnostic(`failed decision ${decision.kind} ${before.issue.identifier} refused from ${source}: ${precondition}`);
      return;
    }
    const result = decision.kind === "revive"
      ? await this.tracker.reviveFailed(decision.issueId, decision.justification, Date.now())
      : await this.tracker.supersedeFailed(decision.issueId, decision.successor, Date.now());
    if (!result.accepted) {
      this.onDiagnostic(`failed decision ${decision.kind} ${before.issue.identifier} refused from ${source}: ${result.reason}`);
      return;
    }
    const readback = await this.tracker.get(decision.issueId);
    const expectedState = decision.kind === "revive" ? "ready" : "cancelled";
    const exactEvent = readback.events.some((event) => decision.kind === "revive"
      ? event.kind === "revival" && event.justification === decision.justification && event.state === expectedState
      : event.kind === "supersession" && event.successor === decision.successor && event.state === expectedState);
    if (readback.issue.state !== expectedState || !exactEvent || readback.version !== result.snapshot.version) {
      throw new Error(`${decision.kind} ${before.issue.identifier} durable decision readback did not reconstruct exact ${expectedState} lifecycle state`);
    }
    this.onDiagnostic(`failed decision ${decision.kind} ${before.issue.identifier} accepted from ${source}: ${result.reason}`);
  }

  /**
   * Consider at most GROOMING_CANDIDATE_LIMIT new backlog candidates after
   * dispatch, stopping at the first grounded contract. Candidate decisions are
   * pure over one backlog observation; at most one proposal is applied. Every
   * failure remains diagnostic-only so this lane and later projects continue.
   */
  async #groomIdleLaneAfterDispatch(): Promise<void> {
    if (this.config.mode !== "discovery") return;
    this.#examinedGroomingCandidates = 0;
    try {
      const [active, ready] = await Promise.all([
        this.tracker.activeClaims(),
        this.tracker.fetchIssuesByStates(["ready"]),
      ]);
      if (active.length > 0 || ready.length > 0) return;

      const backlog = await this.tracker.fetchBacklog();
      this.#reconcileGroomingRefusals(backlog);
      let eligible = backlog.filter((candidate) => !this.#groomingRefusals.has(candidate.id));
      while (this.#examinedGroomingCandidates < GROOMING_CANDIDATE_LIMIT) {
        const proposal = proposeBacklogGrooming(this.config.github.repository, eligible, this.workflow);
        if (!proposal.candidate) return;
        this.#examinedGroomingCandidates += 1;

        if (proposal.outcome === "proposed") {
          const report = await this.tracker.applyGrooming(proposal);
          if (report.outcome === "failed") {
            this.onDiagnostic(`grooming failed ${report.issueIdentifier} at ${report.step}: ${report.error}`);
          }
          return;
        }

        this.#groomingRefusals.set(proposal.candidate.id, {
          issueId: proposal.candidate.id,
          issueNumber: proposal.candidate.number,
          issueIdentifier: proposal.candidate.identifier,
          relation: proposal.refusal.relation,
          reason: proposal.refusal.message,
          revision: groomingRevision(proposal.candidate),
        });
        this.onDiagnostic(`grooming refused ${proposal.candidate.identifier}: ${proposal.refusal.message}`);
        eligible = eligible.filter((candidate) => candidate.id !== proposal.candidate!.id);
      }
    } catch (error) {
      this.onDiagnostic(`grooming failed before apply: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  /** The one explicitly pinned issue id; only meaningful in issue mode. */
  #pinnedIssueId(): string {
    const issueId = this.config.issueId;
    if (this.config.mode === "discovery" || !issueId) {
      throw new Error("operation requires single-issue mode with a pinned issueId");
    }
    return issueId;
  }

  async readStatus(): Promise<LiveRunnerStatus> {
    this.#beginOperation();
    return this.#readStatusInScope();
  }

  /** readStatus without starting a new scope, for callers already inside one. */
  async #readStatusInScope(): Promise<LiveRunnerStatus> {
    if (this.config.mode === "discovery") return this.readDiscoveryStatus();
    const snapshot = await this.tracker.get(this.#pinnedIssueId());
    const execution = snapshot.claim ? await this.craft.get(snapshot.claim.sessionId) : null;
    return { snapshot, status: projectStatus(snapshot), execution };
  }

  /**
   * Discovery projection: every issue the tracker can see in the configured
   * repository, with the primary status being the active claim when one
   * occupies WIP, else the first discovered issue, else null (empty repo).
   */
  private async readDiscoveryStatus(): Promise<LiveRunnerStatus> {
    const allStates = Object.keys(this.config.github.states) as (keyof typeof this.config.github.states)[];
    const [snapshots, backlog] = await Promise.all([
      this.tracker.fetchIssuesByStates(allStates),
      // Free within one operation: the read scope has already answered the
      // listing pages this walks. A tracker without the notion returns nothing.
      this.tracker.fetchBacklog?.() ?? Promise.resolve([]),
    ]);
    const statuses = snapshots.map((snapshot) => projectStatus(snapshot));
    const active = snapshots.find((snapshot) => snapshot.claim !== null && snapshot.claim !== undefined);
    const primary = active ?? snapshots[0] ?? null;
    const execution = active?.claim ? await this.craft.get(active.claim.sessionId) : null;
    this.#reconcileGroomingRefusals(backlog);
    return {
      snapshot: primary,
      status: primary ? projectStatus(primary) : null,
      execution,
      statuses,
      backlog,
      grooming: this.#groomingReport(backlog),
    };
  }

  #reconcileGroomingRefusals(backlog: readonly TrackerBacklogIssue[]): void {
    const revisions = new Map(backlog.map((candidate) => [candidate.id, groomingRevision(candidate)]));
    for (const [issueId, refusal] of this.#groomingRefusals) {
      if (revisions.get(issueId) !== refusal.revision) this.#groomingRefusals.delete(issueId);
    }
  }

  #groomingReport(backlog: readonly TrackerBacklogIssue[]): GroomingReport {
    const backlogIssueNumbers = backlog.map((candidate) => candidate.number).sort((left, right) => left - right);
    const refusals = [...this.#groomingRefusals.values()]
      .map(({ revision: _, ...record }) => record)
      .sort((left, right) => left.issueNumber - right.issueNumber);
    const state = backlog.length === 0
      ? "backlog-empty"
      : refusals.length === backlog.length
        ? "exhausted"
        : "groomable";
    return {
      state,
      backlogIssueNumbers,
      candidateLimit: GROOMING_CANDIDATE_LIMIT,
      examinedCandidates: this.#examinedGroomingCandidates,
      refusals,
    };
  }

  /**
   * Work intake: create a machine-readable contract issue in the configured
   * repository, labeled ready and placed on the configured Project. This is
   * an explicit owner action, independent from scheduler mutation gating.
   */
  async createContractIssue(input: ContractIssueInput): Promise<{ id: string; number: number; url: string }> {
    const intake = this.intake;
    if (!intake) throw new Error("this runner has no GitHub intake transport configured");
    // A single-issue runner is pinned to one authorized issue and would never
    // discover the new one — creating it here would orphan the work.
    if (this.config.mode !== "discovery") {
      throw new Error("issue intake requires a discovery-mode project (a pinned single-issue runner would never dispatch it)");
    }
    // Intake writes bypass the memoised transport, so nothing read before this
    // point may be reused afterwards.
    this.#beginOperation();
    if (!input.title.trim() || !input.goal.trim()) throw new Error("issue title and goal are required");
    if (input.acceptance.filter((item) => item.trim()).length === 0) throw new Error("at least one acceptance criterion is required");
    if (input.model) new ModelPolicy(this.workflow.model).assertAllowed(input.model);
    const body = contractIssueBody(
      { ...input, acceptance: input.acceptance.filter((i) => i.trim()), nonGoals: input.nonGoals.filter((i) => i.trim()) },
      {
        id: `CRAFT-${Date.now().toString(36).toUpperCase()}`,
        model: this.workflow.model.defaultProfile,
        verificationBudget: this.config.verificationBudget,
      },
    );
    const labels = [...this.config.github.requiredLabels, this.config.github.states.ready.label];
    const created = await intake.createIssue(this.config.github.repository, input.title.trim(), body, labels);
    const itemId = await intake.addIssueToProject(this.config.github.projectId, created.id);
    await intake.updateProjectSingleSelect(
      this.config.github.projectId, itemId,
      this.config.github.statusFieldId, this.config.github.states.ready.projectStatusOptionId,
    );
    return created;
  }

  /**
   * Read one repository backlog and return a grounded grooming proposal or an
   * exact refusal. The only adapter capability reachable here is fetchBacklog;
   * the pure proposal builder has no transport reference and cannot mutate.
   */
  /**
   * Provider-backed authorization fence for a repository repair. A successful
   * decision consumes its attempt durably before the prompt can reach a worker;
   * restarts therefore cannot reset the two-attempt cap.
   */
  async prepareCiRepair(issueId: string, proposal: CiRepairProposal | null): Promise<CiRepairDecision> {
    this.#beginOperation();
    const snapshot = await this.tracker.get(issueId);
    const failure = await this.tracker.ciFailure(issueId);
    const attempts = await this.tracker.ciRepairAttempts(issueId, failure?.pullRequestId);
    const decision = decideCiRepair({ contract: snapshot.contract, failure, proposal, attempts });
    if (decision.action === "repair") {
      await this.tracker.recordCiRepairAttempt(
        issueId,
        decision.evidence.pullRequestId,
        recordCiRepairAttempt(decision),
      );
    } else if (decision.evidence && snapshot.claim && ["pr-open", "review", "owner-gate"].includes(snapshot.issue.state)) {
      const exactFailure = decision.evidence
        ? `\ncheck: ${decision.evidence.checkName}\ncommand: ${decision.evidence.command}\noutput:\n${decision.evidence.output}`
        : "";
      const diagnoses = decision.diagnoses.length ? `\ndiagnoses:\n${decision.diagnoses.join("\n")}` : "";
      await this.tracker.transition(issueId, "blocked", Date.now(), {
        fence: snapshot.claim.fence,
        evidence: { ...snapshot.evidence, blocker: decision.reason },
        message: `CI repair handed over: ${decision.reason}${exactFailure}${diagnoses}`,
      });
    }
    return decision;
  }

  async proposeGrooming(): Promise<GroomingProposal> {
    this.#beginOperation();
    const backlog = await this.tracker.fetchBacklog();
    return proposeBacklogGrooming(this.config.github.repository, backlog, this.workflow);
  }

  /** Apply only the exact proposal returned by grooming; refusals remain read-only. */
  async applyGrooming(proposal: GroomingProposal): Promise<GroomingApplyReport> {
    this.#beginOperation();
    return this.tracker.applyGrooming(proposal);
  }

  /**
   * Read failed managed issues and return the first grounded deadline successor.
   * Like grooming, this method has no applying capability: it performs no issue,
   * label, comment, or Project mutation.
   */
  async proposeDeadlineSuccessor(): Promise<DeadlineSuccessorProposal | null> {
    this.#beginOperation();
    const issues = await this.tracker.fetchIssuesByStates(lifecycleStates);
    for (const failed of issues.filter((issue) => issue.issue.state === "failed").sort(compareForDispatch)) {
      const preserved = await this.workspaces?.findPreservedBranches(failed.contract.requiredBranch) ?? [];
      const proposal = proposeDeadlineSuccessor(failed, this.workflow, issues, preserved);
      if (proposal) return proposal;
    }
    return null;
  }

  /** Explicit applying half; never runs autonomously and requires discovery scope. */
  async applyDeadlineSuccessor(proposal: DeadlineSuccessorProposal | null): Promise<DeadlineSuccessorApplyReport> {
    this.#beginOperation();
    if (this.config.mode !== "discovery") {
      return { outcome: "failed", writes: 0, completedSteps: [], issue: null, failedStep: "preflight", error: "deadline-successor apply requires discovery mode" };
    }
    return this.tracker.applyDeadlineSuccessor(proposal);
  }

  async projectDesk(): Promise<ProjectDeskReadback> {
    this.#beginOperation();
    const status = await this.#readStatusInScope();
    if (!status.status) throw new Error("no discovered issue to project to the desk");
    return this.craft.readProjectDesk({ status: status.status, activeRun: status.execution });
  }

  async shadow(): Promise<LiveShadowReceipt> {
    this.#beginOperation();
    return this.#shadowInScope();
  }

  /**
   * Validate every external binding and produce the shadow receipt as ONE
   * observation. Callers used to run preflight and shadow back to back, which
   * read the whole repository twice for a single read-only decision — and a
   * shadow already re-reads it a third time to preview the next dispatch.
   */
  async shadowWithPreflight(): Promise<LiveShadowReceipt> {
    this.#beginOperation();
    await this.#preflightInScope();
    return this.#shadowInScope();
  }

  async #shadowInScope(): Promise<LiveShadowReceipt> {
    const status = await this.#readStatusInScope();
    const [projectDesk, proposal] = await Promise.all([
      status.status
        ? this.craft.readProjectDesk({ status: status.status, activeRun: status.execution })
        : Promise.resolve(null),
      this.config.mode === "discovery"
        ? this.scheduler.previewNext()
        : this.scheduler.preview(this.#pinnedIssueId()),
    ]);
    const payload = { schema: SHADOW_RECEIPT_SCHEMA, projectDesk, proposal, writes: 0 as const };
    return {
      ...payload,
      receiptHash: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
    };
  }

  async project(): Promise<{ notes: string; status: LiveRunnerStatus }> {
    const status = await this.readStatus();
    if (!status.status) throw new Error("no discovered issue to project to the desk");
    const notes = await this.craft.projectToDesk({
      status: status.status,
      activeRun: status.execution,
      latestAcknowledgement: null,
    });
    return { notes, status };
  }

  async transitionToPrOpen(): Promise<LiveRunnerStatus> {
    const before = await this.tracker.get(this.#pinnedIssueId());
    if (!before.claim) throw new Error("Issue has no active claim for PR transition");
    if (before.issue.state !== "running" && before.issue.state !== "pr-open") {
      throw new Error(`Issue cannot enter pr-open from ${before.issue.state}`);
    }
    if (before.issue.state === "running") {
      const execution = await this.craft.get(before.claim.sessionId);
      if (!execution || execution.status !== "settled") {
        throw new Error("Craft execution must have true settled readback before PR transition");
      }
      await this.tracker.transition(before.issue.id, "pr-open", Date.now(), {
        fence: before.claim.fence,
        message: "exact GitHub pull request evidence observed after true Craft settlement",
      });
    }
    return this.readStatus();
  }

  async archiveExecution(): Promise<{ rpcSessionId: string; commandResult: unknown; readback: Record<string, unknown> }> {
    const status = await this.readStatus();
    if (!status.execution || status.execution.status !== "settled") {
      throw new Error("execution session must have true settled readback before archive");
    }
    await this.craftTransport.identity(this.config.craft.cli.rpcDeadlineMs);
    let sessions = await this.craftTransport.invoke<CraftRpcSession[]>("sessions:get", [], this.config.craft.deadlines.rpcMs);
    let exact = sessions.filter((session) => session.id === status.execution!.rpcSessionId);
    if (exact.length !== 1) throw new Error("execution session exact readback is absent or ambiguous before archive");
    let readback = exact[0] as CraftRpcSession & Record<string, unknown>;
    if (readback.isArchived === true && !readback.isProcessing) {
      return { rpcSessionId: status.execution.rpcSessionId, commandResult: "already-archived", readback };
    }
    const commandResult = await this.craftTransport.invoke(
      "sessions:command",
      [status.execution.rpcSessionId, { type: "archive" }],
      this.config.craft.deadlines.rpcMs,
    );
    sessions = await this.craftTransport.invoke<CraftRpcSession[]>("sessions:get", [], this.config.craft.deadlines.rpcMs);
    exact = sessions.filter((session) => session.id === status.execution!.rpcSessionId);
    if (exact.length !== 1) throw new Error("archived execution session exact readback is absent or ambiguous");
    readback = exact[0] as CraftRpcSession & Record<string, unknown>;
    if (readback.isProcessing) throw new Error("archived execution session is still processing");
    const archived = readback.archived === true || readback.isArchived === true || readback.kanbanColumn === "archived";
    if (!archived) throw new Error("execution archive command lacks authoritative archived readback");
    return { rpcSessionId: status.execution.rpcSessionId, commandResult, readback };
  }
}

export async function loadLiveRunnerConfig(path: string): Promise<LiveRunnerConfig> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as LiveRunnerConfig;
  const mode = parsed.mode ?? "issue";
  if (mode !== "issue" && mode !== "discovery") throw new Error("live runner mode must be issue or discovery");
  if (parsed.maxAttempts !== undefined && (!Number.isInteger(parsed.maxAttempts) || parsed.maxAttempts < 1 || parsed.maxAttempts > 10)) {
    throw new Error("live runner maxAttempts must be an integer between 1 and 10");
  }
  if (parsed.configuredClaimFenceIssueIds !== undefined) {
    const fences = parsed.configuredClaimFenceIssueIds;
    if (!Array.isArray(fences) || fences.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error("live runner configuredClaimFenceIssueIds must be an array of non-empty strings");
    }
    if (new Set(fences).size !== fences.length || !fences.includes(parsed.claimFenceIssueId)) {
      throw new Error("live runner configuredClaimFenceIssueIds must be unique and include claimFenceIssueId");
    }
  }
  const required: Record<string, unknown> = {
    workflowPath: parsed.workflowPath,
    repositoryRoot: parsed.repositoryRoot,
    workspaceRoot: parsed.workspaceRoot,
    claimFenceIssueId: parsed.claimFenceIssueId,
    verificationBudget: parsed.verificationBudget,
  };
  if (mode === "issue") required.issueId = parsed.issueId;
  for (const [field, value] of Object.entries(required)) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`live runner ${field} must be configured`);
  }
  return parsed;
}

export async function createLiveRunner(config: LiveRunnerConfig): Promise<LiveV4Runner> {
  const loaded = await loadWorkflow(resolve(config.workflowPath));
  const model = config.model ?? {
    connection: "chatgpt-plus",
    defaultProfile: "pi/gpt-5.6-sol",
    allowedProfiles: ["pi/gpt-5.6-sol"],
  };
  if (!model.connection.trim()) throw new Error("live runner model.connection must be configured");
  if (model.connections !== undefined) {
    if (!Array.isArray(model.connections) || model.connections.some((entry) => typeof entry !== "string" || !entry.trim())) {
      throw new Error("live runner model.connections must be an array of non-empty connection slugs");
    }
  }
  if (model.connectionStrategy !== undefined && model.connectionStrategy !== "failover" && model.connectionStrategy !== "balanced") {
    throw new Error('live runner model.connectionStrategy must be "failover" or "balanced"');
  }
  if (config.autoMerge !== undefined) {
    if (typeof config.autoMerge.enabled !== "boolean") throw new Error("live runner autoMerge.enabled must be a boolean");
    if (!["low", "medium", "high"].includes(config.autoMerge.maxRisk)) {
      throw new Error('live runner autoMerge.maxRisk must be "low", "medium" or "high"');
    }
  }
  if (!model.allowedProfiles.includes(model.defaultProfile)) {
    throw new Error("live runner model.defaultProfile must be one of model.allowedProfiles");
  }
  const workflow: WorkflowConfig = {
    ...loaded.config,
    project: {
      ...loaded.config.project,
      id: config.craft.projectId,
      repository: config.github.repository,
    },
    tracker: { ...loaded.config.tracker, kind: "github" },
    scheduler: { ...loaded.config.scheduler, maxAttempts: config.maxAttempts ?? 1 },
    ...(config.autoMerge ? { autoMerge: config.autoMerge } : {}),
    workspace: { root: resolve(config.workspaceRoot) },
    model: {
      connection: model.connection,
      ...(model.connections?.length ? { connections: [...model.connections] } : {}),
      ...(model.connectionStrategy ? { connectionStrategy: model.connectionStrategy } : {}),
      defaultProfile: model.defaultProfile,
      allowedProfiles: [...model.allowedProfiles],
    },
    verification: {
      ...loaded.config.verification,
      low: {
        budget: config.verificationBudget,
        independentReviews: 0,
        correctionPasses: 0,
        ownerGate: false,
      },
    },
  };
  const ghCli = new GhCliTransport(config.github.executable);
  // Reads are answered once per operation and every write drops the memo. The
  // fencing transports wrap this, so a fenced mutation still clears it.
  const readScope = new ReadScopeGitHubTransport(ghCli);
  const rawGitHub: GitHubTransport = readScope;
  const mode = config.mode ?? "issue";
  let github: GitHubTransport;
  if (mode === "discovery") {
    github = new DiscoveryGitHubTransport(rawGitHub, {
      repository: config.github.repository,
      fenceIssueId: config.claimFenceIssueId,
      readableFenceIssueIds: config.configuredClaimFenceIssueIds ?? [config.claimFenceIssueId],
      projectId: config.github.projectId,
      statusFieldId: config.github.statusFieldId,
      gateFieldId: config.github.gateFieldId,
    });
  } else {
    if (!config.issueId || !config.issueNumber || !config.projectItemId) {
      throw new Error("single-issue mode requires issueId, issueNumber, and projectItemId");
    }
    github = new ScopedGitHubTransport(rawGitHub, {
      repository: config.github.repository,
      issueId: config.issueId,
      issueNumber: config.issueNumber,
      fenceIssueId: config.claimFenceIssueId,
      readableFenceIssueIds: config.configuredClaimFenceIssueIds ?? [config.claimFenceIssueId],
      projectId: config.github.projectId,
      projectItemId: config.projectItemId,
      statusFieldId: config.github.statusFieldId,
      gateFieldId: config.github.gateFieldId,
    });
  }
  const truth = new FilesystemWorkspaceTruthReader(workflow.workspace.root);
  const tracker = new GitHubIssuesProjectsAdapter({
    repository: config.github.repository,
    projectId: config.github.projectId,
    claimFenceIssueId: config.claimFenceIssueId,
    configuredClaimFenceIssueIds: config.configuredClaimFenceIssueIds ?? [config.claimFenceIssueId],
    statusFieldId: config.github.statusFieldId,
    gateFieldId: config.github.gateFieldId,
    requiredLabels: config.github.requiredLabels,
    states: config.github.states,
    workflow,
    eventAuthorLogin: config.github.eventAuthorLogin,
    onDiagnostic: (message) => console.warn(`[symphony] ${message}`),
  }, github, truth);
  const craftTransport = new CraftCliRpcTransport(config.craft.cli);
  const craft = new CraftMobileControlPlaneAdapter({
    workspaceId: config.craft.workspaceId,
    projectId: config.craft.projectId,
    projectWorkingDirectory: config.craft.projectWorkingDirectory,
    ownerSessionId: config.craft.ownerSessionId,
    repositoryInstructions: config.craft.repositoryInstructions,
    issueLabelId: config.craft.issueLabelId,
    runLabelId: config.craft.runLabelId,
    promptLabelId: config.craft.promptLabelId,
    model: { connection: model.connection, ...(model.connections?.length ? { connections: [...model.connections] } : {}), allowedProfiles: [model.defaultProfile, ...model.allowedProfiles.filter((p) => p !== model.defaultProfile)] },
    expectedRuntime: config.craft.cli.expected,
    deadlines: config.craft.deadlines,
    maxHandoffChars: config.craft.maxHandoffChars,
  }, craftTransport);
  const workspaces = new GitWorktreeAdapter({
    repositoryRoot: config.repositoryRoot,
    workspaceRoot: config.workspaceRoot,
    gitExecutable: config.git.executable,
    trackerRepository: config.github.repository,
    // The callback is the durable issue ledger write. The worktree adapter has
    // already pushed and read back the exact ref before this runs; a receipt
    // failure propagates and therefore retains the original worktree for replay.
    onPreserved: async (info) => {
      const receipt = await tracker.recordPreservation(info);
      if (receipt.recorded) console.warn(
        `[symphony] preserved interrupted work from ${info.issueId} attempt ${info.attempt} on remote branch ${info.preservedBranch} (${info.commit.slice(0, 7)}); local preservation branch and original worktree are retained if any later release step fails`,
      );
    },
  });
  const scheduler = new DeterministicScheduler(
    workflow,
    // Auto-merge refusals go to the same place discovery's skip counts go: a
    // policy that quietly declines is indistinguishable from one not running.
    { github: tracker, craft, workspaces, onDiagnostic: (message) => console.warn(`[symphony] ${message}`) },
    new SystemClock(),
  );
  return new LiveV4Runner(config, workflow, tracker, craft, craftTransport, scheduler, workspaces, ghCli, readScope);
}

export interface ContractIssueInput {
  title: string;
  goal: string;
  risk: "low" | "medium" | "high";
  acceptance: string[];
  nonGoals: string[];
  model?: string;
  /**
   * Contract ids / issue identifiers this work depends on. The tracker resolves
   * them into blockedBy, so a dependent issue is simply not dispatchable until
   * its dependencies are done — this is how v4 expresses decomposition
   * (separate issues + edges), instead of the Tasks world's subtask DAG.
   */
  dependencies?: string[];
  /** Overrides the runner config default (risk tiers carry different budgets). */
  verificationBudget?: string;
}

/** Quote a scalar whenever plain YAML could misread it (reserved leading chars bit us live: a backtick-led scalar is a parse error). */
function yamlScalar(value: string): string {
  const trimmed = value.trim();
  if (/^[A-Za-z0-9][^#]*$/.test(trimmed) && !/[:{}\[\],&*?|>'"%@`!-]/.test(trimmed[0]!) && !trimmed.includes(": ")) return trimmed;
  return JSON.stringify(trimmed);
}

/** Deterministic machine-readable contract body for a new work-intake issue. */
export function contractIssueBody(
  input: ContractIssueInput,
  defaults: { id: string; model: string; verificationBudget: string },
): string {
  const list = (items: string[]) => items.map((item) => `  - ${yamlScalar(item)}`).join("\n");
  const dependencies = (input.dependencies ?? []).filter((entry) => entry.trim());
  return [
    "## Work contract",
    "",
    "```yaml",
    `id: ${yamlScalar(defaults.id)}`,
    `goal: ${yamlScalar(input.goal)}`,
    `risk: ${input.risk}`,
    "deployAuthority: none",
    `model: ${yamlScalar(input.model ?? defaults.model)}`,
    `verificationBudget: ${yamlScalar(input.verificationBudget?.trim() || defaults.verificationBudget)}`,
    ...(dependencies.length ? ["dependencies:", list(dependencies)] : []),
    "acceptance:",
    list(input.acceptance),
    "nonGoals:",
    list(input.nonGoals.length ? input.nonGoals : ["scheduler/service architecture changes", "live Fleet or product changes", "independent audit"]),
    "```",
    "",
    "Created from the Craft Symphony board.",
  ].join("\n");
}

function groomingRevision(candidate: TrackerBacklogIssue): string {
  // updatedAt is the provider's issue-change token. The content hash keeps the
  // fail-closed behavior for providers/fixtures that cannot supply one.
  return candidate.updatedAt ?? createHash("sha256").update(canonicalJson(candidate)).digest("hex");
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/**
 * Restricts a repository transport to one configured repository and Project.
 *
 * Unlike ScopedGitHubTransport it does not pin one issue: reads flow for the
 * whole repository, and mutations are permitted only for the claim fence and
 * for issues/Project items actually observed through prior reads of this
 * transport. Nothing can be mutated that discovery did not surface first, and
 * Project mutations stay pinned to the configured project and status/gate
 * fields.
 */
export interface GitHubDiscoveryScope {
  repository: string;
  fenceIssueId: string;
  /** Fence issues this lane may inspect; only fenceIssueId remains writable. */
  readableFenceIssueIds?: readonly string[];
  projectId: string;
  statusFieldId: string;
  gateFieldId: string;
}

export class DiscoveryGitHubTransport implements GitHubTransport {
  readonly #issueIds = new Set<string>();
  readonly #issueNumbers = new Set<number>();
  readonly #projectItemIds = new Set<string>();

  constructor(readonly delegate: GitHubTransport, readonly scope: GitHubDiscoveryScope) {}

  async listIssues(repository: string, cursor: string | null, updatedSince: string | null = null): Promise<Page<GitHubIssueRecord>> {
    if (repository !== this.scope.repository) throw new Error("GitHub request escaped configured repository scope");
    const page = await this.delegate.listIssues(repository, cursor, updatedSince);
    for (const record of page.nodes) {
      this.#issueIds.add(record.id);
      this.#issueNumbers.add(record.number);
    }
    return page;
  }

  async getIssuesByNodeIds(ids: readonly string[]): Promise<(GitHubIssueRecord | null)[]> {
    const records = await this.delegate.getIssuesByNodeIds(ids);
    for (const record of records) {
      if (record) {
        this.#issueIds.add(record.id);
        this.#issueNumbers.add(record.number);
      }
    }
    return records;
  }

  /**
   * Merging is scoped by the pull request the tracker resolved from an in-scope
   * issue, so there is no separate identifier to police here.
   */
  async mergePullRequest(pullRequestId: string, commitHeadline: string): Promise<void> {
    return this.delegate.mergePullRequest(pullRequestId, commitHeadline);
  }

  async containsCommit(repository: string, base: string, head: string): Promise<boolean> {
    if (repository !== this.scope.repository) throw new Error("GitHub request escaped configured repository scope");
    return this.delegate.containsCommit(repository, base, head);
  }

  async listLabels(issueId: string, cursor: string | null): Promise<Page<string>> { return this.delegate.listLabels(this.assertRead(issueId), cursor); }
  async listBlockedBy(issueId: string, cursor: string | null): Promise<Page<GitHubIssueLink>> { return this.delegate.listBlockedBy(this.assertRead(issueId), cursor); }
  async listProjectItems(issueId: string, cursor: string | null): Promise<Page<GitHubProjectItem>> {
    const page = await this.delegate.listProjectItems(this.assertRead(issueId), cursor);
    for (const item of page.nodes) {
      if (item.projectId === this.scope.projectId) this.#projectItemIds.add(item.id);
    }
    return page;
  }
  listProjectFieldValues(itemId: string, cursor: string | null): Promise<Page<GitHubProjectFieldValue>> { return this.delegate.listProjectFieldValues(itemId, cursor); }
  async listComments(issueId: string, cursor: string | null): Promise<Page<GitHubComment>> { return this.delegate.listComments(this.assertRead(issueId), cursor); }
  async listClosingPullRequests(issueId: string, cursor: string | null): Promise<Page<GitHubPullRequestEvidence>> { return this.delegate.listClosingPullRequests(this.assertRead(issueId), cursor); }
  async listFailedCheckDetails(repository: string, headSha: string): Promise<GitHubFailedCheckDetail[]> {
    if (repository !== this.scope.repository) throw new Error("GitHub request escaped configured repository scope");
    return this.delegate.listFailedCheckDetails(repository, headSha);
  }
  async getBranch(repository: string, branchName: string): Promise<GitHubBranchEvidence | null> {
    if (repository !== this.scope.repository) throw new Error("GitHub request escaped configured repository scope");
    return this.delegate.getBranch(repository, branchName);
  }
  async getBaseSha(repository: string, branchName: string): Promise<string> {
    if (repository !== this.scope.repository) throw new Error("GitHub request escaped configured repository scope");
    return this.delegate.getBaseSha(repository, branchName);
  }

  async appendComment(issueId: string, body: string): Promise<GitHubComment> {
    if (issueId !== this.scope.fenceIssueId && !this.#issueIds.has(issueId)) {
      throw new Error("GitHub comment mutation escaped discovered issue/fence scope");
    }
    return this.delegate.appendComment(issueId, body);
  }
  async createIssue(repository: string, title: string, body: string, labels: readonly string[]): Promise<{ id: string; number: number; url: string }> {
    if (repository !== this.scope.repository || !this.delegate.createIssue) {
      throw new Error("GitHub issue creation escaped configured repository scope or is unavailable");
    }
    const created = await this.delegate.createIssue(repository, title, body, labels);
    this.#issueIds.add(created.id);
    this.#issueNumbers.add(created.number);
    return created;
  }
  async addIssueToProject(projectId: string, contentId: string): Promise<string> {
    if (projectId !== this.scope.projectId || !this.#issueIds.has(contentId) || !this.delegate.addIssueToProject) {
      throw new Error("GitHub Project item creation escaped discovered issue/project scope or is unavailable");
    }
    const itemId = await this.delegate.addIssueToProject(projectId, contentId);
    this.#projectItemIds.add(itemId);
    return itemId;
  }
  async updateIssueBody(repository: string, issueNumber: number, body: string, expectedUpdatedAt: string): Promise<boolean> {
    if (repository !== this.scope.repository || !this.#issueNumbers.has(issueNumber)) {
      throw new Error("GitHub body mutation escaped discovered issue scope");
    }
    return this.delegate.updateIssueBody(repository, issueNumber, body, expectedUpdatedAt);
  }
  async replaceLabels(repository: string, issueNumber: number, labels: readonly string[]): Promise<void> {
    if (repository !== this.scope.repository || !this.#issueNumbers.has(issueNumber)) {
      throw new Error("GitHub label mutation escaped discovered repository/issue scope");
    }
    return this.delegate.replaceLabels(repository, issueNumber, labels);
  }
  async updateProjectSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    if (projectId !== this.scope.projectId || fieldId !== this.scope.statusFieldId || !this.#projectItemIds.has(itemId)) {
      throw new Error("GitHub Project status mutation escaped discovered item scope");
    }
    return this.delegate.updateProjectSingleSelect(projectId, itemId, fieldId, optionId);
  }
  async updateProjectText(projectId: string, itemId: string, fieldId: string, value: string): Promise<void> {
    if (projectId !== this.scope.projectId || fieldId !== this.scope.gateFieldId || !this.#projectItemIds.has(itemId)) {
      throw new Error("GitHub Project gate mutation escaped discovered item scope");
    }
    return this.delegate.updateProjectText(projectId, itemId, fieldId, value);
  }

  private assertRead(issueId: string): string {
    const readableFences = this.scope.readableFenceIssueIds ?? [this.scope.fenceIssueId];
    if (!readableFences.includes(issueId) && !this.#issueIds.has(issueId)) {
      throw new Error("GitHub read escaped discovered issue/fence scope");
    }
    return issueId;
  }
}

/** Restricts a repository transport to one explicitly authorized work item. */
export interface GitHubMutationScope {
  repository: string;
  issueId: string;
  issueNumber: number;
  fenceIssueId: string;
  /** Fence issues this lane may inspect; only fenceIssueId remains writable. */
  readableFenceIssueIds?: readonly string[];
  projectId: string;
  projectItemId: string;
  statusFieldId: string;
  gateFieldId: string;
}

export class ScopedGitHubTransport implements GitHubTransport {
  constructor(readonly delegate: GitHubTransport, readonly scope: GitHubMutationScope) {}
  async listIssues(repository: string, cursor: string | null, updatedSince: string | null = null): Promise<Page<GitHubIssueRecord>> {
    if (cursor !== null) return { nodes: [], nextCursor: null };
    let providerCursor: string | null = null;
    do {
      const page = await this.delegate.listIssues(repository, providerCursor, updatedSince);
      const issue = page.nodes.find((candidate) => candidate.id === this.scope.issueId);
      if (issue) return { nodes: [issue], nextCursor: null };
      providerCursor = page.nextCursor;
    } while (providerCursor !== null);
    throw new Error(`scoped GitHub issue ${this.scope.issueId} is missing`);
  }
  getIssuesByNodeIds(ids: readonly string[]): Promise<(GitHubIssueRecord | null)[]> {
    if (ids.some((id) => id !== this.scope.issueId)) throw new Error("GitHub node request escaped configured issue scope");
    return this.delegate.getIssuesByNodeIds(ids);
  }
  mergePullRequest(pullRequestId: string, commitHeadline: string): Promise<void> { return this.delegate.mergePullRequest(pullRequestId, commitHeadline); }
  containsCommit(repository: string, base: string, head: string): Promise<boolean> { return this.delegate.containsCommit(repository, base, head); }
  listLabels(issueId: string, cursor: string | null): Promise<Page<string>> { return this.delegate.listLabels(this.assertIssue(issueId), cursor); }
  listBlockedBy(issueId: string, cursor: string | null): Promise<Page<GitHubIssueLink>> { return this.delegate.listBlockedBy(this.assertIssue(issueId), cursor); }
  listProjectItems(issueId: string, cursor: string | null): Promise<Page<GitHubProjectItem>> { return this.delegate.listProjectItems(this.assertIssue(issueId), cursor); }
  listProjectFieldValues(itemId: string, cursor: string | null): Promise<Page<GitHubProjectFieldValue>> { return this.delegate.listProjectFieldValues(itemId, cursor); }
  listComments(issueId: string, cursor: string | null): Promise<Page<GitHubComment>> {
    const readableFences = this.scope.readableFenceIssueIds ?? [this.scope.fenceIssueId];
    if (issueId !== this.scope.issueId && !readableFences.includes(issueId)) throw new Error("GitHub comment request escaped configured issue/fence scope");
    return this.delegate.listComments(issueId, cursor);
  }
  listClosingPullRequests(issueId: string, cursor: string | null): Promise<Page<GitHubPullRequestEvidence>> { return this.delegate.listClosingPullRequests(this.assertIssue(issueId), cursor); }
  listFailedCheckDetails(repository: string, headSha: string): Promise<GitHubFailedCheckDetail[]> {
    if (repository !== this.scope.repository) throw new Error("GitHub request escaped configured repository scope");
    return this.delegate.listFailedCheckDetails(repository, headSha);
  }
  getBranch(repository: string, branchName: string): Promise<GitHubBranchEvidence | null> { return this.delegate.getBranch(repository, branchName); }
  getBaseSha(repository: string, branchName: string): Promise<string> { return this.delegate.getBaseSha(repository, branchName); }
  appendComment(issueId: string, body: string): Promise<GitHubComment> {
    if (issueId !== this.scope.issueId && issueId !== this.scope.fenceIssueId) throw new Error("GitHub comment mutation escaped configured issue/fence scope");
    return this.delegate.appendComment(issueId, body);
  }
  updateIssueBody(repository: string, issueNumber: number, body: string, expectedUpdatedAt: string): Promise<boolean> {
    if (repository !== this.scope.repository || issueNumber !== this.scope.issueNumber) {
      throw new Error("GitHub body mutation escaped configured issue scope");
    }
    return this.delegate.updateIssueBody(repository, issueNumber, body, expectedUpdatedAt);
  }
  replaceLabels(repository: string, issueNumber: number, labels: readonly string[]): Promise<void> {
    if (repository !== this.scope.repository || issueNumber !== this.scope.issueNumber) {
      throw new Error("GitHub label mutation escaped configured repository/issue scope");
    }
    return this.delegate.replaceLabels(repository, issueNumber, labels);
  }
  updateProjectSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    if (projectId !== this.scope.projectId || itemId !== this.scope.projectItemId || fieldId !== this.scope.statusFieldId) {
      throw new Error("GitHub Project status mutation escaped configured item scope");
    }
    return this.delegate.updateProjectSingleSelect(projectId, itemId, fieldId, optionId);
  }
  updateProjectText(projectId: string, itemId: string, fieldId: string, value: string): Promise<void> {
    if (projectId !== this.scope.projectId || itemId !== this.scope.projectItemId || fieldId !== this.scope.gateFieldId) {
      throw new Error("GitHub Project gate mutation escaped configured item scope");
    }
    return this.delegate.updateProjectText(projectId, itemId, fieldId, value);
  }

  private assertIssue(issueId: string): string {
    if (issueId !== this.scope.issueId) throw new Error("GitHub request escaped configured issue scope");
    return issueId;
  }
}
