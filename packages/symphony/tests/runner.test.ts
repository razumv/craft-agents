// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  LiveV4Runner,
  ScopedGitHubTransport,
  type CraftCliRpcTransport,
  type CraftExecutionSession,
  type CraftMobileControlPlaneAdapter,
  type CraftSessionStatus,
  type DeterministicScheduler,
  type GitHubComment,
  type GitHubIssuesProjectsAdapter,
  type GitHubTransport,
  type LiveRunnerConfig,
  type TrackerIssueSnapshot,
  type WorkflowConfig,
} from "../src";

function fixture() {
  const calls: string[] = [];
  const delegate = {
    appendComment: async (issueId: string, body: string): Promise<GitHubComment> => {
      calls.push(`comment:${issueId}:${body}`);
      return { databaseId: 1, body, authorLogin: "owner", createdAt: "2026-08-18T00:00:00Z", updatedAt: "2026-08-18T00:00:00Z" };
    },
    replaceLabels: async (_repository: string, issueNumber: number) => { calls.push(`labels:${issueNumber}`); },
    updateProjectSingleSelect: async (_projectId: string, itemId: string, fieldId: string) => { calls.push(`status:${itemId}:${fieldId}`); },
    updateProjectText: async (_projectId: string, itemId: string, fieldId: string) => { calls.push(`gate:${itemId}:${fieldId}`); },
  } as unknown as GitHubTransport;
  const scoped = new ScopedGitHubTransport(delegate, {
    repository: "razumv/craft-protocol",
    issueId: "I_52",
    issueNumber: 52,
    fenceIssueId: "I_48",
    projectId: "PROJECT",
    projectItemId: "ITEM_52",
    statusFieldId: "STATUS",
    gateFieldId: "GATE",
  });
  return { calls, scoped };
}

function transitionFixture(status: CraftSessionStatus) {
  let transitions = 0;
  const snapshot: TrackerIssueSnapshot = {
    issue: {
      id: "I_52",
      nativeRef: null,
      identifier: "razumv/craft-protocol#52",
      title: "Runner settlement fence",
      description: null,
      priority: 1,
      state: "running",
      branchName: "v4/runner-settlement",
      url: null,
      assigneeId: null,
      labels: ["v4"],
      blockedBy: [],
      dispatchable: true,
      createdAt: null,
      updatedAt: null,
    },
    contract: {
      id: "V4-RUNNER",
      projectId: "craft-protocol-v4",
      repository: "razumv/craft-protocol",
      goal: "Fence PR transition on true settlement.",
      acceptance: ["settled readback"],
      nonGoals: ["live mutation"],
      risk: "low",
      deployAuthority: "none",
      requiredBranch: "v4/runner-settlement",
      baseBranch: "main",
      dependencies: [],
      ownerDirectiveRefs: [],
      modelProfile: "pi/gpt-5.6-sol",
      verificationBudget: "targeted-tests-plus-one-simulator-smoke",
    },
    version: 2,
    baseSha: "b".repeat(40),
    claim: {
      issueId: "I_52",
      issueIdentifier: "razumv/craft-protocol#52",
      attempt: 1,
      fence: "claim-52",
      sessionId: "run-52",
      workspaceId: "worktree-52",
      workspaceKey: "issue-52-a1",
      workspacePath: "/tmp/issue-52-a1",
      baseSha: "b".repeat(40),
      modelConnection: "chatgpt-plus",
      modelProfile: "pi/gpt-5.6-sol",
      claimedAtMs: 1_000,
      heartbeatAtMs: 1_000,
      expiresAtMs: 61_000,
    },
    retry: null,
    evidence: { prUrl: "https://github.test/pull/52" },
    events: [],
  };
  const execution: CraftExecutionSession = {
    sessionId: "run-52",
    rpcSessionId: "rpc-52",
    issueId: "I_52",
    attempt: 1,
    worktreePath: "/tmp/issue-52-a1",
    status,
    promptMessageId: "prompt-52",
    finalResponse: status === "settled" ? "Final response." : null,
    contextTokens: 42_000,
  };
  const tracker = {
    get: async () => structuredClone(snapshot),
    transition: async (_issueId: string, to: "pr-open") => {
      transitions += 1;
      snapshot.issue.state = to;
      return structuredClone(snapshot);
    },
  } as unknown as GitHubIssuesProjectsAdapter;
  const craft = { get: async () => structuredClone(execution) } as unknown as CraftMobileControlPlaneAdapter;
  const runner = new LiveV4Runner(
    { issueId: "I_52" } as LiveRunnerConfig,
    {} as WorkflowConfig,
    tracker,
    craft,
    {} as CraftCliRpcTransport,
    {} as DeterministicScheduler,
  );
  return { runner, transitionCount: () => transitions };
}

describe("v4 live runner mutation scope", () => {
  test("permits only the configured repository, issue, fence, and exact Project item fields", async () => {
    const { calls, scoped } = fixture();
    await scoped.appendComment("I_52", "event");
    await scoped.appendComment("I_48", "fence");
    await scoped.replaceLabels("razumv/craft-protocol", 52, ["agent-running"]);
    await scoped.updateProjectSingleSelect("PROJECT", "ITEM_52", "STATUS", "in-progress");
    await scoped.updateProjectText("PROJECT", "ITEM_52", "GATE", "gate-52");

    expect(calls).toEqual([
      "comment:I_52:event",
      "comment:I_48:fence",
      "labels:52",
      "status:ITEM_52:STATUS",
      "gate:ITEM_52:GATE",
    ]);
    expect(() => scoped.appendComment("I_51", "escape")).toThrow("escaped");
    expect(() => scoped.replaceLabels("razumv/craft-protocol", 51, [])).toThrow("escaped");
    expect(() => scoped.replaceLabels("other/repository", 52, [])).toThrow("repository/issue scope");
    expect(() => scoped.updateProjectSingleSelect("PROJECT", "ITEM_51", "STATUS", "x")).toThrow("escaped");
    expect(() => scoped.updateProjectText("OTHER", "ITEM_52", "GATE", "x")).toThrow("escaped");
  });

  test("refuses PR transition without exact true-settled Craft readback", async () => {
    for (const status of ["running", "ended-without-response", "turn-deadline", "context-deadline"] as const) {
      const { runner, transitionCount } = transitionFixture(status);
      await expect(runner.transitionToPrOpen()).rejects.toThrow("true settled readback");
      expect(transitionCount()).toBe(0);
    }
  });

  test("allows PR transition after exact true-settled Craft readback", async () => {
    const { runner, transitionCount } = transitionFixture("settled");
    const result = await runner.transitionToPrOpen();

    expect(result.snapshot.issue.state).toBe("pr-open");
    expect(result.execution?.status).toBe("settled");
    expect(transitionCount()).toBe(1);
  });
});
