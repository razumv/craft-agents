import { parseLabelEntry } from '@craft-agent/shared/labels'

export type QueueOnlyAgentRole = 'coordinator' | 'recovery-controller'

export interface CrossSessionAgentTargetState {
  id: string
  isArchived?: boolean
  labels?: string[]
}

export interface CrossSessionAgentDeliveryPolicy {
  targetRole?: string
  forceQueueWhileBusy: boolean
  policy: 'ordinary' | 'queue-only-role'
}

/**
 * Resolve agent-to-agent delivery policy from the target's persisted session
 * manifest. Role-sensitive delivery is deliberately exact and fail-closed:
 * malformed or duplicate agent-role entries must never be guessed through.
 */
export function resolveCrossSessionAgentDeliveryPolicy(
  target: CrossSessionAgentTargetState | undefined,
  targetSessionId: string,
): CrossSessionAgentDeliveryPolicy {
  if (!target) throw new Error(`Session ${targetSessionId} not found`)
  if (target.isArchived) throw new Error(`Session ${targetSessionId} is archived`)

  const roleEntries = (target.labels ?? [])
    .map(parseLabelEntry)
    .filter(entry => entry.id === 'agent-role')

  if (roleEntries.length > 1) {
    throw new Error(`Session ${targetSessionId} has an ambiguous agent-role manifest`)
  }

  const rawTargetRole = roleEntries[0]?.rawValue
  const targetRole = rawTargetRole?.trim().toLowerCase()
  if (roleEntries.length === 1 && !targetRole) {
    throw new Error(`Session ${targetSessionId} has a malformed agent-role manifest`)
  }

  // Canonicalize defensively for the delivery safety boundary. Label storage is
  // expected to emit lowercase exact values, but whitespace/case drift must not
  // downgrade a coordinator into the ordinary (potentially steering) path.
  const forceQueueWhileBusy = targetRole === 'coordinator' || targetRole === 'recovery-controller'
  return {
    ...(targetRole ? { targetRole } : {}),
    forceQueueWhileBusy,
    policy: forceQueueWhileBusy ? 'queue-only-role' : 'ordinary',
  }
}
