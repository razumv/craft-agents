import type { Session, SessionPageResult } from '../../shared/types'

export interface SessionHydrationMetrics {
  phaseDurationsMs: {
    initialList: number
    backgroundEnumeration: number
    total: number
  }
  rpcCounts: {
    sessionPages: number
    permissionState: 0
    messageHistory: 0
  }
  transferredBytes: number
  summaries: {
    initial: number
    final: number
  }
  restarts: number
}

export interface BoundedSessionHydrationOptions {
  /** performance.now() captured when the authenticated WebSocket handshake completed. */
  connectedAt?: number
  requestedSessionId?: string
  getPage: (request: { cursor?: string; limit?: number; requestedSessionId?: string }) => Promise<SessionPageResult>
  onInitial: (sessions: Session[]) => void
  onProgress: (sessions: Session[]) => void
  onComplete: (sessions: Session[], metrics: SessionHydrationMetrics) => void
  onRetryablePartial: (reason: Extract<SessionPageResult, { state: 'retryable-partial' }>['reason']) => void
  maxRestarts?: number
}

function responseBytes(result: SessionPageResult): number {
  return result.metrics.responseBytes ?? new TextEncoder().encode(JSON.stringify(result)).byteLength
}

/**
 * Hydrates an interactive first page, then reconciles an exact stable-cursor
 * workspace projection in the background. A changed/malformed cursor never
 * applies destructive membership changes: it is explicit, retryable partial
 * state and enumeration restarts from a fresh authoritative snapshot.
 */
export async function hydrateBoundedSessions(options: BoundedSessionHydrationOptions): Promise<SessionHydrationMetrics> {
  const startedAt = options.connectedAt ?? performance.now()
  const maxRestarts = options.maxRestarts ?? 3
  let rpcCount = 0
  let bytes = 0
  let restarts = 0
  let initialCount = 0
  let initialFinishedAt = startedAt
  let firstPage = true

  const getPage = async (request: { cursor?: string; limit?: number; requestedSessionId?: string }): Promise<SessionPageResult> => {
    try {
      return await options.getPage(request)
    } catch {
      // Preserve the already rendered summaries. An interrupted response is not
      // authoritative for membership and is retried from a fresh cursor.
      return {
        state: 'retryable-partial',
        reason: 'interrupted-page',
        sessions: [],
        total: 0,
        metrics: { serverDurationMs: 0, responseBytes: 0 },
      }
    }
  }

  while (true) {
    let result = await getPage({
      limit: 100,
      requestedSessionId: options.requestedSessionId,
    })
    rpcCount += 1
    bytes += responseBytes(result)

    if (result.state === 'retryable-partial') {
      options.onRetryablePartial(result.reason)
      if (restarts >= maxRestarts) throw new Error(`Session enumeration remained partial: ${result.reason}`)
      restarts += 1
      continue
    }

    const snapshot = new Map<string, Session>()
    for (const session of result.sessions) snapshot.set(session.id, session)

    if (firstPage) {
      firstPage = false
      initialCount = result.sessions.length
      initialFinishedAt = performance.now()
      options.onInitial(result.sessions)
    } else {
      // Keep the already interactive shell non-destructive while a restarted
      // snapshot catches up; exact membership is committed only at completion.
      options.onProgress(result.sessions)
    }

    let restartReason: Extract<SessionPageResult, { state: 'retryable-partial' }>['reason'] | null = null
    while (result.state === 'partial' && result.cursor) {
      result = await getPage({ cursor: result.cursor, limit: 100 })
      rpcCount += 1
      bytes += responseBytes(result)

      if (result.state === 'retryable-partial') {
        restartReason = result.reason
        options.onRetryablePartial(result.reason)
        break
      }

      for (const session of result.sessions) snapshot.set(session.id, session)
      options.onProgress(result.sessions)
    }

    if (restartReason) {
      if (restarts >= maxRestarts) throw new Error(`Session enumeration remained partial: ${restartReason}`)
      restarts += 1
      continue
    }

    const completeSessions = Array.from(snapshot.values())
      .sort((a, b) => (b.lastMessageAt || 0) - (a.lastMessageAt || 0))
    const finishedAt = performance.now()
    const metrics: SessionHydrationMetrics = {
      phaseDurationsMs: {
        initialList: initialFinishedAt - startedAt,
        backgroundEnumeration: finishedAt - initialFinishedAt,
        total: finishedAt - startedAt,
      },
      rpcCounts: {
        sessionPages: rpcCount,
        permissionState: 0,
        messageHistory: 0,
      },
      transferredBytes: bytes,
      summaries: {
        initial: initialCount,
        final: completeSessions.length,
      },
      restarts,
    }
    options.onComplete(completeSessions, metrics)
    return metrics
  }
}
