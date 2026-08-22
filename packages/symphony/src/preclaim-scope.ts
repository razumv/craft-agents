// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import { parseIssueContract } from "./contract";
import type { IssueContract, TrackerIssueSnapshot, WorkflowConfig } from "./domain";

export const PRECLAIM_SCOPE_PROPOSAL_SCHEMA = "craft-agent/symphony-preclaim-scope-proposal@1" as const;

export interface PreclaimScopeProposal {
  schema: typeof PRECLAIM_SCOPE_PROPOSAL_SCHEMA;
  sourceIssueId: string;
  sourceIssueIdentifier: string;
  sourceVersion: number;
  sourceState: "ready" | "cancelled";
  inheritedIssueBody: string;
  acceptanceLimit: number;
  covers: string[];
  remains: string[];
  contract: IssueContract;
  contractMarkdown: string;
}

export type PreclaimScopeApplyResult =
  | { outcome: "applied" | "already-applied"; source: TrackerIssueSnapshot; successor: TrackerIssueSnapshot }
  | { outcome: "refused"; reason: string };

/** Pure deterministic narrowing. Provider writes belong to the tracker adapter. */
export function proposePreclaimScope(
  source: TrackerIssueSnapshot,
  workflow: WorkflowConfig,
): PreclaimScopeProposal | null {
  const limit = workflow.scheduler.executableAcceptanceLimit ?? 1;
  if (!Number.isInteger(limit) || limit < 1) throw new Error("executable acceptance limit must be a positive integer");
  if (source.contract.acceptance.length <= limit) return null;
  if (source.claim || source.retry) return null;

  const covers = source.contract.acceptance.slice(0, limit);
  const remains = source.contract.acceptance.slice(limit);
  const id = `${source.contract.id}-PRECLAIM-${scopeDigest(source.contract.acceptance, limit)}`;
  const reserved = source.issue.state === "cancelled"
    && source.events.some((event) => event.kind === "supersession" && event.successor === id);
  if (source.issue.state !== "ready" && !reserved) return null;
  const requiredBranch = `${workflow.project.branchPrefix}/${safeSegment(source.issue.identifier)}-preclaim`;
  const contractMarkdown = markdownFor(source, id, requiredBranch, covers, remains);
  const contract = parseIssueContract(contractMarkdown, `${source.issue.identifier}-preclaim`, workflow);

  if (canonical(contract.acceptance) !== canonical(covers)) {
    throw new Error("pre-claim successor acceptance does not exactly preserve the bounded source prefix");
  }
  if (contract.acceptance.some((criterion) => !source.contract.acceptance.includes(criterion))) {
    throw new Error("pre-claim successor invented an acceptance criterion");
  }

  return {
    schema: PRECLAIM_SCOPE_PROPOSAL_SCHEMA,
    sourceIssueId: source.issue.id,
    sourceIssueIdentifier: source.issue.identifier,
    sourceVersion: source.version,
    sourceState: source.issue.state as "ready" | "cancelled",
    inheritedIssueBody: source.issue.description ?? "",
    acceptanceLimit: limit,
    covers,
    remains,
    contract,
    contractMarkdown,
  };
}

export function preclaimScopeAttribution(proposal: PreclaimScopeProposal): string {
  return `<!-- craft-agent/symphony-preclaim-scope@1 ${proposal.contract.id} -->\nPre-claim scope successor ${proposal.contract.id} was created from authored source ${proposal.sourceIssueIdentifier}.`;
}

function markdownFor(
  source: TrackerIssueSnapshot,
  id: string,
  requiredBranch: string,
  covers: readonly string[],
  remains: readonly string[],
): string {
  const original = source.contract;
  return [
    "## Work contract",
    "",
    "```yaml",
    `id: ${yaml(id)}`,
    `project: ${yaml(original.projectId)}`,
    `repository: ${yaml(original.repository)}`,
    `goal: ${yaml(original.goal)}`,
    `risk: ${original.risk}`,
    `deployAuthority: ${original.deployAuthority}`,
    `requiredBranch: ${yaml(requiredBranch)}`,
    `baseBranch: ${yaml(original.baseBranch)}`,
    ...(original.dependencies.length
      ? ["dependencies:", ...original.dependencies.map((item) => `  - ${yaml(item)}`)]
      : ["dependencies: []"]),
    ...(original.ownerDirectiveRefs.length
      ? ["ownerDirectiveRefs:", ...original.ownerDirectiveRefs.map((item) => `  - ${yaml(item)}`)]
      : ["ownerDirectiveRefs: []"]),
    `model: ${yaml(original.modelProfile)}`,
    `verificationBudget: ${yaml(original.verificationBudget)}`,
    ...(original.nonGoals.length
      ? ["nonGoals:", ...original.nonGoals.map((item) => `  - ${yaml(item)}`)]
      : ["nonGoals: []"]),
    "acceptance:",
    ...covers.map((item) => `  - ${yaml(item)}`),
    "```",
    "",
    "## Pre-claim scope trace",
    "",
    `This successor contains the first ${covers.length} authored acceptance ${covers.length === 1 ? "criterion" : "criteria"}, verbatim:`,
    ...covers.map((item) => `- ${JSON.stringify(item)}`),
    "",
    "The following authored acceptance criteria remain and are not part of this successor:",
    ...remains.map((item) => `- ${JSON.stringify(item)}`),
    "",
  ].join("\n");
}

function yaml(value: string): string {
  return JSON.stringify(value);
}

function safeSegment(value: string): string {
  const result = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!result) throw new Error("pre-claim source cannot produce a safe branch segment");
  return result;
}

function scopeDigest(acceptance: readonly string[], limit: number): string {
  return createHash("sha256").update(canonical({ acceptance, limit })).digest("hex").slice(0, 12).toUpperCase();
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
