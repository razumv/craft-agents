import { isAbsolute, resolve } from 'node:path'
import { readFile } from 'node:fs/promises'
import type {
  SymphonyOperationResult,
  SymphonyProjectServiceStatus,
  SymphonyServiceControl,
  SymphonyServiceStatus,
  SymphonyStopResult,
} from '@craft-agent/core/types'
import {
  createLiveRunner,
  loadLiveRunnerConfig,
  type LiveRunnerConfig,
  type LiveRunnerStatus,
} from '@craft-agent/symphony'

export interface SymphonyProjectConfig {
  id: string
  /** Absolute path to one native LiveRunnerConfig JSON file. */
  configPath: string
}

export interface SymphonyLoopConfig {
  /** The loop never starts unless this is explicitly true. */
  enabled: boolean
  /**
   * What each cycle runs per project. `shadow` is read-only (zero-write receipts)
   * and proves the loop machinery without mutating anything; `tick` is the live
   * scheduler step and additionally requires the top-level `enabled: true`.
   */
  mode: 'shadow' | 'tick'
  intervalMs: number
  /** After this many consecutive failed cycles a project is dropped from the loop. */
  maxConsecutiveErrors: number
}

export interface SymphonyServerConfig {
  version: 1
  /** Live scheduler mutation is impossible unless this is explicitly true. */
  enabled: boolean
  stopTimeoutMs: number
  projects: SymphonyProjectConfig[]
  /** Optional autonomous polling loop. Absent → manual operations only. */
  loop?: SymphonyLoopConfig
}

export interface SymphonyRunnerLike {
  preflight(): Promise<unknown>
  createContractIssue?(input: unknown): Promise<unknown>
  readStatus(): Promise<LiveRunnerStatus | unknown>
  projectDesk(): Promise<unknown>
  shadow(): Promise<unknown>
  tick(): Promise<LiveRunnerStatus | unknown>
}

export type SymphonyRunnerFactory = (config: LiveRunnerConfig) => Promise<SymphonyRunnerLike>

interface ProjectRuntime {
  config: SymphonyProjectConfig
  runner: SymphonyRunnerLike | null
  status: SymphonyProjectServiceStatus
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isInteger(value) || (value as number) < 1) throw new Error(`${field} must be a positive integer`)
  return value as number
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${field} must be a non-empty string`)
  return value.trim()
}

export function parseSymphonyServerConfig(value: unknown): SymphonyServerConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Symphony server config must be an object')
  }
  const raw = value as Record<string, unknown>
  if (raw.version !== 1) throw new Error('Symphony server config version must be 1')
  if (typeof raw.enabled !== 'boolean') throw new Error('Symphony server config enabled must be explicit boolean')
  if (!Array.isArray(raw.projects)) throw new Error('Symphony server config projects must be an array')

  const ids = new Set<string>()
  const projects = raw.projects.map((entry, index): SymphonyProjectConfig => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`Symphony project ${index} must be an object`)
    }
    const project = entry as Record<string, unknown>
    const id = requiredString(project.id, `projects[${index}].id`)
    const configPath = requiredString(project.configPath, `projects[${index}].configPath`)
    if (!isAbsolute(configPath)) throw new Error(`projects[${index}].configPath must be absolute`)
    if (ids.has(id)) throw new Error(`duplicate Symphony project id: ${id}`)
    ids.add(id)
    return { id, configPath: resolve(configPath) }
  })

  let loop: SymphonyLoopConfig | undefined
  if (raw.loop !== undefined) {
    if (!raw.loop || typeof raw.loop !== 'object' || Array.isArray(raw.loop)) {
      throw new Error('Symphony server config loop must be an object')
    }
    const rawLoop = raw.loop as Record<string, unknown>
    if (typeof rawLoop.enabled !== 'boolean') throw new Error('Symphony loop enabled must be explicit boolean')
    if (rawLoop.mode !== 'shadow' && rawLoop.mode !== 'tick') throw new Error('Symphony loop mode must be shadow or tick')
    if (rawLoop.mode === 'tick' && raw.enabled !== true) {
      throw new Error('Symphony loop mode tick requires enabled=true in the explicit server config')
    }
    loop = {
      enabled: rawLoop.enabled,
      mode: rawLoop.mode,
      intervalMs: positiveInteger(rawLoop.intervalMs, 'Symphony loop intervalMs'),
      maxConsecutiveErrors: positiveInteger(rawLoop.maxConsecutiveErrors, 'Symphony loop maxConsecutiveErrors'),
    }
  }

  return {
    version: 1,
    enabled: raw.enabled,
    stopTimeoutMs: positiveInteger(raw.stopTimeoutMs, 'Symphony server config stopTimeoutMs'),
    projects,
    ...(loop ? { loop } : {}),
  }
}

export async function loadSymphonyServerConfig(path: string): Promise<SymphonyServerConfig> {
  if (!isAbsolute(path)) throw new Error('CRAFT_SYMPHONY_CONFIG must be an absolute path')
  return parseSymphonyServerConfig(JSON.parse(await readFile(path, 'utf8')))
}

export class NativeSymphonyService implements SymphonyServiceControl {
  readonly #projects = new Map<string, ProjectRuntime>()
  readonly #active = new Set<Promise<unknown>>()
  #phase: SymphonyServiceStatus['phase']
  #accepting = false
  #startPromise: Promise<SymphonyServiceStatus> | null = null
  #loopTimer: ReturnType<typeof setTimeout> | null = null
  #loopCycles = 0
  #loopLastCycleAt: number | null = null
  #loopCycleActive = false
  readonly #loopErrors = new Map<string, number>()
  readonly #loopDropped = new Set<string>()
  readonly #listeners = new Set<(projectId: string, operation: SymphonyOperationResult['operation']) => void>()

  constructor(
    readonly config: SymphonyServerConfig,
    readonly configPath: string | null,
    readonly runnerFactory: SymphonyRunnerFactory = createLiveRunner,
  ) {
    this.#phase = config.projects.length === 0 ? 'disabled' : 'reconstructing'
    const now = Date.now()
    for (const project of config.projects) {
      this.#projects.set(project.id, {
        config: project,
        runner: null,
        status: {
          projectId: project.id,
          phase: 'configured',
          lastOperation: null,
          reconstructedAt: null,
          updatedAt: now,
          lastError: null,
          snapshot: null,
          ownerSessionId: null,
          craftProjectId: null,
        },
      })
    }
  }

  start(): Promise<SymphonyServiceStatus> {
    if (this.#startPromise) return this.#startPromise
    this.#startPromise = this.#reconstruct()
    return this.#startPromise
  }

  async #reconstruct(): Promise<SymphonyServiceStatus> {
    if (this.config.projects.length === 0) {
      this.#phase = 'disabled'
      this.#accepting = false
      return this.status()
    }

    this.#phase = 'reconstructing'
    for (const runtime of this.#projects.values()) {
      try {
        const runnerConfig = await loadLiveRunnerConfig(runtime.config.configPath)
        runtime.runner = await this.runnerFactory(runnerConfig)
        const snapshot = await runtime.runner.readStatus()
        const now = Date.now()
        runtime.status = {
          ...runtime.status,
          phase: 'ready',
          lastOperation: 'reconstruct',
          reconstructedAt: now,
          updatedAt: now,
          lastError: null,
          snapshot,
          ownerSessionId: runnerConfig.craft?.ownerSessionId ?? null,
          craftProjectId: runnerConfig.craft?.projectId ?? null,
        }
      } catch (error) {
        runtime.status = {
          ...runtime.status,
          phase: 'error',
          lastOperation: 'reconstruct',
          updatedAt: Date.now(),
          lastError: error instanceof Error ? error.message : String(error),
        }
        this.#phase = 'error'
        this.#accepting = false
        if (this.config.enabled) throw error
      }
    }

    if (this.#phase !== 'error') this.#phase = 'ready'
    this.#accepting = this.#phase === 'ready'
    if (this.#accepting && this.config.loop?.enabled) this.#scheduleLoop()
    return this.status()
  }

  /**
   * Autonomous polling loop. One timer chain (never overlapping cycles):
   * each cycle serially runs the configured operation for every project that
   * is reconstructed, idle, and under its consecutive-error budget. A project
   * that fails maxConsecutiveErrors cycles in a row is dropped from the loop
   * (its lastError stays visible in status); manual operations stay available.
   */
  #scheduleLoop(): void {
    const loop = this.config.loop
    if (!loop?.enabled || !this.#accepting) return
    this.#loopTimer = setTimeout(() => {
      void this.#runLoopCycle()
    }, loop.intervalMs)
    // Never hold the process open just for the loop.
    this.#loopTimer.unref?.()
  }

  async #runLoopCycle(): Promise<void> {
    const loop = this.config.loop
    if (!loop?.enabled || !this.#accepting || this.#loopCycleActive) return
    this.#loopCycleActive = true
    try {
      for (const runtime of this.#projects.values()) {
        if (!this.#accepting) break
        const projectId = runtime.config.id
        if (this.#loopDropped.has(projectId)) continue
        if (!runtime.runner || runtime.status.phase === 'running') continue
        try {
          if (loop.mode === 'tick') await this.tick(projectId)
          else await this.shadow(projectId)
          // Keep the board snapshot fresh: shadow/tick receipts no longer touch
          // it (see #operate), so every cycle ends with a read-only full-status
          // re-read — new GitHub issues appear without a manual refresh, and
          // the symphony:changed push fires for live boards.
          await this.refresh(projectId)
          this.#loopErrors.delete(projectId)
        } catch {
          const errors = (this.#loopErrors.get(projectId) ?? 0) + 1
          this.#loopErrors.set(projectId, errors)
          if (errors >= loop.maxConsecutiveErrors) this.#loopDropped.add(projectId)
        }
      }
      this.#loopCycles += 1
      this.#loopLastCycleAt = Date.now()
    } finally {
      this.#loopCycleActive = false
      this.#scheduleLoop()
    }
  }

  validate(projectId: string): Promise<SymphonyOperationResult> {
    return this.#operate(projectId, 'validate', async (runner) => runner.preflight())
  }

  shadow(projectId: string): Promise<SymphonyOperationResult> {
    return this.#operate(projectId, 'shadow', async (runner) => {
      // Validate every external binding, but keep the verbose internal preflight
      // record out of the compact public shadow receipt.
      await runner.preflight()
      return runner.shadow()
    })
  }

  projectDesk(projectId: string): Promise<SymphonyOperationResult> {
    return this.#operate(projectId, 'desk', async (runner) => runner.projectDesk())
  }

  /** Read-only full-status re-read; the cached snapshot the UI renders is replaced. */
  refresh(projectId: string): Promise<SymphonyOperationResult> {
    return this.#operate(projectId, 'refresh', async (runner) => runner.readStatus())
  }

  /** Owner work intake: create a contract issue, then re-read status so the board updates. */
  createIssue(projectId: string, input: unknown): Promise<SymphonyOperationResult> {
    return this.#operate(projectId, 'create-issue', async (runner) => {
      if (!runner.createContractIssue) throw new Error('this Symphony runner does not support issue intake')
      const created = await runner.createContractIssue(input)
      const status = await runner.readStatus()
      return { created, ...(status as Record<string, unknown>) }
    })
  }

  subscribe(listener: (projectId: string, operation: SymphonyOperationResult['operation']) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  #notify(projectId: string, operation: SymphonyOperationResult['operation']): void {
    for (const listener of this.#listeners) {
      try { listener(projectId, operation) } catch { /* listeners must not break operations */ }
    }
  }

  async tick(projectId: string): Promise<SymphonyOperationResult> {
    if (!this.config.enabled) {
      throw new Error('Symphony live tick is disabled; set enabled=true in the explicit server config')
    }
    return this.#operate(projectId, 'tick', async (runner) => runner.tick())
  }

  async #operate(
    projectId: string,
    operation: SymphonyOperationResult['operation'],
    action: (runner: SymphonyRunnerLike) => Promise<unknown>,
  ): Promise<SymphonyOperationResult> {
    if (!this.#accepting) throw new Error(`Symphony service is not accepting operations (${this.#phase})`)
    const runtime = this.#projects.get(projectId)
    if (!runtime?.runner) throw new Error(`Unknown or unreconstructed Symphony project: ${projectId}`)
    if (runtime.status.phase === 'running') throw new Error(`Symphony project already has an active operation: ${projectId}`)

    runtime.status = {
      ...runtime.status,
      phase: 'running',
      lastOperation: operation,
      updatedAt: Date.now(),
      lastError: null,
    }

    const task = (async () => {
      try {
        const result = await action(runtime.runner!)
        const completedAt = Date.now()
        // The cached snapshot is what UI surfaces (the board) render between
        // operations, so it must ALWAYS be a full LiveRunnerStatus. Ops whose
        // result is a different shape (shadow receipt, desk readback,
        // validate report, issue intake) must not clobber it — a loop shadow
        // cycle used to wipe the board until a manual refresh.
        const updatesSnapshot = operation === 'tick' || operation === 'refresh'
        runtime.status = {
          ...runtime.status,
          phase: 'ready',
          updatedAt: completedAt,
          lastError: null,
          ...(updatesSnapshot ? { snapshot: result } : {}),
        }
        this.#notify(projectId, operation)
        return { projectId, operation, completedAt, result }
      } catch (error) {
        runtime.status = {
          ...runtime.status,
          phase: 'error',
          updatedAt: Date.now(),
          lastError: error instanceof Error ? error.message : String(error),
        }
        throw error
      }
    })()

    this.#active.add(task)
    task.finally(() => {
      this.#active.delete(task)
      if (this.#phase === 'stopping' && this.#active.size === 0) this.#phase = 'stopped'
    }).catch(() => {})
    return task
  }

  status(): SymphonyServiceStatus {
    return {
      phase: this.#phase,
      enabled: this.config.enabled,
      acceptingOperations: this.#accepting,
      configPath: this.configPath,
      stopTimeoutMs: this.config.stopTimeoutMs,
      activeOperations: this.#active.size,
      projects: [...this.#projects.values()].map(({ status }) => ({ ...status })),
      loop: this.config.loop
        ? {
            enabled: this.config.loop.enabled,
            mode: this.config.loop.mode,
            intervalMs: this.config.loop.intervalMs,
            cycles: this.#loopCycles,
            lastCycleAt: this.#loopLastCycleAt,
            droppedProjects: [...this.#loopDropped],
          }
        : null,
    }
  }

  async stop(timeoutMs = this.config.stopTimeoutMs): Promise<SymphonyStopResult> {
    positiveInteger(timeoutMs, 'Symphony stop timeout')
    this.#accepting = false
    if (this.#loopTimer) {
      clearTimeout(this.#loopTimer)
      this.#loopTimer = null
    }
    if (this.#phase === 'disabled' || this.#phase === 'stopped') {
      this.#phase = this.#phase === 'disabled' ? 'disabled' : 'stopped'
      return { drained: true, timeoutMs, activeOperations: this.#active.size, phase: 'stopped' }
    }

    this.#phase = 'stopping'
    const active = [...this.#active]
    if (active.length > 0) {
      await Promise.race([
        Promise.allSettled(active),
        new Promise<void>((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs)),
      ])
    }
    const drained = this.#active.size === 0
    if (drained) this.#phase = 'stopped'
    return {
      drained,
      timeoutMs,
      activeOperations: this.#active.size,
      phase: drained ? 'stopped' : 'stopping',
    }
  }
}

export function createDisabledSymphonyService(): NativeSymphonyService {
  return new NativeSymphonyService({ version: 1, enabled: false, stopTimeoutMs: 5_000, projects: [] }, null)
}

export async function createSymphonyServiceFromConfig(path: string): Promise<NativeSymphonyService> {
  return new NativeSymphonyService(await loadSymphonyServerConfig(path), resolve(path))
}
