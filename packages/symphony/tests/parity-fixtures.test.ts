// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  CrashRestartSimulator,
  DeterministicScheduler,
  ModelPolicy,
  OwnerDirectiveLedger,
  assertLifecycleTransition,
  lifecycleStates,
  loadWorkflow,
  parseOwnerGateDecision,
  type LifecycleState,
} from "../src";
import parity from "./fixtures/v4.0.0-alpha.1-parity.json";

function issue() {
  return {
    id: "I_52",
    native_ref: { repository: parity.source.repository },
    identifier: "razumv/craft-protocol#52",
    title: "Released alpha parity fixture",
    description: "In-memory fixture only",
    priority: 1,
    state: "ready",
    branch_name: null,
    url: "https://example.test/issues/52",
    assignee_id: null,
    labels: ["v4"],
    blocked_by: [],
    dispatchable: true,
    created_at: "2026-08-18T18:00:00Z",
    updated_at: "2026-08-18T18:00:00Z"
  };
}

function contract(): string {
  return `## Work contract

\`\`\`yaml
id: V4-ALPHA-1-PARITY
goal: Preserve released scheduler behavior in the native package.
risk: low
deployAuthority: none
model: pi/gpt-5.6-sol
verificationBudget: targeted-tests-plus-one-simulator-smoke
nonGoals:
  - live provider mutation
acceptance:
  - deterministic restart reconstruction
\`\`\`
`;
}

describe("v4.0.0-alpha.1 behavior parity fixture", () => {
  test("pins the immutable released source", () => {
    expect(parity.source).toEqual({
      repository: "razumv/craft-protocol",
      tag: "v4.0.0-alpha.1",
      commit: "0767d0f2565d7f10a9ab5d46d7986162f20ab694",
    });
  });

  test("matches the exact lifecycle transition table", () => {
    expect(Object.keys(parity.lifecycle)).toEqual([...lifecycleStates]);
    for (const from of lifecycleStates) {
      const allowed = new Set(parity.lifecycle[from] as LifecycleState[]);
      for (const to of lifecycleStates) {
        if (allowed.has(to)) expect(() => assertLifecycleTransition(from, to)).not.toThrow();
        else expect(() => assertLifecycleTransition(from, to)).toThrow(`illegal lifecycle transition: ${from} -> ${to}`);
      }
    }
  });

  test("enforces the fixture's Codex-only model policy", () => {
    const policy = new ModelPolicy({
      connection: parity.modelPolicy.connection,
      defaultProfile: parity.modelPolicy.allowed[0]!,
      allowedProfiles: parity.modelPolicy.allowed,
    });
    for (const profile of parity.modelPolicy.allowed) expect(() => policy.assertAllowed(profile)).not.toThrow();
    for (const profile of parity.modelPolicy.rejected) expect(() => policy.assertAllowed(profile)).toThrow("model policy rejected");

    const wrongConnection = new ModelPolicy({
      connection: " ",
      defaultProfile: parity.modelPolicy.allowed[0]!,
      allowedProfiles: parity.modelPolicy.allowed,
    });
    expect(() => wrongConnection.assertAllowed(parity.modelPolicy.allowed[0]!)).toThrow("model policy rejected");
  });

  test("keeps directives immutable and gate commands exact", () => {
    const ledger = new OwnerDirectiveLedger();
    const entry = ledger.append({
      id: "directive-52",
      issueId: "I_52",
      receivedAtMs: 1_000,
      acknowledgedAtMs: 1_000 + parity.directivesAndGates.acknowledgementDeadlineMs,
      verbatim: "Do not mutate live providers.",
    });
    expect(ledger.append({ ...entry })).toBe(entry);
    expect(() => ledger.append({ ...entry, verbatim: "Changed." })).toThrow("immutable");
    expect(() => ledger.append({
      ...entry,
      id: "directive-late",
      acknowledgedAtMs: entry.receivedAtMs + parity.directivesAndGates.acknowledgementDeadlineMs + 1,
    })).toThrow("within 60 seconds");

    expect(parseOwnerGateDecision(parity.directivesAndGates.accepted[0]!, parity.directivesAndGates.gateId)).toEqual({
      kind: "approve",
      gateId: parity.directivesAndGates.gateId,
    });
    expect(parseOwnerGateDecision(parity.directivesAndGates.accepted[1]!, parity.directivesAndGates.gateId)).toEqual({
      kind: "reject",
      gateId: parity.directivesAndGates.gateId,
      reason: "verification failed",
    });
    for (const command of parity.directivesAndGates.rejected) {
      expect(() => parseOwnerGateDecision(command, parity.directivesAndGates.gateId)).toThrow("exactly match");
    }
  });

  test("atomically claims once and reconstructs without duplicate identities", async () => {
    const workflow = await loadWorkflow(resolve(import.meta.dir, "fixtures/WORKFLOW.md"));
    const simulator = new CrashRestartSimulator(workflow);
    simulator.seed(issue(), contract());
    const competitor = new DeterministicScheduler(
      workflow.config,
      { github: simulator.github, craft: simulator.craft, workspaces: simulator.workspaces },
      simulator.clock,
    );

    await Promise.all([simulator.scheduler.tick(), competitor.tick()]);
    expect(simulator.github.claimSuccessCount).toBe(parity.claimAndEvidence.claimSuccessesAfterConcurrentTicks);
    const running = simulator.github.get("I_52");
    expect(running.issue.state).toBe(parity.restart.expectedState as LifecycleState);
    expect(() => simulator.github.transition("I_52", "pr-open", simulator.clock.nowMs(), {
      fence: "stale-fence",
      evidence: { prUrl: "https://attacker.test/not-provider-evidence" },
    })).toThrow(parity.claimAndEvidence.staleFenceError);

    simulator.restart();
    await simulator.scheduler.tick();
    expect(simulator.github.claimSuccessCount).toBe(parity.restart.expectedClaimCount);
    expect(simulator.craft.count()).toBe(parity.restart.expectedSessionCount);
    expect(simulator.workspaces.count()).toBe(parity.restart.expectedWorkspaceCount);
  });
});
