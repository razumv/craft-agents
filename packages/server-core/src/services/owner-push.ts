/**
 * Web Push for the one thing worth waking a phone for: a decision only the
 * owner can take.
 *
 * Deliberately narrow. A notification per state change would train the owner to
 * swipe them away, and the states that matter are the ones where the lane has
 * stopped and cannot continue without an answer — an owner gate, or a blocked
 * run. Everything else is visible on the board when they choose to look.
 *
 * Keys and subscriptions live under the Craft config root, owner-readable only.
 * Nothing here reaches the network unless a subscription exists, so an install
 * that never subscribed sends nothing and costs nothing.
 */

import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs'
import { dirname, join } from 'node:path'

export interface PushSubscriptionRecord {
  endpoint: string
  keys: { p256dh: string; auth: string }
  /** Free-form label so the owner can tell one device from another. */
  label?: string
  addedAtMs: number
}

export interface VapidKeys {
  publicKey: string
  privateKey: string
  subject: string
}

/**
 * Delivers one encrypted payload to one endpoint. Injectable so the debounce and
 * dead-endpoint rules can be tested without reaching a real push service; the
 * default implementation is web-push.
 */
export type PushSender = (
  subscription: { endpoint: string; keys: { p256dh: string; auth: string } },
  payload: string,
  vapid: VapidKeys,
) => Promise<void>

export interface OwnerPushNotification {
  title: string
  body: string
  /** Opened when the notification is tapped. */
  url?: string
  /** Stable id so a repeated decision replaces its own notification. */
  tag?: string
}

/**
 * VAPID subject. Apple's push service validates it and refuses a JWT whose
 * subject is not a routable mailto/https, so a localhost placeholder makes every
 * send fail with an opaque rejection.
 */
const DEFAULT_SUBJECT = process.env.CRAFT_PUSH_SUBJECT?.trim() || 'mailto:owner@craft.invalid'

const STATES_NEEDING_A_DECISION = new Set(['owner-gate', 'blocked', 'preservation-unknown'])

/** Whether a lifecycle state is one the owner has to answer. */
export function needsOwnerDecision(state: unknown): boolean {
  return typeof state === 'string' && STATES_NEEDING_A_DECISION.has(state)
}

export class OwnerPushService {
  readonly #keysPath: string
  readonly #subscriptionsPath: string
  #keys: VapidKeys | null = null
  #subscriptions: PushSubscriptionRecord[] | null = null
  #sentTags = new Map<string, number>()

  readonly #send: PushSender

  constructor(
    configRoot: string,
    readonly log: (message: string) => void = () => {},
    send: PushSender = webPushSender,
  ) {
    this.#send = send
    this.#keysPath = join(configRoot, 'push', 'vapid.json')
    this.#subscriptionsPath = join(configRoot, 'push', 'subscriptions.json')
  }

  /**
   * The public key a browser needs to subscribe. Generated once and reused:
   * regenerating it would silently invalidate every existing subscription, so
   * an existing key file is never overwritten.
   */
  async publicKey(): Promise<string> {
    return (await this.#loadOrCreateKeys()).publicKey
  }

  subscriptions(): PushSubscriptionRecord[] {
    if (this.#subscriptions) return this.#subscriptions
    if (!existsSync(this.#subscriptionsPath)) {
      this.#subscriptions = []
      return this.#subscriptions
    }
    try {
      const parsed = JSON.parse(readFileSync(this.#subscriptionsPath, 'utf8'))
      this.#subscriptions = Array.isArray(parsed) ? parsed.filter(isSubscription) : []
    } catch {
      // A corrupt store must not take the server down; it is a cache of
      // endpoints, and a device can always subscribe again.
      this.log('push subscription store is unreadable and was ignored')
      this.#subscriptions = []
    }
    return this.#subscriptions
  }

  subscribe(record: Omit<PushSubscriptionRecord, 'addedAtMs'>, nowMs: number): { added: boolean } {
    if (!isSubscription({ ...record, addedAtMs: nowMs })) throw new Error('push subscription is malformed')
    const current = this.subscriptions()
    if (current.some((entry) => entry.endpoint === record.endpoint)) return { added: false }
    this.#write([...current, { ...record, addedAtMs: nowMs }])
    return { added: true }
  }

  unsubscribe(endpoint: string): { removed: boolean } {
    const current = this.subscriptions()
    const next = current.filter((entry) => entry.endpoint !== endpoint)
    if (next.length === current.length) return { removed: false }
    this.#write(next)
    return { removed: true }
  }

  /**
   * Send one notification to every subscribed device.
   *
   * A `tag` repeated inside the debounce window is dropped: a tick every fifteen
   * minutes must not re-notify about the same unanswered gate, or the owner
   * learns to ignore it. An endpoint the push service rejects as gone is
   * removed, because a dead endpoint never recovers.
   */
  async notify(notification: OwnerPushNotification, nowMs: number, debounceMs = 6 * 60 * 60 * 1000): Promise<{ sent: number; skipped: string | null }> {
    const targets = this.subscriptions()
    if (targets.length === 0) return { sent: 0, skipped: 'no subscribed device' }
    if (notification.tag) {
      const last = this.#sentTags.get(notification.tag)
      if (last !== undefined && nowMs - last < debounceMs) return { sent: 0, skipped: 'already notified recently' }
    }

    const keys = await this.#loadOrCreateKeys()
    const payload = JSON.stringify(notification)
    let sent = 0
    for (const target of [...targets]) {
      try {
        await this.#send({ endpoint: target.endpoint, keys: target.keys }, payload, keys)
        sent += 1
      } catch (error) {
        const status = (error as { statusCode?: number }).statusCode
        if (status === 404 || status === 410) {
          this.unsubscribe(target.endpoint)
          this.log(`push endpoint is gone and was removed (${status})`)
        } else {
          // The status and the service's own body are the only things that
          // distinguish a rejected VAPID subject from a rate limit or an outage,
          // and without them a failed push is unactionable.
          const detail = error as { statusCode?: number; body?: string }
          const parts = [
            error instanceof Error ? error.message : String(error),
            detail.statusCode ? `status ${detail.statusCode}` : null,
            detail.body ? `body ${String(detail.body).slice(0, 200)}` : null,
          ].filter(Boolean)
          this.log(`push send failed: ${parts.join(' — ')}`)
        }
      }
    }
    if (notification.tag && sent > 0) this.#sentTags.set(notification.tag, nowMs)
    return { sent, skipped: null }
  }

  async #loadOrCreateKeys(): Promise<VapidKeys> {
    if (this.#keys) return this.#keys
    if (existsSync(this.#keysPath)) {
      const parsed = JSON.parse(readFileSync(this.#keysPath, 'utf8')) as Partial<VapidKeys>
      if (parsed.publicKey && parsed.privateKey) {
        this.#keys = { publicKey: parsed.publicKey, privateKey: parsed.privateKey, subject: parsed.subject ?? DEFAULT_SUBJECT }
        return this.#keys
      }
      throw new Error('VAPID key file exists but is incomplete; refusing to overwrite it')
    }
    const webpush = await import('web-push')
    const generated = webpush.default.generateVAPIDKeys()
    const keys: VapidKeys = { ...generated, subject: DEFAULT_SUBJECT }
    mkdirSync(dirname(this.#keysPath), { recursive: true, mode: 0o700 })
    writeFileSync(this.#keysPath, JSON.stringify(keys, null, 2), { mode: 0o600 })
    chmodSync(this.#keysPath, 0o600)
    this.#keys = keys
    return keys
  }

  #write(records: PushSubscriptionRecord[]): void {
    mkdirSync(dirname(this.#subscriptionsPath), { recursive: true, mode: 0o700 })
    writeFileSync(this.#subscriptionsPath, JSON.stringify(records, null, 2), { mode: 0o600 })
    chmodSync(this.#subscriptionsPath, 0o600)
    this.#subscriptions = records
  }
}

/**
 * The real delivery path. `urgency: 'high'` is what asks a phone to wake the
 * screen rather than batch the message for later, which is the whole point of
 * notifying about a decision; the TTL keeps a message that could not be
 * delivered within the hour from arriving long after the answer stopped
 * mattering.
 */
const webPushSender: PushSender = async (subscription, payload, vapid) => {
  const webpush = await import('web-push')
  webpush.default.setVapidDetails(vapid.subject, vapid.publicKey, vapid.privateKey)
  await webpush.default.sendNotification(subscription, payload, { urgency: 'high', TTL: 60 * 60 })
}

function isSubscription(value: unknown): value is PushSubscriptionRecord {
  if (!value || typeof value !== 'object') return false
  const record = value as PushSubscriptionRecord
  return typeof record.endpoint === 'string'
    && record.endpoint.startsWith('https://')
    && !!record.keys
    && typeof record.keys.p256dh === 'string'
    && typeof record.keys.auth === 'string'
}
