#!/usr/bin/env bun
// SPDX-License-Identifier: Apache-2.0

import { formatStatusOutput } from "./cli-output";
import { createLiveRunner, loadLiveRunnerConfig } from "./runner";
import type { CrashPoint } from "./scheduler";

const [configPath, command = "status", ...args] = process.argv.slice(2);
if (!configPath) fail("usage: bun run src/cli.ts <absolute-config.json> <preflight|tick|status|project|transition-pr-open|archive|watch> [options]");

const config = await loadLiveRunnerConfig(configPath);
const runner = await createLiveRunner(config);

switch (command) {
  case "preflight":
    output(await runner.preflight());
    break;
  case "tick": {
    const crashIndex = args.indexOf("--crash-after");
    const crashAfter = crashIndex >= 0 ? args[crashIndex + 1] as CrashPoint : undefined;
    if (crashAfter && !["after-claim", "after-workspace", "after-session"].includes(crashAfter)) fail("invalid --crash-after value");
    output(await runner.tick(crashAfter));
    break;
  }
  case "status":
    process.stdout.write(formatStatusOutput(await runner.readStatus(), args.includes("--compact")));
    break;
  case "project":
    output(await runner.project());
    break;
  case "transition-pr-open":
    output(await runner.transitionToPrOpen());
    break;
  case "archive":
    output(await runner.archiveExecution());
    break;
  case "watch":
    await runner.preflight();
    while (true) {
      output(await runner.tick());
      await runner.project();
      await Bun.sleep(runner.workflow.polling.intervalMs);
    }
  default:
    fail(`unknown runner command ${command}`);
}

function output(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function fail(message: string): never {
  process.stderr.write(`${message}\n`);
  process.exit(2);
}
