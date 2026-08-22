import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  NativeSymphonyService,
  createDisabledSymphonyService,
  parseSymphonyServerConfig,
  type SymphonyRunnerLike,
} from './symphony-service'

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function runnerConfigPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'craft-symphony-service-'))
  tempDirs.push(dir)
  const path = join(dir, 'runner.json')
  await writeFile(path, JSON.stringify({
    workflowPath: '/tmp/WORKFLOW.md',
    repositoryRoot: '/tmp/repository',
    workspaceRoot: '/tmp/worktrees',
    issueId: 'ISSUE_1',
    issueNumber: 1,
    projectItemId: 'PVTI_1',
    claimFenceIssueId: 'ISSUE_FENCE',
    verificationBudget: 'focused',
  }))
  return path
}

function config(configPath: string, enabled = false) {
  return {
    version: 1 as const,
    enabled,
    stopTimeoutMs: 25,
    projects: [{ id: 'alpha', configPath }],
  }
}

describe('NativeSymphonyService', () => {
  it('is inert and disabled by default', async () => {
    const service = createDisabledSymphonyService()
    expect(await service.start()).toMatchObject({
      phase: 'disabled',
      enabled: false,
      acceptingOperations: false,
      projects: [],
    })
    await expect(service.tick('alpha')).rejects.toThrow('disabled')
    expect(await service.stop()).toMatchObject({ drained: true, phase: 'stopped' })
  })

  it('requires explicit, absolute, unique project configuration', () => {
    expect(() => parseSymphonyServerConfig({ version: 1, projects: [] })).toThrow('enabled')
    expect(() => parseSymphonyServerConfig({
      version: 1,
      enabled: false,
      stopTimeoutMs: 100,
      projects: [{ id: 'alpha', configPath: 'relative.json' }],
    })).toThrow('absolute')
    expect(() => parseSymphonyServerConfig({
      version: 1,
      enabled: false,
      stopTimeoutMs: 100,
      projects: [
        { id: 'alpha', configPath: '/tmp/one.json' },
        { id: 'alpha', configPath: '/tmp/two.json' },
      ],
    })).toThrow('duplicate')
  })

  it('reconstructs read-only and keeps live tick gated off', async () => {
    const path = await runnerConfigPath()
    const calls: string[] = []
    const runner: SymphonyRunnerLike = {
      async preflight() { calls.push('preflight'); return { valid: true } },
      async readStatus() { calls.push('status'); return { durable: 'same' } },
      async projectDesk() { calls.push('desk'); return { compact: 'Project Desk' } },
      async shadow() {
        calls.push('shadow')
        return {
          projectDesk: { compact: 'Project Desk' },
          proposal: { action: 'claim' },
          receiptHash: 'a'.repeat(64),
          writes: 0,
        }
      },
      async tick() { calls.push('tick'); return { mutated: true } },
    }
    const service = new NativeSymphonyService(config(path), path, async () => runner)

    const started = await service.start()
    expect(started).toMatchObject({ phase: 'ready', enabled: false, acceptingOperations: true })
    expect(started.projects[0]).toMatchObject({
      phase: 'ready',
      lastOperation: 'reconstruct',
      snapshot: { durable: 'same' },
    })
    expect(calls).toEqual(['status'])

    expect(await service.validate('alpha')).toMatchObject({ operation: 'validate', result: { valid: true } })
    const shadow = await service.shadow('alpha')
    expect(shadow).toMatchObject({ operation: 'shadow' })
    expect(shadow.result).toEqual({
      projectDesk: { compact: 'Project Desk' },
      proposal: { action: 'claim' },
      receiptHash: 'a'.repeat(64),
      writes: 0,
    })
    expect(JSON.stringify(shadow.result)).not.toContain('durable')
    expect(JSON.stringify(shadow.result)).not.toContain('preflight')
    expect(await service.projectDesk('alpha')).toMatchObject({
      operation: 'desk',
      result: { compact: 'Project Desk' },
    })
    await expect(service.tick('alpha')).rejects.toThrow('enabled=true')
    expect(calls).toEqual(['status', 'preflight', 'preflight', 'shadow', 'desk'])
  })

  it('derives each repository lane fence registry without changing runner JSON', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'craft-symphony-lanes-'))
    tempDirs.push(dir)
    const make = async (name: string, repository: string, fence: string) => {
      const path = join(dir, `${name}.json`)
      await writeFile(path, JSON.stringify({
        workflowPath: '/tmp/WORKFLOW.md', repositoryRoot: '/tmp/repository', workspaceRoot: '/tmp/worktrees',
        issueId: `ISSUE_${name}`, claimFenceIssueId: fence, verificationBudget: 'focused',
        github: { repository },
      }))
      return path
    }
    const paths = {
      alpha: await make('alpha', 'acme/shared', 'FENCE_A'),
      beta: await make('beta', 'acme/shared', 'FENCE_B'),
      gamma: await make('gamma', 'acme/other', 'FENCE_C'),
    }
    const received = new Map<string, string[] | undefined>()
    const runner: SymphonyRunnerLike = {
      async preflight() { return {} }, async readStatus() { return {} }, async projectDesk() { return {} },
      async shadow() { return {} }, async tick() { return {} },
    }
    const service = new NativeSymphonyService({
      version: 1, enabled: false, stopTimeoutMs: 25,
      projects: Object.entries(paths).map(([id, configPath]) => ({ id, configPath })),
    }, null, async (runnerConfig) => {
      received.set(runnerConfig.claimFenceIssueId, runnerConfig.configuredClaimFenceIssueIds)
      return runner
    })

    await service.start()

    expect(received.get('FENCE_A')).toEqual(['FENCE_A', 'FENCE_B'])
    expect(received.get('FENCE_B')).toEqual(['FENCE_A', 'FENCE_B'])
    expect(received.get('FENCE_C')).toEqual(['FENCE_C'])
    expect(JSON.parse(await Bun.file(paths.alpha).text()).configuredClaimFenceIssueIds).toBeUndefined()
  })

  it('reconstructs identical durable status after a server restart without ticking', async () => {
    const path = await runnerConfigPath()
    let ticks = 0
    const factory = async (): Promise<SymphonyRunnerLike> => ({
      async preflight() { return { valid: true } },
      async readStatus() { return { claim: 'claim-immutable', sessionId: 'session-existing' } },
      async projectDesk() { return { compact: 'same' } },
      async shadow() { return { proposal: { action: 'resume' }, receiptHash: 'same', writes: 0 } },
      async tick() { ticks++; return {} },
    })

    const first = new NativeSymphonyService(config(path), path, factory)
    const second = new NativeSymphonyService(config(path), path, factory)
    const firstStatus = await first.start()
    const secondStatus = await second.start()

    expect(firstStatus.projects[0]?.snapshot).toEqual(secondStatus.projects[0]?.snapshot)
    const firstShadow = await first.shadow('alpha')
    const secondShadow = await second.shadow('alpha')
    expect(firstShadow.result).toEqual(secondShadow.result)
    expect(firstShadow.result).toMatchObject({
      proposal: { action: 'resume' },
      receiptHash: 'same',
      writes: 0,
    })
    expect(ticks).toBe(0)
  })

  it('a project that fails to reconstruct is refused without failing the service', async () => {
    const path = await runnerConfigPath()
    const other = await runnerConfigPath()
    let readStatusCalls = 0
    const runner: SymphonyRunnerLike = {
      async preflight() { return {} },
      async readStatus() {
        readStatusCalls += 1
        // Only the second project can be read; the first is unreachable, the
        // way a rate-limited or unreachable repository behaves.
        if (readStatusCalls === 1) throw new Error('gh: API rate limit already exceeded')
        return { state: 'ready' }
      },
      async projectDesk() { return {} },
      async shadow() { return { writes: 0 } },
      async tick() { return { state: 'ticked' } },
    }
    const service = new NativeSymphonyService({
      version: 1 as const,
      enabled: true,
      stopTimeoutMs: 25,
      projects: [{ id: 'alpha', configPath: path }, { id: 'beta', configPath: other }],
    }, path, async () => runner)

    // Enabled service, failing project: this must resolve rather than throw.
    // The throw used to reach a process.exit(1) in the server entry point.
    const status = await service.start()

    expect(status.phase).toBe('ready')
    expect(status.acceptingOperations).toBeTrue()
    expect(status.projects.find((project) => project.projectId === 'alpha')).toMatchObject({
      phase: 'error',
      lastError: 'gh: API rate limit already exceeded',
    })
    // The healthy project is untouched by its neighbour's failure.
    expect(status.projects.find((project) => project.projectId === 'beta')).toMatchObject({ phase: 'ready' })
    await expect(service.tick('beta')).resolves.toMatchObject({ operation: 'tick' })
    await service.stop()
  })

  it('reports error phase when nothing reconstructs, and still does not throw', async () => {
    const path = await runnerConfigPath()
    const runner: SymphonyRunnerLike = {
      async preflight() { return {} },
      async readStatus() { throw new Error('gh: API rate limit already exceeded') },
      async projectDesk() { return {} },
      async shadow() { return { writes: 0 } },
      async tick() { return { state: 'ticked' } },
    }
    const service = new NativeSymphonyService(config(path, true), path, async () => runner)

    const status = await service.start()

    expect(status.phase).toBe('error')
    expect(status.acceptingOperations).toBeFalse()
    expect(status.projects[0]).toMatchObject({ phase: 'error' })
    await service.stop()
  })

  it('allows one explicitly enabled tick and stops within a bounded deadline', async () => {
    const path = await runnerConfigPath()
    let release!: () => void
    const blocked = new Promise<void>((resolve) => { release = resolve })
    const runner: SymphonyRunnerLike = {
      async preflight() { return {} },
      async readStatus() { return { state: 'ready' } },
      async projectDesk() { return {} },
      async shadow() { return { writes: 0 } },
      async tick() { await blocked; return { state: 'ticked' } },
    }
    const service = new NativeSymphonyService(config(path, true), path, async () => runner)
    await service.start()

    const tick = service.tick('alpha')
    await Bun.sleep(1)
    await expect(service.tick('alpha')).rejects.toThrow('active operation')
    const stopped = await service.stop(5)
    expect(stopped).toMatchObject({ drained: false, phase: 'stopping', activeOperations: 1 })
    await expect(service.validate('alpha')).rejects.toThrow('not accepting')

    release()
    await expect(tick).resolves.toMatchObject({ operation: 'tick', result: { state: 'ticked' } })
    await Bun.sleep(1)
    expect(service.status().phase).toBe('stopped')
  })
})

describe('NativeSymphonyService autonomous loop', () => {
  const loopConfig = (configPath: string, overrides: Partial<import('./symphony-service').SymphonyLoopConfig> = {}, enabled = false) => ({
    version: 1 as const,
    enabled,
    stopTimeoutMs: 25,
    projects: [{ id: 'alpha', configPath }],
    loop: { enabled: true, mode: 'shadow' as const, intervalMs: 5, maxConsecutiveErrors: 3, ...overrides },
  })

  const shadowReceipt = {
    projectDesk: { compact: 'Project Desk' },
    proposal: { action: 'hold' },
    receiptHash: 'b'.repeat(64),
    writes: 0,
  }

  it('rejects a tick loop unless the service itself is enabled', () => {
    expect(() => parseSymphonyServerConfig({
      version: 1,
      enabled: false,
      stopTimeoutMs: 100,
      projects: [],
      loop: { enabled: true, mode: 'tick', intervalMs: 1000, maxConsecutiveErrors: 3 },
    })).toThrow('enabled=true')
    expect(parseSymphonyServerConfig({
      version: 1,
      enabled: false,
      stopTimeoutMs: 100,
      projects: [],
      loop: { enabled: true, mode: 'shadow', intervalMs: 1000, maxConsecutiveErrors: 3 },
    }).loop).toMatchObject({ mode: 'shadow' })
  })

  it('a shadow cycle validates and reports from one observation', async () => {
    const path = await runnerConfigPath()
    const calls: string[] = []
    const runner: SymphonyRunnerLike = {
      async preflight() { calls.push('preflight'); return { valid: true } },
      async readStatus() { calls.push('status'); return { durable: 'same' } },
      async projectDesk() { calls.push('desk'); return { compact: 'Project Desk' } },
      async shadow() { calls.push('shadow'); return shadowReceipt },
      // The combined path exists: the service must prefer it over calling
      // preflight and shadow separately, which read the repository twice.
      async shadowWithPreflight() { calls.push('shadow+preflight'); return shadowReceipt },
      async tick() { calls.push('tick'); return { mutated: true } },
    }
    const service = new NativeSymphonyService(loopConfig(path), path, async () => runner)
    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 60))

    expect(calls.filter((c) => c === 'shadow+preflight').length).toBeGreaterThan(0)
    expect(calls).not.toContain('preflight')
    expect(calls).not.toContain('shadow')
    await service.stop()
  })

  it('runs read-only shadow cycles, reports them, and never ticks', async () => {
    const path = await runnerConfigPath()
    const calls: string[] = []
    const runner: SymphonyRunnerLike = {
      async preflight() { calls.push('preflight'); return { valid: true } },
      async readStatus() { calls.push('status'); return { durable: 'same' } },
      async projectDesk() { calls.push('desk'); return { compact: 'Project Desk' } },
      async shadow() { calls.push('shadow'); return shadowReceipt },
      async tick() { calls.push('tick'); return { mutated: true } },
    }
    const service = new NativeSymphonyService(loopConfig(path), path, async () => runner)
    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const status = service.status()
    expect(status.loop).toMatchObject({ enabled: true, mode: 'shadow', droppedProjects: [] })
    expect(status.loop!.cycles).toBeGreaterThan(0)
    expect(status.loop!.lastCycleAt).not.toBeNull()
    const shadows = calls.filter((c) => c === 'shadow').length
    expect(shadows).toBeGreaterThan(0)
    expect(calls).not.toContain('tick')
    // Every cycle ends with a read-only refresh so the board snapshot stays a
    // LiveRunnerStatus even though shadow receipts no longer touch it.
    // readStatus: 1 (reconstruct) + 1 per completed cycle.
    expect(calls.filter((c) => c === 'status').length).toBeGreaterThanOrEqual(1 + shadows)
    expect(service.status().projects[0]!.snapshot).toMatchObject({ durable: 'same' })
    await service.stop()
  })

  it('tick cycles do not pay for a second full-status read', async () => {
    const path = await runnerConfigPath()
    const calls: string[] = []
    const runner: SymphonyRunnerLike = {
      async preflight() { calls.push('preflight'); return { valid: true } },
      async readStatus() { calls.push('status'); return { durable: 'same' } },
      async projectDesk() { calls.push('desk'); return { compact: 'Project Desk' } },
      async shadow() { calls.push('shadow'); return shadowReceipt },
      async tick() { calls.push('tick'); return { durable: 'ticked' } },
    }
    const service = new NativeSymphonyService(loopConfig(path, { mode: 'tick' }, true), path, async () => runner)
    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const ticks = calls.filter((c) => c === 'tick').length
    expect(ticks).toBeGreaterThan(0)
    // A tick already stores a full status as the snapshot, so the loop must not
    // follow it with a refresh: on a large repository that is a second
    // repository-wide scan bought for nothing. Only reconstruction reads status.
    expect(calls.filter((c) => c === 'status').length).toBe(1)
    expect(service.status().projects[0]!.snapshot).toMatchObject({ durable: 'ticked' })
    await service.stop()
  })

  it("a preservation push diagnostic does not stop the next project's dispatch in the same cycle", async () => {
    const alphaPath = await runnerConfigPath()
    const betaPath = await runnerConfigPath()
    const calls: string[] = []
    let factoryIndex = 0
    const makeRunner = (project: 'alpha' | 'beta'): SymphonyRunnerLike => ({
      async preflight() { return { valid: true } },
      async readStatus() { return { durable: project } },
      async projectDesk() { return { compact: project } },
      async shadow() { return shadowReceipt },
      async tick() {
        calls.push(`dispatch:${project}`)
        if (project === 'alpha') return {
          durable: 'alpha-diagnostic',
          diagnostic: 'preservation push failed for v4-preserved/alpha-a1-1234567: remote rejected; local branch remains and the interrupted worktree was not released',
        }
        return { durable: 'beta-dispatched' }
      },
    })
    const service = new NativeSymphonyService({
      version: 1,
      enabled: true,
      stopTimeoutMs: 25,
      projects: [{ id: 'alpha', configPath: alphaPath }, { id: 'beta', configPath: betaPath }],
      loop: { enabled: true, mode: 'tick', intervalMs: 5, maxConsecutiveErrors: 3 },
    }, alphaPath, async () => makeRunner(factoryIndex++ === 0 ? 'alpha' : 'beta'))

    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 40))

    expect(calls[0]).toBe('dispatch:alpha')
    expect(calls[1]).toBe('dispatch:beta')
    expect(service.status().projects.find((project) => project.projectId === 'alpha')).toMatchObject({
      phase: 'ready', lastError: null,
      snapshot: { durable: 'alpha-diagnostic', diagnostic: expect.stringContaining('local branch remains') },
    })
    expect(service.status().projects.find((project) => project.projectId === 'beta')).toMatchObject({
      phase: 'ready', snapshot: { durable: 'beta-dispatched' },
    })
    await service.stop()
  })

  it('clears the drop as soon as one retry succeeds', async () => {
    const path = await runnerConfigPath()
    let shadows = 0
    let failing = true
    const runner: SymphonyRunnerLike = {
      async preflight() { return { valid: true } },
      async readStatus() { return { durable: 'same' } },
      async projectDesk() { return { compact: 'Project Desk' } },
      async shadow() {
        shadows += 1
        if (failing) throw new Error('provider offline')
        return { receipt: 'ok' }
      },
      async tick() { return { mutated: true } },
    }
    const service = new NativeSymphonyService(loopConfig(path, { maxConsecutiveErrors: 2 }), path, async () => runner)
    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(service.status().loop!.droppedProjects).toEqual(['alpha'])

    // The provider comes back. The project must return to the loop by itself —
    // recovering should not need a restart.
    failing = false
    await new Promise((resolve) => setTimeout(resolve, 120))
    expect(service.status().loop!.droppedProjects).toEqual([])
    expect(service.status().projects[0]).toMatchObject({ phase: 'ready', lastError: null })
    await service.stop()
  })

  it('drops a project after maxConsecutiveErrors and stop cancels the loop', async () => {
    const path = await runnerConfigPath()
    let shadows = 0
    const runner: SymphonyRunnerLike = {
      async preflight() { return { valid: true } },
      async readStatus() { return { durable: 'same' } },
      async projectDesk() { return { compact: 'Project Desk' } },
      async shadow() { shadows += 1; throw new Error('provider offline') },
      async tick() { return { mutated: true } },
    }
    const service = new NativeSymphonyService(loopConfig(path, { maxConsecutiveErrors: 2 }), path, async () => runner)
    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 60))
    const status = service.status()
    expect(status.loop!.droppedProjects).toEqual(['alpha'])
    expect(status.projects[0]).toMatchObject({ phase: 'error', lastError: 'provider offline' })
    // Dropped means paused, not banished: it keeps being retried across a
    // widening gap rather than being attempted twice and abandoned. One HTTP 499
    // from a slow repository read took a project out of the loop for a whole
    // night, and the repository was fine the entire time.
    const afterDrop = shadows
    expect(afterDrop).toBeGreaterThan(2)
    await new Promise((resolve) => setTimeout(resolve, 60))
    expect(shadows).toBeGreaterThan(afterDrop)

    await service.stop()
    const cyclesAtStop = service.status().loop!.cycles
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(service.status().loop!.cycles).toBe(cyclesAtStop)
  })
})


describe("snapshot integrity", () => {
  it("shadow/desk/validate never clobber the board snapshot; refresh/tick do", async () => {
    const path = await runnerConfigPath()
    const runner: SymphonyRunnerLike = {
      async preflight() { return { valid: true } },
      async readStatus() { return { statuses: [{ issueIdentifier: "r/x#1" }] } },
      async projectDesk() { return { compact: "desk" } },
      async shadow() { return { writes: 0, receiptHash: "c".repeat(64) } },
      async tick() { return { statuses: [{ issueIdentifier: "r/x#1" }], ticked: true } },
    }
    const service = new NativeSymphonyService(config(path), path, async () => runner)
    await service.start()
    const initial = service.status().projects[0]!.snapshot
    expect(initial).toMatchObject({ statuses: [{ issueIdentifier: "r/x#1" }] })

    await service.shadow("alpha")
    await service.projectDesk("alpha")
    await service.validate("alpha")
    expect(service.status().projects[0]!.snapshot).toEqual(initial)

    await service.refresh("alpha")
    expect(service.status().projects[0]!.snapshot).toMatchObject({ statuses: [{ issueIdentifier: "r/x#1" }] })
    await service.stop()
  })
})
