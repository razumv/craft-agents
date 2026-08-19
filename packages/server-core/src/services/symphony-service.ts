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

export interface SymphonyServerConfig {
  version: 1
  /** Live scheduler mutation is impossible unless this is explicitly true. */
  enabled: boolean
  stopTimeoutMs: number
  projects: SymphonyProjectConfig[]
}

export interface SymphonyRunnerLike {
  preflight(): Promise<unknown>
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

  return {
    version: 1,
    enabled: raw.enabled,
    stopTimeoutMs: positiveInteger(raw.stopTimeoutMs, 'Symphony server config stopTimeoutMs'),
    projects,
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
    return this.status()
  }

  validate(projectId: string): Promise<SymphonyOperationResult> {
    return this.#operate(projectId, 'validate', async (runner) => runner.preflight())
  }

  shadow(projectId: string): Promise<SymphonyOperationResult> {
    return this.#operate(projectId, 'shadow', async (runner) => {
      const preflight = await runner.preflight()
      const receipt = await runner.shadow()
      return { preflight, ...(receipt as Record<string, unknown>), writes: 0 }
    })
  }

  projectDesk(projectId: string): Promise<SymphonyOperationResult> {
    return this.#operate(projectId, 'desk', async (runner) => runner.projectDesk())
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
        runtime.status = {
          ...runtime.status,
          phase: 'ready',
          updatedAt: completedAt,
          lastError: null,
          snapshot: result,
        }
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
    }
  }

  async stop(timeoutMs = this.config.stopTimeoutMs): Promise<SymphonyStopResult> {
    positiveInteger(timeoutMs, 'Symphony stop timeout')
    this.#accepting = false
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
