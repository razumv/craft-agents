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
  type GitHubProjectFieldValue,
  type GitHubProjectItem,
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
  async containsCommit(): Promise<boolean> {
    return true;
  }

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
  listFailedCheckDetails(): Promise<never[]> { return this.read("listFailedCheckDetails", []).then((page) => page.nodes); }
  getBranch(): Promise<null> { this.calls.push("getBranch"); return Promise.resolve(null); }
  getBaseSha(): Promise<string> { this.calls.push("getBaseSha"); return Promise.resolve("b".repeat(40)); }
  mergePullRequest(): Promise<void> { return Promise.resolve(this.write("mergePullRequest")); }
  appendComment(): Promise<GitHubComment> { return Promise.resolve(this.write("appendComment")); }
  updateIssueBody(): Promise<boolean> { return Promise.resolve(this.write("updateIssueBody")); }
  replaceLabels(): Promise<void> { return Promise.resolve(this.write("replaceLabels")); }
  updateProjectSingleSelect(): Promise<void> { return Promise.resolve(this.write("updateProjectSingleSelect")); }
  updateProjectText(): Promise<void> { return Promise.resolve(this.write("updateProjectText")); }
}

class ApplyingTransport implements GitHubTransport {
  readonly calls: string[] = [];
  readonly comments: string[] = [];
  labels: string[];
  statusOptionId = "option:backlog";
  failAt: "baseline" | "body" | "conflict" | "readback" | "attribution" | "status" | "label" | null = null;
  private nodeReads = 0;

  constructor(readonly record: GitHubIssueRecord) {
    this.labels = [...(record.labelNames ?? [])];
  }

  private page<T>(nodes: T[]): Promise<Page<T>> { return Promise.resolve({ nodes, nextCursor: null }); }
  listIssues(): Promise<Page<GitHubIssueRecord>> {
    return this.page([{ ...this.record, labelNames: [...this.labels] }]);
  }
  getIssuesByNodeIds(): Promise<(GitHubIssueRecord | null)[]> {
    this.calls.push("read-body");
    this.nodeReads += 1;
    if (this.failAt === "readback" && this.nodeReads === 2) return Promise.resolve([{ ...this.record, body: "corrupted readback" }]);
    return Promise.resolve([structuredClone(this.record)]);
  }
  listLabels(): Promise<Page<string>> { this.calls.push("read-labels"); return this.page([...this.labels]); }
  listBlockedBy(): Promise<Page<GitHubIssueLink>> { return this.page([]); }
  listProjectItems(): Promise<Page<GitHubProjectItem>> {
    this.calls.push("read-project-item");
    return this.page([{ id: "ITEM", projectId: "PROJECT" }]);
  }
  listProjectFieldValues(): Promise<Page<GitHubProjectFieldValue>> {
    return this.page([{ kind: "single-select", fieldId: "STATUS", fieldName: "Status", optionId: this.statusOptionId, value: null }]);
  }
  listComments(): Promise<Page<GitHubComment>> { return this.page([]); }
  listClosingPullRequests(): Promise<Page<never>> { return this.page([]); }
  listFailedCheckDetails(): Promise<never[]> { return Promise.resolve([]); }
  getBranch(): Promise<null> { return Promise.resolve(null); }
  getBaseSha(): Promise<string> {
    this.calls.push("read-baseline");
    if (this.failAt === "baseline") return Promise.reject(new Error("baseline unreadable"));
    return Promise.resolve("b".repeat(40));
  }
  containsCommit(): Promise<boolean> { return Promise.resolve(true); }
  mergePullRequest(): Promise<void> { return Promise.resolve(); }
  async updateIssueBody(_repository: string, _number: number, body: string, expectedUpdatedAt: string): Promise<boolean> {
    this.calls.push(`WRITE:body:${expectedUpdatedAt}`);
    if (this.failAt === "body") throw new Error("body failed");
    if (this.failAt === "conflict") {
      this.labels.push("state:blocked");
      return false;
    }
    this.record.body = body;
    return true;
  }
  async appendComment(_issueId: string, body: string): Promise<GitHubComment> {
    this.calls.push("WRITE:attribution");
    if (this.failAt === "attribution") throw new Error("attribution failed");
    this.comments.push(body);
    return { databaseId: 1, body, authorLogin: "bot", createdAt: "2026-08-21T00:00:00Z", updatedAt: "2026-08-21T00:00:00Z" };
  }
  async updateProjectSingleSelect(_projectId: string, _itemId: string, _fieldId: string, optionId: string): Promise<void> {
    this.calls.push(`WRITE:status:${optionId}`);
    if (this.failAt === "status") throw new Error("status failed");
    this.statusOptionId = optionId;
  }
  async replaceLabels(_repository: string, _number: number, labels: readonly string[]): Promise<void> {
    this.calls.push("WRITE:label");
    if (this.failAt === "label") throw new Error("label failed");
    this.labels = [...labels];
  }
  updateProjectText(): Promise<void> { return Promise.resolve(); }
}

function applyingAdapter(candidate: TrackerBacklogIssue, transport?: ApplyingTransport): [GitHubIssuesProjectsAdapter, ApplyingTransport] {
  const record: GitHubIssueRecord = {
    id: candidate.id, number: candidate.number, title: candidate.title, body: candidate.description, url: candidate.url!,
    state: "OPEN", createdAt: candidate.createdAt!, updatedAt: candidate.updatedAt!, assigneeId: null, labelNames: candidate.labels,
  };
  const mutable = transport ?? new ApplyingTransport(record);
  return [new GitHubIssuesProjectsAdapter(
    adapterConfig(), mutable, { inspect: async () => ({ kind: "absent" as const }) } as WorkspaceTruthReader,
  ), mutable];
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

describe("grooming apply", () => {
  test("a refusal performs no tracker read or write", async () => {
    const refused = proposal(issue({ description: "## Acceptance Criteria\n- Improve it better.\n\n## Non-goals\n- Writes." }));
    expect(refused.outcome).toBe("refused");
    const [adapter, transport] = applyingAdapter(issue());

    const report = await adapter.applyGrooming(refused);

    expect(report).toMatchObject({ outcome: "refused", writes: 0 });
    expect(transport.calls).toEqual([]);
  });

  test("an existing parser-valid contract is never overwritten", async () => {
    const proposed = proposal();
    if (proposed.outcome !== "proposed") throw new Error("fixture must propose");
    const [adapter, transport] = applyingAdapter(proposed.candidate);
    transport.record.body = proposed.contractMarkdown;

    const report = await adapter.applyGrooming(proposed);

    expect(report).toEqual({ outcome: "already-present", writes: 0, issueIdentifier: "acme/repo#1" });
    expect(transport.calls.filter((call) => call.startsWith("WRITE:"))).toEqual([]);
    expect(transport.record.body).toBe(proposed.contractMarkdown);
  });

  test("writes verified body, attribution, configured ready status, and label; a second apply is a no-op", async () => {
    const proposed = proposal();
    if (proposed.outcome !== "proposed") throw new Error("fixture must propose");
    const [adapter, transport] = applyingAdapter(proposed.candidate);
    const configuredReadyOption = adapterConfig().states.ready.projectStatusOptionId;

    const first = await adapter.applyGrooming(proposed);
    const second = await adapter.applyGrooming(proposed);

    expect(first).toEqual({ outcome: "applied", writes: 4, issueIdentifier: "acme/repo#1", baselineSha: "b".repeat(40) });
    expect(second).toEqual({ outcome: "already-present", writes: 0, issueIdentifier: "acme/repo#1" });
    expect(parseIssueContract(transport.record.body, proposed.candidate.identifier, workflow)).toEqual(proposed.contract);
    expect(transport.record.body).toStartWith(proposed.candidate.description);
    expect(transport.statusOptionId).toBe(configuredReadyOption);
    expect(transport.labels).toEqual(["enhancement", adapterConfig().states.ready.label]);
    expect(transport.comments).toEqual([
      `Contract authored by Symphony grooming from backlog issue acme/repo#1 against repository acme/repo baseline ${"b".repeat(40)}.`,
    ]);
    expect(transport.calls.filter((call) => call.startsWith("WRITE:"))).toEqual([
      `WRITE:body:${proposed.candidate.updatedAt}`, "WRITE:attribution", `WRITE:status:${configuredReadyOption}`, "WRITE:label",
    ]);
  });

  test("a concurrent lifecycle mutation loses the body compare-and-set and is not overwritten", async () => {
    const proposed = proposal();
    if (proposed.outcome !== "proposed") throw new Error("fixture must propose");
    const [adapter, transport] = applyingAdapter(proposed.candidate);
    transport.failAt = "conflict";

    const report = await adapter.applyGrooming(proposed);

    expect(report).toMatchObject({ outcome: "failed", step: "body", writes: 0, error: "grooming body compare-and-set conflict" });
    expect(transport.record.body).toBe(proposed.candidate.description);
    expect(transport.labels).toContain(adapterConfig().states.blocked.label);
    expect(transport.calls.filter((call) => call.startsWith("WRITE:"))).toEqual([
      `WRITE:body:${proposed.candidate.updatedAt}`,
    ]);
  });

  test("an issue carrying any lifecycle label is untouched", async () => {
    const proposed = proposal();
    if (proposed.outcome !== "proposed") throw new Error("fixture must propose");
    const candidate = { ...proposed.candidate, labels: ["enhancement", adapterConfig().states.blocked.label] };
    const [adapter, transport] = applyingAdapter(candidate);

    const report = await adapter.applyGrooming(proposed);

    expect(report).toMatchObject({ outcome: "lifecycle-present", writes: 0 });
    expect(transport.calls.filter((call) => call.startsWith("WRITE:"))).toEqual([]);
  });

  test("an unreadable repository baseline is skipped before any grooming write", async () => {
    const proposed = proposal();
    if (proposed.outcome !== "proposed") throw new Error("fixture must propose");
    const [adapter, transport] = applyingAdapter(proposed.candidate);
    transport.failAt = "baseline";

    const report = await adapter.applyGrooming(proposed);

    expect(report).toMatchObject({ outcome: "failed", step: "preflight", writes: 0, error: "baseline unreadable" });
    expect(transport.calls.filter((call) => call.startsWith("WRITE:"))).toEqual([]);
    expect(transport.record.body).toBe(proposed.candidate.description);
  });

  test("every failed write is named and the issue is never labelled claimable", async () => {
    const proposed = proposal();
    if (proposed.outcome !== "proposed") throw new Error("fixture must propose");
    const cases = [
      ["body", 0], ["readback", 1], ["attribution", 1], ["status", 2], ["label", 3],
    ] as const;
    for (const [step, writes] of cases) {
      const [adapter, transport] = applyingAdapter(proposed.candidate);
      transport.failAt = step;

      const report = await adapter.applyGrooming(proposed);

      expect(report).toMatchObject({ outcome: "failed", step, writes });
      expect(transport.labels).not.toContain(adapterConfig().states.ready.label);
      if (step !== "body") expect(parseIssueContract(transport.record.body, proposed.candidate.identifier, workflow)).toEqual(proposed.contract);
      expect((await adapter.fetchBacklog()).map((entry) => entry.identifier)).toEqual([proposed.candidate.identifier]);
    }
  });
});

describe("autonomous idle-lane grooming", () => {
  function autonomousRunner(options: {
    backlog?: TrackerBacklogIssue[];
    active?: boolean;
    ready?: boolean;
    apply?: (candidate: TrackerBacklogIssue) => Promise<unknown>;
    calls?: string[];
    diagnostics?: string[];
  } = {}) {
    const calls = options.calls ?? [];
    const diagnostics = options.diagnostics ?? [];
    const tracker = {
      activeClaims: async () => options.active ? [{}] : [],
      fetchIssuesByStates: async (states: readonly LifecycleState[]) => {
        if (states.length === 1 && states[0] === "ready") return options.ready ? [{}] : [];
        return [];
      },
      fetchBacklog: async () => options.backlog ?? [],
      applyGrooming: async (candidateProposal: ReturnType<typeof proposeBacklogGrooming>) => {
        calls.push(`apply:${candidateProposal.candidate?.identifier}`);
        if (candidateProposal.candidate) await options.apply?.(candidateProposal.candidate);
        return { outcome: "applied", writes: 4, issueIdentifier: candidateProposal.candidate?.identifier, baselineSha: "b".repeat(40) };
      },
    } as unknown as GitHubIssuesProjectsAdapter;
    const scheduler = {
      tick: async () => { calls.push("dispatch"); },
    } as unknown as DeterministicScheduler;
    return {
      calls,
      diagnostics,
      runner: new LiveV4Runner(
        { mode: "discovery", github: { repository: "acme/repo", states: adapterConfig().states } } as LiveRunnerConfig,
        workflow,
        tracker,
        {
          pollOwnerDesk: async () => ({
            directives: [], refusals: [], providerReadCalls: 4 as const, providerWriteCalls: 0 as const,
          }),
        } as unknown as CraftMobileControlPlaneAdapter,
        {} as CraftCliRpcTransport,
        scheduler,
        undefined,
        undefined,
        undefined,
        (message) => diagnostics.push(message),
      ),
    };
  }

  test("dispatch runs first and claimable work prevents grooming", async () => {
    const { runner, calls } = autonomousRunner({ active: true, backlog: [issue()] });

    await runner.tick();

    expect(calls).toEqual(["dispatch"]);
  });

  test("several eligible candidates still apply exactly one proposal per cycle", async () => {
    const candidates = [
      issue({ id: "I_3", identifier: "acme/repo#3", number: 3, priority: 3 }),
      issue({ id: "I_1", identifier: "acme/repo#1", number: 1, priority: 1 }),
      issue({ id: "I_2", identifier: "acme/repo#2", number: 2, priority: 2 }),
    ];
    const { runner, calls } = autonomousRunner({ backlog: candidates });

    await runner.tick();

    expect(calls).toEqual(["dispatch", "apply:acme/repo#1"]);
  });

  test("a refusal is attempted once until that exact issue revision changes", async () => {
    const candidate = issue({
      updatedAt: "2026-08-02T00:00:00Z",
      description: "## Acceptance Criteria\n- Improve it better.\n\n## Non-goals\n- Writes.",
    });
    const { runner, calls, diagnostics } = autonomousRunner({ backlog: [candidate] });

    await runner.tick();
    await runner.tick();

    expect(calls).toEqual(["dispatch", "dispatch"]);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]).toContain("grooming refused acme/repo#1");

    candidate.updatedAt = "2026-08-03T00:00:00Z";
    await runner.tick();
    expect(diagnostics).toHaveLength(2);
  });

  test("a grooming exception is logged but does not fail the scheduler tick", async () => {
    const { runner, calls, diagnostics } = autonomousRunner({
      backlog: [issue()],
      apply: async () => { throw new Error("grooming exploded"); },
    });

    await expect(runner.tick()).resolves.toMatchObject({ statuses: [], backlog: expect.any(Array) });
    expect(calls).toEqual(["dispatch", "apply:acme/repo#1"]);
    expect(diagnostics).toEqual(["grooming failed before apply: grooming exploded"]);
  });
});

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
