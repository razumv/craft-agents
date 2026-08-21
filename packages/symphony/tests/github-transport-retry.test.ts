// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GhCliTransport } from "../src/github-transport";

/**
 * A stub `gh` that fails a given number of times with a given diagnostic and then
 * succeeds, recording every invocation. Written as a real executable because the
 * transport spawns a process, and stubbing the spawn instead would test the stub.
 */
function stubGh(options: { failures: number; diagnostic: string; payload: string }): { path: string; countPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "gh-stub-"));
  const countPath = join(dir, "calls");
  const path = join(dir, "gh");
  writeFileSync(countPath, "");
  writeFileSync(path, `#!/bin/sh
cat >/dev/null
printf 'x' >> "${countPath}"
calls=$(wc -c < "${countPath}" | tr -d ' ')
if [ "$calls" -le "${options.failures}" ]; then
  printf '%s' '${options.diagnostic}' >&2
  exit 1
fi
printf '%s' '${options.payload}'
`);
  chmodSync(path, 0o755);
  return { path, countPath };
}

const PAYLOAD = JSON.stringify({ data: { repository: { issues: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } } });

describe("gh transport retry", () => {
  test("a dropped connection is retried and the read still succeeds", async () => {
    const { path, countPath } = stubGh({ failures: 2, diagnostic: "gh: HTTP 499", payload: PAYLOAD });
    const transport = new GhCliTransport(path);

    const page = await transport.listIssues("acme/repo", null);
    expect(page.nodes).toEqual([]);
    // Three attempts: two dropped connections, then the answer. One 499 used to
    // fail a whole repository read and, three cycles later, drop the project.
    expect(Bun.file(countPath).size).toBe(3);
  });

  test("a rate limit is not retried, because it is an answer", async () => {
    const { path, countPath } = stubGh({ failures: 99, diagnostic: "gh: API rate limit already exceeded", payload: PAYLOAD });
    const transport = new GhCliTransport(path);

    await expect(transport.listIssues("acme/repo", null)).rejects.toThrow(/rate limit/);
    // Retrying spends a budget that is already gone and delays the real recovery.
    expect(Bun.file(countPath).size).toBe(1);
  });

  test("a provider verdict is surfaced unchanged rather than retried", async () => {
    const { path, countPath } = stubGh({ failures: 99, diagnostic: "gh: Could not resolve to a node", payload: PAYLOAD });
    const transport = new GhCliTransport(path);

    await expect(transport.listIssues("acme/repo", null)).rejects.toThrow(/Could not resolve/);
    expect(Bun.file(countPath).size).toBe(1);
  });

  test("a mutation is never retried, even on a dropped connection", async () => {
    const { path, countPath } = stubGh({ failures: 1, diagnostic: "gh: HTTP 499", payload: JSON.stringify({ data: { addComment: { commentEdge: { node: { databaseId: 1, body: "", createdAt: "", updatedAt: "" } } } } }) });
    const transport = new GhCliTransport(path);

    // A retried append that actually landed the first time writes a second ledger
    // event, and the compare-and-set then rejects both.
    await expect(transport.appendComment("I_1", "event")).rejects.toThrow(/499/);
    expect(Bun.file(countPath).size).toBe(1);
  });
});
