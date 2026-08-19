import * as React from 'react'
import { Check, Copy, ExternalLink, RefreshCw, X } from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'

/**
 * Read-only Kanban projection of the native Symphony (v4) service.
 *
 * Columns are fixed lifecycle groups; tiles are issues under Symphony
 * orchestration. Everything shown is durable evidence (IDs, links, exact gate
 * commands) — never transcript content. Data comes from the read-only
 * `symphony:status` snapshot, with a per-board refresh that re-reads live desk
 * projections via `symphony:projectDesk`. No mutation is possible from here.
 */

/** Mirrors @craft-agent/symphony ProjectStatus, defensively (snapshot is `unknown` over RPC). */
interface SymphonyTile {
  projectId: string
  /** Owner desk session — the only valid target for gate directives; null → copy-only buttons. */
  ownerSessionId: string | null
  issueIdentifier: string
  objective: string
  state: string
  prUrl: string | null
  branchUrl: string | null
  blocker: string | null
  nextCompletionPoint: string | null
  ownerGate: { id: string; approveCommand: string; rejectCommand: string } | null
  lastEvent: string | null
  error: string | null
}

interface SymphonyColumn {
  id: string
  labelKey: string
  states: readonly string[]
  accent: string
}

const SYMPHONY_COLUMNS: readonly SymphonyColumn[] = [
  { id: 'ready', labelKey: 'kanban.symphony.ready', states: ['ready'], accent: '#8b8b8b' },
  { id: 'claimed', labelKey: 'kanban.symphony.claimed', states: ['claimed'], accent: '#5b8def' },
  { id: 'running', labelKey: 'kanban.symphony.running', states: ['running'], accent: '#7c5bef' },
  { id: 'review', labelKey: 'kanban.symphony.review', states: ['pr-open', 'review'], accent: '#efae5b' },
  { id: 'owner-gate', labelKey: 'kanban.symphony.ownerGate', states: ['owner-gate'], accent: '#ef5b8d' },
  { id: 'done', labelKey: 'kanban.symphony.done', states: ['merged', 'deployed', 'done'], accent: '#3fa66a' },
  {
    id: 'attention',
    labelKey: 'kanban.symphony.attention',
    states: ['blocked', 'retry-wait', 'failed', 'cancelled', 'preservation-unknown'],
    accent: '#d15b5b',
  },
]

function columnFor(state: string): SymphonyColumn {
  return SYMPHONY_COLUMNS.find(c => c.states.includes(state)) ?? SYMPHONY_COLUMNS[SYMPHONY_COLUMNS.length - 1]!
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Parse one ProjectStatus-shaped object (from status snapshot or desk readback) into a tile. */
function tileFromStatus(projectId: string, status: Record<string, unknown>, ownerSessionId: string | null = null): SymphonyTile {
  const gate = status.ownerGate as Record<string, unknown> | null | undefined
  const event = status.lastMaterialEvent as Record<string, unknown> | null | undefined
  return {
    projectId,
    ownerSessionId,
    issueIdentifier: asString(status.issueIdentifier) ?? projectId,
    objective: asString(status.objective) ?? '',
    state: asString(status.state) ?? 'preservation-unknown',
    prUrl: asString(status.prUrl),
    branchUrl: asString(status.branchUrl),
    blocker: asString(status.blocker),
    nextCompletionPoint: asString(status.nextCompletionPoint),
    ownerGate: gate
      ? {
          id: asString(gate.id) ?? '',
          approveCommand: asString(gate.approveCommand) ?? '',
          rejectCommand: asString(gate.rejectCommand) ?? '',
        }
      : null,
    lastEvent: event ? (asString(event.message) ?? null) : null,
    error: null,
  }
}

/** Parse a ProjectDeskReadback (live desk projection) into a tile. */
function tileFromDesk(projectId: string, desk: Record<string, unknown>, ownerSessionId: string | null = null): SymphonyTile {
  const issue = (desk.issue ?? {}) as Record<string, unknown>
  const links = (desk.links ?? {}) as Record<string, unknown>
  const gate = desk.ownerGate as Record<string, unknown> | null | undefined
  const event = desk.latestMaterialEvent as Record<string, unknown> | null | undefined
  return {
    projectId,
    ownerSessionId,
    issueIdentifier: asString(issue.identifier) ?? projectId,
    objective: asString(issue.objective) ?? '',
    state: asString(issue.state) ?? 'preservation-unknown',
    prUrl: asString(links.pullRequest),
    branchUrl: asString(links.branch),
    blocker: asString(desk.blocker),
    nextCompletionPoint: asString(desk.nextCompletionPoint),
    ownerGate: gate
      ? {
          id: asString(gate.id) ?? '',
          approveCommand: asString(gate.approveCommand) ?? '',
          rejectCommand: asString(gate.rejectCommand) ?? '',
        }
      : null,
    lastEvent: event ? (asString(event.message) ?? null) : null,
    error: null,
  }
}

function errorTile(projectId: string, error: string): SymphonyTile {
  return {
    projectId,
    ownerSessionId: null,
    issueIdentifier: projectId,
    objective: '',
    state: 'preservation-unknown',
    prUrl: null,
    branchUrl: null,
    blocker: null,
    nextCompletionPoint: null,
    ownerGate: null,
    lastEvent: null,
    error,
  }
}

/** Extract tiles from the cached service status (reconstruction snapshots). */
function tilesFromServiceStatus(status: { projects: Array<Record<string, unknown>> }): SymphonyTile[] {
  const tiles: SymphonyTile[] = []
  for (const project of status.projects) {
    const projectId = asString(project.projectId) ?? 'unknown'
    const ownerSessionId = asString(project.ownerSessionId)
    const lastError = asString(project.lastError)
    // Reconstruction snapshot is a LiveRunnerStatus: { snapshot, status, execution }.
    // Discovery-mode runners additionally carry `statuses` — one per issue the
    // scheduler can see in the repository; prefer that full projection.
    const snapshot = project.snapshot as Record<string, unknown> | null | undefined
    const many = snapshot?.statuses as Array<Record<string, unknown>> | null | undefined
    const inner = snapshot?.status as Record<string, unknown> | null | undefined
    if (Array.isArray(many) && many.length > 0) {
      for (const status of many) tiles.push(tileFromStatus(projectId, status, ownerSessionId))
    } else if (inner) tiles.push(tileFromStatus(projectId, inner, ownerSessionId))
    else tiles.push(errorTile(projectId, lastError ?? 'no snapshot'))
  }
  return tiles
}

async function copyGateCommand(command: string, t: (key: string) => string): Promise<void> {
  await navigator.clipboard.writeText(command)
  toast.success(t('kanban.symphony.gateCopied'), { description: command })
}

/**
 * Send the exact gate command as an owner message into the owner desk session.
 * The button lives in the owner's own app, so the press IS the owner acting —
 * but it is still explicit: a confirm dialog shows the exact text first, and
 * REJECT additionally asks for the mandatory reason.
 */
async function sendGateCommand(
  tile: SymphonyTile,
  kind: 'approve' | 'reject',
  onSendMessage: (sessionId: string, message: string) => void,
  t: (key: string, options?: Record<string, unknown>) => string,
): Promise<void> {
  const gate = tile.ownerGate
  if (!gate || !tile.ownerSessionId) return
  let command = gate.approveCommand
  if (kind === 'reject') {
    const reason = window.prompt(t('kanban.symphony.gateRejectReason'))?.trim()
    if (!reason) return
    command = `REJECT ${gate.id}: ${reason}`
  }
  if (!window.confirm(t('kanban.symphony.gateSendConfirm', { command }))) return
  onSendMessage(tile.ownerSessionId, command)
  toast.success(t('kanban.symphony.gateSent'), { description: command })
}

function SymphonyTileCard({ tile, onSendMessage }: { tile: SymphonyTile; onSendMessage?: (sessionId: string, message: string) => void }) {
  const { t } = useTranslation()
  const canSend = !!(tile.ownerSessionId && onSendMessage)
  return (
    <div className="rounded-lg border border-border bg-card p-2.5 text-[12px] leading-snug shadow-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="font-semibold text-foreground">{tile.issueIdentifier}</span>
        <span className="shrink-0 rounded-md bg-foreground/[0.06] px-1.5 py-0.5 text-[10.5px] font-medium text-foreground/70">
          {tile.state}
        </span>
      </div>
      {tile.objective && <p className="mt-1 line-clamp-3 text-foreground/80">{tile.objective}</p>}
      {tile.error && <p className="mt-1 text-[11px] text-destructive">{tile.error}</p>}
      {tile.blocker && (
        <p className="mt-1 text-[11px] text-destructive">
          {t('kanban.symphony.blocker')}: {tile.blocker}
        </p>
      )}
      {tile.lastEvent && <p className="mt-1 truncate text-[11px] text-foreground/50">{tile.lastEvent}</p>}
      {tile.ownerGate?.id && (
        <div className="mt-1.5 rounded-md bg-foreground/[0.04] px-1.5 py-1">
          <div className="truncate font-mono text-[10.5px] text-foreground/70">{tile.ownerGate.id}</div>
          {/* The gate contract is exact owner text — these deliberately copy the
              exact command for the owner to paste into the owner session, rather
              than sending anything themselves. */}
          <div className="mt-1 flex items-center gap-1.5">
            <button
              type="button"
              onClick={() =>
                canSend
                  ? void sendGateCommand(tile, 'approve', onSendMessage!, t)
                  : void copyGateCommand(tile.ownerGate!.approveCommand, t)
              }
              className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-emerald-600 hover:bg-emerald-500/20"
            >
              <Check className="h-3 w-3" /> {t('kanban.symphony.approve')}
            </button>
            <button
              type="button"
              onClick={() =>
                canSend
                  ? void sendGateCommand(tile, 'reject', onSendMessage!, t)
                  : void copyGateCommand(tile.ownerGate!.rejectCommand, t)
              }
              className="inline-flex items-center gap-1 rounded-md bg-red-500/10 px-1.5 py-0.5 text-[10.5px] font-semibold text-red-600 hover:bg-red-500/20"
            >
              <X className="h-3 w-3" /> {t('kanban.symphony.reject')}
            </button>
            <Copy className="ml-auto h-3 w-3 text-foreground/30" />
          </div>
        </div>
      )}
      <div className="mt-1.5 flex items-center gap-2">
        {tile.prUrl && (
          <button
            type="button"
            onClick={() => window.electronAPI.openUrl(tile.prUrl!)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground/70 hover:text-foreground"
          >
            PR <ExternalLink className="h-3 w-3" />
          </button>
        )}
        {tile.branchUrl && (
          <button
            type="button"
            onClick={() => window.electronAPI.openUrl(tile.branchUrl!)}
            className="inline-flex items-center gap-1 text-[11px] font-medium text-foreground/70 hover:text-foreground"
          >
            {t('kanban.symphony.branch')} <ExternalLink className="h-3 w-3" />
          </button>
        )}
        {tile.nextCompletionPoint && (
          <span className="ml-auto truncate text-[10.5px] text-foreground/45">→ {tile.nextCompletionPoint}</span>
        )}
      </div>
    </div>
  )
}

export function SymphonyBoard({ onSendMessage }: { onSendMessage?: (sessionId: string, message: string) => void } = {}) {
  const { t } = useTranslation()
  const [tiles, setTiles] = React.useState<SymphonyTile[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)

  const loadFromStatus = React.useCallback(async () => {
    try {
      const status = await window.electronAPI.symphony.status()
      setTiles(tilesFromServiceStatus(status as unknown as { projects: Array<Record<string, unknown>> }))
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [])

  React.useEffect(() => {
    void loadFromStatus()
  }, [loadFromStatus])

  // Live refresh: re-read each project's desk projection (read-only), falling
  // back to the cached snapshot tile when a desk read fails.
  const handleRefresh = React.useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const status = await window.electronAPI.symphony.status()
      const projects = (status as unknown as { projects: Array<Record<string, unknown>> }).projects
      const next = await Promise.all(
        projects.map(async project => {
          const projectId = asString(project.projectId) ?? 'unknown'
          try {
            const result = await window.electronAPI.symphony.projectDesk(projectId)
            return tileFromDesk(projectId, (result as { result: Record<string, unknown> }).result, asString(project.ownerSessionId))
          } catch (err) {
            return errorTile(projectId, err instanceof Error ? err.message : String(err))
          }
        })
      )
      setTiles(next)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setRefreshing(false)
    }
  }, [refreshing])

  if (error && !tiles) {
    return (
      <div className="flex h-full items-center justify-center p-6 text-sm text-muted-foreground">
        {t('kanban.symphony.unavailable')}: {error}
      </div>
    )
  }

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end border-b border-border/50 px-4 py-1.5">
        <button
          type="button"
          onClick={() => void handleRefresh()}
          disabled={refreshing}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-[11.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.03] disabled:opacity-50"
        >
          <RefreshCw className={`h-3 w-3 ${refreshing ? 'animate-spin' : ''}`} />
          {t('kanban.symphony.refresh')}
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-x-auto snap-x snap-mandatory md:snap-none">
        <div className="flex h-full min-w-max gap-3 p-4">
          {SYMPHONY_COLUMNS.map(column => {
            const columnTiles = (tiles ?? []).filter(tile => columnFor(tile.state).id === column.id)
            return (
              <div key={column.id} className="flex w-64 shrink-0 snap-start flex-col rounded-xl bg-foreground/[0.02] p-2">
                <div className="flex items-center gap-2 px-1 pb-2">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: column.accent }} />
                  <span className="text-[12px] font-semibold text-foreground/80">{t(column.labelKey)}</span>
                  <span className="ml-auto text-[11px] text-foreground/40">{columnTiles.length}</span>
                </div>
                <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
                  {columnTiles.map(tile => (
                    <SymphonyTileCard key={`${tile.projectId}-${tile.issueIdentifier}`} tile={tile} onSendMessage={onSendMessage} />
                  ))}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}
