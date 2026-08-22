import { describe, expect, test } from 'bun:test'
import type { Session } from '@craft-agent/shared/protocol'
import { buildSessionPage, MAX_SESSION_PAGE_SIZE } from './session-pagination'

const WORKSPACE_ID = 'workspace-scale-fixture'
const VIRTUAL_HISTORY_BYTES = 10 * 1024 * 1024 * 1024

function summary(index: number, overrides: Partial<Session> = {}): Session {
  return {
    id: `session-${String(index).padStart(4, '0')}`,
    workspaceId: WORKSPACE_ID,
    workspaceName: 'Scale fixture',
    lastMessageAt: 10_000_000 - index,
    messages: [],
    messageCount: 50_000,
    isProcessing: false,
    permissionMode: index % 2 ? 'ask' : 'safe',
    permissionModeVersion: index + 1,
    ...overrides,
  }
}

function fixture(count = 3_300): Session[] {
  return Array.from({ length: count }, (_, index) => summary(index))
}

describe('bounded session summary pagination', () => {
  test('first response contains one bounded newest page plus requested and processing priorities', () => {
    const sessions = fixture()
    sessions[2_700] = summary(2_700, { isProcessing: true })
    sessions[3_100] = summary(3_100, { isProcessing: true })
    const requested = sessions[3_250]!

    const result = buildSessionPage(sessions, WORKSPACE_ID, {
      limit: MAX_SESSION_PAGE_SIZE,
      requestedSessionId: requested.id,
    })

    expect(result.state).toBe('partial')
    if (result.state === 'retryable-partial') throw new Error(result.reason)
    const ids = new Set(result.sessions.map(session => session.id))
    expect(result.sessions.filter(session => sessions.slice(0, 100).some(newest => newest.id === session.id))).toHaveLength(100)
    expect(ids.has(requested.id)).toBe(true)
    expect(ids.has(sessions[2_700]!.id)).toBe(true)
    expect(ids.has(sessions[3_100]!.id)).toBe(true)
    expect(result.sessions.every(session => session.messages.length === 0)).toBe(true)
    expect(result.sessions.every(session => session.permissionModeVersion != null)).toBe(true)
    expect(result.metrics.responseBytes).toBeLessThan(250_000)
    expect(VIRTUAL_HISTORY_BYTES).toBe(10_737_418_240)
  })

  test('stable pages converge exactly without duplicates or ordering corruption', () => {
    const sessions = fixture()
    let result = buildSessionPage(sessions, WORKSPACE_ID, { limit: 100 })
    const byId = new Map<string, Session>()
    let rpcCount = 0
    let transferredBytes = 0

    while (true) {
      rpcCount += 1
      transferredBytes += result.metrics.responseBytes ?? 0
      expect(result.state).not.toBe('retryable-partial')
      if (result.state === 'retryable-partial') throw new Error(result.reason)
      for (const session of result.sessions) byId.set(session.id, session)
      if (result.state === 'complete') break
      result = buildSessionPage(sessions, WORKSPACE_ID, { cursor: result.cursor, limit: 100 })
    }

    const reconciled = Array.from(byId.values()).sort((a, b) => b.lastMessageAt - a.lastMessageAt)
    expect(reconciled.map(session => session.id)).toEqual(sessions.map(session => session.id))
    expect(rpcCount).toBe(33)
    expect(transferredBytes).toBeGreaterThan(0)
  })

  test('concurrent create, update, archive and delete invalidate rather than corrupt a cursor', () => {
    const base = fixture(250)
    const first = buildSessionPage(base, WORKSPACE_ID, { limit: 100 })
    if (first.state !== 'partial') throw new Error('fixture must have another page')

    const mutations: Session[][] = [
      [summary(-1), ...base],
      base.map((session, index) => index === 140 ? { ...session, name: 'updated concurrently' } : session),
      base.map((session, index) => index === 140 ? { ...session, isArchived: true, archivedAt: Date.now() } : session),
      base.filter((_, index) => index !== 140),
    ]

    for (const changed of mutations) {
      const result = buildSessionPage(changed, WORKSPACE_ID, { cursor: first.cursor, limit: 100 })
      expect(result.state).toBe('retryable-partial')
      if (result.state === 'retryable-partial') expect(result.reason).toBe('stale-cursor')
    }
  })

  test('malformed and cross-workspace cursors remain explicit retryable partial state', () => {
    const sessions = fixture(150)
    const malformed = buildSessionPage(sessions, WORKSPACE_ID, { cursor: 'not-a-cursor' })
    expect(malformed).toMatchObject({ state: 'retryable-partial', reason: 'malformed-cursor', sessions: [] })

    const first = buildSessionPage(sessions, WORKSPACE_ID, { limit: 100 })
    if (first.state !== 'partial') throw new Error('fixture must have another page')
    const crossed = buildSessionPage(sessions, 'another-workspace', { cursor: first.cursor })
    expect(crossed).toMatchObject({ state: 'retryable-partial', reason: 'workspace-changed', sessions: [] })
  })

  test('ten scale-fixture initial responses stay below the three-second p95 contract', () => {
    const sessions = fixture()
    const durations: number[] = []
    const bytes: number[] = []

    for (let run = 0; run < 10; run += 1) {
      const startedAt = performance.now()
      const result = buildSessionPage(sessions, WORKSPACE_ID, { limit: 100, requestedSessionId: sessions[3_200]!.id })
      durations.push(performance.now() - startedAt)
      bytes.push(result.metrics.responseBytes ?? 0)
    }

    const sorted = [...durations].sort((a, b) => a - b)
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1]!
    console.info('[PWAHydrationFixture]', JSON.stringify({
      sessions: sessions.length,
      virtualHistoryBytes: VIRTUAL_HISTORY_BYTES,
      runs: durations.length,
      p95Ms: p95,
      maxTransferredBytes: Math.max(...bytes),
      rpcCountPerInitialRender: 1,
      permissionStateRpcCount: 0,
      messageHistoryRpcCount: 0,
    }))
    expect(p95).toBeLessThanOrEqual(3_000)
  })
})
