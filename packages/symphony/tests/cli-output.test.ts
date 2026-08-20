// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { formatStatusOutput } from "../src/cli-output";
import type { LiveRunnerStatus, ProjectStatus } from "../src";

function status(
  issueIdentifier: string,
  state: ProjectStatus["state"],
  prUrl: string | null,
): ProjectStatus {
  return {
    projectId: "PROJECT",
    issueId: issueIdentifier,
    issueIdentifier,
    objective: "CLI status output",
    state,
    attempt: null,
    retryDueAtMs: null,
    recentEvents: [],
    branchUrl: null,
    prUrl,
    deploymentUrl: null,
    lastMaterialEvent: null,
    blocker: null,
    issueClosed: false,
    nextCompletionPoint: "pull request",
    ownerGate: null,
  };
}

describe("runner CLI status output", () => {
  test("compact output prints exactly one line per discovered issue", () => {
    const first = status("razumv/craft-agents#25", "running", "https://github.com/razumv/craft-agents/pull/42");
    const second = status("razumv/craft-agents#26", "ready", null);
    const value: LiveRunnerStatus = {
      snapshot: null,
      status: first,
      execution: null,
      statuses: [first, second],
    };

    expect(formatStatusOutput(value, true)).toBe([
      "razumv/craft-agents#25\trunning\thttps://github.com/razumv/craft-agents/pull/42",
      "razumv/craft-agents#26\tready\t-",
      "",
    ].join("\n"));
  });

  test("compact output prints the pinned issue when discovery statuses are absent", () => {
    const pinned = status("razumv/craft-agents#25", "pr-open", "https://github.com/razumv/craft-agents/pull/42");
    const value: LiveRunnerStatus = { snapshot: null, status: pinned, execution: null };

    expect(formatStatusOutput(value, true)).toBe(
      "razumv/craft-agents#25\tpr-open\thttps://github.com/razumv/craft-agents/pull/42\n",
    );
  });

  test("default output remains pretty-printed JSON", () => {
    const value: LiveRunnerStatus = {
      snapshot: null,
      status: status("razumv/craft-agents#25", "running", null),
      execution: null,
    };

    expect(formatStatusOutput(value)).toBe(`${JSON.stringify(value, null, 2)}\n`);
  });
});
