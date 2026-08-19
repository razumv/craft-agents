// SPDX-License-Identifier: Apache-2.0

import type { LiveRunnerConfig } from "./runner";

/**
 * Generate discovery-mode LiveRunnerConfig drafts from a Craft project's
 * GitHub binding (repositories + Project URL + optional view).
 *
 * The generator is deliberately read-only and draft-producing: it resolves
 * live GitHub identifiers (Project node id, Status/Gate field ids, an
 * existing claim-fence issue) but never mutates GitHub and never touches the
 * Symphony server config. Fields it cannot know are left as explicit "TODO:"
 * markers with matching warnings, so a draft fails loadLiveRunnerConfig
 * validation until an owner reviews and completes it — wiring a draft into
 * CRAFT_SYMPHONY_CONFIG stays a separate explicit activation decision.
 */

export interface ProjectBindingSeed {
  /** owner/name repositories from the Craft project's github binding. */
  repositories: string[];
  /** GitHub Project (v2) URL, e.g. https://github.com/users/razumv/projects/1 */
  projectUrl?: string;
  projectView?: string;
}

export interface CraftProjectSeed {
  /** Craft project id (becomes craft.projectId). */
  id: string;
  slug: string;
  workingDirectory?: string;
}

/** Label that marks the dedicated claim-fence issue in a repository. */
export const FENCE_ISSUE_LABEL = "symphony-fence";
/** Default eligibility label required on dispatchable issues. */
export const DEFAULT_REQUIRED_LABEL = "symphony";

export interface GitHubProjectResolution {
  projectId: string;
  statusFieldId: string | null;
  gateFieldId: string | null;
}

/** The two live lookups the generator needs; implemented by GhCliTransport helpers. */
export interface GitHubConfigResolver {
  /** Resolve a Project (v2) URL to its node id and Status/Gate field ids. */
  resolveProject(projectUrl: string): Promise<GitHubProjectResolution>;
  /** Find the open issue carrying FENCE_ISSUE_LABEL in a repository; null when absent. */
  findFenceIssue(repository: string): Promise<{ id: string; number: number } | null>;
}

export interface RunnerConfigDraft {
  repository: string;
  /** Draft LiveRunnerConfig; contains "TODO:" markers for unresolved fields. */
  config: LiveRunnerConfig;
  /** Human review points — every TODO and every assumption made. */
  warnings: string[];
}

export const PROJECT_URL_PATTERN = /^https:\/\/github\.com\/(users|orgs)\/([\w.-]+)\/projects\/(\d+)/;

const TODO = (what: string): string => `TODO: ${what}`;

export async function generateDiscoveryRunnerConfigs(
  binding: ProjectBindingSeed,
  craftProject: CraftProjectSeed,
  resolver: GitHubConfigResolver,
): Promise<RunnerConfigDraft[]> {
  const repositories = binding.repositories.map((repo) => repo.trim()).filter(Boolean);
  if (repositories.length === 0) throw new Error("project github binding has no repositories");
  for (const repository of repositories) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repository)) throw new Error(`repository must be owner/name: ${repository}`);
  }

  const sharedWarnings: string[] = [];
  let project: GitHubProjectResolution | null = null;
  if (binding.projectUrl) {
    if (!PROJECT_URL_PATTERN.test(binding.projectUrl)) {
      throw new Error(`unsupported GitHub Project URL: ${binding.projectUrl}`);
    }
    project = await resolver.resolveProject(binding.projectUrl);
    if (!project.statusFieldId) sharedWarnings.push('Project has no single-select field named "Status" — set github.statusFieldId manually');
    if (!project.gateFieldId) sharedWarnings.push('Project has no text field named "Gate" — set github.gateFieldId manually');
  } else {
    sharedWarnings.push("binding has no Project URL — set github.projectId/statusFieldId/gateFieldId manually");
  }
  if (binding.projectView) {
    sharedWarnings.push(`Project view "${binding.projectView}" is informational: discovery scopes by repository + labels, not by view`);
  }

  const workingDirectory = craftProject.workingDirectory ?? null;

  return Promise.all(repositories.map(async (repository): Promise<RunnerConfigDraft> => {
    const warnings = [...sharedWarnings];
    const fence = await resolver.findFenceIssue(repository);
    if (!fence) {
      warnings.push(`no open issue labeled "${FENCE_ISSUE_LABEL}" in ${repository} — create one and set claimFenceIssueId`);
    }
    if (!workingDirectory) warnings.push("Craft project has no working directory — set repositoryRoot/workspaceRoot manually");
    warnings.push("review workflowPath, craft.ownerSessionId, craft label ids, and craft.cli identity before wiring the draft in");

    const repoSlug = repository.split("/")[1]!;
    const root = workingDirectory ?? TODO("absolute repository root");
    const config = {
      mode: "discovery",
      workflowPath: workingDirectory ? `${workingDirectory}/WORKFLOW.md` : TODO("absolute workflow file path"),
      repositoryRoot: root,
      workspaceRoot: workingDirectory ? `${workingDirectory}/.worktrees` : TODO("absolute worktree root"),
      claimFenceIssueId: fence?.id ?? TODO(`id of the open "${FENCE_ISSUE_LABEL}" issue in ${repository}`),
      verificationBudget: "focused",
      github: {
        executable: "gh",
        repository,
        eventAuthorLogin: TODO("GitHub login the scheduler's events are authored by"),
        projectId: project?.projectId ?? TODO("GitHub Project (v2) node id"),
        statusFieldId: project?.statusFieldId ?? TODO('Project single-select "Status" field id'),
        gateFieldId: project?.gateFieldId ?? TODO('Project text "Gate" field id'),
        requiredLabels: [DEFAULT_REQUIRED_LABEL],
        states: TODO("per-lifecycle-state GitHub projection map (copy from a reviewed runner config)"),
      },
      git: { executable: "git" },
      craft: {
        workspaceId: TODO("Craft workspace id"),
        projectId: craftProject.id,
        projectWorkingDirectory: root,
        ownerSessionId: TODO("owner desk session id"),
        repositoryInstructions: `Repository ${repository}; project ${craftProject.slug} (${repoSlug}).`,
        issueLabelId: TODO("Craft issue label id"),
        runLabelId: TODO("Craft run label id"),
        promptLabelId: TODO("Craft prompt label id"),
        cli: TODO("CraftCliTransportConfig with exact expected runtime identity"),
        deadlines: { rpcMs: 30_000, turnMs: 1_800_000, cancelMs: 60_000, pollMs: 5_000, maxContextTokens: 80_000 },
        maxHandoffChars: 12_000,
      },
    } as unknown as LiveRunnerConfig;

    return { repository, config, warnings };
  }));
}
