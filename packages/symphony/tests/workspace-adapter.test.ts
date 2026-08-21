// SPDX-License-Identifier: Apache-2.0

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { GitWorktreeAdapter, IdentityFactory, claimBindingFile, type Claim, type CraftStartContext, type IssueContract, type NormalizedIssue } from "../src";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

type PreservedInfo = { issueId: string; attempt: number; branch: string; preservedBranch: string; commit: string };

async function fixture(options: { onPreserved?: (info: PreservedInfo) => void } = {}) {
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
    closed: false,
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
  const adapter = new GitWorktreeAdapter({
    repositoryRoot: root, workspaceRoot, gitExecutable: "/usr/bin/git",
    ...(options.onPreserved ? { onPreserved: options.onPreserved } : {}),
  });
  return { root, workspaceRoot, issue, identity, claim, context, adapter };
}

describe("v4 live git worktree adapter", () => {
  test("preflights the exact executable, git top-level, and canonical worktree root read-only", async () => {
    const { root, workspaceRoot, adapter } = await fixture();
    await mkdir(workspaceRoot, { recursive: true });
    const proof = await adapter.preflight();
    expect(proof.gitExecutable).toBe("/usr/bin/git");
    expect(proof.repositoryRoot).toBe(await realpath(root));
    expect(proof.workspaceRoot).toBe(await realpath(workspaceRoot));
  });

  test("creates one deterministic branch/worktree with atomic binding and resumes idempotently", async () => {
    const { root, identity, claim, context, adapter } = await fixture();
    const first = await adapter.ensure(identity, context);
    const second = await new GitWorktreeAdapter(adapter.config).ensure(identity, context);

    expect(second).toEqual(first);
    expect((await git(root, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(2);
    expect((await git(root, ["branch", "--list", context.contract.requiredBranch])).trim()).toContain(context.contract.requiredBranch);
    expect(JSON.parse(await readFile(resolve(identity.workspacePath, claimBindingFile), "utf8"))).toEqual(claim);
  });

  test("a base commit missing locally is fetched from origin instead of failing the attempt", async () => {
    const { root, claim, context, adapter } = await fixture();

    // A second repository plays origin, and carries a commit this clone has
    // never seen — exactly the state a clone is in the moment work merges.
    const upstream = await mkdtemp(resolve(tmpdir(), "craft-v4-upstream-"));
    roots.push(upstream);
    await git(upstream, ["init", "-b", "main"]);
    await Bun.write(resolve(upstream, "README.md"), "upstream\n");
    await git(upstream, ["add", "README.md"]);
    await git(upstream, ["-c", "user.name=Craft Agent Tests", "-c", "user.email=tests@example.invalid", "commit", "-m", "upstream"]);
    const upstreamSha = (await git(upstream, ["rev-parse", "HEAD"])).trim();
    await git(root, ["remote", "add", "origin", upstream]);

    // The tracker hands us that SHA as the base. Before this fix `worktree add`
    // died with "fatal: invalid reference" and, under an autonomous loop, every
    // retry died the same way until a human fetched.
    const advanced: Claim = { ...claim, baseSha: upstreamSha };
    const created = await adapter.ensure(advanced, { ...context, claim: advanced });

    expect(created.baseSha).toBe(upstreamSha);
    // The object is now in the local clone, and the worktree really sits on it.
    expect((await git(root, ["rev-parse", "--verify", `${upstreamSha}^{commit}`])).trim()).toBe(upstreamSha);
    expect((await git(created.workspacePath, ["rev-parse", "HEAD"])).trim()).toBe(upstreamSha);
  });

  test("a base commit that no fetch can supply still fails closed", async () => {
    const { claim, context, adapter } = await fixture();
    const absent: Claim = { ...claim, baseSha: "0".repeat(40) };

    // No origin configured and an unknown SHA: the attempt must fail with a
    // diagnostic about the base, not silently branch from something else.
    await expect(adapter.ensure(absent, { ...context, claim: absent })).rejects.toThrow(/is not present after fetching origin|invalid reference/);
  });

  test("fails closed when the deterministic branch exists without its bound worktree", async () => {
    const { root, identity, context, adapter } = await fixture();
    await git(root, ["branch", context.contract.requiredBranch, context.claim.baseSha]);
    await expect(adapter.ensure(identity, context)).rejects.toThrow("already exists without its bound worktree");
  });

  test("a retry releases the previous attempt's empty worktree instead of dead-locking on the branch", async () => {
    const first = await fixture();
    await first.adapter.ensure(first.identity, first.context);

    // Attempt 2: same issue, new per-attempt worktree path, same deterministic branch.
    const secondIdentity = new IdentityFactory(first.workspaceRoot).forAttempt(first.issue, 2);
    const secondClaim: Claim = { ...first.claim, ...secondIdentity, attempt: 2, fence: "claim-52-a2" };
    const secondContext: CraftStartContext = { ...first.context, claim: secondClaim };
    const worktree = await first.adapter.ensure(secondIdentity, secondContext);

    expect(worktree.workspacePath).toBe(secondIdentity.workspacePath);
    // Exactly one attempt worktree survives (plus the repository itself).
    expect((await git(first.root, ["worktree", "list", "--porcelain"])).match(/^worktree /gm)).toHaveLength(2);
    expect(JSON.parse(await readFile(resolve(secondIdentity.workspacePath, claimBindingFile), "utf8")).attempt).toBe(2);
  });

  test("the probe allows a branch held by work, saying the work will be preserved", async () => {
    const { root, claim, context, adapter } = await fixture();
    const first = await adapter.ensure(claim, context);
    // The first attempt does real work and never commits it — exactly the state
    // that jammed two live contracts when a deploy restart killed their turns.
    await Bun.write(resolve(first.workspacePath, "in-progress.txt"), "uncommitted work\n");

    // forAttempt supplies `attempt` itself; setting it here too would be overwritten.
    const retry: Claim = { ...claim, ...new IdentityFactory(resolve(root, ".worktrees", "v4-runs")).forAttempt(
      { id: claim.issueId, identifier: claim.issueIdentifier }, 2) };

    const probe = await adapter.probeBranch(retry, "v4/razumv-craft-protocol-52");
    expect(probe.claimable).toBeTrue();
    expect(probe.reason).toContain("preserved");

    // And the probe told the truth: ensure proceeds on the same branch.
    await adapter.ensure(retry, { ...context, claim: retry });
  });

  test("the probe still refuses a branch whose holder cannot be identified", async () => {
    const { root, claim, context, adapter } = await fixture();
    const first = await adapter.ensure(claim, context);
    // Without its claim binding the worktree proves nothing about which issue or
    // attempt it belongs to, so releasing it could destroy unrelated work.
    await rm(resolve(first.workspacePath, claimBindingFile), { force: true });

    const retry: Claim = { ...claim, ...new IdentityFactory(resolve(root, ".worktrees", "v4-runs")).forAttempt(
      { id: claim.issueId, identifier: claim.issueIdentifier }, 2) };

    const probe = await adapter.probeBranch(retry, "v4/razumv-craft-protocol-52");
    expect(probe.claimable).toBeFalse();
    expect(probe.reason).toContain("a retry cannot reclaim");
    await expect(adapter.ensure(retry, { ...context, claim: retry })).rejects.toThrow(/already exists/);
  });

  test("the probe allows a fresh branch and an earlier empty attempt", async () => {
    const { root, claim, context, adapter } = await fixture();

    // Nothing exists yet.
    expect(await adapter.probeBranch(claim, "v4/razumv-craft-protocol-52")).toMatchObject({ claimable: true });

    // An earlier attempt that produced nothing is reclaimable, so a retry may proceed.
    await adapter.ensure(claim, context);
    // forAttempt supplies `attempt` itself; setting it here too would be overwritten.
    const retry: Claim = { ...claim, ...new IdentityFactory(resolve(root, ".worktrees", "v4-runs")).forAttempt(
      { id: claim.issueId, identifier: claim.issueIdentifier }, 2) };
    expect(await adapter.probeBranch(retry, "v4/razumv-craft-protocol-52")).toMatchObject({ claimable: true });
  });

  test("a retry preserves the previous attempt's uncommitted work before taking the branch", async () => {
    const preserved: { preservedBranch: string; commit: string; attempt: number }[] = [];
    const first = await fixture({ onPreserved: (info) => preserved.push(info) });
    const created = await first.adapter.ensure(first.identity, first.context);
    await writeFile(resolve(created.workspacePath, "worker-output.txt"), "uncommitted work\n", "utf8");

    const secondIdentity = new IdentityFactory(first.workspaceRoot).forAttempt(first.issue, 2);
    const secondClaim: Claim = { ...first.claim, ...secondIdentity, attempt: 2, fence: "claim-52-a2" };
    const retry = await first.adapter.ensure(secondIdentity, { ...first.context, claim: secondClaim });

    // The retry got the deterministic branch, clean, from the base.
    expect(retry.branch).toBe("v4/razumv-craft-protocol-52");
    expect((await git(retry.workspacePath, ["status", "--porcelain"])).trim()).toBe("");

    // And the killed attempt's work is still in the repository, on its own branch.
    expect(preserved).toHaveLength(1);
    const info = preserved[0]!;
    expect(info.attempt).toBe(1);
    expect(info.preservedBranch).toStartWith("v4-preserved/v4-razumv-craft-protocol-52-a1-");
    expect(await first.adapter.findPreservedBranches(first.context.contract.requiredBranch)).toEqual([{
      branch: info.preservedBranch,
      commit: info.commit,
    }]);
    const files = await git(first.root, ["show", "--name-only", "--format=", info.commit]);
    expect(files).toContain("worker-output.txt");
    const content = await git(first.root, ["show", `${info.commit}:worker-output.txt`]);
    expect(content).toBe("uncommitted work\n");
  });

  test("a retry releases an earlier attempt that committed, preserving those commits", async () => {
    const preserved: { preservedBranch: string; commit: string }[] = [];
    const first = await fixture({ onPreserved: (info) => preserved.push(info) });
    const created = await first.adapter.ensure(first.identity, first.context);
    await writeFile(resolve(created.workspacePath, "committed.txt"), "committed work\n", "utf8");
    await git(created.workspacePath, ["add", "-A"]);
    await git(created.workspacePath, ["commit", "-m", "work the attempt did commit"]);
    const head = (await git(created.workspacePath, ["rev-parse", "HEAD"])).trim();

    const secondIdentity = new IdentityFactory(first.workspaceRoot).forAttempt(first.issue, 2);
    const secondClaim: Claim = { ...first.claim, ...secondIdentity, attempt: 2, fence: "claim-52-a2" };
    await first.adapter.ensure(secondIdentity, { ...first.context, claim: secondClaim });

    // A commit that already exists needs no rescue commit — it needs a ref that
    // outlives the worktree, pointing at exactly what the attempt built.
    expect(preserved).toHaveLength(1);
    expect(preserved[0]!.commit).toBe(head);
    expect((await git(first.root, ["rev-parse", preserved[0]!.preservedBranch])).trim()).toBe(head);
  });
});

async function git(cwd: string, args: string[]): Promise<string> {
  const processHandle = Bun.spawn(["/usr/bin/git", "-C", cwd, ...args], {
    stdout: "pipe", stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "Craft Agent Tests", GIT_AUTHOR_EMAIL: "tests@example.invalid",
           GIT_COMMITTER_NAME: "Craft Agent Tests", GIT_COMMITTER_EMAIL: "tests@example.invalid" },
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    processHandle.exited,
    new Response(processHandle.stdout).text(),
    new Response(processHandle.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr);
  return stdout;
}
