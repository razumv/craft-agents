// SPDX-License-Identifier: Apache-2.0

import type {
  GitHubBranchEvidence,
  GitHubComment,
  GitHubIssueLink,
  GitHubIssueRecord,
  GitHubProjectFieldValue,
  GitHubProjectItem,
  GitHubPullRequestEvidence,
  GitHubTransport,
  Page,
} from "./github-transport";

/**
 * Memoizes reads for the duration of one runner operation.
 *
 * A single shadow performs five repository-wide reads: preflight reads the
 * discovery status, `shadow()` reads it again, and `previewNext()` reads active
 * claims, then the ready candidates, then the chosen issue. Each of those walks
 * the same issues through the same queries, in the same operation, against a
 * provider that cannot have changed underneath in any way the operation is
 * allowed to act on — it is one decision, taken from one observation.
 *
 * Reads are therefore answered once and reused. Every write clears the whole
 * memo, so a read after a mutation always goes back to the provider: within a
 * tick, reconciliation reads are shared, the claim invalidates them, and
 * everything after the claim sees the provider's new truth. The runner clears
 * the scope at the start of each operation, so nothing is ever carried between
 * two decisions.
 *
 * Only fulfilled reads are remembered. A rejection is never cached, so a strict
 * load that must fail closed still fails on its own terms.
 */
export class ReadScopeGitHubTransport implements GitHubTransport {
  readonly #reads = new Map<string, Promise<unknown>>();
  #hits = 0;
  #misses = 0;

  constructor(readonly inner: GitHubTransport) {
    // Assigned here, not as a field initializer: a field initializer can run
    // before the parameter property is in place, which would read `inner` as
    // undefined and drop the method for a transport that has it.
    if (inner.mergePullRequest) {
      this.mergePullRequest = async (pullRequestId, commitHeadline) => {
        this.clear();
        return inner.mergePullRequest!(pullRequestId, commitHeadline);
      };
    }
  }

  /** Drop everything remembered. Called at the start of an operation and by every write. */
  clear(): void {
    this.#reads.clear();
  }

  /** Read counters, for tests and diagnostics; reset with the scope. */
  get stats(): { hits: number; misses: number } {
    return { hits: this.#hits, misses: this.#misses };
  }

  resetStats(): void {
    this.#hits = 0;
    this.#misses = 0;
  }

  #memo<T>(key: string, load: () => Promise<T>): Promise<T> {
    const existing = this.#reads.get(key);
    if (existing) {
      this.#hits += 1;
      return existing as Promise<T>;
    }
    this.#misses += 1;
    const promise = load().catch((error: unknown) => {
      // A failed read must not be remembered: the next caller may be a strict
      // load whose whole job is to raise that failure.
      this.#reads.delete(key);
      throw error;
    });
    this.#reads.set(key, promise);
    return promise;
  }

  // ---------------------------------------------------------------- reads

  listIssues(repository: string, cursor: string | null): Promise<Page<GitHubIssueRecord>> {
    return this.#memo(`listIssues\n${repository}\n${cursor ?? ""}`, () => this.inner.listIssues(repository, cursor));
  }

  getIssuesByNodeIds(ids: readonly string[]): Promise<(GitHubIssueRecord | null)[]> {
    return this.#memo(`getIssuesByNodeIds\n${[...ids].join(",")}`, () => this.inner.getIssuesByNodeIds(ids));
  }

  listLabels(issueId: string, cursor: string | null): Promise<Page<string>> {
    return this.#memo(`listLabels\n${issueId}\n${cursor ?? ""}`, () => this.inner.listLabels(issueId, cursor));
  }

  listBlockedBy(issueId: string, cursor: string | null): Promise<Page<GitHubIssueLink>> {
    return this.#memo(`listBlockedBy\n${issueId}\n${cursor ?? ""}`, () => this.inner.listBlockedBy(issueId, cursor));
  }

  listProjectItems(issueId: string, cursor: string | null): Promise<Page<GitHubProjectItem>> {
    return this.#memo(`listProjectItems\n${issueId}\n${cursor ?? ""}`, () => this.inner.listProjectItems(issueId, cursor));
  }

  listProjectFieldValues(itemId: string, cursor: string | null): Promise<Page<GitHubProjectFieldValue>> {
    return this.#memo(`listProjectFieldValues\n${itemId}\n${cursor ?? ""}`, () => this.inner.listProjectFieldValues(itemId, cursor));
  }

  listComments(issueId: string, cursor: string | null): Promise<Page<GitHubComment>> {
    return this.#memo(`listComments\n${issueId}\n${cursor ?? ""}`, () => this.inner.listComments(issueId, cursor));
  }

  listClosingPullRequests(issueId: string, cursor: string | null): Promise<Page<GitHubPullRequestEvidence>> {
    return this.#memo(`listClosingPullRequests\n${issueId}\n${cursor ?? ""}`, () => this.inner.listClosingPullRequests(issueId, cursor));
  }

  getBranch(repository: string, branchName: string): Promise<GitHubBranchEvidence | null> {
    return this.#memo(`getBranch\n${repository}\n${branchName}`, () => this.inner.getBranch(repository, branchName));
  }

  getBaseSha(repository: string, branchName: string): Promise<string> {
    return this.#memo(`getBaseSha\n${repository}\n${branchName}`, () => this.inner.getBaseSha(repository, branchName));
  }

  // --------------------------------------------------------------- writes

  async appendComment(issueId: string, body: string): Promise<GitHubComment> {
    this.clear();
    return this.inner.appendComment(issueId, body);
  }

  async replaceLabels(repository: string, issueNumber: number, labels: readonly string[]): Promise<void> {
    this.clear();
    return this.inner.replaceLabels(repository, issueNumber, labels);
  }

  async updateProjectSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    this.clear();
    return this.inner.updateProjectSingleSelect(projectId, itemId, fieldId, optionId);
  }

  async updateProjectText(projectId: string, itemId: string, fieldId: string, value: string): Promise<void> {
    this.clear();
    return this.inner.updateProjectText(projectId, itemId, fieldId, value);
  }

  /**
   * Forwarded explicitly rather than left to fall through, because it does not
   * fall through: an optional method missing from this wrapper is not a type
   * error, it silently reads as "the transport cannot merge" — which is how
   * auto-merge sat switched off for every project while looking configured.
   *
   * Defined as a field so it is absent exactly when the inner transport's is,
   * instead of always present and failing at the call.
   */
  readonly mergePullRequest?: (pullRequestId: string, commitHeadline: string) => Promise<void>;
}
