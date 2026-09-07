import { describe, expect, it, vi } from 'vitest';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import {
  SessionStatusFactory,
  type SessionId,
  type WorkspaceId,
  type SessionHistoryInput,
} from '@lody/shared';
import { MessageHandler } from '../src/lib/message-handler';
import type { AgentClient } from '../src/agent/agent-client';
import { getBuiltinToolPermissionOutcome } from '../src/agent/lody-acp-extension';
import {
  findPermissionOutcomeInHistory,
  updatePermissionOutcomeInHistory,
} from '../src/lib/acp/history';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import type { SessionDoc } from '../src/lib/loro/session-doc';
import type { SessionManager } from '../src/session/session-manager';
import type { Logger } from '../src/utils/logger';
import { createTestCloudPort } from './test-cloud-port';

// Permission tests need no code-collaboration database or user-profile writes.
vi.mock('../src/lib/code-collab/code-collab-v2-diff-store', () => ({
  CodeCollabV2DiffStore: class {
    async close() {}
  },
}));

const sessionId = 'grok-permission-session' as SessionId;
type Outcome = RequestPermissionResponse['outcome'];
const once: Outcome = { outcome: 'selected', optionId: 'once' };
const request = (id: string): RequestPermissionRequest => ({
  sessionId,
  toolCall: { toolCallId: id, title: 'Execute', kind: 'execute', status: 'in_progress' },
  options: [
    { kind: 'allow_always', optionId: 'always', name: 'Always allow' },
    { kind: 'allow_once', optionId: 'once', name: 'Allow once' },
    { kind: 'reject_once', optionId: 'reject', name: 'Reject' },
  ],
});

function fixture(initialMode = 'ask') {
  const logger: Logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    success: vi.fn(),
    debug: vi.fn(),
    setLevel: vi.fn(),
    child: () => logger,
    close: async () => {},
  };
  let history: unknown[] = [
    {
      id: 'assistant-turn',
      role: 'assistant',
      timestamp: '2026-01-01T00:00:00.000Z',
      items: [],
      fileDiff: [],
    },
  ];
  let awaitingUser = false;
  const historyListeners = new Set<() => void>();
  const historyWaiting = new Map<number, () => void>();
  const configListeners = new Set<() => void>();
  const waiting = new Map<number, () => void>();
  let mode = initialMode;
  let permissionHandler:
    | ((
        id: SessionId,
        requestId: string,
        req: RequestPermissionRequest,
        client: AgentClient
      ) => Promise<RequestPermissionResponse>)
    | undefined;
  const doc = {
    updateHistory: vi.fn(async (update: (prev: unknown[]) => unknown[]) => {
      history = update(history);
      for (const listener of historyListeners) listener();
    }),
    setLastMessageAt: async () => {},
    getMetaState: async () => ({ title: 'Synthetic session', userId: 'user' }),
    getHistory: async () => history,
    setStatus: vi.fn(async (_status: unknown, meta?: { awaitingUserSince?: number }) => {
      if (meta?.awaitingUserSince) awaitingUser = true;
    }),
    clearAwaitingUser: async () => {
      awaitingUser = false;
    },
    mirror: {
      subscribe: (listener: () => void) => {
        historyListeners.add(listener);
        historyWaiting.get(historyListeners.size)?.();
        return () => {
          historyListeners.delete(listener);
        };
      },
      getState: () => ({ history }),
    },
  };
  const workspace = {
    sessions: new Map(),
    repo: {
      watch: () => ({ unsubscribe: () => {} }),
      getDocMeta: async () => ({ meta: { needToArchiveSessions: {} } }),
    },
    getOrCreateSessionDoc: async () => doc,
    isTransportConnected: () => false,
    publishSessionPresence: () => {},
    clearSessionPresence: () => {},
  };
  const manager = {
    on: () => {},
    setRequestPermissionHandler: (handler: typeof permissionHandler) => {
      permissionHandler = handler;
    },
  };
  const handler = new MessageHandler(
    manager as unknown as SessionManager,
    workspace as unknown as LoroDocumentManager,
    logger,
    {
      workspaceId: 'workspace' as WorkspaceId,
      userId: 'user',
      machineId: 'machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort({ notifications: null }),
    }
  );
  const client: Pick<AgentClient, 'getAutomaticToolPermissionOutcome' | 'subscribeConfigOptions'> =
    {
      getAutomaticToolPermissionOutcome: (req, pending) =>
        getBuiltinToolPermissionOutcome({
          agentConfig: { cliType: 'builtin', agentType: 'grok' },
          request: req,
          pending,
          configOptions: [
            {
              id: 'permission_mode',
              name: 'Permissions',
              type: 'select',
              category: '_permission',
              currentValue: mode,
              options: [],
            },
          ],
        }),
      subscribeConfigOptions: (listener) => {
        configListeners.add(listener);
        waiting.get(configListeners.size)?.();
        return () => {
          configListeners.delete(listener);
        };
      },
    };
  // Keep running-status restoration on the same ownership path used in production.
  (
    handler as unknown as { startSessionActivePresence: (id: SessionId) => void }
  ).startSessionActivePresence(sessionId);
  return {
    doc,
    invoke: (req: RequestPermissionRequest) => {
      if (!permissionHandler) throw new Error('Permission handler was not registered');
      return permissionHandler(sessionId, req.toolCall.toolCallId, req, client as AgentClient);
    },
    setMode: (value: string) => {
      mode = value;
      for (const listener of configListeners) listener();
    },
    waitForPending: (count = 1) =>
      configListeners.size >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiting.set(count, resolve);
          }),
    waitForHistory: (count = 1) =>
      historyListeners.size >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            historyWaiting.set(count, resolve);
          }),
    outcome: (id: string) => findPermissionOutcomeInHistory(history as SessionHistoryInput[], id),
    answer: (id: string, outcome: Outcome) =>
      updatePermissionOutcomeInHistory(doc as unknown as SessionDoc, id, outcome, logger),
    state: () => ({
      awaitingUser,
      historySubscriptions: historyListeners.size,
      configSubscriptions: configListeners.size,
    }),
  };
}

describe('Grok Always Approve in the durable permission flow', () => {
  it('answers once without entering the waiting UI, and records the outcome', async () => {
    const f = fixture('always-approve');
    await expect(f.invoke(request('tool'))).resolves.toEqual({ outcome: once });
    expect(f.outcome('tool')).toEqual(once);
    expect(f.doc.setStatus).not.toHaveBeenCalled();
    expect(f.state()).toEqual({
      awaitingUser: false,
      historySubscriptions: 0,
      configSubscriptions: 0,
    });
  });

  it('drains multiple pending calls on a mode switch and clears waiting state and subscriptions', async () => {
    const f = fixture();
    const first = f.invoke(request('first'));
    await f.waitForPending();
    const second = f.invoke(request('second'));
    await f.waitForPending(2);
    expect(f.state().awaitingUser).toBe(true);
    f.setMode('always-approve');
    await expect(Promise.all([first, second])).resolves.toEqual([
      { outcome: once },
      { outcome: once },
    ]);
    expect(f.outcome('first')).toEqual(once);
    expect(f.outcome('second')).toEqual(once);
    expect(f.doc.setStatus).toHaveBeenLastCalledWith(SessionStatusFactory.running());
    expect(f.state()).toEqual({
      awaitingUser: false,
      historySubscriptions: 0,
      configSubscriptions: 0,
    });
  });

  it('asks again after leaving Always Approve and preserves an explicit rejection', async () => {
    const f = fixture('always-approve');
    await f.invoke(request('first'));
    f.setMode('ask');
    const next = f.invoke(request('second'));
    await f.waitForPending();
    expect(f.outcome('second')).toBeUndefined();
    const rejected: Outcome = { outcome: 'selected', optionId: 'reject' };
    await f.answer('second', rejected);
    f.setMode('always-approve');
    await expect(next).resolves.toEqual({ outcome: rejected });
    expect(f.outcome('second')).toEqual(rejected);
  });

  it('keeps a new request without AllowOnce interactive, then cancels it on a queue drain', async () => {
    const f = fixture('always-approve');
    const req = request('tool');
    req.options = req.options.filter((o) => o.kind !== 'allow_once');
    const pending = f.invoke(req);
    await f.waitForPending();
    expect(f.outcome('tool')).toBeUndefined();
    // A config snapshot with the same permission mode (e.g. a model change) is not a toggle.
    f.setMode('always-approve');
    expect(f.outcome('tool')).toBeUndefined();
    expect(f.state().awaitingUser).toBe(true);
    f.setMode('ask');
    f.setMode('always-approve');
    await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(f.outcome('tool')).toEqual({ outcome: 'cancelled' });
    expect(f.state().awaitingUser).toBe(false);
  });

  it('catches a mode change during history preparation before a listener exists', async () => {
    const f = fixture();
    const setStatus = f.doc.setStatus;
    setStatus.mockImplementationOnce(async () => {
      f.setMode('always-approve');
    });
    await expect(f.invoke(request('tool'))).resolves.toEqual({ outcome: once });
    expect(f.outcome('tool')).toEqual(once);
    expect(f.state()).toEqual({
      awaitingUser: false,
      historySubscriptions: 0,
      configSubscriptions: 0,
    });
  });

  it('does not run the tool if persisting automatic approval fails', async () => {
    const failed = fixture('always-approve');
    const write = failed.doc.updateHistory.getMockImplementation();
    failed.doc.updateHistory.mockImplementationOnce(async (update) => {
      await write?.(update);
    });
    failed.doc.updateHistory.mockRejectedValueOnce(new Error('disk unavailable'));
    await expect(failed.invoke(request('tool'))).resolves.toEqual({
      outcome: { outcome: 'cancelled' },
    });
    expect(failed.outcome('tool')).toBeUndefined();
  });

  it('keeps a user question waiting while other Grok tool requests drain', async () => {
    const f = fixture();
    const question = request('question');
    question._meta = {
      lody: {
        elicitation: {
          version: 1,
          questions: [
            { question: 'Which database?', header: 'Database', options: [{ label: 'Postgres' }] },
          ],
        },
      },
    };
    const pendingQuestion = f.invoke(question);
    await f.waitForHistory();
    const tool = f.invoke(request('tool'));
    await f.waitForPending();
    f.setMode('always-approve');
    await expect(tool).resolves.toEqual({ outcome: once });
    expect(f.outcome('question')).toBeUndefined();
    expect(f.state().awaitingUser).toBe(true);
    expect(f.doc.setStatus).not.toHaveBeenLastCalledWith(SessionStatusFactory.running());
    expect(f.state().historySubscriptions).toBe(1);
    await f.answer('question', { outcome: 'cancelled' });
    await expect(pendingQuestion).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
    expect(f.state()).toEqual({
      awaitingUser: false,
      historySubscriptions: 0,
      configSubscriptions: 0,
    });
  });

  it('unsubscribes on timeout so a later mode toggle cannot approve the expired call', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const f = fixture();
      const pending = f.invoke(request('expired'));
      await f.waitForPending();
      await vi.runOnlyPendingTimersAsync();
      await expect(pending).resolves.toEqual({ outcome: { outcome: 'cancelled' } });
      f.setMode('always-approve');
      expect(f.outcome('expired')).toEqual({ outcome: 'cancelled' });
      expect(f.state()).toEqual({
        awaitingUser: false,
        historySubscriptions: 0,
        configSubscriptions: 0,
      });
    } finally {
      vi.useRealTimers();
    }
  });
});
