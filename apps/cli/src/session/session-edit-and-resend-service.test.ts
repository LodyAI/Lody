import { withHistoryPort } from '../../tests/history-port-fixture';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoroDoc, LoroMap } from 'loro-crdt';
import { SessionDocument } from '../lib/loro/doc';
import { composeTestSessionDoc } from '../../tests/session-doc-fixture';
import {
  SessionStatusFactory,
  type AgentConfigId,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import type { ReplaceEditableTailInput } from '@lody/shared/session-data';
import { SessionEditAndResendService } from './session-edit-and-resend-service';
import { SessionExecutionService } from './session-execution-service';

const sessionId = 'session-1' as SessionId;
const machineId = 'machine-1' as MachineId;
const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

const historyFixture = (): SessionHistoryInput[] => [
  {
    id: 'user-1',
    timestamp: '2026-08-03T00:00:00.000Z',
    role: 'user',
    items: [{ type: 'text', text: 'first' }],
    fileDiff: [],
    finished: true,
    status: 'handled',
  },
  {
    id: 'assistant-1',
    timestamp: '2026-08-03T00:00:01.000Z',
    role: 'assistant',
    items: [{ type: 'text', text: 'answer' }],
    fileDiff: [],
    finished: true,
    acpTurnId: 'provider-turn-1',
  },
  {
    id: 'user-2',
    userId: 'original-author',
    timestamp: '2026-08-03T00:00:02.000Z',
    role: 'user',
    items: [
      { type: 'image_group', images: [{ key: 'image-1', mimeType: 'image/png' }] },
      { type: 'text', text: 'old prompt' },
    ],
    fileDiff: [],
    finished: true,
    status: 'processing',
    inputConfig: {
      prompt: 'old prompt',
      cliType: 'builtin',
      agentType: 'codex',
      modelId: 'model-1',
      configOptionValues: {
        collaboration_mode: 'plan',
      },
    },
  },
  {
    id: 'assistant-2',
    timestamp: '2026-08-03T00:00:03.000Z',
    role: 'assistant',
    items: [{ type: 'text', text: 'streaming' }],
    fileDiff: [{ filePath: 'src/a.ts', add: 1, del: 0 }],
    finished: false,
  },
];

function createHarness(
  options: {
    active?: boolean;
    prepareError?: Error;
    persistError?: Error;
    beforeCommitFailure?: (doc: LoroDoc) => void;
    /** Lands a concurrent history edit between the eligibility check and the commit. */
    beforeReplace?: (doc: SessionDocument) => Promise<void> | void;
    /** Delays the asynchronous compensation; use a deferred to hold the gate open. */
    beforeRollback?: () => Promise<void>;
    /** A compensation whose follow-up step rejects after restoring the range. */
    rollbackError?: Error;
    history?: SessionHistoryInput[];
  } = {}
) {
  const events: string[] = [];
  let history = options.history ?? historyFixture();
  const loro = new LoroDoc();
  for (const entry of history) {
    const map = loro
      .getList('history')
      .insertContainer(loro.getList('history').length, new LoroMap());
    for (const [key, value] of Object.entries(entry)) if (value !== undefined) map.set(key, value);
  }
  loro.commit();
  const realDoc = new SessionDocument({} as never, sessionId, async () => {}, {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as never);
  // The production storage entry (control-plane Mirror + one shared writer +
  // session-data seam, with the auto-read policy attached) over the fixture doc.
  composeTestSessionDoc(realDoc, { doc: loro });
  cleanups.push(() => realDoc.mirror?.dispose());
  const meta = {
    id: sessionId,
    machineId,
    createdAt: '2026-08-03T00:00:00.000Z',
    userId: 'user-1',
    status: SessionStatusFactory.idle(),
    isArchived: false,
    cliType: 'builtin',
    agentType: 'codex',
    agentConfigId: 'agent-config-1' as AgentConfigId,
    acpSessionId: 'acp-old',
  } as SessionMeta;
  const sessionDoc = withHistoryPort({
    getMetaState: vi.fn(async () => meta),
    getHistory: vi.fn(realDoc.sessionData.history.readAll.bind(realDoc.sessionData.history)),
    sessionData: {
      commands: {
        replaceEditableTail: vi.fn(async (input: ReplaceEditableTailInput) => {
          events.push('history');
          await options.beforeReplace?.(realDoc);
          const result = await realDoc.sessionData.commands.replaceEditableTail(input);
          if (result.status !== 'accepted') return result;
          history = await realDoc.sessionData.history.readAll();
          return {
            ...result,
            rollback: async () => {
              await options.beforeRollback?.();
              await result.rollback();
              history = loro.getList('history').toJSON() as SessionHistoryInput[];
              if (options.rollbackError) throw options.rollbackError;
            },
          };
        }),
      },
    },
  });
  const repo = {
    upsertDocMeta: vi.fn(async () => {
      events.push('meta');
    }),
  };
  const agentClient = {
    prepareReplacementSession: vi.fn(async () => {
      events.push('prepare');
      if (options.prepareError) throw options.prepareError;
      return { sessionId: 'acp-new' };
    }),
    adoptPreparedSession: vi.fn(() => events.push('adopt')),
    closeDetachedSession: vi.fn(async () => true),
  };
  const runtime = {
    acpSessionId: 'acp-old',
    agentClient,
  };
  let barrierHeld = false;
  const executionService = {
    getExecutionSnapshot: vi.fn(() => ({
      hasActiveTurn: options.active === true,
      activeTurnId: options.active ? 'assistant-2' : undefined,
      hasBlockingPendingCreate: false,
      hasReusableSession: true,
      hasRewriteBarrier: barrierHeld,
      hasActiveAutomation: false,
    })),
    tryAcquireSessionRewriteBarrier: vi.fn(() => {
      barrierHeld = true;
      events.push('barrier-acquire');
      return () => {
        barrierHeld = false;
        events.push('barrier-release');
      };
    }),
    getActiveUserTurnId: vi.fn(() => (options.active ? 'user-2' : undefined)),
    cancelSession: vi.fn(async () => {
      events.push('cancel');
      return { success: true };
    }),
    waitForTurnRelease: vi.fn(async () => {
      events.push('wait-release');
    }),
  };
  const logger = { error: vi.fn(), debug: vi.fn() };
  const service = new SessionEditAndResendService({
    workspaceDocument: {
      repo,
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      persistPendingChanges: vi.fn(async (reason: string) => {
        events.push(reason.endsWith('rollback') ? 'persist-rollback' : 'persist');
        if (options.persistError && reason.endsWith('commit')) {
          options.beforeCommitFailure?.(loro);
          throw options.persistError;
        }
      }),
    } as never,
    sessionManager: {
      getSession: vi.fn(() => runtime),
    } as never,
    executionService: executionService as never,
    userResolver: {} as never,
    logger: logger as never,
    workspaceId: 'workspace-1',
    machineId,
    enqueueDispatch: () => events.push('dispatch'),
  });

  return withHistoryPort({
    agentClient,
    events,
    executionService,
    // Read the real doc so an async auto-read write is observable, not a snapshot
    // captured at the last explicit history write.
    getHistory: () => loro.getList('history').toJSON() as SessionHistoryInput[],
    logger,
    realDoc,
    repo,
    service,
  });
}

const spec = {
  sessionId,
  expectedUserTurnId: 'user-2',
  replacementUserTurnId: 'user-3',
  requestedByUserId: 'user-1',
  timestamp: '2026-08-03T00:00:04.000Z',
  inputConfig: {
    prompt: 'new prompt',
    inputBlocks: [
      { type: 'image', imageId: 'image-1', mimeType: 'image/png', sizeBytes: 1 },
      { type: 'text', text: 'new prompt' },
    ],
    cliType: 'builtin' as const,
    agentType: 'codex',
  },
};

describe('SessionEditAndResendService', () => {
  it('forks before cancelling, then atomically replaces the history tail', async () => {
    const harness = createHarness({ active: true });

    const result = await harness.service.editAndResend(spec);
    expect(result, JSON.stringify(result)).toMatchObject({ success: true });

    expect(harness.agentClient.prepareReplacementSession).toHaveBeenCalledWith('provider-turn-1');
    expect(harness.events).toEqual([
      'barrier-acquire',
      'prepare',
      'cancel',
      'wait-release',
      'history',
      'meta',
      'persist',
      'adopt',
      'barrier-release',
      'dispatch',
    ]);
    expect(harness.sessionData.history.readAll().map((entry) => entry.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-3',
    ]);
    await vi.waitFor(() => {
      expect(harness.sessionData.history.readAll().at(-1)).toMatchObject({
        status: 'seen',
        read: true,
      });
    });
    expect(harness.sessionData.history.readAll().at(-1)).toMatchObject({
      userId: 'original-author',
      status: 'seen',
      read: true,
      inputConfig: {
        modelId: 'model-1',
        configOptionValues: {
          collaboration_mode: 'plan',
        },
        resume: 'acp-new',
      },
    });
    expect(harness.repo.upsertDocMeta).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        acpSessionId: 'acp-new',
        latestUserMsgId: 'user-3',
        lastHandledUserMsgId: 'user-1',
      })
    );
  });

  it('refuses the commit when the editable tail moved after the eligibility check', async () => {
    const harness = createHarness({
      beforeReplace: async (doc) => {
        await doc.sessionData.commands.appendTurn({
          id: 'user-concurrent',
          role: 'user',
          timestamp: '2026-08-03T00:00:05.000Z',
          items: [{ type: 'text', text: 'concurrent message' }],
          fileDiff: [],
        });
      },
    });

    const result = await harness.service.editAndResend(spec);
    expect(result).toMatchObject({ success: false, error: { code: 'STALE_USER_TURN' } });
    // The concurrent user turn survives; the replacement was refused before any write.
    expect(harness.sessionData.history.readAll().map((entry) => entry.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
      'user-concurrent',
    ]);
    expect(harness.repo.upsertDocMeta).not.toHaveBeenCalled();
  });

  it('waits for the asynchronous compensation before restoring meta and persisting the rollback', async () => {
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const harness = createHarness({
      persistError: new Error('commit failed'),
      beforeRollback: async () => {
        entered();
        await gate;
      },
    });

    const pending = harness.service.editAndResend(spec);
    await started;
    // Drain scheduled continuations without relying on elapsed time.
    await new Promise<void>((resolve) => setImmediate(resolve));
    try {
      // The compensation is still gated, so neither the follow-up persist nor the
      // barrier release may have happened yet.
      expect(harness.events).not.toContain('persist-rollback');
      expect(harness.events).not.toContain('barrier-release');
    } finally {
      release();
    }

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: { code: 'HISTORY_WRITE_FAILED' },
    });
    expect(harness.events).toContain('persist-rollback');
    expect(harness.events).toContain('barrier-release');
    expect(harness.sessionData.history.readAll().map((entry) => entry.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ]);
  });

  it('catches a rejected compensation, restores meta and reports the commit failure', async () => {
    const harness = createHarness({
      persistError: new Error('commit failed'),
      // The range is restored, but the compensation's own awaitable step fails.
      rollbackError: new Error('compensation follow-up failed'),
    });

    await expect(harness.service.editAndResend(spec)).resolves.toMatchObject({
      success: false,
      error: { code: 'HISTORY_WRITE_FAILED' },
    });
    expect(harness.events).toContain('persist-rollback');
    expect(harness.events).toContain('barrier-release');
    expect(harness.logger.error).toHaveBeenCalledWith(
      expect.stringContaining('Failed to restore history after commit failure')
    );
    expect(harness.sessionData.history.readAll().map((entry) => entry.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ]);
  });

  it('leaves the active turn untouched when provider fork fails', async () => {
    const harness = createHarness({
      active: true,
      prepareError: new Error('[ACP_FORK_FAILED] unavailable'),
    });

    await expect(harness.service.editAndResend(spec)).resolves.toMatchObject({
      success: false,
      error: { code: 'ACP_FORK_FAILED' },
    });
    expect(harness.executionService.cancelSession).not.toHaveBeenCalled();
    expect(harness.sessionData.history.readAll().map((entry) => entry.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ]);
  });

  it('uses session/new for the first user message', async () => {
    const firstHistory: SessionHistoryInput[] = [
      {
        id: 'user-2',
        timestamp: '2026-08-03T00:00:02.000Z',
        role: 'user',
        items: [{ type: 'text', text: 'old prompt' }],
        fileDiff: [],
        finished: true,
        status: 'handled',
      },
    ];
    const harness = createHarness({ history: firstHistory });

    await expect(harness.service.editAndResend(spec)).resolves.toMatchObject({ success: true });
    expect(harness.agentClient.prepareReplacementSession).toHaveBeenCalledWith(undefined);
  });

  it('rejects an applied steer user turn', async () => {
    const history = historyFixture();
    history[2] = {
      ...history[2]!,
      inputConfig: { ...history[2]!.inputConfig, _lodyDeliveryKind: 'steer' },
    };
    const harness = createHarness({ history });

    await expect(harness.service.editAndResend(spec)).resolves.toMatchObject({
      success: false,
      error: { code: 'USER_TURN_NOT_EDITABLE' },
    });
    expect(harness.agentClient.prepareReplacementSession).not.toHaveBeenCalled();
  });

  it('retains newly accepted steer provenance through the writer and actual reader before editing', async () => {
    const harness = createHarness();
    const execution = new SessionExecutionService({
      logger: { debug: vi.fn() },
      workspaceDocument: { repo: harness.repo },
    } as never);
    await execution['transitionDispatchOwnership']({
      sessionId,
      sessionDoc: harness.realDoc,
      nextUserTurnId: 'user-2',
    });
    // Once settled, pending_apply no longer protects the steer from editing.
    await execution['setUserTurnStatus'](harness.realDoc, 'user-2', 'handled');
    const stored = harness.realDoc.sessionData.writer.read('user-2');
    expect(stored?.inputConfig?._lodyDeliveryKind).toBe('steer');
    const read = await harness.realDoc.sessionData.history.readAll();
    expect(read.find((entry) => entry.id === 'user-2')?.inputConfig?._lodyDeliveryKind).toBe(
      'steer'
    );
    await expect(harness.service.editAndResend(spec)).resolves.toMatchObject({
      success: false,
      error: { code: 'USER_TURN_NOT_EDITABLE' },
    });
    expect(harness.agentClient.prepareReplacementSession).not.toHaveBeenCalled();
    expect(harness.agentClient.adoptPreparedSession).not.toHaveBeenCalled();
  });

  it('requires a new logical user turn id', async () => {
    const harness = createHarness();

    await expect(
      harness.service.editAndResend({
        ...spec,
        replacementUserTurnId: spec.expectedUserTurnId,
      })
    ).resolves.toMatchObject({
      success: false,
      error: { code: 'USER_TURN_NOT_EDITABLE' },
    });
    expect(harness.agentClient.prepareReplacementSession).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'restores the old tail on commit failure with peer prefix edit=%s',
    async (peerEdit) => {
      const history = historyFixture();
      const opaqueItems = [
        { type: 'future_item', value: 42 },
        { type: 'text', text: 42, futureField: 'keep' },
      ];
      history[3] = { ...history[3]!, items: opaqueItems } as unknown as SessionHistoryInput;
      const harness = createHarness({
        persistError: new Error('disk unavailable'),
        history,
        beforeCommitFailure: peerEdit
          ? (doc) => {
              const peer = new LoroDoc();
              peer.import(doc.export({ mode: 'snapshot' }));
              (peer.getList('history').get(0) as LoroMap).set('items', [
                { type: 'text', text: 'peer prefix edit' },
              ]);
              doc.import(peer.export({ mode: 'update', from: doc.version() }));
            }
          : undefined,
      });

      await expect(harness.service.editAndResend(spec)).resolves.toMatchObject({
        success: false,
        error: { code: 'HISTORY_WRITE_FAILED' },
      });
      expect(harness.sessionData.history.readAll().map((entry) => entry.id)).toEqual([
        'user-1',
        'assistant-1',
        'user-2',
        'assistant-2',
      ]);
      expect(harness.events).toContain('persist-rollback');
      expect(harness.sessionData.history.readAll()).toEqual(
        peerEdit
          ? [
              { ...history[0], items: [{ type: 'text', text: 'peer prefix edit' }] },
              ...history.slice(1),
            ]
          : history
      );
      expect(harness.agentClient.adoptPreparedSession).not.toHaveBeenCalled();
    }
  );
});
