import { describe, it, expect } from 'bun:test';
import {
  cleanupModeState,
  formatSessionState,
  getPermissionModeDiagnostics,
  hydratePreviousPermissionMode,
  initializeModeState,
  setPermissionMode,
} from '../mode-manager.ts';

describe('mode transition session_state context', () => {
  it('includes explicit transition metadata after a mode change', () => {
    const sessionId = `mode-transition-${Date.now()}`;

    initializeModeState(sessionId, 'safe');
    setPermissionMode(sessionId, 'allow-all', {
      changedBy: 'user',
      changedAt: '2026-03-02T08:00:00.000Z',
    });

    const diagnostics = getPermissionModeDiagnostics(sessionId);
    expect(diagnostics.permissionMode).toBe('allow-all');
    expect(diagnostics.previousPermissionMode).toBe('safe');
    expect(diagnostics.transitionDisplay).toBe('Explore -> Execute');

    const stateBlock = formatSessionState(sessionId, {
      plansFolderPath: '/tmp/plans',
      dataFolderPath: '/tmp/data',
    });

    expect(stateBlock).toContain('permissionMode: execute');
    expect(stateBlock).toContain('modeTransition: Explore -> Execute');
    expect(stateBlock).toContain('modeChangedBy: user');
    expect(stateBlock).toContain('modeChangedAt: 2026-03-02T08:00:00.000Z');
    expect(stateBlock).toContain('modeVersion: 2');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by user at 2026-03-02T08:00:00.000Z (Explore -> Execute, modeVersion=2)');
    expect(stateBlock).toContain('modeChangeUserSignal: The user changed mode manually. Apply this mode immediately for this turn.');

    cleanupModeState(sessionId);
  });

  it('omits modeTransition when no previous mode exists', () => {
    const sessionId = `mode-no-transition-${Date.now()}`;

    const stateBlock = formatSessionState(sessionId, {
      plansFolderPath: '/tmp/plans',
    });

    expect(stateBlock).toContain('permissionMode: ask');
    expect(stateBlock).not.toContain('modeTransition:');
    expect(stateBlock).toContain('modeVersion: 0');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by');
    expect(stateBlock).not.toContain('modeChangeUserSignal:');

    cleanupModeState(sessionId);
  });

  it('does not emit a synthetic modeTransition on initial restore', () => {
    const sessionId = `mode-restore-${Date.now()}`;

    initializeModeState(sessionId, 'safe');

    const diagnostics = getPermissionModeDiagnostics(sessionId);
    expect(diagnostics.permissionMode).toBe('safe');
    expect(diagnostics.transitionDisplay).toBeUndefined();

    const stateBlock = formatSessionState(sessionId);
    expect(stateBlock).toContain('permissionMode: explore');
    expect(stateBlock).not.toContain('modeTransition:');
    expect(stateBlock).toContain('modeChangedBy: restore');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by restore');
    expect(stateBlock).not.toContain('modeChangeUserSignal:');

    cleanupModeState(sessionId);
  });

  it('restores modeTransition after rehydrating persisted previous mode', () => {
    const sessionId = `mode-rehydrate-${Date.now()}`;

    // Simulate restored current mode after app restart.
    setPermissionMode(sessionId, 'allow-all', { changedBy: 'restore' });
    hydratePreviousPermissionMode(sessionId, 'safe');

    const diagnostics = getPermissionModeDiagnostics(sessionId);
    expect(diagnostics.permissionMode).toBe('allow-all');
    expect(diagnostics.previousPermissionMode).toBe('safe');
    expect(diagnostics.transitionDisplay).toBe('Explore -> Execute');

    const stateBlock = formatSessionState(sessionId);
    expect(stateBlock).toContain('permissionMode: execute');
    expect(stateBlock).toContain('modeTransition: Explore -> Execute');
    expect(stateBlock).toContain('modeChangeSummary: Last mode change by restore');
    expect(stateBlock).not.toContain('modeChangeUserSignal:');

    cleanupModeState(sessionId);
  });

  it('emits modeChangeUserSignal once when consume option is enabled', () => {
    const sessionId = `mode-consume-once-${Date.now()}`;

    initializeModeState(sessionId, 'safe');
    setPermissionMode(sessionId, 'allow-all', {
      changedBy: 'user',
      changedAt: '2026-03-02T09:00:00.000Z',
    });

    const first = formatSessionState(sessionId, {
      consumeModeChangeUserSignal: true,
    });
    expect(first).toContain('modeChangeUserSignal: The user changed mode manually. Apply this mode immediately for this turn.');

    const second = formatSessionState(sessionId, {
      consumeModeChangeUserSignal: true,
    });
    expect(second).not.toContain('modeChangeUserSignal:');

    cleanupModeState(sessionId);
  });
});

describe('mode display lookup survives foreign state', () => {
  it('formats session state when the stored mode is not a config key', () => {
    // A session whose mode state was written by another path can hold a canonical
    // alias ('execute') instead of an internal key. Indexing PERMISSION_MODE_CONFIG
    // with it threw, and the same diagnostics feed both the agent turn and the
    // renderer: one spawned coordinator could neither answer a message nor have its
    // mode repaired, and opening it crashed the desktop app.
    const sessionId = `mode-foreign-${Date.now()}`;
    initializeModeState(sessionId, 'allow-all');
    hydratePreviousPermissionMode(sessionId, 'execute' as never);

    const diagnostics = getPermissionModeDiagnostics(sessionId);
    expect(diagnostics.transitionDisplay).toBe('Execute -> Execute');
    expect(() => formatSessionState(sessionId)).not.toThrow();

    cleanupModeState(sessionId);
  });

  it('formats session state for a session whose mode state was never created', () => {
    // Exactly the spawned-coordinator case: the session exists, nothing ever went
    // through the mode manager for it, and the first message must still render.
    const sessionId = `mode-absent-${Date.now()}`;

    expect(() => formatSessionState(sessionId)).not.toThrow();
    expect(formatSessionState(sessionId)).toContain(`sessionId: ${sessionId}`);

    cleanupModeState(sessionId);
  });
});
