/*
 * Service worker for owner decision notifications.
 *
 * Its whole job is to show a notification while the app is closed or the screen
 * is locked, and to bring the board up when the notification is tapped. It
 * deliberately caches nothing: an offline board showing stale run states would
 * be worse than no board, because a decision would be taken against a snapshot
 * that has already moved on.
 *
 * A note on vibration, because it differs by platform and the difference
 * matters to whoever reads this next: Android honours the `vibrate` pattern
 * below. iOS ignores the pattern entirely — it plays the system haptic for a
 * notification, and only when the web app has been added to the Home Screen and
 * granted notification permission. So this file can ask for vibration; it
 * cannot promise the pattern on every device.
 */

/* global self, clients */

const VIBRATE_DECISION = [200, 100, 200, 100, 300]

self.addEventListener('install', () => {
  // Take over immediately: a newly installed worker that waits for every tab to
  // close would leave the owner without notifications for as long as one stale
  // tab stays open.
  self.skipWaiting()
})

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim())
})

self.addEventListener('push', (event) => {
  let payload = {}
  try {
    payload = event.data ? event.data.json() : {}
  } catch {
    payload = {}
  }

  const title = payload.title || 'Craft Agents'
  const options = {
    body: payload.body || 'A run is waiting for your decision.',
    icon: './icon-192.png',
    badge: './icon-192.png',
    vibrate: VIBRATE_DECISION,
    // A decision does not disappear because the phone was unlocked, so the
    // notification stays until it is acted on rather than auto-dismissing.
    requireInteraction: true,
    // One notification per issue and state: a repeated push about the same
    // unanswered decision replaces it instead of stacking.
    tag: payload.tag || 'craft-owner-decision',
    renotify: false,
    data: { url: payload.url || './' },
  }

  event.waitUntil(self.registration.showNotification(title, options))
})

self.addEventListener('notificationclick', (event) => {
  event.notification.close()
  const target = (event.notification.data && event.notification.data.url) || './'

  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    // Focus an open board rather than opening a second copy of it.
    for (const client of windows) {
      if ('focus' in client) {
        await client.focus()
        if ('navigate' in client && target !== './') await client.navigate(target).catch(() => {})
        return
      }
    }
    if (self.clients.openWindow) await self.clients.openWindow(target)
  })())
})
