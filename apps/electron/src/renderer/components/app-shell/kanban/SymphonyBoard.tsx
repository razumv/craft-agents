import * as React from 'react'
import { Check, Copy, ExternalLink, Plus, RefreshCw, X } from 'lucide-react'
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
interface SymphonyLoopInfo {
  enabled: boolean
  mode: string
  cycles: number
  lastCycleAt: number | null
  droppedProjects: string[]
}

/** Per-project intake options surfaced by the service (model policy + defaults). */
interface SymphonyProjectOption {
  projectId: string
  /** owner/name — what the owner actually recognises in the picker. */
  repository: string | null
  allowedProfiles: string[]
  verificationBudget: string | null
}

interface SymphonyTile {
  projectId: string
  /** Craft project the Symphony project is bound to (for the board's project filter). */
  craftProjectId: string | null
  /** Owner desk session — the only valid target for gate directives; null → copy-only buttons. */
  ownerSessionId: string | null
  issueIdentifier: string
  objective: string
  state: string
  /** Tracker closed the issue. A terminal state on a closed issue is history, not a request. */
  issueClosed: boolean
  prUrl: string | null
  branchUrl: string | null
  blocker: string | null
  nextCompletionPoint: string | null
  ownerGate: { id: string; approveCommand: string; rejectCommand: string } | null
  lastEvent: string | null
  attempt: number | null
  retryDueAtMs: number | null
  recentEvents: { sequence: number; atMs: number; state: string; message: string }[]
  error: string | null
}

/**
 * An open repository issue the lane does not manage. It has no run, no claim and
 * no contract — it is shown so the board reflects the repository rather than
 * only the slice already contracted, because a board that shows nothing but the
 * lane's own queue makes an untouched project look like a finished one.
 */
interface SymphonyBacklogItem {
  projectId: string
  craftProjectId: string | null
  issueIdentifier: string
  title: string
  url: string | null
  labels: string[]
}

interface SymphonyColumn {
  id: string
  labelKey: string
  states: readonly string[]
  accent: string
}

const SYMPHONY_COLUMNS: readonly SymphonyColumn[] = [
  // Not a lifecycle state: unmanaged repository issues, read-only.
  { id: 'backlog', labelKey: 'kanban.symphony.backlog', states: [], accent: '#6b7280' },
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

/**
 * A closed issue is a record, not a request. However its run ended — merged,
 * finished by hand, dropped, or retried into nothing — nobody can act on a
 * closed issue, and the scheduler will not dispatch one either, since closed is
 * not dispatchable. So closed tiles always file under Done, whatever lifecycle
 * state they carry; the state on the tile still says exactly what it said.
 *
 * The narrower version of this rule shipped first, covering only `failed` and
 * `cancelled`, and a closed issue in `retry-wait` promptly showed up sitting in
 * Ready — a card in the queue that could never be picked up.
 */
function columnFor(state: string, issueClosed = false): SymphonyColumn {
  if (issueClosed) return SYMPHONY_COLUMNS.find(c => c.id === 'done')!
  return SYMPHONY_COLUMNS.find(c => c.states.includes(state)) ?? SYMPHONY_COLUMNS[SYMPHONY_COLUMNS.length - 1]!
}

function asString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null
}

/** Parse one ProjectStatus-shaped object (from status snapshot or desk readback) into a tile. */
function tileFromStatus(projectId: string, status: Record<string, unknown>, ownerSessionId: string | null = null, craftProjectId: string | null = null): SymphonyTile {
  const gate = status.ownerGate as Record<string, unknown> | null | undefined
  const event = status.lastMaterialEvent as Record<string, unknown> | null | undefined
  return {
    projectId,
    craftProjectId,
    ownerSessionId,
    issueIdentifier: asString(status.issueIdentifier) ?? projectId,
    objective: asString(status.objective) ?? '',
    state: asString(status.state) ?? 'preservation-unknown',
    issueClosed: status.issueClosed === true,
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
    attempt: typeof status.attempt === 'number' ? status.attempt : null,
    retryDueAtMs: typeof status.retryDueAtMs === 'number' ? status.retryDueAtMs : null,
    recentEvents: Array.isArray(status.recentEvents)
      ? (status.recentEvents as SymphonyTile['recentEvents']).slice(-5)
      : [],
    error: null,
  }
}

/** Parse a ProjectDeskReadback (live desk projection) into a tile. */
function tileFromDesk(projectId: string, desk: Record<string, unknown>, ownerSessionId: string | null = null, craftProjectId: string | null = null): SymphonyTile {
  const issue = (desk.issue ?? {}) as Record<string, unknown>
  const links = (desk.links ?? {}) as Record<string, unknown>
  const gate = desk.ownerGate as Record<string, unknown> | null | undefined
  const event = desk.latestMaterialEvent as Record<string, unknown> | null | undefined
  return {
    projectId,
    craftProjectId,
    ownerSessionId,
    issueIdentifier: asString(issue.identifier) ?? projectId,
    objective: asString(issue.objective) ?? '',
    state: asString(issue.state) ?? 'preservation-unknown',
    issueClosed: issue.closed === true,
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
    attempt: null,
    retryDueAtMs: null,
    recentEvents: [],
    error: null,
  }
}

function errorTile(projectId: string, error: string): SymphonyTile {
  return {
    projectId,
    craftProjectId: null,
    ownerSessionId: null,
    issueIdentifier: projectId,
    objective: '',
    state: 'preservation-unknown',
    issueClosed: false,
    prUrl: null,
    branchUrl: null,
    blocker: null,
    nextCompletionPoint: null,
    ownerGate: null,
    lastEvent: null,
    attempt: null,
    retryDueAtMs: null,
    recentEvents: [],
    error,
  }
}

/** Extract tiles from the cached service status (reconstruction snapshots). */
function backlogFromServiceStatus(status: { projects: Array<Record<string, unknown>> }): SymphonyBacklogItem[] {
  const items: SymphonyBacklogItem[] = []
  const seen = new Set<string>()
  for (const project of status.projects) {
    const projectId = asString(project.projectId) ?? 'unknown'
    const craftProjectId = asString(project.craftProjectId)
    const snapshot = project.snapshot as Record<string, unknown> | null | undefined
    const backlog = snapshot?.backlog as Array<Record<string, unknown>> | null | undefined
    if (!Array.isArray(backlog)) continue
    for (const entry of backlog) {
      const issueIdentifier = asString(entry.identifier)
      // Two Symphony projects can watch one repository; show each issue once.
      if (!issueIdentifier || seen.has(issueIdentifier)) continue
      seen.add(issueIdentifier)
      items.push({
        projectId,
        craftProjectId,
        issueIdentifier,
        title: asString(entry.title) ?? issueIdentifier,
        url: asString(entry.url),
        labels: Array.isArray(entry.labels) ? (entry.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [],
      })
    }
  }
  return items
}

function tilesFromServiceStatus(status: { projects: Array<Record<string, unknown>> }): SymphonyTile[] {
  const tiles: SymphonyTile[] = []
  for (const project of status.projects) {
    const projectId = asString(project.projectId) ?? 'unknown'
    const ownerSessionId = asString(project.ownerSessionId)
    const craftProjectId = asString(project.craftProjectId)
    const lastError = asString(project.lastError)
    // Reconstruction snapshot is a LiveRunnerStatus: { snapshot, status, execution }.
    // Discovery-mode runners additionally carry `statuses` — one per issue the
    // scheduler can see in the repository; prefer that full projection.
    const snapshot = project.snapshot as Record<string, unknown> | null | undefined
    const many = snapshot?.statuses as Array<Record<string, unknown>> | null | undefined
    const inner = snapshot?.status as Record<string, unknown> | null | undefined
    if (Array.isArray(many) && many.length > 0) {
      for (const status of many) tiles.push(tileFromStatus(projectId, status, ownerSessionId, craftProjectId))
    } else if (inner) tiles.push(tileFromStatus(projectId, inner, ownerSessionId, craftProjectId))
    else if (lastError) tiles.push(errorTile(projectId, lastError))
    // A reconstructed project with no managed issue is not an error and has no
    // lifecycle state: it simply has nothing contracted yet, which is exactly
    // where a freshly onboarded project starts. Emitting a tile here stamped it
    // `preservation-unknown` — "we cannot tell what happened to the work" — and
    // filed a healthy project under Attention. Its repository is still visible
    // through the Backlog column, so nothing is hidden by staying quiet.
  }
  // The same GitHub issue can be visible through several Symphony projects
  // (e.g. a pinned single-issue project plus repository discovery). Keep one
  // tile per issue, preferring the multi-issue (discovery) projection.
  const byIssue = new Map<string, SymphonyTile>()
  for (const tile of tiles) {
    const existing = byIssue.get(tile.issueIdentifier)
    if (!existing || tile.error === null) byIssue.set(tile.issueIdentifier, tile)
  }
  return [...byIssue.values()]
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

/** GitHub issue URL derived from the identifier (owner/repo#N) — keeps the tile clickable without server round-trips. */
function issueUrlFor(tile: SymphonyTile): string | null {
  const match = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(tile.issueIdentifier)
  return match ? `https://github.com/${match[1]}/issues/${match[2]}` : null
}

function SymphonyTileCard({ tile, onSendMessage }: { tile: SymphonyTile; onSendMessage?: (sessionId: string, message: string) => void }) {
  const { t } = useTranslation()
  const canSend = !!(tile.ownerSessionId && onSendMessage)
  const issueUrl = issueUrlFor(tile)
  return (
    <div className="rounded-lg border border-border bg-card p-2.5 text-[12px] leading-snug shadow-sm">
      <div className="flex items-center justify-between gap-2">
        {issueUrl ? (
          <button
            type="button"
            onClick={() => window.electronAPI.openUrl(issueUrl)}
            className="truncate text-left font-semibold text-foreground hover:underline"
            title={issueUrl}
          >
            {tile.issueIdentifier}
          </button>
        ) : (
          <span className="font-semibold text-foreground">{tile.issueIdentifier}</span>
        )}
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
      {tile.state === 'retry-wait' && tile.attempt !== null && (
        <p className="mt-1 text-[11px] font-medium text-amber-600">
          {t('kanban.symphony.retryAttempt', {
            attempt: tile.attempt,
            time: tile.retryDueAtMs ? new Date(tile.retryDueAtMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—',
          })}
        </p>
      )}
      {tile.recentEvents.length > 0 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-[10.5px] text-foreground/40">
            {t('kanban.symphony.history', { count: tile.recentEvents.length })}
          </summary>
          <ul className="mt-1 space-y-0.5">
            {tile.recentEvents.map(event => (
              <li key={event.sequence} className="text-[10.5px] text-foreground/55">
                <span className="font-mono">#{event.sequence}</span>{' '}
                {new Date(event.atMs).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}{' '}
                [{event.state}] {event.message}
              </li>
            ))}
          </ul>
        </details>
      )}
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

export function SymphonyBoard({ onSendMessage, projectFilter = [] }: { onSendMessage?: (sessionId: string, message: string) => void; projectFilter?: string[] } = {}) {
  const { t } = useTranslation()
  const [tiles, setTiles] = React.useState<SymphonyTile[] | null>(null)
  const [backlog, setBacklog] = React.useState<SymphonyBacklogItem[]>([])
  const [loopInfo, setLoopInfo] = React.useState<SymphonyLoopInfo | null>(null)
  const [projectErrors, setProjectErrors] = React.useState<{ projectId: string; error: string }[]>([])
  // Terminal columns (done/attention) start collapsed — finished/failed work
  // shouldn't crowd out the active pipeline. Session-local, not persisted.
  // Columns the owner has toggled away from their default. The default itself is
  // computed per render: terminal columns and empty columns collapse to a strip,
  // because a board is for seeing work, and an empty full-width column is a
  // column-width hole between the columns that do have work in it.
  const [toggledColumns, setToggledColumns] = React.useState<Set<string>>(() => new Set())
  // Previous tile states, for owner-attention transition toasts (notify-lite).
  const prevStatesRef = React.useRef<Map<string, string>>(new Map())
  const [error, setError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [composerOpen, setComposerOpen] = React.useState(false)
  const [creating, setCreating] = React.useState(false)
  const [projectOptions, setProjectOptions] = React.useState<SymphonyProjectOption[]>([])
  const [draft, setDraft] = React.useState({
    projectId: '',
    title: '',
    goal: '',
    risk: 'low' as 'low' | 'medium' | 'high',
    acceptance: '',
    nonGoals: '',
    model: '',
    dependencies: [] as string[],
  })
  const activeProject = projectOptions.find(option => option.projectId === draft.projectId) ?? projectOptions[0]
  // Dependencies must live in the same project (cross-project blockedBy cannot
  // be resolved by that project's tracker) and exclude terminal work.
  const dependencyCandidates = React.useMemo(
    () => (tiles ?? []).filter(tile =>
      tile.projectId === activeProject?.projectId
      && !['done', 'cancelled'].includes(tile.state)),
    [tiles, activeProject],
  )

  const loadFromStatus = React.useCallback(async () => {
    try {
      const status = await window.electronAPI.symphony.status()
      const raw = status as unknown as { projects: Array<Record<string, unknown>>; loop: SymphonyLoopInfo | null }
      const nextTiles = tilesFromServiceStatus(raw)

      // Intake targets are discovery projects only: a pinned single-issue
      // project can never dispatch a newly created issue, so offering it would
      // silently orphan the work (the server refuses it too).
      setProjectOptions(raw.projects
        .filter(project => project.mode === 'discovery')
        .map(project => ({
          projectId: asString(project.projectId) ?? 'unknown',
          repository: asString(project.repository),
          allowedProfiles: Array.isArray(project.allowedProfiles) ? (project.allowedProfiles as string[]) : [],
          verificationBudget: asString(project.verificationBudget),
        })))

      // Surface project-level failures loudly instead of a silent stub tile.
      setProjectErrors(raw.projects
        .filter(project => asString(project.lastError) || project.phase === 'error')
        .map(project => ({
          projectId: asString(project.projectId) ?? 'unknown',
          error: asString(project.lastError) ?? 'error',
        })))

      // Notify-lite: toast when an issue TRANSITIONS into a state that needs
      // the owner (owner-gate) or their attention (failed). Only transitions —
      // a tile that was already there on first load stays quiet.
      const prev = prevStatesRef.current
      if (prev.size > 0) {
        for (const tile of nextTiles) {
          const before = prev.get(tile.issueIdentifier)
          if (before !== tile.state && (tile.state === 'owner-gate' || tile.state === 'failed')) {
            toast.warning(t('kanban.symphony.stateAlert', { issue: tile.issueIdentifier, state: tile.state }))
          }
        }
      }
      prevStatesRef.current = new Map(nextTiles.map(tile => [tile.issueIdentifier, tile.state]))

      setTiles(nextTiles)
      setBacklog(backlogFromServiceStatus(raw))
      setLoopInfo(raw.loop ?? null)
      setError(null)
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    }
  }, [t])

  // Live updates: the server broadcasts after every completed operation
  // (tick, loop shadow cycle, refresh, issue intake) — re-read status then.
  React.useEffect(() => {
    const off = window.electronAPI.symphony.onChanged?.(() => { void loadFromStatus() })
    return () => { if (typeof off === 'function') off() }
  }, [loadFromStatus])

  const handleCreateIssue = React.useCallback(async () => {
    if (creating) return
    // Explicit project — never "whichever tile happened to be first".
    const projectId = draft.projectId || activeProject?.projectId || ''
    if (!projectId || !draft.title.trim() || !draft.goal.trim() || !draft.acceptance.trim()) return
    setCreating(true)
    try {
      await window.electronAPI.symphony.createIssue(projectId, {
        title: draft.title.trim(),
        goal: draft.goal.trim(),
        risk: draft.risk,
        acceptance: draft.acceptance.split('\n').map(l => l.trim()).filter(Boolean),
        nonGoals: draft.nonGoals.split('\n').map(l => l.trim()).filter(Boolean),
        ...(draft.model ? { model: draft.model } : {}),
        ...(draft.dependencies.length ? { dependencies: draft.dependencies } : {}),
      })
      toast.success(t('kanban.symphony.issueCreated'))
      setComposerOpen(false)
      setDraft(d => ({ ...d, title: '', goal: '', acceptance: '', nonGoals: '', dependencies: [] }))
      await loadFromStatus()
    } catch (err) {
      toast.error(t('kanban.symphony.issueCreateFailed'), { description: err instanceof Error ? err.message : String(err) })
    } finally {
      setCreating(false)
    }
  }, [creating, draft, activeProject, loadFromStatus, t])

  React.useEffect(() => {
    void loadFromStatus()
  }, [loadFromStatus])

  // Live refresh: re-read each project's desk projection (read-only), falling
  // back to the cached snapshot tile when a desk read fails.
  // Refresh re-reads each project's full durable status server-side (read-only)
  // and then re-renders from the updated snapshots, so discovery projects keep
  // one tile per issue instead of collapsing to a single desk card.
  const handleRefresh = React.useCallback(async () => {
    if (refreshing) return
    setRefreshing(true)
    try {
      const before = await window.electronAPI.symphony.status()
      await Promise.all(
        (before.projects ?? []).map(project =>
          window.electronAPI.symphony.refresh(project.projectId).catch(() => null)
        )
      )
      const status = await window.electronAPI.symphony.status()
      const raw = status as unknown as { projects: Array<Record<string, unknown>> }
      setTiles(tilesFromServiceStatus(raw))
      setBacklog(backlogFromServiceStatus(raw))
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
      <div className="flex items-center justify-between border-b border-border/50 px-4 py-1.5">
        <div className="flex items-center gap-2">
          {loopInfo && (
            <span
              className={`inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[10.5px] font-medium ${loopInfo.enabled ? 'bg-emerald-500/10 text-emerald-600' : 'bg-foreground/[0.05] text-foreground/50'}`}
              title={loopInfo.droppedProjects.length ? `dropped: ${loopInfo.droppedProjects.join(', ')}` : undefined}
            >
              <span className={`h-1.5 w-1.5 rounded-full ${loopInfo.enabled ? 'bg-emerald-500 animate-pulse' : 'bg-foreground/30'}`} />
              {t('kanban.symphony.loopChip', {
                mode: loopInfo.mode,
                cycles: loopInfo.cycles,
                last: loopInfo.lastCycleAt ? new Date(loopInfo.lastCycleAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—',
              })}
              {loopInfo.droppedProjects.length > 0 && (
                <span className="text-red-500">⚠ {loopInfo.droppedProjects.length}</span>
              )}
            </span>
          )}
        </div>
        <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => setComposerOpen(open => !open)}
          disabled={projectOptions.length === 0}
          title={projectOptions.length === 0 ? t('kanban.symphony.issueNoTarget') : undefined}
          className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-card px-2 text-[11.5px] font-medium text-foreground transition-colors hover:bg-foreground/[0.03] disabled:opacity-40"
        >
          <Plus className="h-3 w-3" /> {t('kanban.symphony.newIssue')}
        </button>
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
      </div>
      {projectErrors.length > 0 && (
        <div className="space-y-1 border-b border-border/50 bg-red-500/10 px-4 py-2">
          {projectErrors.map(entry => (
            <p key={entry.projectId} className="text-[11.5px] font-medium text-red-500">
              {t('kanban.symphony.projectError', { project: entry.projectId })}: {entry.error}
            </p>
          ))}
        </div>
      )}
      {composerOpen && (
        <div className="space-y-2 border-b border-border/50 bg-foreground/[0.02] px-4 py-3 text-[12px]">
          {/* Project + model are explicit: a contract issue lands in exactly one
              configured Symphony project, and the executor profile must be one the
              project's model policy accepts (anything else fails contract parsing). */}
          <div className="flex flex-wrap gap-2">
            <label className="flex items-center gap-1.5 text-[11px] text-foreground/60">
              {t('kanban.symphony.issueProject')}
              <select
                className="h-8 rounded-lg border border-border bg-card px-2 text-[12px] text-foreground"
                value={draft.projectId || activeProject?.projectId || ''}
                onChange={e => setDraft(d => ({ ...d, projectId: e.target.value, model: '' }))}
              >
                {projectOptions.map(option => (
                  <option key={option.projectId} value={option.projectId}>
                    {option.repository ? `${option.repository} · ${option.projectId}` : option.projectId}
                  </option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-foreground/60">
              {t('kanban.symphony.issueModel')}
              <select
                className="h-8 rounded-lg border border-border bg-card px-2 text-[12px] text-foreground"
                value={draft.model}
                onChange={e => setDraft(d => ({ ...d, model: e.target.value }))}
              >
                <option value="">{t('kanban.symphony.issueModelDefault')}</option>
                {(activeProject?.allowedProfiles ?? []).map(profile => (
                  <option key={profile} value={profile}>{profile}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-1.5 text-[11px] text-foreground/60">
              {t('kanban.symphony.issueRisk')}
              <select
                className="h-8 rounded-lg border border-border bg-card px-2 text-[12px] text-foreground"
                value={draft.risk}
                onChange={e => setDraft(d => ({ ...d, risk: e.target.value as typeof d.risk }))}
              >
                <option value="low">low</option>
                <option value="medium">medium</option>
                <option value="high">high</option>
              </select>
            </label>
          </div>
          <input
            className="h-8 w-full rounded-lg border border-border bg-card px-2"
            placeholder={t('kanban.symphony.issueTitle')}
            value={draft.title}
            onChange={e => setDraft(d => ({ ...d, title: e.target.value }))}
          />
          <input
            className="h-8 w-full rounded-lg border border-border bg-card px-2"
            placeholder={t('kanban.symphony.issueGoal')}
            value={draft.goal}
            onChange={e => setDraft(d => ({ ...d, goal: e.target.value }))}
          />
          <textarea
            className="w-full rounded-lg border border-border bg-card px-2 py-1.5"
            rows={3}
            placeholder={t('kanban.symphony.issueAcceptance')}
            value={draft.acceptance}
            onChange={e => setDraft(d => ({ ...d, acceptance: e.target.value }))}
          />
          <textarea
            className="w-full rounded-lg border border-border bg-card px-2 py-1.5"
            rows={2}
            placeholder={t('kanban.symphony.issueNonGoals')}
            value={draft.nonGoals}
            onChange={e => setDraft(d => ({ ...d, nonGoals: e.target.value }))}
          />
          {/* Decomposition in v4 = separate issues plus edges: dependencies become
              blockedBy, so this issue stays undispatchable until they are done.
              (The Tasks world used in-session subtasks; Symphony uses the tracker.) */}
          {dependencyCandidates.length > 0 && (
            <div>
              <p className="mb-1 text-[11px] text-foreground/60">{t('kanban.symphony.issueDependsOn')}</p>
              <div className="flex flex-wrap gap-1.5">
                {dependencyCandidates.map(tile => {
                  const selected = draft.dependencies.includes(tile.issueIdentifier)
                  return (
                    <button
                      key={tile.issueIdentifier}
                      type="button"
                      onClick={() => setDraft(d => ({
                        ...d,
                        dependencies: selected
                          ? d.dependencies.filter(entry => entry !== tile.issueIdentifier)
                          : [...d.dependencies, tile.issueIdentifier],
                      }))}
                      className={`rounded-md px-1.5 py-0.5 text-[10.5px] font-medium transition-colors ${
                        selected ? 'bg-foreground text-background' : 'bg-foreground/[0.06] text-foreground/70 hover:bg-foreground/[0.12]'
                      }`}
                    >
                      {tile.issueIdentifier}
                    </button>
                  )
                })}
              </div>
            </div>
          )}
          <div className="flex items-center justify-end gap-2">
            {activeProject?.verificationBudget && (
              <span className="mr-auto text-[10.5px] text-foreground/40">
                {t('kanban.symphony.issueBudget')}: {activeProject.verificationBudget}
              </span>
            )}
            <button
              type="button"
              disabled={creating || !draft.title.trim() || !draft.goal.trim() || !draft.acceptance.trim()}
              onClick={() => void handleCreateIssue()}
              className="inline-flex h-7 items-center rounded-lg bg-foreground px-3 text-[11.5px] font-semibold text-background disabled:opacity-40"
            >
              {creating ? '…' : t('kanban.symphony.issueCreate')}
            </button>
          </div>
        </div>
      )}
      <div className="min-h-0 flex-1 overflow-x-auto snap-x snap-mandatory md:snap-none">
        <div className="flex h-full min-w-max gap-3 p-4">
          {SYMPHONY_COLUMNS.map(column => {
            const visible = projectFilter.length === 0
              ? (tiles ?? [])
              : (tiles ?? []).filter(tile => tile.craftProjectId !== null && projectFilter.includes(tile.craftProjectId))
            const columnTiles = visible.filter(tile => columnFor(tile.state, tile.issueClosed).id === column.id)
            const isBacklog = column.id === 'backlog'
            const visibleBacklog = isBacklog
              ? (projectFilter.length === 0
                  ? backlog
                  : backlog.filter(item => item.craftProjectId !== null && projectFilter.includes(item.craftProjectId)))
              : []
            const isTerminal = column.id === 'done' || column.id === 'attention'
            const itemCount = isBacklog ? visibleBacklog.length : columnTiles.length
            // Backlog is reference, not work in flight: collapsed unless asked for.
            const collapsedByDefault = isTerminal || isBacklog || itemCount === 0
            const collapsed = toggledColumns.has(column.id) ? !collapsedByDefault : collapsedByDefault
            const toggle = () => setToggledColumns(prev => {
              const next = new Set(prev)
              if (next.has(column.id)) next.delete(column.id)
              else next.add(column.id)
              return next
            })
            if (collapsed) {
              return (
                <button
                  key={column.id}
                  type="button"
                  onClick={toggle}
                  className="flex w-10 shrink-0 snap-start flex-col items-center gap-2 rounded-xl bg-foreground/[0.02] py-3 transition-colors hover:bg-foreground/[0.05]"
                  title={t(column.labelKey)}
                >
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: column.accent }} />
                  <span className="text-[11px] font-semibold text-foreground/60 [writing-mode:vertical-rl]">
                    {t(column.labelKey)}
                  </span>
                  <span className="text-[11px] font-semibold text-foreground/40">{itemCount}</span>
                </button>
              )
            }
            return (
              <div key={column.id} className="flex w-64 shrink-0 snap-start flex-col rounded-xl bg-foreground/[0.02] p-2">
                <div className="flex items-center gap-2 px-1 pb-2">
                  <span className="h-2 w-2 rounded-full" style={{ backgroundColor: column.accent }} />
                  <span className="text-[12px] font-semibold text-foreground/80">{t(column.labelKey)}</span>
                  <span className="ml-auto text-[11px] text-foreground/40">{itemCount}</span>
                  <button
                    type="button"
                    onClick={toggle}
                    className="text-[10.5px] text-foreground/40 hover:text-foreground/70"
                  >
                    {t('kanban.symphony.collapse')}
                  </button>
                </div>
                <div className="flex min-h-0 flex-col gap-2 overflow-y-auto">
                  {isBacklog
                    ? visibleBacklog.map(item => (
                      <button
                        key={`${item.projectId}-${item.issueIdentifier}`}
                        type="button"
                        onClick={() => item.url && window.electronAPI.openUrl(item.url)}
                        className="flex flex-col gap-1 rounded-lg bg-background/60 p-2 text-left transition-colors hover:bg-background"
                        title={item.issueIdentifier}
                      >
                        <span className="text-[11px] font-semibold text-foreground/50">{item.issueIdentifier}</span>
                        <span className="line-clamp-2 text-[12px] text-foreground/80">{item.title}</span>
                        {item.labels.length > 0 && (
                          <span className="truncate text-[10.5px] text-foreground/40">{item.labels.join(' · ')}</span>
                        )}
                      </button>
                    ))
                    : columnTiles.map(tile => (
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
