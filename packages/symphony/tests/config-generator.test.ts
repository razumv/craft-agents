// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  DEFAULT_REQUIRED_LABEL,
  FENCE_ISSUE_LABEL,
  generateDiscoveryRunnerConfigs,
  type GitHubConfigResolver,
} from "../src/config-generator";

const craftProject = { id: "proj-lineage", slug: "lineage", workingDirectory: "/work/lineage" };

function resolver(overrides: Partial<GitHubConfigResolver> = {}): GitHubConfigResolver {
  return {
    async resolveProject() {
      return { projectId: "PVT_LINEAGE", statusFieldId: "F_STATUS", gateFieldId: "F_GATE" };
    },
    async findFenceIssue(repository) {
      return repository === "razumv/gve" ? { id: "I_FENCE_GVE", number: 7 } : null;
    },
    ...overrides,
  };
}

describe("generateDiscoveryRunnerConfigs", () => {
  test("emits one discovery draft per repository sharing the resolved Project", async () => {
    const drafts = await generateDiscoveryRunnerConfigs(
      {
        repositories: ["razumv/gve", "razumv/lineage-client", "razumv/lineage-server"],
        projectUrl: "https://github.com/users/razumv/projects/3",
        projectView: "Lineage board",
      },
      craftProject,
      resolver(),
    );

    expect(drafts.map((draft) => draft.repository)).toEqual([
      "razumv/gve", "razumv/lineage-client", "razumv/lineage-server",
    ]);
    for (const draft of drafts) {
      const config = draft.config as unknown as Record<string, any>;
      expect(config.mode).toBe("discovery");
      expect(config.github.projectId).toBe("PVT_LINEAGE");
      expect(config.github.statusFieldId).toBe("F_STATUS");
      expect(config.github.gateFieldId).toBe("F_GATE");
      expect(config.github.requiredLabels).toEqual([DEFAULT_REQUIRED_LABEL]);
      expect(config.craft.projectId).toBe("proj-lineage");
      expect(config.repositoryRoot).toBe("/work/lineage");
      // Unknowable fields stay explicit TODOs, so the draft cannot pass
      // loadLiveRunnerConfig without owner review.
      expect(config.craft.ownerSessionId).toStartWith("TODO:");
      expect(config.github.states).toStartWith("TODO:");
      expect(draft.warnings.some((w) => w.includes("view"))).toBe(true);
    }

    expect((drafts[0]!.config as any).claimFenceIssueId).toBe("I_FENCE_GVE");
    expect((drafts[1]!.config as any).claimFenceIssueId).toStartWith("TODO:");
    expect(drafts[1]!.warnings.some((w) => w.includes(FENCE_ISSUE_LABEL))).toBe(true);
  });

  test("rejects malformed repositories and Project URLs; requires at least one repo", async () => {
    await expect(generateDiscoveryRunnerConfigs({ repositories: [] }, craftProject, resolver()))
      .rejects.toThrow("no repositories");
    await expect(generateDiscoveryRunnerConfigs({ repositories: ["not-a-repo"] }, craftProject, resolver()))
      .rejects.toThrow("owner/name");
    await expect(generateDiscoveryRunnerConfigs(
      { repositories: ["razumv/gve"], projectUrl: "https://github.com/razumv/gve/projects/1" },
      craftProject,
      resolver(),
    )).rejects.toThrow("unsupported GitHub Project URL");
  });

  test("without a Project URL the Project ids become TODOs with a warning", async () => {
    const [draft] = await generateDiscoveryRunnerConfigs(
      { repositories: ["razumv/magnetring"] },
      { id: "proj-mr", slug: "magnetring" },
      resolver({ async findFenceIssue() { return null } }),
    );
    const config = draft!.config as unknown as Record<string, any>;
    expect(config.github.projectId).toStartWith("TODO:");
    expect(config.repositoryRoot).toStartWith("TODO:");
    expect(draft!.warnings.some((w) => w.includes("Project URL"))).toBe(true);
    expect(draft!.warnings.some((w) => w.includes("working directory"))).toBe(true);
  });
});

describe("connection failover chain", () => {
  test("attempt N picks connections[N-1], clamps past the end, and ignores an empty chain", async () => {
    const { connectionForAttempt } = await import("../src/identity");
    const chain = { connection: "chatgpt-plus", connections: ["chatgpt-plus", "chatgpt-plus-2", "chatgpt-plus-3"] };
    expect(connectionForAttempt(chain, 1)).toBe("chatgpt-plus");
    expect(connectionForAttempt(chain, 2)).toBe("chatgpt-plus-2");
    expect(connectionForAttempt(chain, 3)).toBe("chatgpt-plus-3");
    // Attempts beyond the chain stay on the last account rather than wrapping
    // back to an exhausted one.
    expect(connectionForAttempt(chain, 4)).toBe("chatgpt-plus-3");
    expect(connectionForAttempt({ connection: "solo" }, 3)).toBe("solo");
    expect(connectionForAttempt({ connection: "solo", connections: [] }, 2)).toBe("solo");
  });

  test("balanced spreads the starting account across issues and still rotates on retry", async () => {
    const { connectionForAttempt } = await import("../src/identity");
    const chain = {
      connection: "chatgpt-plus",
      connections: ["chatgpt-plus", "chatgpt-plus-2", "chatgpt-plus-3"],
      connectionStrategy: "balanced" as const,
    };
    const ids = Array.from({ length: 60 }, (_, index) => `I_kwDO${index}`);
    const firstAttempt = ids.map((id) => connectionForAttempt(chain, 1, id));

    // Every account takes real first-attempt work, which failover never does.
    for (const connection of chain.connections) {
      expect(firstAttempt).toContain(connection);
    }

    // Same inputs, same answer: a restart must reconstruct the binding it claimed.
    for (const id of ids) {
      expect(connectionForAttempt(chain, 1, id)).toBe(connectionForAttempt(chain, 1, id));
    }

    // A retry always leaves the account that just failed, and a full rotation
    // visits every account exactly once before repeating.
    const id = ids[0]!;
    const rotation = [1, 2, 3].map((attempt) => connectionForAttempt(chain, attempt, id));
    expect(new Set(rotation).size).toBe(3);
    expect(connectionForAttempt(chain, 4, id)).toBe(rotation[0]);
  });

  test("balanced without an issue id degrades to failover rather than guessing", async () => {
    const { connectionForAttempt } = await import("../src/identity");
    const chain = {
      connection: "chatgpt-plus",
      connections: ["chatgpt-plus", "chatgpt-plus-2", "chatgpt-plus-3"],
      connectionStrategy: "balanced" as const,
    };
    expect(connectionForAttempt(chain, 1)).toBe("chatgpt-plus");
    expect(connectionForAttempt(chain, 2)).toBe("chatgpt-plus-2");
  });

  test("the default strategy is unchanged failover", async () => {
    const { connectionForAttempt } = await import("../src/identity");
    const chain = { connection: "chatgpt-plus", connections: ["chatgpt-plus", "chatgpt-plus-2"] };
    // No strategy configured: an issue id must not change the pick.
    expect(connectionForAttempt(chain, 1, "I_anything")).toBe("chatgpt-plus");
    expect(connectionForAttempt(chain, 2, "I_anything")).toBe("chatgpt-plus-2");
    expect(connectionForAttempt({ ...chain, connectionStrategy: "failover" }, 1, "I_anything")).toBe("chatgpt-plus");
  });

  test("policy allows every chain connection and dedupes the primary", async () => {
    const { ModelPolicy } = await import("../src/policy");
    const policy = new ModelPolicy({
      connection: "chatgpt-plus",
      connections: ["chatgpt-plus", "chatgpt-plus-2", " "],
      defaultProfile: "pi/gpt-5.6-sol",
      allowedProfiles: ["pi/gpt-5.6-sol"],
    });
    expect(policy.allowedConnections()).toEqual(["chatgpt-plus", "chatgpt-plus-2"]);
  });
});

describe("issue intake is discovery-only", () => {
  test("a pinned single-issue runner refuses intake instead of orphaning the issue", async () => {
    const { LiveV4Runner } = await import("../src/runner");
    const runner = Object.create(LiveV4Runner.prototype) as InstanceType<typeof LiveV4Runner>;
    Object.defineProperty(runner, "config", { value: { mode: "issue" }, writable: false });
    Object.defineProperty(runner, "intake", { value: {}, writable: false });
    await expect(runner.createContractIssue({
      title: "t", goal: "g", risk: "low", acceptance: ["a"], nonGoals: [],
    })).rejects.toThrow("discovery-mode project");
  });
});
