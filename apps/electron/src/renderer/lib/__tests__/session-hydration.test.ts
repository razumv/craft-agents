import { describe, expect, test } from 'bun:test'
import type { Session, SessionPageResult } from '../../../shared/types'
import { hydrateBoundedSessions } from '../session-hydration'

function session(index: number): Session {
  return {
    id: `session-${index}`,
    workspaceId: 'workspace-1',
    workspaceName: 'Workspace',
    lastMessageAt: 1_000 - index,
    messages: [],
    isProcessing: index === 150,
    permissionMode: 'ask',
    permissionModeVersion: index + 1,
  }
}

function page(
  state: 'partial' | 'complete',
  sessions: Session[],
  cursor?: string,
): SessionPageResult {
  return {
    state,
    sessions,
    total: 200,
    snapshotVersion: cursor?.startsWith('b') ? 'snapshot-b' : 'snapshot-a',
    cursor,
    metrics: { serverDurationMs: 1, responseBytes: JSON.stringify(sessions).length },
  }
}

describe('bounded PWA session hydration', () => {
  test('renders the first page before exact background convergence and fetches no histories or permission states', async () => {
    const all = Array.from({ length: 200 }, (_, index) => session(index))
    const responses: SessionPageResult[] = [
      page('partial', [...all.slice(0, 100), all[150]!], 'a-100'),
      page('complete', all.slice(100)),
    ]
    const lifecycle: string[] = []

    const metrics = await hydrateBoundedSessions({
      requestedSessionId: all[150]!.id,
      getPage: async () => {
        lifecycle.push('rpc')
        return responses.shift()!
      },
      onInitial: initial => {
        lifecycle.push('interactive')
        expect(initial).toHaveLength(101)
        expect(initial.some(item => item.id === all[150]!.id)).toBe(true)
      },
      onProgress: () => lifecycle.push('progress'),
      onComplete: complete => {
        lifecycle.push('complete')
        expect(new Set(complete.map(item => item.id)).size).toBe(200)
        expect(complete.every(item => item.messages.length === 0)).toBe(true)
      },
      onRetryablePartial: () => lifecycle.push('retryable-partial'),
    })

    expect(lifecycle.indexOf('interactive')).toBeLessThan(lifecycle.indexOf('complete'))
    expect(metrics.rpcCounts).toEqual({ sessionPages: 2, permissionState: 0, messageHistory: 0 })
    expect(metrics.summaries).toEqual({ initial: 101, final: 200 })
    expect(metrics.transferredBytes).toBeGreaterThan(0)
  })

  test('retains explicit partial state and restarts after a concurrent snapshot change', async () => {
    const original = Array.from({ length: 200 }, (_, index) => session(index))
    const updated = original.map((item, index) => index === 125 ? { ...item, name: 'concurrent update' } : item)
    const responses: SessionPageResult[] = [
      page('partial', original.slice(0, 100), 'a-100'),
      {
        state: 'retryable-partial',
        reason: 'stale-cursor',
        sessions: [],
        total: 200,
        metrics: { serverDurationMs: 1, responseBytes: 80 },
      },
      page('partial', updated.slice(0, 100), 'b-100'),
      page('complete', updated.slice(100)),
    ]
    const partialReasons: string[] = []
    let final: Session[] = []

    const metrics = await hydrateBoundedSessions({
      getPage: async () => responses.shift()!,
      onInitial: () => {},
      onProgress: () => {},
      onComplete: sessions => { final = sessions },
      onRetryablePartial: reason => partialReasons.push(reason),
    })

    expect(partialReasons).toEqual(['stale-cursor'])
    expect(final).toEqual(updated)
    expect(metrics.restarts).toBe(1)
    expect(metrics.rpcCounts.sessionPages).toBe(4)
    expect(metrics.rpcCounts.permissionState).toBe(0)
    expect(metrics.rpcCounts.messageHistory).toBe(0)
  })

  test('turns a transport interruption into retryable partial state and resumes from a fresh cursor', async () => {
    const all = Array.from({ length: 200 }, (_, index) => session(index))
    let call = 0
    const reasons: string[] = []
    let final: Session[] = []

    const metrics = await hydrateBoundedSessions({
      getPage: async () => {
        call += 1
        if (call === 1) return page('partial', all.slice(0, 100), 'a-100')
        if (call === 2) throw new Error('socket interrupted')
        if (call === 3) return page('partial', all.slice(0, 100), 'b-100')
        return page('complete', all.slice(100))
      },
      onInitial: () => {},
      onProgress: () => {},
      onComplete: sessions => { final = sessions },
      onRetryablePartial: reason => reasons.push(reason),
    })

    expect(reasons).toEqual(['interrupted-page'])
    expect(final).toEqual(all)
    expect(metrics.restarts).toBe(1)
  })

  test('fails closed after bounded repeated interrupted pages', async () => {
    let initialCount = 0
    let partialCount = 0

    await expect(hydrateBoundedSessions({
      maxRestarts: 1,
      getPage: async () => ({
        state: 'retryable-partial',
        reason: 'malformed-cursor',
        sessions: [],
        total: 200,
        metrics: { serverDurationMs: 1 },
      }),
      onInitial: () => { initialCount += 1 },
      onProgress: () => {},
      onComplete: () => {},
      onRetryablePartial: () => { partialCount += 1 },
    })).rejects.toThrow('Session enumeration remained partial')

    expect(initialCount).toBe(0)
    expect(partialCount).toBe(2)
  })
})
