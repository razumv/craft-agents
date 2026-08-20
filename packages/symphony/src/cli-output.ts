// SPDX-License-Identifier: Apache-2.0

import type { LiveRunnerStatus } from "./runner";

/** Render runner status for the CLI, preserving the existing JSON output by default. */
export function formatStatusOutput(value: LiveRunnerStatus, compact = false): string {
  if (!compact) return `${JSON.stringify(value, null, 2)}\n`;

  const statuses = value.statuses ?? (value.status ? [value.status] : []);
  return statuses.length === 0
    ? ""
    : `${statuses.map(({ issueIdentifier, state, prUrl }) =>
      `${issueIdentifier}\t${state}\t${prUrl ?? "-"}`
    ).join("\n")}\n`;
}
