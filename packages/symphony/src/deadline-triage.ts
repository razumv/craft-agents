// SPDX-License-Identifier: Apache-2.0

import { parseIssueContract } from "./contract";
import type { IssueContract, MaterialEvent, TrackerIssueSnapshot, WorkflowConfig } from "./domain";

export const DEADLINE_SUCCESSOR_PROPOSAL_SCHEMA = "craft-agent/symphony-deadline-successor-proposal@1" as const;

export interface PreservedBranch {
  branch: string;
  commit: string;
}

export interface DeadlineAcceptanceTrace {
  criterion: string;
  sourceCriterion: string;
  sourceIndex: number;
}

export interface DeadlineSuccessorProposal {
  schema: typeof DEADLINE_SUCCESSOR_PROPOSAL_SCHEMA;
  outcome: "proposed";
  sourceIssueId: string;
  sourceIssueIdentifier: string;
  contractMarkdown: string;
  contract: IssueContract;
  covers: string[];
  remains: string[];
  acceptanceTrace: DeadlineAcceptanceTrace[];
  inheritedIssueBody: string;
  inheritedLedger: MaterialEvent[];
  preservedBranches: PreservedBranch[];
  writes: 0;
}

function successorId(contract: IssueContract): string {
  return `${contract.id}-DEADLINE-SUCCESSOR`;
}

function safeBranchSegment(value: string): string {
  const segment = value.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment) throw new Error("deadline successor source cannot produce a safe branch segment");
  return segment;
}

function yaml(value: string): string {
  return JSON.stringify(value.trim());
}

function yamlItems(values: readonly string[]): string {
  return values.map((value) => `  - ${yaml(value)}`).join("\n");
}

function deadlineFailure(events: readonly MaterialEvent[]): MaterialEvent | null {
  const failures = events.filter((event) => event.kind === "failure" || event.message.startsWith("attempt failed:"));
  const terminal = failures.at(-1) ?? null;
  return terminal && /\b(?:context|turn)-deadline\b/.test(terminal.message) ? terminal : null;
}

function exhaustedAttempt(events: readonly MaterialEvent[], maxAttempts: number): boolean {
  let highest = 0;
  for (const event of events) {
    const match = /\battempt (\d+) (?:atomically claimed|running)\b/.exec(event.message);
    if (match) highest = Math.max(highest, Number(match[1]));
  }
  return highest >= maxAttempts;
}

function markdownFor(
  source: TrackerIssueSnapshot,
  workflow: WorkflowConfig,
  covers: readonly string[],
  remains: readonly string[],
  ledger: readonly MaterialEvent[],
  preserved: readonly PreservedBranch[],
): string {
  const original = source.contract;
  const inheritedBase = preserved.at(-1)?.branch ?? original.baseBranch;
  const requiredBranch = `${workflow.project.branchPrefix}/${safeBranchSegment(source.issue.identifier)}-deadline-successor`;
  const preservedLines = preserved.length
    ? preserved.map(({ branch, commit }) => `- Start from preserved branch \`${branch}\` at commit \`${commit}\`.`)
    : ["- No v4-preserved branch was recorded."];
  return [
    "## Work contract",
    "",
    "```yaml",
    `id: ${yaml(successorId(original))}`,
    `project: ${yaml(original.projectId)}`,
    `repository: ${yaml(original.repository)}`,
    `goal: ${yaml(`Narrow deadline successor for ${source.issue.identifier}: cover only ${covers[0]}`)}`,
    `risk: ${original.risk}`,
    `deployAuthority: ${original.deployAuthority}`,
    `requiredBranch: ${yaml(requiredBranch)}`,
    `baseBranch: ${yaml(inheritedBase)}`,
    `model: ${yaml(original.modelProfile)}`,
    `verificationBudget: ${yaml(original.verificationBudget)}`,
    "acceptance:",
    yamlItems(covers),
    "nonGoals:",
    yamlItems(original.nonGoals),
    ...(original.dependencies.length ? ["dependencies:", yamlItems(original.dependencies)] : []),
    ...(original.ownerDirectiveRefs.length ? ["ownerDirectiveRefs:", yamlItems(original.ownerDirectiveRefs)] : []),
    "```",
    "",
    "## Deadline successor scope",
    "",
    `This successor covers this part of the original contract: ${covers.map((item) => JSON.stringify(item)).join(", ")}.`,
    remains.length
      ? `These parts remain for later successors: ${remains.map((item) => JSON.stringify(item)).join(", ")}.`
      : "No original acceptance criteria remain.",
    "",
    "## Preserved work",
    "",
    ...preservedLines,
    "",
    "## Inherited issue body (verbatim)",
    "",
    source.issue.description ?? "",
    "",
    "## Inherited material ledger (verbatim JSON)",
    "",
    ...ledger.map((event) => JSON.stringify(event)),
  ].join("\n");
}

/**
 * Propose one strictly narrower successor for an exhausted context/turn deadline.
 * Pure and read-only: existing issues and preserved refs are explicit inputs, and
 * the returned `writes: 0` proposal is left for the shared applying half.
 */
export function proposeDeadlineSuccessor(
  source: TrackerIssueSnapshot,
  workflow: WorkflowConfig,
  existingIssues: readonly TrackerIssueSnapshot[] = [],
  preservedBranches: readonly PreservedBranch[] = [],
): DeadlineSuccessorProposal | null {
  if (source.issue.state !== "failed" || source.retry !== null) return null;
  if (!deadlineFailure(source.events)) return null;
  if (!exhaustedAttempt(source.events, workflow.scheduler.maxAttempts)) return null;
  if (source.contract.acceptance.length < 2) return null;

  const id = successorId(source.contract);
  if (existingIssues.some((issue) => issue.contract.id === id)) return null;

  const covers = source.contract.acceptance.slice(0, 1);
  const remains = source.contract.acceptance.slice(1);
  const acceptanceTrace = covers.map((criterion, sourceIndex) => ({
    criterion,
    sourceCriterion: source.contract.acceptance[sourceIndex]!,
    sourceIndex,
  }));
  if (acceptanceTrace.some((trace) => trace.criterion !== trace.sourceCriterion)) {
    throw new Error("deadline successor acceptance is not traceable to the original contract");
  }

  const inheritedLedger = source.events.map((event) => ({ ...event }));
  const preserved = [...preservedBranches]
    .map((entry) => ({ ...entry }))
    .sort((left, right) => left.branch.localeCompare(right.branch) || left.commit.localeCompare(right.commit));
  const contractMarkdown = markdownFor(source, workflow, covers, remains, inheritedLedger, preserved);
  const contract = parseIssueContract(contractMarkdown, `${source.issue.identifier}-deadline-successor`, workflow);
  if (contract.acceptance.length >= source.contract.acceptance.length) {
    throw new Error("deadline successor contract is not strictly narrower than its source");
  }
  if (contract.acceptance.some((criterion) => !source.contract.acceptance.includes(criterion))) {
    throw new Error("deadline successor invented an acceptance criterion");
  }

  return {
    schema: DEADLINE_SUCCESSOR_PROPOSAL_SCHEMA,
    outcome: "proposed",
    sourceIssueId: source.issue.id,
    sourceIssueIdentifier: source.issue.identifier,
    contractMarkdown,
    contract,
    covers,
    remains,
    acceptanceTrace,
    inheritedIssueBody: source.issue.description ?? "",
    inheritedLedger,
    preservedBranches: preserved,
    writes: 0,
  };
}
