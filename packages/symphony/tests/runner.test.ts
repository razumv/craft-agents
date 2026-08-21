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
    closed: false,
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

    expect(result.snapshot!.issue.state).toBe("pr-open");
    expect(result.execution?.status).toBe("settled");
    expect(transitionCount()).toBe(1);
  });

  test("builds a restart-stable canonical shadow receipt without mutation calls", async () => {
    const base = transitionFixture("settled").runner;
    const snapshot = await base.readStatus();
    let mutations = 0;
    let transcript = "SECRET FINAL RESPONSE BEFORE RESTART";
    const tracker = {
      get: async () => structuredClone(snapshot.snapshot),
      tryClaim: async () => { mutations += 1; throw new Error("must not claim"); },
    } as unknown as GitHubIssuesProjectsAdapter;
    const craft = {
      get: async () => ({ ...structuredClone(snapshot.execution!), finalResponse: transcript }),
      readProjectDesk: async () => ({
        issue: {
          projectId: snapshot.status!.projectId,
          id: snapshot.status!.issueId,
          identifier: snapshot.status!.issueIdentifier,
          objective: snapshot.status!.objective,
          state: snapshot.status!.state,
        },
        links: { branch: null, pullRequest: snapshot.status!.prUrl, deployment: null },
        latestMaterialEvent: null,
        blocker: null,
        ownerGate: null,
        nextCompletionPoint: snapshot.status!.nextCompletionPoint,
        run: null,
        directive: null,
        compact: "# Project Desk — Craft Protocol v4",
      }),
    } as unknown as CraftMobileControlPlaneAdapter;
    const scheduler = {
      preview: async () => ({
        action: "resume",
        reason: "durable claim exists; shadow would resume its exact identity",
        issueId: "I_52",
        issueIdentifier: "razumv/craft-protocol#52",
        state: "running",
        attempt: 1,
        claimFence: "claim-52",
        run: {
          issueId: "I_52",
          issueIdentifier: "razumv/craft-protocol#52",
          attempt: 1,
          sessionId: "run-52",
          workspaceId: "worktree-52",
          workspaceKey: "issue-52-a1",
          workspacePath: "/tmp/issue-52-a1",
        },
      }),
      tick: async () => { mutations += 1; },
    } as unknown as DeterministicScheduler;
    const makeRunner = () => new LiveV4Runner(
      { issueId: "I_52" } as LiveRunnerConfig,
      {} as WorkflowConfig,
      tracker,
      craft,
      {} as CraftCliRpcTransport,
      scheduler,
    );

    const first = await makeRunner().shadow();
    transcript = "DIFFERENT SECRET FINAL RESPONSE AFTER RESTART";
    const restarted = await makeRunner().shadow();
    const serialized = JSON.stringify(first);

    expect(first).toEqual(restarted);
    expect(Object.keys(first).sort()).toEqual(["projectDesk", "proposal", "receiptHash", "schema", "writes"]);
    expect(first).toMatchObject({ schema: "craft-agent/symphony-shadow@1", writes: 0, proposal: { action: "resume" } });
    expect(first.receiptHash).toMatch(/^[0-9a-f]{64}$/);
    // The canonical hash must cover the schema field: a different schema value changes the hash.
    const { createHash } = await import("node:crypto");
    const canonical = (value: unknown): string => Array.isArray(value)
      ? `[${value.map(canonical).join(",")}]`
      : value && typeof value === "object"
        ? `{${Object.keys(value as Record<string, unknown>).sort().map((k) => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`
        : JSON.stringify(value);
    const { receiptHash, ...payload } = first;
    expect(receiptHash).toBe(createHash("sha256").update(canonical(payload)).digest("hex"));
    const tampered = createHash("sha256")
      .update(canonical({ ...payload, schema: "craft-agent/symphony-shadow@0" }))
      .digest("hex");
    expect(tampered).not.toBe(receiptHash);
    expect(serialized).not.toContain("finalResponse");
    expect(serialized).not.toContain("SECRET FINAL RESPONSE");
    expect(mutations).toBe(0);
  });

  test("keeps a failing rollup read-only when the provider supplies no exact detail", async () => {
    const base = transitionFixture("settled").runner;
    const status = await base.readStatus();
    const snapshot = structuredClone(status.snapshot!);
    snapshot.issue.state = "pr-open";
    let transitions = 0;
    const tracker = {
      get: async () => structuredClone(snapshot),
      ciFailure: async () => null,
      ciRepairAttempts: async () => [],
      transition: async () => { transitions += 1; return structuredClone(snapshot); },
    } as unknown as GitHubIssuesProjectsAdapter;
    const runner = new LiveV4Runner(
      { issueId: "I_52" } as LiveRunnerConfig,
      {} as WorkflowConfig,
      tracker,
      {} as CraftMobileControlPlaneAdapter,
      {} as CraftCliRpcTransport,
      {} as DeterministicScheduler,
    );

    expect(await runner.prepareCiRepair("I_52", null)).toMatchObject({ action: "handover", evidence: null });
    expect(transitions).toBe(0);
  });

  test("hands a third red result over with exact output and both durable diagnoses", async () => {
    const base = transitionFixture("settled").runner;
    const status = await base.readStatus();
    const snapshot = structuredClone(status.snapshot!);
    snapshot.issue.state = "pr-open";
    const failure = {
      pullRequestId: "PR_52",
      pullRequestUrl: "https://github.test/pull/52",
      headBranch: snapshot.contract.requiredBranch,
      headSha: "d".repeat(40),
      checkName: "validate / test",
      checkUrl: "https://github.test/actions/runs/52",
      command: "bun test",
      output: "AssertionError: still red",
    };
    const attempts = [1, 2].map((attempt) => ({
      attempt: attempt as 1 | 2,
      headSha: attempt === 1 ? "b".repeat(40) : "c".repeat(40),
      checkName: failure.checkName,
      command: failure.command,
      output: failure.output,
      cause: "contract-work" as const,
      diagnosis: attempt === 1 ? "first diagnosis" : "second diagnosis",
      touchedPaths: ["src/widget.ts"],
      previousMistake: attempt === 1 ? null : "first targeted the wrong layer",
    }));
    let handover: { to: string; message: string; blocker: string | undefined } | null = null;
    const tracker = {
      get: async () => structuredClone(snapshot),
      ciFailure: async () => structuredClone(failure),
      ciRepairAttempts: async () => structuredClone(attempts),
      transition: async (_issueId: string, to: string, _now: number, options: { message: string; evidence: { blocker?: string } }) => {
        handover = { to, message: options.message, blocker: options.evidence.blocker };
        return structuredClone(snapshot);
      },
    } as unknown as GitHubIssuesProjectsAdapter;
    const runner = new LiveV4Runner(
      { issueId: "I_52" } as LiveRunnerConfig,
      {} as WorkflowConfig,
      tracker,
      {} as CraftMobileControlPlaneAdapter,
      {} as CraftCliRpcTransport,
      {} as DeterministicScheduler,
    );

    const decision = await runner.prepareCiRepair("I_52", null);
    expect(decision).toMatchObject({ action: "handover", diagnoses: ["first diagnosis", "second diagnosis"] });
    expect(handover).toMatchObject({ to: "blocked", blocker: "two CI repair attempts were already consumed" });
    expect(handover!.message).toContain(failure.command);
    expect(handover!.message).toContain(failure.output);
    expect(handover!.message).toContain("first diagnosis\nsecond diagnosis");
  });
});

describe("contract issue body", () => {
  test("YAML stays parseable even when items start with reserved characters", async () => {
    const { contractIssueBody } = await import("../src/runner");
    const body = contractIssueBody(
      {
        title: "t",
        goal: "`--compact` flag: prints one line",
        risk: "low",
        acceptance: ["`craft-cli` prints one line", "- leading dash", "plain item"],
        nonGoals: [],
      },
      { id: "CRAFT-TEST", model: "pi/gpt-5.6-sol", verificationBudget: "focused" },
    );
    const yaml = /```yaml\n([\s\S]*?)```/.exec(body)![1]!;
    const parsed = Bun.YAML.parse(yaml) as Record<string, unknown>;
    expect(parsed.goal).toBe("`--compact` flag: prints one line");
    expect((parsed.acceptance as string[])[1]).toBe("- leading dash");
    expect((parsed.nonGoals as string[]).length).toBeGreaterThan(0);
    expect(parsed.deployAuthority).toBe("none");
    expect(parsed.dependencies).toBeUndefined();

    const withDeps = contractIssueBody(
      {
        title: "t", goal: "g", risk: "low", acceptance: ["a"], nonGoals: [],
        dependencies: ["razumv/craft-agents#25", " "], verificationBudget: "explicit-budget",
      },
      { id: "CRAFT-TEST", model: "pi/gpt-5.6-sol", verificationBudget: "config-budget" },
    );
    const depYaml = Bun.YAML.parse(/```yaml\n([\s\S]*?)```/.exec(withDeps)![1]!) as Record<string, unknown>;
    expect(depYaml.dependencies).toEqual(["razumv/craft-agents#25"]);
    expect(depYaml.verificationBudget).toBe("explicit-budget");
  });
});
