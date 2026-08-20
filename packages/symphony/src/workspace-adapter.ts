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
  private async releaseStaleAttemptBranch(branch: string, claim: Claim): Promise<boolean> {
    const holders: string[] = [];
    const output = await this.git(["worktree", "list", "--porcelain"]);
    let current: string | null = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("worktree ")) current = resolve(line.slice(9));
      else if (line.startsWith("branch ") && current && line.slice(7).trim() === `refs/heads/${branch}`) holders.push(current);
    }
    // Exactly one holder, inside our workspace root, and not the path we want.
    // git reports canonical paths, so compare canonically (/var vs /private/var).
    if (holders.length !== 1) return false;
    const holder = holders[0]!;
    const canonicalRoot = await realpath(this.#workspaceRoot).catch(() => this.#workspaceRoot);
    if (!inside(canonicalRoot, holder) && !inside(this.#workspaceRoot, holder)) return false;

    // Its binding must belong to the same issue and an earlier attempt.
    const raw = await readFile(resolve(holder, claimBindingFile), "utf8").catch(() => null);
    if (raw === null) return false;
    let binding: Claim;
    try {
      binding = JSON.parse(raw) as Claim;
    } catch {
      return false;
    }
    if (binding.issueId !== claim.issueId || !(binding.attempt < claim.attempt)) return false;

    // It must contain no work: clean tree and no commits beyond the base it started from.
    const status = await this.git(["-C", holder, "status", "--porcelain"], true);
    if (status.exitCode !== 0 || status.stdout.trim() !== "") return false;
    const ahead = await this.git(["-C", holder, "rev-list", "--count", `${binding.baseSha}..HEAD`], true);
    if (ahead.exitCode !== 0 || ahead.stdout.trim() !== "0") return false;

    await this.git(["worktree", "remove", "--force", holder]);
    await this.git(["branch", "-D", branch]);
    return true;
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
