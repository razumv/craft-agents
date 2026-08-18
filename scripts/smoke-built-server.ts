#!/usr/bin/env bun
import { mkdtempSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const release = resolve(process.argv[2] ?? 'dist/server')
const configDir = mkdtempSync(join(tmpdir(), 'craft-built-server-smoke-'))
const token = crypto.randomUUID() + crypto.randomUUID()
const {
  CLAUDECODE: _,
  CRAFT_SYMPHONY_CONFIG: __,
  CRAFT_CONFIG_DIR: ___,
  CRAFT_RPC_TLS_CERT: ____,
  CRAFT_RPC_TLS_KEY: _____,
  CRAFT_RPC_TLS_CA: ______,
  CRAFT_WEBUI_DIR: _______,
  CRAFT_WEBUI_PASSWORD: ________,
  CRAFT_WEBUI_WS_URL: _________,
  ...parentEnv
} = process.env
const proc = Bun.spawn([join(release, 'start.sh')], {
  env: {
    ...parentEnv,
    CRAFT_SERVER_TOKEN: token,
    CRAFT_CONFIG_DIR: configDir,
    CRAFT_DISABLE_MESSAGING: 'true',
    CRAFT_RPC_HOST: '127.0.0.1',
    CRAFT_RPC_PORT: '0',
    CRAFT_HEALTH_PORT: '0',
  },
  stdout: 'pipe',
  stderr: 'pipe',
})

async function readyUrl(): Promise<string> {
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const deadline = Date.now() + 30_000
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now()
    const next = await Promise.race([
      reader.read(),
      Bun.sleep(remaining).then(() => ({ done: true as const, value: undefined })),
    ])
    if (next.done) break
    buffer += decoder.decode(next.value, { stream: true })
    const match = buffer.match(/^CRAFT_SERVER_URL=(.+)$/m)
    if (match) return match[1]!.trim()
  }
  const stderr = await new Response(proc.stderr).text().catch(() => '')
  throw new Error(`built server did not become ready: ${stderr.trim()}`)
}

function cli(url: string, command: string[]): unknown {
  const result = Bun.spawnSync([
    join(release, 'bin', 'craft-cli'),
    '--url', url,
    '--token', token,
    '--timeout', '15000',
    '--json',
    ...command,
  ], { env: parentEnv, stdout: 'pipe', stderr: 'pipe' })
  if (result.exitCode !== 0) {
    throw new Error(`same-release CLI ${command.join(' ')} failed: ${result.stderr.toString().trim()}`)
  }
  return JSON.parse(result.stdout.toString())
}

try {
  const url = await readyUrl()
  const status = cli(url, ['status']) as any
  const health = cli(url, ['health']) as any
  const symphony = cli(url, ['symphony', 'status']) as any
  if (!status?.buildIdentity || status.version !== status.buildIdentity.buildId) {
    throw new Error('server status did not resolve to its manifest build identity')
  }
  if (symphony?.phase !== 'disabled' || symphony?.enabled !== false || symphony?.projects?.length !== 0) {
    throw new Error('unconfigured Symphony service is not default-off')
  }
  console.log(JSON.stringify({
    release,
    url,
    buildIdentity: status.buildIdentity,
    health,
    symphony,
  }, null, 2))
} finally {
  proc.kill('SIGTERM')
  await Promise.race([proc.exited, Bun.sleep(10_000)])
  if (proc.exitCode === null) proc.kill('SIGKILL')
  rmSync(configDir, { recursive: true, force: true })
}
