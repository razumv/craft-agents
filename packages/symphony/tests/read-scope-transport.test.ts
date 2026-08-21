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

  async containsCommit(): Promise<boolean> {
    this.#hit("containsCommit");
    return true;
  }

  async mergePullRequest(): Promise<void> {
    this.#hit("mergePullRequest");
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
    await scoped.listIssues("acme/repo", null, "2026-08-20T12:00:00Z");
    await scoped.listComments("I_1", null);
    await scoped.listComments("I_2", null);

    expect(inner.count("listIssues")).toBe(3);
    expect(inner.count("listComments")).toBe(2);
  });

  test("a write invalidates what it could have changed, and only that", async () => {
    const inner = new CountingTransport();
    const scoped = new ReadScopeGitHubTransport(inner);

    await scoped.listIssues("acme/repo", null);
    await scoped.listIssues("acme/repo", null);
    await scoped.listComments("I_1", null);
    await scoped.listComments("I_2", null);
    await scoped.listLabels("I_1", null);
    expect(inner.count("listIssues")).toBe(1);
    expect(inner.count("listComments")).toBe(2);

    // The ledger lives in comments, so appending one changes this issue's durable
    // state — and nothing about which issues exist or what another issue says.
    await scoped.appendComment("I_1", "ledger event");
    await scoped.listComments("I_1", null);
    await scoped.listComments("I_2", null);
    await scoped.listIssues("acme/repo", null);
    expect(inner.count("listComments")).toBe(3);
    expect(inner.count("listIssues")).toBe(1);

    // Labels decide the lifecycle state and ride along with the listing, so both
    // are re-read. This is the invalidation that must not be narrowed: a stale
    // label is how WIP gets double-spent.
    await scoped.replaceLabels("acme/repo", 1, ["v4-state-claimed"]);
    await scoped.listLabels("I_1", null);
    await scoped.listIssues("acme/repo", null);
    expect(inner.count("listLabels")).toBe(2);
    expect(inner.count("listIssues")).toBe(2);
  });

  test("a project field write invalidates that item's fields, not the whole repository", async () => {
    const inner = new CountingTransport();
    const scoped = new ReadScopeGitHubTransport(inner);

    await scoped.listProjectFieldValues("ITEM_1", null);
    await scoped.listProjectFieldValues("ITEM_2", null);
    await scoped.listIssues("acme/repo", null);

    await scoped.updateProjectSingleSelect("PROJECT", "ITEM_1", "STATUS", "opt-claimed");
    await scoped.listProjectFieldValues("ITEM_1", null);
    await scoped.listProjectFieldValues("ITEM_2", null);
    await scoped.listIssues("acme/repo", null);

    expect(inner.count("listProjectFieldValues")).toBe(3);
    expect(inner.count("listIssues")).toBe(1);

    await scoped.updateProjectText("PROJECT", "ITEM_1", "GATE", "GATE-1");
    await scoped.listProjectFieldValues("ITEM_1", null);
    expect(inner.count("listProjectFieldValues")).toBe(4);
  });

  test("a merge invalidates everything, because a pull request id does not say whose it is", async () => {
    const inner = new CountingTransport();
    const scoped = new ReadScopeGitHubTransport(inner);

    await scoped.listIssues("acme/repo", null);
    await scoped.listComments("I_1", null);
    await scoped.mergePullRequest("PR_1", "headline");
    await scoped.listIssues("acme/repo", null);
    await scoped.listComments("I_1", null);

    // A merge closes an issue and changes its evidence; the id alone does not say
    // which issue, so the coarse drop is the honest one. Merges are rare.
    expect(inner.count("listIssues")).toBe(2);
    expect(inner.count("listComments")).toBe(2);
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

  test("every method of the transport interface survives the wrapper", async () => {
    // The wrapper silently dropped the optional mergePullRequest, and because it
    // is optional that was not a type error — it read downstream as "the
    // transport cannot merge", so auto-merge sat switched off in every project
    // while looking configured. A missing method must fail here instead.
    const inner = new CountingTransport();
    const scoped = new ReadScopeGitHubTransport(inner);
    for (const name of Object.getOwnPropertyNames(CountingTransport.prototype)) {
      if (name === "constructor" || name === "count") continue;
      expect(typeof (scoped as unknown as Record<string, unknown>)[name]).toBe("function");
    }
  });

  test("merging goes through and invalidates the memo", async () => {
    const inner = new CountingTransport();
    const scoped = new ReadScopeGitHubTransport(inner);

    await scoped.listIssues("acme/repo", null);
    await scoped.mergePullRequest("PR_1", "headline");
    await scoped.listIssues("acme/repo", null);

    expect(inner.count("mergePullRequest")).toBe(1);
    // A merge changes the issue, its labels and its pull request, so nothing
    // read before it may be replayed afterwards.
    expect(inner.count("listIssues")).toBe(2);
  });
});
