import { createHash, randomUUID } from 'node:crypto'
import {
  existsSync,
  lstatSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs'
import { dirname, join } from 'node:path'

const FULL_SHA = /^[0-9a-f]{40}$/
const DIGEST = /^[0-9a-f]{64}$/

const REQUIRED_FILES = [
  'release-manifest.json',
  '.source-commit',
  'rollback-layout.json',
  'rollback-receipt.json',
  'bin/craft-server',
  'bin/craft-cli',
  'start.sh',
  'vendor/bun/bun',
  'resources/bin/uv',
  'resources/pi-agent-server/index.js',
  'packages/server/src/index.ts',
  'packages/server-core/src/services/symphony-service.ts',
  'packages/symphony/src/index.ts',
  'packages/pi-agent-server/dist/index.js',
  'apps/cli/src/index.ts',
  'launchd/com.craft-agent.headless.plist.template',
] as const

const REQUIRED_EXECUTABLES = [
  'bin/craft-server',
  'bin/craft-cli',
  'start.sh',
  'vendor/bun/bun',
  'resources/bin/uv',
] as const

const REQUIRED_RUNTIME_PACKAGES = [
  'fast-uri',
  '@earendil-works/pi-coding-agent',
  '@earendil-works/pi-agent-core',
  '@earendil-works/pi-ai',
  'duck-duck-scrape',
  '@sinclair/typebox',
  'node-html-parser',
  'pdfjs-dist',
  'turndown',
] as const

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex')
}

function object(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${field} must be an object`)
  return value as Record<string, unknown>
}

export interface InstalledLayoutResult {
  buildId: string
  sourceCommit: string
  checkedFiles: number
  checkedRuntimePackages: number
}

export function validateInstalledServerLayout(root: string): InstalledLayoutResult {
  for (const relative of REQUIRED_FILES) {
    if (!existsSync(join(root, relative))) throw new Error(`installed release is missing ${relative}`)
  }
  for (const relative of REQUIRED_EXECUTABLES) {
    if ((lstatSync(join(root, relative)).mode & 0o111) === 0) throw new Error(`installed release file is not executable: ${relative}`)
  }
  for (const dependency of REQUIRED_RUNTIME_PACKAGES) {
    if (!existsSync(join(root, 'node_modules', dependency, 'package.json'))) {
      throw new Error(`installed release is missing runtime dependency ${dependency}`)
    }
  }

  const manifest = object(JSON.parse(readFileSync(join(root, 'release-manifest.json'), 'utf8')), 'release manifest')
  if (manifest.schemaVersion !== 1) throw new Error('release manifest schemaVersion must be 1')
  const identity = object(manifest.buildIdentity, 'release manifest buildIdentity')
  const buildId = typeof identity.buildId === 'string' ? identity.buildId : ''
  const sourceCommit = typeof identity.sourceCommit === 'string' ? identity.sourceCommit : ''
  if (!buildId) throw new Error('release manifest buildId is required')
  if (!FULL_SHA.test(sourceCommit)) throw new Error('release manifest sourceCommit must be a full SHA')
  if (readFileSync(join(root, '.source-commit'), 'utf8').trim() !== sourceCommit) {
    throw new Error('.source-commit does not match release manifest')
  }

  const artifacts = object(manifest.artifacts, 'release manifest artifacts')
  for (const [relative, value] of Object.entries(artifacts)) {
    if (typeof value !== 'string' || !DIGEST.test(value)) throw new Error(`invalid artifact digest: ${relative}`)
    const path = join(root, relative)
    if (!existsSync(path)) throw new Error(`manifest artifact is missing: ${relative}`)
    if (sha256(path) !== value) throw new Error(`manifest artifact digest mismatch: ${relative}`)
  }
  for (const critical of ['bin/craft-server', 'bin/craft-cli', 'packages/symphony/src/index.ts', 'resources/pi-agent-server/index.js']) {
    if (!(critical in artifacts)) throw new Error(`critical artifact is not in release manifest: ${critical}`)
  }

  const serverWrapper = readFileSync(join(root, 'bin/craft-server'), 'utf8')
  const cliWrapper = readFileSync(join(root, 'bin/craft-cli'), 'utf8')
  if (!serverWrapper.includes('CRAFT_RELEASE_MANIFEST')) throw new Error('server wrapper does not bind the release manifest')
  if (!cliWrapper.includes('CRAFT_RELEASE_MANIFEST')) throw new Error('CLI wrapper does not bind the release manifest')

  const rollback = object(JSON.parse(readFileSync(join(root, 'rollback-layout.json'), 'utf8')), 'rollback layout')
  if (rollback.schemaVersion !== 1 || rollback.strategy !== 'atomic-symlink-rename') {
    throw new Error('rollback layout strategy is invalid')
  }
  if (rollback.candidateDirectoryName !== sourceCommit) throw new Error('rollback candidate directory is not the source commit')
  const receipt = object(JSON.parse(readFileSync(join(root, 'rollback-receipt.json'), 'utf8')), 'rollback receipt')
  if (receipt.state !== 'prepared' || receipt.candidateBuildId !== buildId || receipt.candidateSourceCommit !== sourceCommit) {
    throw new Error('prepared rollback receipt does not match the candidate identity')
  }

  return {
    buildId,
    sourceCommit,
    checkedFiles: REQUIRED_FILES.length,
    checkedRuntimePackages: REQUIRED_RUNTIME_PACKAGES.length,
  }
}

/** Atomically replace a current symlink without touching the target releases. */
export function atomicSwitchReleaseLink(currentLink: string, targetRelease: string): void {
  const temporary = join(dirname(currentLink), `.current-${randomUUID()}`)
  try {
    symlinkSync(targetRelease, temporary)
    renameSync(temporary, currentLink)
  } finally {
    rmSync(temporary, { force: true })
  }
}

export interface RollbackReceipt {
  schemaVersion: 1
  state: 'rolled-back'
  candidateBuildId: string
  candidateSourceCommit: string
  previousRelease: string
  restoredRelease: string
  activatedAt: string
  rolledBackAt: string
}

export function createRollbackReceipt(input: Omit<RollbackReceipt, 'schemaVersion' | 'state'>): RollbackReceipt {
  if (!FULL_SHA.test(input.candidateSourceCommit)) throw new Error('rollback receipt requires a full candidate source SHA')
  if (!input.candidateBuildId || !input.previousRelease || !input.restoredRelease) {
    throw new Error('rollback receipt requires immutable candidate and release paths')
  }
  return { schemaVersion: 1, state: 'rolled-back', ...input }
}
