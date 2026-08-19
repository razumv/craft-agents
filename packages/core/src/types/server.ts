/**
 * Server-level types for headless server operations.
 *
 * These types are used by the `server:` RPC namespace for
 * server status, health checks, active session discovery,
 * and headless configuration bootstrap.
 */

// ---------------------------------------------------------------------------
// Server Status & Health
// ---------------------------------------------------------------------------

/** Immutable identity shared by one packaged server, CLI, and release manifest. */
export interface BuildIdentity {
  schemaVersion: 1
  buildId: string
  version: string
  sourceCommit: string
  platform: 'darwin' | 'linux'
  arch: 'x64' | 'arm64'
}

export interface ServerStatus {
  serverId: string
  /** Immutable build ID for packaged releases; semantic version in development. */
  version: string
  buildIdentity?: BuildIdentity
  uptime: number              // seconds since bootstrap
  connectedClients: number
  workspaces: {
    id: string
    name: string
    slug: string
    activeSessions: number
    automationCount: number
    schedulerRunning: boolean
  }[]
  memory: {
    heapUsed: number          // bytes
    heapTotal: number
    rss: number
  }
}

export interface ServerHealth {
  status: 'ok' | 'degraded' | 'unhealthy'
  checks: {
    name: string
    status: 'pass' | 'fail'
    message?: string
  }[]
}

// ---------------------------------------------------------------------------
// Symphony v4 service
// ---------------------------------------------------------------------------

export type SymphonyServicePhase = 'disabled' | 'reconstructing' | 'ready' | 'stopping' | 'stopped' | 'error'
export type SymphonyOperation = 'validate' | 'shadow' | 'desk' | 'tick' | 'refresh' | 'reconstruct'

export interface SymphonyProjectServiceStatus {
  projectId: string
  phase: 'configured' | 'running' | 'ready' | 'error'
  lastOperation: SymphonyOperation | null
  reconstructedAt: number | null
  updatedAt: number
  lastError: string | null
  /** Provider-neutral status from the native runner; never transcript content. */
  snapshot: unknown | null
  /** Owner desk session id from the runner config — the ONLY valid target for owner-gate directives. */
  ownerSessionId: string | null
  /** Craft project id from the runner config — lets UI surfaces filter Symphony work by Craft project. */
  craftProjectId: string | null
}

export interface SymphonyServiceStatus {
  phase: SymphonyServicePhase
  enabled: boolean
  acceptingOperations: boolean
  configPath: string | null
  stopTimeoutMs: number
  activeOperations: number
  projects: SymphonyProjectServiceStatus[]
  /** Autonomous polling loop state; null when no loop is configured. */
  loop: {
    enabled: boolean
    mode: 'shadow' | 'tick'
    intervalMs: number
    cycles: number
    lastCycleAt: number | null
    droppedProjects: string[]
  } | null
}

export interface SymphonyOperationResult {
  projectId: string
  operation: Exclude<SymphonyOperation, 'reconstruct'>
  completedAt: number
  result: unknown
}

export interface SymphonyStopResult {
  drained: boolean
  timeoutMs: number
  activeOperations: number
  phase: 'stopped' | 'stopping'
}

/** Narrow dependency injected into RPC handlers by the headless host. */
export interface SymphonyServiceControl {
  start(): Promise<SymphonyServiceStatus>
  validate(projectId: string): Promise<SymphonyOperationResult>
  shadow(projectId: string): Promise<SymphonyOperationResult>
  projectDesk(projectId: string): Promise<SymphonyOperationResult>
  /** Read-only re-read of the runner's full durable status (updates the cached snapshot). */
  refresh(projectId: string): Promise<SymphonyOperationResult>
  tick(projectId: string): Promise<SymphonyOperationResult>
  status(): SymphonyServiceStatus
  stop(timeoutMs?: number): Promise<SymphonyStopResult>
}

// ---------------------------------------------------------------------------
// Active Session Discovery
// ---------------------------------------------------------------------------

/** Session processing state — typed union, not stringly. */
export type SessionProcessingStatus =
  | 'idle'
  | 'processing'
  | 'waiting_input'
  | 'error'
  | 'completed'

/** Server-level active session info (cross-workspace, client-safe). */
export interface ActiveSessionInfo {
  sessionId: string
  workspaceId: string
  workspaceName: string
  title?: string
  status: SessionProcessingStatus
  triggeredBy?: {
    automationName: string
    timestamp: number
  }
  createdAt: number
}

