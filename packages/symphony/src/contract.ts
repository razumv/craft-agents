// SPDX-License-Identifier: Apache-2.0

import {
  lifecycleStates,
  type BlockerRef,
  type DeployAuthority,
  type IssueContract,
  type LifecycleState,
  type NormalizedIssue,
  type RiskTier,
  type WorkflowConfig,
} from "./domain";

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object`);
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function requiredStrings(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty string array`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function optionalStrings(value: unknown, field: string): string[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw new Error(`${field} must be a string array`);
  return value.map((item, index) => requiredString(item, `${field}[${index}]`));
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(value) || Number.isNaN(Date.parse(value))) return null;
  return new Date(value).toISOString();
}

function jsonSafeNativeRef(value: unknown): Record<string, unknown> | null {
  if (value === undefined || value === null) return null;
  try {
    const cloned = JSON.parse(JSON.stringify(value));
    return cloned && typeof cloned === "object" && !Array.isArray(cloned) ? cloned : null;
  } catch {
    return null;
  }
}

function blocker(value: unknown): BlockerRef | null {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;
  const normalized = {
    id: nullableString(raw.id),
    identifier: nullableString(raw.identifier),
    state: nullableString(raw.state),
  };
  return normalized.id || normalized.identifier || normalized.state ? normalized : null;
}

export function normalizeIssue(input: unknown): NormalizedIssue {
  const raw = record(input, "issue");
  if (typeof raw.dispatchable !== "boolean") throw new Error("issue.dispatchable must be explicit boolean");
  const state = requiredString(raw.state, "issue.state").toLowerCase();
  if (!lifecycleStates.includes(state as LifecycleState)) throw new Error(`issue.state is unsupported: ${state}`);

  const labelValues = Array.isArray(raw.labels) ? raw.labels : [];
  const labels = [...new Set(labelValues
    .filter((label): label is string => typeof label === "string")
    .map((label) => label.trim().toLowerCase())
    .filter(Boolean))];
  const blockerValues = Array.isArray(raw.blocked_by ?? raw.blockedBy) ? raw.blocked_by ?? raw.blockedBy : [];
  const blockedBy = (blockerValues as unknown[]).map(blocker).filter((entry): entry is BlockerRef => entry !== null);
  const priority = Number.isInteger(raw.priority) ? raw.priority as number : null;

  return {
    id: requiredString(raw.id, "issue.id"),
    nativeRef: jsonSafeNativeRef(raw.native_ref ?? raw.nativeRef),
    identifier: requiredString(raw.identifier, "issue.identifier"),
    title: requiredString(raw.title, "issue.title"),
    description: nullableString(raw.description),
    priority,
    state: state as LifecycleState,
    branchName: nullableString(raw.branch_name ?? raw.branchName),
    url: nullableString(raw.url),
    assigneeId: nullableString(raw.assignee_id ?? raw.assigneeId),
    labels,
    blockedBy,
    dispatchable: raw.dispatchable,
    createdAt: timestamp(raw.created_at ?? raw.createdAt),
    updatedAt: timestamp(raw.updated_at ?? raw.updatedAt),
  };
}

function extractContractYaml(markdown: string): unknown {
  const fences = markdown.matchAll(/```ya?ml\s*\n([\s\S]*?)```/gi);
  for (const fence of fences) {
    let candidate: unknown;
    try {
      candidate = Bun.YAML.parse(fence[1]);
    } catch (error) {
      throw new Error(`invalid issue contract YAML: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (candidate && typeof candidate === "object" && !Array.isArray(candidate) && "goal" in candidate) return candidate;
  }
  throw new Error("issue description has no YAML work contract");
}

function branchSegment(identifier: string): string {
  const segment = identifier.toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
  if (!segment) throw new Error("issue identifier cannot produce a safe branch segment");
  return segment;
}

export function parseIssueContract(
  markdown: string,
  issueIdentifier: string,
  workflow: WorkflowConfig,
): IssueContract {
  const raw = record(extractContractYaml(markdown), "work contract");
  const risk = requiredString(raw.risk, "contract.risk") as RiskTier;
  if (!["low", "medium", "high"].includes(risk)) throw new Error(`contract.risk is unsupported: ${risk}`);
  const deployAuthority = requiredString(
    raw.deployAuthority ?? raw.deploy_authority,
    "contract.deployAuthority",
  ) as DeployAuthority;
  if (!["none", "dev", "production-gated"].includes(deployAuthority)) {
    throw new Error(`contract.deployAuthority is unsupported: ${deployAuthority}`);
  }

  const modelProfile = requiredString(raw.model, "contract.model");
  if (!workflow.model.allowedProfiles.includes(modelProfile) || !/^pi\/gpt-/i.test(modelProfile)) {
    throw new Error(`contract.model is not an allowed Codex profile: ${modelProfile}`);
  }
  const verificationBudget = requiredString(
    raw.verificationBudget ?? raw.verification_budget,
    "contract.verificationBudget",
  );
  if (verificationBudget !== workflow.verification[risk].budget) {
    throw new Error(`contract.verificationBudget does not match ${risk}-risk policy`);
  }

  const repository = nullableString(raw.repository) ?? workflow.project.repository;
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error("contract.repository must be owner/name");
  return {
    id: requiredString(raw.id, "contract.id"),
    projectId: nullableString(raw.project ?? raw.projectId ?? raw.project_id) ?? workflow.project.id,
    repository,
    goal: requiredString(raw.goal, "contract.goal"),
    acceptance: requiredStrings(raw.acceptance, "contract.acceptance"),
    nonGoals: requiredStrings(raw.nonGoals ?? raw.non_goals, "contract.nonGoals"),
    risk,
    deployAuthority,
    requiredBranch: nullableString(raw.requiredBranch ?? raw.required_branch)
      ?? `${workflow.project.branchPrefix}/${branchSegment(issueIdentifier)}`,
    baseBranch: nullableString(raw.baseBranch ?? raw.base_branch) ?? workflow.project.baseBranch,
    dependencies: optionalStrings(raw.dependencies ?? raw.requires, "contract.dependencies"),
    ownerDirectiveRefs: optionalStrings(
      raw.ownerDirectiveRefs ?? raw.owner_directive_refs,
      "contract.ownerDirectiveRefs",
    ),
    modelProfile,
    verificationBudget,
  };
}
