// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { ReadScopeGitHubTransport } from "../src/read-scope-transport";
import type { GitHubTransport, Page } from "../src/github-transport";

/** Counts what actually reached the provider. */
class CountingTransport implements GitHubTransport {
  readonly calls = new Map<string, number>();
  failNextListIssues = false;

  #hit(name: string): void {
    this.calls.set(name, (this.calls.get(name) ?? 0) + 1);
  }

  count(name: string): number {
    return this.calls.get(name) ?? 0;
  }

  async listIssues(): Promise<Page<never>> {
    this.#hit("listIssues");
    if (this.failNextListIssues) {
      this.failNextListIssues = false;
      throw new Error("gh: API rate limit already exceeded");
    }
    return { nodes: [], nextCursor: null };
  }
  async getIssuesByNodeIds(): Promise<never[]> { this.#hit("getIssuesByNodeIds"); return []; }
  async listLabels(): Promise<Page<string>> { this.#hit("listLabels"); return { nodes: [], nextCursor: null }; }
  async listBlockedBy(): Promise<Page<never>> { this.#hit("listBlockedBy"); return { nodes: [], nextCursor: null }; }
  async listProjectItems(): Promise<Page<never>> { this.#hit("listProjectItems"); return { nodes: [], nextCursor: null }; }
  async listProjectFieldValues(): Promise<Page<never>> { this.#hit("listProjectFieldValues"); return { nodes: [], nextCursor: null }; }
  async listComments(): Promise<Page<never>> { this.#hit("listComments"); return { nodes: [], nextCursor: null }; }
  async listClosingPullRequests(): Promise<Page<never>> { this.#hit("listClosingPullRequests"); return { nodes: [], nextCursor: null }; }
  async getBranch(): Promise<null> { this.#hit("getBranch"); return null; }
  async getBaseSha(): Promise<string> { this.#hit("getBaseSha"); return "b".repeat(40); }
  async appendComment(): Promise<never> { this.#hit("appendComment"); return { databaseId: 1, body: "", authorLogin: "bot", createdAt: "", updatedAt: "" } as never; }
  async replaceLabels(): Promise<void> { this.#hit("replaceLabels"); }
  async updateProjectSingleSelect(): Promise<void> { this.#hit("updateProjectSingleSelect"); }
  async updateProjectText(): Promise<void> { this.#hit("updateProjectText"); }
}

describe("per-operation read scope", () => {
  test("the same read inside one operation reaches the provider once", async () => {
    const inner = new CountingTransport();
    const scoped = new ReadScopeGitHubTransport(inner);

    // Five reads of the same page: what a single shadow does across preflight,
    // its own status read, active claims, the candidate list, and the preview.
    for (let i = 0; i < 5; i += 1) await scoped.listIssues("acme/repo", null);

    expect(inner.count("listIssues")).toBe(1);
    expect(scoped.stats).toMatchObject({ misses: 1, hits: 4 });
  });

  test("distinct arguments are distinct reads", async () => {
    const inner = new CountingTransport();
    const scoped = new ReadScopeGitHubTransport(inner);

    await scoped.listIssues("acme/repo", null);
    await scoped.listIssues("acme/repo", "cursor-2");
    await scoped.listComments("I_1", null);
    await scoped.listComments("I_2", null);

    expect(inner.count("listIssues")).toBe(2);
    expect(inner.count("listComments")).toBe(2);
  });

  test("a write drops the memo, so reads after a mutation see the provider again", async () => {
    const inner = new CountingTransport();
    const scoped = new ReadScopeGitHubTransport(inner);

    await scoped.listIssues("acme/repo", null);
    await scoped.listIssues("acme/repo", null);
    expect(inner.count("listIssues")).toBe(1);

    // A claim is exactly this: a comment, then labels, then the project field.
    await scoped.appendComment("I_1", "ledger event");
    await scoped.listIssues("acme/repo", null);

    // Reading stale state after a claim is how WIP gets double-spent.
    expect(inner.count("listIssues")).toBe(2);

    await scoped.replaceLabels("acme/repo", 1, ["v4-state-claimed"]);
    await scoped.listIssues("acme/repo", null);
    expect(inner.count("listIssues")).toBe(3);

    await scoped.updateProjectSingleSelect("PROJECT", "ITEM", "STATUS", "opt-claimed");
    await scoped.listIssues("acme/repo", null);
    expect(inner.count("listIssues")).toBe(4);

    await scoped.updateProjectText("PROJECT", "ITEM", "GATE", "GATE-1");
    await scoped.listIssues("acme/repo", null);
    expect(inner.count("listIssues")).toBe(5);
  });

  test("clear() ends the scope, so a new operation never reuses the old one's reads", async () => {
    const inner = new CountingTransport();
    const scoped = new ReadScopeGitHubTransport(inner);

    await scoped.listIssues("acme/repo", null);
    scoped.clear();
    await scoped.listIssues("acme/repo", null);

    expect(inner.count("listIssues")).toBe(2);
  });

  test("a failed read is not remembered, so a strict retry still fails on its own terms", async () => {
    const inner = new CountingTransport();
    const scoped = new ReadScopeGitHubTransport(inner);
    inner.failNextListIssues = true;

    await expect(scoped.listIssues("acme/repo", null)).rejects.toThrow("rate limit");
    // Second attempt must reach the provider rather than replay the rejection.
    await expect(scoped.listIssues("acme/repo", null)).resolves.toMatchObject({ nextCursor: null });
    expect(inner.count("listIssues")).toBe(2);
  });
});
