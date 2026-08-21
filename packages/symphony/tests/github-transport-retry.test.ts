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

  test("a secondary rate limit is retried, because the burst guard clears on its own", async () => {
    const { path, countPath } = stubGh({ failures: 1, diagnostic: "gh: You have exceeded a secondary rate limit", payload: PAYLOAD });
    const transport = new GhCliTransport(path);

    // This is what a repository-wide scan of 580 issues actually trips, and it
    // clears in tens of seconds — unlike the hourly budget, which does not.
    const page = await transport.listIssues("acme/repo", null);
    expect(page.nodes).toEqual([]);
    expect(Bun.file(countPath).size).toBe(2);
  }, 60_000);

  test("the 400 whose own text asks to resubmit is treated as the burst guard it is", async () => {
    const { path, countPath } = stubGh({
      failures: 1,
      diagnostic: "gh: We received a malformed request from your client. Please try resubmitting your request (HTTP 400)",
      payload: PAYLOAD,
    });
    const transport = new GhCliTransport(path);

    // lineage-client reported exactly this for hours and looked like it was
    // sending a bad query; it was only asking too fast.
    const page = await transport.listIssues("acme/repo", null);
    expect(page.nodes).toEqual([]);
    expect(Bun.file(countPath).size).toBe(2);
  }, 60_000);

  test("the hourly rate limit is not retried, because it is an answer", async () => {
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

describe("gh transport node-id chunking", () => {
  test("more than a hundred ids are asked for in chunks, in order", async () => {
    const dir = mkdtempSync(join(tmpdir(), "gh-nodes-"));
    const requestLog = join(dir, "requests");
    const path = join(dir, "gh");
    writeFileSync(requestLog, "");
    // The stub echoes back one node per requested id, so the assertion covers
    // both the chunk sizes and that the answers keep the caller's order.
    writeFileSync(path, `#!/usr/bin/env node
const fs = require('fs');
let body = '';
process.stdin.on('data', (chunk) => { body += chunk; });
process.stdin.on('end', () => {
  const ids = JSON.parse(body).variables.ids;
  fs.appendFileSync(${JSON.stringify(requestLog)}, ids.length + "\\n");
  const nodes = ids.map((id) => ({ id, number: Number(id.slice(2)), title: id, body: "", url: "u", state: "OPEN", createdAt: "2026-01-01T00:00:00Z", updatedAt: "2026-01-01T00:00:00Z", assignees: { nodes: [] } }));
  process.stdout.write(JSON.stringify({ data: { nodes } }));
});
`);
    chmodSync(path, 0o755);

    const transport = new GhCliTransport(path);
    const ids = Array.from({ length: 250 }, (_, index) => `I_${index}`);
    const answers = await transport.getIssuesByNodeIds(ids);

    expect(answers).toHaveLength(250);
    expect(answers.map((entry) => entry?.id)).toEqual(ids);
    // 100 + 100 + 50: asking for all 250 at once is what GitHub rejected.
    expect(Bun.file(requestLog).text().then((text) => text.trim().split("\n"))).resolves.toEqual(["100", "100", "50"]);
  });
});
