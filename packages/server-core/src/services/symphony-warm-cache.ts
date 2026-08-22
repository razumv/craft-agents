import { randomUUID } from 'node:crypto'
import { chmod, mkdir, open, readFile, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import type { WarmRestartPayload } from '@craft-agent/symphony'

export const SYMPHONY_WARM_CACHE_SCHEMA = 'craft-agent/symphony-warm-cache@1' as const

export interface SymphonyWarmCache {
  schema: typeof SYMPHONY_WARM_CACHE_SCHEMA
  laneId: string
  savedAt: number
  runner: WarmRestartPayload
  /** Cache-safe LiveRunnerStatus projection used only by read surfaces. */
  board: unknown
}

export type WarmCacheReadResult =
  | { cache: SymphonyWarmCache; reason: null }
  | { cache: null; reason: string }

export function symphonyWarmCachePath(configPath: string): string {
  return `${configPath}.warm-cache.json`
}

export async function readSymphonyWarmCache(path: string, laneId: string): Promise<WarmCacheReadResult> {
  let content: string
  try {
    content = await readFile(path, 'utf8')
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
    return { cache: null, reason: code === 'ENOENT' ? 'warm cache missing' : `warm cache unreadable: ${message(error)}` }
  }
  try {
    const raw = JSON.parse(content) as Record<string, unknown>
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('root is not an object')
    if (raw.schema !== SYMPHONY_WARM_CACHE_SCHEMA) throw new Error('schema mismatch')
    if (raw.laneId !== laneId) throw new Error('lane id mismatch')
    if (!Number.isFinite(raw.savedAt) || (raw.savedAt as number) < 0) throw new Error('savedAt is invalid')
    if (!raw.runner || typeof raw.runner !== 'object' || Array.isArray(raw.runner)) throw new Error('runner checkpoint is invalid')
    if (!Object.hasOwn(raw, 'board')) throw new Error('board snapshot is missing')
    return { cache: structuredClone(raw) as unknown as SymphonyWarmCache, reason: null }
  } catch (error) {
    return { cache: null, reason: `warm cache corrupt or truncated: ${message(error)}` }
  }
}

/**
 * Replace through a same-directory rename. The old readable cache remains in
 * place on every failure before rename; no read/fallback path ever deletes it.
 */
export async function writeSymphonyWarmCache(path: string, cache: SymphonyWarmCache): Promise<void> {
  const parent = dirname(path)
  await mkdir(parent, { recursive: true, mode: 0o700 })
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`
  const payload = JSON.stringify(cache) + '\n'
  let handle: Awaited<ReturnType<typeof open>> | null = null
  try {
    handle = await open(temporary, 'wx', 0o600)
    await handle.writeFile(payload, 'utf8')
    await handle.sync()
    await handle.close()
    handle = null
    await rename(temporary, path)
    await chmod(path, 0o600)
    // Best-effort directory durability. Some filesystems do not permit fsync on
    // directories; the atomic rename remains the visibility boundary there.
    const directory = await open(parent, 'r').catch(() => null)
    if (directory) {
      await directory.sync().catch(() => undefined)
      await directory.close().catch(() => undefined)
    }
  } catch (error) {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
    throw error
  }
}

export function makeSymphonyWarmCache(laneId: string, runner: WarmRestartPayload, board: unknown, savedAt = Date.now()): SymphonyWarmCache {
  return {
    schema: SYMPHONY_WARM_CACHE_SCHEMA,
    laneId,
    savedAt,
    runner: structuredClone(runner),
    board: cacheSafeBoardSnapshot(board),
  }
}

/**
 * Persist only what the board renders. Raw issue descriptions, comments,
 * credentials, paths, session IDs and authoritative agent final responses are
 * excluded. The live runner snapshot replaces this projection after reconcile.
 */
export function cacheSafeBoardSnapshot(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  const status = value as Record<string, unknown>
  const primary = status.snapshot && typeof status.snapshot === 'object' && !Array.isArray(status.snapshot)
    ? status.snapshot as Record<string, unknown>
    : null
  const issue = primary?.issue && typeof primary.issue === 'object' && !Array.isArray(primary.issue)
    ? primary.issue as Record<string, unknown>
    : null
  const execution = status.execution && typeof status.execution === 'object' && !Array.isArray(status.execution)
    ? status.execution as Record<string, unknown>
    : null
  const backlog = Array.isArray(status.backlog)
    ? status.backlog.map((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
        const item = entry as Record<string, unknown>
        return {
          id: item.id,
          identifier: item.identifier,
          number: item.number,
          title: item.title,
          url: item.url,
          labels: Array.isArray(item.labels) ? [...item.labels] : [],
          priority: item.priority ?? null,
          createdAt: item.createdAt ?? null,
          updatedAt: item.updatedAt ?? null,
        }
      }).filter(Boolean)
    : undefined
  return {
    snapshot: issue && typeof issue.id === 'string' ? { issue: { id: issue.id } } : null,
    status: status.status === undefined ? null : structuredClone(status.status),
    ...(Array.isArray(status.statuses) ? { statuses: structuredClone(status.statuses) } : {}),
    ...(backlog ? { backlog } : {}),
    ...(status.grooming !== undefined ? { grooming: structuredClone(status.grooming) } : {}),
    execution: execution ? {
      issueId: execution.issueId,
      status: execution.status,
      contextTokens: execution.contextTokens,
    } : null,
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
