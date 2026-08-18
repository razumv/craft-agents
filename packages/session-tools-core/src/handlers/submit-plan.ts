/**
 * SubmitPlan Handler
 *
 * Submits a plan file for user review. This triggers the plan display UI
 * and pauses agent execution until the user responds.
 */

import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import type { ToolResult } from '../types.ts';
import { successResponse, errorResponse } from '../response.ts';

export interface SubmitPlanArgs {
  planPath?: string;
}

/**
 * Handle the SubmitPlan tool call.
 *
 * 1. Verifies the plan file exists
 * 2. Reads the file to verify it's valid
 * 3. Calls the onPlanSubmitted callback
 * 4. Returns success (agent execution will be paused by callback)
 */
export async function handleSubmitPlan(
  ctx: SessionToolContext,
  args: SubmitPlanArgs
): Promise<ToolResult> {
  // Some session-tool hosts expose SubmitPlan as an argument-less pause action.
  // Preserve the explicit path contract when supplied, but make the canonical
  // session plan (`<plansFolderPath>/plan.md`) the deterministic fallback.
  // This keeps restored/Pi-backed sessions from dispatching `undefined` into
  // the handler and matches the planning prompt's required write location.
  const explicitPath = typeof args.planPath === 'string' ? args.planPath.trim() : '';
  const planPath = explicitPath || join(ctx.plansFolderPath, 'plan.md');

  // Verify the file exists
  if (!ctx.fs.exists(planPath)) {
    return errorResponse(
      `Plan file not found at ${planPath}. Please write the plan file first using the Write tool.`
    );
  }

  // Read the plan content to verify it's valid
  try {
    ctx.fs.readFile(planPath);
  } catch (error) {
    return errorResponse(
      `Failed to read plan file: ${error instanceof Error ? error.message : 'Unknown error'}`
    );
  }

  // Notify via callback (will trigger forceAbort in session manager)
  ctx.callbacks.onPlanSubmitted(planPath);

  return successResponse('Plan submitted for review. Waiting for user feedback.');
}
