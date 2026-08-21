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
 * Reads are therefore answered once and reused, and a write drops exactly what
 * it could have changed. Blanket invalidation was the first version and it cost
 * a fortune: a tick performs many writes — claim, running, heartbeat, each
 * transition and its projection — and each one forced every later read to walk
 * the whole repository again. Measured on razumv/gve, a read-only pass cost 71
 * GraphQL points against 502 for the same tick with writes, so seven full
 * re-scans were being paid for changes to one issue. Across eight projects on a
 * fifteen-minute loop that is three times the hourly budget, and the fleet spent
 * the hour refusing work with "API rate limit already exceeded".
 *
 * So each write names its own scope. A comment invalidates that issue's comments;
 * a label write invalidates that issue's labels and the repository listing, which
 * carries labels; a project field write invalidates that item's field values. What
 * a write cannot have touched stays cached, and a read of what it did touch always
 * goes back to the provider. The runner clears the scope at the start of each
 * operation, so nothing is ever carried between two decisions.
 *
 * Only fulfilled reads are remembered. A rejection is never cached, so a strict
 * load that must fail closed still fails on its own terms.
 */
export class ReadScopeGitHubTransport implements GitHubTransport {
  readonly #reads = new Map<string, Promise<unknown>>();
  #hits = 0;
  #misses = 0;

  constructor(readonly inner: GitHubTransport) {}

  /** Drop everything remembered. Called at the start of each operation. */
  clear(): void {
    this.#reads.clear();
  }

  /**
   * Drop every remembered read whose key mentions one of these tokens.
   *
   * Keys embed the identifiers they were read for, so a token match is exactly
   * "this read could have been about the thing that just changed". A write must
   * pass every identifier it could have affected; passing too few would serve a
   * stale read after a mutation, which is the failure this memo must never cause.
   */
  #invalidate(...tokens: readonly string[]): void {
    for (const key of [...this.#reads.keys()]) {
      if (tokens.some((token) => key.includes(token))) this.#reads.delete(key);
    }
  }

  /** The repository-wide issue listing, which carries each issue's labels and state. */
  #invalidateListing(): void {
    this.#invalidate("listIssues\n", "getIssuesByNodeIds\n");
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

  listIssues(repository: string, cursor: string | null, updatedSince: string | null = null): Promise<Page<GitHubIssueRecord>> {
    return this.#memo(
      `listIssues\n${repository}\n${updatedSince ?? ""}\n${cursor ?? ""}`,
      () => this.inner.listIssues(repository, cursor, updatedSince),
    );
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
    // The ledger lives in comments, so a new comment changes this issue's
    // durable state and nothing else about the repository.
    this.#invalidate(`listComments\n${issueId}`);
    return this.inner.appendComment(issueId, body);
  }

  async updateIssueBody(issueId: string, body: string): Promise<void> {
    // The body rides on both repository listings and exact node reads. Drop
    // those observations before forwarding so the mandatory parser readback
    // cannot accidentally validate the pre-write body from this operation.
    this.#invalidateListing();
    return this.inner.updateIssueBody(issueId, body);
  }

  async replaceLabels(repository: string, issueNumber: number, labels: readonly string[]): Promise<void> {
    // Labels decide which lifecycle state an issue is in, and they ride along
    // with the repository listing, so both go. The listing is one query per
    // page; the per-issue hydration of every other issue stays cached.
    this.#invalidate("listLabels\n");
    this.#invalidateListing();
    return this.inner.replaceLabels(repository, issueNumber, labels);
  }

  async updateProjectSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    this.#invalidate(`listProjectFieldValues\n${itemId}`);
    return this.inner.updateProjectSingleSelect(projectId, itemId, fieldId, optionId);
  }

  async updateProjectText(projectId: string, itemId: string, fieldId: string, value: string): Promise<void> {
    this.#invalidate(`listProjectFieldValues\n${itemId}`);
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
  /**
   * A merge closes the issue, changes its pull request evidence and can move the
   * base branch, and the pull request id alone does not say which issue it
   * belongs to — so this one genuinely invalidates everything. Merges are rare;
   * the cost is a single re-scan when work actually lands.
   */
  containsCommit(repository: string, base: string, head: string): Promise<boolean> {
    // Ancestry between two fixed commits cannot change, so it is memoized like
    // any other read.
    return this.#memo(`containsCommit\n${repository}\n${base}\n${head}`, () => this.inner.containsCommit(repository, base, head));
  }

  async mergePullRequest(pullRequestId: string, commitHeadline: string): Promise<void> {
    this.clear();
    return this.inner.mergePullRequest(pullRequestId, commitHeadline);
  }
}
