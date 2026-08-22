// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import {
  GROOMING_CANDIDATE_LIMIT,
  loadWorkflow,
  proposeBacklogGrooming,
  type TrackerBacklogIssue,
} from "../src";

const [statusPath, projectId] = process.argv.slice(2);
if (!statusPath || !projectId) {
  throw new Error("usage: bun packages/symphony/scripts/measure-grooming-walk.ts <symphony-status.json> <project-id>");
}

const status = await Bun.file(statusPath).json() as {
  projects?: Array<{
    projectId?: string;
    repository?: string;
    snapshot?: { backlog?: TrackerBacklogIssue[] };
  }>;
};
const project = status.projects?.find((candidate) => candidate.projectId === projectId);
if (!project?.repository || !project.snapshot?.backlog) {
  throw new Error(`status has no provider-derived backlog for project ${projectId}`);
}

// Groundability and ordering are independent of lane-specific execution paths.
// The fixture supplies a parser-valid policy shell; the measured repository and
// provider-derived candidate bodies, labels, relations, and timestamps come
// from the exact live status readback passed by the operator.
const fixture = (await loadWorkflow(resolve(import.meta.dir, "../tests/fixtures/WORKFLOW.md"))).config;
const workflow = { ...fixture, project: { ...fixture.project, repository: project.repository } };
let remaining = [...project.snapshot.backlog];
let examined = 0;
let firstGroomable: string | null = null;
const relationCounts: Record<string, number> = {};
const firstRefusals: Array<{ issueIdentifier: string; relation: string; reason: string }> = [];

while (remaining.length > 0) {
  const proposal = proposeBacklogGrooming(project.repository, remaining, workflow);
  if (!proposal.candidate) break;
  examined += 1;
  if (proposal.outcome === "proposed") {
    firstGroomable = proposal.candidate.identifier;
    break;
  }
  relationCounts[proposal.refusal.relation] = (relationCounts[proposal.refusal.relation] ?? 0) + 1;
  if (firstRefusals.length < GROOMING_CANDIDATE_LIMIT) {
    firstRefusals.push({
      issueIdentifier: proposal.candidate.identifier,
      relation: proposal.refusal.relation,
      reason: proposal.refusal.message,
    });
  }
  remaining = remaining.filter((candidate) => candidate.id !== proposal.candidate!.id);
}

console.log(JSON.stringify({
  projectId,
  repository: project.repository,
  observedBacklogIssues: project.snapshot.backlog.length,
  candidateLimit: GROOMING_CANDIDATE_LIMIT,
  examinedToFirstGroomableOrExhaustion: examined,
  firstGroomable,
  cyclesToFirstGroomable: firstGroomable ? Math.ceil(examined / GROOMING_CANDIDATE_LIMIT) : null,
  cyclesToExhaustion: firstGroomable ? null : Math.ceil(examined / GROOMING_CANDIDATE_LIMIT),
  priorOneCandidateCyclesToSamePoint: examined,
  relationCounts,
  firstRefusals,
}, null, 2));
