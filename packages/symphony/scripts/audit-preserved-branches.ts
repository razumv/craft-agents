// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import { GitWorktreeAdapter } from "../src/workspace-adapter";

const [repositoryRootArg, trackerRepository, gitExecutable = "/usr/bin/git"] = process.argv.slice(2);
if (!repositoryRootArg || !trackerRepository) {
  console.error("usage: bun audit-preserved-branches.ts <repository-root> <owner/repository> [absolute-git-executable]");
  process.exit(64);
}

const repositoryRoot = resolve(repositoryRootArg);
const adapter = new GitWorktreeAdapter({
  repositoryRoot,
  workspaceRoot: resolve(repositoryRoot, ".v4-runs"),
  gitExecutable,
  trackerRepository,
});
const records = await adapter.auditPreservedBranches();
const missing = records.filter((record) => !record.durable);
console.log(JSON.stringify({
  repositoryRoot,
  trackerRepository,
  preservedBranches: records.length,
  durableBranches: records.length - missing.length,
  missingRemoteBranches: missing,
}, null, 2));
if (missing.length > 0) process.exitCode = 2;
