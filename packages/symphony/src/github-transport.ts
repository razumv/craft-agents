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
  getBranch(repository: string, branchName: string): Promise<GitHubBranchEvidence | null>;
  getBaseSha(repository: string, branchName: string): Promise<string>;
  appendComment(issueId: string, body: string): Promise<GitHubComment>;
  replaceLabels(repository: string, issueNumber: number, labels: readonly string[]): Promise<void>;
  updateProjectSingleSelect(projectId: string, itemId: string, fieldId: string, optionId: string): Promise<void>;
  updateProjectText(projectId: string, itemId: string, fieldId: string, value: string): Promise<void>;
}

type GraphPage<T> = { nodes: T[]; pageInfo: { hasNextPage: boolean; endCursor: string | null } };

function page<T>(connection: GraphPage<T>): Page<T> {
  return {
    nodes: connection.nodes,
    nextCursor: connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null,
  };
}

function splitRepository(repository: string): [string, string] {
  const parts = repository.split("/");
  if (parts.length !== 2 || parts.some((entry) => !entry)) throw new Error("repository must be owner/name");
  return parts as [string, string];
}

/** Authenticated gh CLI implementation. It is inert until a caller invokes an operation. */
export class GhCliTransport implements GitHubTransport {
  constructor(readonly executable = "gh") {}

  async listIssues(repository: string, cursor: string | null): Promise<Page<GitHubIssueRecord>> {
    const [owner, name] = splitRepository(repository);
    const data = await this.graphql<{ repository: { issues: GraphPage<GitHubIssueRecord> } }>(`query Issues($owner:String!,$name:String!,$cursor:String){repository(owner:$owner,name:$name){issues(first:100,after:$cursor,orderBy:{field:CREATED_AT,direction:ASC}){nodes{id number title body url state createdAt updatedAt assignees(first:1){nodes{id}}}pageInfo{hasNextPage endCursor}}}}`, { owner, name, cursor });
    return page({
      ...data.repository.issues,
      nodes: data.repository.issues.nodes.map((issue) => ({
        ...issue,
        assigneeId: (issue as GitHubIssueRecord & { assignees?: { nodes: { id: string }[] } }).assignees?.nodes[0]?.id ?? null,
      })),
    });
  }

  async getIssuesByNodeIds(ids: readonly string[]): Promise<(GitHubIssueRecord | null)[]> {
    if (ids.length === 0) return [];
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
    const data = await this.graphql<{ node: { closedByPullRequestsReferences: GraphPage<Record<string, unknown>> } | null }>(`query PullRequests($id:ID!,$cursor:String){node(id:$id){... on Issue{closedByPullRequestsReferences(first:100,after:$cursor,includeClosedPrs:true){nodes{id url state headRefName headRefOid baseRefName baseRefOid mergedAt mergeCommit{oid}}pageInfo{hasNextPage endCursor}}}}}`, { id: issueId, cursor });
    if (!data.node) throw new Error(`GitHub issue node ${issueId} is missing`);
    const result = page(data.node.closedByPullRequestsReferences);
    return {
      nodes: result.nodes.map((raw) => ({
        id: String(raw.id), url: String(raw.url), state: raw.state as GitHubPullRequestEvidence["state"],
        headRefName: String(raw.headRefName), headRefOid: String(raw.headRefOid),
        baseRefName: String(raw.baseRefName), baseRefOid: String(raw.baseRefOid),
        mergedAt: typeof raw.mergedAt === "string" ? raw.mergedAt : null,
        mergeCommitSha: raw.mergeCommit && typeof raw.mergeCommit === "object" && "oid" in raw.mergeCommit ? String(raw.mergeCommit.oid) : null,
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

  private async graphql<T = unknown>(query: string, variables: Record<string, unknown>): Promise<T> {
    const output = await this.run(
      ["api", "graphql", "--input", "-"],
      JSON.stringify({ query, variables }),
    );
    const parsed = JSON.parse(output) as { data?: T; errors?: { message: string }[] };
    if (parsed.errors?.length) throw new Error(`GitHub GraphQL failed: ${parsed.errors.map((entry) => entry.message).join("; ")}`);
    if (!parsed.data) throw new Error("GitHub GraphQL returned no data");
    return parsed.data;
  }

  private async run(args: string[], stdin?: string): Promise<string> {
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
    if (exitCode !== 0) throw new Error(`gh command failed (${exitCode}): ${stderr.trim() || "no diagnostic"}`);
    return stdout;
  }
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
