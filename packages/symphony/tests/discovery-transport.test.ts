// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { DiscoveryGitHubTransport, loadLiveRunnerConfig } from "../src/runner";
import type {
  GitHubIssueRecord,
  GitHubProjectItem,
  GitHubTransport,
  Page,
} from "../src/github-transport";
import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const REPO = "razumv/craft-agents";
const SCOPE = {
  repository: REPO,
  fenceIssueId: "ISSUE_FENCE",
  projectId: "PVT_1",
  statusFieldId: "FIELD_STATUS",
  gateFieldId: "FIELD_GATE",
};

function record(id: string, number: number): GitHubIssueRecord {
  return {
    id, number, title: `Issue ${number}`, body: "", url: `https://github.com/${REPO}/issues/${number}`,
    state: "OPEN", createdAt: "2026-08-19T00:00:00Z", updatedAt: "2026-08-19T00:00:00Z", assigneeId: null,
  };
}

function fakeDelegate(calls: string[]): GitHubTransport {
  const page = <T,>(nodes: T[]): Page<T> => ({ nodes, nextCursor: null });
  return {
    async listIssues(repository, _cursor) { calls.push(`listIssues:${repository}`); return page([record("I_1", 1), record("I_2", 2)]); },
    async getIssuesByNodeIds(ids) { return ids.map((id) => (id === "I_3" ? record("I_3", 3) : null)); },
    async listLabels() { return page(["v4"]); },
    async listBlockedBy() { return page([]); },
    async listProjectItems() { return page([{ id: "ITEM_1", projectId: "PVT_1" }, { id: "ITEM_OTHER", projectId: "PVT_OTHER" }] as GitHubProjectItem[]); },
    async listProjectFieldValues() { return page([]); },
    async listComments() { return page([]); },
    async listClosingPullRequests() { return page([]); },
    async getBranch() { return null; },
    async getBaseSha() { return "a".repeat(40); },
    async appendComment(issueId) { calls.push(`comment:${issueId}`); return { id: "C_1", body: "", authorLogin: "x", createdAt: "" } as never; },
    async replaceLabels(_repo, issueNumber) { calls.push(`labels:${issueNumber}`); },
    async updateProjectSingleSelect(_p, itemId) { calls.push(`status:${itemId}`); },
    async updateProjectText(_p, itemId) { calls.push(`gate:${itemId}`); },
  };
}

describe("DiscoveryGitHubTransport", () => {
  test("reads flow repo-wide; mutations only reach fence and observed issues/items", async () => {
    const calls: string[] = [];
    const transport = new DiscoveryGitHubTransport(fakeDelegate(calls), SCOPE);

    // Repository fence on reads.
    await expect(transport.listIssues("other/repo", null)).rejects.toThrow("repository scope");
    await expect(transport.getBranch("other/repo", "main")).rejects.toThrow("repository scope");

    // Unobserved issue: reads and mutations are fenced (fence issue excepted).
    await expect(transport.listLabels("I_1", null)).rejects.toThrow("discovered issue/fence scope");
    await expect(transport.appendComment("I_1", "x")).rejects.toThrow("discovered issue/fence scope");
    await transport.appendComment("ISSUE_FENCE", "claim body");

    // Discovery observes issues; then reads and mutations pass.
    await transport.listIssues(REPO, null);
    expect((await transport.listLabels("I_1", null)).nodes).toEqual(["v4"]);
    await transport.appendComment("I_2", "evidence");
    await transport.replaceLabels(REPO, 2, ["v4"]);
    await expect(transport.replaceLabels(REPO, 99, [])).rejects.toThrow("repository/issue scope");
    await expect(transport.replaceLabels("other/repo", 2, [])).rejects.toThrow("repository/issue scope");

    // Project items must be observed and belong to the configured project/fields.
    await expect(transport.updateProjectSingleSelect("PVT_1", "ITEM_1", "FIELD_STATUS", "opt")).rejects.toThrow("item scope");
    await transport.listProjectItems("I_1", null);
    await transport.updateProjectSingleSelect("PVT_1", "ITEM_1", "FIELD_STATUS", "opt");
    await expect(transport.updateProjectSingleSelect("PVT_1", "ITEM_OTHER", "FIELD_STATUS", "opt")).rejects.toThrow("item scope");
    await expect(transport.updateProjectSingleSelect("PVT_1", "ITEM_1", "FIELD_GATE", "opt")).rejects.toThrow("item scope");
    await transport.updateProjectText("PVT_1", "ITEM_1", "FIELD_GATE", "APPROVE GATE-1");
    await expect(transport.updateProjectText("PVT_OTHER", "ITEM_1", "FIELD_GATE", "x")).rejects.toThrow("item scope");

    // getIssuesByNodeIds also registers observed issues.
    await transport.getIssuesByNodeIds(["I_3"]);
    await transport.appendComment("I_3", "recovered");
  });
});

describe("loadLiveRunnerConfig discovery mode", () => {
  const base = {
    workflowPath: "/tmp/WORKFLOW.md",
    repositoryRoot: "/tmp/repository",
    workspaceRoot: "/tmp/worktrees",
    claimFenceIssueId: "ISSUE_FENCE",
    verificationBudget: "focused",
  };

  async function write(config: unknown): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "craft-symphony-discovery-"));
    const path = join(dir, "runner.json");
    await writeFile(path, JSON.stringify(config));
    return path;
  }

  test("discovery mode does not require a pinned issue", async () => {
    const config = await loadLiveRunnerConfig(await write({ ...base, mode: "discovery" }));
    expect(config.mode).toBe("discovery");
  });

  test("single-issue mode still requires issueId; unknown modes fail", async () => {
    await expect(loadLiveRunnerConfig(await write(base))).rejects.toThrow("issueId");
    await expect(loadLiveRunnerConfig(await write({ ...base, mode: "everything" }))).rejects.toThrow("issue or discovery");
  });
});
