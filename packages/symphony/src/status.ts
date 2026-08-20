// SPDX-License-Identifier: Apache-2.0

import type { LifecycleState, ProjectStatus, TrackerIssueSnapshot } from "./domain";

const nextPoint: Record<LifecycleState, string> = {
  ready: "atomic claim",
  claimed: "session start",
  running: "pull request",
  "pr-open": "review or merge",
  review: "review verdict",
  "owner-gate": "exact owner decision",
  merged: "deployment or completion",
  deployed: "deployment readback",
  done: "complete",
  blocked: "blocker resolution",
  "retry-wait": "bounded retry due time",
  failed: "owner handoff",
  cancelled: "none",
  "preservation-unknown": "preservation proof",
};

function isHeartbeat(event: TrackerIssueSnapshot["events"][number]): boolean {
  if (event.kind !== undefined) return event.kind === "heartbeat";
  // Alpha.1 ledgers did not persist the operation on projected events. Keep their
  // deterministic heartbeat message out of the material lifecycle projection.
  return /^attempt \d+ heartbeat$/i.test(event.message.trim());
}

const RECENT_EVENT_LIMIT = 5;

export function projectStatus(snapshot: TrackerIssueSnapshot): ProjectStatus {
  const material = snapshot.events.filter((event) => !isHeartbeat(event));
  const lastMaterialEvent = material[material.length - 1] ?? null;
  const ownerGateId = snapshot.evidence.ownerGateId ?? null;
  return {
    projectId: snapshot.contract.projectId,
    issueId: snapshot.issue.id,
    issueIdentifier: snapshot.issue.identifier,
    objective: snapshot.contract.goal,
    state: snapshot.issue.state,
    issueClosed: snapshot.issue.closed,
    attempt: snapshot.claim?.attempt ?? snapshot.retry?.attempt ?? null,
    retryDueAtMs: snapshot.issue.state === "retry-wait" ? snapshot.retry?.dueAtMs ?? null : null,
    recentEvents: material.slice(-RECENT_EVENT_LIMIT).map((event) => ({ ...event })),
    branchUrl: snapshot.evidence.branchUrl ?? null,
    prUrl: snapshot.evidence.prUrl ?? null,
    deploymentUrl: snapshot.evidence.deploymentUrl ?? null,
    lastMaterialEvent: lastMaterialEvent ? { ...lastMaterialEvent } : null,
    blocker: snapshot.evidence.blocker
      ?? (snapshot.issue.blockedBy.map((item) => item.identifier ?? item.id ?? "unknown blocker").join(", ") || null),
    nextCompletionPoint: nextPoint[snapshot.issue.state],
    ownerGate: ownerGateId ? {
      id: ownerGateId,
      command: `APPROVE ${ownerGateId}`,
      approveCommand: `APPROVE ${ownerGateId}`,
      rejectCommand: `REJECT ${ownerGateId}: <reason>`,
    } : null,
  };
}

/** Compact, deterministic mobile projection of durable lifecycle evidence only. */
export function compactRunSummary(status: ProjectStatus): string {
  const event = status.lastMaterialEvent;
  return [
    "## Run summary",
    `Issue: ${status.issueIdentifier}`,
    `State: ${status.state}`,
    `Branch / PR: ${status.branchUrl ?? "—"} / ${status.prUrl ?? "—"}`,
    `Last material event: ${event ? `#${event.sequence} @ ${event.atMs} [${event.state}] ${event.message}` : "—"}`,
    `Blocker: ${status.blocker ?? "—"}`,
    `Owner gate: ${status.ownerGate?.id ?? "—"}`,
    `Approve: ${status.ownerGate?.approveCommand ?? "—"}`,
    `Reject: ${status.ownerGate?.rejectCommand ?? "—"}`,
    `Next completion point: ${status.nextCompletionPoint}`,
  ].join("\n");
}
