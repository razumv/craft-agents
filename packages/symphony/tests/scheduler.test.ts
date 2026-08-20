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

function contract(risk: RiskTier = "low"): string {
  const budget = workflow.config.verification[risk].budget;
  const deployAuthority = risk === "high" ? "production-gated" : risk === "medium" ? "dev" : "none";
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
