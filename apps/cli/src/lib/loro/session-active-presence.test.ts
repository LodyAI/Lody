import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionStatusFactory, type MachineId, type SessionId } from '@lody/shared';
import type { Logger } from '@/utils/logger';
import type { LoroDocumentManager } from './doc';
import { SessionActivePresenceController } from './session-active-presence';
import { captureCli } from '../analytics/posthog';

vi.mock('../analytics/posthog', () => ({
  captureCli: vi.fn(),
}));

const sessionId = 'session-active-presence-1' as SessionId;
const machineId = 'machine-active-presence-1' as MachineId;

const createLogger = (): Logger =>
  ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }) as unknown as Logger;

const createWorkspaceDocument = () =>
  ({
    publishSessionPresence: vi.fn(),
    clearSessionPresence: vi.fn(),
  }) as unknown as Pick<LoroDocumentManager, 'publishSessionPresence' | 'clearSessionPresence'>;

describe('SessionActivePresenceController', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('publishes fallback thinking presence on start and clears on release', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId);

    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledWith(
      sessionId,
      machineId,
      SessionStatusFactory.running()
    );

    controller.clear(sessionId);

    expect(workspaceDocument.clearSessionPresence).toHaveBeenCalledWith(sessionId);
  });

  it('updates phase through the same owner without clearing between phases', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId, 'initializing');
    controller.setPhase(sessionId, 'acp');
    controller.start(sessionId, 'thinking');
    controller.setPhase(sessionId, 'requestPermission');
    controller.setPhase(sessionId, 'requestPermission');

    expect(workspaceDocument.clearSessionPresence).not.toHaveBeenCalled();
    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(4);
    expect(workspaceDocument.publishSessionPresence).toHaveBeenLastCalledWith(
      sessionId,
      machineId,
      SessionStatusFactory.requestPermission()
    );
  });

  it('publishes managed runtime progress as initializing presence detail', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId, 'managed-runtime', 'Downloading Codex runtime 42%');
    controller.setPhase(sessionId, 'managed-runtime', 'Downloading Codex runtime 43%');

    expect(workspaceDocument.publishSessionPresence).toHaveBeenLastCalledWith(
      sessionId,
      machineId,
      SessionStatusFactory.initializing('managed-runtime', 'Downloading Codex runtime 43%')
    );
  });

  it('refreshes active presence on the heartbeat interval and stops after clear', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId, 'image_generation');
    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(1_000);
    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(2);

    controller.clear(sessionId);
    vi.advanceTimersByTime(2_000);

    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(2);
    expect(workspaceDocument.clearSessionPresence).toHaveBeenCalledTimes(1);
  });

  it('does not emit active_ping on start but does on the first active minute', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId, 'thinking');

    expect(captureCli).not.toHaveBeenCalled();

    vi.advanceTimersByTime(59_000);
    expect(captureCli).not.toHaveBeenCalled();

    vi.advanceTimersByTime(1_000);
    expect(captureCli).toHaveBeenCalledTimes(1);
    expect(captureCli).toHaveBeenCalledWith(
      'app/active_ping',
      expect.objectContaining({
        active_context: 'session_turn',
      }),
      { tier: 'C' }
    );
  });

  it('keeps one heartbeat timer when start is called for an already active session', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );

    controller.start(sessionId, 'initializing');
    controller.start(sessionId, 'acp');
    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(2);

    vi.advanceTimersByTime(1_000);

    expect(workspaceDocument.publishSessionPresence).toHaveBeenCalledTimes(3);
    expect(workspaceDocument.publishSessionPresence).toHaveBeenLastCalledWith(
      sessionId,
      machineId,
      SessionStatusFactory.initializing('acp')
    );
  });

  it('tracks active sessions and clears all owned entries', () => {
    const workspaceDocument = createWorkspaceDocument();
    const controller = new SessionActivePresenceController(
      workspaceDocument as LoroDocumentManager,
      machineId,
      createLogger(),
      { intervalMs: 1_000 }
    );
    const otherSessionId = 'session-active-presence-2' as SessionId;

    controller.start(sessionId, 'initializing');
    controller.start(otherSessionId, 'thinking');

    expect(controller.has(sessionId)).toBe(true);
    expect(controller.getStatus(sessionId)).toEqual(SessionStatusFactory.initializing());
    expect(controller.getStatus('missing-session' as SessionId)).toBeNull();
    expect(controller.activeSessionCount()).toBe(2);

    controller.clearAll();

    expect(controller.has(sessionId)).toBe(false);
    expect(controller.activeSessionCount()).toBe(0);
    expect(workspaceDocument.clearSessionPresence).toHaveBeenCalledWith(sessionId);
    expect(workspaceDocument.clearSessionPresence).toHaveBeenCalledWith(otherSessionId);
  });
});
