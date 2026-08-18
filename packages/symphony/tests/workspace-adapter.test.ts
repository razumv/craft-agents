// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GitWorktreeAdapter, IdentityFactory, claimBindingFile, type Claim, type CraftStartContext, type IssueContract, type NormalizedIssue } from "../src";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(resolve(tmpdir(), "craft-v4-worktree-"));
  roots.push(root);
  await git(root, ["init", "-b", "main"]);
  await Bun.write(resolve(root, "README.md"), "fixture\n");
  await git(root, ["add", "README.md"]);
  await git(root, ["-c", "user.name=Craft Agent Tests", "-c", "user.email=tests@example.invalid", "commit", "-m", "fixture"]);
  const baseSha = (await git(root, ["rev-parse", "HEAD"])).trim();
  const workspaceRoot = resolve(root, ".worktrees", "v4-runs");
  const issue: NormalizedIssue = {
    id: "I_52",
    nativeRef: null,
    identifier: "razumv/craft-protocol#52",
    title: "compact status",
    description: null,
    priority: null,
    state: "claimed",
    branchName: null,
    url: null,
    assigneeId: null,
    labels: ["v4"],
    blockedBy: [],
    dispatchable: true,
    createdAt: null,
    updatedAt: null,
  };
  const contract: IssueContract = {
    id: "V4-CANARY-RUN-SUMMARY",
    projectId: "proj-craft-protocol",
    repository: "razumv/craft-protocol",
    goal: "compact status",
    acceptance: ["targeted tests"],
    nonGoals: ["production"],
    risk: "low",
    deployAuthority: "none",
    requiredBranch: "v4/razumv-craft-protocol-52",
    baseBranch: "main",
    dependencies: [],
    ownerDirectiveRefs: [],
    modelProfile: "pi/gpt-5.6-sol",
    verificationBudget: "changed-area-tests-plus-one-smoke-no-independent-auditor",
  };
  const identity = new IdentityFactory(workspaceRoot).forAttempt(issue, 1);
  const claim: Claim = {
    ...identity,
    fence: "claim-52",
    baseSha,
    modelConnection: "chatgpt-plus",
    modelProfile: "pi/gpt-5.6-sol",
    claimedAtMs: 1_000,
    heartbeatAtMs: 1_000,
    expiresAtMs: 61_000,
  };
  const context: CraftStartContext = { claim, issue, contract };
  const adapter = new GitWorktreeAdapter({ repositoryRoot: root, workspaceRoot, gitExecutable: "/usr/bin/git" });
  return { root, workspaceRoot, issue, identity, claim, context, adapter };
}

describe("v4 live git worktree adapter", () => {
  test("creates one deterministic branch/worktree with atomic binding and resumes idempotently", async () => {
    const { root, identity, claim, context, adapter } = await fixture();
    const first = await adapter.ensure(identity, context);
    const second = await new GitWorktreeAdapter(adapter.config).ensure(identity, context);

    expect(second).toEqual(first);
    expect((await git(root, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(2);
    expect((await git(root, ["branch", "--list", context.contract.requiredBranch])).trim()).toContain(context.contract.requiredBranch);
    expect(JSON.parse(await readFile(resolve(identity.workspacePath, claimBindingFile), "utf8"))).toEqual(claim);
  });

  test("fails closed when the deterministic branch exists without its bound worktree", async () => {
    const { root, identity, context, adapter } = await fixture();
    await git(root, ["branch", context.contract.requiredBranch, context.claim.baseSha]);
    await expect(adapter.ensure(identity, context)).rejects.toThrow("already exists without its bound worktree");
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const processHandle = Bun.spawn(["/usr/bin/git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}
