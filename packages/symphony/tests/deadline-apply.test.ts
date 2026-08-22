// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  GitHubIssuesProjectsAdapter,
  applyDeadlineSuccessor,
  lifecycleStates,
  loadWorkflow,
  parseIssueContract,
  proposeDeadlineSuccessor,
  type GitHubAdapterConfig,
  type GitHubBranchEvidence,
  type GitHubComment,
  type GitHubFailedCheckDetail,
  type GitHubIssueLink,
  type GitHubIssueRecord,
  type GitHubProjectFieldValue,
  type GitHubProjectItem,
  type GitHubPullRequestEvidence,
  type GitHubTransport,
  type LifecycleState,
  type MaterialEvent,
  type Page,
  type TrackerIssueSnapshot,
  type WorkflowConfig,
  type WorkspaceTruthReader,
} from "../src";

let workflow: WorkflowConfig;
let config: GitHubAdapterConfig;

beforeAll(async () => {
  workflow = (await loadWorkflow(resolve(import.meta.dir, "fixtures/WORKFLOW.md"))).config;
  workflow = { ...workflow, project: { ...workflow.project, repository: "acme/repo" } };
  const states = Object.fromEntries(lifecycleStates.map((state) => [state, {
    label: `state:${state}`,
    projectStatusOptionId: `option:${state}`,
  }])) as Record<LifecycleState, { label: string; projectStatusOptionId: string }>;
  config = {
    repository: "acme/repo",
    projectId: "PROJECT",
    claimFenceIssueId: "FENCE",
    statusFieldId: "STATUS",
    gateFieldId: "GATE",
    requiredLabels: ["v4"],
    states,
    workflow,
    eventAuthorLogin: "bot",
  };
});

function sourceBody(): string {
  return [
    "## Work contract",
    "",
    "```yaml",
    "id: DEADLINE-SOURCE",
    "project: test-project",
    "repository: acme/repo",
    "goal: Finish two bounded outcomes.",
    "risk: medium",
    "deployAuthority: none",
    "requiredBranch: v4/source",
    "baseBranch: main",
    "model: pi/gpt-5.6-sol",
    `verificationBudget: ${workflow.verification.medium.budget}`,
    "acceptance:",
    "  - the first outcome reads back exactly",
    "  - the second outcome reads back exactly",
    "nonGoals:",
    "  - changing provider configuration",
    "```",
  ].join("\n");
}

function proposal() {
  const events: MaterialEvent[] = [
    { sequence: 1, atMs: 1, state: "ready", message: "baseline", kind: "baseline" },
    { sequence: 2, atMs: 2, state: "claimed", message: `attempt ${workflow.scheduler.maxAttempts} atomically claimed`, kind: "claim" },
    { sequence: 3, atMs: 3, state: "failed", message: "attempt failed: Craft run stopped at context-deadline", kind: "failure" },
  ];
  const body = sourceBody();
  const source: TrackerIssueSnapshot = {
    issue: {
      id: "SOURCE", nativeRef: { repository: "acme/repo", number: 65 }, identifier: "acme/repo#65",
      title: "Deadline source", description: body, priority: 1, state: "failed", branchName: null,
      url: "https://github.test/acme/repo/issues/65", assigneeId: null, labels: ["v4", "state:failed"],
      blockedBy: [], dispatchable: false, closed: false, createdAt: "2026-08-21T00:00:00Z", updatedAt: "2026-08-21T01:00:00Z",
    },
    contract: parseIssueContract(body, "acme/repo#65", workflow), version: 1, baseSha: "a".repeat(40),
    claim: null, retry: null, evidence: {}, events,
  };
  const result = proposeDeadlineSuccessor(source, workflow, [], [{ branch: "v4-preserved/source-a3-1234567", commit: "1".repeat(40) }]);
  if (!result) throw new Error("fixture must propose");
  return result;
}

type FailStep =
  | "issue" | "body-readback" | "attribution" | "attribution-readback"
  | "project" | "project-readback" | "source-readback"
  | "status" | "status-readback" | "label" | "label-readback";

class SuccessorTransport implements GitHubTransport {
  readonly records = new Map<string, GitHubIssueRecord>();
  readonly labels = new Map<string, string[]>();
  readonly comments = new Map<string, GitHubComment[]>();
  readonly items = new Map<string, GitHubProjectItem[]>();
  readonly status = new Map<string, string>();
  readonly calls: string[] = [];
  failAt: FailStep | null = null;
  failed = false;
  reorderSourceLabelsOnReadback = false;
  nextNumber = 66;

  constructor(readonly proposed = proposal()) {
    this.records.set("SOURCE", {
      id: "SOURCE", number: 65, title: "Deadline source", body: proposed.inheritedIssueBody,
      url: "https://github.test/acme/repo/issues/65", state: "OPEN", createdAt: "2026-08-21T00:00:00Z",
      updatedAt: "2026-08-21T01:00:00Z", assigneeId: null, labelNames: ["v4", "state:failed"],
    });
    this.labels.set("SOURCE", ["v4", "state:failed"]);
  }

  private page<T>(nodes: T[]): Promise<Page<T>> { return Promise.resolve({ nodes, nextCursor: null }); }
  private once(step: FailStep): boolean {
    if (this.failAt !== step || this.failed) return false;
    this.failed = true;
    return true;
  }

  listIssues(): Promise<Page<GitHubIssueRecord>> { return this.page([...this.records.values()].map((record) => structuredClone(record))); }
  getIssuesByNodeIds(ids: readonly string[]): Promise<(GitHubIssueRecord | null)[]> {
    this.calls.push(`read:nodes:${ids.join(",")}`);
    if (ids.length === 1 && ids[0] !== "SOURCE" && this.once("body-readback")) {
      const record = this.records.get(ids[0]!);
      return Promise.resolve(record ? [{ ...record, body: "not the exact body" }] : [null]);
    }
    if (ids.length === 1 && ids[0] === "SOURCE" && this.records.size > 1 && this.once("source-readback")) {
      return Promise.reject(new Error("source readback unavailable"));
    }
    return Promise.resolve(ids.map((id) => structuredClone(this.records.get(id) ?? null)));
  }
  listLabels(issueId: string): Promise<Page<string>> {
    const values = [...(this.labels.get(issueId) ?? [])];
    if (issueId === "SOURCE" && this.records.size > 1 && this.reorderSourceLabelsOnReadback) values.reverse();
    if (issueId !== "SOURCE" && values.includes(config.states.ready.label) && this.once("label-readback")) {
      return this.page(values.filter((label) => label !== config.states.ready.label));
    }
    return this.page(values);
  }
  listBlockedBy(): Promise<Page<GitHubIssueLink>> { return this.page([]); }
  listProjectItems(issueId: string): Promise<Page<GitHubProjectItem>> {
    const values = [...(this.items.get(issueId) ?? [])];
    if (values.length && this.once("project-readback")) return this.page([]);
    return this.page(values);
  }
  listProjectFieldValues(itemId: string): Promise<Page<GitHubProjectFieldValue>> {
    const optionId = this.status.get(itemId) ?? "option:backlog";
    if (optionId === config.states.ready.projectStatusOptionId && this.once("status-readback")) {
      return this.page([{ kind: "single-select", fieldId: "STATUS", fieldName: "Status", optionId: "option:backlog", value: "Backlog" }]);
    }
    return this.page([{ kind: "single-select", fieldId: "STATUS", fieldName: "Status", optionId, value: null }]);
  }
  listComments(issueId: string): Promise<Page<GitHubComment>> {
    const values = [...(this.comments.get(issueId) ?? [])];
    if (values.length && this.once("attribution-readback")) return this.page([]);
    return this.page(values);
  }
  listClosingPullRequests(): Promise<Page<GitHubPullRequestEvidence>> { return this.page([]); }
  listFailedCheckDetails(): Promise<GitHubFailedCheckDetail[]> { return Promise.resolve([]); }
  getBranch(_repository: string, branchName: string): Promise<GitHubBranchEvidence | null> {
    return Promise.resolve({ name: branchName, oid: "1".repeat(40), url: `https://github.test/acme/repo/tree/${branchName}` });
  }
  getBaseSha(): Promise<string> { return Promise.resolve("1".repeat(40)); }
  containsCommit(): Promise<boolean> { return Promise.resolve(true); }
  mergePullRequest(): Promise<void> { return Promise.resolve(); }

  async createIssue(_repository: string, title: string, body: string): Promise<{ id: string; number: number; url: string }> {
    this.calls.push("WRITE:issue");
    const number = this.nextNumber++;
    const created = { id: `SUCCESSOR_${number}`, number, url: `https://github.test/acme/repo/issues/${number}` };
    this.records.set(created.id, { ...created, title, body, state: "OPEN", createdAt: "2026-08-22T00:00:00Z", updatedAt: "2026-08-22T00:00:00Z", assigneeId: null });
    this.labels.set(created.id, []);
    if (this.once("issue")) throw new Error("create response lost after provider write");
    return created;
  }
  async addIssueToProject(projectId: string, contentId: string): Promise<string> {
    this.calls.push("WRITE:project");
    const itemId = `ITEM_${contentId}`;
    this.items.set(contentId, [{ id: itemId, projectId }]);
    this.status.set(itemId, "option:backlog");
    if (this.once("project")) throw new Error("Project response lost after provider write");
    return itemId;
  }
  async appendComment(issueId: string, body: string): Promise<GitHubComment> {
    this.calls.push("WRITE:attribution");
    const comment = { databaseId: 1, body, authorLogin: "bot", createdAt: "2026-08-22T00:00:00Z", updatedAt: "2026-08-22T00:00:00Z" };
    this.comments.set(issueId, [comment]);
    if (this.once("attribution")) throw new Error("comment response lost after provider write");
    return comment;
  }
  updateIssueBody(): Promise<boolean> { throw new Error("source body must never be written"); }
  async replaceLabels(_repository: string, issueNumber: number, labels: readonly string[]): Promise<void> {
    this.calls.push("WRITE:label");
    const issue = [...this.records.values()].find((record) => record.number === issueNumber)!;
    this.labels.set(issue.id, [...labels]);
    if (this.once("label")) throw new Error("label response lost after provider write");
  }
  async updateProjectSingleSelect(_projectId: string, itemId: string, _fieldId: string, optionId: string): Promise<void> {
    this.calls.push("WRITE:status");
    this.status.set(itemId, optionId);
    if (this.once("status")) throw new Error("status response lost after provider write");
  }
  updateProjectText(): Promise<void> { throw new Error("gate field must never be written"); }
}

function successorRecords(transport: SuccessorTransport): GitHubIssueRecord[] {
  return [...transport.records.values()].filter((record) => record.id !== "SOURCE");
}

describe("deadline successor apply", () => {
  test("creates one attributable exact contract, verifies Project ready, and writes the ready label last", async () => {
    const transport = new SuccessorTransport();
    transport.reorderSourceLabelsOnReadback = true;
    const beforeSource = structuredClone(transport.records.get("SOURCE"));
    const beforeSourceLabels = structuredClone(transport.labels.get("SOURCE"));

    const report = await applyDeadlineSuccessor(transport.proposed, config, transport);

    expect(report.outcome).toBe("applied");
    expect(report.writes).toBe(5);
    expect(successorRecords(transport)).toHaveLength(1);
    const successor = successorRecords(transport)[0]!;
    expect(successor.body).toBe(transport.proposed.contractMarkdown);
    expect(parseIssueContract(successor.body, `acme/repo#${successor.number}`, workflow)).toEqual(transport.proposed.contract);
    expect(transport.comments.get(successor.id)?.[0]?.body).toContain(`from failed source ${transport.proposed.sourceIssueIdentifier}`);
    expect(transport.status.get(`ITEM_${successor.id}`)).toBe(config.states.ready.projectStatusOptionId);
    expect(transport.labels.get(successor.id)).toEqual(["v4", config.states.ready.label]);
    expect(transport.calls.at(-1)).toBe("WRITE:label");
    expect(transport.records.get("SOURCE")).toEqual(beforeSource);
    expect(transport.labels.get("SOURCE")).toEqual(beforeSourceLabels);

    const repeated = await applyDeadlineSuccessor(transport.proposed, config, transport);
    expect(repeated).toMatchObject({ outcome: "already-applied", writes: 0 });
    expect(successorRecords(transport)).toHaveLength(1);
    expect(transport.comments.get(successor.id)).toHaveLength(1);
    expect(transport.items.get(successor.id)).toHaveLength(1);
  });

  test("every partial failure reports its exact step and a retry converges without duplicates", async () => {
    const steps: FailStep[] = [
      "issue", "body-readback", "attribution", "attribution-readback", "project", "project-readback",
      "source-readback", "status", "status-readback", "label", "label-readback",
    ];
    for (const step of steps) {
      const transport = new SuccessorTransport();
      transport.failAt = step;

      const first = await applyDeadlineSuccessor(transport.proposed, config, transport);
      expect(first).toMatchObject({ outcome: "failed", failedStep: step });
      expect(first.completedSteps).not.toContain(step);

      const recovered = await applyDeadlineSuccessor(transport.proposed, config, transport);
      expect(["applied", "already-applied"]).toContain(recovered.outcome);
      expect(successorRecords(transport)).toHaveLength(1);
      const successor = successorRecords(transport)[0]!;
      expect(transport.comments.get(successor.id)).toHaveLength(1);
      expect(transport.items.get(successor.id)).toHaveLength(1);
      expect(transport.labels.get(successor.id)).toContain(config.states.ready.label);
    }
  });

  test("refusals and failed branch/source preconditions create nothing", async () => {
    const refusedTransport = new SuccessorTransport();
    expect(await applyDeadlineSuccessor(null, config, refusedTransport)).toEqual({
      outcome: "refused", writes: 0, completedSteps: [], reason: "no parser-valid deadline-successor proposal",
    });
    expect(successorRecords(refusedTransport)).toEqual([]);

    const missingBranch = new SuccessorTransport();
    missingBranch.getBranch = async () => null;
    const branchReport = await applyDeadlineSuccessor(missingBranch.proposed, config, missingBranch);
    expect(branchReport).toMatchObject({ outcome: "failed", failedStep: "branches", writes: 0 });
    expect(successorRecords(missingBranch)).toEqual([]);

    const changedSource = new SuccessorTransport();
    changedSource.records.get("SOURCE")!.body += "\nchanged";
    const sourceReport = await applyDeadlineSuccessor(changedSource.proposed, config, changedSource);
    expect(sourceReport).toMatchObject({ outcome: "failed", failedStep: "preflight", writes: 0 });
    expect(successorRecords(changedSource)).toEqual([]);
  });

  test("the adapter exposes the same resumable apply capability", async () => {
    const transport = new SuccessorTransport();
    const adapter = new GitHubIssuesProjectsAdapter(
      config,
      transport,
      { inspect: async () => ({ kind: "absent" as const }) } as WorkspaceTruthReader,
    );
    const report = await adapter.applyDeadlineSuccessor(transport.proposed);
    expect(report).toMatchObject({ outcome: "applied", writes: 5 });
  });
});
