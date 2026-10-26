import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import crypto from 'crypto';
import { RequestError } from '@agentclientprotocol/sdk';
import { LoroRepo } from 'loro-repo';
import { getSessionRoomId, type ACPSessionId, type MachineId } from '@lody/shared';

import type {
  AcpSessionNotification,
  MessageContent,
  SessionHistoryInput,
  SessionFilePayload,
  SessionId,
  WorkspaceId,
} from '@lody/shared';

import type { SessionUsageUpdate } from 'acp-extension-core';
import type { TurnOutcomeFact } from '@lody/shared/notifications';
import { MessageHandler } from '../src/lib/message-handler';
import { SessionDocument } from '../src/lib/loro/doc';
import type { LoroDocumentManager } from '../src/lib/loro/doc';
import { SessionManager } from '../src/session/session-manager';
import { Session } from '../src/session/session';
import { createNoopSessionSandbox } from '../src/session/session-sandbox';
import type { SessionConfig } from '../src/session/types';
import { AgentClient } from '../src/agent/agent-client';
import type {
  SessionExecutionService,
  SessionExecutionServiceDeps,
} from '../src/session/session-execution-service';
import type { SessionTransientStore } from '../src/lib/session-transient-store';
import type { SessionActivePresenceControllerLegacy } from '../src/lib/loro/session-active-presence-legacy';
import type { Logger } from '../src/utils/logger';
import { loadEnv } from '../src/utils/const';
import { createTestCloudPort } from './test-cloud-port';
import { isSessionContextCompacting } from '../../../packages/components/src/lib/session-context-compaction';
import { createConversationViewFromReader } from '../../../packages/components/src/lib/conversation-view/create-conversation-view-from-reader';
import { resolveActiveAssistantTurnIdFromIndex } from '../../../packages/components/src/lib/conversation-view/index-queries';

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

const readItems = (entry: SessionHistoryInput | undefined): MessageContent[] => {
  if (!entry || !Array.isArray(entry.items)) {
    return [];
  }
  return entry.items as unknown as MessageContent[];
};

type UploadValidatedSessionFileForTest = (args: {
  workspaceId: WorkspaceId;
  sessionId: SessionId;
  file: {
    absolutePath: string;
    fileName: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    textPreview: boolean;
  };
}) => Promise<SessionFilePayload & { downloadUrl: string }>;

const originalLodyServerUrl = process.env.LODY_SERVER_URL;

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

// loro-repo >= 0.16.11 resolves create()/initOffline()/destroy() on the real clock
// (native libuv async), NOT via the timers vitest fakes. Awaiting them while fake
// timers are installed leaves the resolution to real wall time, which on a loaded CI
// runner can be starved past the 30s test timeout. So run repo setup/teardown on real
// timers and only keep the fake clock for the batch-window assertions.
const destroyRepoOnRealTimers = async (repo: LoroRepo) => {
  if (vi.isFakeTimers()) {
    vi.useRealTimers();
  }
  await repo.destroy();
};

const createHandlerHarness = async (
  sessionIds: SessionId[],
  createManager?: (logger: Logger, document: LoroDocumentManager) => SessionManager
) => {
  const logger = createSilentLogger();
  const fakeTimersActive = vi.isFakeTimers();
  if (fakeTimersActive) {
    vi.useRealTimers();
  }
  const repo = await LoroRepo.create({});
  const docs = new Map<SessionId, SessionDocument>();
  for (const sessionId of sessionIds) {
    const doc = new SessionDocument(repo, sessionId);
    await doc.initOffline();
    docs.set(sessionId, doc);
  }
  if (fakeTimersActive) {
    vi.useFakeTimers();
  }

  const workspaceDocument = {
    isTransportConnected: vi.fn(() => true),
    markMachineFlockDocDirty: vi.fn(),
    registerMachine: vi.fn(),
    repo: {
      watch: vi.fn(() => ({ unsubscribe: vi.fn() })),
      getDocMeta: vi.fn(async () => ({
        meta: {
          needToArchiveSessions: {},
          needToDeleteSessions: {},
        },
      })),
    },
    getOrCreateSessionDoc: vi.fn(async (sessionId: SessionId) => {
      const doc = docs.get(sessionId);
      if (!doc) {
        throw new Error(`Missing session doc for ${sessionId}`);
      }
      return doc;
    }),
  };

  const sessionManagerMock = {
    on: vi.fn(),
    setRequestPermissionHandler: vi.fn(),
    getSession: vi.fn(() => null),
    cleanUp: vi.fn(async () => {}),
  };

  const sessionManager =
    createManager?.(logger, workspaceDocument as unknown as LoroDocumentManager) ??
    (sessionManagerMock as unknown as SessionManager);
  const handler = new MessageHandler(
    sessionManager,
    workspaceDocument as unknown as LoroDocumentManager,
    logger,
    {
      token: 't',
      workspaceId: 'ws-1' as WorkspaceId,
      userId: 'u-1',
      machineId: 'm-1',
      machineName: 'machine',
      cliVersion: '0.0.0',
      cloudPort: createTestCloudPort({
        attachmentUpload: { serverBaseUrl: 'https://uploads.example.test' },
      }),
    }
  );

  return {
    repo,
    docs,
    workspaceDocument,
    sessionManager,
    sessionManagerMock,
    handler,
  };
};

// Keep lifecycle forwarding, finalization, history storage and renderer projection
// real. Only ACP preparation, the provider and Git observation are synthetic.
const createRecoveryHarness = async (
  options: {
    resume?: boolean;
    promptError?: Error;
    priorOutput?: string;
    updates?: AcpSessionNotification['update'][];
    completeNormally?: boolean;
    flushBeforeReturn?: boolean;
    onPrompt?: () => Promise<void>;
    retryError?: Error;
    cleanup?: () => Promise<void>;
  } = {}
) => {
  const fakeTimersActive = vi.isFakeTimers();
  if (fakeTimersActive) vi.useRealTimers();
  const sessionId = 'stale-recovery' as SessionId;
  const userTurnId = 'recovery-input';
  const turnId = `assistant:${userTurnId}`;
  const harness = await createHandlerHarness(
    [sessionId],
    (logger, document) =>
      new SessionManager(logger, 't', 'm-1' as MachineId, 'ws-1' as WorkspaceId, document, {
        cloudPort: createTestCloudPort(),
      })
  );
  const doc = harness.docs.get(sessionId);
  if (!doc) throw new Error('Missing recovery doc');
  const { repo, workspaceDocument, handler, sessionManager: manager } = harness;
  await repo.upsertDocMeta(getSessionRoomId(sessionId), {
    id: sessionId,
    machineId: 'm-1',
    userId: 'u-1',
    cliType: 'builtin',
    agentType: 'codex',
    ...(options.resume ? { acpSessionId: 'acp-old' } : {}),
  });
  await doc.sessionData.commands.applyHistoryAction({
    kind: 'upsert-turn',
    turn: {
      id: userTurnId,
      role: 'user',
      status: 'pending',
      read: false,
      timestamp: '2026-10-17T00:00:00.000Z',
      items: [{ type: 'text', text: 'continue the synthetic task' }],
    } as SessionHistoryInput,
  });
  Object.assign(workspaceDocument.repo, {
    getDocMeta: repo.getDocMeta.bind(repo),
    upsertDocMeta: repo.upsertDocMeta.bind(repo),
    openFlockDoc: async () => ({ flock: { scan: () => [] } }),
  });
  Object.assign(workspaceDocument, {
    publishSessionPresence: () => {},
    clearSessionPresence: () => {},
    updateAcpCapabilities: async () => {},
  });
  const logger = createSilentLogger();
  const managerHost = manager as unknown as {
    sessions: Map<SessionId, Session>;
    registerSessionEvents(session: Session): void;
  };
  const host = handler as unknown as {
    executionService: SessionExecutionService;
    store: SessionTransientStore;
    sessionActivePresence: SessionActivePresenceControllerLegacy;
    machineFlockCommandWatcher: { stop(): void };
    flushACPUpdatesNow(id: SessionId): Promise<void>;
  };
  host.machineFlockCommandWatcher.stop();
  const service = host.executionService;
  const outcomes: TurnOutcomeFact[] = [];
  const deps = (service as unknown as { deps: SessionExecutionServiceDeps }).deps;
  Object.assign(deps, {
    syncSessionBranchName: async () => null,
    syncLiveActivitySummary: async () => {},
    processMessageQueue: async () => {},
    maybeGenerateAndStoreSessionTitle: async () => {},
    evictForMemoryPressure: async () => ({
      availableMemoryBytes: 4 * 1024 ** 3,
      thresholdBytes: 1024 ** 3,
      hadMemoryPressure: false,
      stillUnderPressure: false,
      evictedSessionIds: [],
      pressureReason: null,
    }),
  });
  Object.assign(deps.turnFinalization, {
    onTurnOutcome: async (fact: TurnOutcomeFact) => {
      outcomes.push(fact);
    },
    flushSessionUsage: async () => {},
    persistCodeCollabTurnDiffs: async () => false,
    updateSessionDiffStats: async () => [],
    detectAndAssociatePR: async () => null,
    syncWorkspaceGitState: async () => {},
    notifySessionCompleted: async () => {},
    refreshCodeCollabSharedState: async () => {},
  });
  const retryStarted = Promise.withResolvers<void>();
  const finishRetry = Promise.withResolvers<void>();
  const cleanupStarted = Promise.withResolvers<void>();
  const submissions: string[] = [];
  const makeSession = (replacement: boolean) => {
    const sandbox = createNoopSessionSandbox();
    if (!replacement && options.cleanup)
      sandbox.terminate = async () => {
        cleanupStarted.resolve();
        await options.cleanup?.();
      };
    const config: SessionConfig = {
      workspaceId: 'ws-1' as WorkspaceId,
      machineId: 'm-1' as MachineId,
      requesterUserId: 'u-1',
      userName: 'Synthetic User',
      userEmail: 'synthetic@example.test',
      sessionId,
      agentCliType: 'builtin',
      agentType: 'codex',
      mcpServerIds: [],
    };
    const session = new Session(config, logger, '/tmp', sandbox);
    session.acpSessionId = (replacement ? 'acp-replacement' : 'acp-old') as ACPSessionId;
    let promptPending = false;
    session.agentClient = {
      isCreated: () => true,
      getConfigOptions: () => [],
      currentModel: undefined,
      get pendingPromptCompletion() {
        return promptPending ? finishRetry.promise : null;
      },
      cancel: vi.fn(async () => {}),
      prompt: async () => {
        submissions.push(replacement ? 'replacement' : 'old');
        if (!replacement) {
          for (const update of options.updates ?? [])
            manager.emit('onACPUpdateMessage', sessionId, { sessionId, update });
          if (options.flushBeforeReturn) await host.flushACPUpdatesNow(sessionId);
          await options.onPrompt?.();
          if (options.completeNormally) return { stopReason: 'end_turn' };
          if (options.priorOutput)
            manager.emit('onACPUpdateMessage', sessionId, {
              sessionId,
              update: {
                sessionUpdate: 'agent_message_chunk',
                content: { type: 'text', text: options.priorOutput },
              },
            });
          throw options.promptError ?? new Error('ACP connection closed');
        }
        promptPending = true;
        retryStarted.resolve();
        if (options.retryError) {
          promptPending = false;
          throw options.retryError;
        }
        try {
          await finishRetry.promise;
        } finally {
          promptPending = false;
        }
        return { stopReason: 'end_turn' };
      },
    } as unknown as AgentClient;
    vi.spyOn(session, 'exec').mockImplementation(async (command, args) =>
      command === 'git' && args.join(' ') === 'rev-parse HEAD' ? 'abc123\n' : ''
    );
    managerHost.sessions.set(sessionId, session);
    managerHost.registerSessionEvents(session);
    return session;
  };
  const originalSession = makeSession(false);
  vi.spyOn(manager, 'createSession').mockImplementation(async () => makeSession(true));
  const message: Parameters<SessionExecutionService['continueSession']>[0] = {
    type: 'session/chat',
    sessionId,
    machineId: 'm-1',
    workspaceId: 'ws-1' as WorkspaceId,
    userTurnId,
    userId: 'u-1',
    userName: 'Synthetic User',
    userEmail: 'synthetic@example.test',
    acpSessionConfig: {
      prompt: 'continue the synthetic task',
      cliType: 'builtin',
      agentType: 'codex',
    },
  };
  const emitText = (text: string) =>
    manager.emit('onACPUpdateMessage', sessionId, {
      sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
    });
  if (fakeTimersActive) vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  return {
    ...harness,
    doc,
    host,
    service,
    manager,
    originalSession,
    message,
    sessionId,
    turnId,
    retryStarted,
    finishRetry,
    cleanupStarted,
    submissions,
    outcomes,
    emitText,
    close: async () => {
      await host.sessionActivePresence.close();
      await destroyRepoOnRealTimers(repo);
    },
  };
};

const syntheticGeneratedImage = {
  imageId: 'generated-image',
  mimeType: 'image/png',
  fileName: 'result.png',
  sizeBytes: 68,
  width: 1,
  height: 1,
  downloadUrl: 'https://uploads.example.test/generated-image',
};
const syntheticImageGroup = {
  type: 'image_group' as const,
  images: [
    {
      imageId: 'generated-image',
      mimeType: 'image/png',
      fileName: 'result.png',
      sizeBytes: 68,
      width: 1,
      height: 1,
    },
  ],
};

// Exercise AgentClient's raw-tool suppression and the manager's real image callbacks.
const createImageClient = (h: Awaited<ReturnType<typeof createRecoveryHarness>>) => {
  const client = new AgentClient({
    sessionId: h.sessionId,
    logger: createSilentLogger(),
    terminalManager: {} as never,
    agentConfig: { cliType: 'builtin', agentType: 'codex' },
    onUpdateMessage: (update) => {
      h.manager.emit('onACPUpdateMessage', h.sessionId, update);
    },
    onImageGenerationBegin: (event) => {
      h.manager.emit('onImageGenerationBegin', h.sessionId, event);
    },
    onImageGenerationEnd: (event) => {
      h.manager.emit('onImageGenerationEnd', h.sessionId, event);
    },
  });
  (client as unknown as { acpSessionId: ACPSessionId }).acpSessionId = 'acp-old' as ACPSessionId;
  return {
    begin: () =>
      client.sessionUpdate({
        sessionId: 'acp-old',
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'image-call',
          title: 'Image generation',
          status: 'in_progress',
          _meta: { lody: { toolName: 'ImageGeneration' } },
        },
      }),
    end: (status: 'completed' | 'failed' = 'completed') =>
      client.sessionUpdate({
        sessionId: 'acp-old',
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'image-call',
          status,
          ...(status === 'completed'
            ? {
                content: [
                  {
                    type: 'content',
                    content: {
                      type: 'image',
                      mimeType: 'image/png',
                      data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
                    },
                  },
                ],
              }
            : {}),
        },
      }),
  };
};

describe('MessageHandler ACP batching', () => {
  it('image-only acceptance: persisted image content succeeds without ACP reply chunks', async () => {
    const h = await createRecoveryHarness({
      completeNormally: true,
      updates: [{ sessionUpdate: 'config_option_update', configOptions: [] }],
      onPrompt: async () => {
        const imageHost = h.handler as unknown as {
          appendAssistantImageGroupToActiveTurn(args: {
            sessionDoc: SessionDocument;
            turnId: string;
            content: typeof syntheticImageGroup;
          }): Promise<boolean>;
        };
        expect(
          await imageHost.appendAssistantImageGroupToActiveTurn({
            sessionDoc: h.doc,
            turnId: h.turnId,
            content: syntheticImageGroup,
          })
        ).toBe(true);
      },
    });
    try {
      await h.service.continueSession(h.message);
      const history = await h.doc.sessionData.history.readAll();
      expect(readItems(history.find((entry) => entry.id === h.turnId))).toEqual([
        syntheticImageGroup,
      ]);
      expect(history.find((entry) => entry.id === h.message.userTurnId)?.status).toBe('handled');
      expect(h.outcomes.map((fact) => fact.outcome)).toEqual([{ kind: 'succeeded' }]);
    } finally {
      await h.close();
    }
  });

  it.each(['success', 'upload-failed', 'write-refused', 'failed-status', 'begin-only'] as const)(
    'image lifecycle acceptance: $0 settles from persisted output after the upload tail',
    async (kind) => {
      const uploadStarted = Promise.withResolvers<void>();
      const allowUpload = Promise.withResolvers<void>();
      const observationStarted = Promise.withResolvers<void>();
      const h = await createRecoveryHarness({
        completeNormally: true,
        onPrompt: async () => {
          const images = createImageClient(h);
          await images.begin();
          if (kind !== 'begin-only')
            await images.end(kind === 'failed-status' ? 'failed' : 'completed');
        },
      });
      const imageHost = h.handler as unknown as {
        uploadSessionImageFile: () => Promise<typeof syntheticGeneratedImage>;
      };
      vi.spyOn(imageHost, 'uploadSessionImageFile').mockImplementation(async () => {
        uploadStarted.resolve();
        await allowUpload.promise;
        if (kind === 'upload-failed') throw new Error('Synthetic upload refused');
        if (kind === 'write-refused')
          await h.doc.sessionData.commands.applyHistoryAction({
            kind: 'remove-turn',
            turnId: h.turnId,
          });
        return syntheticGeneratedImage;
      });
      const observe = h.handler.observePromptContentForTurn.bind(h.handler);
      vi.spyOn(h.handler, 'observePromptContentForTurn').mockImplementation((...args) => {
        observationStarted.resolve();
        return observe(...args);
      });
      const running = h.service.continueSession(h.message);
      try {
        await Promise.race([
          observationStarted.promise,
          running.then(() => {
            throw new Error('Turn ended before content observation');
          }),
        ]);
        if (kind !== 'begin-only' && kind !== 'failed-status') {
          await uploadStarted.promise;
          expect(h.outcomes).toEqual([]);
          expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(true);
          expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(true);
        }
        allowUpload.resolve();
        await running;
        const success = kind === 'success';
        const history = await h.doc.sessionData.history.readAll();
        expect(readItems(history.find((entry) => entry.id === h.turnId))).toEqual(
          success ? [syntheticImageGroup] : []
        );
        expect(history.find((entry) => entry.id === h.message.userTurnId)?.status).toBe(
          success ? 'handled' : 'failed'
        );
        expect(h.outcomes.map((fact) => fact.outcome)).toEqual([
          success ? { kind: 'succeeded' } : { kind: 'failed', code: 'no_agent_output' },
        ]);
        expect(h.submissions).toEqual(['old']);
        expect(h.host.store.get(h.sessionId).imageGenerationUploads.size).toBe(0);
        expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(false);
        expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(false);
      } finally {
        allowUpload.resolve();
        await running;
        await h.close();
      }
    }
  );

  it.each([
    { sameId: false, endAfterSwitch: false },
    { sameId: true, endAfterSwitch: false },
    { sameId: false, endAfterSwitch: true },
    { sameId: true, endAfterSwitch: true },
  ])(
    'image epoch acceptance: late output cannot mark a successor (sameId=$sameId, endAfterSwitch=$endAfterSwitch)',
    async ({ sameId, endAfterSwitch }) => {
      const h = await createRecoveryHarness();
      const uploadStarted = Promise.withResolvers<void>();
      const allowUpload = Promise.withResolvers<void>();
      const imageHost = h.handler as unknown as {
        uploadSessionImageFile: () => Promise<typeof syntheticGeneratedImage>;
        flushCodexGeneratedImageUploads(id: SessionId): Promise<void>;
        hasPromptEventsForTurn(id: SessionId, turnId: string): boolean;
      };
      vi.spyOn(imageHost, 'uploadSessionImageFile').mockImplementation(async () => {
        uploadStarted.resolve();
        await allowUpload.promise;
        return syntheticGeneratedImage;
      });
      const nextId = sameId ? h.turnId : 'assistant:next';
      try {
        h.host.store.beginTurn(h.sessionId, { turnId: h.turnId });
        await h.doc.sessionData.commands.applyHistoryAction({
          kind: 'upsert-turn',
          turn: {
            id: h.turnId,
            timestamp: '2026-10-26T00:00:00.000Z',
            role: 'assistant',
            items: [],
            finished: false,
          } as SessionHistoryInput,
        });
        const images = createImageClient(h);
        await images.begin();
        if (!endAfterSwitch) {
          await images.end();
          await uploadStarted.promise;
        }
        h.host.store.clearTurnState(h.sessionId);
        h.host.store.beginTurn(h.sessionId, { turnId: nextId });
        if (!sameId)
          await h.doc.sessionData.commands.applyHistoryAction({
            kind: 'upsert-turn',
            turn: {
              id: nextId,
              timestamp: '2026-10-26T00:00:00.000Z',
              role: 'assistant',
              items: [],
              finished: false,
            } as SessionHistoryInput,
          });
        if (endAfterSwitch) {
          await images.end();
          await uploadStarted.promise;
        }
        allowUpload.resolve();
        await imageHost.flushCodexGeneratedImageUploads(h.sessionId);
        expect(await h.handler.observePromptContentForTurn(h.sessionId, nextId)).toBe(false);
        expect(imageHost.hasPromptEventsForTurn(h.sessionId, nextId)).toBe(false);
        const history = await h.doc.sessionData.history.readAll();
        expect(readItems(history.find((entry) => entry.id === nextId))).toEqual([]);
        if (!sameId)
          expect(readItems(history.find((entry) => entry.id === h.turnId))).toEqual([
            syntheticImageGroup,
          ]);
        expect(h.host.store.get(h.sessionId).imageGenerationUploads.size).toBe(0);
      } finally {
        allowUpload.resolve();
        await imageHost.flushCodexGeneratedImageUploads(h.sessionId);
        await h.close();
      }
    }
  );

  it('image epoch acceptance: generation begun without an active owner stays outside the next turn', async () => {
    const h = await createRecoveryHarness();
    const imageHost = h.handler as unknown as {
      uploadSessionImageFile: () => Promise<typeof syntheticGeneratedImage>;
      flushCodexGeneratedImageUploads(id: SessionId): Promise<void>;
    };
    vi.spyOn(imageHost, 'uploadSessionImageFile').mockResolvedValue(syntheticGeneratedImage);
    try {
      h.host.store.beginTurn(h.sessionId, { turnId: 'old-turn' });
      const old = h.host.store.getCurrentACPUpdateTarget(h.sessionId);
      if (!old) throw new Error('Missing synthetic target');
      h.host.store.rememberFinalizedTurnForLateACPUpdates(h.sessionId, old);
      h.host.store.clearTurnState(h.sessionId);
      const images = createImageClient(h);
      await images.begin();
      h.host.store.beginTurn(h.sessionId, { turnId: 'next-turn' });
      await images.end();
      await imageHost.flushCodexGeneratedImageUploads(h.sessionId);
      const history = await h.doc.sessionData.history.readAll();
      const imageEntry = history.find((entry) =>
        readItems(entry).some((item) => item.type === 'image_group')
      );
      expect(imageEntry?.id).toMatch(/^assistant-image-/);
      expect(readItems(imageEntry)).toEqual([syntheticImageGroup]);
      expect(await h.handler.observePromptContentForTurn(h.sessionId, 'next-turn')).toBe(false);
    } finally {
      await imageHost.flushCodexGeneratedImageUploads(h.sessionId);
      await h.close();
    }
  });

  it('image cancellation acceptance: Stop retains ownership until the upload drains', async () => {
    const uploadStarted = Promise.withResolvers<void>();
    const allowUpload = Promise.withResolvers<void>();
    const observationStarted = Promise.withResolvers<void>();
    const h = await createRecoveryHarness({
      completeNormally: true,
      onPrompt: async () => {
        const images = createImageClient(h);
        await images.begin();
        await images.end();
      },
    });
    const imageHost = h.handler as unknown as {
      uploadSessionImageFile: () => Promise<typeof syntheticGeneratedImage>;
    };
    vi.spyOn(imageHost, 'uploadSessionImageFile').mockImplementation(async () => {
      uploadStarted.resolve();
      await allowUpload.promise;
      return syntheticGeneratedImage;
    });
    const observe = h.handler.observePromptContentForTurn.bind(h.handler);
    vi.spyOn(h.handler, 'observePromptContentForTurn').mockImplementation((...args) => {
      observationStarted.resolve();
      return observe(...args);
    });
    const running = h.service.continueSession(h.message);
    try {
      await observationStarted.promise;
      await uploadStarted.promise;
      await h.service.cancelSession({
        type: 'session/cancel',
        sessionId: h.sessionId,
        turnId: h.turnId,
        machineId: 'm-1',
        workspaceId: 'ws-1' as WorkspaceId,
      });
      expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(true);
      expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(true);
      expect(h.outcomes).toEqual([]);
      allowUpload.resolve();
      await running;
      expect(
        (await h.doc.sessionData.history.readAll()).find(
          (entry) => entry.id === h.message.userTurnId
        )?.status
      ).toBe('canceled');
      expect(h.outcomes.map((fact) => fact.outcome.kind)).toEqual(['cancelled']);
      expect(h.host.store.get(h.sessionId).imageGenerationUploads.size).toBe(0);
      expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(false);
      expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(false);
    } finally {
      allowUpload.resolve();
      await running;
      await h.close();
    }
  });

  it('image lifecycle events prevent stale prompt replay even when no image is produced', async () => {
    const h = await createRecoveryHarness({
      onPrompt: async () => {
        const images = createImageClient(h);
        await images.begin();
        await images.end('failed');
      },
    });
    h.finishRetry.resolve();
    try {
      await h.service.continueSession(h.message);
      expect(h.submissions).toEqual(['old']);
      expect(h.outcomes.map((fact) => fact.outcome)).toEqual([
        { kind: 'unknown', code: 'agent_disconnected' },
      ]);
    } finally {
      await h.close();
    }
  });

  it.each([false, true])(
    'silent-turn acceptance: metadata-only completion fails (flushed=%s)',
    async (flushBeforeReturn) => {
      const h = await createRecoveryHarness({
        completeNormally: true,
        flushBeforeReturn,
        updates: [
          { sessionUpdate: 'current_mode_update', currentModeId: 'auto' },
          { sessionUpdate: 'config_option_update', configOptions: [] },
          { sessionUpdate: 'available_commands_update', availableCommands: [] },
        ],
      });
      try {
        await h.service.continueSession(h.message);
        const history = await h.doc.sessionData.history.readAll();
        expect(history.find((entry) => entry.id === h.message.userTurnId)?.status).toBe('failed');
        expect(history.flatMap(readItems)).toContainEqual(
          expect.objectContaining({
            type: 'system_notice',
            name: 'chat_failed',
            meta: expect.objectContaining({ reason: 'agent_no_output' }),
          })
        );
        expect(h.submissions).toEqual(['old']);
        expect(h.outcomes.map((fact) => fact.outcome)).toEqual([
          { kind: 'failed', code: 'no_agent_output' },
        ]);
        expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(false);
        expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(false);
        expect(h.host.store.get(h.sessionId).acpUpdateBuffer).toEqual([]);
      } finally {
        await h.close();
      }
    }
  );

  it.each<{ name: string; updates: AcpSessionNotification['update'][]; visible: boolean }>([
    { name: 'no events', updates: [], visible: false },
    {
      name: 'empty text',
      updates: [{ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: '' } }],
      visible: false,
    },
    {
      name: 'whitespace thought',
      updates: [{ sessionUpdate: 'agent_thought_chunk', content: { type: 'text', text: ' \n' } }],
      visible: false,
    },
    {
      name: 'usage',
      updates: [{ sessionUpdate: 'usage_update', used: 10, size: 100 }],
      visible: false,
    },
    {
      name: 'title',
      updates: [{ sessionUpdate: 'session_info_update', title: 'Synthetic title' }],
      visible: false,
    },
    {
      name: 'user echo',
      updates: [{ sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'echo' } }],
      visible: false,
    },
    {
      name: 'checklist',
      updates: [
        {
          sessionUpdate: 'plan',
          entries: [{ content: 'Investigate', priority: 'medium', status: 'in_progress' }],
        },
      ],
      visible: false,
    },
    {
      name: 'ACP 1.3 checklist',
      updates: [
        { sessionUpdate: 'plan_update', plan: { type: 'items', planId: 'plan', entries: [] } },
      ],
      visible: false,
    },
    {
      name: 'file plan',
      updates: [
        {
          sessionUpdate: 'plan_update',
          plan: { type: 'file', planId: 'plan', path: '/tmp/synthetic-plan.md' },
        },
      ],
      visible: false,
    },
    {
      name: 'removed plan',
      updates: [{ sessionUpdate: 'plan_removed', planId: 'plan' }],
      visible: false,
    },
    {
      name: 'empty markdown plan',
      updates: [
        { sessionUpdate: 'plan_update', plan: { type: 'markdown', planId: 'plan', content: '' } },
      ],
      visible: false,
    },
    {
      name: 'answer',
      updates: [
        {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'Synthetic answer' },
        },
      ],
      visible: true,
    },
    {
      name: 'thought',
      updates: [
        {
          sessionUpdate: 'agent_thought_chunk',
          content: { type: 'text', text: 'Synthetic reasoning' },
        },
      ],
      visible: true,
    },
    {
      name: 'markdown proposal',
      updates: [
        {
          sessionUpdate: 'plan_update',
          plan: { type: 'markdown', planId: 'plan', content: 'A readable proposal' },
        },
      ],
      visible: true,
    },
    {
      name: 'tool only',
      updates: [
        {
          sessionUpdate: 'tool_call',
          toolCallId: 'tool',
          title: 'Synthetic tool',
          status: 'completed',
        },
      ],
      visible: true,
    },
    {
      name: 'sparse failed tool',
      updates: [{ sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'failed' }],
      visible: true,
    },
  ])('silent-turn content contract: $name', async ({ updates, visible }) => {
    const h = await createRecoveryHarness({ completeNormally: true, updates });
    try {
      await h.service.continueSession(h.message);
      const history = await h.doc.sessionData.history.readAll();
      expect(history.find((entry) => entry.id === h.message.userTurnId)?.status).toBe(
        visible ? 'handled' : 'failed'
      );
      expect(history.find((entry) => entry.id === h.turnId)?.finished).toBe(true);
      expect(h.outcomes.map((fact) => fact.outcome)).toEqual([
        visible ? { kind: 'succeeded' } : { kind: 'failed', code: 'no_agent_output' },
      ]);
      expect(h.submissions).toEqual(['old']);
      expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(false);
      expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it.each<AcpSessionNotification['update']>([
    { sessionUpdate: 'current_mode_update', currentModeId: 'auto' },
    { sessionUpdate: 'plan', entries: [] },
    { sessionUpdate: 'tool_call_update', toolCallId: 'tool', status: 'completed' },
  ])('never replays a disconnected prompt after $sessionUpdate', async (update) => {
    const h = await createRecoveryHarness({ updates: [update] });
    h.finishRetry.resolve();
    try {
      await h.service.continueSession(h.message);
      expect(h.submissions).toEqual(['old']);
      expect(h.outcomes.map((fact) => fact.outcome)).toEqual([
        { kind: 'unknown', code: 'agent_disconnected' },
      ]);
      expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(false);
      expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(false);
    } finally {
      await h.close();
    }
  });

  it.each(['snapshot', 'progress', 'text', 'rich', 'tool'] as const)(
    'subagent content observation distinguishes $0 from lifecycle status',
    async (kind) => {
      const sessionId = 'stale-recovery';
      const snapshot: AcpSessionNotification['update'] = {
        sessionUpdate: 'subagent_event',
        event: {
          version: 1,
          sessionId,
          runId: 'child',
          type: 'snapshot',
          snapshot: {
            state: 'running',
            support: {
              stream: ['text', 'tool'],
              progress: true,
              outputRead: 'live_tail',
              cancel: true,
            },
          },
        },
      };
      const updates: AcpSessionNotification['update'][] = [snapshot];
      if (kind === 'progress')
        updates.push({
          sessionUpdate: 'subagent_event',
          event: {
            version: 1,
            sessionId,
            runId: 'child',
            type: 'progress',
            progress: { totalTokens: 12 },
          },
        });
      if (kind === 'text' || kind === 'rich' || kind === 'tool')
        updates.push({
          sessionUpdate: 'subagent_event',
          event: {
            version: 1,
            sessionId,
            runId: 'child',
            type: 'output',
            update:
              kind === 'tool'
                ? {
                    sessionUpdate: 'tool_call_update',
                    toolCallId: 'child-tool',
                    status: 'completed',
                  }
                : {
                    sessionUpdate: 'agent_message_chunk',
                    content:
                      kind === 'text'
                        ? { type: 'text', text: 'Child answer' }
                        : { type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' },
                  },
          },
        });
      const h = await createRecoveryHarness({ updates, completeNormally: true });
      try {
        await h.service.continueSession(h.message);
        const visible = kind === 'text' || kind === 'tool';
        expect(h.outcomes.map((fact) => fact.outcome)).toEqual([
          visible ? { kind: 'succeeded' } : { kind: 'failed', code: 'no_agent_output' },
        ]);
        const items = (await h.doc.sessionData.history.readAll()).flatMap(readItems);
        expect(items).toContainEqual(
          expect.objectContaining({ type: 'subagent_task', taskId: 'child' })
        );
      } finally {
        await h.close();
      }
    }
  );

  it('keeps content through flush and isolates next-turn, late and suppressed events', async () => {
    const sessionId = 'observations' as SessionId;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const host = handler as unknown as {
      store: SessionTransientStore;
      enqueueACPUpdate(id: SessionId, update: AcpSessionNotification): void;
      flushACPUpdatesNow(id: SessionId): Promise<void>;
      hasPromptEventsForTurn(id: SessionId, turnId: string): boolean;
    };
    const enqueue = (text: string) =>
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
      });
    try {
      expect(await handler.observePromptContentForTurn(sessionId, 'first')).toBeUndefined();
      expect(host.hasPromptEventsForTurn(sessionId, 'first')).toBe(true);
      host.store.beginTurn(sessionId, { turnId: 'first' });
      expect(await handler.observePromptContentForTurn(sessionId, 'first')).toBe(false);
      expect(host.hasPromptEventsForTurn(sessionId, 'first')).toBe(false);
      enqueue('first answer');
      expect(await handler.observePromptContentForTurn(sessionId, 'first')).toBe(true);
      await host.flushACPUpdatesNow(sessionId);
      expect(await handler.observePromptContentForTurn(sessionId, 'first')).toBe(true);
      host.store.markPromptReturned(sessionId, 'first');
      const target = host.store.getCurrentACPUpdateTarget(sessionId);
      if (!target) throw new Error('Missing synthetic target');
      host.store.rememberFinalizedTurnForLateACPUpdates(sessionId, target);
      host.store.clearTurnState(sessionId);
      host.store.beginTurn(sessionId, { turnId: 'second', ownsACPUpdates: false });
      enqueue('late first answer');
      await host.flushACPUpdatesNow(sessionId);
      expect(await handler.observePromptContentForTurn(sessionId, 'first')).toBeUndefined();
      expect(await handler.observePromptContentForTurn(sessionId, 'second')).toBe(false);
      host.store.activateTurnACPUpdateTarget(sessionId, 'second');
      host.store.beginAcpReplaySuppression(sessionId);
      enqueue('native replay');
      host.store.endAcpReplaySuppression(sessionId);
      expect(await handler.observePromptContentForTurn(sessionId, 'second')).toBe(false);
      host.store.clearTurnState(sessionId);
      expect(await handler.observePromptContentForTurn(sessionId, 'second')).toBeUndefined();
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('isolates a malformed tool notification and continues flushing valid output', async () => {
    const sessionId = 'poison-session' as SessionId;
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) throw new Error('Missing synthetic doc');
    const host = handler as unknown as {
      beginConversationTurn(id: SessionId): string;
      enqueueACPUpdate(id: SessionId, update: AcpSessionNotification): void;
      flushACPUpdatesNow(id: SessionId): Promise<void>;
      store: { get(id: SessionId): { acpUpdateBuffer: unknown[] } };
    };
    try {
      host.beginConversationTurn(sessionId);
      const text = (value: string): AcpSessionNotification => ({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } },
      });
      host.enqueueACPUpdate(sessionId, text('before'));
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'bad-tool',
          title: 'Synthetic',
          kind: 'execute',
          status: 'in_progress',
          content: [{ type: 'content', content: { type: 'text', text: 42 } }],
        },
      } as unknown as AcpSessionNotification);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'bad-location',
          title: 'Synthetic',
          kind: 'other',
          status: 'in_progress',
          locations: [{ path: 'synthetic.ts', line: 'invalid' }],
        },
      } as unknown as AcpSessionNotification);
      host.enqueueACPUpdate(sessionId, text('after'));
      await host.flushACPUpdatesNow(sessionId);
      expect(host.store.get(sessionId).acpUpdateBuffer).toEqual([]);
      expect(readItems((await doc.sessionData.history.readAll())[0])).toEqual([
        { type: 'text', text: 'beforeafter' },
      ]);
      host.enqueueACPUpdate(sessionId, text('later'));
      await host.flushACPUpdatesNow(sessionId);
      expect(readItems((await doc.sessionData.history.readAll())[0])).toEqual([
        { type: 'text', text: 'beforeafterlater' },
      ]);
      expect(host.store.get(sessionId).acpUpdateBuffer).toEqual([]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  beforeEach(() => {
    vi.useFakeTimers();
    process.env.LODY_SERVER_URL = 'https://server.example.test';
    loadEnv();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.unstubAllGlobals();
    if (originalLodyServerUrl === undefined) {
      delete process.env.LODY_SERVER_URL;
    } else {
      process.env.LODY_SERVER_URL = originalLodyServerUrl;
    }
    loadEnv();
  });

  it.each([false, true])(
    'keeps a stale ACP retry in its unfinished turn (resume=%s)',
    async (resume) => {
      const h = await createRecoveryHarness({ resume });
      const running = h.service.continueSession(h.message);
      try {
        await Promise.race([
          h.retryStarted.promise,
          running.then(() => {
            throw new Error('Turn ended before retry');
          }),
        ]);
        expect(h.submissions).toEqual(['old', 'replacement']);
        expect(h.host.store.getCurrentACPUpdateTarget(h.sessionId)).toMatchObject({
          assistantEntryId: h.turnId,
          source: 'active_turn',
        });
        expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(true);
        h.emitText('replacement ');
        h.emitText('output');
        await h.host.flushACPUpdatesNow(h.sessionId);
        const history = await h.doc.sessionData.history.readAll();
        const assistant = history.find((entry) => entry.id === h.turnId);
        expect(assistant?.finished).not.toBe(true);
        expect(readItems(assistant)).toEqual([{ type: 'text', text: 'replacement output' }]);
        const view = createConversationViewFromReader(h.doc.sessionData.history, {
          sessionId: h.sessionId,
        });
        try {
          await vi.advanceTimersByTimeAsync(16);
          await view.ready;
          expect(resolveActiveAssistantTurnIdFromIndex(view)).toBe(h.turnId);
        } finally {
          view.dispose();
        }

        h.finishRetry.resolve();
        await running;
        const finished = await h.doc.sessionData.history.readAll();
        expect(finished.find((entry) => entry.id === h.turnId)?.finished).toBe(true);
        expect(finished.find((entry) => entry.id === h.message.userTurnId)?.status).toBe('handled');
        expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(false);
        // Confirm that a successful replacement remains reusable after this turn.
        expect(h.manager.getSession(h.sessionId)?.acpSessionId).toBe('acp-replacement');
      } finally {
        h.finishRetry.resolve();
        await running;
        await h.close();
      }
    }
  );

  it.each([new Error('ACP connection closed'), new RequestError(-32603, 'Session not found')])(
    'retains failed stale cleanup until its existing owner can release it (%s)',
    async (promptError) => {
      const allowCleanup = Promise.withResolvers<void>();
      const cleanupRetried = Promise.withResolvers<void>();
      let firstCleanup = true;
      const h = await createRecoveryHarness({
        promptError,
        cleanup: async () => {
          if (firstCleanup) {
            firstCleanup = false;
            throw new Error('Synthetic process survivor');
          }
          cleanupRetried.resolve();
          await allowCleanup.promise;
        },
      });
      const running = h.service.continueSession(h.message);
      try {
        await Promise.race([
          cleanupRetried.promise,
          running.then(() => {
            throw new Error('Released without retrying failed cleanup');
          }),
        ]);
        // The first failure cannot authorize replacement; the finalizer retries the
        // real Session termination and keeps the visible execution until it settles.
        expect(h.submissions).toEqual(['old']);
        expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(true);
        expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(true);
        allowCleanup.resolve();
        await running;
        expect(h.submissions).toEqual(['old']);
        expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(false);
        expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(false);
        expect(h.originalSession.agentClient).toBeNull();
      } finally {
        allowCleanup.resolve();
        await running;
        await h.close();
      }
    }
  );

  it.each([
    { priorOutput: 'already streamed', retryError: undefined, submitted: ['old'] },
    {
      priorOutput: undefined,
      retryError: new Error('ACP connection closed'),
      submitted: ['old', 'replacement'],
    },
  ])('does not replay after output or retry a second time ($submitted)', async (options) => {
    const h = await createRecoveryHarness(options);
    try {
      await h.service.continueSession(h.message);
      expect(h.submissions).toEqual(options.submitted);
      expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(false);
      if (options.priorOutput)
        expect(
          readItems(
            (await h.doc.sessionData.history.readAll()).find((entry) => entry.id === h.turnId)
          )
        ).toContainEqual({ type: 'text', text: options.priorOutput });
    } finally {
      await h.close();
    }
  });

  it('cancels and drains the replacement prompt after stale recovery', async () => {
    const h = await createRecoveryHarness({ resume: true });
    const running = h.service.continueSession(h.message);
    try {
      await Promise.race([
        h.retryStarted.promise,
        running.then(() => {
          throw new Error('Turn ended before retry');
        }),
      ]);
      await h.service.cancelSession({
        type: 'session/cancel',
        sessionId: h.sessionId,
        turnId: h.turnId,
        machineId: 'm-1',
        workspaceId: 'ws-1' as WorkspaceId,
      });
      // Cancel acknowledgement is distinct from completion of the raw prompt.
      // Its request is admitted synchronously, before the cancellation RPC returns.
      expect(h.manager.getSession(h.sessionId)?.agentClient?.cancel).toHaveBeenCalledWith(
        'acp-replacement'
      );
      expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(true);
      h.finishRetry.resolve();
      await running;
      expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(false);
      expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(false);
      expect(
        (await h.doc.sessionData.history.readAll()).find(
          (entry) => entry.id === h.message.userTurnId
        )?.status
      ).toBe('canceled');
    } finally {
      h.finishRetry.resolve();
      await running;
      await h.close();
    }
  });

  it('joins stale retirement after Stop without starting a replacement', async () => {
    const allowCleanup = Promise.withResolvers<void>();
    const h = await createRecoveryHarness({
      promptError: new RequestError(-32603, 'Session not found'),
      cleanup: () => allowCleanup.promise,
    });
    const running = h.service.continueSession(h.message);
    try {
      await h.cleanupStarted.promise;
      await h.service.cancelSession({
        type: 'session/cancel',
        sessionId: h.sessionId,
        turnId: h.turnId,
        machineId: 'm-1',
        workspaceId: 'ws-1' as WorkspaceId,
      });
      expect(h.submissions).toEqual(['old']);
      expect(h.host.sessionActivePresence.has(h.sessionId)).toBe(true);
      allowCleanup.resolve();
      await running;
      expect(h.submissions).toEqual(['old']);
      expect(h.service.getExecutionSnapshot(h.sessionId).hasActiveTurn).toBe(false);
      expect(
        (await h.doc.sessionData.history.readAll()).find(
          (entry) => entry.id === h.message.userTurnId
        )?.status
      ).toBe('canceled');
    } finally {
      allowCleanup.resolve();
      await running;
      await h.close();
    }
  });

  it('waits for the initial 10ms batch window before flushing ACP updates', async () => {
    const sessionId = 's-1' as SessionId;
    const { repo, docs, workspaceDocument, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' world' },
        },
      });

      expect(workspaceDocument.getOrCreateSessionDoc).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(5);

      expect(workspaceDocument.getOrCreateSessionDoc).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(10);

      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(1);

      const history = await doc.sessionData.history.readAll();
      const entry = history[0];
      const items = readItems(entry);
      expect(items).toEqual([{ type: 'text', text: 'hello world' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('uses a longer batch window after the first ACP flush in a turn', async () => {
    const sessionId = 's-1' as SessionId;
    const { repo, docs, workspaceDocument, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'hello' },
        },
      });

      await vi.advanceTimersByTimeAsync(15);
      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(1);

      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' again' },
        },
      });

      await vi.advanceTimersByTimeAsync(90);
      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(15);
      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(2);

      const history = await doc.sessionData.history.readAll();
      expect(readItems(history[0])).toEqual([{ type: 'text', text: 'hello again' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('flushes pending ACP updates during finalization without replaying them later', async () => {
    const sessionId = 's-1' as SessionId;
    const { repo, docs, workspaceDocument, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        finalizeACPState(sessionId: SessionId): Promise<void>;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'pending' },
        },
      });

      expect(workspaceDocument.getOrCreateSessionDoc).not.toHaveBeenCalled();

      await host.finalizeACPState(sessionId);

      const callCountAfterFinalize = workspaceDocument.getOrCreateSessionDoc.mock.calls.length;
      const historyAfterFinalize = await doc.sessionData.history.readAll();
      const entryAfterFinalize = historyAfterFinalize[0] as
        | (SessionHistoryInput & { finished?: boolean; endedAt?: number })
        | undefined;

      expect(readItems(entryAfterFinalize)).toEqual([{ type: 'text', text: 'pending' }]);
      expect(entryAfterFinalize?.finished).toBe(true);
      expect(typeof entryAfterFinalize?.endedAt).toBe('number');

      await vi.advanceTimersByTimeAsync(250);

      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(callCountAfterFinalize);

      const historyAfterTimerDrain = await doc.sessionData.history.readAll();
      expect(readItems(historyAfterTimerDrain[0])).toEqual([{ type: 'text', text: 'pending' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it.each([
    { reportsSessionActivity: true, restartsClock: true },
    { reportsSessionActivity: false, restartsClock: false },
  ])(
    'post-turn output restarts the GC idle clock only for activity-reporting agents (%o)',
    async ({ reportsSessionActivity, restartsClock }) => {
      const sessionId = 'late-output-activity' as SessionId;
      const { repo, handler, sessionManagerMock } = await createHandlerHarness([sessionId]);
      sessionManagerMock.getSession.mockImplementation(
        () => ({ agentClient: { reportsSessionActivity: () => reportsSessionActivity } }) as never
      );
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
      };
      const text = (value: string): AcpSessionNotification => ({
        sessionId,
        update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: value } },
      });

      try {
        const turnId = host.beginConversationTurn(sessionId);
        const beforeOutput = handler.getLastActivity(sessionId);
        await vi.advanceTimersByTimeAsync(1_000);
        // The open turn already keeps the session from GC.
        host.enqueueACPUpdate(sessionId, text('during the turn'));
        expect(handler.getLastActivity(sessionId)).toBe(beforeOutput);
        await host.finalizeACPState(sessionId, turnId);

        // Claude was woken later by a finished background shell.
        await vi.advanceTimersByTimeAsync(30 * 60 * 1000);
        host.enqueueACPUpdate(sessionId, text('after the background task'));
        expect(handler.getLastActivity(sessionId)).toBe(restartsClock ? Date.now() : beforeOutput);
      } finally {
        await destroyRepoOnRealTimers(repo);
      }
    }
  );

  it('records each turn its own token usage deltas, including late reports', async () => {
    vi.useRealTimers();
    const sessionId = 'turn-token-usage' as SessionId;
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) throw new Error(`Missing session doc for ${sessionId}`);
    const host = handler as unknown as {
      beginConversationTurn(sessionId: SessionId): string;
      createAssistantEntryForTurn(
        sessionId: SessionId,
        sessionDoc: SessionDocument,
        turnId: string
      ): Promise<void>;
      finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
      recordTurnTokenUsage(
        sessionId: SessionId,
        update: SessionUsageUpdate
      ): Promise<void> | undefined;
    };
    const row = (inputTokens: number, cacheReadInputTokens: number) => ({
      inputTokens,
      outputTokens: 20,
      cacheReadInputTokens,
      cacheCreationInputTokens: 5,
      reasoningOutputTokens: 7,
    });
    // Cumulative modelUsage is deliberately large: only `delta` is attributed.
    const report = (delta?: ReturnType<typeof row>): SessionUsageUpdate => ({
      sessionId,
      usage: row(1, 1),
      modelUsage: { model: row(900_000, 900_000) },
      ...(delta ? { delta: { usage: delta, modelUsage: { model: delta } } } : {}),
    });

    try {
      const first = host.beginConversationTurn(sessionId);
      await host.createAssistantEntryForTurn(sessionId, doc, first);
      await host.recordTurnTokenUsage(sessionId, report(row(100, 1000)));
      await host.recordTurnTokenUsage(sessionId, report(row(50, 2000)));
      await host.recordTurnTokenUsage(sessionId, report());
      await host.finalizeACPState(sessionId, first);
      // Background work reporting after the turn ended belongs to that turn.
      await host.recordTurnTokenUsage(sessionId, report(row(10, 0)));

      const second = host.beginConversationTurn(sessionId);
      await host.createAssistantEntryForTurn(sessionId, doc, second);
      await host.recordTurnTokenUsage(sessionId, report(row(3, 4)));
      await host.finalizeACPState(sessionId, second);

      const reopened = new SessionDocument(repo, sessionId, async () => {});
      await reopened.initOffline({ history: [] });
      const history = await reopened.sessionData.history.readAll();
      expect(history.find((entry) => entry.id === first)?.tokenUsage).toEqual({
        inputTokens: 160,
        outputTokens: 60,
        cacheReadInputTokens: 3000,
        cacheCreationInputTokens: 15,
        reasoningOutputTokens: 21,
        costUSD: null,
      });
      expect(history.find((entry) => entry.id === second)?.tokenUsage).toMatchObject({
        inputTokens: 3,
        cacheReadInputTokens: 4,
      });
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('settles an open compaction across finalization, reload, and later activity', async () => {
    vi.useRealTimers();
    const sessionId = 'compaction-lifecycle' as SessionId;
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) throw new Error(`Missing session doc for ${sessionId}`);
    const host = handler as unknown as {
      beginConversationTurn(sessionId: SessionId): string;
      enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
      finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
    };
    const findCompaction = (history: SessionHistoryInput[], toolCallId: string) =>
      history
        .flatMap((entry) => readItems(entry))
        .find(
          (item) =>
            item.type === 'tool_call' &&
            item.activityKind === 'context_compaction' &&
            item.toolCallId === toolCallId
        );

    try {
      const turnId = host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'compact-1',
          title: 'Context compacting',
          status: 'in_progress',
          _meta: { contextCompaction: true },
        },
      });
      await host.flushACPUpdatesNow(sessionId);
      expect(isSessionContextCompacting(await doc.sessionData.history.readAll())).toBe(true);

      // Nothing after the turn boundary can carry `compact-1` to a terminal
      // status, so finalization owns it: the durable record must not reload as
      // a compaction that is still running. Repeating the call is a no-op.
      await host.finalizeACPState(sessionId, turnId);
      await host.finalizeACPState(sessionId, turnId);

      const reopened = new SessionDocument(repo, sessionId, async () => {});
      await reopened.initOffline({ history: [] });
      const reloadedHistory = await reopened.sessionData.history.readAll();
      const reloadedTurn = reloadedHistory.find((entry) => entry.id === turnId);
      expect(reloadedTurn?.finished).toBe(true);
      expect(findCompaction(reloadedHistory, 'compact-1')).toMatchObject({ status: 'failed' });
      expect(isSessionContextCompacting(reloadedHistory)).toBe(false);

      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'compact-1',
          status: 'completed',
          _meta: { contextCompaction: true },
        },
      });
      await host.flushACPUpdatesNow(sessionId);
      const completedHistory = await doc.sessionData.history.readAll();
      const completedCompaction = findCompaction(completedHistory, 'compact-1');
      expect(completedCompaction).toMatchObject({ status: 'completed' });
      if (!completedCompaction || completedCompaction.type !== 'tool_call') {
        throw new Error('Missing completed context compaction');
      }
      expect(isSessionContextCompacting(completedHistory)).toBe(false);

      const nextTurnId = host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call',
          toolCallId: 'compact-2',
          title: 'Context compacting',
          status: 'in_progress',
          _meta: { contextCompaction: true },
        },
      });
      await host.flushACPUpdatesNow(sessionId);
      const nextHistory = await doc.sessionData.history.readAll();
      expect(nextTurnId).not.toBe(turnId);
      expect(findCompaction(nextHistory, 'compact-2')).toMatchObject({ status: 'in_progress' });
      expect(isSessionContextCompacting(nextHistory)).toBe(true);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('persists updates buffered during the finalization tail instead of dropping them', async () => {
    const sessionId = 's-1' as SessionId;
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        finalizeACPState(sessionId: SessionId): Promise<void>;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'pending' },
        },
      });

      // Agents keep emitting briefly after cancel: land one update in the
      // finalization tail — after the drain flushed 'pending' (through the
      // session-data command) and the finished marker was stamped (the first
      // whole-history write), but before the turn state is cleared. Wiping the
      // buffer at turn clear used to drop it.
      const originalUpdateHistory = doc.sessionData.commands.applyHistoryAction.bind(
        doc.sessionData.commands
      );
      let finalizedWrites = 0;
      doc.sessionData.commands.applyHistoryAction = (async (
        mutator: Parameters<typeof originalUpdateHistory>[0]
      ) => {
        const result = await originalUpdateHistory(mutator);
        finalizedWrites += 1;
        if (finalizedWrites === 1) {
          host.enqueueACPUpdate(sessionId, {
            sessionId,
            update: {
              sessionUpdate: 'agent_message_chunk',
              content: { type: 'text', text: ' tail' },
            },
          });
        }
        return result;
      }) as typeof doc.sessionData.commands.applyHistoryAction;

      await host.finalizeACPState(sessionId);

      await vi.advanceTimersByTimeAsync(250);

      const history = await doc.sessionData.history.readAll();
      expect(readItems(history[0])).toEqual([{ type: 'text', text: 'pending tail' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('keeps batched ACP buffers isolated per session when updates interleave', async () => {
    const sessionIds = ['s-1' as SessionId, 's-2' as SessionId] as const;
    const { repo, docs, workspaceDocument, handler } = await createHandlerHarness([...sessionIds]);

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      };

      for (const sessionId of sessionIds) {
        host.beginConversationTurn(sessionId);
      }

      host.enqueueACPUpdate(sessionIds[0], {
        sessionId: sessionIds[0],
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'alpha' },
        },
      });
      host.enqueueACPUpdate(sessionIds[1], {
        sessionId: sessionIds[1],
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'beta' },
        },
      });
      host.enqueueACPUpdate(sessionIds[0], {
        sessionId: sessionIds[0],
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' one' },
        },
      });
      host.enqueueACPUpdate(sessionIds[1], {
        sessionId: sessionIds[1],
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: ' two' },
        },
      });

      await vi.advanceTimersByTimeAsync(35);

      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(2);

      const firstDoc = docs.get(sessionIds[0]);
      const secondDoc = docs.get(sessionIds[1]);
      if (!firstDoc || !secondDoc) {
        throw new Error('Missing session docs for multi-session batching test');
      }

      const firstHistory = await firstDoc.sessionData.history.readAll();
      const secondHistory = await secondDoc.sessionData.history.readAll();

      expect(readItems(firstHistory[0])).toEqual([{ type: 'text', text: 'alpha one' }]);
      expect(readItems(secondHistory[0])).toEqual([{ type: 'text', text: 'beta two' }]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('uploads ACP image content and appends an assistant image group', async () => {
    const sessionId = 's-1' as SessionId;
    const imageBytes = Buffer.from('fake-png-bytes');
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        image: {
          type: 'image',
          imageId: 'img-1',
          mimeType: 'image/png',
          fileName: 'diagram.png',
          sizeBytes: imageBytes.byteLength,
          width: 1,
          height: 1,
        },
      })
    );
    vi.stubGlobal('fetch', fetchMock);

    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'image',
            data: imageBytes.toString('base64'),
            mimeType: 'image/png',
            uri: 'file:///tmp/diagram.png',
          },
        },
      });

      await host.flushACPUpdatesNow(sessionId);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const history = await doc.sessionData.history.readAll();
      const items = readItems(history[0]);
      expect(items).toEqual([
        {
          type: 'image_group',
          images: [
            {
              imageId: 'img-1',
              mimeType: 'image/png',
              fileName: 'diagram.png',
              sizeBytes: imageBytes.byteLength,
              width: 1,
              height: 1,
            },
          ],
        },
      ]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('bounds automatic retries after a persistent ACP history failure', async () => {
    const sessionId = 's-1' as SessionId;
    const { repo, workspaceDocument, handler } = await createHandlerHarness([sessionId]);
    workspaceDocument.getOrCreateSessionDoc.mockRejectedValue(new Error('persistent failure'));

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      };
      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'retained' },
        },
      });

      await vi.advanceTimersByTimeAsync(5_000);
      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(5);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(workspaceDocument.getOrCreateSessionDoc).toHaveBeenCalledTimes(5);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('reuses materialized rich content when its history write is retried', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const text = 'hello from retried resource';
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }
    const uploadFileMock = vi
      .spyOn(
        handler as unknown as { uploadValidatedSessionFile: UploadValidatedSessionFileForTest },
        'uploadValidatedSessionFile'
      )
      .mockResolvedValue({
        type: 'file',
        fileId: 'file-retried',
        fileName: 'retry.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        sha256,
        textPreview: true,
        transport: 'r2',
        uploadedAt: 123,
        downloadUrl: 'https://server.example.test/api/files/file-retried',
      });
    const originalUpdateHistory = doc.sessionData.commands.applyHistoryAction.bind(
      doc.sessionData.commands
    );
    let historyWrites = 0;
    doc.sessionData.commands.applyHistoryAction = (async (
      mutator: Parameters<typeof originalUpdateHistory>[0]
    ) => {
      historyWrites += 1;
      if (historyWrites === 2) {
        throw new Error('transient history write failure');
      }
      return await originalUpdateHistory(mutator);
    }) as typeof doc.sessionData.commands.applyHistoryAction;

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'before ' },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'resource',
            resource: { uri: 'file:///tmp/retry.txt', text, mimeType: 'text/plain' },
          },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'after' },
        },
      });

      await host.flushACPUpdatesNow(sessionId);

      expect(uploadFileMock).toHaveBeenCalledTimes(1);
      const items = readItems((await doc.sessionData.history.readAll())[0]);
      expect(items.map((item) => item.type)).toEqual(['text', 'file', 'text']);
      expect(items[0]).toEqual({ type: 'text', text: 'before ' });
      expect(items[1]).toMatchObject({
        type: 'file',
        fileId: 'file-retried',
        fileName: 'retry.txt',
      });
      expect(items[2]).toEqual({ type: 'text', text: 'after' });
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('deduplicates the persisted prefix when a backend batch fails partway through', async () => {
    vi.useRealTimers();
    const sessionId = 'partial-acp-batch' as SessionId;
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) throw new Error(`Missing session doc for ${sessionId}`);

    const originalAgentWrites = doc.agentWrites;
    const appliedOperationIds = new Set<string>();
    const observedOperationBatches: string[][] = [];
    let injectFailure = true;
    const retryableAgentWrites = {
      ...originalAgentWrites,
      applyAgentBatch: async (input: Parameters<typeof originalAgentWrites.applyAgentBatch>[0]) => {
        const notifications = input.notifications ?? [];
        const operationIds = input.operationIds ?? [];
        observedOperationBatches.push([...operationIds]);
        const { operationIds: _operationIds, ...batchInput } = input;

        for (const [index, notification] of notifications.entries()) {
          const operationId = operationIds[index];
          if (operationId && appliedOperationIds.has(operationId)) continue;

          await originalAgentWrites.applyAgentBatch({
            ...batchInput,
            notifications: [notification],
          });
          if (operationId) appliedOperationIds.add(operationId);
          if (injectFailure) {
            injectFailure = false;
            throw new Error('simulated backend interruption after first item');
          }
        }
      },
    };
    const originalAgentWritesDescriptor = Object.getOwnPropertyDescriptor(doc, 'agentWrites');
    Object.defineProperty(doc, 'agentWrites', {
      configurable: true,
      get: () => retryableAgentWrites,
    });

    try {
      const host = handler as unknown as {
        beginConversationTurn(id: SessionId): string;
        enqueueACPUpdate(id: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(id: SessionId): Promise<void>;
      };
      host.beginConversationTurn(sessionId);
      for (const text of ['prefix', 'suffix']) {
        host.enqueueACPUpdate(sessionId, {
          sessionId,
          update: {
            sessionUpdate: 'agent_message_chunk',
            content: { type: 'text', text },
          },
        });
      }

      await host.flushACPUpdatesNow(sessionId);

      const history = await doc.sessionData.history.readAll();
      expect(readItems(history[0])).toEqual([{ type: 'text', text: 'prefixsuffix' }]);
      expect(observedOperationBatches).toHaveLength(2);
      expect(observedOperationBatches[1]).toEqual(observedOperationBatches[0]);
      expect(new Set(observedOperationBatches[0]).size).toBe(2);
    } finally {
      if (originalAgentWritesDescriptor) {
        Object.defineProperty(doc, 'agentWrites', originalAgentWritesDescriptor);
      } else {
        Reflect.deleteProperty(doc, 'agentWrites');
      }
      await destroyRepoOnRealTimers(repo);
    }
  });

  it('keeps unread state and coalesces plans when a plan write is retried', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }
    const originalSetPlan = doc.setPlan.bind(doc);
    const planSnapshots: Parameters<typeof originalSetPlan>[0][] = [];
    doc.setPlan = (async (entries: Parameters<typeof originalSetPlan>[0]) => {
      planSnapshots.push(entries);
      if (planSnapshots.length === 1) {
        throw new Error('transient plan write failure');
      }
      return await originalSetPlan(entries);
    }) as typeof doc.setPlan;

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
        store: { get(sessionId: SessionId): { pendingUnread: boolean } };
      };
      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'before' },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'Old', priority: 'low', status: 'pending' }],
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'plan',
          entries: [{ content: 'Latest', priority: 'high', status: 'in_progress' }],
        },
      });

      await host.flushACPUpdatesNow(sessionId);

      expect(planSnapshots).toHaveLength(2);
      expect(planSnapshots[0]).toEqual([
        { content: 'Latest', priority: 'high', status: 'in_progress' },
      ]);
      expect(planSnapshots[1]).toEqual(planSnapshots[0]);
      expect(readItems((await doc.sessionData.history.readAll())[0])).toEqual([
        { type: 'text', text: 'before' },
      ]);
      expect(host.store.get(sessionId).pendingUnread).toBe(true);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('persists late diff evidence against its finalized enqueue-time turn', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const standardDiffSpy = vi
      .spyOn(
        handler as unknown as {
          collectCodeCollabStandardDiffs: (
            sessionId: SessionId,
            turnId: string,
            diffs: readonly unknown[]
          ) => Promise<void>;
        },
        'collectCodeCollabStandardDiffs'
      )
      .mockResolvedValue();

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
        finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
      };
      const oldTurnId = host.beginConversationTurn(sessionId);
      await host.finalizeACPState(sessionId, oldTurnId);
      const persistDiffsSpy = vi
        .spyOn(
          handler as unknown as {
            persistCodeCollabTurnDiffs: (sessionId: SessionId, turnId: string) => Promise<boolean>;
          },
          'persistCodeCollabTurnDiffs'
        )
        .mockResolvedValue(true);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-1',
          status: 'completed',
          content: [{ type: 'diff', path: '/tmp/a.txt', oldText: 'old', newText: 'new' }],
        },
      });
      const newTurnId = host.beginConversationTurn(sessionId);
      expect(newTurnId).not.toBe(oldTurnId);

      await host.flushACPUpdatesNow(sessionId);

      expect(standardDiffSpy).toHaveBeenCalledWith(sessionId, oldTurnId, [
        { path: '/tmp/a.txt', oldText: 'old', newText: 'new' },
      ]);
      expect(persistDiffsSpy).toHaveBeenCalledWith(sessionId, oldTurnId);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('buffers write_text_file evidence before workspace resolution', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const { repo, handler, sessionManagerMock } = await createHandlerHarness([sessionId]);
    const internals = handler as unknown as {
      beginConversationTurn(sessionId: SessionId): string;
      flushCodeCollabEvidenceWrites(sessionId: SessionId): Promise<void>;
      codeCollabV2TurnDiffs: Map<string, unknown[]>;
      resolveCodeCollabV2Workspace(sessionId: SessionId): Promise<unknown>;
    };
    const onWriteTextFile = sessionManagerMock.on.mock.calls.find(
      ([eventName]) => eventName === 'onWriteTextFile'
    )?.[1] as
      | ((
          sessionId: SessionId,
          evidence: { path: string; oldText: string | null; newText: string }
        ) => void)
      | undefined;

    try {
      expect(onWriteTextFile).toBeTypeOf('function');
      const turnId = internals.beginConversationTurn(sessionId);
      const resolveWorkspaceSpy = vi.spyOn(internals, 'resolveCodeCollabV2Workspace');

      onWriteTextFile?.(sessionId, {
        path: '/tmp/a.txt',
        oldText: 'old',
        newText: 'new',
      });
      await internals.flushCodeCollabEvidenceWrites(sessionId);

      expect(resolveWorkspaceSpy).not.toHaveBeenCalled();
      expect(internals.codeCollabV2TurnDiffs.get(`${sessionId}\0${turnId}`)).toEqual([
        {
          path: '/tmp/a.txt',
          oldText: 'old',
          newText: 'new',
          oldTextEvidence: 'strong',
        },
      ]);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('restores both diff evidence sets after a transient persistence failure', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const turnId = 'turn-retry';
    const key = `${sessionId}\0${turnId}`;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const acpEvent = { path: 'a.txt', oldText: 'old', newText: 'new' };
    const editEvidence = {
      path: '/tmp/a.txt',
      changeType: 'update',
      contentOldText: 'old',
      contentNewText: 'new',
    };
    const internals = handler as unknown as {
      codeCollabV2TurnDiffs: Map<string, unknown[]>;
      codeCollabV2TurnEdits: Map<string, unknown[]>;
      resolveCodeCollabV2Workspace: (sessionId: SessionId) => Promise<unknown>;
      persistCodeCollabTurnDiffsOnce: (sessionId: SessionId, turnId: string) => Promise<boolean>;
    };
    internals.codeCollabV2TurnDiffs.set(key, [acpEvent]);
    internals.codeCollabV2TurnEdits.set(key, [editEvidence]);
    const resolveWorkspaceSpy = vi
      .spyOn(internals, 'resolveCodeCollabV2Workspace')
      .mockResolvedValueOnce({
        ok: false,
        code: 'transient_io',
        message: 'transient workspace failure',
      })
      .mockResolvedValueOnce({ ok: false, code: 'workspace_unavailable' });

    try {
      await expect(internals.persistCodeCollabTurnDiffsOnce(sessionId, turnId)).rejects.toThrow(
        'transient workspace failure'
      );
      expect(internals.codeCollabV2TurnDiffs.get(key)).toEqual([acpEvent]);
      expect(internals.codeCollabV2TurnEdits.get(key)).toEqual([editEvidence]);

      // A later finalized-turn notification invokes the same drain again. The
      // second workspace resolution proves the restored evidence was retained
      // past the early empty-evidence return.
      await expect(internals.persistCodeCollabTurnDiffsOnce(sessionId, turnId)).resolves.toBe(
        false
      );
      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(2);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('retries late finalized-turn evidence without another ACP notification', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const host = handler as unknown as {
      beginConversationTurn(sessionId: SessionId): string;
      enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
      finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
      persistCodeCollabTurnDiffs: (sessionId: SessionId, turnId: string) => Promise<boolean>;
      collectCodeCollabStandardDiffs(
        sessionId: SessionId,
        turnId: string,
        diffs: readonly unknown[]
      ): Promise<void>;
    };

    try {
      const turnId = host.beginConversationTurn(sessionId);
      await host.finalizeACPState(sessionId, turnId);
      vi.spyOn(host, 'collectCodeCollabStandardDiffs').mockResolvedValue();
      const persistSpy = vi
        .spyOn(host, 'persistCodeCollabTurnDiffs')
        .mockRejectedValueOnce(new Error('transient persistence failure'))
        .mockResolvedValueOnce(true);
      vi.useFakeTimers();

      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'tool_call_update',
          toolCallId: 'edit-1',
          status: 'completed',
          content: [{ type: 'diff', path: '/tmp/a.txt', oldText: 'old', newText: 'new' }],
        },
      });
      await host.flushACPUpdatesNow(sessionId);
      expect(persistSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(99);
      expect(persistSpy).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(persistSpy).toHaveBeenCalledTimes(2);
      expect(persistSpy).toHaveBeenLastCalledWith(sessionId, turnId);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('drains pending evidence retries before cleanup closes the diff store', async () => {
    const sessionId = 's-1' as SessionId;
    const turnId = 'turn-cleanup';
    const key = `${sessionId}\0${turnId}`;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const internals = handler as unknown as {
      codeCollabV2TurnDiffs: Map<string, unknown[]>;
      codeCollabV2DiffStore: { close(): void };
      resolveCodeCollabV2Workspace: (sessionId: SessionId) => Promise<unknown>;
      persistLateCodeCollabTurnDiffs: (sessionId: SessionId, turnId: string) => Promise<void>;
    };
    internals.codeCollabV2TurnDiffs.set(key, [{ path: 'a.txt', oldText: 'old', newText: 'new' }]);
    const resolveWorkspaceSpy = vi
      .spyOn(internals, 'resolveCodeCollabV2Workspace')
      .mockRejectedValueOnce(new Error('transient persistence failure'))
      .mockResolvedValueOnce({ ok: false, code: 'workspace_unavailable' });
    const closeSpy = vi.spyOn(internals.codeCollabV2DiffStore, 'close');

    try {
      await internals.persistLateCodeCollabTurnDiffs(sessionId, turnId);
      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(1);

      await handler.cleanup();

      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(2);
      expect(internals.codeCollabV2TurnDiffs.has(key)).toBe(false);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(resolveWorkspaceSpy.mock.invocationCallOrder[1]).toBeLessThan(
        closeSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
      );

      await vi.advanceTimersByTimeAsync(2_000);
      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(2);
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('stops ACP producers before the final cleanup evidence drain', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const { repo, handler, sessionManagerMock } = await createHandlerHarness([sessionId]);
    const host = handler as unknown as {
      beginConversationTurn(sessionId: SessionId): string;
      enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
      finalizeACPState(sessionId: SessionId, turnId?: string): Promise<void>;
      codeCollabV2DiffStore: { close(): void };
      resolveCodeCollabV2Workspace: (sessionId: SessionId) => Promise<unknown>;
    };

    try {
      const turnId = host.beginConversationTurn(sessionId);
      await host.finalizeACPState(sessionId, turnId);
      const resolveWorkspaceSpy = vi
        .spyOn(host, 'resolveCodeCollabV2Workspace')
        .mockResolvedValueOnce({
          ok: true,
          ownerSessionId: sessionId,
          workspaceRoot: '/tmp',
          allChangesBaseBranch: 'main',
        })
        .mockRejectedValueOnce(new Error('transient persistence failure'))
        .mockResolvedValueOnce({ ok: false, code: 'workspace_unavailable' });
      const closeSpy = vi.spyOn(host.codeCollabV2DiffStore, 'close');
      let cleanupCalls = 0;
      sessionManagerMock.cleanUp.mockImplementation(async () => {
        cleanupCalls += 1;
        if (cleanupCalls === 1) {
          host.enqueueACPUpdate(sessionId, {
            sessionId,
            update: {
              sessionUpdate: 'tool_call_update',
              toolCallId: 'late-cleanup-edit',
              status: 'completed',
              content: [{ type: 'diff', path: '/tmp/a.txt', oldText: 'old', newText: 'new' }],
            },
          });
        }
      });

      await handler.cleanup();

      expect(sessionManagerMock.cleanUp).toHaveBeenNthCalledWith(1, {
        keepWorkspaceDocumentOpen: true,
      });
      expect(sessionManagerMock.cleanUp).toHaveBeenNthCalledWith(2);
      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(3);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(resolveWorkspaceSpy.mock.invocationCallOrder[2]).toBeLessThan(
        closeSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
      );
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  it('waits for pending evidence collectors before the cleanup map snapshot', async () => {
    const sessionId = 's-1' as SessionId;
    const turnId = 'turn-pending-collector';
    const key = `${sessionId}\0${turnId}`;
    const { repo, handler } = await createHandlerHarness([sessionId]);
    const internals = handler as unknown as {
      codeCollabV2PendingEvidenceWrites: Map<SessionId, Set<Promise<void>>>;
      codeCollabV2TurnDiffs: Map<string, unknown[]>;
      codeCollabV2DiffStore: { close(): void };
      resolveCodeCollabV2Workspace: (sessionId: SessionId) => Promise<unknown>;
    };
    let releaseCollector: (() => void) | undefined;
    let trackedCollector: Promise<void>;
    const pending = new Set<Promise<void>>();
    const collector = new Promise<void>((resolve) => {
      releaseCollector = () => {
        internals.codeCollabV2TurnDiffs.set(key, [
          { path: 'a.txt', oldText: 'old', newText: 'new' },
        ]);
        resolve();
      };
    });
    trackedCollector = collector.finally(() => {
      pending.delete(trackedCollector);
      if (pending.size === 0) {
        internals.codeCollabV2PendingEvidenceWrites.delete(sessionId);
      }
    });
    pending.add(trackedCollector);
    internals.codeCollabV2PendingEvidenceWrites.set(sessionId, pending);
    const resolveWorkspaceSpy = vi
      .spyOn(internals, 'resolveCodeCollabV2Workspace')
      .mockResolvedValue({ ok: false, code: 'workspace_unavailable' });
    const closeSpy = vi.spyOn(internals.codeCollabV2DiffStore, 'close');

    try {
      const cleanup = handler.cleanup();
      await Promise.resolve();
      await Promise.resolve();
      expect(closeSpy).not.toHaveBeenCalled();

      releaseCollector?.();
      await cleanup;

      expect(resolveWorkspaceSpy).toHaveBeenCalledTimes(1);
      expect(internals.codeCollabV2TurnDiffs.has(key)).toBe(false);
      expect(closeSpy).toHaveBeenCalledTimes(1);
      expect(resolveWorkspaceSpy.mock.invocationCallOrder[0]).toBeLessThan(
        closeSpy.mock.invocationCallOrder[0] ?? Number.MAX_SAFE_INTEGER
      );
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);

  // Unlike the batch-window tests, this one never advances fake timers — it calls
  // flushACPUpdatesNow() directly. Its flush does real filesystem I/O
  // (materializeACPAgentRichContent → fs.mkdtemp/writeFile) plus native loro doc
  // writes. Holding vitest's fake clock over that real async only adds risk, and on a
  // contended CI runner the I/O can be starved past the default 30s budget. So run it
  // on real timers with extra headroom.
  it('uploads ACP embedded resources and preserves surrounding text order', async () => {
    vi.useRealTimers();
    const sessionId = 's-1' as SessionId;
    const text = 'hello from agent resource';
    const sha256 = crypto.createHash('sha256').update(text).digest('hex');
    const { repo, docs, handler } = await createHandlerHarness([sessionId]);
    const doc = docs.get(sessionId);
    if (!doc) {
      throw new Error(`Missing session doc for ${sessionId}`);
    }
    const uploadFileMock = vi
      .spyOn(
        handler as unknown as { uploadValidatedSessionFile: UploadValidatedSessionFileForTest },
        'uploadValidatedSessionFile'
      )
      .mockResolvedValue({
        type: 'file',
        fileId: 'file-1',
        fileName: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        sha256,
        textPreview: true,
        transport: 'r2',
        uploadedAt: 123,
        downloadUrl: 'https://server.example.test/api/files/file-1',
      });

    try {
      const host = handler as unknown as {
        beginConversationTurn(sessionId: SessionId): string;
        enqueueACPUpdate(sessionId: SessionId, update: AcpSessionNotification): void;
        flushACPUpdatesNow(sessionId: SessionId): Promise<void>;
      };

      host.beginConversationTurn(sessionId);
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'before ' },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: {
            type: 'resource',
            resource: {
              uri: 'file:///tmp/report.txt',
              text,
              mimeType: 'text/plain',
            },
          },
        },
      });
      host.enqueueACPUpdate(sessionId, {
        sessionId,
        update: {
          sessionUpdate: 'agent_message_chunk',
          content: { type: 'text', text: 'after' },
        },
      });

      await host.flushACPUpdatesNow(sessionId);

      expect(uploadFileMock).toHaveBeenCalledTimes(1);
      expect(uploadFileMock.mock.calls[0]?.[0].file).toMatchObject({
        fileName: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        sha256,
        textPreview: true,
      });
      const history = await doc.sessionData.history.readAll();
      const items = readItems(history[0]);
      expect(items.map((item) => item.type)).toEqual(['text', 'file', 'text']);
      expect(items[0]).toEqual({ type: 'text', text: 'before ' });
      expect(items[1]).toEqual({
        type: 'file',
        fileId: 'file-1',
        fileName: 'report.txt',
        mimeType: 'text/plain',
        sizeBytes: Buffer.byteLength(text),
        sha256,
        textPreview: true,
        transport: 'r2',
        uploadedAt: 123,
      });
      expect(items[2]).toEqual({ type: 'text', text: 'after' });
    } finally {
      await destroyRepoOnRealTimers(repo);
    }
  }, 120_000);
});
