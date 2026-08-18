// SPDX-License-Identifier: Apache-2.0

import { FakeCraftAdapter, FakeGitHubAdapter, FakeWorkspaceAdapter } from "./adapters";
import { normalizeIssue, parseIssueContract } from "./contract";
import type { NormalizedIssue, ProjectStatus, WorkflowDefinition } from "./domain";
import { DeterministicScheduler, ManualClock, SimulatedCrash, type CrashPoint } from "./scheduler";

export class CrashRestartSimulator {
  readonly github = new FakeGitHubAdapter();
  readonly craft = new FakeCraftAdapter();
  readonly workspaces = new FakeWorkspaceAdapter();
  readonly clock = new ManualClock(1_000_000);
  scheduler: DeterministicScheduler;

  constructor(readonly workflow: WorkflowDefinition) {
    this.scheduler = this.newScheduler();
  }

  seed(input: unknown, contractMarkdown: string, baseSha = "a".repeat(40)): NormalizedIssue {
    const issue = normalizeIssue(input);
    const contract = parseIssueContract(contractMarkdown, issue.identifier, this.workflow.config);
    this.github.seed(issue, contract, baseSha);
    return issue;
  }

  restart(): void {
    this.scheduler = this.newScheduler();
  }

  async crashTick(point: CrashPoint): Promise<void> {
    try {
      await this.scheduler.tick(point);
    } catch (error) {
      if (!(error instanceof SimulatedCrash) || error.point !== point) throw error;
      return;
    }
    throw new Error(`simulator did not crash at ${point}`);
  }

  async runSmoke(issueId: string): Promise<ProjectStatus> {
    await this.crashTick("after-session");
    this.restart();
    await this.scheduler.tick();
    let snapshot = this.github.get(issueId);
    if (snapshot.issue.state !== "running" || !snapshot.claim) throw new Error("restart did not recover running claim");
    const fence = snapshot.claim.fence;
    this.github.transition(issueId, "pr-open", this.clock.nowMs(), {
      fence,
      message: "focused tests and simulator smoke passed",
      evidence: { prUrl: "https://example.test/pull/45", branchUrl: "https://example.test/tree/v4/issue-45" },
    });
    this.github.transition(issueId, "merged", this.clock.nowMs(), { fence, message: "candidate merged" });
    this.github.transition(issueId, "done", this.clock.nowMs(), { fence, message: "workflow outcome complete" });
    snapshot = this.github.get(issueId);
    return await this.scheduler.status(snapshot.issue.id);
  }

  private newScheduler(): DeterministicScheduler {
    return new DeterministicScheduler(
      this.workflow.config,
      { github: this.github, craft: this.craft, workspaces: this.workspaces },
      this.clock,
    );
  }
}
