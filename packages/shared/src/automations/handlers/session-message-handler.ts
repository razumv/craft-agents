import { createLogger } from '../../utils/debug.ts'
import type { EventBus, BaseEventPayload } from '../event-bus.ts'
import type { AutomationHandler, SessionMessageHandlerOptions, AutomationsConfigProvider } from './types.ts'
import { APP_EVENTS, type AutomationEvent, type AppEvent, type SessionMessageAction, type PendingSessionMessage } from '../types.ts'
import { buildEnvFromPayload, expandEnvVars, matcherMatches } from '../utils.ts'

const log = createLogger('session-message-handler')

/** Builds durable existing-session deliveries from matching App events. */
export class SessionMessageHandler implements AutomationHandler {
  private bus: EventBus | null = null
  private boundHandler: ((event: AutomationEvent, payload: BaseEventPayload) => Promise<void>) | null = null

  constructor(
    private readonly options: SessionMessageHandlerOptions,
    private readonly configProvider: AutomationsConfigProvider,
  ) {}

  subscribe(bus: EventBus): void {
    this.bus = bus
    this.boundHandler = this.handleEvent.bind(this)
    bus.onAny(this.boundHandler)
  }

  private async handleEvent(event: AutomationEvent, payload: BaseEventPayload): Promise<void> {
    if (!APP_EVENTS.includes(event as AppEvent)) return
    const matchers = this.configProvider.getMatchersForEvent(event)
    if (matchers.length === 0 || !this.options.onSessionMessagesReady) return

    const env = buildEnvFromPayload(event, payload)
    const occurrenceId = `${event}:${payload.sessionId ?? ''}:${payload.timestamp}`
    const pending: PendingSessionMessage[] = []

    for (const [matcherIndex, matcher] of matchers.entries()) {
      if (!matcherMatches(matcher, event, payload as unknown as Record<string, unknown>)) continue
      const matcherId = matcher.id ?? `${event}:${matcherIndex}`

      for (const [actionIndex, action] of matcher.actions.entries()) {
        if (action.type !== 'session-message') continue
        const messageAction = action as SessionMessageAction
        const sessionId = expandEnvVars(messageAction.sessionId, env).trim()
        const message = expandEnvVars(messageAction.message, env)
        const idempotencyKey = messageAction.idempotencyKey
          ? expandEnvVars(messageAction.idempotencyKey, env).trim()
          : 'event'
        if (!sessionId || !message || !idempotencyKey) {
          // Config validation rejects literals like this. Runtime expansion can
          // still produce an empty value, which must fail closed.
          log.warn('[SessionMessageHandler] Dropping session-message action after empty expansion', { matcherId, actionIndex })
          continue
        }
        pending.push({
          workspaceId: this.options.workspaceId,
          sessionId,
          message,
          matcherId,
          actionId: String(actionIndex),
          occurrenceId,
          idempotencyKey,
        })
      }
    }

    if (pending.length > 0) await this.options.onSessionMessagesReady(pending)
  }

  dispose(): void {
    if (this.bus && this.boundHandler) this.bus.offAny(this.boundHandler)
    this.boundHandler = null
    this.bus = null
  }
}
