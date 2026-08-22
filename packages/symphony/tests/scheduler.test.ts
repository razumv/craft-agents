// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  CrashRestartSimulator,
  DeterministicScheduler,
  OwnerDirectiveLedger,
  RiskPolicy,
  loadWorkflow,
  parseIssueContract,
  parseOwnerGateDecision,
  type RiskTier,
  type WorkflowDefinition,
} from "../src";

let workflow: WorkflowDefinition;

beforeAll(async () => {
  workflow = await loadWorkflow(resolve(import.meta.dir, "fixtures/WORKFLOW.md"));
});

function issue(id = "issue-45", identifier = "CP-45") {
  return {
    id,
    native_ref: { repository_id: "fake-repository" },
    identifier,
    title: "Deterministic scheduler core",
    description: "Local simulator only",
    priority: 1,
    state: "ready",
    branch_name: null,
    url: `https://example.test/issues/${identifier}`,
    assignee_id: "fake-codex",
    labels: [" V4 ", "v4"],
    blocked_by: [],
    dispatchable: true,
    created_at: "2026-08-18T18:00:00+02:00",
    updated_at: "2026-08-18T18:00:00+02:00",
  };
}

function contract(risk: RiskTier = "low", deploy?: "none" | "dev" | "production-gated"): string {
  const budget = workflow.config.verification[risk].budget;
  // Risk and deploy authority are independent: high-risk work that ships nothing
  // is common, and the two gates answer different questions.
  const deployAuthority = deploy ?? (risk === "high" ? "production-gated" : risk === "medium" ? "dev" : "none");
  return `## Work contract

\`\`\`yaml
id: V4-CORE
goal: Build deterministic issue execution without live mutations.
risk: ${risk}
deployAuthority: ${deployAuthority}
model: pi/gpt-5.6-sol
verificationBudget: ${budget}
nonGoals:
  - live GitHub writes
  - live Craft sessions
acceptance:
  - exactly-once claim
  - deterministic restart recovery
\`\`\`
`;
}

describe("v4.1 deterministic scheduler core", () => {
  test("exactly-once claim under concurrent ticks", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    simulator.seed(issue(), contract());
    const competingScheduler = new DeterministicScheduler(
      workflow.config,
      { github: simulator.github, craft: simulator.craft, workspaces: simulator.workspaces },
      simulator.clock,
    );

    await Promise.all([simulator.scheduler.tick(), competingScheduler.tick()]);

    expect(simulator.github.claimSuccessCount).toBe(1);
    expect(simulator.github.get("issue-45").issue.state).toBe("running");
  });

  test("a preservation push failure becomes a durable diagnostic without escaping the lane tick", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    simulator.seed(issue(), contract());
    const diagnostic = "preservation push failed for v4-preserved/v4-CP-45-a1-1234567: remote rejected; local branch remains and the interrupted worktree was not released";
    const scheduler = new DeterministicScheduler(workflow.config, {
      github: simulator.github,
      craft: simulator.craft,
      workspaces: { ensure: async () => { throw new Error(diagnostic); } },
    }, simulator.clock);

    await expect(scheduler.tick()).resolves.toBeUndefined();
    expect(simulator.github.get("issue-45")).toMatchObject({
      issue: { state: "retry-wait" },
      retry: { failureClass: "runtime", reason: diagnostic },
    });
    expect(simulator.craft.count()).toBe(0);
  });

  test("shadow preview is restart-stable and creates no claim, session, or worktree", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    simulator.seed(issue(), contract());

    const first = await simulator.scheduler.preview("issue-45");
    simulator.restart();
    const afterRestart = await simulator.scheduler.preview("issue-45");

    expect(first).toEqual(afterRestart);
    expect(first).toMatchObject({
      action: "claim",
      attempt: 1,
      issueId: "issue-45",
      reason: "eligible deterministic dispatch (shadow only)",
    });
    expect(first.run?.sessionId).toMatch(/^craft-/);
    expect(first.claimFence).toMatch(/^claim-/);
    expect(simulator.github.claimSuccessCount).toBe(0);
    expect(simulator.craft.count()).toBe(0);
    expect(simulator.workspaces.count()).toBe(0);
  });

  test("repeated ticks and scheduler replacement do not duplicate session or worktree identity", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    simulator.seed(issue(), contract());

    await simulator.scheduler.tick();
    await simulator.scheduler.tick();
    simulator.restart();
    await simulator.scheduler.tick();

    expect(simulator.github.claimSuccessCount).toBe(1);
    expect(simulator.craft.count()).toBe(1);
    expect(simulator.workspaces.count()).toBe(1);
  });

  test("restart recovers a fenced claim from durable adapter truth", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    simulator.seed(issue(), contract());

    await simulator.crashTick("after-claim");
    const claimed = simulator.github.get("issue-45");
    expect(claimed.issue.state).toBe("claimed");
    expect(simulator.craft.count()).toBe(0);
    expect(simulator.workspaces.count()).toBe(0);

    simulator.restart();
    await simulator.scheduler.tick();
    const recovered = simulator.github.get("issue-45");

    expect(recovered.issue.state).toBe("running");
    expect(recovered.claim?.sessionId).toBe(claimed.claim?.sessionId);
    expect(recovered.claim?.workspaceId).toBe(claimed.claim?.workspaceId);
    expect(simulator.craft.count()).toBe(1);
    expect(simulator.workspaces.count()).toBe(1);
  });

  test("stale runs use exponential backoff and stop at the bounded attempt limit", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    simulator.seed(issue(), contract());

    for (let attempt = 1; attempt <= workflow.config.scheduler.maxAttempts; attempt += 1) {
      await simulator.scheduler.tick();
      const running = simulator.github.get("issue-45");
      expect(running.claim?.attempt).toBe(attempt);
      simulator.craft.setStatus(running.claim!.sessionId, "failed");
      simulator.clock.advance(workflow.config.scheduler.staleRunMs);
      await simulator.scheduler.tick();

      const afterFailure = simulator.github.get("issue-45");
      if (attempt < workflow.config.scheduler.maxAttempts) {
        const expectedDelay = Math.min(
          workflow.config.scheduler.retryBaseMs * 2 ** (attempt - 1),
          workflow.config.scheduler.retryMaxMs,
        );
        expect(afterFailure.issue.state).toBe("retry-wait");
        expect(afterFailure.retry?.dueAtMs).toBe(simulator.clock.nowMs() + expectedDelay);
        await simulator.scheduler.tick();
        expect(simulator.github.get("issue-45").issue.state).toBe("retry-wait");
        simulator.clock.advance(expectedDelay);
      } else {
        expect(afterFailure.issue.state).toBe("failed");
        expect(afterFailure.retry).toBeNull();
      }
    }

    await simulator.scheduler.tick();
    expect(simulator.github.claimSuccessCount).toBe(workflow.config.scheduler.maxAttempts);
    expect(simulator.craft.count()).toBe(workflow.config.scheduler.maxAttempts);
    expect(simulator.workspaces.count()).toBe(workflow.config.scheduler.maxAttempts);
  });

  test("each silent-run cause reaches the ledger with its own detection wording and exact preserved commit", async () => {
    const cases = [
      {
        cause: "provider-or-connection-failure" as const,
        status: "failed" as const,
        lastObserved: "error message err-1: Provider connection reset while streaming",
      },
      {
        cause: "no-output" as const,
        status: "ended-without-response" as const,
        lastObserved: "frozen prompt accepted; session stopped with workflow status stopped and produced no persisted output",
      },
      {
        cause: "ending-lost" as const,
        status: "ended-without-response" as const,
        lastObserved: "assistant message progress-1: Implemented 242 lines and started focused tests",
      },
    ];

    for (const item of cases) {
      const simulator = new CrashRestartSimulator(workflow);
      simulator.seed(issue(), contract());
      await simulator.scheduler.tick();
      const running = simulator.github.get("issue-45");
      simulator.craft.setStatus(running.claim!.sessionId, item.status, item);
      simulator.clock.advance(workflow.config.scheduler.staleRunMs);
      const workspaces = item.cause === "ending-lost"
        ? {
            ensure: simulator.workspaces.ensure.bind(simulator.workspaces),
            preserveInterrupted: async () => ({
              branch: "v4/CP-45",
              commit: "2".repeat(40),
              preservedBranch: "v4-preserved/v4-CP-45-a1-2222222",
            }),
          }
        : simulator.workspaces;
      const scheduler = new DeterministicScheduler(
        workflow.config,
        { github: simulator.github, craft: simulator.craft, workspaces },
        simulator.clock,
      );
      await scheduler.tick();

      const failed = simulator.github.get("issue-45");
      const message = failed.events.at(-1)!.message;
      expect(message).toContain(`silent run cause ${item.cause}`);
      expect(message).toContain(`last observed: ${item.lastObserved}`);
      if (item.cause === "ending-lost") {
        expect(message).toContain(`branch commit ${"2".repeat(40)} preserved as v4-preserved/v4-CP-45-a1-2222222`);
        expect(failed.evidence).toMatchObject({
          silentRunCommit: "2".repeat(40),
          silentRunPreservedBranch: "v4-preserved/v4-CP-45-a1-2222222",
        });
      } else {
        expect(message).toContain(`branch commit ${running.claim!.baseSha} equals the attempt base`);
      }
    }
  });

  test("the third identical silent death is reported instead of consuming another attempt", async () => {
    const fourAttemptWorkflow: WorkflowDefinition = {
      ...workflow,
      config: {
        ...workflow.config,
        scheduler: { ...workflow.config.scheduler, maxAttempts: 4 },
      },
    };
    const simulator = new CrashRestartSimulator(fourAttemptWorkflow);
    simulator.seed(issue(), contract());
    const observation = {
      cause: "no-output" as const,
      lastObserved: "frozen prompt accepted; session stopped with workflow status stopped and produced no persisted output",
    };

    for (let attempt = 1; attempt <= 3; attempt += 1) {
      await simulator.scheduler.tick();
      const running = simulator.github.get("issue-45");
      expect(running.claim?.attempt).toBe(attempt);
      simulator.craft.setStatus(running.claim!.sessionId, "ended-without-response", observation);
      simulator.clock.advance(fourAttemptWorkflow.config.scheduler.staleRunMs);
      await simulator.scheduler.tick();
      const terminal = simulator.github.get("issue-45");
      if (attempt < 3) {
        expect(terminal.issue.state).toBe("retry-wait");
        simulator.clock.advance(terminal.retry!.dueAtMs - simulator.clock.nowMs());
      } else {
        expect(terminal.issue.state).toBe("failed");
        expect(terminal.retry).toBeNull();
        expect(terminal.events.at(-1)?.message).toContain("unchanged terminal evidence observed 3 times, so another attempt is suppressed");
      }
    }

    await simulator.scheduler.tick();
    expect(simulator.github.claimSuccessCount).toBe(3);
  });

  test("a transient provider transport failure still schedules an ordinary retry", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    simulator.seed(issue(), contract());
    await simulator.scheduler.tick();
    const running = simulator.github.get("issue-45");
    simulator.craft.setStatus(running.claim!.sessionId, "failed", {
      cause: "provider-or-connection-failure",
      lastObserved: "error message transport-1: transient provider connection reset",
    });
    simulator.clock.advance(workflow.config.scheduler.staleRunMs);
    await simulator.scheduler.tick();

    expect(simulator.github.get("issue-45")).toMatchObject({
      issue: { state: "retry-wait" },
      retry: { attempt: 2, failureClass: "runtime" },
      evidence: { silentRunOccurrences: 1, silentRunCause: "provider-or-connection-failure" },
    });
  });

  test("a revived issue is claimed through the unchanged ready scheduler path as attempt one", async () => {
    const oneAttemptWorkflow: WorkflowDefinition = {
      ...workflow,
      config: {
        ...workflow.config,
        scheduler: { ...workflow.config.scheduler, maxAttempts: 1 },
      },
    };
    const simulator = new CrashRestartSimulator(oneAttemptWorkflow);
    simulator.seed(issue(), contract());

    await simulator.scheduler.tick();
    let running = simulator.github.get("issue-45");
    simulator.craft.setStatus(running.claim!.sessionId, "failed");
    simulator.clock.advance(oneAttemptWorkflow.config.scheduler.staleRunMs);
    await simulator.scheduler.tick();
    expect(simulator.github.get("issue-45").issue.state).toBe("failed");

    const revived = simulator.github.reviveFailed("issue-45", "provider quota reset OPS-42", simulator.clock.nowMs());
    expect(revived).toMatchObject({ accepted: true, snapshot: { issue: { state: "ready" } } });
    await simulator.scheduler.tick();

    running = simulator.github.get("issue-45");
    expect(running.issue.state).toBe("running");
    expect(running.claim?.attempt).toBe(1);
    expect(simulator.github.claimSuccessCount).toBe(2);
  });

  test("failed bounded cancellation preserves the claim instead of starting a replacement", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    simulator.seed(issue(), contract());
    await simulator.scheduler.tick();

    const scheduler = new DeterministicScheduler(
      workflow.config,
      {
        github: simulator.github,
        workspaces: simulator.workspaces,
        craft: {
          ensure: (identity) => simulator.craft.ensure(identity),
          get: async () => ({ status: "turn-deadline" }),
          cancel: async () => ({ status: "cancel-deadline" }),
        },
      },
      simulator.clock,
    );
    await scheduler.tick();

    expect(simulator.github.get("issue-45").issue.state).toBe("preservation-unknown");
    expect(simulator.github.claimSuccessCount).toBe(1);
  });

  test("auto-merge is off unless configured, and never exceeds the contract's risk ceiling", async () => {
    const attempts: string[] = [];
    const build = (autoMerge?: { enabled: boolean; maxRisk: RiskTier }, risk: RiskTier = "low") => {
      const simulator = new CrashRestartSimulator(workflow);
      simulator.seed(issue(), contract(risk));
      const github = simulator.github as unknown as {
        mergeClosingPullRequest?: (issueId: string) => Promise<{ merged: boolean; reason: string }>;
      };
      github.mergeClosingPullRequest = async (issueId: string) => {
        attempts.push(issueId);
        return { merged: true, reason: "test" };
      };
      return { simulator, config: autoMerge ? { ...workflow.config, autoMerge } : workflow.config };
    };

    // No policy: nothing is ever merged, which is the default the fleet ran on.
    const off = build();
    await new DeterministicScheduler(off.config, { github: off.simulator.github, workspaces: off.simulator.workspaces, craft: off.simulator.craft }, off.simulator.clock).tick();
    expect(attempts).toBeEmpty();

    // Enabled, but the contract declares more risk than the ceiling allows.
    const tooRisky = build({ enabled: true, maxRisk: "low" }, "high");
    await new DeterministicScheduler(tooRisky.config, { github: tooRisky.simulator.github, workspaces: tooRisky.simulator.workspaces, craft: tooRisky.simulator.craft }, tooRisky.simulator.clock).tick();
    expect(attempts).toBeEmpty();
  });

  test("a ceiling that admits the risk satisfies its own gate instead of waiting for a second answer", async () => {
    const diagnostics: string[] = [];
    const simulator = new CrashRestartSimulator(workflow);
    const seeded = simulator.seed(issue(), contract("high", "none"));
    const github = simulator.github as unknown as {
      mergeReadiness?: (issueId: string) => Promise<{ ready: boolean; reason: string; headSha: string }>;
      mergeClosingPullRequest?: (issueId: string) => Promise<{ merged: boolean; reason: string }>;
    };
    let merged = 0;
    github.mergeReadiness = async () => ({ ready: true, reason: "mergeable with passing checks", headSha: "f".repeat(40) });
    github.mergeClosingPullRequest = async () => { merged += 1; return { merged: true, reason: "mergeable with passing checks" }; };

    // The ceiling admits high risk: the owner has delegated that decision, so the
    // lane must honour the delegation. Raising a gate nothing can leave is a trap —
    // the approval is recorded but no code acts on it.
    const config = { ...workflow.config, autoMerge: { enabled: true, maxRisk: "high" as RiskTier } };
    const scheduler = new DeterministicScheduler(config,
      { github: simulator.github, workspaces: simulator.workspaces, craft: simulator.craft, onDiagnostic: (m) => diagnostics.push(m) },
      simulator.clock);
    await scheduler.tick();
    const claim = (await simulator.github.activeClaims())[0]?.claim;
    if (claim) {
      await simulator.github.transition(seeded.id, "pr-open", simulator.clock.nowMs(), {
        fence: claim.fence,
        evidence: { prUrl: "https://github.test/acme/repo/pull/1" },
      });
    }
    await scheduler.tick();

    // The gate is still raised and recorded — the invariant that high risk merges
    // only out of owner-gate is untouched — and then answered by the policy.
    expect(diagnostics.join(" ")).toContain("approval delegated by the configured ceiling");
    expect(merged).toBe(1);
  });

  test("work above the ceiling is raised to the owner gate, and only when the provider says it could land", async () => {
    const drive = async (ready: boolean) => {
      const diagnostics: string[] = [];
      const simulator = new CrashRestartSimulator(workflow);
      const seeded = simulator.seed(issue(), contract("high"));
      const github = simulator.github as unknown as {
        mergeReadiness?: (issueId: string) => Promise<{ ready: boolean; reason: string; headSha: string }>;
        mergeClosingPullRequest?: (issueId: string) => Promise<{ merged: boolean; reason: string }>;
      };
      let merged = false;
      github.mergeClosingPullRequest = async () => { merged = true; return { merged: true, reason: "should not happen" }; };
      github.mergeReadiness = async () => ready
        ? { ready: true, reason: "mergeable with passing checks", headSha: "f".repeat(40) }
        : { ready: false, reason: "checks are FAILURE", headSha: "f".repeat(40) };

      const config = { ...workflow.config, autoMerge: { enabled: true, maxRisk: "medium" as RiskTier } };
      const adapters = {
        github: simulator.github,
        workspaces: simulator.workspaces,
        craft: simulator.craft,
        onDiagnostic: (message: string) => diagnostics.push(message),
      };
      const scheduler = new DeterministicScheduler(config, adapters, simulator.clock);
      // Claim and start, then put the run where a finished agent leaves it.
      await scheduler.tick();
      const claim = (await simulator.github.activeClaims())[0]?.claim;
      if (claim) {
        await simulator.github.transition(seeded.id, "pr-open", simulator.clock.nowMs(), {
          fence: claim.fence,
          evidence: { prUrl: "https://github.test/acme/repo/pull/1" },
        });
      }
      await scheduler.tick();
      return { diagnostics: diagnostics.join(" "), merged, state: (await simulator.github.get(seeded.id)).issue.state };
    };

    // Green and above the ceiling: the owner is given something to decide, and the
    // lane does not land it itself.
    const green = await drive(true);
    expect(green.diagnostics).toContain("owner gate raised");
    expect(green.merged).toBeFalse();
    expect(green.state).toBe("owner-gate");

    // Red and above the ceiling: an owner asked to approve what CI has not passed
    // is being asked to guess, so no gate is raised and it stays where it was.
    const red = await drive(false);
    expect(red.diagnostics).toContain("owner gate withheld");
    expect(red.state).toBe("pr-open");
  });

  test("an unchanged stuck PR verdict parks at the cycle bound and frees WIP without closing work", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    const first = simulator.seed(issue(), contract());
    simulator.seed(issue("issue-46", "CP-46"), contract());
    const verdict = {
      disposition: "stuck" as const,
      verdict: "mergeability is CONFLICTING",
      resumeCondition: "the branch must be updated to resolve conflicts with main",
    };
    Object.assign(simulator.github, { pullRequestVerdict: async () => verdict });

    await simulator.scheduler.tick();
    const claim = simulator.github.get(first.id).claim!;
    simulator.github.transition(first.id, "pr-open", simulator.clock.nowMs(), {
      fence: claim.fence,
      evidence: {
        branchUrl: "https://github.test/acme/repo/tree/v4/acme-repo-45",
        prUrl: "https://github.test/acme/repo/pull/45",
      },
    });

    await simulator.scheduler.tick();
    expect(simulator.github.get(first.id).evidence.prOpenVerdictCycles).toBe(1);
    // Replacing the scheduler proves the count is durable evidence, not process memory.
    simulator.restart();
    await simulator.scheduler.tick();
    expect(simulator.github.get(first.id).evidence.prOpenVerdictCycles).toBe(2);
    await simulator.scheduler.tick();

    const parked = simulator.github.get(first.id);
    expect(parked.issue.state).toBe("blocked");
    expect(parked.issue.closed).toBeFalse();
    expect(parked.claim).toBeNull();
    expect(parked.evidence.branchUrl).toBe("https://github.test/acme/repo/tree/v4/acme-repo-45");
    expect(parked.evidence.prUrl).toBe("https://github.test/acme/repo/pull/45");
    expect(parked.evidence.blocker).toContain(verdict.verdict);
    expect(parked.evidence.blocker).toContain(`To resume: ${verdict.resumeCondition}`);
    // The same threshold tick can spend the released WIP slot on the next issue.
    expect(simulator.github.get("issue-46")).toMatchObject({ issue: { state: "running" }, claim: { issueId: "issue-46" } });
  });

  test("the stuck count resets when the exact verdict changes", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    const seeded = simulator.seed(issue(), contract());
    const conflict = {
      disposition: "stuck" as const, verdict: "mergeability is CONFLICTING",
      resumeCondition: "resolve conflicts",
    };
    const noChecks = {
      disposition: "stuck" as const, verdict: "no checks ran on the head commit",
      resumeCondition: "run and pass a required check",
    };
    const observations = [conflict, conflict, noChecks, conflict, conflict, conflict];
    Object.assign(simulator.github, { pullRequestVerdict: async () => observations.shift() ?? conflict });
    await simulator.scheduler.tick();
    const claim = simulator.github.get(seeded.id).claim!;
    simulator.github.transition(seeded.id, "pr-open", simulator.clock.nowMs(), {
      fence: claim.fence, evidence: { prUrl: "https://github.test/acme/repo/pull/45" },
    });

    for (const expected of [1, 2, 1, 1, 2]) {
      await simulator.scheduler.tick();
      expect(simulator.github.get(seeded.id)).toMatchObject({
        issue: { state: "pr-open" }, evidence: { prOpenVerdictCycles: expected },
      });
    }
    await simulator.scheduler.tick();
    expect(simulator.github.get(seeded.id).issue.state).toBe("blocked");
  });

  test("queued, running, review-requested, and behind PRs wait by cycles regardless of elapsed time", async () => {
    const waiting = [
      ["checks are QUEUED", "queued checks must finish"],
      ["checks are RUNNING", "running checks must finish"],
      ["review is REQUESTED", "the requested review must approve"],
      ["base branch is BEHIND", "the branch must catch up with main"],
    ] as const;
    for (const [verdict, resumeCondition] of waiting) {
      const simulator = new CrashRestartSimulator(workflow);
      const seeded = simulator.seed(issue(), contract());
      Object.assign(simulator.github, {
        pullRequestVerdict: async () => ({
          disposition: "waiting" as const, verdict, resumeCondition,
        }),
      });
      await simulator.scheduler.tick();
      const claim = simulator.github.get(seeded.id).claim!;
      simulator.github.transition(seeded.id, "pr-open", simulator.clock.nowMs(), {
        fence: claim.fence, evidence: { prUrl: "https://github.test/acme/repo/pull/45" },
      });
      for (let cycle = 0; cycle < workflow.config.scheduler.prOpenStuckCycles + 1; cycle += 1) {
        simulator.clock.advance(24 * 60 * 60 * 1_000);
        await simulator.scheduler.tick();
      }
      expect(simulator.github.get(seeded.id)).toMatchObject({
        issue: { state: "pr-open" },
        claim: { issueId: seeded.id },
        evidence: { prOpenVerdict: verdict, prOpenVerdictCycles: 0 },
      });
    }
  });

  test("owner directives are immutable and gates require exact IDs", () => {
    const ledger = new OwnerDirectiveLedger();
    const entry = ledger.append({
      id: "directive-1",
      issueId: "issue-45",
      receivedAtMs: 1000,
      acknowledgedAtMs: 1050,
      verbatim: "Do not touch production.",
    });
    expect(ledger.append({ ...entry })).toBe(entry);
    expect(() => ledger.append({ ...entry, verbatim: "Touch production." })).toThrow("immutable");
    expect(() => ((ledger.entries()[0] as { verbatim: string }).verbatim = "mutated")).toThrow();
    expect(parseOwnerGateDecision("APPROVE gate-45", "gate-45")).toEqual({ kind: "approve", gateId: "gate-45" });
    expect(() => parseOwnerGateDecision("APPROVE gate-54", "gate-45")).toThrow("exactly match");
  });

  test("risk policy enforces the declared budget and forbids audit loops", () => {
    const policy = new RiskPolicy(workflow.config.verification);
    const low = parseIssueContract(contract("low"), "CP-45", workflow.config);
    const medium = parseIssueContract(contract("medium"), "CP-46", workflow.config);
    const high = parseIssueContract(contract("high"), "CP-47", workflow.config);

    expect(policy.budgetFor(low).independentReviews).toBe(0);
    expect(() => policy.assertIndependentReviewAllowed(low, 0)).toThrow("forbidden");
    expect(() => policy.assertIndependentReviewAllowed(medium, 0)).not.toThrow();
    expect(() => policy.assertIndependentReviewAllowed(medium, 1)).toThrow("audit loop");
    expect(policy.budgetFor(high).ownerGate).toBeTrue();
    expect(() => policy.assertCorrectionAllowed(high, 0)).not.toThrow();
    expect(() => policy.assertCorrectionAllowed(high, 1)).toThrow("another correction");
  });

  test("end-to-end simulator smoke survives a crash and reaches structured done status", async () => {
    const simulator = new CrashRestartSimulator(workflow);
    simulator.seed(issue(), contract());

    const status = await simulator.runSmoke("issue-45");

    expect(status.state).toBe("done");
    expect(status.objective).toContain("deterministic issue execution");
    expect(status.prUrl).toBe("https://example.test/pull/45");
    expect(status.nextCompletionPoint).toBe("complete");
    expect(status.lastMaterialEvent?.message).toBe("workflow outcome complete");
    expect(simulator.github.activeClaims()).toHaveLength(0);
    expect(simulator.craft.count()).toBe(1);
    expect(simulator.workspaces.count()).toBe(1);
  });
});
