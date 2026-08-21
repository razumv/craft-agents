// SPDX-License-Identifier: Apache-2.0

import type { IssueContract } from "./domain";

export const ciRepairCauses = ["contract-work", "earlier-merge", "stale-check-expectation", "infrastructure"] as const;
export type CiRepairCause = (typeof ciRepairCauses)[number];

/** Exact failure evidence read from the provider before a repair may be proposed. */
export interface CiFailureDetail {
  pullRequestId: string;
  pullRequestUrl: string;
  headBranch: string;
  headSha: string;
  checkName: string;
  checkUrl: string;
  /** The command printed by the failed provider step, not a locally reconstructed approximation. */
  command: string;
  /** Verbatim failed-step log output. */
  output: string;
}

export type CiRepairEffect =
  | "fix-contract-work"
  | "fix-earlier-merge"
  | "correct-stale-expectation"
  | "weaken-assertion"
  | "disable-check"
  | "runner-or-host-change";

export type CiCheckImpact = "none" | "strengthen" | "correct-exact-stale-expectation";

export interface CiRepairProposal {
  cause: CiRepairCause;
  diagnosis: string;
  effect: CiRepairEffect;
  /** Machine-checked treatment of test/check files; prose cannot override it. */
  checkImpact: CiCheckImpact;
  touchedPaths: string[];
  /** Unified diff proposed for this attempt. Empty for infrastructure handoff. */
  patch: string;
  /** Frozen readback of the original contract acceptance criteria. */
  originalAcceptance: string[];
  /** Required on attempt two: what the new evidence proved attempt one got wrong. */
  previousMistake?: string;
}

export interface CiRepairAttempt {
  attempt: 1 | 2;
  headSha: string;
  checkName: string;
  command: string;
  output: string;
  cause: Exclude<CiRepairCause, "infrastructure">;
  diagnosis: string;
  touchedPaths: string[];
  previousMistake: string | null;
}

const attemptRecordPrefix = "<!-- craft-protocol-v4:ci-repair-attempt\n";
const attemptRecordSuffix = "\n-->";
const attemptRecordSchema = "craft-protocol/v4/ci-repair-attempt@1";

export interface CiRepairAttemptRecord {
  schema: typeof attemptRecordSchema;
  issueId: string;
  pullRequestId: string;
  attempt: CiRepairAttempt;
}

export function ciRepairAttemptComment(issueId: string, pullRequestId: string, attempt: CiRepairAttempt): string {
  if (!issueId.trim() || !pullRequestId.trim()) throw new Error("CI repair attempt identity must not be blank");
  const record: CiRepairAttemptRecord = { schema: attemptRecordSchema, issueId, pullRequestId, attempt };
  return `${attemptRecordPrefix}${JSON.stringify(record)}${attemptRecordSuffix}`;
}

export function parseCiRepairAttemptComment(body: string): CiRepairAttemptRecord | null {
  if (!body.startsWith(attemptRecordPrefix) || !body.endsWith(attemptRecordSuffix)) return null;
  let value: unknown;
  try {
    value = JSON.parse(body.slice(attemptRecordPrefix.length, -attemptRecordSuffix.length));
  } catch {
    throw new Error("CI repair attempt record contains invalid JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CI repair attempt record is invalid");
  const record = value as Partial<CiRepairAttemptRecord>;
  if (record.schema !== attemptRecordSchema || typeof record.issueId !== "string" || typeof record.pullRequestId !== "string") {
    throw new Error("CI repair attempt record has an invalid identity or schema");
  }
  const attempt = record.attempt as Partial<CiRepairAttempt> | undefined;
  if (
    !attempt || (attempt.attempt !== 1 && attempt.attempt !== 2)
    || typeof attempt.headSha !== "string" || typeof attempt.checkName !== "string"
    || typeof attempt.command !== "string" || typeof attempt.output !== "string"
    || !["contract-work", "earlier-merge", "stale-check-expectation"].includes(String(attempt.cause))
    || typeof attempt.diagnosis !== "string" || !Array.isArray(attempt.touchedPaths)
    || !attempt.touchedPaths.every((path) => typeof path === "string")
    || (attempt.previousMistake !== null && typeof attempt.previousMistake !== "string")
    || (attempt.attempt === 1 && attempt.previousMistake !== null)
    || (attempt.attempt === 2 && !attempt.previousMistake?.trim())
  ) throw new Error("CI repair attempt record has an invalid payload");
  return record as CiRepairAttemptRecord;
}

export type CiRepairDecision =
  | { action: "repair"; attempt: 1 | 2; evidence: CiFailureDetail; proposal: CiRepairProposal; prompt: string }
  | { action: "handover"; reason: string; evidence: CiFailureDetail | null; diagnoses: string[] };

export interface CiRepairInput {
  contract: IssueContract;
  failure: CiFailureDetail | null;
  proposal: CiRepairProposal | null;
  attempts: readonly CiRepairAttempt[];
}

const forbiddenPatchPatterns: readonly [RegExp, string][] = [
  [/^[-+]\s*[^\n]*(?:\.skip\s*\(|\bskip\s*:\s*true|@Disabled\b|pytest\.mark\.skip|test\.skip\s*\()/im, "skips a check or test"],
  [/^[-+]\s*[^\n]*(?:continue-on-error\s*:\s*true|allow_failure\s*:\s*true|if\s*:\s*failure\(\)|\|\|\s*true\b)/im, "adds a passing exception"],
  [/^[-+]\s*[^\n]*(?:pending\s*:\s*true|neutral\b|mark.*pending)/im, "marks a check pending or non-failing"],
];

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function handover(reason: string, evidence: CiFailureDetail | null, attempts: readonly CiRepairAttempt[]): CiRepairDecision {
  return { action: "handover", reason, evidence, diagnoses: attempts.map((attempt) => attempt.diagnosis) };
}

function validateEvidence(failure: CiFailureDetail): string | null {
  for (const [field, value] of Object.entries(failure)) {
    if (typeof value !== "string" || !value.trim()) return `provider failure detail is missing ${field}`;
  }
  return null;
}

interface PatchSection { path: string; removed: string[]; added: string[] }

function patchSections(patch: string): PatchSection[] | null {
  const lines = patch.split(/\r?\n/);
  const sections: PatchSection[] = [];
  let current: PatchSection | null = null;
  for (const line of lines) {
    const header = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
    if (header) {
      if (header[1] !== header[2]) return null;
      current = { path: header[1]!, removed: [], added: [] };
      sections.push(current);
      continue;
    }
    if (!current) continue;
    if (line.startsWith("-") && !line.startsWith("---")) current.removed.push(line.slice(1));
    if (line.startsWith("+") && !line.startsWith("+++")) current.added.push(line.slice(1));
  }
  return sections.length ? sections : null;
}

function checkPath(path: string): boolean {
  return /(?:^|\/)(?:\.github\/workflows|tests?|__tests__)(?:\/|$)|\.(?:spec|test)\.[cm]?[jt]sx?$/.test(path);
}

function literalShape(line: string): string {
  return line
    .replace(/(["'`])(?:\\.|(?!\1).)*\1/g, "<literal>")
    .replace(/\b(?:0x[\da-f]+|\d+(?:\.\d+)?)\b/gi, "<literal>")
    .replace(/\s+/g, " ")
    .trim();
}

function validateCheckImpact(proposal: CiRepairProposal, sections: readonly PatchSection[]): string | null {
  if (!["none", "strengthen", "correct-exact-stale-expectation"].includes(proposal.checkImpact)) {
    return "repair refused: check impact is absent or invalid";
  }
  const protectedSections = sections.filter((section) => checkPath(section.path));
  if (proposal.checkImpact === "none") {
    return protectedSections.length ? "repair refused: proposal changes a check/test while declaring no check impact" : null;
  }
  if (proposal.checkImpact === "strengthen") {
    return protectedSections.some((section) => section.removed.some((line) => line.trim()))
      ? "repair refused: a strengthening repair removes existing check/test content"
      : null;
  }
  if (
    proposal.cause !== "stale-check-expectation"
    || protectedSections.length === 0
    || protectedSections.length !== sections.length
  ) {
    return "repair refused: exact expectation correction requires a stale-check diagnosis and a check/test path";
  }
  for (const section of protectedSections) {
    if (section.removed.length !== section.added.length || section.removed.length === 0) {
      return "repair refused: stale expectation correction must replace exact lines one-for-one";
    }
    for (let index = 0; index < section.removed.length; index += 1) {
      if (literalShape(section.removed[index]!) !== literalShape(section.added[index]!)) {
        return "repair refused: stale expectation correction changes behavior rather than exact literals";
      }
    }
  }
  return null;
}

function validateProposal(contract: IssueContract, failure: CiFailureDetail, proposal: CiRepairProposal, attempt: 1 | 2): string | null {
  if (!sameStrings(proposal.originalAcceptance, contract.acceptance)) {
    return "repair refused: the original contract acceptance criteria changed";
  }
  if (failure.headBranch !== contract.requiredBranch) {
    return `repair refused: pull request branch ${failure.headBranch} is not the lane-owned branch ${contract.requiredBranch}`;
  }
  if (!ciRepairCauses.includes(proposal.cause)) return "repair refused: diagnosis cause is invalid";
  if (!proposal.diagnosis.trim()) return "repair refused: diagnosis is blank";
  if (proposal.cause === "infrastructure") return "infrastructure is outside the repository";
  if (proposal.touchedPaths.length === 0 || proposal.touchedPaths.some((path) => !path.trim() || path.startsWith("/") || path.includes(".."))) {
    return "repair refused: touched paths are empty or escape the repository";
  }
  if (!proposal.patch.trim()) return "repair refused: repository repair has no proposed patch";
  const sections = patchSections(proposal.patch);
  if (!sections) return "repair refused: proposed patch lacks exact per-file diff headers";
  const declared = [...new Set(proposal.touchedPaths)].sort();
  const actual = [...new Set(sections.map((section) => section.path))].sort();
  if (!sameStrings(declared, actual)) return "repair refused: proposed patch touches paths outside its diagnosis";
  if (proposal.effect === "weaken-assertion") return "repair refused: proposal only weakens an assertion";
  const checkImpactError = validateCheckImpact(proposal, sections);
  if (checkImpactError) return checkImpactError;
  if (proposal.effect === "disable-check") return "repair refused: proposal disables a check";
  if (proposal.effect === "runner-or-host-change") return "repair refused: runner or host state is outside this contract";
  const expectedEffect: Record<Exclude<CiRepairCause, "infrastructure">, CiRepairEffect> = {
    "contract-work": "fix-contract-work",
    "earlier-merge": "fix-earlier-merge",
    "stale-check-expectation": "correct-stale-expectation",
  };
  if (proposal.effect !== expectedEffect[proposal.cause]) {
    return `repair refused: diagnosis names ${proposal.cause} but the proposed change targets ${proposal.effect}`;
  }
  for (const [pattern, reason] of forbiddenPatchPatterns) {
    if (pattern.test(proposal.patch)) return `repair refused: proposed patch ${reason}`;
  }
  // Deleting a workflow/test file is a check deletion even when no skip token is present.
  if (/^deleted file mode /m.test(proposal.patch) && proposal.touchedPaths.some((path) => /(?:^|\/)(?:\.github\/workflows|tests?|__tests__)(?:\/|$)/.test(path))) {
    return "repair refused: proposed patch deletes a check or test";
  }
  if (attempt === 2 && !proposal.previousMistake?.trim()) {
    return "repair refused: attempt two must state what attempt one got wrong";
  }
  return null;
}

/**
 * Fail-closed decision boundary. It does not execute commands or mutate a branch;
 * only a returned `repair` decision may be handed to a repository worker.
 */
export function decideCiRepair(input: CiRepairInput): CiRepairDecision {
  if (!input.failure) return handover("provider reported a failing rollup without exact failure detail; no repair attempted", null, input.attempts);
  const evidenceError = validateEvidence(input.failure);
  if (evidenceError) return handover(`${evidenceError}; no repair attempted`, input.failure, input.attempts);
  if (input.attempts.length >= 2) {
    return handover("two CI repair attempts were already consumed", input.failure, input.attempts);
  }
  if (!input.proposal) return handover("no grounded diagnosis was supplied; no repair attempted", input.failure, input.attempts);
  if (input.proposal.cause === "infrastructure") {
    return handover(`infrastructure failure cannot be fixed from the repository: ${input.proposal.diagnosis.trim()}`, input.failure, input.attempts);
  }
  const attempt = (input.attempts.length + 1) as 1 | 2;
  const refusal = validateProposal(input.contract, input.failure, input.proposal, attempt);
  if (refusal) return handover(refusal, input.failure, input.attempts);
  return {
    action: "repair",
    attempt,
    evidence: input.failure,
    proposal: structuredClone(input.proposal),
    prompt: buildCiRepairPrompt(input.contract, input.failure, input.proposal, input.attempts),
  };
}

export function recordCiRepairAttempt(decision: Extract<CiRepairDecision, { action: "repair" }>): CiRepairAttempt {
  return {
    attempt: decision.attempt,
    headSha: decision.evidence.headSha,
    checkName: decision.evidence.checkName,
    command: decision.evidence.command,
    output: decision.evidence.output,
    cause: decision.proposal.cause as Exclude<CiRepairCause, "infrastructure">,
    diagnosis: decision.proposal.diagnosis.trim(),
    touchedPaths: [...decision.proposal.touchedPaths],
    previousMistake: decision.proposal.previousMistake?.trim() || null,
  };
}

function buildCiRepairPrompt(
  contract: IssueContract,
  failure: CiFailureDetail,
  proposal: CiRepairProposal,
  attempts: readonly CiRepairAttempt[],
): string {
  const prior = attempts.length
    ? `\n## Previous repair diagnosis\n${attempts.map((item) => `Attempt ${item.attempt}: ${item.diagnosis}`).join("\n")}\n\nWhat it got wrong: ${proposal.previousMistake}`
    : "";
  return `<!-- craft-protocol-v4:ci-repair ${attempts.length + 1} -->
# CI repair only

Do not re-run or reinterpret the original work contract. Its acceptance criteria remain frozen:
${contract.acceptance.map((item) => `- ${item}`).join("\n")}

Provider failure recorded before this change:
- check: ${failure.checkName}
- URL: ${failure.checkUrl}
- head: ${failure.headSha}
- command: ${failure.command}

\`\`\`text
${failure.output}
\`\`\`

Diagnosis (${proposal.cause}): ${proposal.diagnosis}
Touch only: ${proposal.touchedPaths.join(", ")}.${prior}

Apply only the validated patch on ${contract.requiredBranch}. Do not delete, skip, pend, except, or loosen a check; do not install anything or alter runner/host state. Commit and push the repair, then report the diagnosis, exact files, command run, and result.`;
}
