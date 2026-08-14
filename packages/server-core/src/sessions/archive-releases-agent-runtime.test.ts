import { describe, expect, it } from 'bun:test'
import { SessionManager } from './SessionManager.ts'

// Archiving a session used to leave its agent runtime alive forever.
//
//   archiveSession() flipped isArchived, persisted and emitted an event — and
//   that was all. The agent subprocess, pool server, MCP connections and config
//   watchers stayed resident for the lifetime of the server process (~30 MB
//   each). Nothing could reclaim them later either: those processes carry no
//   session identity (identical argv, no session files open, all parented by
//   the server), so an external cleaner can only group them by cwd and must
//   refuse any group a live session shares — which is the normal case when a
//   coordinator and its finished workers share a repository root. A fleet that
//   archives sessions all day accumulated ~100 idle harnesses / 2.6 GB.
//
// archiveSession now releases the runtime through the existing
// disposeManagedAgentRuntime() helper while keeping the ManagedSession in the
// map, so unarchive and read paths still work and the next turn lazily rebuilds
// the runtime via getOrCreateAgent().

function managedStub(overrides: Record<string, unknown> = {}) {
  return {
    id: 's-1',
    isArchived: false,
    isProcessing: false,
    agent: { dispose() {}, forceAbort() {} },
    workspace: { id: 'ws-1' },
    ...overrides,
  }
}

function managerWithStubs(managed: Record<string, unknown>) {
  const sm = new SessionManager()
  const calls: string[] = []
  ;(sm as unknown as { sessions: Map<string, unknown> }).sessions.set(String(managed.id), managed)
  ;(sm as unknown as { persistSession: unknown }).persistSession = () => calls.push('persist')
  ;(sm as unknown as { flushSession: unknown }).flushSession = async () => calls.push('flush')
  ;(sm as unknown as { sendEvent: unknown }).sendEvent = () => calls.push('event')
  ;(sm as unknown as { emitUnreadSummaryChanged: unknown }).emitUnreadSummaryChanged = () => {}
  ;(sm as unknown as { disposeManagedAgentRuntime: unknown }).disposeManagedAgentRuntime =
    async (_m: unknown, reason: string) => calls.push(`dispose:${reason}`)
  return { sm, calls }
}

describe('archiveSession releases the agent runtime', () => {
  it('disposes the runtime after the archive is persisted and announced', async () => {
    const managed = managedStub()
    const { sm, calls } = managerWithStubs(managed)

    await sm.archiveSession('s-1')

    expect(managed.isArchived).toBe(true)
    expect(calls).toEqual(['persist', 'flush', 'event', 'dispose:session archived'])
  })

  it('keeps the managed session so unarchive still works', async () => {
    const managed = managedStub()
    const { sm } = managerWithStubs(managed)

    await sm.archiveSession('s-1')

    const sessions = (sm as unknown as { sessions: Map<string, unknown> }).sessions
    expect(sessions.get('s-1')).toBe(managed)
  })

  it('stops a turn in flight before tearing the runtime down', async () => {
    let aborted = false
    const managed = managedStub({
      isProcessing: true,
      agent: { dispose() {}, forceAbort() { aborted = true } },
    })
    const { sm, calls } = managerWithStubs(managed)

    await sm.archiveSession('s-1')

    expect(aborted).toBe(true)
    expect(calls.at(-1)).toBe('dispose:session archived')
  })

  it('is a no-op for an unknown session', async () => {
    const { sm, calls } = managerWithStubs(managedStub())

    await sm.archiveSession('ghost')

    expect(calls).toEqual([])
  })
})
