import { afterEach, describe, expect, it } from 'bun:test'
import { createHash } from 'node:crypto'
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  atomicSwitchReleaseLink,
  createRollbackReceipt,
  validateInstalledServerLayout,
} from './server-release-layout'

const roots: string[] = []
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })))

const sourceCommit = '0123456789abcdef0123456789abcdef01234567'
const buildId = '0.11.4+git.0123456789ab.darwin-arm64'
const executableFiles = ['bin/craft-server', 'bin/craft-cli', 'start.sh', 'vendor/bun/bun', 'resources/bin/uv']
const normalFiles = [
  'resources/pi-agent-server/index.js',
  'packages/server/src/index.ts',
  'packages/server-core/src/services/symphony-service.ts',
  'packages/symphony/src/index.ts',
  'packages/pi-agent-server/dist/index.js',
  'apps/cli/src/index.ts',
  'launchd/com.craft-agent.headless.plist.template',
]
const runtimePackages = [
  'fast-uri', '@earendil-works/pi-coding-agent', '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai', 'duck-duck-scrape', '@sinclair/typebox',
  'node-html-parser', 'pdfjs-dist', 'turndown',
]

function put(root: string, relative: string, content = relative): void {
  const path = join(root, relative)
  mkdirSync(join(path, '..'), { recursive: true })
  writeFileSync(path, content)
}

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'craft-installed-layout-'))
  roots.push(root)
  for (const file of executableFiles) {
    put(root, file, `#!/bin/sh\nexport CRAFT_RELEASE_MANIFEST="$ROOT/release-manifest.json"\n`)
    chmodSync(join(root, file), 0o755)
  }
  for (const file of normalFiles) put(root, file)
  for (const dependency of runtimePackages) put(root, `node_modules/${dependency}/package.json`, '{}')
  put(root, '.source-commit', `${sourceCommit}\n`)
  put(root, 'rollback-layout.json', JSON.stringify({
    schemaVersion: 1,
    strategy: 'atomic-symlink-rename',
    candidateDirectoryName: sourceCommit,
  }))
  put(root, 'rollback-receipt.json', JSON.stringify({
    schemaVersion: 1,
    state: 'prepared',
    candidateBuildId: buildId,
    candidateSourceCommit: sourceCommit,
  }))
  const artifactPaths = [
    '.source-commit', 'bin/craft-server', 'bin/craft-cli', 'packages/symphony/src/index.ts',
    'resources/pi-agent-server/index.js', 'rollback-layout.json',
  ]
  const artifacts = Object.fromEntries(artifactPaths.map((relative) => [
    relative,
    createHash('sha256').update(readFileSync(join(root, relative))).digest('hex'),
  ]))
  put(root, 'release-manifest.json', JSON.stringify({
    schemaVersion: 1,
    buildIdentity: {
      schemaVersion: 1,
      buildId,
      version: '0.11.4',
      sourceCommit,
      platform: 'darwin',
      arch: 'arm64',
    },
    artifacts,
  }))
  return root
}

describe('installed server release layout', () => {
  it('requires the complete server, CLI, Symphony, Pi subprocess, and runtime dependency layout', () => {
    const root = fixture()
    expect(validateInstalledServerLayout(root)).toEqual({
      buildId,
      sourceCommit,
      checkedFiles: 16,
      checkedRuntimePackages: 9,
    })

    rmSync(join(root, 'resources/pi-agent-server/index.js'))
    expect(() => validateInstalledServerLayout(root)).toThrow('resources/pi-agent-server/index.js')
  })

  it('rejects a manifest/source or critical artifact mismatch', () => {
    const root = fixture()
    writeFileSync(join(root, '.source-commit'), 'f'.repeat(40))
    expect(() => validateInstalledServerLayout(root)).toThrow('.source-commit')
  })

  it('atomically restores the previous immutable release and creates a deterministic receipt', () => {
    const root = mkdtempSync(join(tmpdir(), 'craft-rollback-layout-'))
    roots.push(root)
    const oldRelease = join(root, 'releases', 'old')
    const candidate = join(root, 'releases', sourceCommit)
    mkdirSync(oldRelease, { recursive: true })
    mkdirSync(candidate, { recursive: true })
    const current = join(root, 'current')

    atomicSwitchReleaseLink(current, oldRelease)
    atomicSwitchReleaseLink(current, candidate)
    expect(readlinkSync(current)).toBe(candidate)
    atomicSwitchReleaseLink(current, oldRelease)
    expect(readlinkSync(current)).toBe(oldRelease)

    expect(createRollbackReceipt({
      candidateBuildId: buildId,
      candidateSourceCommit: sourceCommit,
      previousRelease: oldRelease,
      restoredRelease: oldRelease,
      activatedAt: '2026-08-19T00:00:00.000Z',
      rolledBackAt: '2026-08-19T00:01:00.000Z',
    })).toEqual({
      schemaVersion: 1,
      state: 'rolled-back',
      candidateBuildId: buildId,
      candidateSourceCommit: sourceCommit,
      previousRelease: oldRelease,
      restoredRelease: oldRelease,
      activatedAt: '2026-08-19T00:00:00.000Z',
      rolledBackAt: '2026-08-19T00:01:00.000Z',
    })
  })

  it('can validate the actual candidate when CRAFT_SERVER_DIST is supplied', () => {
    if (!process.env.CRAFT_SERVER_DIST) return
    expect(validateInstalledServerLayout(process.env.CRAFT_SERVER_DIST).sourceCommit).toMatch(/^[0-9a-f]{40}$/)
  })
})
