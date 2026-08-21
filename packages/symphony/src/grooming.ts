// SPDX-License-Identifier: Apache-2.0

import { parseIssueContract } from "./contract";
import type { IssueContract, RiskTier, WorkflowConfig } from "./domain";
import { compareForDispatch } from "./scheduler";
import type { TrackerBacklogIssue } from "./tracker";

export const GROOMING_PROPOSAL_SCHEMA = "craft-agent/symphony-grooming-proposal@1" as const;

/**
 * Deterministic risk rubric for read-only grooming.
 *
 * 1. High: credentials/secrets, authentication/authorization, payments/billing,
 *    data deletion/destructive operations, or anything described as irreversible.
 * 2. Low: the issue explicitly limits itself to documentation or tests/fixtures.
 * 3. Medium: every other executable change.
 *
 * The high rule is evaluated first and cannot be downgraded by a low-risk label.
 */
export const GROOMING_RISK_RUBRIC = {
  high: "credentials, secrets, authentication, authorization, payments, billing, data deletion, destructive operations, or irreversible effects",
  low: "explicitly documentation-only or tests/fixtures-only",
  medium: "all other executable changes",
} as const;

export interface AcceptanceTrace {
  criterion: string;
  sourceSentence: string;
  sourceLine: number;
}

export type GroomingRefusalRelation = "blocked-by" | "parent" | "prerequisite-label" | "grounding" | "no-candidate";

export interface GroomingRefusal {
  relation: GroomingRefusalRelation;
  message: string;
  missing?: string[];
}

export interface GroomingProposalBase {
  schema: typeof GROOMING_PROPOSAL_SCHEMA;
  repository: string;
  candidate: TrackerBacklogIssue | null;
  writes: 0;
}

export interface ProposedGroomingContract extends GroomingProposalBase {
  outcome: "proposed";
  candidate: TrackerBacklogIssue;
  contractMarkdown: string;
  contract: IssueContract;
  acceptanceTrace: AcceptanceTrace[];
  riskAssignment: { risk: RiskTier; rule: keyof typeof GROOMING_RISK_RUBRIC; evidence: string };
  verificationBudget: string;
}

export interface RefusedGroomingContract extends GroomingProposalBase {
  outcome: "refused";
  refusal: GroomingRefusal;
}

export type GroomingProposal = ProposedGroomingContract | RefusedGroomingContract;

export type GroomingApplyStep = "preflight" | "body" | "readback" | "attribution" | "status" | "label";

export type GroomingApplyReport =
  | { outcome: "refused"; writes: 0; reason: string }
  | { outcome: "already-present"; writes: 0; issueIdentifier: string }
  | { outcome: "lifecycle-present"; writes: 0; issueIdentifier: string; labels: string[] }
  | { outcome: "applied"; writes: 4; issueIdentifier: string; baselineSha: string }
  | { outcome: "failed"; writes: number; issueIdentifier: string; step: GroomingApplyStep; error: string };

/** The exact body persisted by apply: original backlog authorship plus the grounded contract. */
export function appliedGroomingBody(original: string, contractMarkdown: string): string {
  return [original.trimEnd(), contractMarkdown.trim()].filter(Boolean).join("\n\n");
}

/** Attribution is deliberately human-readable and carries the immutable repository baseline. */
export function groomingAttributionComment(issueIdentifier: string, repository: string, baselineSha: string): string {
  return `Contract authored by Symphony grooming from backlog issue ${issueIdentifier} against repository ${repository} baseline ${baselineSha}.`;
}

type SectionName = "goal" | "acceptance" | "nonGoals" | null;
type SourcedLine = { text: string; line: number };

function refusal(
  repository: string,
  candidate: TrackerBacklogIssue | null,
  relation: GroomingRefusalRelation,
  message: string,
  missing?: string[],
): RefusedGroomingContract {
  return {
    schema: GROOMING_PROPOSAL_SCHEMA,
    repository,
    candidate,
    outcome: "refused",
    refusal: { relation, message, ...(missing?.length ? { missing } : {}) },
    writes: 0,
  };
}

function heading(line: string): SectionName {
  const normalized = line.replace(/^\s{0,3}#{1,6}\s+/, "").replace(/:\s*$/, "").trim().toLowerCase();
  if (/^(goal|objective|desired outcome)$/.test(normalized)) return "goal";
  if (/^(acceptance|acceptance criteria|success criteria)$/.test(normalized)) return "acceptance";
  if (/^(non-?goals?|out of scope)$/.test(normalized)) return "nonGoals";
  return null;
}

function issueSections(markdown: string): Record<Exclude<SectionName, null>, SourcedLine[]> {
  const sections = { goal: [] as SourcedLine[], acceptance: [] as SourcedLine[], nonGoals: [] as SourcedLine[] };
  let current: SectionName = null;
  for (const [index, raw] of markdown.split(/\r?\n/).entries()) {
    if (/^\s{0,3}#{1,6}\s+/.test(raw)) {
      current = heading(raw);
      continue;
    }
    if (!current) continue;
    const list = /^\s*(?:[-*+] |\d+[.)]\s+)(.+?)\s*$/.exec(raw);
    if (list) sections[current].push({ text: list[1]!, line: index + 1 });
    else if (current === "goal" && raw.trim()) sections.goal.push({ text: raw.trim(), line: index + 1 });
  }
  return sections;
}

function falsifiable(sentence: string): boolean {
  if (/^(make|improve|enhance|support|handle|fix)\s+(it|things?|stuff|better|properly)\.?$/i.test(sentence.trim())) return false;
  return /\b(accepts?|returns?|rejects?|refuses?|writes?|reads?|selects?|orders?|sorts?|parses?|records?|maps?|matches?|equals?|contains?|excludes?|prevents?|never|must|is|are|has|have|fails?|passes?|remains?|produces?|assigns?|states?|asserts?)\b/i.test(sentence);
}

function prerequisiteLabel(labels: readonly string[]): string | null {
  return labels.find((label) => /(^|[:/\s-])prerequisite($|[:/\s-])/i.test(label.trim())) ?? null;
}

function assignRisk(issue: TrackerBacklogIssue): ProposedGroomingContract["riskAssignment"] {
  const text = `${issue.title}\n${issue.description}\n${issue.labels.join("\n")}`;
  const high = /\b(credentials?|secrets?|tokens?|passwords?|auth(?:entication|orization)?|payments?|billing|data\s+delet(?:e|ion)|destructive|irreversible)\b/i.exec(text);
  if (high) return { risk: "high", rule: "high", evidence: high[0] };
  const lowOnly = /\b(documentation|docs?|tests?|fixtures?)\s*[- ]only\b/i.exec(text);
  if (lowOnly) return { risk: "low", rule: "low", evidence: lowOnly[0] };
  return { risk: "medium", rule: "medium", evidence: "default executable-change tier" };
}

function yaml(value: string): string {
  return JSON.stringify(value.trim());
}

/** Fail closed if any proposed criterion is not the exact recorded issue line. */
export function assertGroundedAcceptance(issueDescription: string, traces: readonly AcceptanceTrace[]): void {
  const lines = issueDescription.split(/\r?\n/);
  for (const trace of traces) {
    const raw = lines[trace.sourceLine - 1];
    const authored = raw === undefined
      ? null
      : /^\s*(?:[-*+] |\d+[.)]\s+)(.+?)\s*$/.exec(raw)?.[1] ?? raw.trim();
    if (!authored || trace.criterion !== trace.sourceSentence || trace.sourceSentence !== authored) {
      throw new Error(`grooming acceptance criterion is not traceable to issue source line ${trace.sourceLine}`);
    }
  }
}

function contractMarkdown(
  issue: TrackerBacklogIssue,
  workflow: WorkflowConfig,
  goal: string,
  acceptance: readonly string[],
  nonGoals: readonly string[],
  risk: RiskTier,
): string {
  const items = (values: readonly string[]) => values.map((value) => `  - ${yaml(value)}`).join("\n");
  return [
    "## Work contract",
    "",
    "```yaml",
    `id: ${yaml(`GROOM-${issue.identifier}`)}`,
    `repository: ${yaml(workflow.project.repository)}`,
    `goal: ${yaml(goal)}`,
    `risk: ${risk}`,
    "deployAuthority: none",
    `model: ${yaml(workflow.model.defaultProfile)}`,
    `verificationBudget: ${yaml(workflow.verification[risk].budget)}`,
    "acceptance:",
    items(acceptance),
    "nonGoals:",
    items(nonGoals),
    "```",
  ].join("\n");
}

/**
 * Select exactly one backlog issue by the upstream order and produce either a
 * parser-valid executable contract or an exact refusal. This function is pure:
 * it has no tracker/transport capability and therefore cannot write anywhere.
 */
export function proposeBacklogGrooming(
  repository: string,
  backlog: readonly TrackerBacklogIssue[],
  workflow: WorkflowConfig,
): GroomingProposal {
  if (repository !== workflow.project.repository) {
    throw new Error("grooming repository must match workflow project repository");
  }
  const candidate = backlog
    .map((issue) => ({ issue }))
    .sort(compareForDispatch)[0]?.issue ?? null;
  if (!candidate) return refusal(repository, null, "no-candidate", `repository ${repository} has no open unmanaged backlog issue`);

  const openBlocker = candidate.blockedBy.find((blocker) => blocker.state === "OPEN");
  if (openBlocker) {
    return refusal(repository, candidate, "blocked-by", `blocked-by relation ${openBlocker.identifier} is open`);
  }
  if (candidate.parent?.state === "OPEN") {
    return refusal(repository, candidate, "parent", `parent relation ${candidate.parent.identifier} is open`);
  }
  const prerequisite = prerequisiteLabel(candidate.labels);
  if (prerequisite) {
    return refusal(repository, candidate, "prerequisite-label", `prerequisite label ${JSON.stringify(prerequisite)} is present`);
  }

  const sections = issueSections(candidate.description);
  const unsupportedAcceptance = sections.acceptance.filter((entry) => !falsifiable(entry.text));
  const groundedAcceptance = sections.acceptance.filter((entry) => falsifiable(entry.text));
  const missing: string[] = [];
  if (sections.acceptance.length === 0) missing.push("an explicit Acceptance Criteria section with issue-authored criteria");
  else if (groundedAcceptance.length === 0) missing.push("at least one falsifiable acceptance criterion with an observable outcome");
  else if (unsupportedAcceptance.length > 0) {
    missing.push(`a falsifiable observable outcome for every acceptance criterion (unsupported: ${unsupportedAcceptance.map((entry) => JSON.stringify(entry.text)).join(", ")})`);
  }
  if (sections.nonGoals.length === 0) missing.push("an explicit Non-goals or Out of scope section");
  if (missing.length) {
    return refusal(repository, candidate, "grounding", `issue ${candidate.identifier} cannot ground an executable contract: missing ${missing.join("; ")}`, missing);
  }

  const goal = sections.goal[0]?.text ?? candidate.title;
  const traces = groundedAcceptance.map((entry) => ({
    criterion: entry.text,
    sourceSentence: entry.text,
    sourceLine: entry.line,
  }));
  // A criterion that is not the exact issue-authored sentence is a defect.
  assertGroundedAcceptance(candidate.description, traces);
  const riskAssignment = assignRisk(candidate);
  const markdown = contractMarkdown(
    candidate,
    workflow,
    goal,
    traces.map((trace) => trace.criterion),
    sections.nonGoals.map((entry) => entry.text),
    riskAssignment.risk,
  );
  // Parse with the real ingestion parser before exposing the proposal. This is
  // the fail-fast boundary that prevents a parser-rejected proposal existing.
  const contract = parseIssueContract(markdown, candidate.identifier, workflow);
  return {
    schema: GROOMING_PROPOSAL_SCHEMA,
    repository,
    candidate,
    outcome: "proposed",
    contractMarkdown: markdown,
    contract,
    acceptanceTrace: traces,
    riskAssignment,
    verificationBudget: workflow.verification[riskAssignment.risk].budget,
    writes: 0,
  };
}
