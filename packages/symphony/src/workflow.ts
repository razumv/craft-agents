// SPDX-License-Identifier: Apache-2.0

import { dirname, isAbsolute, resolve } from "node:path";
import {
  lifecycleStates,
  type LifecycleState,
  type RiskTier,
  type VerificationBudget,
  type WorkflowConfig,
  type WorkflowDefinition,
} from "./domain";

function object(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${field} must be an object`);
  }
  return value as Record<string, unknown>;
}

function string(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string`);
  return value.trim();
}

function integer(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`);
  return value as number;
}

function stringArray(value: unknown, field: string): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error(`${field} must be a non-empty string array`);
  return value.map((entry, index) => string(entry, `${field}[${index}]`));
}

function stateArray(value: unknown, field: string): LifecycleState[] {
  return stringArray(value, field).map((state) => {
    if (!lifecycleStates.includes(state as LifecycleState)) throw new Error(`${field} contains unknown state ${state}`);
    return state as LifecycleState;
  });
}

function verificationBudget(value: unknown, risk: RiskTier): VerificationBudget {
  const raw = object(value, `verification.${risk}`);
  const independentReviews = raw.independent_reviews;
  const correctionPasses = raw.correction_passes;
  if (independentReviews !== 0 && independentReviews !== 1) {
    throw new Error(`verification.${risk}.independent_reviews must be 0 or 1`);
  }
  if (correctionPasses !== 0 && correctionPasses !== 1) {
    throw new Error(`verification.${risk}.correction_passes must be 0 or 1`);
  }
  if (typeof raw.owner_gate !== "boolean") throw new Error(`verification.${risk}.owner_gate must be boolean`);
  return {
    budget: string(raw.budget, `verification.${risk}.budget`),
    independentReviews,
    correctionPasses,
    ownerGate: raw.owner_gate,
  };
}

export function parseWorkflow(content: string, workflowPath = resolve("WORKFLOW.md")): WorkflowDefinition {
  let yaml = "";
  let promptTemplate = content.trim();
  if (content.startsWith("---")) {
    const closing = content.indexOf("\n---", 3);
    if (closing < 0) throw new Error("WORKFLOW.md has unterminated YAML front matter");
    yaml = content.slice(content.indexOf("\n") + 1, closing);
    promptTemplate = content.slice(closing + 4).trim();
  }
  if (yaml === "") throw new Error("v4.1 WORKFLOW.md requires YAML front matter");
  if (promptTemplate === "") throw new Error("WORKFLOW.md prompt body must not be empty");

  let parsed: unknown;
  try {
    parsed = Bun.YAML.parse(yaml);
  } catch (error) {
    throw new Error(`invalid WORKFLOW.md YAML: ${error instanceof Error ? error.message : String(error)}`);
  }
  const root = object(parsed, "WORKFLOW.md front matter");
  if (string(root.version, "version") !== "4.1") throw new Error("version must be 4.1");

  const project = object(root.project, "project");
  const tracker = object(root.tracker, "tracker");
  const polling = object(root.polling, "polling");
  const scheduler = object(root.scheduler, "scheduler");
  const workspace = object(root.workspace, "workspace");
  const model = object(root.model, "model");
  const verification = object(root.verification, "verification");

  const repository = string(project.repository, "project.repository");
  if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error("project.repository must be owner/name");
  const trackerKind = string(tracker.kind, "tracker.kind");
  if (trackerKind !== "fake-github" && trackerKind !== "github") {
    throw new Error("tracker.kind must be fake-github or github");
  }
  if (scheduler.wip_limit !== 1) throw new Error("scheduler.wip_limit must be exactly 1");

  const allowedProfiles = stringArray(model.allowed_profiles, "model.allowed_profiles");
  const defaultProfile = string(model.default_profile, "model.default_profile");
  const modelConnection = string(model.connection, "model.connection");
  const modelConnections = model.connections === undefined
    ? undefined
    : stringArray(model.connections, "model.connections");
  const modelConnectionStrategy = model.connection_strategy === undefined
    ? undefined
    : string(model.connection_strategy, "model.connection_strategy");
  if (modelConnectionStrategy !== undefined && modelConnectionStrategy !== "failover" && modelConnectionStrategy !== "balanced") {
    throw new Error('model.connection_strategy must be "failover" or "balanced"');
  }
  if (!allowedProfiles.includes(defaultProfile)) throw new Error("model.default_profile must be allowed");

  const rootPath = string(workspace.root, "workspace.root");
  const workspaceRoot = isAbsolute(rootPath) ? resolve(rootPath) : resolve(dirname(workflowPath), rootPath);
  const retryBaseMs = integer(scheduler.retry_base_ms, "scheduler.retry_base_ms");
  const retryMaxMs = integer(scheduler.retry_max_ms, "scheduler.retry_max_ms");
  const maxRevivals = integer(scheduler.max_revivals, "scheduler.max_revivals");
  const executableAcceptanceLimit = scheduler.executable_acceptance_limit === undefined
    ? 1
    : integer(scheduler.executable_acceptance_limit, "scheduler.executable_acceptance_limit");
  const prOpenStuckCycles = scheduler.pr_open_stuck_cycles === undefined
    ? 3
    : integer(scheduler.pr_open_stuck_cycles, "scheduler.pr_open_stuck_cycles");
  if (maxRevivals < 0) throw new Error("scheduler.max_revivals must be non-negative");
  if (retryMaxMs < retryBaseMs) throw new Error("scheduler.retry_max_ms must be >= retry_base_ms");

  const config: WorkflowConfig = {
    version: "4.1",
    project: {
      id: string(project.id, "project.id"),
      repository,
      baseBranch: string(project.base_branch, "project.base_branch"),
      branchPrefix: string(project.branch_prefix, "project.branch_prefix").replace(/\/+$/, ""),
    },
    tracker: {
      kind: trackerKind,
      activeStates: stateArray(tracker.active_states, "tracker.active_states"),
      terminalStates: stateArray(tracker.terminal_states, "tracker.terminal_states"),
    },
    polling: { intervalMs: integer(polling.interval_ms, "polling.interval_ms") },
    scheduler: {
      wipLimit: 1,
      claimTtlMs: integer(scheduler.claim_ttl_ms, "scheduler.claim_ttl_ms"),
      staleRunMs: integer(scheduler.stale_run_ms, "scheduler.stale_run_ms"),
      maxAttempts: integer(scheduler.max_attempts, "scheduler.max_attempts"),
      executableAcceptanceLimit,
      maxRevivals,
      prOpenStuckCycles,
      retryBaseMs,
      retryMaxMs,
    },
    workspace: { root: workspaceRoot },
    model: {
      connection: modelConnection,
      ...(modelConnections?.length ? { connections: modelConnections } : {}),
      ...(modelConnectionStrategy ? { connectionStrategy: modelConnectionStrategy } : {}),
      defaultProfile,
      allowedProfiles,
    },
    verification: {
      low: verificationBudget(verification.low, "low"),
      medium: verificationBudget(verification.medium, "medium"),
      high: verificationBudget(verification.high, "high"),
    },
  };

  if (config.verification.low.independentReviews !== 0) {
    throw new Error("low-risk workflow must forbid independent review");
  }
  return { config, promptTemplate };
}

export async function loadWorkflow(path: string): Promise<WorkflowDefinition> {
  return parseWorkflow(await Bun.file(path).text(), path);
}
