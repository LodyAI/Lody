import { describe, expect, it, vi } from 'vitest';
import {
  SessionStatusFactory,
  type AgentConfigId,
  type MachineId,
  type SessionHistoryInput,
  type SessionId,
  type SessionMeta,
} from '@lody/shared';
import { SessionEditAndResendService } from './session-edit-and-resend-service';

const sessionId = 'session-1' as SessionId;
const machineId = 'machine-1' as MachineId;

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
      acceptWiderPermissions: [
        { controlId: 'mode', requestedModeId: 'plan', effectiveModeId: 'auto' },
      ],
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
    history?: SessionHistoryInput[];
  } = {}
) {
  const events: string[] = [];
  let history = options.history ?? historyFixture();
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
  const sessionDoc = {
    getMetaState: vi.fn(async () => meta),
    getHistory: vi.fn(async () => history),
    updateHistory: vi.fn(
      async (update: (current: SessionHistoryInput[]) => SessionHistoryInput[]) => {
        events.push('history');
        history = update(history);
      }
    ),
  };
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
  const service = new SessionEditAndResendService({
    workspaceDocument: {
      repo,
      getOrCreateSessionDoc: vi.fn(async () => sessionDoc),
      persistPendingChanges: vi.fn(async (reason: string) => {
        events.push(reason.endsWith('rollback') ? 'persist-rollback' : 'persist');
        if (options.persistError && reason.endsWith('commit')) {
          throw options.persistError;
        }
      }),
    } as never,
    sessionManager: {
      getSession: vi.fn(() => runtime),
    } as never,
    executionService: executionService as never,
    userResolver: {} as never,
    logger: { error: vi.fn(), debug: vi.fn() } as never,
    workspaceId: 'workspace-1',
    machineId,
    enqueueDispatch: () => events.push('dispatch'),
  });

  return { agentClient, events, executionService, getHistory: () => history, repo, service };
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
      { type: 'image', key: 'image-1', mimeType: 'image/png' },
      { type: 'text', text: 'new prompt' },
    ],
    cliType: 'builtin' as const,
    agentType: 'codex',
  },
};

describe('SessionEditAndResendService', () => {
  it('forks before cancelling, then atomically replaces the history tail', async () => {
    const harness = createHarness({ active: true });

    await expect(harness.service.editAndResend(spec)).resolves.toMatchObject({ success: true });

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
    expect(harness.getHistory().map((entry) => entry.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-3',
    ]);
    expect(harness.getHistory().at(-1)).toMatchObject({
      userId: 'original-author',
      status: 'pending',
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

  it("does not carry the original turn's permission acceptance onto the new prompt", async () => {
    // The client already drops it, but a rule the daemon does not enforce is a
    // rule the next client forgets: the replacement config only LACKS the field,
    // and a missing key does not overwrite a present one in a spread.
    const harness = createHarness({ active: true });

    await expect(harness.service.editAndResend(spec)).resolves.toMatchObject({ success: true });

    const replacement = harness.getHistory().at(-1);
    expect(replacement?.inputConfig).not.toHaveProperty('acceptWiderPermissions');
    // The rest of the original turn's config still carries over.
    expect(replacement?.inputConfig).toMatchObject({ modelId: 'model-1' });
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
    expect(harness.getHistory().map((entry) => entry.id)).toEqual([
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

  it('restores the old history tail when the durable commit fails', async () => {
    const harness = createHarness({ persistError: new Error('disk unavailable') });

    await expect(harness.service.editAndResend(spec)).resolves.toMatchObject({
      success: false,
      error: { code: 'HISTORY_WRITE_FAILED' },
    });
    expect(harness.getHistory().map((entry) => entry.id)).toEqual([
      'user-1',
      'assistant-1',
      'user-2',
      'assistant-2',
    ]);
    expect(harness.events).toContain('persist-rollback');
    expect(harness.agentClient.adoptPreparedSession).not.toHaveBeenCalled();
  });
});
