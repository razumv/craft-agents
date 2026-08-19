/**
 * Persisted thin-client connection settings.
 *
 * Historically thin-client mode was entered only via CRAFT_SERVER_URL /
 * CRAFT_SERVER_TOKEN environment variables, which meant relaunching the app
 * from a shell (or launchctl setenv) just to point it at a remote server.
 * This module persists the same two values in ~/.craft-agent/remote-client.json
 * and injects them into process.env at startup — before any of the env
 * consumers (cert-bypass, main thin-client gate, preload transport) run.
 *
 * Explicit environment variables always win over the persisted file, so every
 * existing launcher keeps working unchanged.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'

export interface RemoteClientConfig {
  /** Connect as a thin client on next launch. */
  enabled: boolean
  /** ws:// or wss:// URL of the remote Craft server. */
  url: string
  /** Auth token for the remote server. */
  token: string
}

const CONFIG_PATH = join(homedir(), '.craft-agent', 'remote-client.json')

export function remoteClientConfigPath(): string {
  return CONFIG_PATH
}

export function loadRemoteClientConfig(): RemoteClientConfig | null {
  try {
    if (!existsSync(CONFIG_PATH)) return null
    const raw = JSON.parse(readFileSync(CONFIG_PATH, 'utf8')) as Partial<RemoteClientConfig>
    if (typeof raw.url !== 'string' || typeof raw.token !== 'string') return null
    return { enabled: raw.enabled === true, url: raw.url, token: raw.token }
  } catch {
    // A corrupt file must never block app startup; the settings page will show empty fields.
    return null
  }
}

export function saveRemoteClientConfig(config: RemoteClientConfig): RemoteClientConfig {
  if (config.enabled) {
    let parsed: URL
    try {
      parsed = new URL(config.url)
    } catch {
      throw new Error('Remote server URL is not a valid URL')
    }
    if (parsed.protocol !== 'ws:' && parsed.protocol !== 'wss:') {
      throw new Error('Remote server URL must start with ws:// or wss://')
    }
    if (!config.token.trim()) throw new Error('Remote server token is required')
  }
  const normalized: RemoteClientConfig = {
    enabled: config.enabled,
    url: config.url.trim(),
    token: config.token.trim(),
  }
  mkdirSync(dirname(CONFIG_PATH), { recursive: true })
  writeFileSync(CONFIG_PATH, JSON.stringify(normalized, null, 2) + '\n', { mode: 0o600 })
  return normalized
}

/**
 * Inject persisted settings into process.env unless explicit env vars are
 * already present. Must run at main-process module load, before anything
 * reads CRAFT_SERVER_URL.
 */
export function applyRemoteClientConfigToEnv(): void {
  if (process.env.CRAFT_SERVER_URL) return
  const config = loadRemoteClientConfig()
  if (!config?.enabled) return
  process.env.CRAFT_SERVER_URL = config.url
  process.env.CRAFT_SERVER_TOKEN = config.token
}
