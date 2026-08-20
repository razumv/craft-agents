import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.ownerPush.PUBLIC_KEY,
  RPC_CHANNELS.ownerPush.SUBSCRIBE,
  RPC_CHANNELS.ownerPush.UNSUBSCRIBE,
  RPC_CHANNELS.ownerPush.TEST,
] as const

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} is required`)
  return value.trim()
}

export function registerOwnerPushHandlers(server: RpcServer, deps: HandlerDeps): void {
  const push = deps.ownerPush
  if (!push) return

  server.handle(RPC_CHANNELS.ownerPush.PUBLIC_KEY, async () => ({ publicKey: await push.publicKey() }))

  server.handle(RPC_CHANNELS.ownerPush.SUBSCRIBE, async (_ctx, subscription: unknown, label?: unknown) => {
    const record = subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } }
    return push.subscribe({
      endpoint: nonEmpty(record?.endpoint, 'subscription endpoint'),
      keys: {
        p256dh: nonEmpty(record?.keys?.p256dh, 'subscription p256dh key'),
        auth: nonEmpty(record?.keys?.auth, 'subscription auth key'),
      },
      ...(typeof label === 'string' && label.trim() ? { label: label.trim() } : {}),
    }, Date.now())
  })

  server.handle(RPC_CHANNELS.ownerPush.UNSUBSCRIBE, async (_ctx, endpoint: unknown) =>
    push.unsubscribe(nonEmpty(endpoint, 'subscription endpoint')))

  /**
   * Send one notification on demand. A push path that cannot be tried on
   * purpose is a push path nobody trusts: this is how the owner confirms the
   * phone actually wakes, without waiting for a real decision to arrive.
   * Debounce is bypassed here — that is the entire point of a test.
   */
  server.handle(RPC_CHANNELS.ownerPush.TEST, async () => push.notify({
    title: 'Craft Agents',
    body: 'Test notification — push and vibration are working.',
    tag: `owner-push-test-${Date.now()}`,
  }, Date.now(), 0))
}
