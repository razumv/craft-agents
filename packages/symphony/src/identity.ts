// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { isAbsolute, relative, resolve } from "node:path";
import type { Claim, NormalizedIssue, RunIdentity, WorkflowConfig } from "./domain";

function digest(value: string, length = 16): string {
  return createHash("sha256").update(value).digest("hex").slice(0, length);
}

function workspaceKey(identifier: string): string {
  const sanitized = identifier.replace(/[^A-Za-z0-9._-]/g, "_");
  if (!sanitized) throw new Error("issue identifier cannot produce a workspace key");
  return sanitized === identifier ? sanitized : `${sanitized}-${digest(identifier)}`;
}

/**
 * Which account a run uses. Both strategies are pure functions of durable claim
 * inputs, which is the actual requirement — a restart must reconstruct the same
 * binding it claimed — and neither reads a clock or any process state.
 *
 * `failover` (default): attempt N → connections[N-1], clamped to the last. The
 * first attempt always lands on the configured primary, so later accounts are
 * pure reserve. With several projects running concurrently every attempt-1 run
 * piles onto one account while the rest idle.
 *
 * `balanced`: the starting account is chosen by hashing the issue id, and each
 * further attempt steps to the next account. Steady-state work spreads across
 * accounts per issue, retries still move off the account that just failed, and
 * with a full rotation an issue visits every account before repeating — which
 * `failover` never does, since it clamps on the last entry.
 */
export type ConnectionStrategy = "failover" | "balanced";

export function connectionForAttempt(
  model: { connection: string; connections?: string[]; connectionStrategy?: ConnectionStrategy },
  attempt: number,
  issueId?: string,
): string {
  const chain = model.connections?.filter((entry) => entry.trim()) ?? [];
  if (chain.length === 0) return model.connection;
  const step = Math.max(attempt, 1) - 1;
  // Balanced needs an issue id to spread by. Without one it degrades to
  // failover rather than picking something non-deterministic.
  if (model.connectionStrategy === "balanced" && issueId) {
    const offset = Number.parseInt(digest(issueId, 8), 16) % chain.length;
    return chain[(offset + step) % chain.length]!;
  }
  return chain[Math.min(step, chain.length - 1)]!;
}

export class IdentityFactory {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
    if (!isAbsolute(this.#root)) throw new Error("workspace root must be absolute");
  }

  forAttempt(issue: Pick<NormalizedIssue, "id" | "identifier">, attempt: number): RunIdentity {
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error("attempt must be a positive integer");
    const key = workspaceKey(issue.identifier);
    const seed = `${issue.id}\n${issue.identifier}\n${attempt}`;
    const attemptKey = `${key}-a${attempt}-${digest(seed, 12)}`;
    const workspacePath = resolve(this.#root, attemptKey);
    const rel = relative(this.#root, workspacePath);
    if (rel.startsWith("..") || isAbsolute(rel)) throw new Error("workspace escaped configured root");
    return Object.freeze({
      issueId: issue.id,
      issueIdentifier: issue.identifier,
      attempt,
      sessionId: `craft-${digest(`session\n${seed}`, 24)}`,
      workspaceId: `worktree-${digest(`workspace\n${seed}`, 24)}`,
      workspaceKey: attemptKey,
      workspacePath,
    });
  }

  claimFor(
    issue: Pick<NormalizedIssue, "id" | "identifier">,
    attempt: number,
    version: number,
    baseSha: string,
    model: WorkflowConfig["model"],
    nowMs: number,
    ttlMs: number,
  ): Claim {
    const identity = this.forAttempt(issue, attempt);
    return {
      ...identity,
      fence: `claim-${digest(`${issue.id}\n${attempt}\n${version}\n${baseSha}`, 32)}`,
      baseSha,
      // A pure function of the issue and the attempt, so a restart reconstructs
      // the exact same binding it claimed. See ConnectionStrategy.
      modelConnection: connectionForAttempt(model, attempt, issue.id),
      modelProfile: model.defaultProfile,
      claimedAtMs: nowMs,
      heartbeatAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };
  }
}
