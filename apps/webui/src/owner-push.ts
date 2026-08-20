/**
 * Registers the service worker and subscribes this device to owner-decision
 * notifications.
 *
 * Two things are deliberate. Permission is only ever requested from an explicit
 * user action — a browser that is asked on page load denies for the session and
 * the owner never sees a prompt again. And nothing here throws into the app:
 * push is an addition, so every failure is reported and swallowed.
 */

export interface OwnerPushStatus {
  supported: boolean
  permission: NotificationPermission | 'unsupported'
  subscribed: boolean
  reason?: string
}

type Invoke = (channel: string, ...args: unknown[]) => Promise<unknown>

const SW_URL = './sw.js'

function base64UrlToUint8Array(value: string): Uint8Array {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/')
  const raw = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4))
  return Uint8Array.from(raw, (char) => char.charCodeAt(0))
}

export async function ownerPushStatus(): Promise<OwnerPushStatus> {
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    return { supported: false, permission: 'unsupported', subscribed: false, reason: 'this browser has no Web Push' }
  }
  const registration = await navigator.serviceWorker.getRegistration()
  const existing = registration ? await registration.pushManager.getSubscription() : null
  return { supported: true, permission: Notification.permission, subscribed: !!existing }
}

/**
 * Subscribe this device. Must be called from a user gesture.
 *
 * On iOS this only works once the page has been added to the Home Screen —
 * Safari exposes no push to a plain tab — so the failure is reported in those
 * words rather than as a generic denial.
 */
export async function subscribeOwnerPush(invoke: Invoke, label?: string): Promise<OwnerPushStatus> {
  const status = await ownerPushStatus()
  if (!status.supported) return status

  const standalone = window.matchMedia('(display-mode: standalone)').matches
    || (window.navigator as { standalone?: boolean }).standalone === true
  const iOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  if (iOS && !standalone) {
    return { ...status, subscribed: false, reason: 'on iOS, add this page to the Home Screen first — Safari gives a plain tab no push' }
  }

  const permission = await Notification.requestPermission()
  if (permission !== 'granted') {
    return { supported: true, permission, subscribed: false, reason: 'notification permission was not granted' }
  }

  const registration = await navigator.serviceWorker.register(SW_URL)
  await navigator.serviceWorker.ready

  const { publicKey } = (await invoke('ownerPush:publicKey')) as { publicKey: string }
  if (!publicKey) return { supported: true, permission, subscribed: false, reason: 'the server returned no VAPID public key' }

  const existing = await registration.pushManager.getSubscription()
  const subscription = existing ?? await registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlToUint8Array(publicKey) as BufferSource,
  })

  const raw = subscription.toJSON() as { endpoint?: string; keys?: { p256dh?: string; auth?: string } }
  if (!raw.endpoint || !raw.keys?.p256dh || !raw.keys?.auth) {
    return { supported: true, permission, subscribed: false, reason: 'the browser returned an incomplete subscription' }
  }

  await invoke('ownerPush:subscribe', { endpoint: raw.endpoint, keys: raw.keys }, label ?? navigator.userAgent.slice(0, 80))
  return { supported: true, permission, subscribed: true }
}

export async function unsubscribeOwnerPush(invoke: Invoke): Promise<OwnerPushStatus> {
  const registration = await navigator.serviceWorker.getRegistration()
  const subscription = registration ? await registration.pushManager.getSubscription() : null
  if (subscription) {
    await invoke('ownerPush:unsubscribe', subscription.endpoint).catch(() => undefined)
    await subscription.unsubscribe().catch(() => undefined)
  }
  return ownerPushStatus()
}

/** Ask the server to send one notification now, so the owner can see it arrive. */
export async function testOwnerPush(invoke: Invoke): Promise<{ sent: number; skipped: string | null }> {
  return (await invoke('ownerPush:test')) as { sent: number; skipped: string | null }
}
