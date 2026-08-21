import { describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { OwnerPushService, needsOwnerDecision } from './owner-push'

function root(): string {
  return mkdtempSync(join(tmpdir(), 'owner-push-'))
}

const SUBSCRIPTION = {
  endpoint: 'https://push.example/abc',
  keys: { p256dh: 'p256dh-value', auth: 'auth-value' },
}

describe('needsOwnerDecision', () => {
  test('covers exactly the states where the lane cannot continue alone', () => {
    expect(needsOwnerDecision('owner-gate')).toBe(true)
    expect(needsOwnerDecision('blocked')).toBe(true)
    expect(needsOwnerDecision('preservation-unknown')).toBe(true)
    // Progress is not a decision — notifying on it would train the owner to
    // swipe every notification away.
    expect(needsOwnerDecision('in-progress')).toBe(false)
    expect(needsOwnerDecision('done')).toBe(false)
    expect(needsOwnerDecision(undefined)).toBe(false)
  })

  test('a closed issue is history, not a decision, in every one of those states', () => {
    // razumv/lineage2-server#94 merged and closed yesterday, and every server
    // restart re-read its reconciliation and pushed `blocked` again. Both of its
    // blockers were closed too, so there was nothing the owner could have done.
    expect(needsOwnerDecision('blocked', true)).toBe(false)
    expect(needsOwnerDecision('owner-gate', true)).toBe(false)
    expect(needsOwnerDecision('preservation-unknown', true)).toBe(false)
    // An open issue in the same state still has to reach the owner, and an
    // absent or non-true flag must not be read as closed.
    expect(needsOwnerDecision('blocked', false)).toBe(true)
    expect(needsOwnerDecision('blocked', undefined)).toBe(true)
    expect(needsOwnerDecision('blocked', 'true')).toBe(true)
  })
})

describe('OwnerPushService subscriptions', () => {
  test('subscribing twice from one device does not duplicate it', () => {
    const service = new OwnerPushService(root())
    expect(service.subscribe(SUBSCRIPTION, 1).added).toBe(true)
    expect(service.subscribe(SUBSCRIPTION, 2).added).toBe(false)
    expect(service.subscriptions()).toHaveLength(1)
  })

  test('subscriptions survive a restart and stay owner-only', () => {
    const configRoot = root()
    new OwnerPushService(configRoot).subscribe(SUBSCRIPTION, 1)

    const path = join(configRoot, 'push', 'subscriptions.json')
    expect(statSync(path).mode & 0o777).toBe(0o600)
    expect(new OwnerPushService(configRoot).subscriptions()).toHaveLength(1)
  })

  test('a malformed subscription is refused rather than stored', () => {
    const service = new OwnerPushService(root())
    expect(() => service.subscribe({ endpoint: 'http://insecure.example', keys: SUBSCRIPTION.keys }, 1)).toThrow()
    expect(service.subscriptions()).toHaveLength(0)
  })

  test('a corrupt store is ignored instead of taking the server down', () => {
    const configRoot = root()
    mkdirSync(join(configRoot, 'push'), { recursive: true })
    writeFileSync(join(configRoot, 'push', 'subscriptions.json'), 'not json at all')

    const logged: string[] = []
    const service = new OwnerPushService(configRoot, (message) => logged.push(message))
    expect(service.subscriptions()).toEqual([])
    expect(logged.join(' ')).toContain('unreadable')
  })

  test('unsubscribe reports whether it removed anything', () => {
    const service = new OwnerPushService(root())
    service.subscribe(SUBSCRIPTION, 1)
    expect(service.unsubscribe('https://push.example/other').removed).toBe(false)
    expect(service.unsubscribe(SUBSCRIPTION.endpoint).removed).toBe(true)
    expect(service.subscriptions()).toEqual([])
  })
})

describe('OwnerPushService keys', () => {
  test('the public key is generated once and reused across restarts', async () => {
    const configRoot = root()
    const first = await new OwnerPushService(configRoot).publicKey()
    // Regenerating would silently invalidate every device already subscribed.
    expect(await new OwnerPushService(configRoot).publicKey()).toBe(first)
    expect(statSync(join(configRoot, 'push', 'vapid.json')).mode & 0o777).toBe(0o600)
  })

  test('an incomplete key file is never overwritten', async () => {
    const configRoot = root()
    mkdirSync(join(configRoot, 'push'), { recursive: true })
    const path = join(configRoot, 'push', 'vapid.json')
    writeFileSync(path, JSON.stringify({ publicKey: 'only-public' }))

    await expect(new OwnerPushService(configRoot).publicKey()).rejects.toThrow(/incomplete/)
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ publicKey: 'only-public' })
  })
})

describe('OwnerPushService notify', () => {
  test('sends nothing when no device is subscribed', async () => {
    const result = await new OwnerPushService(root()).notify({ title: 't', body: 'b' }, 1_000)
    expect(result).toEqual({ sent: 0, skipped: 'no subscribed device' })
  })

  test('delivers to every subscribed device', async () => {
    const delivered: string[] = []
    const service = new OwnerPushService(root(), () => {}, async (subscription) => {
      delivered.push(subscription.endpoint)
    })
    service.subscribe(SUBSCRIPTION, 1)
    service.subscribe({ ...SUBSCRIPTION, endpoint: 'https://push.example/second' }, 1)

    expect(await service.notify({ title: 't', body: 'b' }, 1_000)).toEqual({ sent: 2, skipped: null })
    expect(delivered).toEqual(['https://push.example/abc', 'https://push.example/second'])
  })

  test('a repeated tag is dropped inside the window and allowed after it', async () => {
    let sends = 0
    const service = new OwnerPushService(root(), () => {}, async () => { sends += 1 })
    service.subscribe(SUBSCRIPTION, 1)
    const notification = { title: 't', body: 'b', tag: 'owner-decision:gta#59:owner-gate' }
    const window = 60_000

    expect((await service.notify(notification, 1_000, window)).sent).toBe(1)
    // A tick re-reads the same unanswered gate every cycle; re-notifying would
    // teach the owner to ignore the notification.
    expect(await service.notify(notification, 2_000, window)).toEqual({ sent: 0, skipped: 'already notified recently' })
    expect((await service.notify(notification, 1_000 + window, window)).sent).toBe(1)
    expect(sends).toBe(2)
  })

  test('an untagged notification is never debounced', async () => {
    let sends = 0
    const service = new OwnerPushService(root(), () => {}, async () => { sends += 1 })
    service.subscribe(SUBSCRIPTION, 1)
    await service.notify({ title: 't', body: 'b' }, 1_000)
    await service.notify({ title: 't', body: 'b' }, 1_001)
    expect(sends).toBe(2)
  })

  test('a debounced tag is not recorded when every send failed', async () => {
    let attempts = 0
    const service = new OwnerPushService(root(), () => {}, async () => {
      attempts += 1
      throw new Error('push service unavailable')
    })
    service.subscribe(SUBSCRIPTION, 1)
    const notification = { title: 't', body: 'b', tag: 'owner-decision:gta#59:blocked' }

    expect(await service.notify(notification, 1_000, 60_000)).toEqual({ sent: 0, skipped: null })
    // Nothing reached the phone, so the next tick must be allowed to try again
    // rather than being silenced by a debounce for a delivery that never happened.
    await service.notify(notification, 1_500, 60_000)
    expect(attempts).toBe(2)
  })

  test('an endpoint the push service reports as gone is removed', async () => {
    const logged: string[] = []
    const service = new OwnerPushService(root(), (message) => logged.push(message), async () => {
      throw Object.assign(new Error('gone'), { statusCode: 410 })
    })
    service.subscribe(SUBSCRIPTION, 1)

    await service.notify({ title: 't', body: 'b' }, 1_000)
    expect(service.subscriptions()).toEqual([])
    expect(logged.join(' ')).toContain('410')
  })

  test('a transient send failure keeps the subscription', async () => {
    const service = new OwnerPushService(root(), () => {}, async () => {
      throw Object.assign(new Error('rate limited'), { statusCode: 429 })
    })
    service.subscribe(SUBSCRIPTION, 1)

    await service.notify({ title: 't', body: 'b' }, 1_000)
    // A rate-limited push service recovers; a dead endpoint does not. Only the
    // latter should cost the owner their subscription.
    expect(service.subscriptions()).toHaveLength(1)
  })
})
