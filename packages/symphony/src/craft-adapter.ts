// SPDX-License-Identifier: Apache-2.0

import { createHash } from "node:crypto";
import type {
  Claim,
  IssueContract,
  NormalizedIssue,
  ProjectStatus,
  RunIdentity,
} from "./domain";
import { OwnerDirectiveLedger, parseOwnerGateDecision, type OwnerDirective, type OwnerGateDecision } from "./ledger";
import { ModelPolicy } from "./policy";
import { compactRunSummary } from "./status";
import { assertRuntimeIdentity, type CraftRpcTransport, type CraftRuntimeIdentity } from "./craft-transport";

export const craftSessionStatuses = [
  "running",
  "settled",
  "failed",
  "ended-without-response",
  "turn-deadline",
  "context-deadline",
  "cancelled",
  "cancel-deadline",
] as const;
export type CraftSessionStatus = (typeof craftSessionStatuses)[number];

export interface CraftMessage {
  id: string;
  role: string;
  content?: string;
  timestamp?: number;
  hidden?: boolean;
}

export interface CraftRpcSession {
  id: string;
  workspaceId: string;
  name?: string;
  messages?: CraftMessage[];
  isProcessing: boolean;
  permissionMode?: string;
  sessionStatus?: string;
  labels?: string[];
  workingDirectory?: string;
  model?: string;
  llmConnection?: string;
  projectId?: string;
  isArchived?: boolean;
  archived?: boolean;
  kanbanColumn?: string;
  createdAt?: number;
  tokenUsage?: { inputTokens?: number; contextTokens?: number; contextWindow?: number };
  lastFinalMessageId?: string;
  lastMessageRole?: string;
}

export interface CraftProjectRecord {
  config?: {
    id?: string;
    workingDirectory?: string;
    [key: string]: unknown;
  };
  workspaceId?: string;
  [key: string]: unknown;
}

export interface CraftExecutionSession {
  /** Stable v4 identity carried by the canonical run label. */
  sessionId: string;
  /** Craft-generated RPC session ID. */
  rpcSessionId: string;
  issueId: string;
  attempt: number;
  worktreePath: string;
  status: CraftSessionStatus;
  promptMessageId: string | null;
  finalResponse: string | null;
  contextTokens: number;
  /** Authoritative persisted archive truth, independent of a user-controlled workflow badge. */
  isArchived?: boolean;
  isProcessing?: boolean;
  workflowStatus?: string | null;
}

export interface CraftStartContext {
  claim: Claim;
  issue: NormalizedIssue;
  contract: IssueContract;
  ownerDirectives?: readonly Readonly<OwnerDirective>[];
  compactHandoff?: string | null;
}

export interface CraftControlAdapter {
  ensure(identity: RunIdentity, context?: CraftStartContext): Promise<CraftExecutionSession>;
  get(sessionId: string, nowMs?: number): CraftExecutionSession | null | Promise<CraftExecutionSession | null>;
  cancel?(sessionId: string, nowMs: number): Promise<CraftExecutionSession>;
}

export interface CraftAdapterConfig {
  workspaceId: string;
  projectId: string;
  projectWorkingDirectory: string;
  ownerSessionId: string;
  repositoryInstructions: string;
  issueLabelId: string;
  runLabelId: string;
  promptLabelId: string;
  model: {
    connection: string;
    allowedProfiles: string[];
  };
  expectedRuntime: CraftRuntimeIdentity;
  deadlines: {
    rpcMs: number;
    turnMs: number;
    cancelMs: number;
    pollMs: number;
    maxContextTokens: number;
  };
  maxHandoffChars: number;
  nowMs?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export interface DirectOwnerDirectiveInput {
  id: string;
  issueId: string;
  sourceSessionId: string;
  sourceMessageId: string;
  receivedAtMs: number;
  verbatim: string;
  gateId?: string;
}

export interface ProjectDeskProjection {
  status: ProjectStatus;
  activeRun: CraftExecutionSession | null;
  latestAcknowledgement: Readonly<OwnerDirective> | null;
}

export interface ProjectDeskReadback {
  issue: {
    projectId: string;
    id: string;
    identifier: string;
    objective: string;
    state: ProjectStatus["state"];
  };
  links: {
    branch: string | null;
    pullRequest: string | null;
    deployment: string | null;
  };
  latestMaterialEvent: ProjectStatus["lastMaterialEvent"];
  blocker: string | null;
  ownerGate: ProjectStatus["ownerGate"];
  nextCompletionPoint: string;
  run: null | {
    runId: string;
    sessionId: string;
    attempt: number;
    contextTokens: number;
    adapterStatus: CraftSessionStatus;
    /** Archived + not-processing wins over stale sessionStatus/kanban workflow badges. */
    truth: "terminal" | "processing" | "stopped";
    workflowBadge: string | null;
  };
  directive: null | {
    id: string;
    sourceSessionId: string | null;
    sourceMessageId: string | null;
    acknowledgementId: string | null;
    receivedAtMs: number;
    acknowledgedAtMs: number;
  };
  /** Compact markdown suitable for existing Craft session notes/mobile surfaces. */
  compact: string;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

function required(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must not be blank`);
  return value.trim();
}

function labelEntry(labelId: string, value: string): string {
  return `${required(labelId, "canonical label ID")}::${required(value, "canonical label value")}`;
}

function labelsFor(labels: readonly string[], labelId: string): string[] {
  return labels.filter((entry) => entry.startsWith(`${labelId}::`));
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 24);
}

const directiveRecordPrefix = "<!-- craft-protocol-v4:owner-directive\n";
const directiveRecordSuffix = "\n-->";

function directiveRecord(entry: OwnerDirective): string {
  return `${directiveRecordPrefix}${JSON.stringify(entry)}${directiveRecordSuffix}`;
}

function directiveRecords(notes: string): { entry: OwnerDirective; block: string }[] {
  const pattern = /<!-- craft-protocol-v4:owner-directive\n([\s\S]*?)\n-->/g;
  const matches = [...notes.matchAll(pattern)];
  if ((notes.match(/<!-- craft-protocol-v4:owner-directive/g) ?? []).length !== matches.length) {
    throw new Error("Project Desk owner directive ledger is malformed");
  }
  return matches.map((match) => {
    let entry: unknown;
    try {
      entry = JSON.parse(match[1]!);
    } catch {
      throw new Error("Project Desk owner directive ledger contains invalid JSON");
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("Project Desk owner directive ledger contains an invalid record");
    }
    return { entry: entry as OwnerDirective, block: match[0] };
  });
}

function contextTokens(session: CraftRpcSession): number {
  const values = [session.tokenUsage?.contextTokens, session.tokenUsage?.inputTokens]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0);
  return values.length ? Math.max(...values) : 0;
}

function messages(session: CraftRpcSession): CraftMessage[] {
  return Array.isArray(session.messages) ? session.messages : [];
}

function timestamp(message: CraftMessage | undefined, fallback: number): number {
  return typeof message?.timestamp === "number" && Number.isFinite(message.timestamp) ? message.timestamp : fallback;
}

export class CraftMobileControlPlaneAdapter implements CraftControlAdapter {
  readonly directives = new OwnerDirectiveLedger();
  readonly #models: ModelPolicy;
  readonly #now: () => number;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(readonly config: CraftAdapterConfig, readonly transport: CraftRpcTransport) {
    for (const [field, value] of Object.entries({
      workspaceId: config.workspaceId,
      projectId: config.projectId,
      projectWorkingDirectory: config.projectWorkingDirectory,
      ownerSessionId: config.ownerSessionId,
      repositoryInstructions: config.repositoryInstructions,
      issueLabelId: config.issueLabelId,
      runLabelId: config.runLabelId,
      promptLabelId: config.promptLabelId,
    })) required(value, `Craft adapter ${field}`);
    for (const [field, value] of Object.entries(config.deadlines)) {
      if (!Number.isInteger(value) || value < 1) throw new Error(`Craft adapter ${field} must be a positive integer`);
    }
    if (!Number.isInteger(config.maxHandoffChars) || config.maxHandoffChars < 1) {
      throw new Error("Craft adapter max handoff length must be positive");
    }
    this.#models = new ModelPolicy({
      connection: config.model.connection,
      defaultProfile: config.model.allowedProfiles[0] ?? "",
      allowedProfiles: [...config.model.allowedProfiles],
    });
    this.#now = config.nowMs ?? Date.now;
    this.#sleep = config.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async ensure(identity: RunIdentity, context?: CraftStartContext): Promise<CraftExecutionSession> {
    if (!context) throw new Error("real Craft adapter requires frozen issue/run context");
    this.assertRequest(identity, context);
    await this.verifyRuntime();
    await this.verifyProject();
    await this.verifyCanonicalLabels();

    await this.verifyOwnerDesk();
    await this.loadDirectiveLedger();
    const issueLabel = labelEntry(this.config.issueLabelId, identity.issueId);
    const runLabel = labelEntry(this.config.runLabelId, identity.sessionId);
    const compactHandoff = context.compactHandoff ?? await this.buildReplacementHandoff(identity, issueLabel, runLabel);
    const prompt = buildExecutionPrompt(
      identity,
      context.issue,
      context.contract,
      this.config.repositoryInstructions,
      context.ownerDirectives ?? this.directives.entries().filter((entry) => entry.issueId === identity.issueId),
      compactHandoff,
      this.config.maxHandoffChars,
    );
    const promptLabel = labelEntry(this.config.promptLabelId, digest(prompt));

    let sessions = await this.listSessions();
    const runMatches = sessions.filter((session) => session.labels?.includes(runLabel));
    if (runMatches.length > 1) throw new Error(`duplicate Craft sessions for canonical run ${identity.sessionId}`);
    if (runMatches.length === 1 && !runMatches[0]!.labels?.includes(issueLabel)) {
      throw new Error("canonical run label is bound to a different issue");
    }

    let session = runMatches[0];
    if (!session) {
      const created = await this.transport.invoke<CraftRpcSession>("sessions:create", [this.config.workspaceId, {
        name: `[v4] ${context.issue.identifier} attempt ${identity.attempt}`,
        permissionMode: "allow-all",
        workingDirectory: identity.workspacePath,
        model: context.claim.modelProfile,
        llmConnection: context.claim.modelConnection,
        sessionStatus: "in-progress",
        labels: [issueLabel, runLabel, promptLabel],
        enabledSourceSlugs: [],
        projectId: this.config.projectId,
      }], this.config.deadlines.rpcMs);
      session = created;
      sessions = await this.listSessions();
      const readback = sessions.filter((candidate) => candidate.labels?.includes(runLabel));
      if (readback.length !== 1 || readback[0]!.id !== created.id) {
        throw new Error("Craft session creation did not produce one exact durable run binding");
      }
      session = readback[0]!;
    }

    session = await this.readSession(session.id);
    this.verifySession(session, identity, context.claim, issueLabel, runLabel, promptLabel);
    const existingPrompt = this.findPrompt(session, identity.sessionId, prompt);
    if (!existingPrompt) {
      if (messages(session).some((message) => message.role === "user")) {
        throw new Error("fresh Craft execution session contains an unrelated prior user transcript");
      }
      const accepted = await this.transport.invoke<{ accepted?: unknown; messageId?: unknown }>(
        "sessions:sendMessage",
        [session.id, prompt],
        this.config.deadlines.rpcMs,
      );
      if (accepted.accepted !== true || typeof accepted.messageId !== "string" || !accepted.messageId.trim()) {
        throw new Error("Craft did not durably acknowledge the execution prompt");
      }
      session = await this.readSession(session.id);
    }

    this.verifySession(session, identity, context.claim, issueLabel, runLabel, promptLabel);
    this.findPrompt(session, identity.sessionId, prompt);
    return this.inspectSession(identity.sessionId, identity.issueId, identity.attempt, session, this.#now());
  }

  async get(sessionId: string, nowMs = this.#now()): Promise<CraftExecutionSession | null> {
    await this.verifyRuntime();
    const runLabel = labelEntry(this.config.runLabelId, sessionId);
    const matches = (await this.listSessions()).filter((session) => session.labels?.includes(runLabel));
    if (matches.length > 1) throw new Error(`duplicate Craft sessions for canonical run ${sessionId}`);
    const header = matches[0];
    if (!header) return null;
    const session = await this.readSession(header.id);
    const labels = session.labels ?? [];
    const issueEntries = labelsFor(labels, this.config.issueLabelId);
    const runEntries = labelsFor(labels, this.config.runLabelId);
    const promptEntries = labelsFor(labels, this.config.promptLabelId);
    if (issueEntries.length !== 1 || runEntries.length !== 1 || promptEntries.length !== 1 || runEntries[0] !== runLabel) {
      throw new Error("Craft run canonical label binding is absent or ambiguous");
    }
    const issueId = issueEntries[0]!.slice(this.config.issueLabelId.length + 2);
    const attempt = parseAttempt(session.name);
    this.findPrompt(session, sessionId);
    return this.inspectSession(sessionId, issueId, attempt, session, nowMs);
  }

  async cancel(sessionId: string, nowMs: number): Promise<CraftExecutionSession> {
    const current = await this.get(sessionId, nowMs);
    if (!current) throw new Error(`cannot cancel missing Craft run ${sessionId}`);
    if (!current.status.startsWith("running") && current.status !== "turn-deadline" && current.status !== "context-deadline") {
      return current;
    }
    await this.transport.invoke("sessions:cancel", [current.rpcSessionId, true], this.config.deadlines.rpcMs);
    const dueAt = nowMs + this.config.deadlines.cancelMs;
    let observed = await this.readSession(current.rpcSessionId);
    while (observed.isProcessing && this.#now() < dueAt) {
      await this.#sleep(Math.min(this.config.deadlines.pollMs, dueAt - this.#now()));
      observed = await this.readSession(current.rpcSessionId);
    }
    if (observed.isProcessing) {
      return { ...current, status: "cancel-deadline" };
    }
    const result = this.inspectSession(sessionId, current.issueId, current.attempt, observed, this.#now());
    return result.status === "settled" ? result : { ...result, status: "cancelled" };
  }

  async ingestOwnerDirective(input: DirectOwnerDirectiveInput): Promise<{
    directive: Readonly<OwnerDirective>;
    gateDecision: OwnerGateDecision | null;
  }> {
    if (input.sourceSessionId !== this.config.ownerSessionId) {
      throw new Error("owner directive source is not the configured direct-owner desk");
    }
    await this.verifyRuntime();
    await this.verifyOwnerDesk();
    const durable = await this.loadDirectiveLedger();
    const existing = this.directives.get(input.id);
    if (existing) {
      if (
        existing.issueId !== input.issueId
        || existing.sourceSessionId !== input.sourceSessionId
        || existing.sourceMessageId !== input.sourceMessageId
        || existing.receivedAtMs !== input.receivedAtMs
        || existing.verbatim !== input.verbatim
      ) {
        throw new Error(`directive ${input.id} is immutable`);
      }
      return {
        directive: existing,
        gateDecision: input.gateId ? parseOwnerGateDecision(input.verbatim, input.gateId) : null,
      };
    }
    const ownerDesk = await this.readSession(this.config.ownerSessionId);
    const sourceMatches = messages(ownerDesk).filter((message) => message.id === input.sourceMessageId);
    if (
      sourceMatches.length !== 1
      || sourceMatches[0]!.role !== "user"
      || sourceMatches[0]!.content !== input.verbatim
      || timestamp(sourceMatches[0], -1) !== input.receivedAtMs
    ) {
      throw new Error("owner directive does not match one exact direct-owner message");
    }
    const acknowledgedAtMs = this.#now();
    const remainingMs = input.receivedAtMs + 60_000 - acknowledgedAtMs;
    if (acknowledgedAtMs < input.receivedAtMs || remainingMs < 0) {
      throw new Error("owner directive acknowledgement deadline already expired");
    }
    const acknowledgementId = `ack-${digest(`${input.id}\n${input.issueId}\n${input.receivedAtMs}\n${input.verbatim}`)}`;
    const candidate: OwnerDirective = {
      id: input.id,
      issueId: input.issueId,
      receivedAtMs: input.receivedAtMs,
      acknowledgedAtMs,
      verbatim: input.verbatim,
      sourceSessionId: input.sourceSessionId,
      sourceMessageId: input.sourceMessageId,
      acknowledgementId,
    };
    const acknowledgement = `ACK ${input.id} ${acknowledgementId}`;
    const nextBody = [
      durable.notes.trim(),
      "## Latest owner acknowledgement",
      acknowledgement,
      directiveRecord(candidate),
    ].filter(Boolean).join("\n\n");
    await this.transport.invoke(
      "sessions:setNotes",
      [this.config.ownerSessionId, nextBody],
      Math.max(1, Math.min(this.config.deadlines.rpcMs, remainingMs || 1)),
    );
    if (this.#now() - input.receivedAtMs > 60_000) {
      throw new Error("owner directive acknowledgement projection missed its 60 second deadline");
    }
    await this.verifyDeskNotes(nextBody);
    const directive = this.directives.append(candidate);
    return {
      directive,
      gateDecision: input.gateId ? parseOwnerGateDecision(input.verbatim, input.gateId) : null,
    };
  }

  /** Read the same compact Project Desk projection used by notes, without mutating Craft. */
  async readProjectDesk(projection: Omit<ProjectDeskProjection, "latestAcknowledgement">): Promise<ProjectDeskReadback> {
    await this.verifyRuntime();
    await this.verifyOwnerDesk();
    await this.loadDirectiveLedger();
    return projectDeskReadback({
      ...projection,
      latestAcknowledgement: this.directives.entries()
        .filter((entry) => entry.issueId === projection.status.issueId)
        .at(-1) ?? null,
    });
  }

  async projectToDesk(projection: ProjectDeskProjection): Promise<string> {
    await this.verifyRuntime();
    await this.verifyOwnerDesk();
    const durable = await this.loadDirectiveLedger();
    const latest = projection.latestAcknowledgement ?? this.directives.entries()
      .filter((entry) => entry.issueId === projection.status.issueId)
      .at(-1) ?? null;
    const compact = compactProjectDeskProjection({ ...projection, latestAcknowledgement: latest });
    const body = [compact, ...durable.blocks].join("\n\n");
    await this.transport.invoke("sessions:setNotes", [this.config.ownerSessionId, body], this.config.deadlines.rpcMs);
    await this.verifyDeskNotes(body);
    return body;
  }

  private async loadDirectiveLedger(): Promise<{ notes: string; blocks: string[] }> {
    const notes = await this.transport.invoke<unknown>(
      "sessions:getNotes",
      [this.config.ownerSessionId],
      this.config.deadlines.rpcMs,
    );
    if (typeof notes !== "string") throw new Error("Project Desk notes response is ambiguous");
    const records = directiveRecords(notes);
    for (const record of records) this.directives.append(record.entry);
    return { notes, blocks: records.map((record) => record.block) };
  }

  private async verifyDeskNotes(expected: string): Promise<void> {
    const readback = await this.transport.invoke<unknown>(
      "sessions:getNotes",
      [this.config.ownerSessionId],
      this.config.deadlines.rpcMs,
    );
    if (readback !== expected) throw new Error("Project Desk acknowledgement/status projection did not persist exactly");
  }

  private assertRequest(identity: RunIdentity, context: CraftStartContext): void {
    this.#models.assertAllowed(context.claim.modelProfile);
    if (context.claim.modelConnection !== this.config.model.connection) throw new Error(`Craft connection does not match model policy (expected ${this.config.model.connection})`);
    if (context.claim.sessionId !== identity.sessionId || context.claim.workspaceId !== identity.workspaceId) {
      throw new Error("Craft start context does not match deterministic run identity");
    }
    if (context.contract.projectId !== this.config.projectId) throw new Error("issue contract project does not match Craft project");
    if (context.issue.id !== identity.issueId || context.issue.identifier !== identity.issueIdentifier) {
      throw new Error("issue does not match deterministic run identity");
    }
  }

  private async verifyRuntime(): Promise<void> {
    const actual = await this.transport.identity(this.config.deadlines.rpcMs);
    assertRuntimeIdentity(actual, this.config.expectedRuntime);
  }

  private async verifyProject(): Promise<void> {
    const project = await this.transport.invoke<CraftProjectRecord | null>(
      "projects:getOne",
      [this.config.workspaceId, this.config.projectId],
      this.config.deadlines.rpcMs,
    );
    if (
      !project
      || project.config?.id !== this.config.projectId
      || project.config?.workingDirectory !== this.config.projectWorkingDirectory
    ) {
      throw new Error("Craft project binding is absent, ambiguous, or points at another repository");
    }
  }

  private async verifyOwnerDesk(): Promise<void> {
    const matches = (await this.listSessions()).filter((session) => session.id === this.config.ownerSessionId);
    if (matches.length !== 1 || matches[0]!.projectId !== this.config.projectId || matches[0]!.workspaceId !== this.config.workspaceId) {
      throw new Error("configured owner Project Desk identity is absent or ambiguous");
    }
  }

  private async verifyCanonicalLabels(): Promise<void> {
    const labels = await this.transport.invoke<unknown[]>("labels:list", [this.config.workspaceId], this.config.deadlines.rpcMs);
    const records = labels.flatMap((value) => {
      if (!value || typeof value !== "object") return [];
      const record = value as { id?: unknown; valueType?: unknown };
      return typeof record.id === "string" ? [record] : [];
    });
    for (const expected of [this.config.issueLabelId, this.config.runLabelId, this.config.promptLabelId]) {
      const matches = records.filter((record) => record.id === expected);
      if (matches.length !== 1 || matches[0]!.valueType !== "string") {
        throw new Error(`canonical Craft label ${expected} is absent, ambiguous, or not string-valued`);
      }
    }
  }

  private verifySession(
    session: CraftRpcSession,
    identity: RunIdentity,
    claim: Claim,
    issueLabel: string,
    runLabel: string,
    promptLabel: string,
  ): void {
    const labels = session.labels ?? [];
    const exact = [
      ["workspace", session.workspaceId, this.config.workspaceId],
      ["project", session.projectId, this.config.projectId],
      ["model", session.model, claim.modelProfile],
      ["connection", session.llmConnection, claim.modelConnection],
      ["worktree", session.workingDirectory, identity.workspacePath],
    ] as const;
    for (const [field, actual, expected] of exact) {
      if (actual !== expected) throw new Error(`Craft session ${field} binding mismatch`);
    }
    const expectedLabels = [
      [this.config.issueLabelId, issueLabel],
      [this.config.runLabelId, runLabel],
      [this.config.promptLabelId, promptLabel],
    ] as const;
    for (const [labelId, expected] of expectedLabels) {
      const entries = labelsFor(labels, labelId);
      if (entries.length !== 1 || entries[0] !== expected) {
        throw new Error(`Craft session canonical ${labelId} label is missing or ambiguous`);
      }
    }
  }

  private async listSessions(): Promise<CraftRpcSession[]> {
    const result = await this.transport.invoke<unknown>("sessions:get", [], this.config.deadlines.rpcMs);
    if (!Array.isArray(result)) throw new Error("Craft session list response is ambiguous");
    return result.filter((value): value is CraftRpcSession => Boolean(value && typeof value === "object" && typeof (value as CraftRpcSession).id === "string"));
  }

  private async readSession(rpcSessionId: string): Promise<CraftRpcSession> {
    const session = await this.transport.invoke<CraftRpcSession | null>(
      "sessions:getMessages",
      [rpcSessionId],
      this.config.deadlines.rpcMs,
    );
    if (!session || session.id !== rpcSessionId) throw new Error("Craft session readback is absent or ambiguous");
    return session;
  }

  private findPrompt(session: CraftRpcSession, sessionId: string, expectedPrompt?: string): CraftMessage | null {
    const marker = promptMarker(sessionId);
    const visibleUserMessages = messages(session).filter((message) => message.role === "user" && !message.hidden);
    const prompts = visibleUserMessages.filter((message) => message.content?.includes(marker));
    if (prompts.length > 1) throw new Error("Craft run contains duplicate execution prompts");
    const prompt = prompts[0] ?? null;
    if (prompt && visibleUserMessages.length !== 1) {
      throw new Error("Craft execution session contains additional user transcript");
    }
    if (!prompt) return null;
    if (!prompt.content || (expectedPrompt !== undefined && prompt.content !== expectedPrompt)) {
      throw new Error("Craft execution prompt content does not match its frozen contract");
    }
    const promptLabels = labelsFor(session.labels ?? [], this.config.promptLabelId);
    if (promptLabels.length !== 1 || promptLabels[0] !== labelEntry(this.config.promptLabelId, digest(prompt.content))) {
      throw new Error("Craft execution prompt digest binding is absent or ambiguous");
    }
    return prompt;
  }

  private inspectSession(
    sessionId: string,
    issueId: string,
    attempt: number,
    session: CraftRpcSession,
    nowMs: number,
  ): CraftExecutionSession {
    const prompt = this.findPrompt(session, sessionId);
    const allMessages = messages(session);
    const promptIndex = prompt ? allMessages.findIndex((message) => message.id === prompt.id) : -1;
    const afterPrompt = promptIndex >= 0 ? allMessages.slice(promptIndex + 1) : [];
    const errors = afterPrompt.filter((message) => message.role === "error");
    const final = session.lastFinalMessageId
      ? afterPrompt.find((message) => (
          message.id === session.lastFinalMessageId
          && message.role === "assistant"
          && !message.hidden
          && message.content?.trim()
        ))
      : undefined;
    const usedContext = contextTokens(session);
    const promptAt = timestamp(prompt ?? undefined, session.createdAt ?? nowMs);
    const turnDueAt = promptAt + this.config.deadlines.turnMs;
    const finalAt = final ? timestamp(final, Number.POSITIVE_INFINITY) : null;
    let status: CraftSessionStatus;
    if (errors.length > 0) status = "failed";
    else if (usedContext >= this.config.deadlines.maxContextTokens) status = "context-deadline";
    else if (final && finalAt !== null && finalAt <= turnDueAt && !session.isProcessing) status = "settled";
    else if (prompt && ((finalAt !== null && finalAt > turnDueAt) || nowMs >= turnDueAt)) status = "turn-deadline";
    else if (!session.isProcessing && prompt) status = "ended-without-response";
    else status = "running";
    return {
      sessionId,
      rpcSessionId: session.id,
      issueId,
      attempt,
      worktreePath: session.workingDirectory ?? "",
      status,
      promptMessageId: prompt?.id ?? null,
      finalResponse: final?.content?.trim() ?? null,
      contextTokens: usedContext,
      isArchived: session.isArchived === true || session.archived === true || session.kanbanColumn === "archived",
      isProcessing: session.isProcessing,
      workflowStatus: session.sessionStatus ?? session.kanbanColumn ?? null,
    };
  }

  private async buildReplacementHandoff(identity: RunIdentity, issueLabel: string, runLabel: string): Promise<string | null> {
    if (identity.attempt <= 1) return null;
    const candidates = (await this.listSessions()).filter((session) => (
      session.labels?.includes(issueLabel)
      && !session.labels?.includes(runLabel)
      && parseAttempt(session.name) === identity.attempt - 1
    ));
    if (candidates.length > 1) throw new Error("replacement handoff has duplicate prior Craft sessions");
    const prior = candidates[0];
    if (!prior) return `Prior attempt ${identity.attempt - 1} has no unambiguous Craft session readback.`;
    const priorLabels = prior.labels ?? [];
    const priorRuns = labelsFor(priorLabels, this.config.runLabelId);
    const priorIssues = labelsFor(priorLabels, this.config.issueLabelId);
    const priorPrompts = labelsFor(priorLabels, this.config.promptLabelId);
    if (priorRuns.length !== 1 || priorIssues.length !== 1 || priorPrompts.length !== 1 || priorIssues[0] !== issueLabel) {
      throw new Error("replacement handoff prior run identity is absent or ambiguous");
    }
    const priorRun = priorRuns[0]!.slice(this.config.runLabelId.length + 2);
    const inspected = this.inspectSession(priorRun, identity.issueId, identity.attempt - 1, await this.readSession(prior.id), this.#now());
    return `Prior attempt ${identity.attempt - 1} (${priorRun}) ended as ${inspected.status}. Continue only from durable issue/tracker evidence.`;
  }
}

function parseAttempt(name: string | undefined): number {
  const match = name?.match(/ attempt (\d+)$/);
  return match ? Number(match[1]) : 1;
}

function promptMarker(sessionId: string): string {
  return `<!-- craft-protocol-v4:run ${sessionId} -->`;
}

export function buildExecutionPrompt(
  identity: RunIdentity,
  issue: NormalizedIssue,
  contract: IssueContract,
  repositoryInstructions: string,
  directives: readonly Readonly<OwnerDirective>[],
  compactHandoff: string | null | undefined,
  maxHandoffChars: number,
): string {
  const handoff = compactHandoff?.trim();
  if (handoff && handoff.length > maxHandoffChars) throw new Error("compact handoff exceeds configured bound");
  const directiveBlock = directives
    .filter((entry) => entry.issueId === issue.id)
    .map((entry) => `- ${entry.id}: ${entry.verbatim}`)
    .join("\n") || "- none";
  const contractBody = JSON.stringify({
    id: contract.id,
    projectId: contract.projectId,
    repository: contract.repository,
    goal: contract.goal,
    acceptance: contract.acceptance,
    nonGoals: contract.nonGoals,
    risk: contract.risk,
    deployAuthority: contract.deployAuthority,
    requiredBranch: contract.requiredBranch,
    baseBranch: contract.baseBranch,
    dependencies: contract.dependencies,
    modelProfile: contract.modelProfile,
    verificationBudget: contract.verificationBudget,
  }, null, 2);
  return [
    promptMarker(identity.sessionId),
    "# Issue contract",
    contractBody,
    "# Owner directives",
    directiveBlock,
    "# Repository instructions",
    repositoryInstructions.trim(),
    ...(handoff ? ["# Compact replacement handoff", handoff] : []),
  ].join("\n\n");
}

export function projectDeskReadback(projection: ProjectDeskProjection): ProjectDeskReadback {
  const { status, activeRun, latestAcknowledgement } = projection;
  const terminal = activeRun?.isArchived === true && activeRun.isProcessing === false;
  const run: ProjectDeskReadback["run"] = activeRun ? {
    runId: activeRun.sessionId,
    sessionId: activeRun.rpcSessionId,
    attempt: activeRun.attempt,
    contextTokens: activeRun.contextTokens,
    adapterStatus: activeRun.status,
    truth: terminal ? "terminal" : activeRun.isProcessing === true ? "processing" : "stopped",
    workflowBadge: activeRun.workflowStatus ?? null,
  } : null;
  const directive: ProjectDeskReadback["directive"] = latestAcknowledgement ? {
    id: latestAcknowledgement.id,
    sourceSessionId: latestAcknowledgement.sourceSessionId ?? null,
    sourceMessageId: latestAcknowledgement.sourceMessageId ?? null,
    acknowledgementId: latestAcknowledgement.acknowledgementId ?? null,
    receivedAtMs: latestAcknowledgement.receivedAtMs,
    acknowledgedAtMs: latestAcknowledgement.acknowledgedAtMs,
  } : null;
  const execution = run
    ? run.truth === "terminal"
      ? `terminal (archived + not-processing; workflow badge ${run.workflowBadge ?? "—"} ignored)`
      : `${run.truth} (${run.adapterStatus}; workflow badge ${run.workflowBadge ?? "—"})`
    : "—";
  const compact = [
    "# Project Desk — Craft Protocol v4",
    compactRunSummary(status),
    `Objective: ${status.objective}`,
    `Deploy: ${status.deploymentUrl ?? "—"}`,
    `Run: ${run?.runId ?? "—"}`,
    `Session: ${run?.sessionId ?? "—"}`,
    `Attempt: ${run?.attempt ?? "—"}`,
    `Execution: ${execution}`,
    `Context: ${run?.contextTokens ?? 0}`,
    `Directive: ${directive ? `${directive.id} / ${directive.sourceSessionId ?? "—"} / ${directive.sourceMessageId ?? "—"}` : "—"}`,
    `Acknowledgement: ${directive?.acknowledgementId ?? "—"}`,
  ].join("\n");
  return {
    issue: {
      projectId: status.projectId,
      id: status.issueId,
      identifier: status.issueIdentifier,
      objective: status.objective,
      state: status.state,
    },
    links: {
      branch: status.branchUrl,
      pullRequest: status.prUrl,
      deployment: status.deploymentUrl,
    },
    latestMaterialEvent: status.lastMaterialEvent ? { ...status.lastMaterialEvent } : null,
    blocker: status.blocker,
    ownerGate: status.ownerGate ? { ...status.ownerGate } : null,
    nextCompletionPoint: status.nextCompletionPoint,
    run,
    directive,
    compact,
  };
}

export function compactProjectDeskProjection(projection: ProjectDeskProjection): string {
  return projectDeskReadback(projection).compact;
}
