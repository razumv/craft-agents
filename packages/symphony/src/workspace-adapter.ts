// SPDX-License-Identifier: Apache-2.0

import { appendFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
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
      throw new Error(`deterministic branch ${branch} already exists without its bound worktree`);
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
