/**
 * Automation Handlers - Re-exports for convenience
 */

export type {
  AutomationHandler,
  PromptHandlerOptions,
  SessionMessageHandlerOptions,
  EventLogHandlerOptions,
  PromptProcessingResult,
  AutomationsConfigProvider,
} from './types.ts';

export { PromptHandler } from './prompt-handler.ts';
export { SessionMessageHandler } from './session-message-handler.ts';
export { EventLogHandler } from './event-log-handler.ts';
export { WebhookHandler, type WebhookHandlerOptions } from './webhook-handler.ts';
