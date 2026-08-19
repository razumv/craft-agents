import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.symphony.VALIDATE,
  RPC_CHANNELS.symphony.SHADOW,
  RPC_CHANNELS.symphony.PROJECT_DESK,
  RPC_CHANNELS.symphony.TICK,
  RPC_CHANNELS.symphony.STATUS,
  RPC_CHANNELS.symphony.STOP,
] as const

function projectId(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error('Symphony projectId is required')
  return value.trim()
}

export function registerSymphonyHandlers(server: RpcServer, deps: HandlerDeps): void {
  const service = deps.symphonyService
  if (!service) return

  server.handle(RPC_CHANNELS.symphony.VALIDATE, async (_ctx, id: unknown) => service.validate(projectId(id)))
  server.handle(RPC_CHANNELS.symphony.SHADOW, async (_ctx, id: unknown) => service.shadow(projectId(id)))
  server.handle(RPC_CHANNELS.symphony.PROJECT_DESK, async (_ctx, id: unknown) => service.projectDesk(projectId(id)))
  server.handle(RPC_CHANNELS.symphony.TICK, async (_ctx, id: unknown) => service.tick(projectId(id)))
  server.handle(RPC_CHANNELS.symphony.STATUS, async () => service.status())
  server.handle(RPC_CHANNELS.symphony.STOP, async (_ctx, timeoutMs?: unknown) => {
    if (timeoutMs === undefined) return service.stop()
    if (!Number.isInteger(timeoutMs) || (timeoutMs as number) < 1) {
      throw new Error('Symphony stop timeoutMs must be a positive integer')
    }
    return service.stop(timeoutMs as number)
  })
}
