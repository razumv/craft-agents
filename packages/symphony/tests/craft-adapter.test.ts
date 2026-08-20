// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  CraftMobileControlPlaneAdapter,
  IdentityFactory,
  compactProjectDeskProjection,
  parseOwnerGateDecision,
  validateCraftCliConfig,
  type Claim,
  type CraftAdapterConfig,
  type CraftMessage,
  type CraftRpcSession,
  type CraftRpcTransport,
  type CraftRuntimeIdentity,
  type CraftSessionStatus,
  type IssueContract,
  type NormalizedIssue,
  type ProjectStatus,
  type RunIdentity,
} from "../src";
import parity from "./fixtures/v4.0.0-alpha.1-parity.json";

const craftSettlementParity = parity.craftSettlement as {
  agentEndWithoutFinalResponse: CraftSessionStatus;
  stoppedWithAuthoritativeFinalResponse: CraftSessionStatus;
};
const deadlineParity = parity.deadlines as typeof parity.deadlines & {
  turnStatus: CraftSessionStatus;
  contextStatus: CraftSessionStatus;
  cancelStatus: CraftSessionStatus;
};

function clone<T>(value: T): T {
  return structuredClone(value);
}

class MemoryCraftTransport implements CraftRpcTransport {
  now = 1_000_000;
  identityValue: CraftRuntimeIdentity = {
    cliPath: "/opt/craft/bin/craft-cli",
    cliVersion: "0.11.4",
    serverId: "craft-server-1",
    serverVersion: "0.11.4-admission.87951ae",
  };
  readonly sessions: CraftRpcSession[] = [{
    id: "owner-desk",
    workspaceId: "general",
    name: "Project Desk",
    messages: [],
    isProcessing: false,
    projectId: "craft-protocol-v4",
    labels: [],
  }];
  readonly calls: { channel: string; args: readonly unknown[] }[] = [];
  notes = "";
  cancellationSticky = false;
  createCount = 0;
  promptCount = 0;

  async identity(): Promise<CraftRuntimeIdentity> {
    return clone(this.identityValue);
  }

  async invoke<T>(channel: string, args: readonly unknown[] = []): Promise<T> {
    this.calls.push({ channel, args: clone(args) });
    let result: unknown;
    switch (channel) {
      case "projects:getOne":
        result = {
          config: { id: "craft-protocol-v4", workingDirectory: "/repo" },
          workspaceId: "general",
        };
        break;
      case "labels:list":
        result = [
          { id: "v4-issue", valueType: "string" },
          { id: "v4-run", valueType: "string" },
          { id: "v4-prompt", valueType: "string" },
        ];
        break;
      case "sessions:get":
        result = this.sessions.map((session) => ({ ...clone(session), messages: [] }));
        break;
      case "sessions:create": {
        const [workspaceId, options] = args as [string, Record<string, unknown>];
        const session: CraftRpcSession = {
          id: `rpc-session-${++this.createCount}`,
          workspaceId,
          name: options.name as string,
          messages: [],
          isProcessing: false,
          permissionMode: options.permissionMode as string,
          sessionStatus: options.sessionStatus as string,
          labels: clone(options.labels as string[]),
          workingDirectory: options.workingDirectory as string,
          model: options.model as string,
          llmConnection: options.llmConnection as string,
          projectId: options.projectId as string,
          createdAt: this.now,
          tokenUsage: { inputTokens: 0 },
        };
        this.sessions.push(session);
        result = clone(session);
        break;
      }
      case "sessions:sendMessage": {
        const [id, content] = args as [string, string];
        const session = this.byId(id);
        const message: CraftMessage = {
          id: `prompt-${++this.promptCount}`,
          role: "user",
          content,
          timestamp: this.now,
        };
        session.messages!.push(message);
        session.isProcessing = true;
        result = { accepted: true, messageId: message.id };
        break;
      }
      case "sessions:getMessages":
        result = clone(this.byId(args[0] as string));
        break;
      case "sessions:cancel": {
        const session = this.byId(args[0] as string);
        if (!this.cancellationSticky) session.isProcessing = false;
        result = true;
        break;
      }
      case "sessions:getNotes":
        result = this.notes;
        break;
      case "sessions:setNotes":
        this.notes = args[1] as string;
        result = undefined;
        break;
      default:
        throw new Error(`unexpected fake Craft RPC ${channel}`);
    }
    return result as T;
  }

  byId(id: string): CraftRpcSession {
    const session = this.sessions.find((candidate) => candidate.id === id);
    if (!session) throw new Error(`unknown session ${id}`);
    return session;
  }

  finish(id: string, text?: string): void {
    const session = this.byId(id);
    session.isProcessing = false;
    if (text !== undefined) {
      const final: CraftMessage = {
        id: `assistant-${session.messages!.length}`,
        role: "assistant",
        content: text,
        timestamp: ++this.now,
      };
      session.messages!.push(final);
      session.lastFinalMessageId = final.id;
    }
  }
}

const issue: NormalizedIssue = {
  id: "issue-47",
  nativeRef: { repository: "razumv/craft-protocol" },
  identifier: "CP-47",
  title: "Craft mobile control-plane adapter",
  description: "This full description must never be copied as transcript history.",
  priority: 1,
  state: "claimed",
  branchName: "v4/issue-47-craft-adapter",
  url: "https://github.com/razumv/craft-protocol/issues/47",
  assigneeId: null,
  labels: ["v4"],
  blockedBy: [],
  dispatchable: true,
    closed: false,
  createdAt: "2026-08-18T18:36:44.000Z",
  updatedAt: "2026-08-18T20:33:17.000Z",
};

const contract: IssueContract = {
  id: "V4-CRAFT",
  projectId: "craft-protocol-v4",
  repository: "razumv/craft-protocol",
  goal: "Add a Craft RPC mobile control plane.",
  acceptance: ["Codex only", "exact settlement"],
  nonGoals: ["production mutation"],
  risk: "medium",
  deployAuthority: "none",
  requiredBranch: "v4/issue-47-craft-adapter",
  baseBranch: "main",
  dependencies: ["V4-GITHUB"],
  ownerDirectiveRefs: [],
  modelProfile: "pi/gpt-5.6-sol",
  verificationBudget: "targeted-tests-one-review-one-correction-max",
};

function identity(attempt = 1): RunIdentity {
  return new IdentityFactory(resolve("/tmp/craft-protocol-v4-tests")).forAttempt(issue, attempt);
}

function claimFor(run: RunIdentity, overrides: Partial<Claim> = {}): Claim {
  return {
    ...run,
    fence: `claim-${run.attempt}`,
    baseSha: "d57d0bb8f21591c5c827ea4ab64ff095530c9ae3",
    modelConnection: "chatgpt-plus",
    modelProfile: "pi/gpt-5.6-sol",
    claimedAtMs: 1_000_000,
    heartbeatAtMs: 1_000_000,
    expiresAtMs: 1_060_000,
    ...overrides,
  };
}

function config(transport: MemoryCraftTransport, overrides: Partial<CraftAdapterConfig> = {}): CraftAdapterConfig {
  return {
    workspaceId: "general",
    projectId: "craft-protocol-v4",
    projectWorkingDirectory: "/repo",
    ownerSessionId: "owner-desk",
    repositoryInstructions: "Follow WORKFLOW.md. Run focused v4 tests only.",
    issueLabelId: "v4-issue",
    runLabelId: "v4-run",
    promptLabelId: "v4-prompt",
    model: { connection: "chatgpt-plus", allowedProfiles: ["pi/gpt-5.6-sol", "pi/gpt-5.6-terra"] },
    expectedRuntime: clone(transport.identityValue),
    deadlines: {
      rpcMs: 5_000,
      turnMs: parity.deadlines.turnMs,
      cancelMs: parity.deadlines.cancelMs,
      pollMs: 1_000,
      maxContextTokens: parity.deadlines.maxContextTokens,
    },
    maxHandoffChars: 512,
    nowMs: () => transport.now,
    sleep: async (ms) => { transport.now += ms; },
    ...overrides,
  };
}

function adapterFixture(overrides: Partial<CraftAdapterConfig> = {}) {
  const transport = new MemoryCraftTransport();
  const adapter = new CraftMobileControlPlaneAdapter(config(transport, overrides), transport);
  return { transport, adapter };
}

function directOwnerMessage(transport: MemoryCraftTransport, id: string, content: string, atMs: number) {
  transport.byId("owner-desk").messages!.push({ id, role: "user", content, timestamp: atMs });
  return { sourceSessionId: "owner-desk", sourceMessageId: id, receivedAtMs: atMs, verbatim: content };
}

function startContext(run: RunIdentity, claimOverrides: Partial<Claim> = {}) {
  return { claim: claimFor(run, claimOverrides), issue, contract };
}

const deskStatus: ProjectStatus = {
  projectId: "craft-protocol-v4",
  issueId: issue.id,
  issueIdentifier: issue.identifier,
  objective: contract.goal,
  state: "running",
  attempt: 1,
  retryDueAtMs: null,
  recentEvents: [],
  branchUrl: null,
  prUrl: null,
  deploymentUrl: null,
  lastMaterialEvent: null,
  blocker: null,
  issueClosed: false,
  nextCompletionPoint: "pull request",
  ownerGate: null,
};

describe("v4.3 Craft mobile control-plane adapter", () => {
  test("requires one explicit absolute Craft CLI path and exact expected CLI identity", () => {
    const base = {
      cliPath: "/opt/craft/bin/craft-cli",
      serverUrl: "ws://127.0.0.1:3131",
      rpcDeadlineMs: 5_000,
      expected: {
        cliPath: "/opt/craft/bin/craft-cli",
        cliVersion: "0.11.4",
        serverId: "craft-server-1",
        serverVersion: "0.11.4-admission.87951ae",
      },
    };
    expect(() => validateCraftCliConfig(base)).not.toThrow();
    expect(() => validateCraftCliConfig({ ...base, cliPath: "current/bin/craft-cli" })).toThrow("absolute");
    expect(() => validateCraftCliConfig({ ...base, cliPath: "/other/craft-cli" })).toThrow("exactly match");
    expect(() => validateCraftCliConfig({ ...base, expected: { ...base.expected, serverId: "" } })).toThrow("must be configured");
  });

  test("rejects non-Codex profiles and non-chatgpt-plus connections before mutation", async () => {
    const { adapter, transport } = adapterFixture();
    const run = identity();
    await expect(adapter.ensure(run, startContext(run, { modelProfile: "claude-fable-5" }))).rejects.toThrow("model policy rejected");
    await expect(adapter.ensure(run, startContext(run, { modelConnection: "api-key" as "chatgpt-plus" }))).rejects.toThrow("chatgpt-plus");
    expect(transport.createCount).toBe(0);
  });

  test("creates one fresh project-bound session and verifies exact model, connection, worktree, and labels", async () => {
    const { adapter, transport } = adapterFixture();
    const run = identity();
    const session = await adapter.ensure(run, startContext(run));

    expect(session.sessionId).toBe(run.sessionId);
    expect(transport.createCount).toBe(1);
    expect(transport.promptCount).toBe(1);
    const create = transport.calls.find((call) => call.channel === "sessions:create")!;
    const options = create.args[1] as Record<string, unknown>;
    expect(options).toMatchObject({
      projectId: contract.projectId,
      model: contract.modelProfile,
      llmConnection: "chatgpt-plus",
      workingDirectory: run.workspacePath,
      labels: [
        `v4-issue::${issue.id}`,
        `v4-run::${run.sessionId}`,
        expect.stringMatching(/^v4-prompt::[0-9a-f]{24}$/),
      ],
      enabledSourceSlugs: [],
    });
    expect(options.branchFromSessionId).toBeUndefined();
    expect(options.branchFromMessageId).toBeUndefined();

    await adapter.ensure(run, startContext(run));
    expect(transport.createCount).toBe(1);
    expect(transport.promptCount).toBe(1);

    transport.byId(session.rpcSessionId).messages![0]!.content += "\nUNRELATED INSTRUCTION";
    await expect(adapter.ensure(run, startContext(run))).rejects.toThrow("frozen contract");
  });

  test("refuses duplicate canonical sessions instead of choosing one", async () => {
    const { adapter, transport } = adapterFixture();
    const run = identity();
    await adapter.ensure(run, startContext(run));
    transport.sessions.push({ ...clone(transport.sessions.at(-1)!), id: "forged-duplicate" });

    await expect(adapter.get(run.sessionId)).rejects.toThrow("duplicate Craft sessions");
    expect(transport.createCount).toBe(1);
  });

  test("refuses sessions carrying additional canonical issue or run bindings", async () => {
    const { adapter, transport } = adapterFixture();
    const run = identity();
    const started = await adapter.ensure(run, startContext(run));
    transport.byId(started.rpcSessionId).labels!.push("v4-issue::other-issue");
    await expect(adapter.get(run.sessionId)).rejects.toThrow("absent or ambiguous");
  });

  test("does not treat agent_end or complete-without-response as settlement", async () => {
    const { adapter, transport } = adapterFixture();
    const run = identity();
    const started = await adapter.ensure(run, startContext(run));

    // A low-level agent_end is represented by processing stopping without a final assistant message.
    transport.finish(started.rpcSessionId);
    expect((await adapter.get(run.sessionId))?.status).toBe(craftSettlementParity.agentEndWithoutFinalResponse);

    transport.finish(started.rpcSessionId, "Durable final response.");
    const settled = await adapter.get(run.sessionId);
    expect(settled?.status).toBe(craftSettlementParity.stoppedWithAuthoritativeFinalResponse);
    expect(settled?.finalResponse).toBe("Durable final response.");
  });

  test("replacement is fresh and inherits only a bounded compact handoff, never prior transcript", async () => {
    const { adapter, transport } = adapterFixture();
    const first = identity(1);
    const firstSession = await adapter.ensure(first, startContext(first));
    transport.finish(firstSession.rpcSessionId, "SECRET PRIOR TRANSCRIPT PAYLOAD");

    const second = identity(2);
    await adapter.ensure(second, startContext(second));
    const secondCreate = transport.calls.filter((call) => call.channel === "sessions:create").at(-1)!;
    const secondOptions = secondCreate.args[1] as Record<string, unknown>;
    const secondPrompt = transport.byId("rpc-session-2").messages![0]!.content!;

    expect(secondOptions.branchFromSessionId).toBeUndefined();
    expect(secondOptions.branchFromMessageId).toBeUndefined();
    expect(secondPrompt).toContain("# Compact replacement handoff");
    expect(secondPrompt).toContain("ended as settled");
    expect(secondPrompt).not.toContain("SECRET PRIOR TRANSCRIPT PAYLOAD");
    expect(secondPrompt).not.toContain(issue.description!);
  });

  test("direct owner directives project an immutable acknowledgement within 60 seconds", async () => {
    const { adapter, transport } = adapterFixture();
    const source = directOwnerMessage(transport, "owner-message-1", "Do not touch production.", transport.now - 60_000);
    const result = await adapter.ingestOwnerDirective({
      id: "directive-47-1",
      issueId: issue.id,
      ...source,
    });

    expect(result.directive.acknowledgedAtMs - result.directive.receivedAtMs).toBeLessThanOrEqual(60_000);
    expect(transport.notes).toContain(`ACK directive-47-1 ${result.directive.acknowledgementId}`);

    const run = identity();
    const execution = await adapter.ensure(run, startContext(run));
    const prompt = transport.byId(execution.rpcSessionId).messages![0]!.content!;
    expect(prompt).toContain("# Owner directives\n\n- directive-47-1: Do not touch production.");

    await expect(adapter.ingestOwnerDirective({
      id: "directive-47-1",
      issueId: issue.id,
      ...source,
      verbatim: "Touch production.",
    })).rejects.toThrow("immutable");
    const restarted = new CraftMobileControlPlaneAdapter(config(transport), transport);
    await expect(restarted.ingestOwnerDirective({
      id: "directive-47-1",
      issueId: issue.id,
      ...source,
      verbatim: "Touch production after restart.",
    })).rejects.toThrow("immutable");

    const projected = await restarted.projectToDesk({ status: deskStatus, activeRun: null, latestAcknowledgement: null });
    expect(projected).toContain("craft-protocol-v4:owner-directive");
    expect(projected).toContain(result.directive.acknowledgementId!);

    const late = directOwnerMessage(transport, "owner-message-late", "Late.", transport.now - 60_001);
    await expect(restarted.ingestOwnerDirective({
      id: "late",
      issueId: issue.id,
      ...late,
    })).rejects.toThrow("deadline");
  });

  test("gate decisions require the exact immutable command", async () => {
    const { adapter, transport } = adapterFixture();
    const source = directOwnerMessage(transport, "owner-gate-message", "APPROVE gate-47", transport.now);
    const approved = await adapter.ingestOwnerDirective({
      id: "gate-decision-1",
      issueId: issue.id,
      ...source,
      gateId: "gate-47",
    });
    expect(approved.gateDecision).toEqual({ kind: "approve", gateId: "gate-47" });
    expect(parseOwnerGateDecision("REJECT gate-47: verification failed", "gate-47")).toEqual({
      kind: "reject",
      gateId: "gate-47",
      reason: "verification failed",
    });
    expect(() => parseOwnerGateDecision("REJECT gate-47: ", "gate-47")).toThrow("exactly match");
    expect(() => parseOwnerGateDecision("APPROVE gate-047", "gate-47")).toThrow("exactly match");
    expect(() => parseOwnerGateDecision("approve gate-47", "gate-47")).toThrow("exactly match");
  });

  test("enforces turn, context, and bounded cancellation deadlines", async () => {
    const { adapter, transport } = adapterFixture();
    const run = identity();
    const started = await adapter.ensure(run, startContext(run));
    expect((await adapter.get(run.sessionId, transport.now + parity.deadlines.turnMs))?.status).toBe(deadlineParity.turnStatus);

    const rpc = transport.byId(started.rpcSessionId);
    rpc.tokenUsage = { contextTokens: 0, inputTokens: parity.deadlines.maxContextTokens };
    transport.finish(started.rpcSessionId, "Response cannot override context exhaustion.");
    expect((await adapter.get(run.sessionId, transport.now))?.status).toBe(deadlineParity.contextStatus);

    rpc.isProcessing = true;
    transport.cancellationSticky = true;
    const cancelled = await adapter.cancel(run.sessionId, transport.now);
    expect(cancelled.status).toBe(deadlineParity.cancelStatus);
    expect(transport.now).toBe(1_000_001 + parity.deadlines.cancelMs);

    const lateFixture = adapterFixture();
    const lateRun = identity();
    const lateStarted = await lateFixture.adapter.ensure(lateRun, startContext(lateRun));
    lateFixture.transport.now += parity.deadlines.turnMs + 1;
    lateFixture.transport.finish(lateStarted.rpcSessionId, "Late final response.");
    expect((await lateFixture.adapter.get(lateRun.sessionId, lateFixture.transport.now))?.status).toBe(deadlineParity.turnStatus);
  });

  test("fails closed when CLI/server runtime identity is absent or mismatched", async () => {
    const { adapter, transport } = adapterFixture();
    transport.identityValue.serverId = "";
    const run = identity();
    await expect(adapter.ensure(run, startContext(run))).rejects.toThrow("serverId is absent");
    expect(transport.createCount).toBe(0);
  });

  test("in-memory adapter integration smoke reaches settled and projects compact Project Desk status", async () => {
    const { adapter, transport } = adapterFixture();
    const run = identity();
    const started = await adapter.ensure(run, startContext(run));
    transport.finish(started.rpcSessionId, "Worker transcript\nTool: bash focused-tests");
    const settled = await adapter.get(run.sessionId);
    expect(settled?.status).toBe(craftSettlementParity.stoppedWithAuthoritativeFinalResponse);

    const readCalls = transport.calls.filter((call) => call.channel === "sessions:setNotes").length;
    const readback = await adapter.readProjectDesk({ status: deskStatus, activeRun: settled });
    expect(readback.run).toMatchObject({
      runId: run.sessionId,
      sessionId: started.rpcSessionId,
      attempt: 1,
      contextTokens: 0,
      truth: "stopped",
    });
    expect(transport.calls.filter((call) => call.channel === "sessions:setNotes")).toHaveLength(readCalls);

    const body = await adapter.projectToDesk({ status: deskStatus, activeRun: settled, latestAcknowledgement: null });
    expect(body).toBe(compactProjectDeskProjection({ status: deskStatus, activeRun: settled, latestAcknowledgement: null }));
    expect(body).toContain("## Run summary");
    expect(body).toContain("Last material event: —");
    expect(body).toContain(`Run: ${run.sessionId}`);
    expect(body).toContain(`Session: ${started.rpcSessionId}`);
    expect(body).toContain("Attempt: 1");
    expect(body).not.toContain("Worker transcript");
    expect(body).not.toContain("Tool: bash focused-tests");
    expect(transport.notes).toBe(body);
  });

  test("archived and not-processing is terminal truth despite a stale workflow badge", async () => {
    const { adapter, transport } = adapterFixture();
    const run = identity();
    const started = await adapter.ensure(run, startContext(run));
    transport.finish(started.rpcSessionId, "Durable final response.");
    const session = transport.byId(started.rpcSessionId);
    session.isArchived = true;
    session.sessionStatus = "in-progress";

    const execution = await adapter.get(run.sessionId);
    const readback = await adapter.readProjectDesk({ status: deskStatus, activeRun: execution });
    expect(readback.run).toMatchObject({
      truth: "terminal",
      workflowBadge: "in-progress",
      adapterStatus: "settled",
    });
    expect(readback.compact).toContain("Execution: terminal (archived + not-processing; workflow badge in-progress ignored)");
  });
});
