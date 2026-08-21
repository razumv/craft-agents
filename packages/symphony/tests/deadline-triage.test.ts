// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  loadWorkflow,
  parseIssueContract,
  proposeDeadlineSuccessor,
  type MaterialEvent,
  type TrackerIssueSnapshot,
  type WorkflowDefinition,
} from "../src";

let workflow: WorkflowDefinition;

beforeAll(async () => {
  workflow = await loadWorkflow(resolve(import.meta.dir, "fixtures/WORKFLOW.md"));
});

const exactEnvironmentFact = "Verified Blender is exactly C:\\Program Files\\Blender Foundation\\Blender 4.5\\blender.exe.";

function sourceContract(): string {
  return [
    exactEnvironmentFact,
    "The diagnosed exporter limit is exactly 464 lines.",
    "",
    "## Work contract",
    "",
    "```yaml",
    "id: DEADLINE-SOURCE",
    "goal: Finish exporter discovery and implementation in one contract.",
    "risk: medium",
    "deployAuthority: none",
    "model: pi/gpt-5.6-sol",
    `verificationBudget: ${workflow.config.verification.medium.budget}`,
    "acceptance:",
    "  - the existing exporter script is reused instead of rewritten",
    "  - exact Blender tool paths are verified in a focused test",
    "  - the final export is produced and inspected",
    "nonGoals:",
    "  - changing the Blender installation",
    "```",
  ].join("\n");
}

function events(reason: string, attempts = workflow.config.scheduler.maxAttempts): MaterialEvent[] {
  const result: MaterialEvent[] = [{ sequence: 1, atMs: 1, state: "ready", message: "GitHub baseline", kind: "baseline" }];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    result.push({
      sequence: result.length + 1,
      atMs: attempt * 10,
      state: "claimed",
      message: `attempt ${attempt} atomically claimed`,
      kind: "claim",
    });
    result.push({
      sequence: result.length + 1,
      atMs: attempt * 10 + 1,
      state: attempt === attempts ? "failed" : "retry-wait",
      message: attempt === attempts ? `attempt failed: ${reason}` : `retry scheduled: ${reason}`,
      kind: "failure",
    });
  }
  return result;
}

function failed(reason = "Craft run stopped at context-deadline", attempts = workflow.config.scheduler.maxAttempts): TrackerIssueSnapshot {
  const description = sourceContract();
  return {
    issue: {
      id: "I_deadline",
      nativeRef: { repository: "acme/repo", number: 65 },
      identifier: "acme/repo#65",
      title: "Exporter work exceeded one turn",
      description,
      priority: 1,
      state: "failed",
      branchName: null,
      url: "https://github.test/acme/repo/issues/65",
      assigneeId: null,
      labels: ["v4", "state:failed"],
      blockedBy: [],
      dispatchable: false,
      closed: false,
      createdAt: "2026-08-21T00:00:00Z",
      updatedAt: "2026-08-21T01:00:00Z",
    },
    contract: parseIssueContract(description, "acme/repo#65", workflow.config),
    version: 10,
    baseSha: "a".repeat(40),
    claim: null,
    retry: null,
    evidence: {},
    events: events(reason, attempts),
  };
}

function asExistingSuccessor(source: TrackerIssueSnapshot, contract: TrackerIssueSnapshot["contract"]): TrackerIssueSnapshot {
  const child = structuredClone(source);
  child.issue.id = "I_successor";
  child.issue.identifier = "acme/repo#66";
  child.issue.state = "ready";
  child.contract = structuredClone(contract);
  child.events = [{ sequence: 1, atMs: 1, state: "ready", message: "successor created", kind: "baseline" }];
  return child;
}

describe("exhausted deadline successor triage", () => {
  test("context and turn deadlines produce a parser-valid contract with a strictly narrower traced acceptance set", () => {
    for (const reason of ["Craft run stopped at context-deadline", "Craft run stopped at turn-deadline"]) {
      const source = failed(reason);
      const before = structuredClone(source);
      const proposal = proposeDeadlineSuccessor(source, workflow.config);

      expect(proposal).not.toBeNull();
      if (!proposal) continue;
      expect(parseIssueContract(proposal.contractMarkdown, "acme/repo#66", workflow.config)).toEqual(proposal.contract);
      expect(proposal.contract.acceptance).toEqual([source.contract.acceptance[0]]);
      expect(proposal.contract.acceptance.length).toBeLessThan(source.contract.acceptance.length);
      expect(proposal.covers).toEqual([source.contract.acceptance[0]]);
      expect(proposal.remains).toEqual(source.contract.acceptance.slice(1));
      expect(proposal.contractMarkdown).toContain("This successor covers this part of the original contract");
      expect(proposal.contractMarkdown).toContain("These parts remain for later successors");
      expect(proposal.acceptanceTrace).toEqual([{
        criterion: source.contract.acceptance[0],
        sourceCriterion: source.contract.acceptance[0],
        sourceIndex: 0,
      }]);
      expect(source).toEqual(before);
      expect(proposal.writes).toBe(0);
    }
  });

  test("the issue facts, complete material ledger, and preserved branch commit are inherited verbatim", () => {
    const source = failed();
    const preserved = [{
      branch: "v4-preserved/v4-acme-repo-65-a10-a741b62",
      commit: "a741b62" + "0".repeat(33),
    }, {
      branch: "v4-preserved/v4-acme-repo-65-a2-5741b62",
      commit: "5741b62" + "0".repeat(33),
    }];
    const proposal = proposeDeadlineSuccessor(source, workflow.config, [], preserved);

    expect(proposal).not.toBeNull();
    if (!proposal) return;
    expect(proposal.contractMarkdown).toContain(exactEnvironmentFact);
    expect(proposal.contractMarkdown).toContain("The diagnosed exporter limit is exactly 464 lines.");
    for (const event of source.events) expect(proposal.contractMarkdown).toContain(JSON.stringify(event));
    expect(proposal.inheritedIssueBody).toBe(source.issue.description!);
    expect(proposal.inheritedLedger).toEqual(source.events);
    for (const branch of preserved) {
      expect(proposal.contractMarkdown).toContain(branch.branch);
      expect(proposal.contractMarkdown).toContain(branch.commit);
    }
    expect(proposal.contract.baseBranch).toBe(preserved[0]!.branch);
  });

  test("non-deadline failures and deadline failures before budget exhaustion produce nothing", () => {
    expect(proposeDeadlineSuccessor(failed("agent settled without tracker handoff evidence"), workflow.config)).toBeNull();
    expect(proposeDeadlineSuccessor(
      failed("Craft run stopped at context-deadline", workflow.config.scheduler.maxAttempts - 1),
      workflow.config,
    )).toBeNull();

    const historicalDeadline = failed("agent settled without tracker handoff evidence");
    const earlierFailure = historicalDeadline.events.find((event) => event.message.startsWith("retry scheduled:"));
    if (!earlierFailure) throw new Error("fixture has no earlier retry failure");
    earlierFailure.message = "retry scheduled: Craft run stopped at context-deadline";
    historicalDeadline.events.reverse();
    expect(proposeDeadlineSuccessor(historicalDeadline, workflow.config)).toBeNull();
  });

  test("no absent criterion is invented and an already-applied successor suppresses a second proposal", () => {
    const source = failed();
    const first = proposeDeadlineSuccessor(source, workflow.config);
    expect(first).not.toBeNull();
    if (!first) return;

    const invented = "the successor also repairs an unrelated red CI check";
    expect(source.contract.acceptance).not.toContain(invented);
    expect(first.contract.acceptance).not.toContain(invented);
    expect(first.contract.acceptance.every((criterion) => source.contract.acceptance.includes(criterion))).toBeTrue();

    const existing = asExistingSuccessor(source, first.contract);
    expect(proposeDeadlineSuccessor(source, workflow.config, [source, existing])).toBeNull();
  });
});
