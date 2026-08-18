import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SessionToolContext } from '../context.ts';
import { handleSubmitPlan } from './submit-plan.ts';

function createCtx(root: string, submitted: string[]): SessionToolContext {
  const plansFolderPath = join(root, 'plans');
  mkdirSync(plansFolderPath, { recursive: true });
  return {
    sessionId: 'test-session',
    workspacePath: root,
    sourcesPath: join(root, 'sources'),
    skillsPath: join(root, 'skills'),
    plansFolderPath,
    callbacks: {
      onPlanSubmitted: (path: string) => submitted.push(path),
      onAuthRequest: () => {},
    },
    fs: {
      exists: (path: string) => existsSync(path),
      readFile: (path: string) => readFileSync(path, 'utf8'),
    },
  } as unknown as SessionToolContext;
}

describe('handleSubmitPlan', () => {
  let root: string;
  let submitted: string[];

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'submit-plan-'));
    submitted = [];
  });

  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('falls back to the canonical session plan for an argument-less tool call', async () => {
    const ctx = createCtx(root, submitted);
    const expected = join(ctx.plansFolderPath, 'plan.md');
    writeFileSync(expected, '# Approved plan\n');

    const result = await handleSubmitPlan(ctx, {});

    expect(result.isError).toBe(false);
    expect(submitted).toEqual([expected]);
  });

  it('preserves an explicit plan path when supplied', async () => {
    const ctx = createCtx(root, submitted);
    const explicit = join(ctx.plansFolderPath, 'protocol-v4.md');
    writeFileSync(explicit, '# Protocol v4\n');

    const result = await handleSubmitPlan(ctx, { planPath: explicit });

    expect(result.isError).toBe(false);
    expect(submitted).toEqual([explicit]);
  });

  it('reports the canonical fallback path when plan.md is missing', async () => {
    const ctx = createCtx(root, submitted);
    const expected = join(ctx.plansFolderPath, 'plan.md');

    const result = await handleSubmitPlan(ctx, {});

    expect(result.isError).toBe(true);
    const responseText = JSON.stringify(result.content);
    expect(responseText).toContain(expected);
    expect(responseText).not.toContain('undefined');
    expect(submitted).toEqual([]);
  });
});
