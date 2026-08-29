import { describe, expect, it, vi } from 'vitest';

import { SessionStatusFactory, type SessionId, type WorkspaceId } from '@lody/shared';
import type { RequestPermissionRequest } from '@agentclientprotocol/sdk';

import { MessageHandler } from '../src/lib/message-handler';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';
import type { CloudNotificationsPort } from '@lody/platform';
import { createTestCloudPort } from './test-cloud-port';

/**
 * Mark a session as having active presence so permission resolution is allowed
 * to restore `running` (see session-activity-status.ts). Permission requests
 * happen while a visible turn is active.
 */
const injectActivePresence = (handler: MessageHandler, sessionId: SessionId): void => {
  (
    handler as unknown as {
      startSessionActivePresence: (id: SessionId) => void;
    }
  ).startSessionActivePresence(sessionId);
};

const createSilentLogger = (): Logger => ({
  info: () => {},
  warn: () => {},
  error: () => {},
  success: () => {},
  debug: () => {},
  setLevel: () => {},
  child: () => createSilentLogger(),
  close: async () => {},
});

const createNotificationPort = (
  overrides: Partial<CloudNotificationsPort> = {}
): CloudNotificationsPort => ({
  notifySessionCompleted: async () => {},
  notifyPermissionRequested: async () => {},
  recordPermissionRequested: async () => {},
  resolvePermissionRequested: async () => {},
  syncLiveActivitySummary: async () => ({ sent: false }),
  ...overrides,
});

describe('MessageHandler permission notifications', () => {
  it('records Inbox before a successful Live Activity without fallback push', async () => {
    const logger = createSilentLogger();

    const sessionId = 's-1' as SessionId;
    const workspaceId = 'ws-1' as WorkspaceId;

    // Track subscription callbacks so we can trigger them
    const subscriptionCallbacks: Array<() => void> = [];

    let history: unknown[] = [
      {
        id: 'u-1',
        role: 'user',
        timestamp: new Date().toISOString(),
        read: true,
        userId: 'active-user',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
        finished: true,
      },
      {
        id: 'turn-1',
        role: 'assistant',
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        items: [],
        fileDiff: [],
      },
    ];
    const sessionDoc = {
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
      waitUntilSynced: vi.fn(async () => true),
      setLastMessageAt: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      getMetaState: vi.fn(async () => ({
        title: 'My Session',
        userId: 'meta-user',
        cliType: 'claude',
      })),
      getHistory: vi.fn(async () => history),
      mirror: {
        subscribe: vi.fn((callback: () => void) => {
          subscriptionCallbacks.push(callback);
          return () => {
            const idx = subscriptionCallbacks.indexOf(callback);
            if (idx >= 0) subscriptionCallbacks.splice(idx, 1);
          };
        }),
        getState: () => ({ history }),
      },
    };

    const workspaceDocument = {
      sessions: new Map<SessionId, unknown>(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      isTransportConnected: vi.fn(() => true),
      publishSessionPresence: vi.fn(),
      clearSessionPresence: vi.fn(),
    };

    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      hasSession: vi.fn(() => false),
      terminateSession: vi.fn(),
      archiveSession: vi.fn(),
      cleanUp: vi.fn(),
      setSessionError: vi.fn(),
    };
    const notifyPermissionRequested = vi.fn(async () => {});
    const recordPermissionRequested = vi.fn(async () => {});
    const resolvePermissionRequested = vi.fn(async () => {});
    const syncLiveActivitySummary = vi.fn(async () => ({ sent: true as const, ended: false }));

    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      logger,
      {
        token: 't',
        workspaceId,
        workspaceSlug: 'ws-slug',
        userId: 'device-owner',
        machineId: 'm-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort({
          notifications: createNotificationPort({
            notifyPermissionRequested,
            recordPermissionRequested,
            resolvePermissionRequested,
            syncLiveActivitySummary,
          }),
        }),
      }
    );

    const request: RequestPermissionRequest = {
      sessionId,
      options: [{ kind: 'allow_once', name: 'Allow once', optionId: 'opt1' }],
      toolCall: { toolCallId: 'tc1', title: 'Read file', status: 'in_progress', kind: 'read' },
    };

    const host = handler as unknown as {
      handleAgentPermissionRequest: (
        sessionId: SessionId,
        requestId: string,
        request: RequestPermissionRequest
      ) => Promise<unknown>;
    };

    injectActivePresence(handler, sessionId);
    const permissionPromise = host.handleAgentPermissionRequest(sessionId, 'req1', request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Simulate the outcome being written to LoroDoc by the Web client
    // Find the tool_call entry and add the outcome
    history = history.map((entry) => {
      const e = entry as { items?: unknown[] };
      if (e.items) {
        return {
          ...e,
          items: e.items.map((item) => {
            const i = item as { type?: string; permissionRequest?: { requestId?: string } };
            if (i.type === 'tool_call' && i.permissionRequest?.requestId === 'req1') {
              return {
                ...i,
                permissionRequest: {
                  ...i.permissionRequest,
                  outcome: { outcome: 'cancelled' },
                },
              };
            }
            return item;
          }),
        };
      }
      return entry;
    });

    // Trigger the subscription callbacks to simulate LoroDoc change detection
    for (const cb of subscriptionCallbacks) {
      cb();
    }

    await permissionPromise;

    // The durable "waiting on you" marker rides the same meta write as the
    // status, so needs-you survives the heartbeat repairing status to idle.
    expect(sessionDoc.setStatus).toHaveBeenNthCalledWith(
      1,
      SessionStatusFactory.requestPermission(),
      expect.objectContaining({ awaitingUserSince: expect.any(Number) })
    );
    expect(sessionDoc.setStatus).toHaveBeenLastCalledWith(SessionStatusFactory.running());
    expect(sessionDoc.waitUntilSynced).toHaveBeenCalledTimes(1);
    expect(syncLiveActivitySummary).toHaveBeenCalled();
    const waitCallOrder = sessionDoc.waitUntilSynced.mock.invocationCallOrder[0];
    const liveActivityCallOrder = syncLiveActivitySummary.mock.invocationCallOrder[0];
    if (waitCallOrder === undefined || liveActivityCallOrder === undefined) {
      throw new Error('Expected waitUntilSynced and syncLiveActivitySummary to be called');
    }
    expect(waitCallOrder).toBeLessThan(liveActivityCallOrder);
    expect(notifyPermissionRequested).not.toHaveBeenCalled();
    expect(recordPermissionRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        sessionTitle: 'My Session',
        workspaceSlug: 'ws-slug',
        userId: 'active-user',
        requestId: 'req1',
        toolCallId: 'tc1',
        toolTitle: 'Read file',
        toolKind: 'read',
      })
    );
    expect(resolvePermissionRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        userId: 'active-user',
        requestId: 'req1',
        toolCallId: 'tc1',
      })
    );
  });

  it('uses the AskUserQuestion title for question request notifications', async () => {
    const logger = createSilentLogger();

    const sessionId = 's-question' as SessionId;
    const workspaceId = 'ws-1' as WorkspaceId;
    const subscriptionCallbacks: Array<() => void> = [];

    let history: unknown[] = [
      {
        id: 'u-1',
        role: 'user',
        timestamp: new Date().toISOString(),
        read: true,
        userId: 'active-user',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
        finished: true,
      },
      {
        id: 'turn-1',
        role: 'assistant',
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        items: [],
        fileDiff: [],
      },
    ];
    const sessionDoc = {
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
      waitUntilSynced: vi.fn(async () => true),
      setLastMessageAt: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      getMetaState: vi.fn(async () => ({
        title: 'My Session',
        userId: 'meta-user',
        cliType: 'claude',
      })),
      getHistory: vi.fn(async () => history),
      mirror: {
        subscribe: vi.fn((callback: () => void) => {
          subscriptionCallbacks.push(callback);
          return () => {
            const idx = subscriptionCallbacks.indexOf(callback);
            if (idx >= 0) subscriptionCallbacks.splice(idx, 1);
          };
        }),
        getState: () => ({ history }),
      },
    };

    const workspaceDocument = {
      sessions: new Map<SessionId, unknown>(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      isTransportConnected: vi.fn(() => true),
      publishSessionPresence: vi.fn(),
      clearSessionPresence: vi.fn(),
    };

    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      hasSession: vi.fn(() => false),
      terminateSession: vi.fn(),
      archiveSession: vi.fn(),
      cleanUp: vi.fn(),
      setSessionError: vi.fn(),
    };
    const notifyPermissionRequested = vi.fn(async () => {});
    const recordPermissionRequested = vi.fn(async () => {});
    const resolvePermissionRequested = vi.fn(async () => {});

    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      logger,
      {
        token: 't',
        workspaceId,
        workspaceSlug: 'ws-slug',
        userId: 'device-owner',
        machineId: 'm-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort({
          notifications: createNotificationPort({
            notifyPermissionRequested,
            recordPermissionRequested,
            resolvePermissionRequested,
          }),
        }),
      }
    );

    const request: RequestPermissionRequest = {
      sessionId,
      options: [
        { optionId: 'answer', name: 'Submit answers', kind: 'allow_once' },
        { optionId: 'cancel', name: 'Cancel', kind: 'reject_once' },
      ],
      toolCall: {
        toolCallId: 'tc-question',
        title: 'AskUserQuestion',
        status: 'in_progress',
        kind: 'think',
      },
      _meta: {
        claudeCode: {
          requestType: 'askUserQuestion',
          askUserQuestion: {
            version: 1,
            allowCustomAnswer: true,
            questions: [
              {
                question: 'Which database should we use?',
                header: 'Database',
                options: [{ label: 'Postgres', description: 'Use PostgreSQL' }],
                multiSelect: false,
              },
            ],
          },
        },
      },
    } as RequestPermissionRequest;

    const host = handler as unknown as {
      handleAgentPermissionRequest: (
        sessionId: SessionId,
        requestId: string,
        request: RequestPermissionRequest
      ) => Promise<unknown>;
    };

    const permissionPromise = host.handleAgentPermissionRequest(sessionId, 'req-question', request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    history = history.map((entry) => {
      const e = entry as { items?: unknown[] };
      if (!e.items) return entry;
      return {
        ...e,
        items: e.items.map((item) => {
          const i = item as { type?: string; permissionRequest?: { requestId?: string } };
          if (i.type === 'tool_call' && i.permissionRequest?.requestId === 'req-question') {
            return {
              ...i,
              permissionRequest: {
                ...i.permissionRequest,
                outcome: { outcome: 'cancelled' },
              },
            };
          }
          return item;
        }),
      };
    });

    for (const cb of subscriptionCallbacks) {
      cb();
    }

    await permissionPromise;

    // The durable "waiting on you" marker rides the same meta write as the
    // status, so needs-you survives the heartbeat repairing status to idle.
    expect(sessionDoc.setStatus).toHaveBeenNthCalledWith(
      1,
      SessionStatusFactory.requestPermission(),
      expect.objectContaining({ awaitingUserSince: expect.any(Number) })
    );
    expect(notifyPermissionRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        sessionTitle: 'My Session',
        requestId: 'req-question',
        toolCallId: 'tc-question',
        toolTitle: 'Which database should we use?',
        requestKind: 'ask_user_question',
      })
    );
    expect(recordPermissionRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        requestId: 'req-question',
        toolCallId: 'tc-question',
      })
    );
    expect(resolvePermissionRequested).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId,
        requestId: 'req-question',
        toolCallId: 'tc-question',
      })
    );
  });

  it('does not restore running when session already transitioned to idle', async () => {
    const logger = createSilentLogger();

    const sessionId = 's-2' as SessionId;
    const workspaceId = 'ws-1' as WorkspaceId;
    const subscriptionCallbacks: Array<() => void> = [];

    let history: unknown[] = [
      {
        id: 'u-1',
        role: 'user',
        timestamp: new Date().toISOString(),
        read: true,
        userId: 'active-user',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
        finished: true,
      },
      {
        id: 'turn-1',
        role: 'assistant',
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        items: [],
        fileDiff: [],
      },
    ];

    const sessionDoc = {
      currentStatus: SessionStatusFactory.requestPermission(),
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
      waitUntilSynced: vi.fn(async () => true),
      setLastMessageAt: vi.fn(async () => {}),
      setStatus: vi.fn(async function (this: { currentStatus: unknown }, status: unknown) {
        this.currentStatus = status;
      }),
      getStatus: vi.fn(async function (this: { currentStatus: unknown }) {
        return this.currentStatus;
      }),
      getMetaState: vi.fn(async () => ({
        title: 'My Session',
        userId: 'meta-user',
        cliType: 'claude',
      })),
      getHistory: vi.fn(async () => history),
      mirror: {
        subscribe: vi.fn((callback: () => void) => {
          subscriptionCallbacks.push(callback);
          return () => {
            const idx = subscriptionCallbacks.indexOf(callback);
            if (idx >= 0) subscriptionCallbacks.splice(idx, 1);
          };
        }),
        getState: () => ({ history }),
      },
    };

    const workspaceDocument = {
      sessions: new Map<SessionId, unknown>(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      isTransportConnected: vi.fn(() => true),
      publishSessionPresence: vi.fn(),
      clearSessionPresence: vi.fn(),
    };

    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      hasSession: vi.fn(() => false),
      terminateSession: vi.fn(),
      archiveSession: vi.fn(),
      cleanUp: vi.fn(),
      setSessionError: vi.fn(),
    };

    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      logger,
      {
        token: 't',
        workspaceId,
        workspaceSlug: 'ws-slug',
        userId: 'device-owner',
        machineId: 'm-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort(),
      }
    );

    const request: RequestPermissionRequest = {
      sessionId,
      options: [{ kind: 'allow_once', name: 'Allow once', optionId: 'opt1' }],
      toolCall: { toolCallId: 'tc1', title: 'Read file', status: 'in_progress', kind: 'read' },
    };

    const host = handler as unknown as {
      handleAgentPermissionRequest: (
        sessionId: SessionId,
        requestId: string,
        request: RequestPermissionRequest
      ) => Promise<unknown>;
    };

    injectActivePresence(handler, sessionId);
    const permissionPromise = host.handleAgentPermissionRequest(sessionId, 'req1', request);
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Simulate external transition to idle before permission outcome arrives.
    sessionDoc.currentStatus = SessionStatusFactory.idle();

    history = history.map((entry) => {
      const e = entry as { items?: unknown[] };
      if (e.items) {
        return {
          ...e,
          items: e.items.map((item) => {
            const i = item as { type?: string; permissionRequest?: { requestId?: string } };
            if (i.type === 'tool_call' && i.permissionRequest?.requestId === 'req1') {
              return {
                ...i,
                permissionRequest: {
                  ...i.permissionRequest,
                  outcome: { outcome: 'cancelled' },
                },
              };
            }
            return item;
          }),
        };
      }
      return entry;
    });

    for (const cb of subscriptionCallbacks) {
      cb();
    }

    await permissionPromise;

    expect(sessionDoc.getStatus).toHaveBeenCalled();
    expect(sessionDoc.setStatus).not.toHaveBeenCalledWith(SessionStatusFactory.running());
  });

  it('cancels permission request instead of waiting when it cannot be persisted', async () => {
    const logger = createSilentLogger();

    const sessionId = 's-3' as SessionId;
    const workspaceId = 'ws-1' as WorkspaceId;

    let history: unknown[] = [
      {
        id: 'u-1',
        role: 'user',
        timestamp: new Date().toISOString(),
        read: true,
        userId: 'active-user',
        items: [{ type: 'text', text: 'hello' }],
        fileDiff: [],
        finished: true,
      },
    ];

    const sessionDoc = {
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
      waitUntilSynced: vi.fn(async () => true),
      setLastMessageAt: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      getMetaState: vi.fn(async () => ({
        title: 'My Session',
        userId: 'meta-user',
        cliType: 'claude',
      })),
      getHistory: vi.fn(async () => history),
      mirror: {
        subscribe: vi.fn(() => () => {}),
        getState: () => ({ history }),
      },
    };

    const workspaceDocument = {
      sessions: new Map<SessionId, unknown>(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      isTransportConnected: vi.fn(() => true),
    };

    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      hasSession: vi.fn(() => false),
      terminateSession: vi.fn(),
      archiveSession: vi.fn(),
      cleanUp: vi.fn(),
      setSessionError: vi.fn(),
    };
    const notifyPermissionRequested = vi.fn(async () => {});

    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      logger,
      {
        token: 't',
        workspaceId,
        workspaceSlug: 'ws-slug',
        userId: 'device-owner',
        machineId: 'm-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort({
          notifications: createNotificationPort({ notifyPermissionRequested }),
        }),
      }
    );

    const request: RequestPermissionRequest = {
      sessionId,
      options: [{ kind: 'allow_once', name: 'Allow once', optionId: 'opt1' }],
      toolCall: { toolCallId: 'tc1', title: 'Read file', status: 'in_progress', kind: 'read' },
    };

    const host = handler as unknown as {
      handleAgentPermissionRequest: (
        sessionId: SessionId,
        requestId: string,
        request: RequestPermissionRequest
      ) => Promise<unknown>;
    };

    await expect(host.handleAgentPermissionRequest(sessionId, 'req1', request)).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(sessionDoc.setStatus).not.toHaveBeenCalled();
    expect(notifyPermissionRequested).not.toHaveBeenCalled();
    expect(sessionDoc.mirror.subscribe).not.toHaveBeenCalled();
  });

  it('auto-approves tool permissions when the session run config opts out of prompts', async () => {
    const logger = createSilentLogger();
    const sessionId = 's-auto-approve' as SessionId;
    const workspaceId = 'ws-auto-approve' as WorkspaceId;

    let history: unknown[] = [
      {
        id: 'turn-auto',
        role: 'assistant',
        timestamp: new Date().toISOString(),
        read: undefined,
        userId: undefined,
        items: [],
        fileDiff: [],
      },
    ];
    const sessionDoc = {
      updateHistory: vi.fn(async (updater: (prev: unknown[]) => unknown[]) => {
        history = updater(history);
      }),
      waitUntilSynced: vi.fn(async () => true),
      setLastMessageAt: vi.fn(async () => {}),
      setStatus: vi.fn(async () => {}),
      getMetaState: vi.fn(async () => ({ title: 'Auto session', userId: 'meta-user' })),
      getHistory: vi.fn(async () => history),
      mirror: {
        subscribe: vi.fn(() => () => {}),
        getState: () => ({ history }),
      },
    };

    const workspaceDocument = {
      sessions: new Map<SessionId, unknown>(),
      repo: {
        watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
        getDocMeta: vi.fn(async () => ({ meta: { needToArchiveSessions: {} } })),
      },
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      isTransportConnected: vi.fn(() => true),
      publishSessionPresence: vi.fn(),
      clearSessionPresence: vi.fn(),
    };

    const sessionManager = {
      on: vi.fn(),
      setRequestPermissionHandler: vi.fn(),
      hasSession: vi.fn(() => false),
      terminateSession: vi.fn(),
      archiveSession: vi.fn(),
      cleanUp: vi.fn(),
      setSessionError: vi.fn(),
    };
    const notifyPermissionRequested = vi.fn(async () => {});

    const handler = new MessageHandler(
      sessionManager as unknown as SessionManager,
      workspaceDocument as unknown as LoroDocumentManager,
      logger,
      {
        token: 't',
        workspaceId,
        workspaceSlug: 'ws-slug',
        userId: 'device-owner',
        machineId: 'm-1',
        machineName: 'machine',
        cliVersion: '0.0.0',
        cloudPort: createTestCloudPort({
          notifications: createNotificationPort({ notifyPermissionRequested }),
        }),
      }
    );

    const request: RequestPermissionRequest = {
      sessionId,
      options: [{ kind: 'allow_once', name: 'Allow once', optionId: 'opt1' }],
      toolCall: { toolCallId: 'tc1', title: 'Execute shell', status: 'in_progress', kind: 'execute' },
    };

    const agentClient = {
      getConfigOptions: () => [
        {
          id: 'permission_mode',
          category: '_permission',
          type: 'select',
          currentValue: 'always-approve',
          name: 'Permission Mode',
          description: '',
          options: [],
        },
      ],
    };

    const host = handler as unknown as {
      handleAgentPermissionRequest: (
        sessionId: SessionId,
        requestId: string,
        request: RequestPermissionRequest,
        model?: unknown,
        agentClient?: typeof agentClient
      ) => Promise<unknown>;
    };

    injectActivePresence(handler, sessionId);
    await expect(
      host.handleAgentPermissionRequest(sessionId, 'req-auto', request, undefined, agentClient)
    ).resolves.toEqual({
      outcome: { outcome: 'selected', optionId: 'opt1' },
    });

    expect(sessionDoc.setStatus).not.toHaveBeenCalled();
    expect(notifyPermissionRequested).not.toHaveBeenCalled();
    expect(sessionDoc.mirror.subscribe).not.toHaveBeenCalled();
  });
});
