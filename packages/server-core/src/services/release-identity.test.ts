import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { assertBuildIdentity, loadReleaseManifest } from './release-identity'

const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })))

const identity = {
  schemaVersion: 1 as const,
  buildId: '0.11.4+git.0123456789ab.darwin-arm64',
  version: '0.11.4',
  sourceCommit: '0123456789abcdef0123456789abcdef01234567',
  platform: 'darwin' as const,
  arch: 'arm64' as const,
}

describe('release identity', () => {
  it('loads one strict immutable manifest identity', () => {
    const dir = mkdtempSync(join(tmpdir(), 'craft-release-identity-'))
    dirs.push(dir)
    const path = join(dir, 'release-manifest.json')
    writeFileSync(path, JSON.stringify({
      schemaVersion: 1,
      buildIdentity: identity,
      artifacts: { 'bin/craft-cli': 'a'.repeat(64) },
    }))
    expect(loadReleaseManifest(path)).toEqual({
      schemaVersion: 1,
      buildIdentity: identity,
      artifacts: { 'bin/craft-cli': 'a'.repeat(64) },
    })
  })

  it('rejects abbreviated commits and malformed build IDs', () => {
    expect(() => assertBuildIdentity({ ...identity, sourceCommit: '0123456' })).toThrow('full lowercase git SHA')
    expect(() => assertBuildIdentity({ ...identity, buildId: 'bad id' })).toThrow('buildId')
  })
})
