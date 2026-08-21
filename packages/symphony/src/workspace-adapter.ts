// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { access, appendFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { CraftStartContext } from "./craft-adapter";
import type { Claim, RunIdentity } from "./domain";
import { claimBindingFile, claimBindingsEqual } from "./workspace-truth";

export interface GitWorktreeAdapterConfig {
  repositoryRoot: string;
  workspaceRoot: string;
  gitExecutable: string;
  /**
   * Called when a dead attempt's uncommitted work was rescued onto a branch
   * before its worktree was released. Optional: preservation happens either way,
   * but nobody can act on work they were never told about.
   */
  onPreserved?: (info: { issueId: string; attempt: number; branch: string; preservedBranch: string; commit: string }) => void;
}

export interface GitWorktree {
  workspaceId: string;
  workspacePath: string;
  issueId: string;
  attempt: number;
  branch: string;
  baseSha: string;
}

/** Idempotent, fail-closed git worktree creation for one deterministic issue attempt. */
export class GitWorktreeAdapter {
  readonly #repositoryRoot: string;
  readonly #workspaceRoot: string;

  constructor(readonly config: GitWorktreeAdapterConfig) {
    this.#repositoryRoot = resolve(config.repositoryRoot);
    this.#workspaceRoot = resolve(config.workspaceRoot);
    if (!isAbsolute(config.gitExecutable)) throw new Error("git executable path must be absolute");
    if (!inside(this.#repositoryRoot, this.#workspaceRoot)) {
      throw new Error("workspace root must be inside the repository root");
    }
  }

  /** Read-only proof that configured git/repository/worktree roots are exact. */
  async preflight(): Promise<{ gitExecutable: string; repositoryRoot: string; workspaceRoot: string }> {
    const gitExecutable = await realpath(this.config.gitExecutable).catch(() => {
      throw new Error("configured git executable is missing");
    });
    const gitInfo = await lstat(gitExecutable);
    if (!gitInfo.isFile()) throw new Error("configured git executable is not a file");
    await access(gitExecutable, constants.X_OK).catch(() => {
      throw new Error("configured git executable is not executable");
    });

    const [repositoryInfo, workspaceInfo] = await Promise.all([
      lstat(this.#repositoryRoot).catch(() => null),
      lstat(this.#workspaceRoot).catch(() => null),
    ]);
    if (!repositoryInfo?.isDirectory() || repositoryInfo.isSymbolicLink()) {
      throw new Error("configured repository root must be a real directory");
    }
    if (!workspaceInfo?.isDirectory() || workspaceInfo.isSymbolicLink()) {
      throw new Error("configured workspace root must be a real directory");
    }

    const [repositoryRoot, workspaceRoot, gitTop] = await Promise.all([
      realpath(this.#repositoryRoot),
      realpath(this.#workspaceRoot),
      this.git(["rev-parse", "--show-toplevel"]),
    ]);
    if (await realpath(resolve(gitTop.trim())) !== repositoryRoot) {
      throw new Error("configured repository root is not the exact git top-level");
    }
    if (!inside(repositoryRoot, workspaceRoot)) {
      throw new Error("canonical workspace root must be inside the canonical repository root");
    }
    return { gitExecutable, repositoryRoot, workspaceRoot };
  }

  /**
   * Read the rescue refs created for a deterministic branch. The ref namespace
   * is derived by the same function as preservation, so unrelated branches can
   * never be inherited by a successor proposal.
   */
  async findPreservedBranches(requiredBranch: string): Promise<{ branch: string; commit: string }[]> {
    const branch = validateBranch(requiredBranch);
    const prefix = `v4-preserved/${stripRefPrefix(branch)}-a`;
    const output = await this.git([
      "for-each-ref",
      "--format=%(refname:short)%09%(objectname)",
      "refs/heads/v4-preserved",
    ]);
    return output.split(/\r?\n/).filter(Boolean).flatMap((line) => {
      const [preservedBranch, commit, ...extra] = line.split("\t");
      if (!preservedBranch || !commit || extra.length || !/^[0-9a-f]{40,64}$/i.test(commit)) {
        throw new Error("git returned an invalid preserved branch record");
      }
      return preservedBranch.startsWith(prefix) ? [{ branch: preservedBranch, commit }] : [];
    }).sort((left, right) => left.branch.localeCompare(right.branch) || left.commit.localeCompare(right.commit));
  }

  async ensure(identity: RunIdentity, context?: CraftStartContext): Promise<GitWorktree> {
    if (!context) throw new Error("real worktree adapter requires frozen issue/run context");
    const { claim, contract } = context;
    this.assertIdentity(identity, claim);
    const workspacePath = resolve(identity.workspacePath);
    if (!inside(this.#workspaceRoot, workspacePath)) throw new Error("worktree path escapes configured workspace root");
    const branch = validateBranch(contract.requiredBranch);

    const existingPath = await lstat(workspacePath).catch((error) => missing(error) ? null : Promise.reject(error));
    if (existingPath) {
      if (existingPath.isSymbolicLink() || !existingPath.isDirectory()) throw new Error("existing worktree path is not a real directory");
      await this.verifyExisting(workspacePath, branch, claim);
      await this.ensureBindingExcluded(workspacePath);
      return result(identity, branch, claim.baseSha);
    }

    if (await this.branchExists(branch)) {
      // The required branch is deterministic per ISSUE, while the worktree path
      // is per ATTEMPT — so a retry always finds the branch already taken by
      // the dead attempt's worktree. Release it, but only when the evidence is
      // unambiguous: the holder must be a worktree of this same issue whose
      // claim binding names an EARLIER attempt, and it must carry no work
      // (no commits beyond the base, no dirty files). Anything else still
      // fails closed — losing a worker's commits would be far worse than
      // burning an attempt.
      const released = await this.releaseStaleAttemptBranch(branch, claim);
      if (!released) throw new Error(`deterministic branch ${branch} already exists without its bound worktree`);
    }
    const listed = await this.worktreePaths();
    if (listed.has(workspacePath)) throw new Error("git reports the absent worktree path as already registered");

    await mkdir(dirname(workspacePath), { recursive: true });
    await this.ensureBaseShaPresent(claim.baseSha);
    await this.git(["worktree", "add", "-b", branch, workspacePath, claim.baseSha]);
    try {
      await this.writeBinding(workspacePath, claim);
      await this.verifyExisting(workspacePath, branch, claim);
      await this.ensureBindingExcluded(workspacePath);
    } catch (error) {
      // Do not delete the new worktree: ambiguous preservation must remain inspectable.
      throw new Error(`worktree created but durable claim binding failed: ${message(error)}`);
    }
    return result(identity, branch, claim.baseSha);
  }

  private assertIdentity(identity: RunIdentity, claim: Claim): void {
    for (const key of ["issueId", "issueIdentifier", "attempt", "sessionId", "workspaceId", "workspaceKey", "workspacePath"] as const) {
      if (identity[key] !== claim[key]) throw new Error(`worktree claim ${key} binding mismatch`);
    }
  }

  private async verifyExisting(workspacePath: string, branch: string, claim: Claim): Promise<void> {
    const [canonical, canonicalRoot] = await Promise.all([realpath(workspacePath), realpath(this.#workspaceRoot)]);
    if (!inside(canonicalRoot, canonical)) throw new Error("worktree realpath escapes canonical workspace root");
    const [top, actualBranch, bindingRaw] = await Promise.all([
      this.git(["-C", workspacePath, "rev-parse", "--show-toplevel"]),
      this.git(["-C", workspacePath, "symbolic-ref", "--short", "HEAD"]),
      readFile(resolve(workspacePath, claimBindingFile), "utf8"),
    ]);
    if (await realpath(resolve(top.trim())) !== canonical) throw new Error("worktree top-level path mismatch");
    if (actualBranch.trim() !== branch) throw new Error("worktree branch binding mismatch");
    let binding: Claim;
    try {
      binding = JSON.parse(bindingRaw) as Claim;
    } catch {
      throw new Error("worktree claim binding is invalid JSON");
    }
    if (!claimBindingsEqual(claim, binding)) throw new Error("worktree claim binding mismatch");
  }

  private async writeBinding(workspacePath: string, claim: Claim): Promise<void> {
    const target = resolve(workspacePath, claimBindingFile);
    const temporary = `${target}.tmp-${process.pid}`;
    await rm(temporary, { force: true });
    await writeFile(temporary, `${JSON.stringify(claim, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  }

  private async ensureBindingExcluded(workspacePath: string): Promise<void> {
    const excludePath = (await this.git(["-C", workspacePath, "rev-parse", "--git-path", "info/exclude"])).trim();
    const existing = await readFile(excludePath, "utf8").catch((error) => missing(error) ? "" : Promise.reject(error));
    if (!existing.split(/\r?\n/).includes(claimBindingFile)) {
      await appendFile(excludePath, `${existing.endsWith("\n") || existing === "" ? "" : "\n"}${claimBindingFile}\n`, "utf8");
    }
  }

  /**
   * Prune the previous attempt's worktree so its deterministic branch can be
   * recreated for this attempt. Returns false (keep failing closed) unless
   * every safety condition holds.
   */
  /**
   * Whether a claim for this branch could take it, asked BEFORE the claim is
   * spent. `ensure` already refuses a branch held by work — deliberately, since
   * discarding a worker's commits is worse than burning an attempt — but it
   * refuses after the claim exists, so a jammed branch consumed the whole retry
   * budget one attempt at a time. Probing first lets the scheduler skip the
   * issue and dispatch something else instead.
   *
   * Read-only: it releases nothing and creates nothing.
   */
  async probeBranch(claim: Claim, requiredBranch: string): Promise<{ claimable: boolean; reason: string }> {
    const branch = validateBranch(requiredBranch);
    if (!await this.branchExists(branch)) return { claimable: true, reason: "branch does not exist yet" };
    const workspacePath = resolve(this.#workspaceRoot, claim.workspaceKey);
    const existing = await lstat(workspacePath).catch((error) => missing(error) ? null : Promise.reject(error));
    // This attempt's own worktree already being there is resumption, not a jam.
    if (existing?.isDirectory()) return { claimable: true, reason: "this attempt's worktree already exists" };
    const holder = await this.#staleHolder(branch, claim);
    if (holder === null) return { claimable: false, reason: `deterministic branch ${branch} is held by work a retry cannot reclaim` };
    return holder.carriesWork
      ? { claimable: true, reason: "branch is held by an earlier attempt whose work will be preserved before release" }
      : { claimable: true, reason: "branch is held by an earlier empty attempt and can be released" };
  }

  private async releaseStaleAttemptBranch(branch: string, claim: Claim): Promise<boolean> {
    const holder = await this.#staleHolder(branch, claim);
    if (holder === null) return false;
    // Work first, release second, and never the other way round: a rescue that
    // runs after `worktree remove --force` has nothing left to rescue.
    if (holder.carriesWork) await this.#preserveHolderWork(holder.path, holder.binding, branch);
    await this.git(["worktree", "remove", "--force", holder.path]);
    await this.git(["branch", "-D", branch]);
    return true;
  }

  /**
   * Rescue a dead attempt's work onto its own branch before the deterministic
   * branch is released.
   *
   * This exists because of a failure I caused: restarting the Craft server
   * during a deploy killed two workers mid-turn, and their uncommitted work then
   * held the deterministic branch, so every retry failed closed and the issues
   * went terminal with the work still sitting in a worktree nobody would look
   * at. Fail-closed was right — losing commits is worse than burning an attempt
   * — but refusing was never the only safe option: the work can be kept AND the
   * branch freed.
   *
   * The preserved branch name carries the commit's own SHA, which makes a repeat
   * of the same rescue idempotent rather than a collision. Every step is
   * verified before the destructive one runs, and any failure propagates — a
   * silent rescue failure would be indistinguishable from the data loss this is
   * here to prevent.
   */
  async #preserveHolderWork(holder: string, binding: Claim, branch: string): Promise<void> {
    const dirty = (await this.git(["-C", holder, "status", "--porcelain"])).trim() !== "";
    if (dirty) {
      await this.git(["-C", holder, "add", "-A"]);
      const message = [
        `chore(v4): preserve interrupted work from attempt ${binding.attempt}`,
        "",
        `The attempt for ${binding.issueIdentifier} ended without committing — its`,
        "turn was cut short rather than completed. This commit is that work,",
        "unreviewed and unverified, kept so a retry can start from a clean branch",
        "without discarding it.",
        "",
        "Co-Authored-By: Craft Agent <agents-noreply@craft.do>",
      ].join("\n");
      await this.git(["-C", holder, "commit", "--no-verify", "-m", message]);
    }

    const head = (await this.git(["-C", holder, "rev-parse", "HEAD"])).trim();
    if (head === binding.baseSha) return; // Nothing survived the commit; there is nothing to preserve.
    const preserved = `v4-preserved/${stripRefPrefix(branch)}-a${binding.attempt}-${head.slice(0, 7)}`;

    const existing = await this.git(["rev-parse", "--verify", `refs/heads/${preserved}`], true);
    if (existing.exitCode === 0) {
      // Same branch, same commit: an earlier rescue already did this.
      if (existing.stdout.trim() !== head) throw new Error(`preservation branch ${preserved} exists at a different commit`);
    } else {
      await this.git(["branch", preserved, head]);
      const verify = await this.git(["rev-parse", "--verify", `refs/heads/${preserved}`], true);
      if (verify.exitCode !== 0 || verify.stdout.trim() !== head) {
        throw new Error(`refusing to release ${branch}: preservation branch ${preserved} was not created`);
      }
    }
    this.config.onPreserved?.({
      issueId: binding.issueId,
      attempt: binding.attempt,
      branch,
      preservedBranch: preserved,
      commit: head,
    });
  }

  /**
   * The worktree currently holding this branch when it provably belongs to an
   * earlier attempt of the same issue, else null. `carriesWork` says whether it
   * has anything worth rescuing first.
   *
   * Shared by the read-only probe and the actual release so the two can never
   * disagree — a probe that says yes where the release says no would be worse
   * than having no probe at all.
   */
  async #staleHolder(branch: string, claim: Claim): Promise<{ path: string; binding: Claim; carriesWork: boolean } | null> {
    const holders: string[] = [];
    const output = await this.git(["worktree", "list", "--porcelain"]);
    let current: string | null = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) current = resolve(line.slice(9));
      else if (line.startsWith("branch ") && current && line.slice(7).trim() === `refs/heads/${branch}`) holders.push(current);
    }
    // Exactly one holder, inside our workspace root, and not the path we want.
    // git reports canonical paths, so compare canonically (/var vs /private/var).
    if (holders.length !== 1) return null;
    const holder = holders[0]!;
    const canonicalRoot = await realpath(this.#workspaceRoot).catch(() => this.#workspaceRoot);
    if (!inside(canonicalRoot, holder) && !inside(this.#workspaceRoot, holder)) return null;

    // Its binding must belong to the same issue and an earlier attempt.
    const raw = await readFile(resolve(holder, claimBindingFile), "utf8").catch(() => null);
    if (raw === null) return null;
    let binding: Claim;
    try {
      binding = JSON.parse(raw) as Claim;
    } catch {
      return null;
    }
    if (binding.issueId !== claim.issueId || !(binding.attempt < claim.attempt)) return null;

    // Whether it holds work decides how it is released, not whether it can be.
    // A git command that cannot even be run is not "no work" — that is unknown,
    // and unknown still fails closed.
    const status = await this.git(["-C", holder, "status", "--porcelain"], true);
    if (status.exitCode !== 0) return null;
    const ahead = await this.git(["-C", holder, "rev-list", "--count", `${binding.baseSha}..HEAD`], true);
    if (ahead.exitCode !== 0) return null;

    const carriesWork = status.stdout.trim() !== "" || ahead.stdout.trim() !== "0";
    return { path: holder, binding, carriesWork };
  }

  /**
   * The base SHA comes from the tracker, so it can easily be newer than this
   * local clone — the moment work merges, the next claim's base is a commit
   * nobody fetched here yet, and `worktree add` dies with
   * "fatal: invalid reference". Under a manual tick that reads as a one-off; in
   * an autonomous loop every attempt fails the same way until a human happens
   * to fetch, which burns the whole retry budget on a stale checkout.
   *
   * Fetch only when the object is genuinely absent, so the common path stays
   * offline and a fetch failure on an already-present base never blocks work.
   */
  private async ensureBaseShaPresent(baseSha: string): Promise<void> {
    if ((await this.git(["cat-file", "-e", `${baseSha}^{commit}`], true)).exitCode === 0) return;
    const fetched = await this.git(["fetch", "--quiet", "origin", baseSha], true);
    if (fetched.exitCode !== 0) {
      // Not every remote allows fetching a bare SHA; fall back to a full fetch.
      await this.git(["fetch", "--quiet", "origin"], true);
    }
    if ((await this.git(["cat-file", "-e", `${baseSha}^{commit}`], true)).exitCode !== 0) {
      throw new Error(`base commit ${baseSha} is not present after fetching origin`);
    }
  }

  private async branchExists(branch: string): Promise<boolean> {
    const output = await this.git(["show-ref", "--verify", "--quiet", `refs/heads/${branch}`], true);
    return output.exitCode === 0;
  }

  private async worktreePaths(): Promise<Set<string>> {
    const output = await this.git(["worktree", "list", "--porcelain"]);
    return new Set(output.split("\n").filter((line) => line.startsWith("worktree ")).map((line) => resolve(line.slice(9))));
  }

  private async git(args: string[], allowFailure?: false): Promise<string>;
  private async git(args: string[], allowFailure: true): Promise<{ exitCode: number; stdout: string; stderr: string }>;
  private async git(args: string[], allowFailure = false): Promise<string | { exitCode: number; stdout: string; stderr: string }> {
    const processHandle = Bun.spawn([this.config.gitExecutable, "-C", this.#repositoryRoot, ...args], {
      stdout: "pipe",
      stderr: "pipe",
    });
    const [exitCode, stdout, stderr] = await Promise.all([
      processHandle.exited,
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
    ]);
    if (allowFailure) return { exitCode, stdout, stderr };
    if (exitCode !== 0) throw new Error(`git command failed (${exitCode}): ${stderr.trim() || "no diagnostic"}`);
    return stdout;
  }
}

function result(identity: RunIdentity, branch: string, baseSha: string): GitWorktree {
  return {
    workspaceId: identity.workspaceId,
    workspacePath: identity.workspacePath,
    issueId: identity.issueId,
    attempt: identity.attempt,
    branch,
    baseSha,
  };
}

function validateBranch(value: string): string {
  const branch = value.trim();
  if (!branch || branch.startsWith("-") || branch.includes("..") || /[\s~^:?*[\\]/.test(branch)) {
    throw new Error("required branch is not a safe git branch name");
  }
  return branch;
}

/**
 * Flatten a branch name for use inside another branch name. `v4/x` nested under
 * `v4-preserved/` would need a directory where git already has a ref file, so the
 * separator becomes a dash instead.
 */
function stripRefPrefix(branch: string): string {
  return branch.replace(/\//g, "-");
}

function inside(root: string, candidate: string): boolean {
  const rel = relative(root, candidate);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

function missing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
