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

/** Deterministic failover pick: attempt N → connections[N-1], clamped to the last. */
export function connectionForAttempt(
  model: { connection: string; connections?: string[] },
  attempt: number,
): string {
  const chain = model.connections?.filter((entry) => entry.trim()) ?? [];
  if (chain.length === 0) return model.connection;
  return chain[Math.min(Math.max(attempt, 1), chain.length) - 1]!;
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
      // Attempt N → connections[N-1] (clamped): deterministic, so a restart
      // reconstructs the exact same binding it claimed.
      modelConnection: connectionForAttempt(model, attempt),
      modelProfile: model.defaultProfile,
      claimedAtMs: nowMs,
      heartbeatAtMs: nowMs,
      expiresAtMs: nowMs + ttlMs,
    };
  }
}
