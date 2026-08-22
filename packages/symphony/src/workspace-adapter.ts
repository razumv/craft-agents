// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { access, appendFile, lstat, mkdir, readFile, realpath, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { CraftStartContext } from "./craft-adapter";
import type { Claim, RunIdentity } from "./domain";
import { claimBindingFile, claimBindingsEqual } from "./workspace-truth";

export interface PreservedWork {
  issueId: string;
  attempt: number;
  branch: string;
  preservedBranch: string;
  commit: string;
}

export interface PreservationAuditRecord {
  branch: string;
  commit: string;
  remoteCommit: string | null;
  durable: boolean;
}

export interface GitWorktreeAdapterConfig {
  repositoryRoot: string;
  workspaceRoot: string;
  gitExecutable: string;
  /** Repository named by the tracker. Its matching git remote receives rescue refs. */
  trackerRepository?: string;
  /** Test/embedded override; production derives the remote from trackerRepository. */
  trackerRemote?: string;
  /**
   * Durable ledger write performed only after the remote has the exact commit.
   * A rejected write leaves both the local preservation ref and original
   * worktree intact, so replay can safely finish the receipt.
   */
  onPreserved?: (info: PreservedWork) => void | Promise<void>;
}

export interface GitWorktree {
  workspaceId: string;
  workspacePath: string;
  issueId: string;
  attempt: number;
  branch: string;
  baseSha: string;
}

export interface TerminalWorktreeEvidence {
  repository: string;
  projectId: string;
  issueIdentifier: string;
  requiredBranch: string;
  baseBranch: string;
  settledAtMs: number;
  branchSha: string;
  mergeCommitSha: string;
}

export interface TerminalWorktreeGcReceipt {
  workspaceId: string;
  workspacePath: string;
  issueIdentifier: string;
  attempt: number;
  headSha: string;
  settledAtMs: number;
  removedAtMs: number;
}

export interface TerminalWorktreeGcReport {
  retentionLimit: 5;
  registered: number;
  eligible: number;
  retained: number;
  excluded: number;
  laneIdle: boolean;
  reasons: Array<{ reason: string; count: number; workspaces: string[] }>;
  lastReceipt: TerminalWorktreeGcReceipt | null;
  laneError: string | null;
}

export interface TerminalWorktreeGcCallbacks {
  /** Fresh provider, lane-ledger, and Craft-session proof. */
  verify(binding: Claim, phase: "classify" | "pre-remove" | "post-remove"): Promise<{ accepted: true; evidence: TerminalWorktreeEvidence } | { accepted: false; reason: string }>;
  /** Re-read immediately before removal; false protects a concurrent claim. */
  laneIdle(): Promise<boolean>;
}

interface RegisteredWorktree {
  path: string;
  head: string | null;
  branch: string | null;
}

interface EligibleTerminalWorktree {
  registered: RegisteredWorktree;
  binding: Claim;
  evidence: TerminalWorktreeEvidence;
  head: string;
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
    const prefix = `v4-preserved/${stripRefPrefix(branch)}`;
    const exactPreservedRef = new RegExp(`^${escapeRegExp(prefix)}-a[1-9]\\d*-[0-9a-f]{7}$`, "i");
    const remote = await this.trackerRemote();
    const output = await this.git(["ls-remote", "--heads", remote, `refs/heads/${prefix}-a*`]);
    return parseRemoteRefs(output).filter((record) => exactPreservedRef.test(record.branch));
  }

  /** One-off, read-only inventory of local rescue refs that are absent or different remotely. */
  async auditPreservedBranches(): Promise<PreservationAuditRecord[]> {
    const local = parseLocalRefs(await this.git([
      "for-each-ref",
      "--format=%(refname:short)%09%(objectname)",
      "refs/heads/v4-preserved",
    ]));
    const remote = new Map(parseRemoteRefs(await this.git([
      "ls-remote", "--heads", await this.trackerRemote(), "refs/heads/v4-preserved/*",
    ])).map((record) => [record.branch, record.commit]));
    return local.map(({ branch, commit }) => {
      const remoteCommit = remote.get(branch) ?? null;
      return { branch, commit, remoteCommit, durable: remoteCommit === commit };
    });
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

  /**
   * Preserve the exact current attempt before its failure is written. Unlike
   * stale-attempt reclamation this never removes the worktree or branch; it
   * returns the exact commit even when there is no work beyond the base.
   */
  async preserveInterrupted(identity: RunIdentity, context?: CraftStartContext): Promise<{
    branch: string;
    commit: string;
    preservedBranch: string | null;
  }> {
    if (!context) throw new Error("terminal preservation requires frozen issue/run context");
    const { claim, contract } = context;
    this.assertIdentity(identity, claim);
    const branch = validateBranch(contract.requiredBranch);
    const workspacePath = resolve(identity.workspacePath);
    await this.verifyExisting(workspacePath, branch, claim);
    const preserved = await this.#preserveHolderWork(workspacePath, claim, branch);
    const commit = (await this.git(["-C", workspacePath, "rev-parse", "HEAD"])).trim();
    return { branch, commit, preservedBranch: preserved?.preservedBranch ?? null };
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
  async #preserveHolderWork(holder: string, binding: Claim, branch: string): Promise<PreservedWork | null> {
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
    if (head === binding.baseSha) return null; // Nothing survived the commit; there is nothing to preserve.
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
    const remote = await this.trackerRemote();
    const pushed = await this.git([
      "push", "--porcelain", remote, `refs/heads/${preserved}:refs/heads/${preserved}`,
    ], true);
    if (pushed.exitCode !== 0) {
      throw new Error(
        `preservation push failed for ${preserved}: ${pushed.stderr.trim() || pushed.stdout.trim() || "no diagnostic"}; `
        + `local branch ${preserved} remains at ${head} and the interrupted worktree was not released`,
      );
    }
    const remoteRef = parseRemoteRefs(await this.git([
      "ls-remote", "--heads", remote, `refs/heads/${preserved}`,
    ])).find((record) => record.branch === preserved);
    if (remoteRef?.commit !== head) {
      throw new Error(
        `preservation push for ${preserved} did not read back ${head} from ${remote}; `
        + `local branch ${preserved} and the interrupted worktree remain`,
      );
    }

    const record = {
      issueId: binding.issueId,
      attempt: binding.attempt,
      branch,
      preservedBranch: preserved,
      commit: head,
    };
    await this.config.onPreserved?.(record);
    return record;
  }

  private async trackerRemote(): Promise<string> {
    if (this.config.trackerRemote?.trim()) return this.config.trackerRemote.trim();
    const repository = this.config.trackerRepository?.trim();
    if (!repository || !/^[^/\s]+\/[^/\s]+$/.test(repository)) {
      throw new Error("tracker repository is required to identify the preservation push remote");
    }
    const remotes = (await this.git(["remote"])).split(/\r?\n/).map((remote) => remote.trim()).filter(Boolean);
    const matching: string[] = [];
    for (const remote of remotes) {
      const urls = (await this.git(["remote", "get-url", "--push", "--all", remote], true));
      if (urls.exitCode === 0 && urls.stdout.split(/\r?\n/).some((url) => repositoryFromRemoteUrl(url) === repository)) {
        matching.push(remote);
      }
    }
    if (matching.length !== 1) {
      throw new Error(`expected exactly one git push remote for tracker repository ${repository}, found ${matching.length}`);
    }
    return matching[0]!;
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
   * Classify every registered direct child of this lane root and, only while
   * the lane is still idle, remove the oldest eligible identity beyond the
   * newest five. Classification and pre-delete verification share the same
   * function; faults exclude, never make a worktree look clean.
   */
  async collectTerminalWorktrees(callbacks: TerminalWorktreeGcCallbacks): Promise<TerminalWorktreeGcReport> {
    const retentionLimit = 5 as const;
    const exclusions = new Map<string, string[]>();
    const eligible: EligibleTerminalWorktree[] = [];
    let registeredCount = 0;
    let laneError: string | null = null;

    let records: RegisteredWorktree[];
    try {
      records = parseWorktreeList(await this.git(["worktree", "list", "--porcelain"]));
    } catch (error) {
      return { retentionLimit, registered: 0, eligible: 0, retained: 0, excluded: 0, laneIdle: false, reasons: [], lastReceipt: null, laneError: message(error) };
    }
    const canonicalRoot = await realpath(this.#workspaceRoot).catch(() => this.#workspaceRoot);
    for (const record of records) {
      const rel = relative(canonicalRoot, record.path);
      if (!rel || escapesRoot(rel)) continue;
      registeredCount += 1;
      const identity = rel;
      const classified = await this.#classifyTerminalWorktree(record, canonicalRoot, callbacks, "classify");
      if (classified.accepted) eligible.push(classified.worktree);
      else addExclusion(exclusions, classified.reason, identity);
    }

    eligible.sort((left, right) => right.evidence.settledAtMs - left.evidence.settledAtMs
      || left.evidence.issueIdentifier.localeCompare(right.evidence.issueIdentifier)
      || right.binding.attempt - left.binding.attempt
      || left.binding.workspaceId.localeCompare(right.binding.workspaceId));
    const retained = Math.min(retentionLimit, eligible.length);
    let lastReceipt: TerminalWorktreeGcReceipt | null = null;
    let laneIdle = false;
    try {
      laneIdle = await callbacks.laneIdle();
      const candidate = eligible.at(-1);
      if (laneIdle && eligible.length > retentionLimit && candidate) {
        // A second complete classification closes the provider/Craft/Git race
        // window as far as this bounded adapter can. The non-overlapping lane
        // operation and lane fence protect the final command itself.
        const fresh = await this.#classifyTerminalWorktree(candidate.registered, canonicalRoot, callbacks, "pre-remove");
        if (!fresh.accepted || fresh.worktree.binding.workspaceId !== candidate.binding.workspaceId) {
          addExclusion(exclusions, fresh.accepted ? "identity-changed-before-remove" : `pre-remove-${fresh.reason}`, candidate.binding.workspaceKey);
        } else if (!await callbacks.laneIdle()) {
          addExclusion(exclusions, "concurrent-claim", candidate.binding.workspaceKey);
          laneIdle = false;
        } else {
          await this.git(["worktree", "remove", candidate.registered.path]);
          const [remaining, pathInfo, post] = await Promise.all([
            this.worktreePaths(),
            lstat(candidate.registered.path).catch((error) => missing(error) ? null : Promise.reject(error)),
            callbacks.verify(candidate.binding, "post-remove"),
          ]);
          if (remaining.has(resolve(candidate.registered.path)) || pathInfo !== null) {
            throw new Error("non-force worktree removal lacks exact registration/path readback");
          }
          if (!post.accepted || post.evidence.settledAtMs !== candidate.evidence.settledAtMs) {
            throw new Error(`terminal ledger readback changed after removal: ${post.accepted ? "settled-time-mismatch" : post.reason}`);
          }
          lastReceipt = {
            workspaceId: candidate.binding.workspaceId,
            workspacePath: candidate.registered.path,
            issueIdentifier: candidate.evidence.issueIdentifier,
            attempt: candidate.binding.attempt,
            headSha: candidate.head,
            settledAtMs: candidate.evidence.settledAtMs,
            removedAtMs: Date.now(),
          };
        }
      }
    } catch (error) {
      laneError = message(error);
    }

    const reasons = [...exclusions].map(([reason, workspaces]) => ({
      reason, count: workspaces.length, workspaces: [...workspaces].sort(),
    })).sort((left, right) => left.reason.localeCompare(right.reason));
    return {
      retentionLimit,
      registered: registeredCount,
      eligible: eligible.length,
      retained,
      excluded: registeredCount - eligible.length,
      laneIdle,
      reasons,
      lastReceipt,
      laneError,
    };
  }

  async #classifyTerminalWorktree(
    record: RegisteredWorktree,
    canonicalRoot: string,
    callbacks: TerminalWorktreeGcCallbacks,
    phase: "classify" | "pre-remove",
  ): Promise<{ accepted: true; worktree: EligibleTerminalWorktree } | { accepted: false; reason: string }> {
    try {
      const rel = relative(canonicalRoot, record.path);
      if (!rel || escapesRoot(rel) || rel.includes(sep)) return { accepted: false, reason: "not-canonical-direct-child" };
      const info = await lstat(record.path);
      if (!info.isDirectory() || info.isSymbolicLink()) return { accepted: false, reason: "path-not-real-directory" };
      const canonical = await realpath(record.path);
      if (canonical !== resolve(canonicalRoot, rel)) return { accepted: false, reason: "canonical-path-mismatch" };
      if (!record.head || !/^[0-9a-f]{40,64}$/i.test(record.head) || !record.branch?.startsWith("refs/heads/")) {
        return { accepted: false, reason: "detached-or-invalid-registration" };
      }

      const raw = await readFile(resolve(record.path, claimBindingFile), "utf8");
      const binding = JSON.parse(raw) as Claim;
      const boundCanonical = validClaimBinding(binding)
        ? await realpath(resolve(binding.workspacePath)).catch(() => null)
        : null;
      if (!validClaimBinding(binding) || boundCanonical !== canonical || binding.workspaceKey !== rel) {
        return { accepted: false, reason: "claim-binding-mismatch" };
      }
      const external = await callbacks.verify(binding, phase);
      if (!external.accepted) return { accepted: false, reason: external.reason };
      const evidence = external.evidence;
      if (evidence.repository !== this.config.trackerRepository || evidence.issueIdentifier !== binding.issueIdentifier) {
        return { accepted: false, reason: "repository-or-issue-mismatch" };
      }
      if (record.branch !== `refs/heads/${evidence.requiredBranch}`) return { accepted: false, reason: "branch-binding-mismatch" };

      const [top, common, head, status, ignored, stash, submodules] = await Promise.all([
        this.git(["-C", record.path, "rev-parse", "--show-toplevel"]),
        this.git(["-C", record.path, "rev-parse", "--git-common-dir"]),
        this.git(["-C", record.path, "rev-parse", "HEAD"]),
        this.git(["-C", record.path, "status", "--porcelain=v2", "--untracked-files=all"]),
        this.git(["-C", record.path, "status", "--porcelain=v2", "--ignored=matching"]),
        this.git(["stash", "list", "--format=%gd"]),
        this.git(["-C", record.path, "ls-files", "--stage"]),
      ]);
      if (await realpath(resolve(top.trim())) !== canonical) return { accepted: false, reason: "git-top-level-mismatch" };
      const commonPath = resolve(record.path, common.trim());
      const rootCommon = resolve(this.#repositoryRoot, (await this.git(["rev-parse", "--git-common-dir"])).trim());
      if (await realpath(commonPath) !== await realpath(rootCommon)) return { accepted: false, reason: "git-common-directory-mismatch" };
      if (head.trim() !== record.head) return { accepted: false, reason: "head-registration-mismatch" };
      if (status.trim()) return { accepted: false, reason: "staged-modified-conflicted-or-untracked" };
      const ignoredPaths = ignored.split(/\r?\n/).filter((line) => line.startsWith("! ")).map((line) => line.slice(2));
      if (ignoredPaths.some((path) => path !== claimBindingFile)) return { accepted: false, reason: "run-owned-ignored" };
      if (stash.trim()) return { accepted: false, reason: "stash-present" };
      if (submodules.split(/\r?\n/).some((line) => /^160000\s/.test(line))) return { accepted: false, reason: "submodule-present" };

      const preserved = await this.#headPreserved(record.head, evidence);
      if (!preserved) return { accepted: false, reason: "local-only-or-unpushed-head" };
      return { accepted: true, worktree: { registered: record, binding, evidence, head: record.head } };
    } catch (error) {
      return { accepted: false, reason: `classification-fault: ${message(error)}` };
    }
  }

  async #headPreserved(head: string, evidence: TerminalWorktreeEvidence): Promise<boolean> {
    const remote = await this.trackerRemote();
    const refs = parseRemoteRefs(await this.git([
      "ls-remote", "--heads", remote,
      `refs/heads/${evidence.baseBranch}`,
      `refs/heads/${evidence.requiredBranch}`,
    ]));
    const base = refs.find((entry) => entry.branch === evidence.baseBranch)?.commit;
    for (const accepted of [base, evidence.mergeCommitSha]) {
      if (!accepted) continue;
      const present = await this.git(["cat-file", "-e", `${accepted}^{commit}`], true);
      if (present.exitCode !== 0) continue;
      const ancestor = await this.git(["merge-base", "--is-ancestor", head, accepted], true);
      if (ancestor.exitCode === 0) return true;
    }
    // Squash/rebase merges need not contain the PR head. They are safe only
    // when both immutable provider evidence and the bound remote branch expose
    // this exact commit; a local-only or force-moved head remains excluded.
    const remoteHead = refs.find((entry) => entry.branch === evidence.requiredBranch)?.commit;
    return evidence.branchSha === head && remoteHead === head && /^[0-9a-f]{40,64}$/i.test(evidence.mergeCommitSha);
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

function parseWorktreeList(output: string): RegisteredWorktree[] {
  const records: RegisteredWorktree[] = [];
  let current: RegisteredWorktree | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) {
      if (current) records.push(current);
      current = { path: resolve(line.slice(9)), head: null, branch: null };
    } else if (current && line.startsWith("HEAD ")) current.head = line.slice(5).trim();
    else if (current && line.startsWith("branch ")) current.branch = line.slice(7).trim();
  }
  if (current) records.push(current);
  const paths = new Set<string>();
  for (const record of records) {
    if (paths.has(record.path)) throw new Error("git returned duplicate worktree registration");
    paths.add(record.path);
  }
  return records;
}

function validClaimBinding(value: unknown): value is Claim {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const claim = value as Partial<Claim>;
  const strings: (keyof Claim)[] = [
    "issueId", "issueIdentifier", "fence", "sessionId", "workspaceId", "workspaceKey", "workspacePath",
    "baseSha", "modelConnection", "modelProfile",
  ];
  return strings.every((key) => typeof claim[key] === "string" && Boolean((claim[key] as string).trim()))
    && Number.isInteger(claim.attempt) && claim.attempt! > 0
    && [claim.claimedAtMs, claim.heartbeatAtMs, claim.expiresAtMs].every((entry) => typeof entry === "number" && Number.isFinite(entry) && entry! >= 0)
    && claim.expiresAtMs! >= claim.claimedAtMs!;
}

function addExclusion(target: Map<string, string[]>, reason: string, workspace: string): void {
  const stable = reason.trim() || "unknown-exclusion";
  target.set(stable, [...(target.get(stable) ?? []), workspace]);
}

function escapesRoot(rel: string): boolean {
  return isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`);
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseLocalRefs(output: string): { branch: string; commit: string }[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [branch, commit, ...extra] = line.split("\t");
    if (!branch || !commit || extra.length || !/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new Error("git returned an invalid local preserved branch record");
    }
    return { branch, commit };
  }).sort((left, right) => left.branch.localeCompare(right.branch) || left.commit.localeCompare(right.commit));
}

function parseRemoteRefs(output: string): { branch: string; commit: string }[] {
  return output.split(/\r?\n/).filter(Boolean).map((line) => {
    const [commit, ref, ...extra] = line.split("\t");
    if (!commit || !ref?.startsWith("refs/heads/") || extra.length || !/^[0-9a-f]{40,64}$/i.test(commit)) {
      throw new Error("git returned an invalid remote preserved branch record");
    }
    return { branch: ref.slice("refs/heads/".length), commit };
  }).sort((left, right) => left.branch.localeCompare(right.branch) || left.commit.localeCompare(right.commit));
}

function repositoryFromRemoteUrl(value: string): string | null {
  const url = value.trim().replace(/\/+$/, "").replace(/\.git$/, "");
  // Accept ordinary URL and SCP-like git syntax on any host. Tracker identity is
  // owner/name; pinning the host to github.com would break GitHub Enterprise.
  const match = url.match(/^(?:[a-z][a-z0-9+.-]*:\/\/(?:[^@/\s]+@)?[^/\s]+\/|[^@/\s]+@[^:/\s]+:)([^/\s]+\/[^/\s]+)$/i);
  return match?.[1] ?? null;
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
