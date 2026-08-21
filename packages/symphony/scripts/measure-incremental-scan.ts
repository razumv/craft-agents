// SPDX-License-Identifier: Apache-2.0

import { resolve } from "node:path";
import {
  GhCliTransport,
  GitHubIssuesProjectsAdapter,
  ReadScopeGitHubTransport,
  lifecycleStates,
  loadWorkflow,
  proposeBacklogGrooming,
  type LifecycleState,
  type WorkspaceTruthReader,
} from "../src";

const repository = process.argv[2];
if (!repository || repository.split("/").length !== 2) {
  throw new Error("usage: bun packages/symphony/scripts/measure-incremental-scan.ts owner/repository");
}

const workflow = (await loadWorkflow(resolve(import.meta.dir, "../tests/fixtures/WORKFLOW.md"))).config;
const states = Object.fromEntries(lifecycleStates.map((state) => [state, {
  // The production fleet's compact projection. A repository with managed work
  // will hydrate it; an unmanaged repository still measures its full backlog.
  label: state === "ready" ? "agent-ready" : ["done", "failed", "cancelled"].includes(state) ? "agent-done" : "agent-running",
  projectStatusOptionId: `unused-${state}`,
}])) as Record<LifecycleState, { label: string; projectStatusOptionId: string }>;

let measuredCost = 0;
let measuredQueries = 0;
const scoped = new ReadScopeGitHubTransport(new GhCliTransport("gh", (cost) => {
  measuredCost += cost;
  measuredQueries += 1;
}));
const truth: WorkspaceTruthReader = { async inspect() { return { kind: "absent" }; } };
const adapter = new GitHubIssuesProjectsAdapter({
  repository,
  projectId: "unused-measurement-project",
  claimFenceIssueId: "unused-measurement-fence",
  statusFieldId: "unused-measurement-status",
  gateFieldId: "unused-measurement-gate",
  requiredLabels: ["v4"],
  states,
  workflow: { ...workflow, project: { ...workflow.project, repository } },
}, scoped, truth);

async function ghJson<T>(args: readonly string[]): Promise<T> {
  const proc = Bun.spawn(["gh", ...args], { stdout: "pipe", stderr: "pipe" });
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(stderr.trim());
  return JSON.parse(stdout) as T;
}

async function issueCount(): Promise<number> {
  const [owner, name] = repository.split("/") as [string, string];
  const value = await ghJson<number>([
    "api", "graphql",
    "-f", "query=query($owner:String!,$name:String!){repository(owner:$owner,name:$name){issues{totalCount}}}",
    "-F", `owner=${owner}`, "-F", `name=${name}`,
    "--jq", ".data.repository.issues.totalCount",
  ]);
  return Number(value);
}

async function tick(label: string) {
  scoped.clear();
  measuredCost = 0;
  measuredQueries = 0;
  const [managed, backlog] = await Promise.all([
    adapter.fetchIssuesByStates(lifecycleStates),
    adapter.fetchBacklog(),
  ]);
  return {
    measurement: {
      label,
      // Each provider request carries its own `rateLimit.cost`; summing those
      // values cannot be contaminated by another process sharing this credential.
      providerCost: measuredCost,
      providerQueries: measuredQueries,
      managedIssues: managed.length,
      backlogIssues: backlog.length,
    },
    backlog,
  };
}

const cold = await tick("before / cold full scan");
const warm = await tick("after / incremental scan");
const beforeGroomingCost = measuredCost;
const beforeGroomingQueries = measuredQueries;
// This is the loop's exact decision path: the post-dispatch status already
// carries backlog, so selecting/proposing one candidate is pure local work.
const grooming = proposeBacklogGrooming(repository, warm.backlog, { ...workflow, project: { ...workflow.project, repository } });

console.log(JSON.stringify({
  repository,
  issueCount: await issueCount(),
  cold: cold.measurement,
  warm: warm.measurement,
  idleGroomingDecision: {
    outcome: grooming.outcome,
    candidate: grooming.candidate?.identifier ?? null,
    additionalProviderCost: measuredCost - beforeGroomingCost,
    additionalProviderQueries: measuredQueries - beforeGroomingQueries,
  },
}, null, 2));
