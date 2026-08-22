// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { parseWorkflow } from "../src";

const fixturePath = resolve(import.meta.dir, "fixtures/WORKFLOW.md");

describe("pre-claim executable width policy", () => {
  test("defaults to one acceptance criterion when the workflow omits the limit", async () => {
    const configured = await Bun.file(fixturePath).text();
    const omitted = configured.replace("  executable_acceptance_limit: 2\n", "");
    expect(parseWorkflow(omitted, fixturePath).config.scheduler.executableAcceptanceLimit).toBe(1);
  });

  test("requires a positive integer when the workflow configures the limit", async () => {
    const configured = await Bun.file(fixturePath).text();
    const invalid = configured.replace("  executable_acceptance_limit: 2", "  executable_acceptance_limit: 0");
    expect(() => parseWorkflow(invalid, fixturePath)).toThrow("scheduler.executable_acceptance_limit must be a positive integer");
  });
});
