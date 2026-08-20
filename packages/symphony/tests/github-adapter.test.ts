// SPDX-License-Identifier: Apache-2.0

import { beforeAll, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  GitHubIssuesProjectsAdapter,
  IdentityFactory,
  lifecycleStates,
  loadWorkflow,
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
  async inspect(claim: Claim): Promise<WorkspaceTruth> {
    return structuredClone(this.values.get(claim.fence) ?? { kind: "absent" });
  }
}

class MemoryGitHubTransport implements GitHubTransport {
  readonly issues: GitHubIssueRecord[] = [];
  readonly labels = new Map<string, string[]>();
  readonly blockers = new Map<string, GitHubIssueLink[]>();
  readonly items = new Map<string, GitHubProjectItem[]>();
  readonly fields = new Map<string, GitHubProjectFieldValue[]>();
  readonly comments = new Map<string, GitHubComment[]>();
  readonly prs = new Map<string, GitHubPullRequestEvidence[]>();
  readonly branches = new Map<string, GitHubBranchEvidence>();
  readonly calls = new Map<string, number>();
  pageSize = 100;
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

  listIssues(_repository: string, cursor: string | null): Promise<Page<GitHubIssueRecord>> {
    return Promise.resolve(this.paged("issues", this.issues, cursor));
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

function config(): GitHubAdapterConfig {
  const states = Object.fromEntries(lifecycleStates.map((state) => [state, {
    label: `state:${state}`,
    projectStatusOptionId: `opt-${state}`,
  }])) as Record<LifecycleState, { label: string; projectStatusOptionId: string }>;
  return {
    repository: "acme/repo",
    projectId: "PROJECT",
    claimFenceIssueId: "FENCE",
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

  test("claimless active projections fail closed instead of releasing scheduler WIP", async () => {
    const { transport, adapter } = setup();
    transport.addIssue(1, "running");

    await expect(adapter.activeClaims()).rejects.toThrow("lacks a durable claim binding");
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
