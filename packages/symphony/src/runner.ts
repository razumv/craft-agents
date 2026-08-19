// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { CraftExecutionSession, CraftRpcSession, ProjectDeskReadback } from "./craft-adapter";
import { CraftMobileControlPlaneAdapter } from "./craft-adapter";
import { CraftCliRpcTransport, type CraftCliTransportConfig } from "./craft-transport";
import type { LifecycleState, ProjectStatus, TrackerIssueSnapshot, WorkflowConfig } from "./domain";
import { GitHubIssuesProjectsAdapter, type GitHubStateProjection } from "./github-adapter";
import {
  GhCliTransport,
  type GitHubBranchEvidence,
  type GitHubComment,
  type GitHubIssueLink,
  type GitHubIssueRecord,
  type GitHubProjectFieldValue,
  type GitHubProjectItem,
  type GitHubPullRequestEvidence,
  type GitHubTransport,
  type Page,
} from "./github-transport";
import { DeterministicScheduler, type Clock, type CrashPoint, type ShadowProposal } from "./scheduler";
import { projectStatus } from "./status";
import { loadWorkflow } from "./workflow";
import { GitWorktreeAdapter } from "./workspace-adapter";
import { FilesystemWorkspaceTruthReader } from "./workspace-truth";

export interface LiveRunnerConfig {
  workflowPath: string;
  repositoryRoot: string;
  workspaceRoot: string;
  issueId: string;
  issueNumber: number;
  projectItemId: string;
  claimFenceIssueId: string;
  verificationBudget: string;
  github: {
    executable: string;
    repository: string;
    eventAuthorLogin: string;
    projectId: string;
    statusFieldId: string;
    gateFieldId: string;
    requiredLabels: string[];
    states: Record<LifecycleState, GitHubStateProjection>;
  };
  git: { executable: string };
  craft: {
    workspaceId: string;
    projectId: string;
    projectWorkingDirectory: string;
    ownerSessionId: string;
    repositoryInstructions: string;
    issueLabelId: string;
    runLabelId: string;
    promptLabelId: string;
    cli: CraftCliTransportConfig;
    deadlines: {
      rpcMs: number;
      turnMs: number;
      cancelMs: number;
      pollMs: number;
      maxContextTokens: number;
    };
    maxHandoffChars: number;
  };
}

export interface LiveRunnerStatus {
  snapshot: TrackerIssueSnapshot;
  status: ProjectStatus;
  execution: CraftExecutionSession | null;
}

export const SHADOW_RECEIPT_SCHEMA = "craft-agent/symphony-shadow@1" as const;

export interface LiveShadowReceipt {
  /** Explicit schema identifier for the public receipt shape. */
  schema: typeof SHADOW_RECEIPT_SCHEMA;
  /** Explicit public projection: no issue body, messages, or final response. */
  projectDesk: ProjectDeskReadback;
  proposal: ShadowProposal;
  writes: 0;
  /** SHA-256 over every public receipt field except this hash itself. */
  receiptHash: string;
}

class SystemClock implements Clock {
  nowMs(): number { return Date.now(); }
}

/** One explicitly scoped live composition. No provider is touched until a method is called. */
export class LiveV4Runner {
  constructor(
    readonly config: LiveRunnerConfig,
    readonly workflow: WorkflowConfig,
    readonly tracker: GitHubIssuesProjectsAdapter,
    readonly craft: CraftMobileControlPlaneAdapter,
    readonly craftTransport: CraftCliRpcTransport,
    readonly scheduler: DeterministicScheduler,
    readonly workspaces?: GitWorktreeAdapter,
  ) {}

  async preflight(): Promise<{
    runtime: Awaited<ReturnType<CraftCliRpcTransport["identity"]>>;
    issue: TrackerIssueSnapshot;
    projectId: string;
    workspace: Awaited<ReturnType<GitWorktreeAdapter["preflight"]>> | null;
  }> {
    const [runtime, workspace] = await Promise.all([
      this.craftTransport.identity(this.config.craft.cli.rpcDeadlineMs),
      this.workspaces?.preflight() ?? Promise.resolve(null),
    ]);
    const project = await this.craftTransport.invoke<{ config?: { id?: string; workingDirectory?: string } } | null>(
      "projects:getOne",
      [this.config.craft.workspaceId, this.config.craft.projectId],
      this.config.craft.deadlines.rpcMs,
    );
    if (
      !project
      || project.config?.id !== this.config.craft.projectId
      || project.config?.workingDirectory !== this.config.craft.projectWorkingDirectory
    ) throw new Error("dedicated Craft Protocol project preflight failed exact readback");
    const issue = await this.tracker.get(this.config.issueId);
    return { runtime, issue, projectId: project.config.id, workspace };
  }

  async tick(crashAfter?: CrashPoint): Promise<LiveRunnerStatus> {
    await this.scheduler.tick(crashAfter);
    return this.readStatus();
  }

  async readStatus(): Promise<LiveRunnerStatus> {
    const snapshot = await this.tracker.get(this.config.issueId);
    const execution = snapshot.claim ? await this.craft.get(snapshot.claim.sessionId) : null;
    return { snapshot, status: projectStatus(snapshot), execution };
  }

  async projectDesk(): Promise<ProjectDeskReadback> {
    const status = await this.readStatus();
    return this.craft.readProjectDesk({ status: status.status, activeRun: status.execution });
  }

  async shadow(): Promise<LiveShadowReceipt> {
    const status = await this.readStatus();
    const [projectDesk, proposal] = await Promise.all([
      this.craft.readProjectDesk({ status: status.status, activeRun: status.execution }),
      this.scheduler.preview(this.config.issueId),
    ]);
    const payload = { schema: SHADOW_RECEIPT_SCHEMA, projectDesk, proposal, writes: 0 as const };
    return {
      ...payload,
      receiptHash: createHash("sha256").update(canonicalJson(payload)).digest("hex"),
    };
  }

  async project(): Promise<{ notes: string; status: LiveRunnerStatus }> {
    const status = await this.readStatus();
    const notes = await this.craft.projectToDesk({
      status: status.status,
      activeRun: status.execution,
      latestAcknowledgement: null,
    });
    return { notes, status };
  }

  async transitionToPrOpen(): Promise<LiveRunnerStatus> {
    const before = await this.tracker.get(this.config.issueId);
    if (!before.claim) throw new Error("Issue has no active claim for PR transition");
    if (before.issue.state !== "running" && before.issue.state !== "pr-open") {
      throw new Error(`Issue cannot enter pr-open from ${before.issue.state}`);
    }
    if (before.issue.state === "running") {
      const execution = await this.craft.get(before.claim.sessionId);
      if (!execution || execution.status !== "settled") {
        throw new Error("Craft execution must have true settled readback before PR transition");
      }
      await this.tracker.transition(before.issue.id, "pr-open", Date.now(), {
        fence: before.claim.fence,
        message: "exact GitHub pull request evidence observed after true Craft settlement",
      });
    }
    return this.readStatus();
  }

  async archiveExecution(): Promise<{ rpcSessionId: string; commandResult: unknown; readback: Record<string, unknown> }> {
    const status = await this.readStatus();
    if (!status.execution || status.execution.status !== "settled") {
      throw new Error("execution session must have true settled readback before archive");
    }
    await this.craftTransport.identity(this.config.craft.cli.rpcDeadlineMs);
    let sessions = await this.craftTransport.invoke<CraftRpcSession[]>("sessions:get", [], this.config.craft.deadlines.rpcMs);
    let exact = sessions.filter((session) => session.id === status.execution!.rpcSessionId);
    if (exact.length !== 1) throw new Error("execution session exact readback is absent or ambiguous before archive");
    let readback = exact[0] as CraftRpcSession & Record<string, unknown>;
    if (readback.isArchived === true && !readback.isProcessing) {
      return { rpcSessionId: status.execution.rpcSessionId, commandResult: "already-archived", readback };
    }
    const commandResult = await this.craftTransport.invoke(
      "sessions:command",
      [status.execution.rpcSessionId, { type: "archive" }],
      this.config.craft.deadlines.rpcMs,
    );
    sessions = await this.craftTransport.invoke<CraftRpcSession[]>("sessions:get", [], this.config.craft.deadlines.rpcMs);
    exact = sessions.filter((session) => session.id === status.execution!.rpcSessionId);
    if (exact.length !== 1) throw new Error("archived execution session exact readback is absent or ambiguous");
    readback = exact[0] as CraftRpcSession & Record<string, unknown>;
    if (readback.isProcessing) throw new Error("archived execution session is still processing");
    const archived = readback.archived === true || readback.isArchived === true || readback.kanbanColumn === "archived";
    if (!archived) throw new Error("execution archive command lacks authoritative archived readback");
    return { rpcSessionId: status.execution.rpcSessionId, commandResult, readback };
  }
}

export async function loadLiveRunnerConfig(path: string): Promise<LiveRunnerConfig> {
  const parsed = JSON.parse(await readFile(path, "utf8")) as LiveRunnerConfig;
  for (const [field, value] of Object.entries({
    workflowPath: parsed.workflowPath,
    repositoryRoot: parsed.repositoryRoot,
    workspaceRoot: parsed.workspaceRoot,
    issueId: parsed.issueId,
    claimFenceIssueId: parsed.claimFenceIssueId,
    verificationBudget: parsed.verificationBudget,
  })) {
    if (typeof value !== "string" || !value.trim()) throw new Error(`live runner ${field} must be configured`);
  }
  return parsed;
}

export async function createLiveRunner(config: LiveRunnerConfig): Promise<LiveV4Runner> {
  const loaded = await loadWorkflow(resolve(config.workflowPath));
  const workflow: WorkflowConfig = {
    ...loaded.config,
    project: {
      ...loaded.config.project,
      id: config.craft.projectId,
      repository: config.github.repository,
    },
    tracker: { ...loaded.config.tracker, kind: "github" },
    scheduler: { ...loaded.config.scheduler, maxAttempts: 1 },
    workspace: { root: resolve(config.workspaceRoot) },
    model: {
      connection: "chatgpt-plus",
      defaultProfile: "pi/gpt-5.6-sol",
      allowedProfiles: ["pi/gpt-5.6-sol"],
    },
    verification: {
      ...loaded.config.verification,
      low: {
        budget: config.verificationBudget,
        independentReviews: 0,
        correctionPasses: 0,
        ownerGate: false,
      },
    },
  };
  const rawGitHub = new GhCliTransport(config.github.executable);
  const github = new ScopedGitHubTransport(rawGitHub, {
    repository: config.github.repository,
    issueId: config.issueId,
    issueNumber: config.issueNumber,
    fenceIssueId: config.claimFenceIssueId,
    projectId: config.github.projectId,
    projectItemId: config.projectItemId,
    statusFieldId: config.github.statusFieldId,
    gateFieldId: config.github.gateFieldId,
  });
  const truth = new FilesystemWorkspaceTruthReader(workflow.workspace.root);
  const tracker = new GitHubIssuesProjectsAdapter({
    repository: config.github.repository,
    projectId: config.github.projectId,
    claimFenceIssueId: config.claimFenceIssueId,
    statusFieldId: config.github.statusFieldId,
    gateFieldId: config.github.gateFieldId,
    requiredLabels: config.github.requiredLabels,
    states: config.github.states,
    workflow,
    eventAuthorLogin: config.github.eventAuthorLogin,
  }, github, truth);
  const craftTransport = new CraftCliRpcTransport(config.craft.cli);
  const craft = new CraftMobileControlPlaneAdapter({
    workspaceId: config.craft.workspaceId,
    projectId: config.craft.projectId,
    projectWorkingDirectory: config.craft.projectWorkingDirectory,
    ownerSessionId: config.craft.ownerSessionId,
    repositoryInstructions: config.craft.repositoryInstructions,
    issueLabelId: config.craft.issueLabelId,
    runLabelId: config.craft.runLabelId,
    promptLabelId: config.craft.promptLabelId,
    model: { connection: "chatgpt-plus", allowedProfiles: ["pi/gpt-5.6-sol"] },
    expectedRuntime: config.craft.cli.expected,
    deadlines: config.craft.deadlines,
    maxHandoffChars: config.craft.maxHandoffChars,
  }, craftTransport);
  const workspaces = new GitWorktreeAdapter({
    repositoryRoot: config.repositoryRoot,
    workspaceRoot: config.workspaceRoot,
    gitExecutable: config.git.executable,
  });
  const scheduler = new DeterministicScheduler(workflow, { github: tracker, craft, workspaces }, new SystemClock());
  return new LiveV4Runner(config, workflow, tracker, craft, craftTransport, scheduler, workspaces);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** Restricts a repository transport to one explicitly authorized work item. */
export interface GitHubMutationScope {
  repository: string;
  issueId: string;
  issueNumber: number;
  fenceIssueId: string;
  projectId: string;
  projectItemId: string;
  statusFieldId: string;
  gateFieldId: string;
}

export class ScopedGitHubTransport implements GitHubTransport {
  constructor(readonly delegate: GitHubTransport, readonly scope: GitHubMutationScope) {}
  async listIssues(repository: string, cursor: string | null): Promise<Page<GitHubIssueRecord>> {
    if (cursor !== null) return { nodes: [], nextCursor: null };
    let providerCursor: string | null = null;
    do {
      const page = await this.delegate.listIssues(repository, providerCursor);
      const issue = page.nodes.find((candidate) => candidate.id === this.scope.issueId);
      if (issue) return { nodes: [issue], nextCursor: null };
      providerCursor = page.nextCursor;
    } while (providerCursor !== null);
    throw new Error(`scoped GitHub issue ${this.scope.issueId} is missing`);
  }
  getIssuesByNodeIds(ids: readonly string[]): Promise<(GitHubIssueRecord | null)[]> {
    if (ids.some((id) => id !== this.scope.issueId)) throw new Error("GitHub node request escaped configured issue scope");
    return this.delegate.getIssuesByNodeIds(ids);
  }
  listLabels(issueId: string, cursor: string | null): Promise<Page<string>> { return this.delegate.listLabels(this.assertIssue(issueId), cursor); }
  listBlockedBy(issueId: string, cursor: string | null): Promise<Page<GitHubIssueLink>> { return this.delegate.listBlockedBy(this.assertIssue(issueId), cursor); }
  listProjectItems(issueId: string, cursor: string | null): Promise<Page<GitHubProjectItem>> { return this.delegate.listProjectItems(this.assertIssue(issueId), cursor); }
  listProjectFieldValues(itemId: string, cursor: string | null): Promise<Page<GitHubProjectFieldValue>> { return this.delegate.listProjectFieldValues(itemId, cursor); }
  listComments(issueId: string, cursor: string | null): Promise<Page<GitHubComment>> {
    if (issueId !== this.scope.issueId && issueId !== this.scope.fenceIssueId) throw new Error("GitHub comment request escaped configured issue/fence scope");
    return this.delegate.listComments(issueId, cursor);
  }
  listClosingPullRequests(issueId: string, cursor: string | null): Promise<Page<GitHubPullRequestEvidence>> { return this.delegate.listClosingPullRequests(this.assertIssue(issueId), cursor); }
  getBranch(repository: string, branchName: string): Promise<GitHubBranchEvidence | null> { return this.delegate.getBranch(repository, branchName); }
  getBaseSha(repository: string, branchName: string): Promise<string> { return this.delegate.getBaseSha(repository, branchName); }
  appendComment(issueId: string, body: string): Promise<GitHubComment> {
    if (issueId !== this.scope.issueId && issueId !== this.scope.fenceIssueId) throw new Error("GitHub comment mutation escaped configured issue/fence scope");
    return this.delegate.appendComment(issueId, body);
  }
  replaceLabels(repository: string, issueNumber: number, labels: readonly string[]): Promise<void> {
    if (repository !== this.scope.repository || issueNumber !== this.scope.issueNumber) {
      throw new Error("GitHub label mutation escaped configured repository/issue scope");
    }
    return this.delegate.replaceLabels(repository, issueNumber, labels);
  }
  updateProjectSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    if (projectId !== this.scope.projectId || itemId !== this.scope.projectItemId || fieldId !== this.scope.statusFieldId) {
      throw new Error("GitHub Project status mutation escaped configured item scope");
    }
    return this.delegate.updateProjectSingleSelect(projectId, itemId, fieldId, optionId);
  }
  updateProjectText(projectId: string, itemId: string, fieldId: string, value: string): Promise<void> {
    if (projectId !== this.scope.projectId || itemId !== this.scope.projectItemId || fieldId !== this.scope.gateFieldId) {
      throw new Error("GitHub Project gate mutation escaped configured item scope");
    }
    return this.delegate.updateProjectText(projectId, itemId, fieldId, value);
  }

  private assertIssue(issueId: string): string {
    if (issueId !== this.scope.issueId) throw new Error("GitHub request escaped configured issue scope");
    return issueId;
  }
}
