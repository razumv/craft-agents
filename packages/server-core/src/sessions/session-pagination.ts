import { createHash } from 'node:crypto'
import type {
  Session,
  SessionPageRequest,
  SessionPageResult,
} from '@craft-agent/shared/protocol'

export const MAX_SESSION_PAGE_SIZE = 100
const CURSOR_VERSION = 1

type CursorPayload = {
  v: typeof CURSOR_VERSION
  workspaceId: string
  fingerprint: string
  offset: number
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url')
}

function decodeCursor(cursor: string): CursorPayload | null {
  try {
    const value = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorPayload>
    if (
      value.v !== CURSOR_VERSION ||
      typeof value.workspaceId !== 'string' ||
      typeof value.fingerprint !== 'string' ||
      !Number.isSafeInteger(value.offset) ||
      (value.offset ?? -1) < 0
    ) {
      return null
    }
    return value as CursorPayload
  } catch {
    return null
  }
}

/**
 * Hash every authoritative summary field. A cursor is accepted only while this
 * exact ordered workspace projection is unchanged, so concurrent create/update/
 * archive/delete activity cannot silently skip, duplicate, or reorder entries.
 */
export function fingerprintSessionSummaries(sessions: Session[]): string {
  return createHash('sha256').update(JSON.stringify(sessions)).digest('base64url')
}

function clampLimit(limit: number | undefined): number {
  if (!Number.isFinite(limit)) return MAX_SESSION_PAGE_SIZE
  return Math.max(1, Math.min(MAX_SESSION_PAGE_SIZE, Math.floor(limit!)))
}

export function buildSessionPage(
  orderedSessions: Session[],
  workspaceId: string,
  request: SessionPageRequest = {},
): SessionPageResult {
  const startedAt = performance.now()
  const limit = clampLimit(request.limit)
  const fingerprint = fingerprintSessionSummaries(orderedSessions)
  const decoded = request.cursor ? decodeCursor(request.cursor) : null

  if (request.cursor && !decoded) {
    return {
      state: 'retryable-partial',
      reason: 'malformed-cursor',
      sessions: [],
      total: orderedSessions.length,
      metrics: { serverDurationMs: performance.now() - startedAt },
    }
  }

  if (decoded && decoded.workspaceId !== workspaceId) {
    return {
      state: 'retryable-partial',
      reason: 'workspace-changed',
      sessions: [],
      total: orderedSessions.length,
      metrics: { serverDurationMs: performance.now() - startedAt },
    }
  }

  if (decoded && decoded.fingerprint !== fingerprint) {
    return {
      state: 'retryable-partial',
      reason: 'stale-cursor',
      sessions: [],
      total: orderedSessions.length,
      metrics: { serverDurationMs: performance.now() - startedAt },
    }
  }

  const offset = decoded?.offset ?? 0
  if (offset > orderedSessions.length) {
    return {
      state: 'retryable-partial',
      reason: 'malformed-cursor',
      sessions: [],
      total: orderedSessions.length,
      metrics: { serverDurationMs: performance.now() - startedAt },
    }
  }

  const newestPage = orderedSessions.slice(offset, offset + limit)
  let sessions = newestPage

  // The first response pins the requested and every processing session in
  // addition to (never instead of) the bounded newest page. Preserve canonical
  // ordering and de-duplicate sessions already present in that page.
  if (!decoded) {
    const included = new Set(newestPage.map(session => session.id))
    for (const session of orderedSessions) {
      if (session.isProcessing || session.id === request.requestedSessionId) {
        included.add(session.id)
      }
    }
    sessions = orderedSessions.filter(session => included.has(session.id))
  }

  const nextOffset = offset + newestPage.length
  const complete = nextOffset >= orderedSessions.length
  const result: SessionPageResult = {
    state: complete ? 'complete' : 'partial',
    sessions,
    total: orderedSessions.length,
    snapshotVersion: fingerprint,
    metrics: { serverDurationMs: performance.now() - startedAt },
  }

  if (!complete) {
    result.cursor = encodeCursor({
      v: CURSOR_VERSION,
      workspaceId,
      fingerprint,
      offset: nextOffset,
    })
  }

  // Fixed point includes the responseBytes field itself, yielding the exact
  // serialized result-payload size (the transport envelope is measured separately).
  let responseBytes = 0
  do {
    result.metrics.responseBytes = responseBytes
    const measured = Buffer.byteLength(JSON.stringify(result), 'utf8')
    if (measured === responseBytes) break
    responseBytes = measured
  } while (true)
  return result
}
