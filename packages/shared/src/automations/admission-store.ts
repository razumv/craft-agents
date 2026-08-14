import { link, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { uptime } from 'node:os'

/** Durable lifecycle states for one automation side effect. */
export type AutomationAdmissionState = 'prepared' | 'delivering' | 'committed' | 'completed' | 'blocked'

/** Consumption state of an admitted existing-session message. */
export type AutomationAdmissionDeliveryState = 'delivered' | 'pending-consumption' | 'consumed' | 'blocked'

/**
 * The complete idempotency scope. `occurrenceId` identifies one event
 * occurrence; `idempotencyKey` lets callers distinguish independently
 * idempotent effects produced by that occurrence.
 */
export interface AutomationAdmissionScope {
  workspaceId: string
  matcherId: string
  actionId: string
  occurrenceId: string
  idempotencyKey: string
}

interface AutomationAdmissionRecoveryClaim {
  token: string
  ownerToken: string
  processingGeneration: number
  claimedAt: number
}

export interface AutomationAdmissionReceipt {
  messageId?: string
  sessionId?: string
  targetKind?: 'controller' | 'coordinator'
  targetId?: string
  targetGeneration?: string
  deliveredAt?: number
  deliveryState?: AutomationAdmissionDeliveryState
  acceptedProcessingGeneration?: number
  contentRevision?: string
  completedContentRevision?: string
  recoveryClaim?: AutomationAdmissionRecoveryClaim
  recoveryAttemptedAt?: number
  recoveryProcessingGeneration?: number
  consumedAt?: number
  completedProcessingGeneration?: number
  completedMessageId?: string
  completedMessageAt?: number
  [key: string]: unknown
}

export type AutomationAdmissionRecoveryClaimResult =
  | { status: 'claimed'; record: AutomationAdmissionRecord; token: string }
  | { status: 'busy'; record: AutomationAdmissionRecord }
  | { status: 'duplicate'; record: AutomationAdmissionRecord }
  | { status: 'blocked'; record: AutomationAdmissionRecord; reason: string }

export interface AutomationAdmissionRecord extends AutomationAdmissionScope {
  key: string
  state: AutomationAdmissionState
  createdAt: number
  updatedAt: number
  receipt?: AutomationAdmissionReceipt
  blockedReason?: string
}

export type AutomationAdmissionClaimResult =
  | { status: 'claimed'; record: AutomationAdmissionRecord; recovered: boolean }
  | { status: 'duplicate'; record: AutomationAdmissionRecord; receipt?: AutomationAdmissionReceipt }
  | { status: 'busy'; record: AutomationAdmissionRecord }
  | { status: 'blocked'; record: AutomationAdmissionRecord; reason: string }

interface AdmissionFile {
  version: 1
  entries: Record<string, AutomationAdmissionRecord>
}

interface AdmissionLockOwner {
  pid: number
  /** Random process-lifetime token; prevents a stale holder from releasing a newer lock. */
  token: string
  createdAt: number
}

const PROCESS_LOCK_TOKEN = `${process.pid}:${Date.now()}:${Math.random().toString(16).slice(2)}`
const CURRENT_BOOT_TIME = Date.now() - uptime() * 1000

export interface AutomationAdmissionStoreOptions {
  /** Maximum retained terminal records. Retention always runs while holding the file lock. */
  maxEntries?: number
  /** Age limit for terminal records. In-flight records are never discarded. */
  retentionMs?: number
  /** Maximum time to wait for a competing process to release the lock. */
  lockTimeoutMs?: number
}

const DEFAULT_MAX_ENTRIES = 10_000
const DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60 * 1000
const DEFAULT_LOCK_TIMEOUT_MS = 5_000
const LOCK_RETRY_MS = 15

async function fsyncContainingDirectory(filePath: string): Promise<void> {
  if (process.platform === 'win32') return
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(dirname(filePath), 'r')
    await handle.sync()
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code !== 'EINVAL' && code !== 'ENOTSUP' && code !== 'EBADF' && code !== 'EISDIR') throw error
  } finally {
    await handle?.close().catch(() => {})
  }
}

/**
 * A small JSON-backed, cross-process admission ledger. All read-modify-write
 * operations acquire a sibling lock file and replace the JSON file atomically.
 * It deliberately contains no Craft-, transport-, or product-specific policy.
 */
export class AutomationAdmissionStore {
  private readonly filePath: string
  private readonly lockPath: string
  private readonly maxEntries: number
  private readonly retentionMs: number
  private readonly lockTimeoutMs: number

  constructor(workspaceRootPath: string, options: AutomationAdmissionStoreOptions = {}) {
    this.filePath = join(workspaceRootPath, 'automations-admissions.json')
    this.lockPath = `${this.filePath}.lock`
    this.maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES
    this.retentionMs = options.retentionMs ?? DEFAULT_RETENTION_MS
    this.lockTimeoutMs = options.lockTimeoutMs ?? DEFAULT_LOCK_TIMEOUT_MS
  }

  static keyFor(scope: AutomationAdmissionScope): string {
    // JSON encoding is unambiguous, preserves every requested scope component,
    // and avoids delimiter escaping ambiguity in user-supplied identifiers.
    return JSON.stringify([scope.workspaceId, scope.matcherId, scope.actionId, scope.occurrenceId, scope.idempotencyKey])
  }

  async claim(scope: AutomationAdmissionScope): Promise<AutomationAdmissionClaimResult> {
    this.assertScope(scope)
    return this.withLockedFile((file, now) => {
      const key = AutomationAdmissionStore.keyFor(scope)
      const existing = file.entries[key]
      if (!existing) {
        const record: AutomationAdmissionRecord = { ...scope, key, state: 'prepared', createdAt: now, updatedAt: now }
        file.entries[key] = record
        return { status: 'claimed', record, recovered: false }
      }

      if (existing.state === 'prepared') {
        // A previous process claimed but never began the side effect. It is safe
        // to retry after restart because no delivery was admitted yet.
        existing.updatedAt = now
        return { status: 'claimed', record: existing, recovered: true }
      }
      if (existing.state === 'delivering') return { status: 'busy', record: existing }
      if (existing.state === 'blocked') {
        return { status: 'blocked', record: existing, reason: existing.blockedReason ?? 'Delivery is blocked' }
      }
      return { status: 'duplicate', record: existing, receipt: existing.receipt }
    })
  }

  async beginDelivery(scope: AutomationAdmissionScope): Promise<AutomationAdmissionClaimResult> {
    return this.transition(scope, (record, now) => {
      if (record.state === 'prepared') {
        record.state = 'delivering'
        record.updatedAt = now
        return { status: 'claimed', record, recovered: false }
      }
      if (record.state === 'delivering') return { status: 'busy', record }
      if (record.state === 'blocked') return { status: 'blocked', record, reason: record.blockedReason ?? 'Delivery is blocked' }
      return { status: 'duplicate', record, receipt: record.receipt }
    })
  }

  async commit(scope: AutomationAdmissionScope, receipt: AutomationAdmissionReceipt): Promise<AutomationAdmissionRecord> {
    return this.mutateExisting(scope, (record, now) => {
      if (record.state === 'blocked') throw new Error('Cannot commit a blocked automation admission')
      record.state = 'committed'
      record.receipt = { ...receipt }
      record.updatedAt = now
      return record
    })
  }

  /** Merge durable delivery observations without changing the admission lifecycle. */
  async updateReceipt(scope: AutomationAdmissionScope, patch: AutomationAdmissionReceipt): Promise<AutomationAdmissionRecord> {
    return this.mutateExisting(scope, (record, now) => {
      if (record.state === 'blocked') return record
      record.receipt = { ...record.receipt, ...patch }
      record.updatedAt = now
      return record
    })
  }

  /**
   * Atomically reserve the one permitted stuck-turn recovery attempt. The
   * SessionManager performs the remaining runtime/session CAS checks before
   * calling this method; this ledger CAS prevents concurrent RPC callers from
   * both destroying/replaying the same generation.
   */
  async beginRecovery(
    scope: AutomationAdmissionScope,
    messageId: string,
    processingGeneration: number,
    contentRevision: string,
  ): Promise<AutomationAdmissionRecoveryClaimResult> {
    return this.mutateExisting(scope, (record, now) => {
      if (record.state === 'blocked') {
        return { status: 'blocked', record, reason: record.blockedReason ?? 'Delivery is blocked' }
      }
      if (record.receipt?.messageId !== messageId) {
        return { status: 'blocked', record, reason: 'Outstanding admission message does not match' }
      }
      if (record.receipt?.contentRevision !== contentRevision) {
        return { status: 'blocked', record, reason: 'Outstanding admission content revision does not match' }
      }
      if (record.receipt?.deliveryState === 'consumed') return { status: 'duplicate', record }
      if (record.receipt?.recoveryClaim) return { status: 'busy', record }
      if (record.receipt?.recoveryAttemptedAt !== undefined) return { status: 'duplicate', record }
      const token = `${PROCESS_LOCK_TOKEN}:${now}:${Math.random().toString(16).slice(2)}`
      record.receipt = {
        ...record.receipt,
        recoveryClaim: {
          token,
          ownerToken: PROCESS_LOCK_TOKEN,
          processingGeneration,
          claimedAt: now,
        },
      }
      record.updatedAt = now
      return { status: 'claimed', record, token }
    })
  }

  /** Commit the single attempt only after the session checkpoint is durable. */
  async commitRecovery(scope: AutomationAdmissionScope, token: string): Promise<AutomationAdmissionRecord> {
    return this.mutateExisting(scope, (record, now) => {
      const claim = record.receipt?.recoveryClaim
      if (!claim || claim.token !== token) throw new Error('Automation recovery claim token does not match')
      record.receipt = {
        ...record.receipt,
        // Retain the claim while the winning caller tears down and publishes
        // its final checkpoint. Concurrent callers stay retryable busy.
        recoveryAttemptedAt: now,
        recoveryProcessingGeneration: claim.processingGeneration,
      }
      record.updatedAt = now
      return record
    })
  }

  /** Release the winner claim after all recovery checkpoints are durable. */
  async finishRecovery(scope: AutomationAdmissionScope, token: string): Promise<AutomationAdmissionRecord> {
    return this.mutateExisting(scope, (record, now) => {
      if (record.receipt?.recoveryClaim?.token !== token) throw new Error('Automation recovery claim token does not match')
      record.receipt = { ...record.receipt, recoveryClaim: undefined }
      record.updatedAt = now
      return record
    })
  }

  /** Release a pre-side-effect claim without blocking another recovery winner. */
  async releaseRecovery(scope: AutomationAdmissionScope, token: string): Promise<AutomationAdmissionRecord> {
    return this.mutateExisting(scope, (record, now) => {
      if (record.receipt?.recoveryClaim?.token === token) {
        record.receipt = { ...record.receipt, recoveryClaim: undefined }
        record.updatedAt = now
      }
      return record
    })
  }

  /** Record server-proven consumption by a newer completed assistant turn. */
  async consume(
    scope: AutomationAdmissionScope,
    completion: {
      messageId: string
      processingGeneration: number
      completedMessageId: string
      completedMessageAt: number
      contentRevision: string
    },
  ): Promise<AutomationAdmissionRecord> {
    return this.mutateExisting(scope, (record, now) => {
      if (record.state === 'blocked'
        || record.receipt?.messageId !== completion.messageId
        || record.receipt?.contentRevision !== completion.contentRevision) return record
      record.state = 'completed'
      record.receipt = {
        ...record.receipt,
        deliveryState: 'consumed',
        consumedAt: now,
        completedProcessingGeneration: completion.processingGeneration,
        completedMessageId: completion.completedMessageId,
        completedMessageAt: completion.completedMessageAt,
        completedContentRevision: completion.contentRevision,
      }
      record.updatedAt = now
      return record
    })
  }

  async complete(scope: AutomationAdmissionScope): Promise<AutomationAdmissionRecord> {
    return this.mutateExisting(scope, (record, now) => {
      // Completion is intentionally monotonic. A committed acknowledgement must
      // never be made replayable merely because completion bookkeeping retries.
      if (record.state === 'committed' || record.state === 'completed') {
        record.state = 'completed'
        record.updatedAt = now
      }
      return record
    })
  }

  async block(scope: AutomationAdmissionScope, reason: string): Promise<AutomationAdmissionRecord> {
    return this.mutateExisting(scope, (record, now) => {
      if (record.receipt?.deliveryState === 'consumed') return record
      record.state = 'blocked'
      record.receipt = record.receipt ? { ...record.receipt, deliveryState: 'blocked', recoveryClaim: undefined } : record.receipt
      record.blockedReason = reason
      record.updatedAt = now
      return record
    })
  }

  /** Return a pre-ack delivery to prepared so a transient failure can retry. */
  async prepareRetry(scope: AutomationAdmissionScope): Promise<AutomationAdmissionRecord> {
    return this.mutateExisting(scope, (record, now) => {
      if (record.state === 'delivering') {
        record.state = 'prepared'
        record.updatedAt = now
      }
      return record
    })
  }

  /** Read one entry without mutating it. */
  async get(scope: AutomationAdmissionScope): Promise<AutomationAdmissionRecord | undefined> {
    this.assertScope(scope)
    return this.withLockedFile((file) => file.entries[AutomationAdmissionStore.keyFor(scope)])
  }

  /**
   * Mark the unique receipt for a deterministic message ID consumed. Message
   * IDs are derived from the full admission key, so more than one match means
   * ledger corruption and is deliberately rejected.
   */
  async consumeByMessageId(
    messageId: string,
    completion: {
      processingGeneration: number
      completedMessageId: string
      completedMessageAt: number
      contentRevision: string
    },
  ): Promise<AutomationAdmissionRecord | undefined> {
    return this.withLockedFile((file, now) => {
      const matches = Object.values(file.entries).filter((record) => record.receipt?.messageId === messageId)
      if (matches.length === 0) return undefined
      if (matches.length !== 1) throw new Error(`Automation admission message ID is not unique: ${messageId}`)
      const record = matches[0]!
      if (record.state === 'blocked' || record.receipt?.contentRevision !== completion.contentRevision) return record
      record.state = 'completed'
      record.receipt = {
        ...record.receipt,
        deliveryState: 'consumed',
        consumedAt: now,
        completedProcessingGeneration: completion.processingGeneration,
        completedMessageId: completion.completedMessageId,
        completedMessageAt: completion.completedMessageAt,
        completedContentRevision: completion.contentRevision,
      }
      record.updatedAt = now
      return record
    })
  }

  /**
   * Restart reconciliation makes interrupted pre-ack deliveries retryable.
   * Committed and completed admissions intentionally remain untouched.
   */
  async reconcile(): Promise<{ prepared: number; committed: number; completed: number; blocked: number }> {
    return this.withLockedFile((file, now) => {
      const counts = { prepared: 0, committed: 0, completed: 0, blocked: 0 }
      for (const record of Object.values(file.entries)) {
        // A recovery claim from another process incarnation cannot still own
        // local session side effects. Release it without consuming the attempt;
        // the durable session checkpoint decides whether replay is already safe.
        if (record.receipt?.recoveryClaim?.ownerToken !== PROCESS_LOCK_TOKEN) {
          record.receipt = { ...record.receipt, recoveryClaim: undefined }
          record.updatedAt = now
        }
        if (record.state === 'delivering') {
          record.state = 'prepared'
          record.updatedAt = now
        }
        if (record.state === 'prepared') counts.prepared++
        else if (record.state === 'committed') counts.committed++
        else if (record.state === 'completed') counts.completed++
        else counts.blocked++
      }
      return counts
    })
  }

  private async transition(
    scope: AutomationAdmissionScope,
    mutate: (record: AutomationAdmissionRecord, now: number) => AutomationAdmissionClaimResult,
  ): Promise<AutomationAdmissionClaimResult> {
    this.assertScope(scope)
    return this.withLockedFile((file, now) => {
      const record = file.entries[AutomationAdmissionStore.keyFor(scope)]
      if (!record) throw new Error('Automation admission must be claimed before delivery')
      return mutate(record, now)
    })
  }

  private async mutateExisting<T>(
    scope: AutomationAdmissionScope,
    mutate: (record: AutomationAdmissionRecord, now: number) => T,
  ): Promise<T> {
    this.assertScope(scope)
    return this.withLockedFile((file, now) => {
      const record = file.entries[AutomationAdmissionStore.keyFor(scope)]
      if (!record) throw new Error('Automation admission does not exist')
      return mutate(record, now)
    })
  }

  private async withLockedFile<T>(fn: (file: AdmissionFile, now: number) => T | Promise<T>): Promise<T> {
    const release = await this.acquireLock()
    try {
      const file = await this.readFile()
      const result = await fn(file, Date.now())
      this.compact(file, Date.now())
      await this.writeFile(file)
      return result
    } finally {
      await release()
    }
  }

  private async acquireLock(): Promise<() => Promise<void>> {
    await mkdir(dirname(this.filePath), { recursive: true })
    const deadline = Date.now() + this.lockTimeoutMs
    const owner: AdmissionLockOwner = { pid: process.pid, token: PROCESS_LOCK_TOKEN, createdAt: Date.now() }
    const candidatePath = `${this.lockPath}.${process.pid}.${Math.random().toString(16).slice(2)}.candidate`

    // Publish only fully written ownership. `open(lock, 'wx')` followed by a
    // write has a fatal crash window: an empty lock is visible and can never be
    // proven stale. A same-filesystem hard link is an exclusive, atomic publish
    // (EEXIST means another owner won); a crash before link leaves no lock.
    const candidate = await open(candidatePath, 'wx', 0o600)
    try {
      await candidate.writeFile(JSON.stringify(owner))
      await candidate.sync()
    } finally {
      await candidate.close()
    }

    try {
      for (;;) {
        try {
          await link(candidatePath, this.lockPath)
          await rm(candidatePath, { force: true }).catch(() => {})
          return async () => {
            // Never unlink a lock acquired by a later process if this process
            // was delayed after its own lock was externally recovered.
            const raw = await readFile(this.lockPath, 'utf8').catch(() => '')
            try {
              const current = JSON.parse(raw) as AdmissionLockOwner
              if (current.token !== owner.token) return
            } catch {
              return
            }
            await rm(this.lockPath, { force: true })
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error
          // Only recover ownership that is provably stale. Ambiguous live
          // ownership stays fail-closed rather than allowing two writers.
          await this.recoverDeadLock()
          if (Date.now() >= deadline) throw new Error(`Timed out acquiring automation admission lock: ${basename(this.lockPath)}`)
          await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS))
        }
      }
    } catch (error) {
      await rm(candidatePath, { force: true }).catch(() => {})
      throw error
    }
  }

  private async recoverDeadLock(): Promise<void> {
    let owner: AdmissionLockOwner
    try {
      owner = JSON.parse(await readFile(this.lockPath, 'utf8')) as AdmissionLockOwner
    } catch {
      // An unreadable lock might belong to a live process. It is ambiguous and
      // therefore deliberately left in place rather than risking two writers.
      return
    }
    if (!Number.isInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== 'string' || typeof owner.createdAt !== 'number') return

    let stale = owner.pid === process.pid && owner.token !== PROCESS_LOCK_TOKEN
    // A lock from a prior boot cannot belong to a current PID, even when the OS
    // has already recycled that numeric PID.
    stale ||= owner.createdAt < CURRENT_BOOT_TIME
    if (!stale) {
      try {
        process.kill(owner.pid, 0)
        return // PID exists (including EPERM): live/ambiguous, never remove it.
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return
        stale = true
      }
    }
    if (!stale) return

    // The owner process incarnation is provably gone. Re-read its identity before unlinking so
    // a newly acquired lock is not released by a stale waiter.
    const confirmation = await readFile(this.lockPath, 'utf8').catch(() => '')
    if (confirmation !== JSON.stringify(owner)) return
    await rm(this.lockPath, { force: true }).catch(() => {})
  }

  private async readFile(): Promise<AdmissionFile> {
    try {
      const parsed = JSON.parse(await readFile(this.filePath, 'utf8')) as AdmissionFile
      if (parsed?.version === 1 && parsed.entries && typeof parsed.entries === 'object') return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    return { version: 1, entries: {} }
  }

  private async writeFile(file: AdmissionFile): Promise<void> {
    const temporary = `${this.filePath}.${process.pid}.${Math.random().toString(16).slice(2)}.tmp`
    const handle = await open(temporary, 'wx', 0o600)
    try {
      await handle.writeFile(`${JSON.stringify(file)}\n`, 'utf8')
      await handle.sync()
    } finally {
      await handle.close()
    }
    await rename(temporary, this.filePath)
    await fsyncContainingDirectory(this.filePath)
  }

  private compact(file: AdmissionFile, now: number): void {
    const terminal = Object.values(file.entries)
      .filter((entry) => entry.state === 'committed' || entry.state === 'completed' || entry.state === 'blocked')
      .sort((a, b) => a.updatedAt - b.updatedAt)

    for (const entry of terminal) {
      if (now - entry.updatedAt > this.retentionMs) delete file.entries[entry.key]
    }

    const retainedTerminal = Object.values(file.entries)
      .filter((entry) => entry.state === 'committed' || entry.state === 'completed' || entry.state === 'blocked')
      .sort((a, b) => a.updatedAt - b.updatedAt)
    while (retainedTerminal.length > this.maxEntries) {
      const oldest = retainedTerminal.shift()
      if (oldest) delete file.entries[oldest.key]
    }
  }

  private assertScope(scope: AutomationAdmissionScope): void {
    for (const [name, value] of Object.entries(scope)) {
      if (typeof value !== 'string' || value.trim().length === 0) throw new Error(`Automation admission ${name} must be a non-empty string`)
    }
  }
}
