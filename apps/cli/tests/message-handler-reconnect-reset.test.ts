import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MessageHandler } from '../src/lib/message-handler';
import type { Logger } from '../src/utils/logger';
import { SessionStatusFactory, WorkspaceId, type SessionId } from '@lody/shared';
import type { SessionManager } from '../src/session/session-manager';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import { createTestCloudPort } from './test-cloud-port';

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  trace: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

describe('MessageHandler reconnect reset', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resets stale running sessions owned by this machine to idle after reconnect', async () => {
    const logger = createSilentLogger();

    // Session owned by this machine, in running state with no local active presence - should be reset
    const session1 = {
      getMetaState: vi.fn(async () => ({
        machineId: 'm-1',
        status: SessionStatusFactory.running(),
      })),
      setStatus: vi.fn(async () => {}),
    };

    // Session owned by different machine - should NOT be reset
    const session2 = {
      getMetaState: vi.fn(async () => ({
        machineId: 'm-2',
        status: SessionStatusFactory.running(),
      })),
      setStatus: vi.fn(async () => {}),
    };

    // Session owned by this machine, already idle - should NOT be reset
    const session3 = {
      getMetaState: vi.fn(async () => ({
        machineId: 'm-1',
        status: SessionStatusFactory.idle(),
      })),
      setStatus: vi.fn(async () => {}),
    };

    const sessionDocs = new Map<SessionId, unknown>([
      ['s-1' as SessionId, session1],
      ['s-2' as SessionId, session2],
      ['s-3' as SessionId, session3],
    ]);

    const workspaceDocument = {
      isTransportConnected: vi.fn(() => true),
      markMachineFlockDocDirty: vi.fn(),
      sessions: new Map<SessionId, unknown>([
        ['s-1' as SessionId, {}],
        ['s-2' as SessionId, {}],
        ['s-3' as SessionId, {}],
      ]),
      registerMachine: vi.fn(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
      },
      getOrCreateSessionDoc: vi.fn(async (sessionId: SessionId) => {
        const doc = sessionDocs.get(sessionId);
        if (!doc) {
          throw new Error(`Unknown session: ${String(sessionId)}`);
        }
        return doc;
      }),
    };

    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      getSession: vi.fn(),
      finishSession: vi.fn(),
      cleanUp: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      hasSession: vi.fn(),
      initialize: vi.fn(),
      createSession: vi.fn(),
    };

    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      logger,
      {
        token: 't',
        workspaceId: 'ws-1' as WorkspaceId,
        userId: 'u-1',
        machineId: 'm-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort(),
      }
    );

    await handler.resetMachineDisconnectedSessionsToIdle();

    // Session 1 should be reset (owned by this machine, no local active presence means stale)
    expect(session1.setStatus).toHaveBeenCalledTimes(1);
    expect(session1.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
    // Session 2 should NOT be reset (owned by different machine)
    expect(session2.setStatus).not.toHaveBeenCalled();
    // Session 3 should NOT be reset (already idle)
    expect(session3.setStatus).not.toHaveBeenCalled();
  });

  it('does NOT reset running sessions with local active presence', async () => {
    const logger = createSilentLogger();

    // Session owned by this machine, in running state with local active presence - should NOT be reset
    const session1 = {
      getMetaState: vi.fn(async () => ({
        machineId: 'm-1',
        status: SessionStatusFactory.running(),
      })),
      setStatus: vi.fn(async () => {}),
    };

    // Session owned by this machine, initializing with local active presence - should NOT be reset
    const session2 = {
      getMetaState: vi.fn(async () => ({
        machineId: 'm-1',
        status: SessionStatusFactory.initializing('resuming'),
      })),
      setStatus: vi.fn(async () => {}),
    };

    const sessionDocs = new Map<SessionId, unknown>([
      ['s-1' as SessionId, session1],
      ['s-2' as SessionId, session2],
    ]);

    const workspaceDocument = {
      isTransportConnected: vi.fn(() => true),
      markMachineFlockDocDirty: vi.fn(),
      sessions: new Map<SessionId, unknown>([
        ['s-1' as SessionId, {}],
        ['s-2' as SessionId, {}],
      ]),
      registerMachine: vi.fn(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
      },
      getOrCreateSessionDoc: vi.fn(async (sessionId: SessionId) => {
        const doc = sessionDocs.get(sessionId);
        if (!doc) {
          throw new Error(`Unknown session: ${String(sessionId)}`);
        }
        return doc;
      }),
      publishSessionPresence: vi.fn(),
      clearSessionPresence: vi.fn(),
    };

    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      getSession: vi.fn(),
      finishSession: vi.fn(),
      cleanUp: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      hasSession: vi.fn(),
      initialize: vi.fn(),
      createSession: vi.fn(),
    };

    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      logger,
      {
        token: 't',
        workspaceId: 'ws-1' as WorkspaceId,
        userId: 'u-1',
        machineId: 'm-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort(),
      }
    );

    // Simulate active local presence for both sessions
    (handler as unknown as Record<string, (id: SessionId) => void>).startSessionActivePresence(
      's-1' as SessionId
    );
    (handler as unknown as Record<string, (id: SessionId) => void>).startSessionActivePresence(
      's-2' as SessionId
    );

    await handler.resetMachineDisconnectedSessionsToIdle();

    // Session 1 should NOT be reset (local active presence means agent is still running)
    expect(session1.setStatus).not.toHaveBeenCalled();
    // Session 2 should NOT be reset (local active presence means agent is still initializing)
    expect(session2.setStatus).not.toHaveBeenCalled();
  });

  it('resets running sessions with no local active presence', async () => {
    const logger = createSilentLogger();

    // Session owned by this machine, running but no local active presence - should be reset (stale)
    const session1 = {
      getMetaState: vi.fn(async () => ({
        machineId: 'm-1',
        status: SessionStatusFactory.running(),
      })),
      setStatus: vi.fn(async () => {}),
    };

    const sessionDocs = new Map<SessionId, unknown>([['s-1' as SessionId, session1]]);

    const workspaceDocument = {
      isTransportConnected: vi.fn(() => true),
      markMachineFlockDocDirty: vi.fn(),
      sessions: new Map<SessionId, unknown>([['s-1' as SessionId, {}]]),
      registerMachine: vi.fn(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
      },
      getOrCreateSessionDoc: vi.fn(async (sessionId: SessionId) => {
        const doc = sessionDocs.get(sessionId);
        if (!doc) {
          throw new Error(`Unknown session: ${String(sessionId)}`);
        }
        return doc;
      }),
    };

    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      getSession: vi.fn(),
      finishSession: vi.fn(),
      cleanUp: vi.fn(),
      setSessionError: vi.fn(),
      terminateSession: vi.fn(),
      hasSession: vi.fn(),
      initialize: vi.fn(),
      createSession: vi.fn(),
    };

    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      logger,
      {
        token: 't',
        workspaceId: 'ws-1' as WorkspaceId,
        userId: 'u-1',
        machineId: 'm-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort(),
      }
    );

    await handler.resetMachineDisconnectedSessionsToIdle();

    // Session 1 should be reset (no local active presence means stale)
    expect(session1.setStatus).toHaveBeenCalledTimes(1);
    expect(session1.setStatus).toHaveBeenCalledWith(SessionStatusFactory.idle());
  });
});
