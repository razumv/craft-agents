import { describe, expect, it } from 'bun:test'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { HandlerFn, RpcServer } from '../../transport/types'
import type { SymphonyServiceControl } from '@craft-agent/core/types'
import { registerSymphonyHandlers } from './symphony'

function rpcHarness() {
  const handlers = new Map<string, HandlerFn>()
  const server: RpcServer = {
    handle(channel, handler) { handlers.set(channel, handler) },
    push() {},
    async invokeClient() {},
    hasClientCapability() { return false },
    findClientsWithCapability() { return [] },
  }
  const invoke = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel)
    if (!handler) throw new Error(`missing handler ${channel}`)
    return handler({ clientId: 'test', workspaceId: null, webContentsId: null }, ...args)
  }
  return { server, handlers, invoke }
}

describe('Symphony RPC handlers', () => {
  it('registers the typed service boundary and forwards validated arguments', async () => {
    const calls: unknown[][] = []
    const service: SymphonyServiceControl = {
      async start() { throw new Error('not used') },
      async validate(id) { calls.push(['validate', id]); return { projectId: id, operation: 'validate', completedAt: 1, result: {} } },
      async shadow(id) { calls.push(['shadow', id]); return { projectId: id, operation: 'shadow', completedAt: 2, result: {} } },
      async projectDesk(id) { calls.push(['desk', id]); return { projectId: id, operation: 'desk', completedAt: 3, result: {} } },
      async refresh(id) { calls.push(['refresh', id]); return { projectId: id, operation: 'refresh', completedAt: 5, result: {} } },
      async tick(id) { calls.push(['tick', id]); return { projectId: id, operation: 'tick', completedAt: 4, result: {} } },
      status() { calls.push(['status']); return { phase: 'ready', enabled: false, acceptingOperations: true, configPath: '/tmp/config.json', stopTimeoutMs: 100, activeOperations: 0, projects: [], loop: null } },
      async stop(timeoutMs) { calls.push(['stop', timeoutMs]); return { drained: true, timeoutMs: timeoutMs ?? 100, activeOperations: 0, phase: 'stopped' } },
    }
    const rpc = rpcHarness()
    registerSymphonyHandlers(rpc.server, { symphonyService: service } as any)

    expect([...rpc.handlers.keys()].sort()).toEqual([
      RPC_CHANNELS.symphony.SHADOW,
      RPC_CHANNELS.symphony.PROJECT_DESK,
      RPC_CHANNELS.symphony.GENERATE_CONFIG,
      RPC_CHANNELS.symphony.REFRESH,
      RPC_CHANNELS.symphony.STATUS,
      RPC_CHANNELS.symphony.STOP,
      RPC_CHANNELS.symphony.TICK,
      RPC_CHANNELS.symphony.VALIDATE,
    ].sort())
    await rpc.invoke(RPC_CHANNELS.symphony.VALIDATE, 'alpha')
    await rpc.invoke(RPC_CHANNELS.symphony.SHADOW, 'alpha')
    await rpc.invoke(RPC_CHANNELS.symphony.PROJECT_DESK, 'alpha')
    await rpc.invoke(RPC_CHANNELS.symphony.TICK, 'alpha')
    await rpc.invoke(RPC_CHANNELS.symphony.STATUS)
    await rpc.invoke(RPC_CHANNELS.symphony.STOP, 25)
    expect(calls).toEqual([
      ['validate', 'alpha'],
      ['shadow', 'alpha'],
      ['desk', 'alpha'],
      ['tick', 'alpha'],
      ['status'],
      ['stop', 25],
    ])
  })

  it('rejects missing project IDs and invalid stop deadlines', async () => {
    const service = {
      validate: async () => ({}), shadow: async () => ({}), projectDesk: async () => ({}), tick: async () => ({}),
      status: () => ({}), stop: async () => ({}), start: async () => ({}),
    }
    const rpc = rpcHarness()
    registerSymphonyHandlers(rpc.server, { symphonyService: service } as any)

    await expect(rpc.invoke(RPC_CHANNELS.symphony.VALIDATE, '')).rejects.toThrow('projectId')
    await expect(rpc.invoke(RPC_CHANNELS.symphony.PROJECT_DESK, '   ')).rejects.toThrow('projectId')
    await expect(rpc.invoke(RPC_CHANNELS.symphony.STOP, 0)).rejects.toThrow('positive integer')
  })

  it('does not advertise handlers in hosts without the service', () => {
    const rpc = rpcHarness()
    registerSymphonyHandlers(rpc.server, {} as any)
    expect(rpc.handlers.size).toBe(0)
  })
})
