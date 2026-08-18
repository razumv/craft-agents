import { readFileSync } from 'node:fs'
import type { BuildIdentity } from '@craft-agent/core/types'

const COMMIT_RE = /^[0-9a-f]{40}$/
const BUILD_ID_RE = /^[0-9A-Za-z][0-9A-Za-z.+_-]{1,160}$/

export interface ReleaseManifest {
  schemaVersion: 1
  buildIdentity: BuildIdentity
  artifacts: Record<string, string>
}

export function assertBuildIdentity(value: unknown): BuildIdentity {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('release buildIdentity must be an object')
  }
  const identity = value as Record<string, unknown>
  if (identity.schemaVersion !== 1) throw new Error('release buildIdentity.schemaVersion must be 1')
  if (typeof identity.buildId !== 'string' || !BUILD_ID_RE.test(identity.buildId)) {
    throw new Error('release buildIdentity.buildId is invalid')
  }
  if (typeof identity.version !== 'string' || !identity.version.trim()) {
    throw new Error('release buildIdentity.version is required')
  }
  if (typeof identity.sourceCommit !== 'string' || !COMMIT_RE.test(identity.sourceCommit)) {
    throw new Error('release buildIdentity.sourceCommit must be a full lowercase git SHA')
  }
  if (identity.platform !== 'darwin' && identity.platform !== 'linux') {
    throw new Error('release buildIdentity.platform is unsupported')
  }
  if (identity.arch !== 'x64' && identity.arch !== 'arm64') {
    throw new Error('release buildIdentity.arch is unsupported')
  }
  return identity as unknown as BuildIdentity
}

export function loadReleaseManifest(path: string): ReleaseManifest {
  const parsed = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>
  if (parsed.schemaVersion !== 1) throw new Error('release manifest schemaVersion must be 1')
  const buildIdentity = assertBuildIdentity(parsed.buildIdentity)
  if (!parsed.artifacts || typeof parsed.artifacts !== 'object' || Array.isArray(parsed.artifacts)) {
    throw new Error('release manifest artifacts must be an object')
  }
  for (const [name, digest] of Object.entries(parsed.artifacts as Record<string, unknown>)) {
    if (!name || typeof digest !== 'string' || !/^[0-9a-f]{64}$/.test(digest)) {
      throw new Error(`release manifest artifact digest is invalid: ${name || '<empty>'}`)
    }
  }
  return {
    schemaVersion: 1,
    buildIdentity,
    artifacts: parsed.artifacts as Record<string, string>,
  }
}
