// SPDX-License-Identifier: Apache-2.0

import type { CraftStartContext } from "./craft-adapter";
import type { Claim, ProjectStatus, RiskTier, RunIdentity, TrackerIssueSnapshot, WorkflowConfig } from "./domain";
import { IdentityFactory } from "./identity";
import { ModelPolicy, RiskPolicy } from "./policy";
import { projectStatus } from "./status";
import type { TrackerAdapter } from "./tracker";

export interface Clock {
  nowMs(): number;
}

export class ManualClock implements Clock {
  constructor(private value = 0) {}
  nowMs(): number { return this.value; }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("clock advance must be non-negative");
    this.value += ms;
  }
}

export type CrashPoint = "after-claim" | "after-workspace" | "after-session";
export class SimulatedCrash extends Error {
  constructor(readonly point: CrashPoint) {
    super(`simulated scheduler crash ${point}`);
  }
}

export interface SchedulerCraftSession {
  status: string;
}

/** Provider-independent Craft seam; the simulator and RPC adapter both implement it. */
export interface SchedulerCraftAdapter {
  ensure(identity: RunIdentity, context?: CraftStartContext): Promise<SchedulerCraftSession>;
  get(sessionId: string, nowMs?: number): SchedulerCraftSession | null | Promise<SchedulerCraftSession | null>;
  cancel?(sessionId: string, nowMs: number): Promise<SchedulerCraftSession>;
}

export interface SchedulerWorkspaceAdapter {
  ensure(identity: RunIdentity, context?: CraftStartContext): Promise<unknown>;
  /**
   * Read-only: could a claim for this branch actually take it? Optional, so a
   * simulator or test double needs nothing new.
   */
  probeBranch?(claim: Claim, requiredBranch: string): Promise<{ claimable: boolean; reason: string }>;
}

export interface SchedulerAdapters {
  github: TrackerAdapter;
  craft: SchedulerCraftAdapter;
  workspaces: SchedulerWorkspaceAdapter;
  /** Injected sink for decisions worth saying out loud (auto-merge refusals). */
  onDiagnostic?: (message: string) => void;
}

const riskOrder = { low: 0, medium: 1, high: 2 } as const;

function riskAtMost(risk: RiskTier, ceiling: RiskTier): boolean {
  return riskOrder[risk] <= riskOrder[ceiling];
}

export type ShadowProposal =
  | {
      action: "claim" | "resume";
      reason: string;
      issueId: string;
      issueIdentifier: string;
      state: TrackerIssueSnapshot["issue"]["state"];
      attempt: number;
      claimFence: string;
      run: RunIdentity;
    }
  | {
      action: "observe";
      reason: string;
      issueId: string;
      issueIdentifier: string;
      state: TrackerIssueSnapshot["issue"]["state"];
      attempt: number | null;
      claimFence: string | null;
      run: RunIdentity | null;
    };

export class DeterministicScheduler {
  readonly #identity: IdentityFactory;
  readonly #models: ModelPolicy;
  readonly #risk: RiskPolicy;
  #startupReconciled = false;

  constructor(
    readonly config: WorkflowConfig,
    readonly adapters: SchedulerAdapters,
    readonly clock: Clock,
  ) {
    if (config.scheduler.wipLimit !== 1) throw new Error("v4 increment 1 requires WIP=1");
    this.#identity = new IdentityFactory(config.workspace.root);
    this.#models = new ModelPolicy(config.model);
    this.#risk = new RiskPolicy(config.verification);
  }

  async tick(crashAfter?: CrashPoint): Promise<void> {
    if (!this.#startupReconciled) {
      await this.adapters.github.reconcileStartup?.(this.clock.nowMs());
      this.#startupReconciled = true;
    }
    await this.reconcile(crashAfter);
    if ((await this.adapters.github.activeClaims()).length >= this.config.scheduler.wipLimit) return;

    const candidates = await this.adapters.github.fetchIssuesByStates(["ready", "retry-wait"]);
    for (const candidate of candidates.sort(compareForDispatch)) {
      if (!this.dispatchable(candidate)) continue;
      this.#models.assertAllowed(candidate.contract.modelProfile);
      this.#risk.budgetFor(candidate.contract);
      const attempt = candidate.retry?.attempt ?? 1;
      const claim = this.#identity.claimFor(
        candidate.issue,
        attempt,
        candidate.version,
        candidate.baseSha,
        { ...this.config.model, defaultProfile: candidate.contract.modelProfile },
        this.clock.nowMs(),
        this.config.scheduler.claimTtlMs,
      );
      // Ask before spending the claim. `ensure` refuses a branch held by real
      // work — rightly, since discarding a worker's commits is worse than
      // burning an attempt — but it refuses after the claim exists, so a jammed
      // branch ate the whole retry budget one attempt at a time. Skipping the
      // candidate leaves it exactly as it was, for a person to look at, and
      // lets the tick dispatch something that can actually run.
      if (this.adapters.workspaces.probeBranch) {
        const probe = await this.adapters.workspaces.probeBranch(claim, candidate.contract.requiredBranch);
        if (!probe.claimable) {
          this.adapters.onDiagnostic?.(
            `skipping ${candidate.issue.identifier} without claiming: ${probe.reason}`,
          );
          continue;
        }
      }
      const claimed = await this.adapters.github.tryClaim(
        candidate.issue.id,
        candidate.version,
        claim,
        this.clock.nowMs(),
      );
      if (!claimed) continue;
      this.crashIf("after-claim", crashAfter);
      await this.startClaim(claimed, crashAfter);
      return;
    }
  }

  async status(issueId: string): Promise<ProjectStatus> {
    return projectStatus(await this.adapters.github.get(issueId));
  }

  /**
   * Discovery preview: what the next tick would act on across the whole
   * repository — the active claim if one occupies WIP, else the first
   * dispatchable candidate in deterministic dispatch order, else null.
   * Read-only, like preview().
   */
  async previewNext(): Promise<ShadowProposal | null> {
    const active = await this.adapters.github.activeClaims();
    const first = active[0];
    if (first) return this.preview(first.issue.id);
    const candidates = await this.adapters.github.fetchIssuesByStates(["ready", "retry-wait"]);
    for (const candidate of candidates.sort(compareForDispatch)) {
      if (this.dispatchable(candidate)) return this.preview(candidate.issue.id);
    }
    return null;
  }

  /**
   * Merge a finished low-risk pull request so the lane closes without a person.
   *
   * Deliberately narrow. The risk ceiling comes from the contract, not from how
   * the run went, so a medium or high contract never merges itself however green
   * it looks. Nothing here judges the change: the provider decides mergeability
   * and the checks decide correctness — this only declines to wait when both
   * have already spoken. Evidence advancement then carries the issue from
   * pr-open to merged to done on the merge the provider records, exactly as it
   * does for a merge performed by hand.
   */
  private async maybeAutoMerge(snapshot: TrackerIssueSnapshot): Promise<void> {
    const policy = this.config.autoMerge;
    if (!policy?.enabled) return;
    if (!this.adapters.github.mergeClosingPullRequest) return;
    if (snapshot.issue.state !== "pr-open") return;
    if (!riskAtMost(snapshot.contract.risk, policy.maxRisk)) return;
    // A contract that carries deployment authority is not ours to land.
    if (snapshot.contract.deployAuthority !== "none") return;
    const outcome = await this.adapters.github.mergeClosingPullRequest(snapshot.issue.id);
    this.adapters.onDiagnostic?.(
      `auto-merge ${outcome.merged ? "merged" : "declined"} ${snapshot.issue.identifier}: ${outcome.reason}`,
    );
  }

  /** Pure deterministic decision preview. It never claims, heartbeats, creates, or reconciles. */
  async preview(issueId: string): Promise<ShadowProposal> {
    const snapshot = await this.adapters.github.get(issueId);
    if (snapshot.claim) {
      const claim = snapshot.claim;
      return {
        action: "resume",
        reason: "durable claim exists; shadow would resume its exact identity",
        issueId: snapshot.issue.id,
        issueIdentifier: snapshot.issue.identifier,
        state: snapshot.issue.state,
        attempt: claim.attempt,
        claimFence: claim.fence,
        run: {
          issueId: claim.issueId,
          issueIdentifier: claim.issueIdentifier,
          attempt: claim.attempt,
          sessionId: claim.sessionId,
          workspaceId: claim.workspaceId,
          workspaceKey: claim.workspaceKey,
          workspacePath: claim.workspacePath,
        },
      };
    }
    if ((await this.adapters.github.activeClaims()).length >= this.config.scheduler.wipLimit) {
      return this.observation(snapshot, "project WIP limit is occupied");
    }
    if (snapshot.issue.state !== "ready" && snapshot.issue.state !== "retry-wait") {
      return this.observation(snapshot, `state ${snapshot.issue.state} is not dispatchable`);
    }
    if (!this.dispatchable(snapshot)) {
      const blockers = snapshot.issue.blockedBy
        .filter((blocker) => blocker.state?.trim().toLowerCase() !== "done")
        .map((blocker) => blocker.identifier ?? blocker.id ?? "unknown blocker")
        .join(", ");
      return this.observation(snapshot, blockers ? `blocked by ${blockers}` : "issue contract is not dispatchable");
    }
    this.#models.assertAllowed(snapshot.contract.modelProfile);
    this.#risk.budgetFor(snapshot.contract);
    const attempt = snapshot.retry?.attempt ?? 1;
    // Fence and identity are independent of wall-clock timestamps. Use zero only
    // to reuse the canonical claim builder, then return no lease timestamps.
    const claim = this.#identity.claimFor(
      snapshot.issue,
      attempt,
      snapshot.version,
      snapshot.baseSha,
      { ...this.config.model, defaultProfile: snapshot.contract.modelProfile },
      0,
      this.config.scheduler.claimTtlMs,
    );
    return {
      action: "claim",
      reason: "eligible deterministic dispatch (shadow only)",
      issueId: snapshot.issue.id,
      issueIdentifier: snapshot.issue.identifier,
      state: snapshot.issue.state,
      attempt,
      claimFence: claim.fence,
      run: {
        issueId: claim.issueId,
        issueIdentifier: claim.issueIdentifier,
        attempt: claim.attempt,
        sessionId: claim.sessionId,
        workspaceId: claim.workspaceId,
        workspaceKey: claim.workspaceKey,
        workspacePath: claim.workspacePath,
      },
    };
  }

  private observation(snapshot: TrackerIssueSnapshot, reason: string): ShadowProposal {
    return {
      action: "observe",
      reason,
      issueId: snapshot.issue.id,
      issueIdentifier: snapshot.issue.identifier,
      state: snapshot.issue.state,
      attempt: snapshot.retry?.attempt ?? null,
      claimFence: null,
      run: null,
    };
  }

  private async reconcile(crashAfter?: CrashPoint): Promise<void> {
    const now = this.clock.nowMs();
    // Durable evidence outranks the session: a dead run must not strand an
    // already-merged issue short of its terminal state.
    await this.adapters.github.advanceByEvidence?.(now);
    const activeClaims = await this.adapters.github.activeClaims();
    for (const snapshot of activeClaims.sort((a, b) => a.issue.id.localeCompare(b.issue.id))) {
      const claim = snapshot.claim!;
      if (!this.identityMatches(snapshot, claim)) {
        await this.adapters.github.transition(snapshot.issue.id, "preservation-unknown", now, {
          fence: claim.fence,
          message: "claim identity no longer matches deterministic workspace/session identity",
        });
        continue;
      }
      try {
        this.#models.assertAllowed(claim.modelProfile);
      } catch (error) {
        await this.adapters.github.failClaim(claim.fence, "policy", String(error), now, this.config.scheduler);
        continue;
      }

      if (snapshot.issue.state === "claimed") {
        const session = await this.adapters.craft.get(claim.sessionId, now);
        if (now >= claim.expiresAtMs && !session) {
          await this.adapters.github.failClaim(
            claim.fence,
            "runtime",
            "claim expired before its Craft session was durable",
            now,
            this.config.scheduler,
          );
          continue;
        }
        await this.startClaim(snapshot, crashAfter);
        continue;
      }
      if (snapshot.issue.state !== "running") {
        await this.maybeAutoMerge(snapshot);
        await this.adapters.github.heartbeat(claim.fence, now, this.config.scheduler.claimTtlMs);
        continue;
      }

      const session = await this.adapters.craft.get(claim.sessionId, now);
      if (session?.status === "off-contract") {
        // Reached only for a run still claiming to be running: durable merge
        // evidence is applied before this loop, so work that actually landed is
        // advanced on the provider's truth rather than judged by its session.
        // What is left is a run whose agent was told something outside the
        // frozen contract, which cannot be allowed to settle. Retryable on
        // purpose — a replacement attempt starts from a clean session.
        await this.adapters.github.failClaim(
          claim.fence,
          "runtime",
          "Craft execution session received transcript outside its frozen contract",
          now,
          this.config.scheduler,
        );
        continue;
      }
      const stale = now - claim.heartbeatAtMs >= this.config.scheduler.staleRunMs || now >= claim.expiresAtMs;
      const deadlineFailure = session && [
        "ended-without-response",
        "turn-deadline",
        "context-deadline",
        "cancel-deadline",
      ].includes(session.status);
      if (!session || session.status === "failed" || deadlineFailure) {
        if (deadlineFailure) {
          if (!this.adapters.craft.cancel) {
            await this.adapters.github.transition(snapshot.issue.id, "preservation-unknown", now, {
              fence: claim.fence,
              message: "Craft deadline reached without a cancellation/readback capability",
            });
            continue;
          }
          const cancelled = await this.adapters.craft.cancel(claim.sessionId, now);
          if (cancelled.status === "cancel-deadline") {
            await this.adapters.github.transition(snapshot.issue.id, "preservation-unknown", now, {
              fence: claim.fence,
              message: "Craft cancellation deadline expired before exact stopped readback",
            });
            continue;
          }
        }
        if (stale || deadlineFailure) {
          await this.adapters.github.failClaim(
            claim.fence,
            "runtime",
            !session
              ? "stale Craft run is missing"
              : session.status === "ended-without-response"
                ? "Craft turn ended without a final response"
                : `Craft run stopped at ${session.status}`,
            now,
            this.config.scheduler,
          );
        }
        continue;
      }
      if (session.status === "running") {
        await this.adapters.github.heartbeat(claim.fence, now, this.config.scheduler.claimTtlMs);
      } else if (stale) {
        await this.adapters.github.failClaim(
          claim.fence,
          "runtime",
          "agent settled without tracker handoff evidence",
          now,
          this.config.scheduler,
        );
      }
    }
  }

  private async startClaim(snapshot: TrackerIssueSnapshot, crashAfter?: CrashPoint): Promise<void> {
    const claim = snapshot.claim;
    if (!claim) throw new Error("cannot start without a claim");
    const identity: RunIdentity = {
      issueId: claim.issueId,
      issueIdentifier: claim.issueIdentifier,
      attempt: claim.attempt,
      sessionId: claim.sessionId,
      workspaceId: claim.workspaceId,
      workspaceKey: claim.workspaceKey,
      workspacePath: claim.workspacePath,
    };
    try {
      await this.adapters.workspaces.ensure(identity, {
        claim,
        issue: snapshot.issue,
        contract: snapshot.contract,
      });
      this.crashIf("after-workspace", crashAfter);
      await this.adapters.craft.ensure(identity, {
        claim,
        issue: snapshot.issue,
        contract: snapshot.contract,
      });
      this.crashIf("after-session", crashAfter);
      await this.adapters.github.markRunning(claim.fence, this.clock.nowMs());
    } catch (error) {
      if (error instanceof SimulatedCrash) throw error;
      await this.adapters.github.failClaim(
        claim.fence,
        "runtime",
        error instanceof Error ? error.message : String(error),
        this.clock.nowMs(),
        this.config.scheduler,
      );
    }
  }

  private dispatchable(snapshot: TrackerIssueSnapshot): boolean {
    if (!snapshot.issue.dispatchable) return false;
    if (snapshot.issue.state === "retry-wait" && (!snapshot.retry || snapshot.retry.dueAtMs > this.clock.nowMs())) return false;
    return !snapshot.issue.blockedBy.some((blocker) => blocker.state?.trim().toLowerCase() !== "done");
  }

  private identityMatches(snapshot: TrackerIssueSnapshot, claim: Claim): boolean {
    const expected = this.#identity.forAttempt(snapshot.issue, claim.attempt);
    return expected.sessionId === claim.sessionId
      && expected.workspaceId === claim.workspaceId
      && expected.workspaceKey === claim.workspaceKey
      && expected.workspacePath === claim.workspacePath;
  }

  private crashIf(point: CrashPoint, selected?: CrashPoint): void {
    if (point === selected) throw new SimulatedCrash(point);
  }
}

function compareForDispatch(left: TrackerIssueSnapshot, right: TrackerIssueSnapshot): number {
  const priority = (value: number | null): number => value !== null && value >= 1 && value <= 4 ? value : Number.MAX_SAFE_INTEGER;
  const priorityOrder = priority(left.issue.priority) - priority(right.issue.priority);
  if (priorityOrder !== 0) return priorityOrder;
  const created = (value: string | null): number => value ? Date.parse(value) : Number.MAX_SAFE_INTEGER;
  const createdOrder = created(left.issue.createdAt) - created(right.issue.createdAt);
  return createdOrder || left.issue.identifier.localeCompare(right.issue.identifier) || left.issue.id.localeCompare(right.issue.id);
}
