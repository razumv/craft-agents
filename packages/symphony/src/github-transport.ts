// SPDX-License-Identifier: Apache-2.0

export interface Page<T> {
  nodes: T[];
  nextCursor: string | null;
}

export interface GitHubIssueRecord {
  id: string;
  number: number;
  title: string;
  body: string;
  url: string;
  state: "OPEN" | "CLOSED";
  createdAt: string;
  updatedAt: string;
  assigneeId: string | null;
  /**
   * Label names carried by the listing itself, when the transport can supply
   * them without an extra request. Discovery uses this to decide whether an
   * issue is worth hydrating at all; `null` means "unknown, ask separately"
   * so a transport that cannot provide them stays correct.
   */
  labelNames?: readonly string[] | null;
  /** Upstream-normalized priority when a provider listing exposes one. */
  priority?: number | null;
  /** Native parent issue relation, carried by the repository listing. */
  parent?: GitHubIssueLink | null;
}

export interface GitHubIssueLink {
  id: string;
  number: number;
  title: string;
  state: "OPEN" | "CLOSED";
  url: string;
}

export interface GitHubProjectItem {
  id: string;
  projectId: string;
}

export type GitHubProjectFieldValue =
  | { kind: "single-select"; fieldId: string; fieldName: string; optionId: string | null; value: string | null }
  | { kind: "text"; fieldId: string; fieldName: string; value: string | null }
  | { kind: "number"; fieldId: string; fieldName: string; value: number | null }
  | { kind: "date"; fieldId: string; fieldName: string; value: string | null }
  | { kind: "other"; fieldId: string | null; fieldName: string | null };

export interface GitHubComment {
  databaseId: number;
  body: string;
  authorLogin: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface GitHubPullRequestEvidence {
  id: string;
  url: string;
  state: "OPEN" | "CLOSED" | "MERGED";
  headRefName: string;
  headRefOid: string;
  baseRefName: string;
  baseRefOid: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  /** GitHub's own mergeability verdict; UNKNOWN while it is still computing. */
  mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  /**
   * Rollup verdict over the head commit's checks, or null when the commit has
   * none. Null is NOT success: a repository whose workflow does not trigger on
   * this base branch reports no checks at all, and reading that as green is how
   * an unverified change merges itself.
   */
  checkRollupState: string | null;
  /** How many checks the rollup covers. Zero means nothing ran. */
  checkCount: number;
}

export interface GitHubBranchEvidence {
  name: string;
  url: string;
  oid: string;
}

/** All provider I/O is injected through this boundary; adapter tests never invoke gh. */
export interface GitHubTransport {
  listIssues(repository: string, cursor: string | null): Promise<Page<GitHubIssueRecord>>;
  getIssuesByNodeIds(ids: readonly string[]): Promise<(GitHubIssueRecord | null)[]>;
  listLabels(issueId: string, cursor: string | null): Promise<Page<string>>;
  listBlockedBy(issueId: string, cursor: string | null): Promise<Page<GitHubIssueLink>>;
  listProjectItems(issueId: string, cursor: string | null): Promise<Page<GitHubProjectItem>>;
  listProjectFieldValues(itemId: string, cursor: string | null): Promise<Page<GitHubProjectFieldValue>>;
  listComments(issueId: string, cursor: string | null): Promise<Page<GitHubComment>>;
  listClosingPullRequests(issueId: string, cursor: string | null): Promise<Page<GitHubPullRequestEvidence>>;
  /** Squash-merge one pull request by node id. A mutation: callers gate it. */
  /**
   * Required, not optional. As an optional member every wrapper that forgot to
   * forward it type-checked fine and read downstream as "this transport cannot
   * merge" — which is how auto-merge stayed off in every project while the
   * configuration said it was on. A transport that genuinely cannot merge should
   * throw, where the failure is visible.
   */
  mergePullRequest(pullRequestId: string, commitHeadline: string): Promise<void>;

  /**
   * Whether `head` contains `base` — that is, whether the work grew from it
   * rather than being a different lineage. Answered over REST, which has its own
   * hourly budget, so an ancestry question never competes with the GraphQL reads.
   */
  containsCommit(repository: string, base: string, head: string): Promise<boolean>;
  getBranch(repository: string, branchName: string): Promise<GitHubBranchEvidence | null>;
  getBaseSha(repository: string, branchName: string): Promise<string>;
  appendComment(issueId: string, body: string): Promise<GitHubComment>;
  replaceLabels(repository: string, issueNumber: number, labels: readonly string[]): Promise<void>;
  updateProjectSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void>;
  updateProjectText(projectId: string, itemId: string, fieldId: string, value: string): Promise<void>;
}

type GraphPage<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

/** Labels requested inline per issue in the repository listing. */
const LISTING_LABEL_PAGE_SIZE = 50;

function page<T>(connection: GraphPage<T>): Page<T> {
  return {
    nodes: connection.nodes,
    nextCursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null,
  };
}

function headRollup(raw: Record<string, unknown>): Record<string, unknown> | null {
  const commits = raw.commits as { nodes?: { commit?: { statusCheckRollup?: Record<string, unknown> | null } }[] } | undefined;
  return commits?.nodes?.[0]?.commit?.statusCheckRollup ?? null;
}

function rollupState(raw: Record<string, unknown>): string | null {
  const rollup = headRollup(raw);
  return rollup && typeof rollup.state === "string" ? rollup.state : null;
}

function rollupCount(raw: Record<string, unknown>): number {
  const contexts = headRollup(raw)?.contexts as { totalCount?: unknown } | undefined;
  return typeof contexts?.totalCount === "number" ? contexts.totalCount : 0;
}

function splitRepository(repository: string): [string, string] {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((entry) => !entry)) throw new Error("repository must be owner/name");
  return parts as [string, string];
}

function priorityFromLabels(labels: readonly string[]): number | null {
  for (const label of labels) {
    const match = /^(?:priority[:\s-]*|p)([1-4])$/i.exec(label.trim());
    if (match) return Number(match[1]);
  }
  return null;
}

/** Authenticated gh CLI implementation. It is inert until a caller invokes an operation. */
export class GhCliTransport implements GitHubTransport {
  constructor(readonly executable = "gh") {}

  async listIssues(repository: string, cursor: string | null): Promise<Page<GitHubIssueRecord>> {
    const [owner, name] = splitRepository(repository);
    // Labels ride along with the listing: hydrating an issue costs six further
    // queries, and an issue with no lifecycle label is never hydrated. Asking
    // for them here turns a repository-wide scan from O(issues) round trips
    // into O(pages) for everything the lane does not manage.
    const data = await this.graphql<{ repository: { issues: GraphPage<GitHubIssueRecord> } }>(`query Issues($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}){nodes{id number title body url state createdAt updatedAt assignees(first:1){nodes{id}}labels(first:LABEL_PAGE){nodes{name}totalCount}parent{id number title state url}}pageInfo{hasNextPage endCursor}}}}`.replace("LABEL_PAGE", String(LISTING_LABEL_PAGE_SIZE)), { owner, name, cursor });
    return page({
      ...data.repository.issues,
      nodes: data.repository.issues.nodes.map((issue) => {
        const raw = issue as GitHubIssueRecord & {
          assignees?: { nodes: { id: string }[] };
          labels?: { nodes: { name: string }[]; totalCount: number };
        };
        // A truncated label set is reported as unknown rather than as a short
        // list: claiming "no lifecycle label" from a partial page would skip an
        // issue that actually holds a claim.
        const truncated = raw.labels ? raw.labels.totalCount > raw.labels.nodes.length : true;
        return {
          ...issue,
          assigneeId: raw.assignees?.nodes[0]?.id ?? null,
          labelNames: raw.labels && !truncated ? raw.labels.nodes.map((label) => label.name) : null,
          // GitHub Issues have no repository-level priority field. Preserve an
          // exact 1..4 priority label when present; everything else is the
          // upstream comparator's null/other bucket.
          priority: raw.labels && !truncated ? priorityFromLabels(raw.labels.nodes.map((label) => label.name)) : null,
          parent: issue.parent ?? null,
        };
      }),
    });
  }

  async getIssuesByNodeIds(ids: readonly string[]): Promise<(GitHubIssueRecord | null)[]> {
    if (ids.length === 0) return [];
    // GitHub answers at most a hundred node ids per request and rejects the whole
    // call beyond that — razumv/lineage2-classic-ue has 579 issues, and asking for
    // all of them at once returned "We received a malformed request from your
    // client (HTTP 400)", which failed the project's reconstruction outright. The
    // chunks are requested in order and concatenated, so the caller still gets one
    // answer per id in the order it asked.
    if (ids.length > GITHUB_NODE_IDS_PER_REQUEST) {
      const answers: (GitHubIssueRecord | null)[] = [];
      for (let start = 0; start < ids.length; start += GITHUB_NODE_IDS_PER_REQUEST) {
        answers.push(...await this.getIssuesByNodeIds(ids.slice(start, start + GITHUB_NODE_IDS_PER_REQUEST)));
      }
      return answers;
    }
    const data = await this.graphql<{ nodes: ({
      id: string; number: number; title: string; body: string; url: string; state: "OPEN" | "CLOSED";
      createdAt: string; updatedAt: string; assignees: { nodes: { id: string }[] };
    } | null)[] }>(`query IssueNodes($ids:[ID!]!){nodes(ids:$ids){... on Issue{id number title body url state createdAt updatedAt assignees(first:1){nodes{id}}}}}`, { ids });
    return data.nodes.map((issue) => issue ? { ...issue, assigneeId: issue.assignees.nodes[0]?.id ?? null } : null);
  }

  async listLabels(issueId: string, cursor: string | null): Promise<Page<string>> {
    const data = await this.graphql<{ node: { labels: GraphPage<{ name: string }> } | null }>(`query Labels($id:ID!,$cursor:String){node(id:$id){... on Issue{labels(first:100,after:$cursor){nodes{name}pageInfo{hasNextPage endCursor}}}}}`, { id: issueId, cursor });
    if (!data.node) throw new Error(`GitHub issue node ${issueId} is missing`);
    const result = page(data.node.labels);
    return { nodes: result.nodes.map((entry) => entry.name), nextCursor: result.nextCursor };
  }

  async listBlockedBy(issueId: string, cursor: string | null): Promise<Page<GitHubIssueLink>> {
    const data = await this.graphql<{ node: { blockedBy: GraphPage<GitHubIssueLink> } | null }>(`query BlockedBy($id:ID!,$cursor:String){node(id:$id){... on Issue{blockedBy(first:100,after:$cursor){nodes{id number title state url}pageInfo{hasNextPage endCursor}}}}}`, { id: issueId, cursor });
    if (!data.node) throw new Error(`GitHub issue node ${issueId} is missing`);
    return page(data.node.blockedBy);
  }

  async listProjectItems(issueId: string, cursor: string | null): Promise<Page<GitHubProjectItem>> {
    const data = await this.graphql<{ node: { projectItems: GraphPage<{ id: string; project: { id: string } }> } | null }>(`query ProjectItems($id:ID!,$cursor:String){node(id:$id){... on Issue{projectItems(first:100,after:$cursor,includeArchived:true){nodes{id project{id}}pageInfo{hasNextPage endCursor}}}}}`, { id: issueId, cursor });
    if (!data.node) throw new Error(`GitHub issue node ${issueId} is missing`);
    const result = page(data.node.projectItems);
    return { nodes: result.nodes.map((item) => ({ id: item.id, projectId: item.project.id })), nextCursor: result.nextCursor };
  }

  async listProjectFieldValues(itemId: string, cursor: string | null): Promise<Page<GitHubProjectFieldValue>> {
    const data = await this.graphql<{ node: { fieldValues: GraphPage<Record<string, unknown>> } | null }>(`query FieldValues($id:ID!,$cursor:String){node(id:$id){... on ProjectV2Item{fieldValues(first:100,after:$cursor){nodes{__typename ... on ProjectV2ItemFieldSingleSelectValue{field{... on ProjectV2SingleSelectField{id name}}optionId name}... on ProjectV2ItemFieldTextValue{field{... on ProjectV2Field{id name}}text}... on ProjectV2ItemFieldNumberValue{field{... on ProjectV2Field{id name}}number}... on ProjectV2ItemFieldDateValue{field{... on ProjectV2Field{id name}}date}}pageInfo{hasNextPage endCursor}}}}}`, { id: itemId, cursor });
    if (!data.node) throw new Error(`GitHub project item ${itemId} is missing`);
    const result = page(data.node.fieldValues);
    return { nodes: result.nodes.map(normalizeRawFieldValue), nextCursor: result.nextCursor };
  }

  async listComments(issueId: string, cursor: string | null): Promise<Page<GitHubComment>> {
    const data = await this.graphql<{ node: { comments: GraphPage<GitHubComment & { author: { login: string } | null }> } | null }>(`query Comments($id:ID!,$cursor:String){node(id:$id){... on Issue{comments(first:100,after:$cursor){nodes{databaseId body author{login}createdAt updatedAt}pageInfo{hasNextPage endCursor}}}}}`, { id: issueId, cursor });
    if (!data.node) throw new Error(`GitHub issue node ${issueId} is missing`);
    const result = page(data.node.comments);
    return { nodes: result.nodes.map((entry) => ({ ...entry, authorLogin: entry.author?.login ?? null })), nextCursor: result.nextCursor };
  }

  async listClosingPullRequests(issueId: string, cursor: string | null): Promise<Page<GitHubPullRequestEvidence>> {
    const data = await this.graphql<{ node: { closedByPullRequestsReferences: GraphPage<Record<string, unknown>> } | null }>(`query PullRequests($id:ID!,$cursor:String){node(id:$id){... on Issue{closedByPullRequestsReferences(first:100,after:$cursor,includeClosedPrs:true){nodes{id url state headRefName headRefOid baseRefName baseRefOid mergedAt mergeCommit{oid} mergeable commits(last:1){nodes{commit{statusCheckRollup{state contexts(first:1){totalCount}}}}}}pageInfo{hasNextPage endCursor}}}}}`, { id: issueId, cursor });
    if (!data.node) throw new Error(`GitHub issue node ${issueId} is missing`);
    const result = page(data.node.closedByPullRequestsReferences);
    return {
      nodes: result.nodes.map((raw) => ({
        id: String(raw.id), url: String(raw.url), state: raw.state as GitHubPullRequestEvidence["state"],
        headRefName: String(raw.headRefName), headRefOid: String(raw.headRefOid),
        baseRefName: String(raw.baseRefName), baseRefOid: String(raw.baseRefOid),
        mergedAt: typeof raw.mergedAt === "string" ? raw.mergedAt : null,
        mergeCommitSha: raw.mergeCommit && typeof raw.mergeCommit === "object" && "oid" in raw.mergeCommit ? String(raw.mergeCommit.oid) : null,
        mergeable: raw.mergeable === "MERGEABLE" || raw.mergeable === "CONFLICTING" ? raw.mergeable : "UNKNOWN",
        checkRollupState: rollupState(raw),
        checkCount: rollupCount(raw),
      })),
      nextCursor: result.nextCursor,
    };
  }

  async getBranch(repository: string, branchName: string): Promise<GitHubBranchEvidence | null> {
    const [owner, name] = splitRepository(repository);
    const data = await this.graphql<{ repository: { ref: { name: string; target: { oid: string } } | null } }>(`query Branch($owner:String!,$name:String!,$qualified:String!){repository(owner:$owner,name:$name){ref(qualifiedName:$qualified){name target{oid}}}}`, { owner, name, qualified: `refs/heads/${branchName}` });
    return data.repository.ref ? {
      name: branchName,
      oid: data.repository.ref.target.oid,
      url: `https://github.com/${repository}/tree/${encodeURIComponent(branchName)}`,
    } : null;
  }

  async getBaseSha(repository: string, branchName: string): Promise<string> {
    const branch = await this.getBranch(repository, branchName);
    if (!branch) throw new Error(`base branch ${branchName} is missing`);
    return branch.oid;
  }

  async containsCommit(repository: string, base: string, head: string): Promise<boolean> {
    if (base === head) return true;
    const [owner, name] = splitRepository(repository);
    // REST compare answers this in one call and spends the REST budget, not the
    // GraphQL one. `identical` and `behind` both mean head already contains base.
    const output = await this.run(["api", `repos/${owner}/${name}/compare/${base}...${head}`, "--jq", ".status"], undefined, true);
    const status = output.trim();
    return status === "ahead" || status === "identical";
  }

  async mergePullRequest(pullRequestId: string, commitHeadline: string): Promise<void> {
    await this.graphql(
      `mutation Merge($id:ID!,$headline:String!){mergePullRequest(input:{pullRequestId:$id,mergeMethod:SQUASH,commitHeadline:$headline}){pullRequest{id merged}}}`,
      { id: pullRequestId, headline: commitHeadline },
    );
  }

  async appendComment(issueId: string, body: string): Promise<GitHubComment> {
    const data = await this.graphql<{ addComment: { commentEdge: { node: GitHubComment & { author: { login: string } | null } } } }>(`mutation AppendEvent($id:ID!,$body:String!){addComment(input:{subjectId:$id,body:$body}){commentEdge{node{databaseId body author{login}createdAt updatedAt}}}}`, { id: issueId, body });
    const entry = data.addComment.commentEdge.node;
    return { ...entry, authorLogin: entry.author?.login ?? null };
  }

  async replaceLabels(repository: string, issueNumber: number, labels: readonly string[]): Promise<void> {
    const input = JSON.stringify({ labels });
    await this.run(["api", "--method", "PUT", `repos/${repository}/issues/${issueNumber}/labels`, "--input", "-"], input);
  }

  async updateProjectSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void> {
    await this.graphql(`mutation ProjectStatus($project:ID!,$item:ID!,$field:ID!,$option:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{singleSelectOptionId:$option}}){projectV2Item{id}}}`, { project: projectId, item: itemId, field: fieldId, option: optionId });
  }

  async updateProjectText(projectId: string, itemId: string, fieldId: string, value: string): Promise<void> {
    await this.graphql(`mutation ProjectText($project:ID!,$item:ID!,$field:ID!,$value:String!){updateProjectV2ItemFieldValue(input:{projectId:$project,itemId:$item,fieldId:$field,value:{text:$value}}){projectV2Item{id}}}`, { project: projectId, item: itemId, field: fieldId, value });
  }

  /** Create a repository issue with labels (work intake; not part of GitHubTransport). */
  async createIssue(repository: string, title: string, body: string, labels: readonly string[]): Promise<{ id: string; number: number; url: string }> {
    const [owner, name] = splitRepository(repository);
    const output = await this.run([
      "api", `repos/${owner}/${name}/issues`, "--method", "POST",
      "-f", `title=${title}`, "-f", `body=${body}`,
      ...labels.flatMap((label) => ["-f", `labels[]=${label}`]),
    ]);
    const parsed = JSON.parse(output) as { node_id: string; number: number; html_url: string };
    return { id: parsed.node_id, number: parsed.number, url: parsed.html_url };
  }

  /** Add an issue to a Project (v2); returns the item id (work intake helper). */
  async addIssueToProject(projectId: string, contentId: string): Promise<string> {
    const data = await this.graphql<{ addProjectV2ItemById: { item: { id: string } } }>(
      `mutation AddItem($project:ID!,$content:ID!){addProjectV2ItemById(input:{projectId:$project,contentId:$content}){item{id}}}`,
      { project: projectId, content: contentId },
    );
    return data.addProjectV2ItemById.item.id;
  }

  /** Resolve a Project (v2) URL to node id + Status/Gate field ids (config generation). */
  async resolveProject(projectUrl: string): Promise<{ projectId: string; statusFieldId: string | null; gateFieldId: string | null }> {
    const match = /^https:\/\/github\.com\/(users|orgs)\/([\w.-]+)\/projects\/(\d+)/.exec(projectUrl);
    if (!match) throw new Error(`unsupported GitHub Project URL: ${projectUrl}`);
    const [, kind, login, numberRaw] = match;
    const owner = kind === "orgs" ? "organization" : "user";
    const data = await this.graphql<Record<string, { projectV2: {
      id: string;
      fields: { nodes: { id?: string; name?: string; dataType?: string }[] };
    } | null } | null>>(
      `query Project($login:String!,$number:Int!){${owner}(login:$login){projectV2(number:$number){id fields(first:50){nodes{... on ProjectV2FieldCommon{id name dataType}}}}}}`,
      { login, number: Number(numberRaw) },
    );
    const project = data[owner]?.projectV2;
    if (!project) throw new Error(`GitHub Project not found: ${projectUrl}`);
    const field = (name: string, dataType: string) =>
      project.fields.nodes.find((node) => node.name?.toLowerCase() === name && node.dataType === dataType)?.id ?? null;
    return {
      projectId: project.id,
      statusFieldId: field("status", "SINGLE_SELECT"),
      gateFieldId: field("gate", "TEXT"),
    };
  }

  /** Find the open claim-fence issue (by label) in a repository; null when absent. */
  async findFenceIssue(repository: string, label: string): Promise<{ id: string; number: number } | null> {
    const data = await this.graphql<{ search: { nodes: { id?: string; number?: number }[] } }>(
      `query Fence($query:String!){search(query:$query,type:ISSUE,first:2){nodes{... on Issue{id number}}}}`,
      { query: `repo:${repository} is:issue is:open label:"${label}"` },
    );
    const issues = data.search.nodes.filter((node) => node.id && node.number !== undefined);
    if (issues.length > 1) throw new Error(`repository ${repository} has more than one open "${label}" issue`);
    const first = issues[0];
    return first ? { id: first.id!, number: first.number! } : null;
  }

  private async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    // A mutation is never retried. `appendComment` is not idempotent — a retry
    // that actually landed the first time would write a second ledger event and
    // the compare-and-set above would then reject both. Reads have no such
    // hazard, so only reads get another attempt.
    const isMutation = /^\s*mutation\b/.test(query);
    const output = await this.run(
      ["api", "graphql", "--input", "-"],
      JSON.stringify({ query, variables }),
      !isMutation,
    );
    const parsed = JSON.parse(output) as { data?: T; errors?: { message: string }[] };
    if (parsed.errors?.length) throw new Error(`GitHub GraphQL failed: ${parsed.errors.map((entry) => entry.message).join("; ")}`);
    if (!parsed.data) throw new Error("GitHub GraphQL returned no data");
    return parsed.data;
  }

  private async run(args: string[], stdin?: string, retryable = false): Promise<string> {
    let lastError: Error | null = null;
    for (let attempt = 1; attempt <= (retryable ? GITHUB_READ_ATTEMPTS : 1); attempt += 1) {
      const process = Bun.spawn([this.executable, ...args], {
        stdin: stdin === undefined ? undefined : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [exitCode, stdout, stderr] = await Promise.all([
        process.exited,
        new Response(process.stdout).text(),
        new Response(process.stderr).text(),
      ]);
      if (exitCode === 0) return stdout;
      const diagnostic = stderr.trim() || "no diagnostic";
      lastError = new Error(`gh command failed (${exitCode}): ${diagnostic}`);
      if (!isTransientTransportFailure(diagnostic)) throw lastError;
      if (attempt === GITHUB_READ_ATTEMPTS) break;
      await new Promise((resolve) => setTimeout(resolve, GITHUB_RETRY_BASE_MS * 2 ** (attempt - 1)));
    }
    throw lastError ?? new Error("gh command failed with no diagnostic");
  }
}

/** GitHub's own ceiling on `nodes(ids:)` per request. */
const GITHUB_NODE_IDS_PER_REQUEST = 100;

/** Attempts for one read, including the first. */
const GITHUB_READ_ATTEMPTS = 3;
const GITHUB_RETRY_BASE_MS = 1_000;

/**
 * Whether a failed `gh` invocation says the request never reached a verdict.
 *
 * A dropped connection is not an answer, and treating it as one cost a night:
 * `HTTP 499` — GitHub's edge reporting that the client went away mid-request —
 * failed one repository read, which failed the project's reconstruction, which
 * after three cycles dropped razumv/lineage2-classic-ue out of the autonomous
 * loop entirely while the repository was reachable the whole time.
 *
 * Deliberately narrow. A rate limit is excluded: it is a real answer, it will not
 * change within seconds, and retrying it just spends the budget that is already
 * gone. Anything the provider actually decided — a 4xx that is not 499, a GraphQL
 * error, a missing node — must surface unchanged, because failing closed on those
 * is what keeps WIP correct.
 */
function isTransientTransportFailure(diagnostic: string): boolean {
  if (/rate limit/i.test(diagnostic)) return false;
  return /HTTP 499|HTTP 5\d\d|timeout|timed out|connection reset|connection refused|EOF|network is unreachable|temporary failure|try again/i.test(diagnostic);
}

function normalizeRawFieldValue(raw: Record<string, unknown>): GitHubProjectFieldValue {
  const field = raw.field && typeof raw.field === "object" ? raw.field as Record<string, unknown> : null;
  const fieldId = typeof field?.id === "string" ? field.id : null;
  const fieldName = typeof field?.name === "string" ? field.name : null;
  switch (raw.__typename) {
    case "ProjectV2ItemFieldSingleSelectValue":
      return { kind: "single-select", fieldId: fieldId ?? "", fieldName: fieldName ?? "", optionId: typeof raw.optionId === "string" ? raw.optionId : null, value: typeof raw.name === "string" ? raw.name : null };
    case "ProjectV2ItemFieldTextValue":
      return { kind: "text", fieldId: fieldId ?? "", fieldName: fieldName ?? "", value: typeof raw.text === "string" ? raw.text : null };
    case "ProjectV2ItemFieldNumberValue":
      return { kind: "number", fieldId: fieldId ?? "", fieldName: fieldName ?? "", value: typeof raw.number === "number" ? raw.number : null };
    case "ProjectV2ItemFieldDateValue":
      return { kind: "date", fieldId: fieldId ?? "", fieldName: fieldName ?? "", value: typeof raw.date === "string" ? raw.date : null };
    default:
      return { kind: "other", fieldId, fieldName };
  }
}
