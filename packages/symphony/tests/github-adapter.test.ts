// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  DeterministicScheduler,
  FakeCraftAdapter,
  FakeWorkspaceAdapter,
  GitHubIssuesProjectsAdapter,
  IdentityFactory,
  ManualClock,
  lifecycleStates,
  loadWorkflow,
  proposePreclaimScope,
  type Claim,
  type GitHubAdapterConfig,
  type GitHubBranchEvidence,
  type GitHubComment,
  type GitHubIssueLink,
  type GitHubIssueRecord,
  type GitHubProjectFieldValue,
  type GitHubProjectItem,
  type GitHubPullRequestEvidence,
  type GitHubTransport,
  type LifecycleState,
  type Page,
  type WorkflowDefinition,
  type WorkspaceTruth,
  type WorkspaceTruthReader,
} from "../src";
import parity from "./fixtures/v4.0.0-alpha.1-parity.json";

let workflow: WorkflowDefinition;

beforeAll(async () => {
  workflow = await loadWorkflow(resolve(import.meta.dir, "fixtures/WORKFLOW.md"));
});

class MemoryWorkspaceTruth implements WorkspaceTruthReader {
  readonly values = new Map<string, WorkspaceTruth>();
  inspectCalls = 0;
  async inspect(claim: Claim): Promise<WorkspaceTruth> {
    this.inspectCalls += 1;
    return structuredClone(this.values.get(claim.fence) ?? { kind: "absent" });
  }
}

class MemoryGitHubTransport implements GitHubTransport {
  readonly descendants = new Map<string, Set<string>>();
  async containsCommit(_repository: string, base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    return this.descendants.get(head)?.has(base) ?? false;
  }

  readonly issues: GitHubIssueRecord[] = [];
  readonly labels = new Map<string, string[]>();
  readonly blockers = new Map<string, GitHubIssueLink[]>();
  readonly items = new Map<string, GitHubProjectItem[]>();
  readonly fields = new Map<string, GitHubProjectFieldValue[]>();
  readonly comments = new Map<string, GitHubComment[]>();
  readonly prs = new Map<string, GitHubPullRequestEvidence[]>();
  readonly failedChecks = new Map<string, { checkName: string; checkUrl: string; command: string; output: string }[]>();
  readonly branches = new Map<string, GitHubBranchEvidence>();
  readonly calls = new Map<string, number>();
  readonly issueBounds: (string | null)[] = [];
  pageSize = 100;
  honorUpdatedSince = false;
  failNextListIssues = false;
  failNextCreateIssue = false;
  #commentId = 1000;

  addIssue(number: number, state: LifecycleState = "ready", dependencies: string[] = [], risk: "low" | "medium" | "high" = "low"): GitHubIssueRecord {
    const id = `I_${number}`;
    const record: GitHubIssueRecord = {
      id,
      number,
      title: `Issue ${number}`,
      body: contract(`WORK-${number}`, dependencies, risk),
      url: `https://github.test/acme/repo/issues/${number}`,
      state: state === "done" ? "CLOSED" : "OPEN",
      createdAt: `2026-08-${String(number).padStart(2, "0")}T10:00:00Z`,
      updatedAt: `2026-08-${String(number).padStart(2, "0")}T10:00:00Z`,
      assigneeId: null,
    };
    this.issues.push(record);
    this.labels.set(id, ["v4", `state:${state}`]);
    this.blockers.set(id, []);
    this.items.set(id, [{ id: `ITEM_${number}`, projectId: "PROJECT" }]);
    this.fields.set(`ITEM_${number}`, [
      { kind: "single-select", fieldId: "STATUS", fieldName: "Status", optionId: `opt-${state}`, value: state },
      { kind: "text", fieldId: "GATE", fieldName: "Gate", value: null },
    ]);
    this.comments.set(id, []);
    this.prs.set(id, []);
    return record;
  }

  listIssues(_repository: string, cursor: string | null, updatedSince: string | null = null): Promise<Page<GitHubIssueRecord>> {
    this.issueBounds.push(updatedSince);
    if (this.failNextListIssues) {
      this.failNextListIssues = false;
      this.hit("issues");
      return Promise.reject(new Error("provider listing failed"));
    }
    const issues = this.honorUpdatedSince && updatedSince !== null
      ? this.issues.filter((issue) => Date.parse(issue.updatedAt) >= Date.parse(updatedSince))
      : this.issues;
    return Promise.resolve(this.paged("issues", issues, cursor));
  }
  getIssuesByNodeIds(ids: readonly string[]): Promise<(GitHubIssueRecord | null)[]> {
    this.hit("issue-nodes");
    return Promise.resolve(ids.map((id) => this.issues.find((issue) => issue.id === id) ?? null));
  }
  listLabels(issueId: string, cursor: string | null): Promise<Page<string>> {
    return Promise.resolve(this.paged("labels", this.labels.get(issueId) ?? [], cursor));
  }
  listBlockedBy(issueId: string, cursor: string | null): Promise<Page<GitHubIssueLink>> {
    return Promise.resolve(this.paged("blocked-by", this.blockers.get(issueId) ?? [], cursor));
  }
  listProjectItems(issueId: string, cursor: string | null): Promise<Page<GitHubProjectItem>> {
    return Promise.resolve(this.paged("project-items", this.items.get(issueId) ?? [], cursor));
  }
  listProjectFieldValues(itemId: string, cursor: string | null): Promise<Page<GitHubProjectFieldValue>> {
    return Promise.resolve(this.paged("field-values", this.fields.get(itemId) ?? [], cursor));
  }
  listComments(issueId: string, cursor: string | null): Promise<Page<GitHubComment>> {
    return Promise.resolve(this.paged("comments", this.comments.get(issueId) ?? [], cursor));
  }
  listClosingPullRequests(issueId: string, cursor: string | null): Promise<Page<GitHubPullRequestEvidence>> {
    return Promise.resolve(this.paged("pull-requests", this.prs.get(issueId) ?? [], cursor));
  }
  listFailedCheckDetails(_repository: string, headSha: string) {
    this.hit("failed-check-details");
    return Promise.resolve(structuredClone(this.failedChecks.get(headSha) ?? []));
  }
  getBranch(_repository: string, branchName: string): Promise<GitHubBranchEvidence | null> {
    this.hit("branch");
    return Promise.resolve(structuredClone(this.branches.get(branchName) ?? null));
  }
  getBaseSha(_repository: string, branchName: string): Promise<string> {
    this.hit("base");
    return Promise.resolve(this.branches.get(branchName)?.oid ?? "b".repeat(40));
  }
  readonly merged: string[] = [];
  async mergePullRequest(pullRequestId: string, commitHeadline: string): Promise<void> {
    this.hit("merge-pr");
    this.merged.push(`${pullRequestId}:${commitHeadline}`);
    const [issueId] = [...this.prs.entries()].find(([, prs]) => prs.some((pr) => pr.id === pullRequestId)) ?? [];
    if (issueId) {
      this.prs.set(issueId, this.prs.get(issueId)!.map((pr) => pr.id === pullRequestId
        ? { ...pr, state: "MERGED" as const, mergedAt: "2026-08-20T12:00:00Z", mergeCommitSha: "e".repeat(40) }
        : pr));
    }
    await Promise.resolve();
  }
  async appendComment(issueId: string, body: string): Promise<GitHubComment> {
    this.hit("append-comment");
    const timestamp = "2026-08-18T19:10:00Z";
    const comment = { databaseId: ++this.#commentId, body, authorLogin: "craft-bot", createdAt: timestamp, updatedAt: timestamp };
    this.comments.get(issueId)!.push(comment);
    await Promise.resolve();
    return structuredClone(comment);
  }
  async createIssue(_repository: string, title: string, body: string, _labels: readonly string[]): Promise<{ id: string; number: number; url: string }> {
    this.hit("create-issue");
    if (this.failNextCreateIssue) {
      this.failNextCreateIssue = false;
      throw new Error("simulated issue creation interruption");
    }
    const number = Math.max(0, ...this.issues.map((issue) => issue.number)) + 1;
    const id = `I_${number}`;
    const url = `https://github.test/acme/repo/issues/${number}`;
    this.issues.push({ id, number, title, body, url, state: "OPEN", createdAt: "2026-08-18T19:10:00Z", updatedAt: "2026-08-18T19:10:00Z", assigneeId: null });
    this.labels.set(id, []);
    this.blockers.set(id, []);
    this.items.set(id, []);
    this.comments.set(id, []);
    this.prs.set(id, []);
    return { id, number, url };
  }
  async addIssueToProject(projectId: string, contentId: string): Promise<string> {
    this.hit("add-project-item");
    const itemId = `ITEM_${contentId}`;
    this.items.set(contentId, [{ id: itemId, projectId }]);
    this.fields.set(itemId, [
      { kind: "single-select", fieldId: "STATUS", fieldName: "Status", optionId: null, value: null },
      { kind: "text", fieldId: "GATE", fieldName: "Gate", value: null },
    ]);
    return itemId;
  }
  updateIssueBody(_repository: string, issueNumber: number, body: string): Promise<boolean> {
    this.hit("update-body");
    const issue = this.issues.find((entry) => entry.number === issueNumber);
    if (!issue) return Promise.reject(new Error("missing issue"));
    issue.body = body;
    return Promise.resolve(true);
  }
  replaceLabels(_repository: string, issueNumber: number, labels: readonly string[]): Promise<void> {
    this.hit("replace-labels");
    this.labels.set(`I_${issueNumber}`, [...labels]);
    return Promise.resolve();
  }
  updateProjectSingleSelect(_projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    this.hit("project-status");
    const values = this.fields.get(itemId)!;
    const field = values.find((value) => value.fieldId === fieldId);
    if (!field || field.kind !== "single-select") throw new Error("missing status field");
    field.optionId = optionId;
    field.value = optionId.replace(/^opt-/, "");
    return Promise.resolve();
  }
  updateProjectText(_projectId: string, itemId: string, fieldId: string, value: string): Promise<void> {
    this.hit("project-text");
    const field = this.fields.get(itemId)!.find((entry) => entry.fieldId === fieldId);
    if (!field || field.kind !== "text") throw new Error("missing gate field");
    field.value = value;
    return Promise.resolve();
  }

  private paged<T>(name: string, values: T[], cursor: string | null): Page<T> {
    this.hit(name);
    const offset = cursor === null ? 0 : Number(cursor);
    const nodes = values.slice(offset, offset + this.pageSize).map((value) => structuredClone(value));
    const next = offset + this.pageSize;
    return { nodes, nextCursor: next < values.length ? String(next) : null };
  }
  private hit(name: string): void { this.calls.set(name, (this.calls.get(name) ?? 0) + 1); }
}

function contract(id: string, dependencies: string[], risk: "low" | "medium" | "high" = "low"): string {
  const budget = risk === "high"
    ? "security-review-owner-gate-exact-readback"
    : "targeted-tests-plus-one-simulator-smoke";
  return `## Work contract

\`\`\`yaml
id: ${id}
goal: Exercise the GitHub adapter deterministically.
risk: ${risk}
deployAuthority: none
model: pi/gpt-5.6-sol
verificationBudget: ${budget}
requires:${dependencies.length ? `\n${dependencies.map((entry) => `  - ${entry}`).join("\n")}` : " []"}
nonGoals:
  - live mutations
acceptance:
  - exact durable transition
\`\`\`
`;
}

function config(
  claimFenceIssueId = "FENCE",
  configuredClaimFenceIssueIds: readonly string[] = [claimFenceIssueId],
  onDiagnostic?: (message: string) => void,
): GitHubAdapterConfig {
  const states = Object.fromEntries(lifecycleStates.map((state) => [state, {
    label: `state:${state}`,
    projectStatusOptionId: `opt-${state}`,
  }])) as Record<LifecycleState, { label: string; projectStatusOptionId: string }>;
  return {
    repository: "acme/repo",
    projectId: "PROJECT",
    claimFenceIssueId,
    configuredClaimFenceIssueIds,
    statusFieldId: "STATUS",
    gateFieldId: "GATE",
    requiredLabels: [" V4 "],
    states,
    workflow: {
      ...workflow.config,
      project: { ...workflow.config.project, repository: "acme/repo" },
      tracker: { ...workflow.config.tracker, kind: "github" },
    },
    eventAuthorLogin: "craft-bot",
    ...(onDiagnostic ? { onDiagnostic } : {}),
  };
}

function setup(): { transport: MemoryGitHubTransport; truth: MemoryWorkspaceTruth; adapter: GitHubIssuesProjectsAdapter } {
  const transport = new MemoryGitHubTransport();
  transport.branches.set("main", { name: "main", url: "https://github.test/acme/repo/tree/main", oid: "b".repeat(40) });
  transport.comments.set("FENCE", []);
  const truth = new MemoryWorkspaceTruth();
  return { transport, truth, adapter: new GitHubIssuesProjectsAdapter(config(), transport, truth) };
}

function compactConfig(): GitHubAdapterConfig {
  const base = config();
  const active = new Set<LifecycleState>(["claimed", "running", "pr-open", "review", "owner-gate", "merged", "deployed", "blocked"]);
  const states = Object.fromEntries(lifecycleStates.map((state) => {
    if (state === "ready") return [state, { label: "agent-ready", projectStatusOptionId: "todo" }];
    if (state === "retry-wait") return [state, { label: "agent-running", projectStatusOptionId: "todo" }];
    if (active.has(state)) return [state, { label: "agent-running", projectStatusOptionId: "in-progress" }];
    return [state, { label: "agent-done", projectStatusOptionId: "done" }];
  })) as GitHubAdapterConfig["states"];
  return { ...base, states };
}

async function proposedClaim(adapter: GitHubIssuesProjectsAdapter, issueId: string, nowMs = 1_000): Promise<Claim> {
  const snapshot = await adapter.get(issueId);
  return new IdentityFactory(workflow.config.workspace.root).claimFor(
    snapshot.issue,
    snapshot.retry?.attempt ?? 1,
    snapshot.version,
    snapshot.baseSha,
    { ...workflow.config.model, defaultProfile: snapshot.contract.modelProfile },
    nowMs,
    workflow.config.scheduler.claimTtlMs,
  );
}

function attachPr(
  transport: MemoryGitHubTransport,
  issueId: string,
  merged = false,
  checks: { state: string | null; count: number } = { state: "SUCCESS", count: 1 },
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN" = "MERGEABLE",
): void {
  transport.prs.set(issueId, [{
    mergeable,
    checkRollupState: checks.state,
    checkCount: checks.count,
    id: "PR_1",
    url: "https://github.test/acme/repo/pull/1",
    state: merged ? "MERGED" : "OPEN",
    headRefName: "v4/acme-repo-1",
    headRefOid: "d".repeat(40),
    baseRefName: "main",
    baseRefOid: "b".repeat(40),
    mergedAt: merged ? "2026-08-18T19:20:00Z" : null,
    mergeCommitSha: merged ? "c".repeat(40) : null,
  }]);
  transport.branches.set("v4/acme-repo-1", {
    name: "v4/acme-repo-1",
    url: "https://github.test/acme/repo/tree/v4/acme-repo-1",
    oid: "d".repeat(40),
  });
}

describe("v4.2 GitHub Issues and Projects adapter", () => {
  test("creates one bounded successor and supersedes the open authored source before any claim", async () => {
    const { transport, truth, adapter } = setup();
    const sourceRecord = transport.addIssue(1);
    sourceRecord.body = sourceRecord.body.replace(
      "acceptance:\n  - exact durable transition",
      "acceptance:\n  - exact durable transition\n  - preserve authored ordering\n  - report remaining scope verbatim",
    );
    const sourceBody = sourceRecord.body;
    const source = await adapter.get(sourceRecord.id);
    const proposal = proposePreclaimScope(source, config().workflow)!;

    const first = await adapter.applyPreclaimScope(proposal, 2_000);
    expect(first).toMatchObject({
      outcome: "applied",
      source: { issue: { id: sourceRecord.id, state: "cancelled", closed: false }, claim: null },
      successor: { issue: { state: "ready", closed: false }, contract: { acceptance: ["exact durable transition", "preserve authored ordering"] } },
    });
    expect(first.outcome === "refused" ? null : first.source.events.map((event) => event.kind)).not.toContain("claim");
    expect(first.outcome === "refused" ? null : first.source.events).toContainEqual(expect.objectContaining({
      kind: "supersession",
      successor: proposal.contract.id,
    }));
    expect(sourceRecord.state).toBe("OPEN");
    expect(sourceRecord.body).toBe(sourceBody);
    expect(transport.calls.get("create-issue")).toBe(1);

    const restarted = new GitHubIssuesProjectsAdapter(config(), transport, truth);
    expect(await restarted.reconcilePreclaimScopes(3_000)).toBeNull();
    expect(transport.calls.get("create-issue")).toBe(1);
    expect(transport.issues.filter((issue) => issue.body.includes(proposal.contract.id))).toHaveLength(1);
    expect(proposal.contractMarkdown).toContain(JSON.stringify("report remaining scope verbatim"));
  });

  test("source CAS elects one concurrent creator and an interrupted reservation resumes after restart", async () => {
    const concurrent = setup();
    const sourceRecord = concurrent.transport.addIssue(1);
    sourceRecord.body = sourceRecord.body.replace(
      "acceptance:\n  - exact durable transition",
      "acceptance:\n  - exact durable transition\n  - preserve authored ordering\n  - report remaining scope verbatim",
    );
    const proposal = proposePreclaimScope(await concurrent.adapter.get(sourceRecord.id), config().workflow)!;
    const [left, right] = await Promise.all([
      concurrent.adapter.applyPreclaimScope(proposal, 2_000),
      concurrent.adapter.applyPreclaimScope(proposal, 2_000),
    ]);
    expect([left.outcome, right.outcome].sort()).toEqual(["applied", "refused"]);
    expect(concurrent.transport.calls.get("create-issue")).toBe(1);

    const interrupted = setup();
    const interruptedSource = interrupted.transport.addIssue(1);
    interruptedSource.body = interruptedSource.body.replace(
      "acceptance:\n  - exact durable transition",
      "acceptance:\n  - exact durable transition\n  - preserve authored ordering\n  - report remaining scope verbatim",
    );
    const interruptedProposal = proposePreclaimScope(await interrupted.adapter.get(interruptedSource.id), config().workflow)!;
    interrupted.transport.failNextCreateIssue = true;
    await expect(interrupted.adapter.applyPreclaimScope(interruptedProposal, 2_000)).rejects.toThrow("simulated issue creation interruption");
    const reserved = await interrupted.adapter.get(interruptedSource.id);
    expect(reserved).toMatchObject({ issue: { state: "cancelled", closed: false }, claim: null });
    expect(reserved.events).toContainEqual(expect.objectContaining({
      kind: "supersession",
      successor: interruptedProposal.contract.id,
    }));

    const restarted = new GitHubIssuesProjectsAdapter(config(), interrupted.transport, interrupted.truth);
    expect(await restarted.reconcilePreclaimScopes(3_000)).toMatchObject({ outcome: "applied" });
    expect(interrupted.transport.issues.filter((issue) => issue.body.includes(interruptedProposal.contract.id))).toHaveLength(1);
    expect(await restarted.reconcilePreclaimScopes(4_000)).toBeNull();
  });

  test("projects one immutable directive receipt visibly on its issue and deduplicates after restart", async () => {
    const { transport, truth, adapter } = setup();
    transport.addIssue(1);
    const directive = {
      id: "directive-owner-1",
      issueId: "I_1",
      receivedAtMs: 2_000,
      acknowledgedAtMs: 2_000,
      verbatim: "Keep the change bounded.",
      sourceSessionId: "owner-desk",
      sourceMessageId: "owner-message-1",
      sourceTimestampMs: 1_500,
      acknowledgementId: "ack-owner-1",
    };

    expect(await adapter.recordOwnerDirective(directive)).toEqual({ recorded: true });
    const restarted = new GitHubIssuesProjectsAdapter(config(), transport, truth);
    expect(await restarted.recordOwnerDirective(directive)).toEqual({ recorded: false });

    const receipts = transport.comments.get("I_1")!;
    expect(receipts).toHaveLength(1);
    expect(receipts[0]!.body).toContain("Project Desk directive received for **acme/repo#1**");
    expect(receipts[0]!.body).toContain("> Keep the change bounded.");
    expect(transport.calls.get("append-comment")).toBe(1);
  });

  test("records one immutable preservation receipt and deduplicates the same attempt after restart", async () => {
    const { transport, truth, adapter } = setup();
    transport.addIssue(1);
    const record = {
      issueId: "I_1",
      attempt: 1,
      branch: "v4/acme-repo-1",
      preservedBranch: "v4-preserved/v4-acme-repo-1-a1-1234567",
      commit: "1234567890abcdef1234567890abcdef12345678",
    };

    expect(await adapter.recordPreservation(record)).toEqual({ recorded: true });
    const restarted = new GitHubIssuesProjectsAdapter(config(), transport, truth);
    expect(await restarted.recordPreservation(record)).toEqual({ recorded: false });
    expect(transport.comments.get("I_1")).toHaveLength(1);
    expect(transport.comments.get("I_1")![0]!.body).toContain(`remote branch \`${record.preservedBranch}\``);
    expect(transport.comments.get("I_1")![0]!.body).toContain("craft-protocol-v4:preservation-receipt");
    await expect(restarted.recordPreservation({ ...record, commit: "f".repeat(40) })).rejects.toThrow("immutable");
  });

  test("empty fetches avoid provider requests and pagination normalizes exact fields and dependencies", async () => {
    const { transport, adapter } = setup();
    transport.pageSize = 1;
    transport.addIssue(1, "ready", ["WORK-2"]);
    transport.addIssue(2, "done");

    expect(await adapter.fetchIssuesByStates([])).toEqual([]);
    expect(await adapter.fetchIssuesByIds([])).toEqual([]);
    expect(transport.calls.size).toBe(0);

    const [candidate] = await adapter.fetchIssuesByStates(["ready"]);
    expect(candidate?.issue.blockedBy).toEqual([{ id: "I_2", identifier: "acme/repo#2", state: "done" }]);
    expect(candidate?.issue.dispatchable).toBeTrue();
    expect(transport.calls.get("issues")).toBe(2);
    expect((transport.calls.get("field-values") ?? 0) >= 4).toBeTrue();
  });

  test("the first scan after start walks every issue with no update bound", async () => {
    const { transport, adapter } = setup();
    transport.honorUpdatedSince = true;
    transport.pageSize = 1;
    for (let number = 1; number <= 3; number += 1) transport.addIssue(number);

    expect(await adapter.fetchIssuesByStates(["ready"])).toHaveLength(3);
    expect(transport.calls.get("issues")).toBe(3);
    expect(transport.issueBounds).toEqual([null, null, null]);

    // No state is persisted: a replacement adapter pays the cold-start cost.
    transport.issueBounds.length = 0;
    const restarted = new GitHubIssuesProjectsAdapter(config(), transport, new MemoryWorkspaceTruth());
    expect(await restarted.fetchIssuesByStates(["ready"])).toHaveLength(3);
    expect(transport.issueBounds).toEqual([null, null, null]);
  });

  test("later scans pass the provider's last timestamp as their update bound", async () => {
    const { transport, adapter } = setup();
    transport.honorUpdatedSince = true;
    const first = transport.addIssue(1);
    const second = transport.addIssue(2);
    first.labelNames = ["v4", "state:ready"];
    second.labelNames = ["v4", "state:ready"];

    await adapter.fetchIssuesByStates(["ready"]);
    const providerWatermark = second.updatedAt;
    first.updatedAt = "2026-08-20T12:34:56Z";
    transport.issueBounds.length = 0;

    expect(await adapter.fetchIssuesByStates(["ready"])).toHaveLength(2);
    expect(transport.issueBounds).toEqual([providerWatermark]);
  });

  test("a warm checkpoint resumes since-watermark discovery and exact-refreshes cached targets without persisting bodies", async () => {
    const { transport, adapter } = setup();
    transport.honorUpdatedSince = true;
    const managed = transport.addIssue(1);
    const backlog = transport.addIssue(2);
    managed.labelNames = ["v4", "state:ready"];
    backlog.labelNames = ["bug"];
    transport.labels.set(backlog.id, ["bug"]);

    const beforeManaged = await adapter.fetchIssuesByStates(["ready"]);
    const beforeBacklog = await adapter.fetchBacklog();
    const checkpoint = adapter.exportWarmObservation();

    expect(checkpoint.watermark).toBe(backlog.updatedAt);
    expect(checkpoint.records.every((record) => !Object.hasOwn(record, "body"))).toBeTrue();
    expect(checkpoint.backlog.every((issue) => !Object.hasOwn(issue, "description"))).toBeTrue();
    expect(JSON.stringify(checkpoint)).not.toContain("Exercise the GitHub adapter deterministically");

    const restarted = new GitHubIssuesProjectsAdapter(config(), transport, new MemoryWorkspaceTruth());
    restarted.restoreWarmObservation(checkpoint);
    transport.calls.clear();
    transport.issueBounds.length = 0;

    const afterManaged = await restarted.fetchIssuesByStates(["ready"]);
    const afterBacklog = await restarted.fetchBacklog();

    expect(afterManaged).toEqual(beforeManaged);
    expect(afterBacklog).toEqual(beforeBacklog);
    expect(transport.issueBounds.length).toBeGreaterThan(0);
    expect(transport.issueBounds.every((bound) => bound === checkpoint.watermark)).toBeTrue();
    expect(transport.issueBounds).not.toContain(null);
    // One batched node refresh replaces a repository-wide cold listing and
    // restores every redacted body before the adapter can return live state.
    expect(transport.calls.get("issue-nodes")).toBeGreaterThan(0);

    expect(() => restarted.restoreWarmObservation({ ...checkpoint, repository: "other/repo" })).toThrow("repository mismatch");
    expect(() => restarted.restoreWarmObservation({ ...checkpoint, records: [{ ...checkpoint.records[0], body: "raw" }] })).toThrow("issue body");
    expect(() => restarted.restoreWarmObservation({
      ...checkpoint,
      backlog: [{ ...checkpoint.backlog[0], blockedBy: [{ id: "bad", state: "OPEN" }] }],
    })).toThrow("malformed");
  });

  test("provider changes reconcile exactly from a restored watermark", async () => {
    const { transport, adapter } = setup();
    transport.honorUpdatedSince = true;
    const issue = transport.addIssue(1);
    issue.labelNames = ["v4", "state:ready"];
    await adapter.fetchIssuesByStates(["ready"]);
    const checkpoint = adapter.exportWarmObservation();

    issue.title = "Changed provider title";
    issue.updatedAt = "2026-08-22T08:00:00Z";
    const restarted = new GitHubIssuesProjectsAdapter(config(), transport, new MemoryWorkspaceTruth());
    restarted.restoreWarmObservation(checkpoint);

    const [changed] = await restarted.fetchIssuesByStates(["ready"]);
    expect(changed?.issue.title).toBe("Changed provider title");
    expect(transport.issueBounds.at(-1)).toBe(checkpoint.watermark);
  });

  test("warm promotion re-reads active provider and worktree truth without writing lifecycle state", async () => {
    const { transport, adapter } = setup();
    transport.honorUpdatedSince = true;
    transport.addIssue(1);
    const ready = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", ready.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    const checkpoint = adapter.exportWarmObservation();

    const truth = new MemoryWorkspaceTruth();
    truth.values.set(claim.fence, { kind: "bound", binding: claim });
    const restarted = new GitHubIssuesProjectsAdapter(config(), transport, truth);
    restarted.restoreWarmObservation(checkpoint);
    transport.calls.clear();
    const [live] = await restarted.fetchIssuesByStates(["running"]);
    await restarted.verifyWarmMutationTruth();

    expect(live?.claim?.fence).toBe(claim.fence);
    expect(transport.calls.get("issue-nodes")).toBeGreaterThan(0);
    expect(truth.inspectCalls).toBe(1);
    expect(live?.version).toBe((await adapter.get("I_1")).version);

    truth.values.set(claim.fence, { kind: "ambiguous", reason: "dirty/unpushed" });
    await expect(restarted.verifyWarmMutationTruth()).rejects.toThrow("ambiguous");
  });

  test("an active claim is node-refreshed when PR checks change without touching the issue", async () => {
    const { transport, adapter } = setup();
    transport.honorUpdatedSince = true;
    transport.addIssue(1);
    const ready = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", ready.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    const unchangedIssueTimestamp = transport.issues[0]!.updatedAt;

    transport.calls.clear();
    transport.issueBounds.length = 0;
    attachPr(transport, "I_1");
    const advanced = await adapter.advanceByEvidence(1_200);

    expect(advanced).toEqual([{ issueId: "I_1", action: "advanced", reason: "pull request evidence" }]);
    expect(transport.calls.get("issue-nodes")).toBeGreaterThan(0);
    expect(transport.issueBounds[0]).toBe(unchangedIssueTimestamp);
  });

  test("a failed scan leaves the provider watermark unchanged for the retry", async () => {
    const { transport, adapter } = setup();
    transport.honorUpdatedSince = true;
    const issue = transport.addIssue(1);
    await adapter.fetchIssuesByStates(["ready"]);
    transport.issueBounds.length = 0;
    transport.failNextListIssues = true;

    await expect(adapter.fetchIssuesByStates(["ready"])).rejects.toThrow("provider listing failed");
    await expect(adapter.fetchIssuesByStates(["ready"])).resolves.toHaveLength(1);
    expect(transport.issueBounds).toEqual([issue.updatedAt, issue.updatedAt]);
  });

  test("listing labels let discovery skip unmanaged issues without hydrating them", async () => {
    const { transport, adapter } = setup();
    const managed = transport.addIssue(1, "ready");
    const unmanaged = transport.addIssue(2, "ready");
    // The listing itself reports labels. Only #1 carries a lifecycle label; #2
    // is an ordinary tracker issue the lane does not manage.
    managed.labelNames = ["v4", "state:ready"];
    unmanaged.labelNames = ["bug", "tracking:child"];

    const found = await adapter.fetchIssuesByStates(["ready"]);

    expect(found.map((entry) => entry.issue.identifier)).toEqual(["acme/repo#1"]);
    // One issue hydrated, so exactly one project-item lookup — the unmanaged
    // issue cost nothing beyond the listing page it arrived in.
    expect(transport.calls.get("project-items")).toBe(1);
    expect(transport.calls.get("comments")).toBe(1);
  });

  test("unknown listing labels still hydrate, so a truncated label page cannot hide a claim", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "ready");
    // labelNames stays undefined: the transport could not prove the label set.

    const found = await adapter.fetchIssuesByStates(["ready"]);

    expect(found.map((entry) => entry.issue.identifier)).toEqual(["acme/repo#1"]);
    expect(transport.calls.get("project-items")).toBe(1);
  });

  test("an explicitly requested issue is hydrated even when its listing labels look unmanaged", async () => {
    const { transport, adapter } = setup();
    const record = transport.addIssue(1, "ready");
    record.labelNames = ["bug"];
    // Its real labels still carry the lifecycle label; only the listing view
    // looked unmanaged. Asking for it by id must not silently drop it.

    const snapshot = await adapter.get("I_1");

    expect(snapshot.issue.identifier).toBe("acme/repo#1");
  });

  test("backlog is the open unmanaged issues without full lifecycle hydration", async () => {
    const { transport, adapter } = setup();
    const managed = transport.addIssue(1, "ready");
    const unmanaged = transport.addIssue(2, "ready");
    const closedUnmanaged = transport.addIssue(3, "done");
    managed.labelNames = ["v4", "state:ready"];
    unmanaged.labelNames = ["bug", "tracking:child"];
    closedUnmanaged.labelNames = ["bug"];
    closedUnmanaged.state = "CLOSED";

    const backlog = await adapter.fetchBacklog();

    // Only the open, unmanaged issue: the managed one belongs to the lane and
    // the closed one is not work anybody is waiting on.
    expect(backlog.map((entry) => entry.identifier)).toEqual(["acme/repo#2"]);
    expect(backlog[0]).toMatchObject({ number: 2, labels: ["bug", "tracking:child"] });
    // Blocker edges are read for grooming, but no lifecycle/Project hydration is
    // needed: labels, body, priority and parent rode along with the listing.
    expect(transport.calls.get("blocked-by")).toBe(1);
    expect(transport.calls.get("project-items") ?? 0).toBe(0);
    expect(transport.calls.get("comments") ?? 0).toBe(0);
  });

  test("an issue whose listing labels are unknown is never reported as backlog", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "ready");
    // labelNames undefined: a truncated label page. Discovery hydrates it, so
    // guessing here could show a managed issue as unmanaged backlog.

    expect(await adapter.fetchBacklog()).toEqual([]);
  });

  test("grounds a red pull request in the provider's exact failing command and output", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    attachPr(transport, "I_1", false, { state: "FAILURE", count: 1 });
    transport.failedChecks.set("d".repeat(40), [{
      checkName: "validate / test",
      checkUrl: "https://github.test/acme/repo/actions/runs/1",
      command: "bun test packages/symphony/tests/ci-repair.test.ts",
      output: "AssertionError: expected exact provider output",
    }]);

    expect(await adapter.ciFailure("I_1")).toEqual({
      pullRequestId: "PR_1",
      pullRequestUrl: "https://github.test/acme/repo/pull/1",
      headBranch: "v4/acme-repo-1",
      headSha: "d".repeat(40),
      checkName: "validate / test",
      checkUrl: "https://github.test/acme/repo/actions/runs/1",
      command: "bun test packages/symphony/tests/ci-repair.test.ts",
      output: "AssertionError: expected exact provider output",
    });
    expect(transport.calls.get("failed-check-details")).toBe(1);
  });

  test("serializes concurrent repair authorizations so one attempt number is consumed once", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    const candidate = {
      attempt: 1 as const,
      headSha: "d".repeat(40),
      checkName: "validate / test",
      command: "bun test",
      output: "failure",
      cause: "contract-work" as const,
      diagnosis: "one diagnosis",
      touchedPaths: ["src/widget.ts"],
      previousMistake: null,
    };
    const results = await Promise.allSettled([
      adapter.recordCiRepairAttempt("I_1", "PR_1", candidate),
      adapter.recordCiRepairAttempt("I_1", "PR_1", candidate),
    ]);
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(await adapter.ciRepairAttempts("I_1", "PR_1")).toHaveLength(1);
  });

  test("persists the repair budget in authenticated provider comments and refuses a third attempt", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    const base = {
      headSha: "d".repeat(40),
      checkName: "validate / test",
      command: "bun test",
      output: "failure",
      cause: "contract-work" as const,
      touchedPaths: ["src/widget.ts"],
    };
    await adapter.recordCiRepairAttempt("I_1", "PR_1", {
      ...base, attempt: 1, diagnosis: "first diagnosis", previousMistake: null,
    });
    await adapter.recordCiRepairAttempt("I_1", "PR_1", {
      ...base, attempt: 2, diagnosis: "second diagnosis", previousMistake: "the first diagnosis targeted the wrong layer",
    });

    expect(await adapter.ciRepairAttempts("I_1", "PR_1")).toMatchObject([
      { attempt: 1, diagnosis: "first diagnosis" },
      { attempt: 2, diagnosis: "second diagnosis", previousMistake: "the first diagnosis targeted the wrong layer" },
    ]);
    await expect(adapter.recordCiRepairAttempt("I_1", "PR_1", {
      ...base, attempt: 2, diagnosis: "third diagnosis", previousMistake: "again",
    })).rejects.toThrow("two-attempt cap");
  });

  test("returns no actionable repair evidence when a red rollup has no failed-step detail", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    attachPr(transport, "I_1", false, { state: "FAILURE", count: 1 });

    expect(await adapter.ciFailure("I_1")).toBeNull();
  });

  test("classifies queued, running, requested-review, and behind PRs as waiting", async () => {
    const cases = [
      {
        expected: "checks are QUEUED",
        patch: { checkRollupState: "PENDING", checkRunStatuses: ["QUEUED"] },
      },
      {
        expected: "checks are RUNNING",
        patch: { checkRollupState: "PENDING", checkRunStatuses: ["IN_PROGRESS"] },
      },
      {
        expected: "review is REQUESTED",
        patch: { reviewDecision: "REVIEW_REQUIRED" },
      },
      {
        expected: "base branch is BEHIND",
        patch: { mergeStateStatus: "BEHIND" },
      },
    ] satisfies { expected: string; patch: Partial<GitHubPullRequestEvidence> }[];

    for (const { expected, patch } of cases) {
      const { transport, adapter } = setup();
      transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
      attachPr(transport, "I_1", false, { state: "SUCCESS", count: 1 });
      Object.assign(transport.prs.get("I_1")![0]!, patch);
      expect(await adapter.pullRequestVerdict("I_1")).toMatchObject({
        disposition: "waiting",
        verdict: expected,
      });
    }
  });

  test("reports exact stuck verdicts with the condition required to resume", async () => {
    const unknown = setup();
    unknown.transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    attachPr(unknown.transport, "I_1", false, { state: "SUCCESS", count: 1 }, "UNKNOWN");
    expect(await unknown.adapter.pullRequestVerdict("I_1")).toMatchObject({
      disposition: "stuck",
      verdict: "mergeability is UNKNOWN",
      resumeCondition: "GitHub must report a definitive mergeability verdict",
    });

    const conflicting = setup();
    conflicting.transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    attachPr(conflicting.transport, "I_1", false, { state: "SUCCESS", count: 1 }, "CONFLICTING");
    expect(await conflicting.adapter.pullRequestVerdict("I_1")).toMatchObject({
      disposition: "stuck",
      verdict: "mergeability is CONFLICTING",
      resumeCondition: "the branch must be updated to resolve conflicts with main",
    });

    const unchecked = setup();
    unchecked.transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    attachPr(unchecked.transport, "I_1", false, { state: null, count: 0 });
    // GitHub also reports BLOCKED when required checks never appeared. The exact
    // missing-check fact must outrank that generic merge-state summary.
    Object.assign(unchecked.transport.prs.get("I_1")![0]!, { mergeStateStatus: "BLOCKED" });
    expect(await unchecked.adapter.pullRequestVerdict("I_1")).toMatchObject({
      disposition: "stuck",
      verdict: "no checks ran on the head commit",
      resumeCondition: "at least one required check must run on the head commit and pass",
    });
    // The same head still cannot merge: parking classification never loosens the guard.
    expect(await unchecked.adapter.mergeClosingPullRequest("I_1")).toEqual({
      merged: false,
      reason: "no checks ran on the head commit",
    });
    expect(unchecked.transport.merged).toBeEmpty();
  });

  test("auto-merge lands a mergeable pull request whose checks actually passed", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    attachPr(transport, "I_1", false, { state: "SUCCESS", count: 2 });

    const outcome = await adapter.mergeClosingPullRequest("I_1");

    expect(outcome).toMatchObject({ merged: true });
    expect(transport.merged).toHaveLength(1);
  });

  test("auto-merge refuses when no checks ran, because absence is not success", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    // A repository whose workflow does not trigger on this base branch reports
    // no checks at all. Reading that as green merges an unverified change —
    // which is exactly what happened to a real PR before this existed.
    attachPr(transport, "I_1", false, { state: null, count: 0 });

    const outcome = await adapter.mergeClosingPullRequest("I_1");

    expect(outcome).toMatchObject({ merged: false, reason: "no checks ran on the head commit" });
    expect(transport.merged).toBeEmpty();
  });

  test("auto-merge refuses failing checks, a conflicting merge, and an already-merged PR", async () => {
    const failing = setup();
    failing.transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    attachPr(failing.transport, "I_1", false, { state: "FAILURE", count: 3 });
    expect(await failing.adapter.mergeClosingPullRequest("I_1")).toMatchObject({ merged: false, reason: "checks are FAILURE" });
    expect(failing.transport.merged).toBeEmpty();

    const conflicting = setup();
    conflicting.transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    attachPr(conflicting.transport, "I_1", false, { state: "SUCCESS", count: 1 }, "CONFLICTING");
    expect(await conflicting.adapter.mergeClosingPullRequest("I_1")).toMatchObject({ merged: false, reason: "mergeability is CONFLICTING" });
    expect(conflicting.transport.merged).toBeEmpty();

    const done = setup();
    done.transport.addIssue(1, "pr-open").labelNames = ["v4", "state:pr-open"];
    attachPr(done.transport, "I_1", true, { state: "SUCCESS", count: 1 });
    expect(await done.adapter.mergeClosingPullRequest("I_1")).toMatchObject({ merged: false, reason: "already merged" });
    expect(done.transport.merged).toBeEmpty();
  });

  test("an item whose status was never projected still hydrates from its lifecycle label", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "ready");
    // A Project that auto-adds new repository issues creates the item with no
    // status value. Refusing that stopped an entire project on one card.
    transport.fields.set("ITEM_1", [{ kind: "text", fieldId: "GATE", fieldName: "Gate", value: null }]);

    const [snapshot] = await adapter.fetchIssuesByStates(["ready"]);

    expect(snapshot?.issue.state).toBe("ready");
    expect(snapshot?.issue.identifier).toBe("acme/repo#1");
  });

  test("a status the label cannot disambiguate still fails closed", async () => {
    // compactConfig maps several states onto one label, so with no status value
    // the label alone cannot say which state it is — that is real ambiguity.
    const transport = new MemoryGitHubTransport();
    transport.branches.set("main", { name: "main", url: "https://github.test/acme/repo/tree/main", oid: "b".repeat(40) });
    transport.comments.set("FENCE", []);
    const adapter = new GitHubIssuesProjectsAdapter(compactConfig(), transport, new MemoryWorkspaceTruth());
    transport.addIssue(1, "running");
    transport.labels.set("I_1", ["v4", "agent-running"]);
    transport.fields.set("ITEM_1", [{ kind: "text", fieldId: "GATE", fieldName: "Gate", value: null }]);

    // Omitted rather than accepted: repository-wide discovery tolerates an
    // issue it cannot read, and this one carries no claim.
    expect(await adapter.fetchIssuesByStates(["running"])).toEqual([]);
  });

  test("duplicate values for one field are still ambiguous", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "ready");
    transport.fields.set("ITEM_1", [
      { kind: "single-select", fieldId: "STATUS", fieldName: "Status", optionId: "opt-ready", value: "ready" },
      { kind: "single-select", fieldId: "STATUS", fieldName: "Status", optionId: "opt-done", value: "done" },
    ]);

    expect(await adapter.fetchIssuesByStates(["ready"])).toEqual([]);
  });

  test("concurrent compare-and-set claims elect exactly one durable comment", async () => {
    const { transport, truth, adapter } = setup();
    transport.addIssue(1);
    const competitor = new GitHubIssuesProjectsAdapter(config(), transport, truth);
    const snapshot = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");

    const results = await Promise.all([
      adapter.tryClaim("I_1", snapshot.version, claim, 1_000),
      competitor.tryClaim("I_1", snapshot.version, claim, 1_000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect((await adapter.get("I_1")).claim).toEqual(claim);
    expect(transport.comments.get("FENCE")).toHaveLength(2);
    expect(transport.comments.get("I_1")).toHaveLength(1);
  });

  test("shared provider fence enforces WIP=1 across concurrent different issues and schedulers", async () => {
    const { transport, truth, adapter } = setup();
    transport.addIssue(1);
    transport.addIssue(2);
    const competitor = new GitHubIssuesProjectsAdapter(config(), transport, truth);
    const [first, second] = await Promise.all([adapter.get("I_1"), competitor.get("I_2")]);
    const [firstClaim, secondClaim] = await Promise.all([
      proposedClaim(adapter, "I_1"),
      proposedClaim(competitor, "I_2"),
    ]);

    const results = await Promise.all([
      adapter.tryClaim("I_1", first.version, firstClaim, 1_000),
      competitor.tryClaim("I_2", second.version, secondClaim, 1_000),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    const claimedIssues = [await adapter.get("I_1"), await adapter.get("I_2")].filter((entry) => entry.claim);
    expect(claimedIssues).toHaveLength(1);
    expect(transport.comments.get("FENCE")).toHaveLength(2);
  });

  test("compact provider labels and statuses reconstruct distinct ledger states after restart", async () => {
    const { transport, truth } = setup();
    transport.addIssue(1);
    transport.labels.set("I_1", ["v4", "agent-ready"]);
    transport.fields.set("ITEM_1", [
      { kind: "single-select", fieldId: "STATUS", fieldName: "Status", optionId: "todo", value: "Todo" },
      { kind: "text", fieldId: "GATE", fieldName: "Gate", value: null },
    ]);
    const adapter = new GitHubIssuesProjectsAdapter(compactConfig(), transport, truth);
    const ready = await adapter.get("I_1");
    const claim = new IdentityFactory(workflow.config.workspace.root).claimFor(
      ready.issue,
      1,
      ready.version,
      ready.baseSha,
      { ...workflow.config.model, defaultProfile: ready.contract.modelProfile },
      1_000,
      workflow.config.scheduler.claimTtlMs,
    );

    await adapter.tryClaim("I_1", ready.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    expect(transport.labels.get("I_1")).toEqual(["v4", "agent-running"]);
    expect((transport.fields.get("ITEM_1")![0] as { optionId: string | null }).optionId).toBe("in-progress");

    const restarted = new GitHubIssuesProjectsAdapter(compactConfig(), transport, truth);
    const reconstructed = await restarted.get("I_1");
    expect(reconstructed.issue.state).toBe("running");
    expect(reconstructed.claim?.sessionId).toBe(claim.sessionId);
  });

  test("stale fence cannot mutate a durable claim and restart reconstructs the exact binding", async () => {
    const { transport, truth, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    expect(await adapter.tryClaim("I_1", before.version, claim, 1_000)).not.toBeNull();
    await expect(adapter.transition("I_1", "running", 1_100, { fence: "stale-fence" })).rejects.toThrow(parity.claimAndEvidence.staleFenceError);

    const restarted = new GitHubIssuesProjectsAdapter(config(), transport, truth);
    const recovered = await restarted.get("I_1");
    expect(recovered.claim).toEqual(claim);
    expect(recovered.version).toBe(2);
  });

  test("caller-supplied PR evidence is rejected unless exact provider head/base evidence matches", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);

    await expect(adapter.transition("I_1", "pr-open", 1_200, {
      fence: claim.fence,
      evidence: { prUrl: "https://attacker.test/pull/false" },
    })).rejects.toThrow(parity.claimAndEvidence.callerPrEvidenceError);

    attachPr(transport, "I_1");
    transport.prs.get("I_1")![0]!.headRefOid = "e".repeat(40);
    await expect(adapter.transition("I_1", "pr-open", 1_300, {
      fence: claim.fence,
      evidence: { prUrl: "https://attacker.test/pull/false" },
    })).rejects.toThrow(parity.claimAndEvidence.callerPrEvidenceError);

    attachPr(transport, "I_1");
    const opened = await adapter.transition("I_1", "pr-open", 1_400, {
      fence: claim.fence,
      evidence: {
        prUrl: "https://attacker.test/pull/false",
        mergedAt: "2026-08-18T00:00:00Z",
        mergeCommitSha: "f".repeat(40),
      },
    });
    expect(opened.evidence.prUrl).toBe("https://github.test/acme/repo/pull/1");
    expect(opened.evidence.branchSha).toBe("d".repeat(40));
    expect(opened.evidence.mergedAt).toBeUndefined();
    expect(opened.evidence.mergeCommitSha).toBeUndefined();
  });

  test("startup reconciliation maps exact PR and merge evidence to lifecycle state", async () => {
    const { transport, truth, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    truth.values.set(claim.fence, { kind: "bound", binding: claim });
    attachPr(transport, "I_1");

    expect((await adapter.reconcileStartup(1_200))[0]).toMatchObject({ action: "advanced", reason: "pull request evidence" });
    expect((await adapter.get("I_1")).issue.state).toBe("pr-open");

    attachPr(transport, "I_1", true);
    transport.branches.delete("v4/acme-repo-1");
    expect((await adapter.reconcileStartup(1_300))[0]).toMatchObject({ action: "advanced", reason: "merge evidence" });
    const merged = await adapter.get("I_1");
    expect(merged.issue.state).toBe("merged");
    expect(merged.evidence.mergeCommitSha).toBe("c".repeat(40));
  });

  test("a board's own default status column does not read as ambiguity", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    // A project sets its own default when an issue is added to a board, and that
    // option belongs to no lifecycle state. Treating it as a disagreement
    // refused a freshly written contract until a human set the field by hand.
    for (const values of transport.fields.values()) {
      for (const value of values) {
        if (value.kind === "single-select" && value.fieldId === "STATUS") value.optionId = "human-backlog";
      }
    }

    const snapshot = await adapter.get("I_1");
    expect(snapshot.issue.state).toBe("ready");
  });

  test("a high-risk merge that skipped its owner gate blocks for the owner instead of reading as delivered", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "ready", [], "high");
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    attachPr(transport, "I_1");
    await adapter.advanceByEvidence(1_150);
    expect((await adapter.get("I_1")).issue.state).toBe("pr-open");

    // Auto-merge never merges high risk, so a merge here is a person's doing.
    // It must not be recorded as `merged` — for high-risk work that asserts the
    // gate was honoured — and it must not sit in pr-open holding WIP either.
    attachPr(transport, "I_1", true);
    const advanced = await adapter.advanceByEvidence(1_300);
    expect(advanced[0]).toMatchObject({ reason: "high-risk work merged without passing its owner gate" });
    const settled = await adapter.get("I_1");
    expect(settled.issue.state).toBe("blocked");
    expect(settled.claim).toBeNull();
  });

  test("work that merged after its attempt failed stops being reported as a failure", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    attachPr(transport, "I_1");
    await adapter.advanceByEvidence(1_150);

    // The attempt dies after the pull request exists — the branch jammed, the
    // turn was cut short, the run stopped — and the claim is released.
    await adapter.failClaim(claim.fence, "runtime", "attempt died", 1_200, {
      maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, claimTtlMs: 60_000, staleRunMs: 60_000,
    } as never);
    expect((await adapter.get("I_1")).issue.state).toBe("failed");

    // Then the work lands anyway — merged by hand, or by a later auto-merge.
    attachPr(transport, "I_1", true);
    transport.branches.delete("v4/acme-repo-1");

    const advanced = await adapter.advanceByEvidence(1_300);
    expect(advanced).toEqual([
      { issueId: "I_1", action: "advanced", reason: "merge evidence after a failed attempt" },
      { issueId: "I_1", action: "advanced", reason: "merge evidence with no deployment authority" },
    ]);
    const done = await adapter.get("I_1");
    expect(done.issue.state).toBe("done");
    // The failure is not erased — it stays in the history, which is where a
    // failed attempt belongs.
    expect(done.events.some((event) => event.kind === "failure")).toBeTrue();
  });

  test("revival requires a named change, persists it, and renews attempt one without erasing failure history", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const firstClaim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, firstClaim, 1_000);
    await adapter.markRunning(firstClaim.fence, 1_100);
    await adapter.failClaim(firstClaim.fence, "runtime", "provider quota exhausted", 1_200, {
      maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, claimTtlMs: 60_000, staleRunMs: 60_000,
    } as never);

    const writesBeforeRefusal = transport.comments.get("I_1")!.length;
    const unnamed = await adapter.reviveFailed("I_1", "   ", 1_300);
    expect(unnamed).toMatchObject({ accepted: false, reason: "revival refused: a named change is required" });
    expect(transport.comments.get("I_1")!).toHaveLength(writesBeforeRefusal);

    const revived = await adapter.reviveFailed("I_1", "quota reset ticket OPS-42", 1_400);
    expect(revived).toMatchObject({ accepted: true, snapshot: { issue: { state: "ready" }, retry: null } });
    expect(revived.snapshot.events.at(-1)).toMatchObject({
      kind: "revival",
      state: "ready",
      justification: "quota reset ticket OPS-42",
    });

    // No scheduler branch exists for revival. Once projected to ordinary ready,
    // the ordinary claim path grants attempt one of the new budget.
    const newClaim = await proposedClaim(adapter, "I_1", 1_500);
    expect(newClaim.attempt).toBe(1);
    const claimed = await adapter.tryClaim("I_1", revived.snapshot.version, newClaim, 1_500);
    expect(claimed?.claim?.attempt).toBe(1);
    expect(claimed?.events.filter((event) => event.kind === "failure")).toHaveLength(1);
    expect(claimed?.events.map((event) => event.message)).toContain("attempt 1 atomically claimed");
  });

  test("a justification is single-use and the configured revival bound leaves the issue failed with a reason", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);

    const exhaust = async (atMs: number): Promise<void> => {
      const ready = await adapter.get("I_1");
      const claim = await proposedClaim(adapter, "I_1", atMs);
      await adapter.tryClaim("I_1", ready.version, claim, atMs);
      await adapter.markRunning(claim.fence, atMs + 1);
      await adapter.failClaim(claim.fence, "runtime", "attempt exhausted", atMs + 2, {
        maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, claimTtlMs: 60_000, staleRunMs: 60_000,
      } as never);
    };

    await exhaust(2_000);
    expect((await adapter.reviveFailed("I_1", "dependency release v2", 2_100)).accepted).toBeTrue();
    await exhaust(2_200);

    const writesBeforeDuplicate = transport.comments.get("I_1")!.length;
    const duplicate = await adapter.reviveFailed("I_1", "dependency release v2", 2_300);
    expect(duplicate).toMatchObject({ accepted: false, reason: "revival refused: change already used: dependency release v2" });
    expect(duplicate.snapshot.issue.state).toBe("failed");
    expect(transport.comments.get("I_1")!).toHaveLength(writesBeforeDuplicate);

    expect((await adapter.reviveFailed("I_1", "dependency release v3", 2_400)).accepted).toBeTrue();
    await exhaust(2_500);
    const bounded = await adapter.reviveFailed("I_1", "dependency release v4", 2_600);
    expect(bounded).toMatchObject({
      accepted: false,
      reason: "revival refused: configured limit of 2 reached; issue remains failed",
      snapshot: { issue: { state: "failed" } },
    });
  });

  test("supersession requires a successor and records cancelled work without inventing delivery", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const ready = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", ready.version, claim, 3_000);
    await adapter.markRunning(claim.fence, 3_100);
    await adapter.failClaim(claim.fence, "contract", "scope no longer belongs here", 3_200, workflow.config.scheduler);

    const writesBeforeRefusal = transport.comments.get("I_1")!.length;
    const missing = await adapter.supersedeFailed("I_1", "", 3_300);
    expect(missing).toMatchObject({ accepted: false, reason: "supersession refused: a successor reference is required" });
    expect(transport.comments.get("I_1")!).toHaveLength(writesBeforeRefusal);

    const superseded = await adapter.supersedeFailed("I_1", "acme/repo#99", 3_400);
    expect(superseded).toMatchObject({ accepted: true, snapshot: { issue: { state: "cancelled" } } });
    expect(superseded.snapshot.events.at(-1)).toMatchObject({
      kind: "supersession",
      successor: "acme/repo#99",
      message: "cancelled because work continued at acme/repo#99",
    });
    expect(superseded.snapshot.evidence.mergedAt).toBeUndefined();
    expect(superseded.snapshot.evidence.deploymentUrl).toBeUndefined();
    await expect(adapter.transition("I_1", "merged", 3_500)).rejects.toThrow("merged requires exact provider PR evidence");
  });

  test("closing a failed issue remains an owner decision and refuses later lifecycle rewrites", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const ready = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", ready.version, claim, 3_600);
    await adapter.markRunning(claim.fence, 3_700);
    await adapter.failClaim(claim.fence, "contract", "owner decision required", 3_800, workflow.config.scheduler);
    transport.issues[0]!.state = "CLOSED";

    const revival = await adapter.reviveFailed("I_1", "new dependency release", 3_900);
    const supersession = await adapter.supersedeFailed("I_1", "acme/repo#99", 3_900);
    expect(revival).toMatchObject({ accepted: false, reason: "revival refused: issue is closed" });
    expect(supersession).toMatchObject({ accepted: false, reason: "supersession refused: issue is closed" });
    expect(revival.snapshot).toMatchObject({ issue: { state: "failed", closed: true } });
  });

  test("provider merge evidence refuses both failed-work decisions because delivery owns the outcome", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const ready = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", ready.version, claim, 4_000);
    await adapter.markRunning(claim.fence, 4_100);
    await adapter.failClaim(claim.fence, "runtime", "attempt died", 4_200, {
      maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, claimTtlMs: 60_000, staleRunMs: 60_000,
    } as never);
    attachPr(transport, "I_1", true);
    transport.branches.delete("v4/acme-repo-1");

    const revival = await adapter.reviveFailed("I_1", "runner repaired", 4_300);
    const supersession = await adapter.supersedeFailed("I_1", "acme/repo#99", 4_300);
    expect(revival).toMatchObject({ accepted: false, reason: "revival refused: provider merge evidence already records delivery" });
    expect(supersession).toMatchObject({ accepted: false, reason: "supersession refused: provider merge evidence already records delivery" });
    expect(revival.snapshot.issue.state).toBe("failed");
    expect(revival.snapshot.evidence.mergeCommitSha).toBe("c".repeat(40));
  });

  test("a run that died before recording a branch still gets credit when its pull request merged", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);

    // The run dies before any branch evidence reaches the ledger.
    await adapter.failClaim(claim.fence, "runtime", "died before pushing", 1_200, {
      maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, claimTtlMs: 60_000, staleRunMs: 60_000,
    } as never);
    const failed = await adapter.get("I_1");
    expect(failed.issue.state).toBe("failed");
    expect(failed.evidence.branchSha).toBeUndefined();

    // Its pull request merged anyway, and the branch was deleted with the merge —
    // so there is no head commit to match, and none was ever recorded to match it
    // against. The deterministic branch name is derived from this issue.
    attachPr(transport, "I_1", true);
    transport.branches.delete("v4/acme-repo-1");

    await adapter.advanceByEvidence(1_300);
    expect((await adapter.get("I_1")).issue.state).toBe("done");
  });

  test("a branch updated from the base still counts as this attempt's work", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    attachPr(transport, "I_1");
    await adapter.advanceByEvidence(1_150);
    expect((await adapter.get("I_1")).evidence.branchSha).toBe("d".repeat(40));

    // The branch is updated from the base to pick up a fix that made CI pass, so
    // its head moves. The attempt's own commit is still in there — refusing this
    // is what left delivered work stranded in pr-open with a held WIP slot.
    attachPr(transport, "I_1", true);
    transport.branches.delete("v4/acme-repo-1");
    transport.prs.get("I_1")![0]!.headRefOid = "a".repeat(40);
    transport.descendants.set("a".repeat(40), new Set(["d".repeat(40)]));

    await adapter.advanceByEvidence(1_300);
    expect((await adapter.get("I_1")).issue.state).toBe("done");
  });

  test("a ledger branch SHA that disagrees with the pull request still refuses", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    attachPr(transport, "I_1");
    // The ledger now holds this attempt's branch SHA.
    await adapter.advanceByEvidence(1_150);
    expect((await adapter.get("I_1")).evidence.branchSha).toBe("d".repeat(40));

    attachPr(transport, "I_1", true);
    transport.branches.delete("v4/acme-repo-1");
    transport.prs.get("I_1")![0]!.headRefOid = "7".repeat(40);
    // Not a descendant: a different lineage, not this attempt's work grown.

    // A recorded SHA that disagrees is a different commit, not a missing one.
    expect(await adapter.advanceByEvidence(1_300)).toEqual([]);
    expect((await adapter.get("I_1")).issue.state).toBe("pr-open");
  });

  test("an issue closed by hand while in flight is recorded as cancelled", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);

    // Someone closes it. The lane can never dispatch a closed issue, so leaving
    // the label in flight leaves a badge that would never change again.
    transport.issues.find((issue) => issue.id === "I_1")!.state = "CLOSED";

    expect(await adapter.advanceByEvidence(1_200)).toEqual([
      { issueId: "I_1", action: "advanced", reason: "closed by hand without a merge" },
    ]);
    const settled = await adapter.get("I_1");
    expect(settled.issue.state).toBe("cancelled");
    // Cancelled, not done: nothing merged, so nothing was delivered.
    expect(settled.evidence.mergedAt).toBeUndefined();
    expect(settled.claim).toBeNull();
  });

  test("a closed issue whose work merged is recorded as delivered, not cancelled", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    attachPr(transport, "I_1");
    await adapter.advanceByEvidence(1_150);
    attachPr(transport, "I_1", true);
    transport.branches.delete("v4/acme-repo-1");
    transport.issues.find((issue) => issue.id === "I_1")!.state = "CLOSED";

    // Closed AND merged must take the delivery path, never the cancelled one.
    await adapter.advanceByEvidence(1_200);
    expect((await adapter.get("I_1")).issue.state).toBe("done");
  });

  test("a failed attempt with no merge stays failed", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    attachPr(transport, "I_1");
    await adapter.advanceByEvidence(1_150);
    await adapter.failClaim(claim.fence, "runtime", "attempt died", 1_200, {
      maxAttempts: 1, retryBaseMs: 1, retryMaxMs: 1, claimTtlMs: 60_000, staleRunMs: 60_000,
    } as never);

    // An open pull request is not delivery, and nothing may promote it.
    expect(await adapter.advanceByEvidence(1_300)).toEqual([]);
    expect((await adapter.get("I_1")).issue.state).toBe("failed");
  });

  test("a merged pull request still proves the merge after its base branch has moved on", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    attachPr(transport, "I_1");
    await adapter.advanceByEvidence(1_200);
    expect((await adapter.get("I_1")).issue.state).toBe("pr-open");

    attachPr(transport, "I_1", true);
    transport.branches.delete("v4/acme-repo-1");
    // The base ref's oid is the tip of the base branch, and it moves — this very
    // merge moves it, and so does anything landing after the claim. Comparing it
    // to the claim's base stranded Dirty-play/general#76 in pr-open with its work
    // already merged, holding the lane's only WIP slot against every later issue.
    transport.prs.get("I_1")![0]!.baseRefOid = "9".repeat(40);

    expect(await adapter.advanceByEvidence(1_300)).toEqual([
      { issueId: "I_1", action: "advanced", reason: "merge evidence" },
      { issueId: "I_1", action: "advanced", reason: "merge evidence with no deployment authority" },
    ]);
    const done = await adapter.get("I_1");
    expect(done.issue.state).toBe("done");
    expect(done.evidence.mergeCommitSha).toBe("c".repeat(40));
    // The claim is released, which is the point: the lane can take the next issue.
    expect(done.claim).toBeNull();
  });

  test("evidence from a pull request on a different commit is still refused", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    attachPr(transport, "I_1");
    await adapter.advanceByEvidence(1_200);

    attachPr(transport, "I_1", true);
    transport.branches.delete("v4/acme-repo-1");
    // Head commit identity is what pins the pull request to this attempt's work.
    // Dropping the moving base comparison must not loosen that.
    transport.prs.get("I_1")![0]!.headRefOid = "7".repeat(40);

    expect(await adapter.advanceByEvidence(1_300)).toEqual([]);
    expect((await adapter.get("I_1")).issue.state).toBe("pr-open");
  });

  test("ordinary reconcile advances running to done on durable evidence without a live session", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);

    expect(await adapter.advanceByEvidence(1_150)).toEqual([]);
    expect((await adapter.get("I_1")).issue.state).toBe("running");

    attachPr(transport, "I_1");
    expect(await adapter.advanceByEvidence(1_200)).toEqual([
      { issueId: "I_1", action: "advanced", reason: "pull request evidence" },
    ]);
    expect((await adapter.get("I_1")).issue.state).toBe("pr-open");

    attachPr(transport, "I_1", true);
    transport.branches.delete("v4/acme-repo-1");
    expect(await adapter.advanceByEvidence(1_300)).toEqual([
      { issueId: "I_1", action: "advanced", reason: "merge evidence" },
      { issueId: "I_1", action: "advanced", reason: "merge evidence with no deployment authority" },
    ]);

    const done = await adapter.get("I_1");
    expect(done.issue.state).toBe("done");
    expect(done.claim).toBeNull();
    expect(done.evidence.mergeCommitSha).toBe("c".repeat(40));
    expect(await adapter.activeClaims()).toEqual([]);
    expect(transport.comments.get("FENCE")!.at(-1)!.body).toContain("\"operation\":\"release\"");
  });

  test("evidence advancement is idempotent and terminal once the ledger settles", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    attachPr(transport, "I_1", true);

    expect(await adapter.advanceByEvidence(1_200)).toHaveLength(3);
    const settled = await adapter.get("I_1");
    expect(settled.issue.state).toBe("done");

    expect(await adapter.advanceByEvidence(1_300)).toEqual([]);
    const again = await adapter.get("I_1");
    expect(again.version).toBe(settled.version);
    expect(transport.comments.get("I_1")).toHaveLength(settled.events.length - 1);
  });

  test("owner gate preserves and validates the exact immutable Gate field ID", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "pr-open");
    attachPr(transport, "I_1");
    const gated = await adapter.transition("I_1", "owner-gate", 2_000, {
      evidence: { prUrl: "https://github.test/acme/repo/pull/1", ownerGateId: "GATE-I_1-7" },
    });
    expect(gated.evidence.ownerGateId).toBe("GATE-I_1-7");
    expect((transport.fields.get("ITEM_1")![1] as { value: string | null }).value).toBe("GATE-I_1-7");

    (transport.fields.get("ITEM_1")![1] as { value: string | null }).value = "gate-i_1-7";
    await expect(adapter.get("I_1")).rejects.toThrow("does not exactly match GATE-I_1-7");
  });

  test("claimless active projections are reported as orphaned rather than adopted", async () => {
    const diagnostics: string[] = [];
    const transport = new MemoryGitHubTransport();
    transport.branches.set("main", { name: "main", url: "https://github.test/acme/repo/tree/main", oid: "b".repeat(40) });
    transport.comments.set("FENCE", []);
    const adapter = new GitHubIssuesProjectsAdapter(config("FENCE", ["FENCE"], (message) => diagnostics.push(message)), transport, new MemoryWorkspaceTruth());
    transport.addIssue(1, "running");

    expect(await adapter.activeClaims()).toEqual([]);
    expect(diagnostics).toEqual([
      "orphaned active claim projection acme/repo#1: state running has no durable claim binding",
    ]);
  });

  test("ambiguous filesystem truth transitions a running claim to preservation-unknown", async () => {
    const { transport, truth, adapter } = setup();
    transport.addIssue(1);
    const before = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", before.version, claim, 1_000);
    await adapter.markRunning(claim.fence, 1_100);
    truth.values.set(claim.fence, { kind: "ambiguous", reason: "dirty/shared/unpushed state cannot be proved" });

    const result = await adapter.reconcileStartup(1_200);
    const preserved = await adapter.get("I_1");
    expect(result[0]).toEqual({ issueId: "I_1", action: "preservation-unknown", reason: "dirty/shared/unpushed state cannot be proved" });
    expect(preserved.issue.state).toBe("preservation-unknown");
    expect(preserved.claim).toBeNull();
  });

  test("adapter integration smoke reaches done using only injected GitHub and filesystem boundaries", async () => {
    const { transport, truth, adapter } = setup();
    transport.addIssue(1);
    const ready = await adapter.get("I_1");
    const claim = await proposedClaim(adapter, "I_1");
    await adapter.tryClaim("I_1", ready.version, claim, 3_000);
    await adapter.markRunning(claim.fence, 3_100);
    truth.values.set(claim.fence, { kind: "bound", binding: claim });
    attachPr(transport, "I_1");
    await adapter.reconcileStartup(3_200);
    await adapter.transition("I_1", "review", 3_300, { fence: claim.fence, message: "focused review complete" });
    attachPr(transport, "I_1", true);
    await adapter.reconcileStartup(3_400);
    const done = await adapter.transition("I_1", "done", 3_500, { fence: claim.fence, message: "workflow evidence complete" });

    expect(done.issue.state).toBe("done");
    expect(done.claim).toBeNull();
    expect(done.evidence.prUrl).toBe("https://github.test/acme/repo/pull/1");
    expect(transport.comments.get("I_1")).toHaveLength(6);
  });
});

describe("lane-scoped WIP and reconciliation", () => {
  function lanes(onDiagnostic?: (message: string) => void) {
    const transport = new MemoryGitHubTransport();
    transport.branches.set("main", { name: "main", url: "https://github.test/acme/repo/tree/main", oid: "b".repeat(40) });
    transport.comments.set("FENCE_A", []);
    transport.comments.set("FENCE_B", []);
    const truth = new MemoryWorkspaceTruth();
    const fences = ["FENCE_A", "FENCE_B"];
    return {
      transport,
      truth,
      laneA: new GitHubIssuesProjectsAdapter(config("FENCE_A", fences, onDiagnostic), transport, truth),
      laneB: new GitHubIssuesProjectsAdapter(config("FENCE_B", fences, onDiagnostic), transport, truth),
    };
  }

  test("WIP counts only the claim held on this lane's own fence", async () => {
    const { transport, laneA, laneB } = lanes();
    transport.addIssue(1);
    transport.addIssue(2);
    const first = await laneA.get("I_1");
    const claimA = await proposedClaim(laneA, "I_1");
    expect(await laneA.tryClaim("I_1", first.version, claimA, 1_000)).not.toBeNull();

    expect((await laneA.activeClaims()).map((entry) => entry.issue.id)).toEqual(["I_1"]);
    expect(await laneB.activeClaims()).toEqual([]);

    const second = await laneB.get("I_2");
    const claimB = await proposedClaim(laneB, "I_2");
    expect(await laneB.tryClaim("I_2", second.version, claimB, 1_000)).not.toBeNull();
    expect((await laneB.activeClaims()).map((entry) => entry.issue.id)).toEqual(["I_2"]);
  });

  test("startup and ordinary reconciliation leave a foreign claim completely untouched", async () => {
    const { transport, laneA, laneB } = lanes();
    transport.addIssue(1);
    const ready = await laneA.get("I_1");
    const claim = await proposedClaim(laneA, "I_1");
    await laneA.tryClaim("I_1", ready.version, claim, 1_000);
    await laneA.markRunning(claim.fence, 1_100);
    const issueComments = structuredClone(transport.comments.get("I_1"));
    const fenceComments = structuredClone(transport.comments.get("FENCE_A"));
    let craftReads = 0;
    const scheduler = new DeterministicScheduler(
      config("FENCE_B", ["FENCE_A", "FENCE_B"]).workflow,
      {
        github: laneB,
        craft: {
          ensure: async () => { throw new Error("foreign session must not start"); },
          get: async () => { craftReads += 1; return null; },
        },
        workspaces: { ensure: async () => { throw new Error("foreign workspace must not start"); } },
      },
      new ManualClock(1_000_000),
    );

    await scheduler.tick();

    expect(craftReads).toBe(0);
    expect(await laneB.activeClaims()).toEqual([]);
    expect((await laneA.get("I_1")).issue.state).toBe("running");
    expect(transport.comments.get("I_1")).toEqual(issueComments);
    expect(transport.comments.get("FENCE_A")).toEqual(fenceComments);
    expect(transport.comments.get("FENCE_B")).toEqual([]);
  });

  test("two lanes racing the same issue leave one claim there and the loser claims the next candidate", async () => {
    const { transport, laneA, laneB } = lanes();
    transport.addIssue(1);
    transport.addIssue(2);
    const craft = new FakeCraftAdapter();
    const workspaces = new FakeWorkspaceAdapter();
    const starts: { issueId: string; workspacePath: string; branch: string }[] = [];
    const workspaceAdapter = {
      ensure: async (identity: Parameters<FakeWorkspaceAdapter["ensure"]>[0], context?: { contract: { requiredBranch: string } }) => {
        starts.push({ issueId: identity.issueId, workspacePath: identity.workspacePath, branch: context!.contract.requiredBranch });
        return workspaces.ensure(identity);
      },
    };
    const clock = new ManualClock(1_000);
    const workflowConfig = config("FENCE_A", ["FENCE_A", "FENCE_B"]).workflow;
    const schedulerA = new DeterministicScheduler(workflowConfig, { github: laneA, craft, workspaces: workspaceAdapter }, clock);
    const schedulerB = new DeterministicScheduler(workflowConfig, { github: laneB, craft, workspaces: workspaceAdapter }, clock);

    await Promise.all([schedulerA.tick(), schedulerB.tick()]);

    const snapshots = await laneA.fetchIssuesByStates(["running"]);
    expect(snapshots.map((entry) => entry.issue.id).sort()).toEqual(["I_1", "I_2"]);
    expect(snapshots.map((entry) => entry.claim?.attempt)).toEqual([1, 1]);
    expect(snapshots.map((entry) => entry.events.filter((event) => event.kind === "claim").length)).toEqual([1, 1]);
    expect((await laneA.activeClaims()).length + (await laneB.activeClaims()).length).toBe(2);
    expect(new Set(starts.map((start) => start.workspacePath)).size).toBe(2);
    expect(new Set(starts.map((start) => start.branch)).size).toBe(2);
  });

  test("a claim held by no configured lane fence is reported and never adopted", async () => {
    const diagnostics: string[] = [];
    const transport = new MemoryGitHubTransport();
    transport.branches.set("main", { name: "main", url: "https://github.test/acme/repo/tree/main", oid: "b".repeat(40) });
    transport.comments.set("FENCE_OLD", []);
    transport.comments.set("FENCE_A", []);
    transport.comments.set("FENCE_B", []);
    const truth = new MemoryWorkspaceTruth();
    const oldLane = new GitHubIssuesProjectsAdapter(config("FENCE_OLD"), transport, truth);
    transport.addIssue(1);
    const ready = await oldLane.get("I_1");
    const claim = await proposedClaim(oldLane, "I_1");
    await oldLane.tryClaim("I_1", ready.version, claim, 1_000);
    await oldLane.markRunning(claim.fence, 1_100);
    const currentLane = new GitHubIssuesProjectsAdapter(
      config("FENCE_A", ["FENCE_A", "FENCE_B"], (message) => diagnostics.push(message)),
      transport,
      truth,
    );
    const issueComments = structuredClone(transport.comments.get("I_1"));

    expect(await currentLane.activeClaims()).toEqual([]);
    expect(diagnostics).toEqual([
      `orphaned claim acme/repo#1 (${claim.fence}) is held by no configured lane fence`,
    ]);
    expect(transport.comments.get("I_1")).toEqual(issueComments);
  });
});

describe("strict load tolerance for contract-less issues", () => {
  test("a labeled tracker issue without a contract no longer breaks strict repo-wide loads", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    // A tracking/plain issue: matching repo, no YAML contract, NO lifecycle label.
    transport.issues.push({
      id: "I_TRACKER",
      number: 99,
      title: "Tracking issue",
      body: "```yaml\nid: TRACKER\ngoal: track things\n```",
      url: "https://github.test/acme/repo/issues/99",
      state: "OPEN",
      createdAt: "2026-08-19T10:00:00Z",
      updatedAt: "2026-08-19T10:00:00Z",
      assigneeId: null,
    });
    transport.labels.set("I_TRACKER", ["v4"]);
    transport.comments.set("I_TRACKER", []);

    // Strict paths (activeClaims drives shadow/tick) skip the tracker instead of failing.
    await expect(adapter.activeClaims()).resolves.toEqual([]);
    const ready = await adapter.fetchIssuesByStates(["ready"]);
    expect(ready.map((entry) => entry.issue.id)).toEqual(["I_1"]);
  });

  test("a malformed issue that carries a lifecycle label still fails closed", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1);
    transport.issues.push({
      id: "I_BAD",
      number: 98,
      title: "Broken contract on a lifecycle-labeled issue",
      body: "no contract at all",
      url: "https://github.test/acme/repo/issues/98",
      state: "OPEN",
      createdAt: "2026-08-19T10:00:00Z",
      updatedAt: "2026-08-19T10:00:00Z",
      assigneeId: null,
    });
    transport.labels.set("I_BAD", ["v4", "state:running"]);
    transport.comments.set("I_BAD", []);

    await expect(adapter.activeClaims()).rejects.toThrow();
  });
});
