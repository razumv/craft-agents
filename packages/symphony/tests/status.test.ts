// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { compactRunSummary, projectStatus, type ProjectStatus, type TrackerIssueSnapshot } from "../src";

const status: ProjectStatus = {
  projectId: "PROJECT",
  issueId: "I_52",
  issueIdentifier: "razumv/craft-protocol#52",
  objective: "Add a deterministic compact mobile run-summary projection.",
  state: "owner-gate",
  attempt: 1,
  retryDueAtMs: null,
  recentEvents: [],
  branchUrl: "https://github.test/razumv/craft-protocol/tree/v4/razumv-craft-protocol-52",
  prUrl: "https://github.test/razumv/craft-protocol/pull/53",
  deploymentUrl: null,
  lastMaterialEvent: {
    sequence: 7,
    atMs: 1_787_089_620_000,
    state: "owner-gate",
    message: "targeted verification passed",
  },
  blocker: "waiting for owner approval",
  nextCompletionPoint: "exact owner decision",
  ownerGate: {
    id: "GATE-I_52-7",
    command: "APPROVE GATE-I_52-7",
    approveCommand: "APPROVE GATE-I_52-7",
    rejectCommand: "REJECT GATE-I_52-7: <reason>",
  },
};

describe("compact mobile run summary", () => {
  test("projects required durable status fields in a fixed order", () => {
    const expected = [
      "## Run summary",
      "Issue: razumv/craft-protocol#52",
      "State: owner-gate",
      "Branch / PR: https://github.test/razumv/craft-protocol/tree/v4/razumv-craft-protocol-52 / https://github.test/razumv/craft-protocol/pull/53",
      "Last material event: #7 @ 1787089620000 [owner-gate] targeted verification passed",
      "Blocker: waiting for owner approval",
      "Owner gate: GATE-I_52-7",
      "Approve: APPROVE GATE-I_52-7",
      "Reject: REJECT GATE-I_52-7: <reason>",
      "Next completion point: exact owner decision",
    ].join("\n");

    expect(compactRunSummary(status)).toBe(expected);
    expect(compactRunSummary(structuredClone(status))).toBe(expected);
  });

  test("uses explicit placeholders when optional durable evidence is absent", () => {
    expect(compactRunSummary({
      ...status,
      state: "running",
      branchUrl: null,
      prUrl: null,
      lastMaterialEvent: null,
      blocker: null,
      ownerGate: null,
      nextCompletionPoint: "pull request",
    })).toContain([
      "Branch / PR: — / —",
      "Last material event: —",
      "Blocker: —",
      "Owner gate: —",
      "Approve: —",
      "Reject: —",
      "Next completion point: pull request",
    ].join("\n"));
  });

  test("selects the latest material lifecycle event and excludes heartbeat noise", () => {
    const snapshot = {
      issue: { id: "I_52", identifier: status.issueIdentifier, state: "running", blockedBy: [] },
      contract: { projectId: status.projectId, goal: status.objective },
      evidence: {},
      events: [
        { sequence: 1, atMs: 100, state: "running", message: "attempt 1 running", kind: "running" },
        { sequence: 2, atMs: 200, state: "running", message: "attempt 1 heartbeat", kind: "heartbeat" },
        // Compatibility proof for alpha.1 events without an explicit kind.
        { sequence: 3, atMs: 300, state: "running", message: "attempt 1 heartbeat" },
      ],
    } as unknown as TrackerIssueSnapshot;

    expect(projectStatus(snapshot).lastMaterialEvent).toMatchObject({
      sequence: 1,
      message: "attempt 1 running",
    });
  });
});
