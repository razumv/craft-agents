// SPDX-License-Identifier: Apache-2.0

import { lstat, readFile, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { Claim } from "./domain";

export const claimBindingFile = ".craft-protocol-v4-claim.json";

export type WorkspaceTruth =
  | { kind: "absent" }
  | { kind: "bound"; binding: Claim }
  | { kind: "ambiguous"; reason: string };

export interface WorkspaceTruthReader {
  inspect(claim: Claim): Promise<WorkspaceTruth>;
}

/** Read-only filesystem boundary used during startup; it never creates, cleans, or repairs worktrees. */
export class FilesystemWorkspaceTruthReader implements WorkspaceTruthReader {
  readonly #root: string;

  constructor(root: string) {
    this.#root = resolve(root);
    if (!isAbsolute(this.#root)) throw new Error("workspace root must be absolute");
  }

  async inspect(claim: Claim): Promise<WorkspaceTruth> {
    const expected = resolve(claim.workspacePath);
    const rel = relative(this.#root, expected);
    if (rel.startsWith("..") || isAbsolute(rel)) return { kind: "ambiguous", reason: "claim workspace escapes configured root" };
    let stat;
    try {
      stat = await lstat(expected);
    } catch (error) {
      if (isMissing(error)) return { kind: "absent" };
      return { kind: "ambiguous", reason: `workspace stat failed: ${errorMessage(error)}` };
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) return { kind: "ambiguous", reason: "workspace path is not a real directory" };
    try {
      const canonical = await realpath(expected);
      const canonicalRel = relative(this.#root, canonical);
      if (canonicalRel.startsWith("..") || isAbsolute(canonicalRel)) {
        return { kind: "ambiguous", reason: "workspace real path escapes configured root" };
      }
      const raw = JSON.parse(await readFile(resolve(expected, claimBindingFile), "utf8")) as unknown;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        return { kind: "ambiguous", reason: "claim binding file is not an object" };
      }
      return { kind: "bound", binding: raw as Claim };
    } catch (error) {
      return { kind: "ambiguous", reason: `claim binding is unreadable: ${errorMessage(error)}` };
    }
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error as NodeJS.ErrnoException).code === "ENOENT";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function claimBindingsEqual(left: Claim, right: Claim): boolean {
  const keys: (keyof Claim)[] = [
    "issueId", "issueIdentifier", "attempt", "fence", "sessionId", "workspaceId", "workspaceKey",
    "workspacePath", "baseSha", "modelConnection", "modelProfile", "claimedAtMs",
  ];
  return keys.every((key) => left[key] === right[key]);
}
