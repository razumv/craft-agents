// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import {
  ciRepairAttemptComment,
  decideCiRepair,
  extractFailedLogCommand,
  failedStepLog,
  parseCiRepairAttemptComment,
  recordCiRepairAttempt,
  type CiFailureDetail,
  type CiRepairAttempt,
  type CiRepairProposal,
  type IssueContract,
} from "../src";

const contract: IssueContract = {
  id: "CI-REPAIR",
  projectId: "PROJECT",
  repository: "acme/repo",
  goal: "implement original behavior",
  acceptance: ["original behavior remains verified", "the public result is stable"],
  nonGoals: ["runner changes"],
  risk: "medium",
  deployAuthority: "none",
  requiredBranch: "v4/acme-7",
  baseBranch: "main",
  dependencies: [],
  ownerDirectiveRefs: [],
  modelProfile: "pi/gpt-5.6-sol",
  verificationBudget: "targeted-tests-one-review-one-correction-max",
};

const failure: CiFailureDetail = {
  pullRequestId: "PR_7",
  pullRequestUrl: "https://github.test/acme/repo/pull/7",
  headBranch: contract.requiredBranch,
  headSha: "a".repeat(40),
  checkName: "validate / test",
  checkUrl: "https://github.test/acme/repo/actions/runs/7",
  command: "bun test tests/widget.test.ts",
  output: "AssertionError: expected 2, received 3",
};

function proposal(overrides: Partial<CiRepairProposal> = {}): CiRepairProposal {
  return {
    cause: "contract-work",
    diagnosis: "this contract changed the widget count but failed to update production aggregation",
    effect: "fix-contract-work",
    checkImpact: "none",
    touchedPaths: ["src/widget.ts"],
    patch: "diff --git a/src/widget.ts b/src/widget.ts\n- return parts.length + 1\n+ return parts.length",
    originalAcceptance: [...contract.acceptance],
    ...overrides,
  };
}

function attempt(number: 1 | 2, diagnosis: string): CiRepairAttempt {
  return {
    attempt: number,
    headSha: number === 1 ? "a".repeat(40) : "b".repeat(40),
    checkName: failure.checkName,
    command: failure.command,
    output: failure.output,
    cause: "contract-work",
    diagnosis,
    touchedPaths: ["src/widget.ts"],
    previousMistake: number === 1 ? null : "attempt one changed the wrong aggregation layer",
  };
}

describe("CI repair decision", () => {
  test("extracts the exact command rendered by the provider failed-step log", () => {
    const log = [
      "test\tsetup\t2026-08-21T00:00:00Z ##[group]Run bun install",
      "test\tunit\t2026-08-21T00:00:00Z ##[group]Run bun test packages/symphony/tests/ci-repair.test.ts",
      "test\tunit\t2026-08-21T00:00:01Z AssertionError: red",
    ].join("\n");
    const failed = failedStepLog(log, "unit");
    expect(failed).not.toContain("bun install");
    expect(extractFailedLogCommand(failed)).toBe("bun test packages/symphony/tests/ci-repair.test.ts");
    expect(extractFailedLogCommand("AssertionError without provider command metadata")).toBeNull();
  });

  test("does not attempt repair when the provider has no exact failure detail", () => {
    const decision = decideCiRepair({ contract, failure: null, proposal: proposal(), attempts: [] });
    expect(decision).toEqual({
      action: "handover",
      reason: "provider reported a failing rollup without exact failure detail; no repair attempted",
      evidence: null,
      diagnoses: [],
    });
  });

  test("records the provider command and output before authorizing a repository repair", () => {
    const decision = decideCiRepair({ contract, failure, proposal: proposal(), attempts: [] });
    expect(decision.action).toBe("repair");
    if (decision.action !== "repair") throw new Error(decision.reason);
    expect(decision.prompt).toContain(failure.command);
    expect(decision.prompt).toContain(failure.output);
    const recorded = recordCiRepairAttempt(decision);
    expect(recorded).toMatchObject({ command: failure.command, output: failure.output, attempt: 1 });
  });

  test("refuses a proposed repair that only weakens an assertion", () => {
    const decision = decideCiRepair({
      contract,
      failure,
      attempts: [],
      proposal: proposal({
        cause: "stale-check-expectation",
        // Mislabelled as a correction: the patch itself must still expose that
        // exact equality was replaced by a broad predicate.
        effect: "correct-stale-expectation",
        checkImpact: "correct-exact-stale-expectation",
        touchedPaths: ["tests/widget.test.ts"],
        patch: "diff --git a/tests/widget.test.ts b/tests/widget.test.ts\n- expect(actual).toBe(2)\n+ expect(actual).toBeGreaterThan(0)",
      }),
    });
    expect(decision).toMatchObject({
      action: "handover",
      reason: "repair refused: stale expectation correction changes behavior rather than exact literals",
    });
  });

  test("refuses a headerless patch because its touched paths cannot be verified", () => {
    const decision = decideCiRepair({
      contract,
      failure,
      attempts: [],
      proposal: proposal({ patch: "- return oldValue\n+ return newValue" }),
    });
    expect(decision).toMatchObject({ action: "handover", reason: "repair refused: proposed patch lacks exact per-file diff headers" });
  });

  test("refuses a patch that touches files outside the diagnosed side", () => {
    const decision = decideCiRepair({
      contract,
      failure,
      attempts: [],
      proposal: proposal({
        touchedPaths: ["src/widget.ts"],
        patch: "diff --git a/src/widget.ts b/src/widget.ts\n-old\n+new\ndiff --git a/tests/widget.test.ts b/tests/widget.test.ts\n-exact\n+broad",
      }),
    });
    expect(decision).toMatchObject({ action: "handover", reason: "repair refused: proposed patch touches paths outside its diagnosis" });
  });

  test("requires the named wrong side to match the side touched by the repair", () => {
    const decision = decideCiRepair({
      contract,
      failure,
      attempts: [],
      proposal: proposal({ cause: "earlier-merge", effect: "fix-contract-work" }),
    });
    expect(decision).toMatchObject({
      action: "handover",
      reason: "repair refused: diagnosis names earlier-merge but the proposed change targets fix-contract-work",
    });
  });

  test("classifies infrastructure as a handover and preserves exact output", () => {
    const infrastructure = { ...failure, output: "download electron-v504.zip: HTTP 504 Gateway Timeout" };
    const decision = decideCiRepair({
      contract,
      failure: infrastructure,
      attempts: [],
      proposal: proposal({
        cause: "infrastructure",
        effect: "runner-or-host-change",
        checkImpact: "none",
        touchedPaths: [],
        patch: "",
        diagnosis: "Electron's external download server returned HTTP 504; no repository change can repair the host response",
      }),
    });
    expect(decision).toMatchObject({
      action: "handover",
      evidence: infrastructure,
      reason: expect.stringContaining("cannot be fixed from the repository"),
    });
  });

  test("allows at most two attempts then hands over both diagnoses", () => {
    const attempts = [attempt(1, "first diagnosis"), attempt(2, "second diagnosis")];
    const decision = decideCiRepair({ contract, failure, proposal: proposal(), attempts });
    expect(decision).toEqual({
      action: "handover",
      reason: "two CI repair attempts were already consumed",
      evidence: failure,
      diagnoses: ["first diagnosis", "second diagnosis"],
    });
  });

  test("durable parsing also rejects attempt two without its correction learning", () => {
    const invalid = ciRepairAttemptComment("I_7", "PR_7", { ...attempt(2, "second diagnosis"), previousMistake: null });
    expect(() => parseCiRepairAttemptComment(invalid)).toThrow("invalid payload");
    const valid = ciRepairAttemptComment("I_7", "PR_7", attempt(2, "second diagnosis"));
    expect(parseCiRepairAttemptComment(valid)?.attempt.previousMistake).toBe("attempt one changed the wrong aggregation layer");
  });

  test("attempt two reports what attempt one got wrong", () => {
    const first = attempt(1, "the aggregation implementation was wrong");
    const refused = decideCiRepair({ contract, failure, attempts: [first], proposal: proposal() });
    expect(refused).toMatchObject({ action: "handover", reason: "repair refused: attempt two must state what attempt one got wrong" });

    const accepted = decideCiRepair({
      contract,
      failure: { ...failure, headSha: "b".repeat(40) },
      attempts: [first],
      proposal: proposal({ previousMistake: "attempt one fixed the helper, but the failing path uses the cached aggregate" }),
    });
    expect(accepted).toMatchObject({ action: "repair", attempt: 2 });
    if (accepted.action === "repair") expect(accepted.prompt).toContain("What it got wrong: attempt one fixed the helper");
  });

  test("never changes or re-runs the original acceptance contract", () => {
    const changed = decideCiRepair({
      contract,
      failure,
      attempts: [],
      proposal: proposal({ originalAcceptance: ["make CI green"] }),
    });
    expect(changed).toMatchObject({ action: "handover", reason: "repair refused: the original contract acceptance criteria changed" });

    const accepted = decideCiRepair({ contract, failure, attempts: [], proposal: proposal() });
    expect(contract.acceptance).toEqual(["original behavior remains verified", "the public result is stable"]);
    if (accepted.action === "repair") {
      expect(accepted.prompt).toContain("Do not re-run or reinterpret the original work contract");
      for (const criterion of contract.acceptance) expect(accepted.prompt).toContain(criterion);
    }
  });

  test("refuses repair on a branch the lane does not own", () => {
    const decision = decideCiRepair({ contract, failure: { ...failure, headBranch: "someone/else" }, proposal: proposal(), attempts: [] });
    expect(decision).toMatchObject({ action: "handover", reason: expect.stringContaining("not the lane-owned branch") });
  });
});
