// SPDX-License-Identifier: Apache-2.0

import { parseIssueContract } from "./contract";
import {
  DEADLINE_SUCCESSOR_PROPOSAL_SCHEMA,
  type DeadlineSuccessorProposal,
} from "./deadline-triage";
import type { GitHubIssueRecord, GitHubTransport, Page } from "./github-transport";
import type { GitHubAdapterConfig } from "./github-adapter";

export type DeadlineSuccessorApplyStep =
  | "preflight"
  | "branches"
  | "issue"
  | "body-readback"
  | "attribution"
  | "attribution-readback"
  | "project"
  | "project-readback"
  | "source-readback"
  | "status"
  | "status-readback"
  | "label"
  | "label-readback";

export interface DeadlineSuccessorIssueReadback {
  id: string;
  number: number;
  identifier: string;
  url: string;
}

interface ApplyProgress {
  writes: number;
  completedSteps: DeadlineSuccessorApplyStep[];
  issue: DeadlineSuccessorIssueReadback | null;
}

export type DeadlineSuccessorApplyReport =
  | { outcome: "refused"; writes: 0; completedSteps: []; reason: string }
  | ({ outcome: "applied" | "already-applied" } & ApplyProgress & { issue: DeadlineSuccessorIssueReadback })
  | ({ outcome: "failed"; failedStep: DeadlineSuccessorApplyStep; error: string } & ApplyProgress);

const attributionPrefix = "<!-- craft-agent/symphony-deadline-successor@1 ";

export function deadlineSuccessorAttribution(proposal: DeadlineSuccessorProposal): string {
  return `${attributionPrefix}${proposal.contract.id} -->\nDeadline successor ${proposal.contract.id} was created by Symphony from failed source ${proposal.sourceIssueIdentifier}.`;
}

/**
 * Resumably apply one pure deadline-successor proposal. Contract id is the
 * durable idempotency key: every retry discovers the provider issue first and
 * continues only the missing verified steps. The ready label is the last write.
 */
export async function applyDeadlineSuccessor(
  proposal: DeadlineSuccessorProposal | null,
  config: GitHubAdapterConfig,
  transport: GitHubTransport,
): Promise<DeadlineSuccessorApplyReport> {
  if (!proposal) return { outcome: "refused", writes: 0, completedSteps: [], reason: "no parser-valid deadline-successor proposal" };

  const progress: ApplyProgress = { writes: 0, completedSteps: [], issue: null };
  const complete = (step: DeadlineSuccessorApplyStep): void => { progress.completedSteps.push(step); };
  const failed = (failedStep: DeadlineSuccessorApplyStep, error: unknown): DeadlineSuccessorApplyReport => ({
    outcome: "failed",
    ...progress,
    completedSteps: [...progress.completedSteps],
    failedStep,
    error: errorMessage(error),
  });

  let source: GitHubIssueRecord;
  let sourceLabels: string[];
  let existing: GitHubIssueRecord | null;
  try {
    assertProposal(proposal, config);
    if (!transport.createIssue || !transport.addIssueToProject) {
      throw new Error("GitHub transport cannot create issues and Project items");
    }
    const records = await collectPages((cursor) => transport.listIssues(config.repository, cursor));
    const sources = records.filter((record) => record.id === proposal.sourceIssueId);
    if (sources.length !== 1) throw new Error(`expected exactly one failed source issue, found ${sources.length}`);
    source = sources[0]!;
    if (source.state !== "OPEN" || source.body !== proposal.inheritedIssueBody) {
      throw new Error("failed source issue body or provider state changed after proposal");
    }
    sourceLabels = await collectPages((cursor) => transport.listLabels(source.id, cursor));

    const matching: GitHubIssueRecord[] = [];
    for (const record of records) {
      try {
        if (parseIssueContract(record.body, `${config.repository}#${record.number}`, config.workflow).id === proposal.contract.id) {
          matching.push(record);
        }
      } catch {
        // Non-contract issues are unrelated to this idempotency key.
      }
    }
    if (matching.length > 1) throw new Error(`successor contract id ${proposal.contract.id} is ambiguous across ${matching.length} issues`);
    existing = matching[0] ?? null;
    if (existing && (existing.state !== "OPEN" || existing.body !== proposal.contractMarkdown)) {
      throw new Error("existing successor contract id has non-exact body or is closed");
    }
    complete("preflight");
  } catch (error) {
    return failed("preflight", error);
  }

  try {
    for (const preserved of proposal.preservedBranches) {
      const branch = await transport.getBranch(config.repository, preserved.branch);
      if (!branch || branch.oid !== preserved.commit) {
        throw new Error(`preserved branch ${preserved.branch} is not provider-visible at ${preserved.commit}`);
      }
    }
    complete("branches");
  } catch (error) {
    return failed("branches", error);
  }

  let successor = existing;
  if (!successor) {
    try {
      const created = await transport.createIssue!(
        config.repository,
        `Deadline successor for ${proposal.sourceIssueIdentifier}`,
        proposal.contractMarkdown,
        [],
      );
      progress.writes += 1;
      successor = {
        ...created,
        title: `Deadline successor for ${proposal.sourceIssueIdentifier}`,
        body: proposal.contractMarkdown,
        state: "OPEN",
        createdAt: "",
        updatedAt: "",
        assigneeId: null,
      };
      complete("issue");
    } catch (error) {
      return failed("issue", error);
    }
  } else {
    complete("issue");
  }
  progress.issue = issueReadback(successor, config.repository);

  try {
    const [readback] = await transport.getIssuesByNodeIds([successor.id]);
    if (!readback || readback.state !== "OPEN" || readback.body !== proposal.contractMarkdown) {
      throw new Error("successor issue body did not read back exactly");
    }
    const contract = parseIssueContract(readback.body, progress.issue.identifier, config.workflow);
    if (canonical(contract) !== canonical(proposal.contract)) throw new Error("successor parsed contract differs from proposal");
    successor = readback;
    complete("body-readback");
  } catch (error) {
    return failed("body-readback", error);
  }

  const attribution = deadlineSuccessorAttribution(proposal);
  try {
    let comments = await collectPages((cursor) => transport.listComments(successor.id, cursor));
    const exact = comments.filter((comment) => comment.body === attribution);
    if (exact.length > 1) throw new Error("successor attribution receipt is duplicated");
    if (exact.length === 0) {
      await transport.appendComment(successor.id, attribution);
      progress.writes += 1;
    }
    complete("attribution");
    comments = await collectPages((cursor) => transport.listComments(successor.id, cursor));
    if (comments.filter((comment) => comment.body === attribution).length !== 1) {
      throw new Error("successor attribution receipt did not read back exactly once");
    }
    complete("attribution-readback");
  } catch (error) {
    return failed(progress.completedSteps.includes("attribution") ? "attribution-readback" : "attribution", error);
  }

  let itemId: string;
  try {
    let items = (await collectPages((cursor) => transport.listProjectItems(successor.id, cursor)))
      .filter((item) => item.projectId === config.projectId);
    if (items.length > 1) throw new Error(`expected at most one configured Project item, found ${items.length}`);
    if (items.length === 0) {
      itemId = await transport.addIssueToProject!(config.projectId, successor.id);
      progress.writes += 1;
    } else {
      itemId = items[0]!.id;
    }
    complete("project");
    items = (await collectPages((cursor) => transport.listProjectItems(successor.id, cursor)))
      .filter((item) => item.projectId === config.projectId);
    if (items.length !== 1 || items[0]!.id !== itemId) {
      throw new Error("configured Project item did not read back exactly once");
    }
    complete("project-readback");
  } catch (error) {
    return failed(progress.completedSteps.includes("project") ? "project-readback" : "project", error);
  }

  // The source readback is deliberately before status/label publication. This
  // operation never mutates the source; a concurrent source change fails closed.
  try {
    const [freshSource] = await transport.getIssuesByNodeIds([source.id]);
    const freshLabels = await collectPages((cursor) => transport.listLabels(source.id, cursor));
    if (!freshSource || freshSource.state !== source.state || freshSource.body !== source.body || !sameLabels(freshLabels, sourceLabels)) {
      throw new Error("failed source issue body, state, or labels changed during successor apply");
    }
    complete("source-readback");
  } catch (error) {
    return failed("source-readback", error);
  }

  const readyOption = config.states.ready.projectStatusOptionId;
  try {
    let values = await collectPages((cursor) => transport.listProjectFieldValues(itemId, cursor));
    const statuses = values.filter((value): value is Extract<typeof value, { kind: "single-select" }> => value.kind === "single-select" && value.fieldId === config.statusFieldId);
    if (statuses.length > 1) throw new Error("configured Project status field is ambiguous");
    if (statuses[0]?.optionId !== readyOption) {
      await transport.updateProjectSingleSelect(config.projectId, itemId, config.statusFieldId, readyOption);
      progress.writes += 1;
    }
    complete("status");
    values = await collectPages((cursor) => transport.listProjectFieldValues(itemId, cursor));
    const exact = values.filter((value) => value.kind === "single-select" && value.fieldId === config.statusFieldId && value.optionId === readyOption);
    if (exact.length !== 1) throw new Error("configured ready Project option did not read back exactly once");
    complete("status-readback");
  } catch (error) {
    return failed(progress.completedSteps.includes("status") ? "status-readback" : "status", error);
  }

  const readyLabel = config.states.ready.label;
  try {
    let labels = await collectPages((cursor) => transport.listLabels(successor.id, cursor));
    if (!labels.includes(readyLabel)) {
      const desired = [...new Set([...labels, ...config.requiredLabels, readyLabel])];
      await transport.replaceLabels(config.repository, successor.number, desired);
      progress.writes += 1;
    }
    complete("label");
    labels = await collectPages((cursor) => transport.listLabels(successor.id, cursor));
    if (!labels.includes(readyLabel) || config.requiredLabels.some((label) => !labels.includes(label))) {
      throw new Error("ready and required labels did not read back exactly");
    }
    complete("label-readback");
  } catch (error) {
    return failed(progress.completedSteps.includes("label") ? "label-readback" : "label", error);
  }

  return {
    outcome: progress.writes === 0 ? "already-applied" : "applied",
    ...progress,
    completedSteps: [...progress.completedSteps],
    issue: progress.issue!,
  };
}

function assertProposal(proposal: DeadlineSuccessorProposal, config: GitHubAdapterConfig): void {
  if (proposal.schema !== DEADLINE_SUCCESSOR_PROPOSAL_SCHEMA || proposal.outcome !== "proposed" || proposal.writes !== 0) {
    throw new Error("deadline-successor proposal envelope is invalid");
  }
  if (proposal.contract.repository !== config.repository) throw new Error("deadline-successor repository does not match adapter repository");
  const parsed = parseIssueContract(proposal.contractMarkdown, `${proposal.sourceIssueIdentifier}-successor`, config.workflow);
  if (canonical(parsed) !== canonical(proposal.contract)) throw new Error("deadline-successor proposal is not parser-valid exactly as supplied");
  if (proposal.acceptanceTrace.length !== proposal.covers.length || proposal.acceptanceTrace.some((trace) => trace.criterion !== trace.sourceCriterion)) {
    throw new Error("deadline-successor acceptance trace is invalid");
  }
}

function issueReadback(record: GitHubIssueRecord, repository: string): DeadlineSuccessorIssueReadback {
  return { id: record.id, number: record.number, identifier: `${repository}#${record.number}`, url: record.url };
}

async function collectPages<T>(read: (cursor: string | null) => Promise<Page<T>>): Promise<T[]> {
  const values: T[] = [];
  let cursor: string | null = null;
  do {
    const page = await read(cursor);
    values.push(...page.nodes);
    cursor = page.nextCursor;
  } while (cursor !== null);
  return values;
}

function sameLabels(left: readonly string[], right: readonly string[]): boolean {
  const normalized = (labels: readonly string[]) => [...new Set(labels)].sort((a, b) => a.localeCompare(b));
  return canonical(normalized(left)) === canonical(normalized(right));
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
