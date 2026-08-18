// SPDX-License-Identifier: Apache-2.0

import { constants } from "node:fs";
import { access, realpath, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";

export interface CraftRuntimeIdentity {
  cliPath: string;
  cliVersion: string;
  serverId: string;
  serverVersion: string;
}

export interface CraftServerStatus {
  serverId?: unknown;
  version?: unknown;
  [key: string]: unknown;
}

/** Minimal injected boundary. Tests implement this in memory and never touch live Craft. */
export interface CraftRpcTransport {
  invoke<T>(channel: string, args?: readonly unknown[], deadlineMs?: number): Promise<T>;
  identity(deadlineMs?: number): Promise<CraftRuntimeIdentity>;
}

export interface CraftCliTransportConfig {
  cliPath: string;
  serverUrl: string;
  serverToken?: string;
  rpcDeadlineMs: number;
  expected: {
    cliPath: string;
    cliVersion: string;
    serverId: string;
    serverVersion: string;
  };
}

function required(value: string, field: string): string {
  if (!value.trim()) throw new Error(`${field} must be configured`);
  return value.trim();
}

export function validateCraftCliConfig(config: CraftCliTransportConfig): void {
  if (!isAbsolute(config.cliPath) || !isAbsolute(config.expected.cliPath)) {
    throw new Error("Craft CLI path and expected CLI path must be absolute");
  }
  if (resolve(config.cliPath) !== resolve(config.expected.cliPath)) {
    throw new Error("configured Craft CLI path does not exactly match expected identity");
  }
  required(config.serverUrl, "Craft server URL");
  required(config.expected.cliVersion, "expected Craft CLI version");
  required(config.expected.serverId, "expected Craft server ID");
  required(config.expected.serverVersion, "expected Craft server version");
  if (!Number.isInteger(config.rpcDeadlineMs) || config.rpcDeadlineMs < 1) {
    throw new Error("Craft RPC deadline must be a positive integer");
  }
}

/**
 * Explicit CLI-backed transport. Construction is inert; validate() must succeed before use.
 * It never guesses a packaged path and never spawns a Craft runtime.
 */
export class CraftCliRpcTransport implements CraftRpcTransport {
  #validatedIdentity: CraftRuntimeIdentity | null = null;

  constructor(readonly config: CraftCliTransportConfig) {
    validateCraftCliConfig(config);
  }

  async validate(): Promise<CraftRuntimeIdentity> {
    const configuredPath = resolve(this.config.cliPath);
    const info = await stat(configuredPath).catch(() => null);
    if (!info?.isFile()) throw new Error("configured Craft CLI path is not a file");
    await access(configuredPath, constants.X_OK).catch(() => {
      throw new Error("configured Craft CLI path is not executable");
    });
    const actualPath = await realpath(configuredPath);
    const expectedPath = await realpath(this.config.expected.cliPath).catch(() => resolve(this.config.expected.cliPath));
    if (actualPath !== expectedPath) throw new Error("Craft CLI realpath is ambiguous or unexpected");

    const cliVersion = (await this.run(["--version"], this.config.rpcDeadlineMs, false)).trim();
    const status = await this.rawInvoke<CraftServerStatus>("server:getStatus", [], this.config.rpcDeadlineMs);
    const serverId = typeof status.serverId === "string" ? status.serverId.trim() : "";
    const serverVersion = typeof status.version === "string" ? status.version.trim() : "";
    const identity = { cliPath: actualPath, cliVersion, serverId, serverVersion };
    assertRuntimeIdentity(identity, { ...this.config.expected, cliPath: expectedPath });
    this.#validatedIdentity = identity;
    return { ...identity };
  }

  async identity(deadlineMs = this.config.rpcDeadlineMs): Promise<CraftRuntimeIdentity> {
    if (deadlineMs !== this.config.rpcDeadlineMs) {
      throw new Error("Craft runtime identity must use the configured auditable deadline");
    }
    // Re-read both identities: a replaced CLI or restarted server must not inherit trust.
    return this.validate();
  }

  async invoke<T>(channel: string, args: readonly unknown[] = [], deadlineMs = this.config.rpcDeadlineMs): Promise<T> {
    if (!this.#validatedIdentity) throw new Error("Craft CLI/runtime identity must be validated before RPC mutation");
    return this.rawInvoke<T>(channel, args, deadlineMs);
  }

  private async rawInvoke<T>(channel: string, args: readonly unknown[], deadlineMs: number): Promise<T> {
    required(channel, "Craft RPC channel");
    const output = await this.run([
      "--json",
      "--url", this.config.serverUrl,
      "--timeout", String(deadlineMs),
      "invoke", channel,
      ...args.map((arg) => JSON.stringify(arg)),
    ], deadlineMs, true);
    if (output.trim() === "") return undefined as T;
    try {
      return JSON.parse(output) as T;
    } catch {
      throw new Error(`Craft RPC ${channel} returned non-JSON output`);
    }
  }

  private async run(args: string[], deadlineMs: number, includeServerToken: boolean): Promise<string> {
    if (!Number.isInteger(deadlineMs) || deadlineMs < 1) throw new Error("Craft RPC deadline must be positive");
    const env = { ...process.env };
    if (includeServerToken && this.config.serverToken) env.CRAFT_SERVER_TOKEN = this.config.serverToken;
    const processHandle = Bun.spawn([this.config.cliPath, ...args], {
      env,
      stdout: "pipe",
      stderr: "pipe",
      timeout: deadlineMs,
      // SIGKILL is deliberate: RPC/identity deadlines are hard safety bounds and
      // an unresponsive CLI must not hold replacement or cancellation open.
      killSignal: "SIGKILL",
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(processHandle.stdout).text(),
      new Response(processHandle.stderr).text(),
      processHandle.exited,
    ]);
    if (exitCode !== 0) {
      const detail = stderr.trim() || `exit ${exitCode}`;
      throw new Error(`configured Craft CLI failed: ${detail}`);
    }
    return stdout;
  }
}

export function assertRuntimeIdentity(
  actual: CraftRuntimeIdentity,
  expected: CraftCliTransportConfig["expected"],
): void {
  const entries: [keyof CraftRuntimeIdentity, string, string][] = [
    ["cliPath", actual.cliPath, expected.cliPath],
    ["cliVersion", actual.cliVersion, expected.cliVersion],
    ["serverId", actual.serverId, expected.serverId],
    ["serverVersion", actual.serverVersion, expected.serverVersion],
  ];
  for (const [field, value, wanted] of entries) {
    if (!value.trim()) throw new Error(`Craft runtime identity ${field} is absent`);
    if (value !== wanted) throw new Error(`Craft runtime identity ${field} mismatch`);
  }
}
