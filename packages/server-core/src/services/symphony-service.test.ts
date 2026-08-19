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
