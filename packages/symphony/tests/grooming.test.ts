// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  GitHubIssuesProjectsAdapter,
  LiveV4Runner,
  assertGroundedAcceptance,
  compareForDispatch,
  lifecycleStates,
  loadWorkflow,
  parseIssueContract,
  proposeBacklogGrooming,
  type CraftCliRpcTransport,
  type CraftMobileControlPlaneAdapter,
  type DeterministicScheduler,
  type GitHubAdapterConfig,
  type GitHubComment,
  type GitHubIssueLink,
  type GitHubIssueRecord,
  type GitHubTransport,
  type LifecycleState,
  type LiveRunnerConfig,
  type Page,
  type TrackerBacklogIssue,
  type WorkflowConfig,
  type WorkspaceTruthReader,
} from "../src";

let workflow: WorkflowConfig;

beforeAll(async () => {
  workflow = (await loadWorkflow(resolve(import.meta.dir, "fixtures/WORKFLOW.md"))).config;
  workflow = { ...workflow, project: { ...workflow.project, repository: "acme/repo" } };
});

function issue(overrides: Partial<TrackerBacklogIssue> = {}): TrackerBacklogIssue {
  return {
    id: "I_1",
    identifier: "acme/repo#1",
    number: 1,
    title: "Return a read-only grooming proposal",
    description: [
      "## Goal",
      "Return one grounded proposal for the next backlog issue.",
      "",
      "## Acceptance Criteria",
      "- The runner returns one proposal without writing to GitHub.",
      "- The real contract parser accepts the proposed contract.",
      "",
      "## Non-goals",
      "- Writing labels, comments, issue bodies, or Project fields.",
    ].join("\n"),
    url: "https://github.test/acme/repo/issues/1",
    labels: ["enhancement"],
    priority: 1,
    createdAt: "2026-08-01T00:00:00Z",
    updatedAt: "2026-08-02T00:00:00Z",
    blockedBy: [],
    parent: null,
    ...overrides,
  };
}

function proposal(candidate = issue()) {
  return proposeBacklogGrooming("acme/repo", [candidate], workflow);
}

class RecordingTransport implements GitHubTransport {
  readonly calls: string[] = [];
  constructor(readonly record: GitHubIssueRecord, readonly blockers: GitHubIssueLink[] = []) {}
  private read<T>(name: string, nodes: T[]): Promise<Page<T>> { this.calls.push(name); return Promise.resolve({ nodes, nextCursor: null }); }
  private write(name: string): never { this.calls.push(`WRITE:${name}`); throw new Error(`unexpected write ${name}`); }

  listIssues(): Promise<Page<GitHubIssueRecord>> { return this.read("listIssues", [this.record]); }
  getIssuesByNodeIds(): Promise<(GitHubIssueRecord | null)[]> { return this.read("getIssuesByNodeIds", []).then(() => []); }
  listLabels(): Promise<Page<string>> { return this.read("listLabels", []); }
  listBlockedBy(): Promise<Page<GitHubIssueLink>> { return this.read("listBlockedBy", this.blockers); }
  listProjectItems(): Promise<Page<never>> { return this.read("listProjectItems", []); }
  listProjectFieldValues(): Promise<Page<never>> { return this.read("listProjectFieldValues", []); }
  listComments(): Promise<Page<GitHubComment>> { return this.read("listComments", []); }
  listClosingPullRequests(): Promise<Page<never>> { return this.read("listClosingPullRequests", []); }
  getBranch(): Promise<null> { this.calls.push("getBranch"); return Promise.resolve(null); }
  getBaseSha(): Promise<string> { this.calls.push("getBaseSha"); return Promise.resolve("b".repeat(40)); }
  mergePullRequest(): Promise<void> { return Promise.resolve(this.write("mergePullRequest")); }
  appendComment(): Promise<GitHubComment> { return Promise.resolve(this.write("appendComment")); }
  replaceLabels(): Promise<void> { return Promise.resolve(this.write("replaceLabels")); }
  updateProjectSingleSelect(): Promise<void> { return Promise.resolve(this.write("updateProjectSingleSelect")); }
  updateProjectText(): Promise<void> { return Promise.resolve(this.write("updateProjectText")); }
}

function adapterConfig(): GitHubAdapterConfig {
  const states = Object.fromEntries(lifecycleStates.map((state) => [state, {
    label: `state:${state}`,
    projectStatusOptionId: `option:${state}`,
  }])) as Record<LifecycleState, { label: string; projectStatusOptionId: string }>;
  return {
    repository: "acme/repo",
    projectId: "PROJECT",
    claimFenceIssueId: "FENCE",
    statusFieldId: "STATUS",
    gateFieldId: "GATE",
    requiredLabels: ["v4"],
    states,
    workflow: { ...workflow, tracker: { ...workflow.tracker, kind: "github" } },
    eventAuthorLogin: "bot",
  };
}

describe("read-only backlog grooming", () => {
  test("runner builds one proposal from the existing backlog read and the transport receives no write call", async () => {
    const source = issue();
    const transport = new RecordingTransport({
      id: source.id,
      number: source.number,
      title: source.title,
      body: source.description,
      url: source.url!,
      state: "OPEN",
      createdAt: source.createdAt!,
      updatedAt: source.updatedAt!,
      assigneeId: null,
      labelNames: source.labels,
      priority: source.priority,
      parent: null,
    });
    const tracker = new GitHubIssuesProjectsAdapter(
      adapterConfig(),
      transport,
      { inspect: async () => ({ kind: "absent" as const }) } as WorkspaceTruthReader,
    );
    const runner = new LiveV4Runner(
      { github: { repository: "acme/repo" } } as LiveRunnerConfig,
      workflow,
      tracker,
      {} as CraftMobileControlPlaneAdapter,
      {} as CraftCliRpcTransport,
      {} as DeterministicScheduler,
    );

    const result = await runner.proposeGrooming();

    expect(result).toMatchObject({ outcome: "proposed", writes: 0, candidate: { identifier: "acme/repo#1" } });
    expect(transport.calls).toEqual(["listIssues", "listBlockedBy"]);
    expect(transport.calls.some((call) => call.startsWith("WRITE:"))).toBeFalse();
  });

  test("candidate order is priority 1..4, then other/null, created oldest/null-last, then identifier", () => {
    const ordered = [
      { issue: { id: "z", identifier: "Z", priority: null, createdAt: null } },
      { issue: { id: "b", identifier: "B", priority: 9, createdAt: "2026-07-01T00:00:00Z" } },
      { issue: { id: "id-b", identifier: "B", priority: 2, createdAt: "2026-06-01T00:00:00Z" } },
      { issue: { id: "id-a", identifier: "A", priority: 2, createdAt: "2026-06-01T00:00:00Z" } },
      { issue: { id: "p4", identifier: "P4", priority: 4, createdAt: "2026-01-01T00:00:00Z" } },
      { issue: { id: "p3", identifier: "P3", priority: 3, createdAt: "2026-01-01T00:00:00Z" } },
      { issue: { id: "p1", identifier: "P1", priority: 1, createdAt: null } },
      { issue: { id: "null-old", identifier: "C", priority: null, createdAt: "2026-01-01T00:00:00Z" } },
      { issue: { id: "other-null", identifier: "A", priority: 0, createdAt: null } },
    ].sort(compareForDispatch);

    expect(ordered.map((entry) => entry.issue.id)).toEqual([
      "p1", "id-a", "id-b", "p3", "p4", "null-old", "b", "other-null", "z",
    ]);
  });

  test("the first upstream candidate is refused for each blocking relation and a later issue is never substituted", () => {
    const later = issue({ id: "I_2", identifier: "acme/repo#2", number: 2, priority: 2 });
    const cases: [TrackerBacklogIssue, string, string][] = [
      [issue({ blockedBy: [{ id: "I_9", identifier: "acme/repo#9", state: "OPEN", title: "Dependency", url: "https://github.test/9" }] }), "blocked-by", "acme/repo#9"],
      [issue({ parent: { id: "I_8", identifier: "acme/repo#8", state: "OPEN", title: "Parent", url: "https://github.test/8" } }), "parent", "acme/repo#8"],
      [issue({ labels: ["tracking:prerequisite"] }), "prerequisite-label", "tracking:prerequisite"],
    ];
    for (const [first, relation, named] of cases) {
      const result = proposeBacklogGrooming("acme/repo", [later, first], workflow);
      expect(result).toMatchObject({ outcome: "refused", candidate: { identifier: "acme/repo#1" }, refusal: { relation } });
      if (result.outcome === "refused") expect(result.refusal.message).toContain(named);
    }
  });

  test("every proposed acceptance criterion maps exactly to its own issue sentence and real parser ingestion succeeds", () => {
    const result = proposal();
    expect(result.outcome).toBe("proposed");
    if (result.outcome !== "proposed") return;

    expect(result.acceptanceTrace).toEqual([
      { criterion: "The runner returns one proposal without writing to GitHub.", sourceSentence: "The runner returns one proposal without writing to GitHub.", sourceLine: 5 },
      { criterion: "The real contract parser accepts the proposed contract.", sourceSentence: "The real contract parser accepts the proposed contract.", sourceLine: 6 },
    ]);
    expect(result.contract.acceptance).toEqual(result.acceptanceTrace.map((trace) => trace.sourceSentence));
    expect(parseIssueContract(result.contractMarkdown, result.candidate.identifier, workflow)).toEqual(result.contract);
    expect(result.verificationBudget).toBe(workflow.verification[result.contract.risk].budget);
  });

  test("an unsupported or altered criterion is a defect", () => {
    expect(() => assertGroundedAcceptance(issue().description, [{
      criterion: "The runner also edits the issue body.",
      sourceSentence: "The runner also edits the issue body.",
      sourceLine: 5,
    }])).toThrow("not traceable to issue source line 5");
  });

  test("a mixed acceptance set is refused rather than silently dropping its vague criterion", () => {
    const mixed = issue({
      description: issue().description.replace(
        "- The real contract parser accepts the proposed contract.",
        "- The real contract parser accepts the proposed contract.\n- Improve it better.",
      ),
    });
    const result = proposal(mixed);

    expect(result).toMatchObject({ outcome: "refused", refusal: { relation: "grounding" } });
    if (result.outcome === "refused") expect(result.refusal.message).toContain("Improve it better.");
  });

  test("a deliberately vague issue names the missing falsifiable acceptance set and invents no contract", () => {
    const vague = issue({
      description: [
        "Please make grooming better.",
        "",
        "## Acceptance Criteria",
        "- Improve it better.",
        "",
        "## Non-goals",
        "- Changing the scheduler.",
      ].join("\n"),
    });
    const result = proposal(vague);

    expect(result).toMatchObject({ outcome: "refused", refusal: { relation: "grounding" } });
    if (result.outcome === "refused") {
      expect(result.refusal.message).toContain("falsifiable acceptance criterion");
      expect("contract" in result).toBeFalse();
    }
  });

  test("sensitive and irreversible issues are always high and receive the exact high-risk owner-gate budget", () => {
    for (const sensitive of ["credentials", "authentication", "payments", "data deletion", "irreversible migration"]) {
      const candidate = issue({
        title: `Change ${sensitive}`,
        description: issue().description.replace("one grounded proposal", sensitive),
      });
      const result = proposal(candidate);
      expect(result.outcome).toBe("proposed");
      if (result.outcome !== "proposed") continue;
      expect(result.riskAssignment).toMatchObject({ risk: "high", rule: "high" });
      expect(result.contract.risk).toBe("high");
      expect(result.contract.verificationBudget).toBe(workflow.verification.high.budget);
      expect(workflow.verification.high.ownerGate).toBeTrue();
    }
  });
});
