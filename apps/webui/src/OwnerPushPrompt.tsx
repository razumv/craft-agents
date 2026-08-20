/**
 * A small bar offering to turn on decision notifications on this device.
 *
 * Web-UI only by design: the desktop app is already in front of the owner, and
 * push exists for the case where they are not. It shows itself only when this
 * browser can actually deliver a notification and has not already subscribed,
 * so a phone that is set up sees nothing on every later visit.
 */

import React, { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { ownerPushStatus, subscribeOwnerPush, testOwnerPush, type OwnerPushStatus } from './owner-push'

interface Props {
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>
}

export function OwnerPushPrompt({ invoke }: Props) {
  const { t } = useTranslation()
  const [status, setStatus] = useState<OwnerPushStatus | null>(null)
  const [busy, setBusy] = useState(false)
  const [dismissed, setDismissed] = useState(() => localStorage.getItem('ownerPushDismissed') === '1')
  const [note, setNote] = useState<string | null>(null)

  useEffect(() => {
    ownerPushStatus().then(setStatus).catch(() => setStatus(null))
  }, [])

  if (!status || !status.supported || status.subscribed || dismissed) return null
  // A browser the owner has already refused will never prompt again; nagging it
  // would only ever produce the same silent denial.
  if (status.permission === 'denied') return null

  const enable = async () => {
    setBusy(true)
    setNote(null)
    try {
      const next = await subscribeOwnerPush(invoke)
      setStatus(next)
      if (next.subscribed) {
        // Prove the whole path end to end rather than claiming it works: the
        // owner should feel the phone buzz before they trust it.
        const result = await testOwnerPush(invoke)
        setNote(result.sent > 0 ? t('webui.ownerPush.testSent') : (result.skipped ?? null))
      } else {
        setNote(next.reason ?? t('webui.ownerPush.failed'))
      }
    } catch (error) {
      setNote(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }

  return (
    // The bar sits above the app shell, which means it — not the shell — is what
    // the notch and status bar overlap, so it carries the safe-area inset itself.
    <div
      className="flex items-center gap-3 px-4 pb-2 text-[13px] bg-background shadow-minimal"
      style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)' }}
    >
      <span className="text-foreground/70 flex-1">
        {note ?? t('webui.ownerPush.offer')}
      </span>
      <button
        onClick={enable}
        disabled={busy}
        className="px-3 py-1 rounded-md bg-background shadow-minimal text-foreground/80 cursor-pointer disabled:opacity-50"
      >
        {busy ? t('common.loading') : t('webui.ownerPush.enable')}
      </button>
      <button
        onClick={() => {
          localStorage.setItem('ownerPushDismissed', '1')
          setDismissed(true)
        }}
        className="px-2 py-1 text-foreground/50 cursor-pointer"
      >
        {t('common.dismiss')}
      </button>
    </div>
  )
}
