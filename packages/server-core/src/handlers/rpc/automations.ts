import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { RPC_CHANNELS } from '@craft-agent/shared/protocol'
import { getWorkspaceByNameOrId } from '@craft-agent/shared/config'
import { appendAutomationHistoryEntry } from '@craft-agent/shared/automations/history-store'
import { AutomationAdmissionStore, type AutomationAdmissionScope } from '@craft-agent/shared/automations/admission-store'
import { AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER } from '@craft-agent/shared/automations/constants'
import type { RpcServer } from '@craft-agent/server-core/transport'
import type { HandlerDeps } from '../handler-deps'

// History file name — matches AUTOMATIONS_HISTORY_FILE from @craft-agent/shared/automations/constants
const HISTORY_FILE = 'automations-history.jsonl'
interface HistoryEntry { id: string; ts: number; ok: boolean; sessionId?: string; prompt?: string; error?: string; webhook?: { method: string; url: string; statusCode: number; durationMs: number; attempts?: number; error?: string; responseBody?: string } }

// Per-workspace config mutex: serializes read-modify-write cycles on automations.json
// to prevent concurrent IPC calls from clobbering each other's changes.
const configMutexes = new Map<string, Promise<void>>()
function withConfigMutex<T>(workspaceRoot: string, fn: () => Promise<T>): Promise<T> {
  const prev = configMutexes.get(workspaceRoot) ?? Promise.resolve()
  const next = prev.then(fn, fn) // run fn regardless of previous result
  configMutexes.set(workspaceRoot, next.then(() => {}, () => {}))
  return next
}

// Shared helper: resolve workspace, read automations.json, validate matcher, mutate, write back
interface AutomationsConfigJson { automations?: Record<string, Record<string, unknown>[]>; [key: string]: unknown }
async function withAutomationMatcher(workspaceId: string, eventName: string, matcherIndex: number, mutate: (matchers: Record<string, unknown>[], index: number, config: AutomationsConfigJson, genId: () => string) => void) {
  const workspace = getWorkspaceByNameOrId(workspaceId)
  if (!workspace) throw new Error('Workspace not found')

  await withConfigMutex(workspace.rootPath, async () => {
    const { resolveAutomationsConfigPath, generateShortId } = await import('@craft-agent/shared/automations/resolve-config-path')
    const configPath = resolveAutomationsConfigPath(workspace.rootPath)

    const raw = await readFile(configPath, 'utf-8')
    const config = JSON.parse(raw)

    const eventMap = config.automations ?? {}
    const matchers = eventMap[eventName]
    if (!Array.isArray(matchers) || matcherIndex < 0 || matcherIndex >= matchers.length) {
      throw new Error(`Invalid automation reference: ${eventName}[${matcherIndex}]`)
    }

    mutate(matchers, matcherIndex, config, generateShortId)

    // Backfill missing IDs on all matchers before writing
    for (const eventMatchers of Object.values(eventMap)) {
      if (!Array.isArray(eventMatchers)) continue
      for (const m of eventMatchers as Record<string, unknown>[]) {
        if (!m.id) m.id = generateShortId()
      }
    }

    await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8')
  })
}

export const HANDLED_CHANNELS = [
  RPC_CHANNELS.automations.GET,
  RPC_CHANNELS.automations.TEST,
  RPC_CHANNELS.automations.SET_ENABLED,
  RPC_CHANNELS.automations.DUPLICATE,
  RPC_CHANNELS.automations.DELETE,
  RPC_CHANNELS.automations.GET_HISTORY,
  RPC_CHANNELS.automations.GET_LAST_EXECUTED,
  RPC_CHANNELS.automations.REPLAY,
  RPC_CHANNELS.automations.ADMISSION_CAPABILITIES,
  RPC_CHANNELS.automations.ADMISSION_CLAIM,
  RPC_CHANNELS.automations.ADMISSION_DELIVER,
  RPC_CHANNELS.automations.ADMISSION_INSPECT,
  RPC_CHANNELS.automations.ADMISSION_RECOVER,
] as const

export function registerAutomationsHandlers(server: RpcServer, deps: HandlerDeps): void {
  const log = deps.platform.logger

  // Durable admission discovery is available only after the transport's
  // authenticated handshake. The registered channel is also advertised in the
  // handshake acknowledgement for capability-aware clients.
  server.handle(RPC_CHANNELS.automations.ADMISSION_CAPABILITIES, async () => ({
    version: 2,
    // Deployment identity is explicit rather than inferred from Node/Electron
    // versions. Capability-aware controllers fail closed when either value is
    // absent or does not match their accepted pinned runtime.
    runtimeVersion: process.env.CRAFT_VERSION ?? null,
    runtimeCommit: process.env.CRAFT_BUILD_SHA ?? null,
    actions: ['session-message'],
    states: ['prepared', 'delivering', 'committed', 'completed', 'blocked'],
    deliveryStates: ['delivered', 'pending-consumption', 'consumed', 'duplicate', 'busy', 'blocked'],
    targetKinds: ['controller', 'coordinator'],
    minimumRecoveryAgeMs: 60_000,
    claimChannel: RPC_CHANNELS.automations.ADMISSION_CLAIM,
    deliverChannel: RPC_CHANNELS.automations.ADMISSION_DELIVER,
    inspectChannel: RPC_CHANNELS.automations.ADMISSION_INSPECT,
    recoverChannel: RPC_CHANNELS.automations.ADMISSION_RECOVER,
  }))

  // Generic atomic admission claim surface for authenticated RPC clients.
  // It only reserves work; product-specific side effects remain with their
  // owning runtime (for session-message, SessionManager).
  server.handle(RPC_CHANNELS.automations.ADMISSION_CLAIM, async (_ctx, workspaceId: string, scope: AutomationAdmissionScope) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    if (!scope || scope.workspaceId !== workspace.id) throw new Error('Admission scope workspace does not match requested workspace')
    return new AutomationAdmissionStore(workspace.rootPath).claim(scope)
  })

  // Supported addressable delivery surface. Claim and message persistence are
  // one SessionManager operation, so clients never need to compose a non-atomic
  // `claim` plus ordinary `sessions:sendMessage` sequence.
  server.handle(RPC_CHANNELS.automations.ADMISSION_DELIVER, async (_ctx, workspaceId: string, input: {
    sessionId: string
    message: string
    matcherId: string
    actionId: string
    occurrenceId: string
    idempotencyKey: string
    targetKind: 'controller' | 'coordinator'
    targetId: string
    targetGeneration: string
  }) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    for (const field of ['sessionId', 'message', 'matcherId', 'actionId', 'occurrenceId', 'idempotencyKey', 'targetId', 'targetGeneration'] as const) {
      if (typeof input?.[field] !== 'string' || input[field].trim().length === 0) throw new Error(`Admission delivery ${field} must be a non-empty string`)
    }
    if (input.targetKind !== 'controller' && input.targetKind !== 'coordinator') throw new Error('Admission delivery targetKind must be controller or coordinator')
    return deps.sessionManager.deliverAutomationSessionMessage({
      workspaceId: workspace.id,
      workspaceRootPath: workspace.rootPath,
      sessionId: input.sessionId,
      message: input.message,
      matcherId: input.matcherId,
      actionId: input.actionId,
      occurrenceId: input.occurrenceId,
      idempotencyKey: input.idempotencyKey,
      targetKind: input.targetKind,
      targetId: input.targetId,
      targetGeneration: input.targetGeneration,
    })
  })

  server.handle(RPC_CHANNELS.automations.ADMISSION_INSPECT, async (_ctx, workspaceId: string, input: {
    sessionId: string
    matcherId: string
    actionId: string
    occurrenceId: string
    idempotencyKey: string
  }) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    for (const field of ['sessionId', 'matcherId', 'actionId', 'occurrenceId', 'idempotencyKey'] as const) {
      if (typeof input?.[field] !== 'string' || input[field].trim().length === 0) throw new Error(`Admission inspection ${field} must be a non-empty string`)
    }
    return deps.sessionManager.inspectAutomationSessionMessage({
      workspaceId: workspace.id,
      workspaceRootPath: workspace.rootPath,
      ...input,
    })
  })

  server.handle(RPC_CHANNELS.automations.ADMISSION_RECOVER, async (_ctx, workspaceId: string, input: {
    sessionId: string
    matcherId: string
    actionId: string
    occurrenceId: string
    idempotencyKey: string
    targetKind: 'controller' | 'coordinator'
    targetId: string
    targetGeneration: string
    messageId: string
    runtimeVersion: string
    runtimeCommit: string
    processingGeneration: number
    minimumProcessingAgeMs: number
  }) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')
    for (const field of ['sessionId', 'matcherId', 'actionId', 'occurrenceId', 'idempotencyKey', 'targetId', 'targetGeneration', 'messageId', 'runtimeVersion', 'runtimeCommit'] as const) {
      if (typeof input?.[field] !== 'string' || input[field].trim().length === 0) throw new Error(`Admission recovery ${field} must be a non-empty string`)
    }
    if (input.targetKind !== 'controller' && input.targetKind !== 'coordinator') throw new Error('Admission recovery targetKind must be controller or coordinator')
    return deps.sessionManager.recoverAutomationSessionMessage({
      workspaceId: workspace.id,
      workspaceRootPath: workspace.rootPath,
      ...input,
    })
  })

  // Get automations config for a workspace (read-only, resolves path server-side)
  server.handle(RPC_CHANNELS.automations.GET, async (_ctx, workspaceId: string) => {
    log.info(`AUTOMATIONS_GET: Loading automations for workspace: ${workspaceId}`)
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) {
      log.error(`AUTOMATIONS_GET: Workspace not found: ${workspaceId}`)
      return null
    }
    try {
      const { resolveAutomationsConfigPath } = await import('@craft-agent/shared/automations/resolve-config-path')
      const configPath = resolveAutomationsConfigPath(workspace.rootPath)
      log.info(`AUTOMATIONS_GET: Reading config from: ${configPath}`)
      const content = await readFile(configPath, 'utf-8')
      const parsed = JSON.parse(content)
      const eventCount = parsed?.automations ? Object.keys(parsed.automations).length : 0
      log.info(`AUTOMATIONS_GET: Loaded ${eventCount} event type(s) from ${configPath}`)
      return parsed
    } catch (error) {
      if (error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT') {
        log.info(`AUTOMATIONS_GET: No automations.json found for workspace ${workspaceId}`)
        return null // No automations configured yet
      }
      log.error(`AUTOMATIONS_GET: Error loading automations:`, error)
      throw error
    }
  })

  server.handle(RPC_CHANNELS.automations.TEST, async (_ctx, payload: import('@craft-agent/shared/protocol').TestAutomationPayload) => {
    const workspace = getWorkspaceByNameOrId(payload.workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const results: import('@craft-agent/shared/protocol').TestAutomationActionResult[] = []
    const { parsePromptReferences } = await import('@craft-agent/shared/automations')
    const { executeWebhookRequest, createWebhookHistoryEntry, createPromptHistoryEntry } = await import('@craft-agent/shared/automations/webhook-utils')

    for (const [actionIndex, action] of payload.actions.entries()) {
      const start = Date.now()

      if (action.type === 'session-message') {
        const delivery = await deps.sessionManager.deliverAutomationSessionMessage({
          workspaceId: payload.workspaceId,
          workspaceRootPath: workspace.rootPath,
          sessionId: action.sessionId,
          message: action.message,
          matcherId: payload.automationId ?? 'test',
          actionId: String(actionIndex),
          occurrenceId: `test:${Date.now()}:${actionIndex}`,
          idempotencyKey: action.idempotencyKey ?? 'test',
          targetKind: 'controller',
          targetId: action.sessionId,
          targetGeneration: 'automation-test',
        })
        const success = delivery.status === 'delivered' || delivery.status === 'pending-consumption' || delivery.status === 'consumed' || delivery.status === 'duplicate'
        results.push({
          type: 'session-message',
          success,
          messageId: delivery.messageId,
          delivery: delivery.status,
          stderr: success ? undefined : delivery.reason ?? delivery.status,
          duration: Date.now() - start,
        })
        continue
      }

      if (action.type === 'webhook') {
        // Execute webhook action using shared utility (no env expansion for test — raw URLs)
        // Cast needed: protocol DTO uses loose `method?: string`, WebhookAction uses strict union
        const result = await executeWebhookRequest(action as import('@craft-agent/shared/automations').WebhookAction)
        const method = action.method ?? 'POST'

        results.push({
          ...result,
          duration: Date.now() - start,
        })

        if (payload.automationId) {
          const entry = createWebhookHistoryEntry({
            matcherId: payload.automationId,
            ok: result.success,
            method,
            url: action.url as string,
            statusCode: result.statusCode,
            durationMs: result.durationMs ?? 0,
            error: result.error,
            responseBody: result.responseBody,
          })
          try {
            await appendAutomationHistoryEntry(workspace.rootPath, entry)
          } catch (e) {
            log.warn('[Automations] Failed to write history:', e)
          }
        }
        continue
      }

      // Prompt action
      // Parse @mentions from the prompt to resolve source/skill references
      const references = parsePromptReferences(action.prompt)

      try {
        const { sessionId } = await deps.sessionManager.executePromptAutomation({
          workspaceId: payload.workspaceId,
          workspaceRootPath: workspace.rootPath,
          prompt: action.prompt,
          labels: payload.labels,
          permissionMode: payload.permissionMode,
          mentions: references.mentions,
          llmConnection: action.llmConnection,
          model: action.model,
          thinkingLevel: action.thinkingLevel,
          automationName: payload.automationName,
          telegramTopic: payload.telegramTopic,
          // Test = "did it launch + start producing output", not "did the whole
          // turn finish". Return once the session is created so a long run doesn't
          // trip the 30s RPC timeout (craft-agents-oss#943).
          waitForCompletion: false,
        })
        results.push({
          type: 'prompt',
          success: true,
          sessionId,
          duration: Date.now() - start,
        })

        // Write history entry for test runs
        if (payload.automationId) {
          const entry = createPromptHistoryEntry({ matcherId: payload.automationId, ok: true, sessionId, prompt: action.prompt })
          try {
            await appendAutomationHistoryEntry(workspace.rootPath, entry)
          } catch (e) {
            log.warn('[Automations] Failed to write history:', e)
          }
        }
      } catch (err: unknown) {
        results.push({
          type: 'prompt',
          success: false,
          stderr: (err as Error).message,
          duration: Date.now() - start,
        })

        // Write failed history entry
        if (payload.automationId) {
          const entry = createPromptHistoryEntry({ matcherId: payload.automationId, ok: false, error: (err as Error).message, prompt: action.prompt })
          try {
            await appendAutomationHistoryEntry(workspace.rootPath, entry)
          } catch (e) {
            log.warn('[Automations] Failed to write history:', e)
          }
        }
      }
    }

    return { actions: results } satisfies import('@craft-agent/shared/protocol').TestAutomationResult
  })

  // Automation enabled state management (toggle enabled/disabled in automations.json)
  server.handle(RPC_CHANNELS.automations.SET_ENABLED, async (_ctx, workspaceId: string, eventName: string, matcherIndex: number, enabled: boolean) => {
    await withAutomationMatcher(workspaceId, eventName, matcherIndex, (matchers, idx) => {
      if (enabled) {
        delete matchers[idx].enabled
      } else {
        matchers[idx].enabled = false
      }
    })
  })

  // Duplicate an automation matcher
  server.handle(RPC_CHANNELS.automations.DUPLICATE, async (_ctx, workspaceId: string, eventName: string, matcherIndex: number) => {
    await withAutomationMatcher(workspaceId, eventName, matcherIndex, (matchers, idx, _config, genId) => {
      const clone = JSON.parse(JSON.stringify(matchers[idx]))
      clone.id = genId()
      clone.name = clone.name ? `${clone.name} Copy` : 'Untitled Copy'
      matchers.splice(idx + 1, 0, clone)
    })
  })

  // Delete an automation matcher
  server.handle(RPC_CHANNELS.automations.DELETE, async (_ctx, workspaceId: string, eventName: string, matcherIndex: number) => {
    await withAutomationMatcher(workspaceId, eventName, matcherIndex, (matchers, idx, config) => {
      matchers.splice(idx, 1)
      if (matchers.length === 0) {
        const eventMap = config.automations
        if (eventMap) delete eventMap[eventName]
      }
    })
  })

  // Read execution history for a specific automation
  server.handle(RPC_CHANNELS.automations.GET_HISTORY, async (_ctx, workspaceId: string, automationId: string, limit = AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const clampedLimit = Math.max(1, Math.min(limit, AUTOMATION_HISTORY_MAX_RUNS_PER_MATCHER))
    const historyPath = join(workspace.rootPath, HISTORY_FILE)
    try {
      const content = await readFile(historyPath, 'utf-8')
      const lines = content.trim().split('\n').filter(Boolean)

      return lines
        .map(line => { try { return JSON.parse(line) } catch { return null } })
        .filter((e): e is HistoryEntry => e?.id === automationId)
        .slice(-clampedLimit)
        .reverse()
    } catch {
      return [] // File doesn't exist yet
    }
  })

  // Replay webhook actions for a specific automation matcher
  server.handle(RPC_CHANNELS.automations.REPLAY, async (_ctx, workspaceId: string, automationId: string, eventName: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const { resolveAutomationsConfigPath } = await import('@craft-agent/shared/automations/resolve-config-path')
    const configPath = resolveAutomationsConfigPath(workspace.rootPath)
    const raw = await readFile(configPath, 'utf-8')
    const config = JSON.parse(raw) as { automations?: Record<string, Array<{ id?: string; actions?: Array<{ type: string; [key: string]: unknown }> }>> }

    const matchers = config.automations?.[eventName] ?? []
    const matcher = matchers.find(m => m.id === automationId)
    if (!matcher) throw new Error('Automation not found')

    const webhookActions = (matcher.actions ?? []).filter(a => a.type === 'webhook')
    if (webhookActions.length === 0) throw new Error('No webhook actions to replay')

    const { executeWebhookRequest, createWebhookHistoryEntry } = await import('@craft-agent/shared/automations/webhook-utils')
    const results = await Promise.all(
      webhookActions.map(a => executeWebhookRequest(a as unknown as import('@craft-agent/shared/automations').WebhookAction))
    )

    // Write history entries for replay — use index to correctly attribute method per action
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!
      const action = webhookActions[i]!
      const entry = createWebhookHistoryEntry({
        matcherId: automationId,
        ok: result.success,
        method: (action as { method?: string }).method,
        url: result.url,
        statusCode: result.statusCode,
        durationMs: result.durationMs ?? 0,
        error: result.error,
      })
      try {
        await appendAutomationHistoryEntry(workspace.rootPath, entry)
      } catch (e) {
        log.warn('[Automations] Failed to write replay history:', e)
      }
    }

    return { results: results.map(r => ({ ...r, duration: r.durationMs ?? 0 })) }
  })

  // Return last execution timestamp for all automations
  server.handle(RPC_CHANNELS.automations.GET_LAST_EXECUTED, async (_ctx, workspaceId: string) => {
    const workspace = getWorkspaceByNameOrId(workspaceId)
    if (!workspace) throw new Error('Workspace not found')

    const historyPath = join(workspace.rootPath, HISTORY_FILE)
    try {
      const content = await readFile(historyPath, 'utf-8')
      const result: Record<string, number> = {}
      for (const line of content.trim().split('\n')) {
        try {
          const entry = JSON.parse(line)
          if (entry.id && entry.ts) result[entry.id] = entry.ts
        } catch { /* skip malformed lines */ }
      }
      return result
    } catch {
      return {}
    }
  })
}
