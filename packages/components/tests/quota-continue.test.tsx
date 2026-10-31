// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { getDefaultStore } from 'jotai';
import { LoroDoc } from 'loro-crdt';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  getRateLimitEntryKey,
  getSessionRoomId,
  ScheduleRepository,
  type SessionHistory,
  type SessionMeta,
  type ScheduleRepositoryPort,
} from '@lody/shared';
import en from '../../../locales/en.json';
import { userAtom } from '../src/atoms';
import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { runtimeAtom } from '../src/atoms/runtime';
import { SessionLimitContinueAction } from '../src/components/schedules/quota-continue-action';
import { MessageRowView } from '../src/components/ai-gui/view';
import {
  findClaudeSessionLimit,
  quotaContinueIdentity,
  legacyQuotaContinueId,
  quotaContinueReset,
  quotaContinueSendAt,
} from '../src/components/schedules/quota-continue';

const NOW = Date.parse('2026-10-27T14:00:00Z');
const RESET = Date.parse('2026-10-27T14:30:00Z');
const state = vi.hoisted(() => ({
  turns: [] as SessionHistory[],
  machine: null as any,
  registry: { ready: true, rows: [], error: undefined },
  allowed: true,
  recoveryEnabled: false,
}));
vi.mock('../src/components/sessions/use-local-session-continuation', () => ({
  useLocalSessionContinuation: () => ({ recoveryEnabled: state.recoveryEnabled }),
}));
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => ({ enabled: true, workspaceId: 'workspace' }),
}));
vi.mock('../src/hooks/use-workspace-feature', () => ({ useWorkspaceFeature: () => state.allowed }));
vi.mock('../src/hooks/use-resolved-machine-meta', () => ({
  useResolvedMachineMeta: () => ({ machine: state.machine }),
}));
vi.mock('../src/hooks/use-provider-quota-refresh', () => ({
  useProviderQuotaRefresh: () => undefined,
}));
vi.mock('../src/hooks/use-session-doc', () => ({ useSessionDoc: () => ({ history: null }) }));
vi.mock('../src/hooks/use-conversation-view', () => ({
  useConversationTail: () => ({ turns: state.turns }),
}));
vi.mock('../src/hooks/use-schedules', () => ({ useSchedules: () => state.registry }));
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useNavigate: () => () => undefined,
}));
vi.mock('../src/lib/toast', () => ({
  toast: { success: () => undefined, error: () => undefined },
}));

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const session = {
  id: 'session',
  userId: 'owner',
  machineId: 'machine',
  agentConfigId: 'agent',
  cliType: 'builtin',
  agentType: 'claude',
} as SessionMeta;
const entry = (
  id: string,
  role: SessionHistory['role'],
  items: SessionHistory['items']
): SessionHistory =>
  ({
    id,
    role,
    timestamp: new Date(NOW).toISOString(),
    finished: true,
    items,
    fileDiff: [],
  }) as SessionHistory;
const user = () => ({
  ...entry('user', 'user', [{ type: 'text', text: 'Original task' }]),
  inputConfig: {
    agentType: 'claude',
    cliType: 'builtin' as const,
    modelId: 'claude-test',
    modeId: 'safe',
    configOptionValues: { plan_mode: false },
    mcpServerIds: ['mcp-test'],
  },
});
const failed = (message = "You've hit your session limit · resets 2:30pm (UTC)") =>
  entry('failure', 'system', [
    { type: 'system_notice', name: 'chat_failed', meta: { reason: 'acp_internal_error', message } },
  ]);
const limits = (reset: number | null = RESET / 1000, used = 100) => ({
  [getRateLimitEntryKey('claude', 'claude', 'agent' as never)]: {
    limitId: 'claude',
    scope: { providerId: 'claude' },
    planName: null,
    windows: [{ usedPercent: used, windowDurationSeconds: 18000, resetsAtEpochSeconds: reset }],
  },
});

describe('Claude quota continuation', () => {
  let root: Root;
  let container: HTMLDivElement;
  let repository: ScheduleRepository;
  let failFlush: boolean;
  beforeAll(async () => {
    await i18next.use(initReactI18next).init({ lng: 'en', resources: { en: { translation: en } } });
  });
  beforeEach(() => {
    vi.spyOn(Date, 'now').mockReturnValue(NOW);
    state.turns = [user(), failed()];
    state.allowed = true;
    state.recoveryEnabled = false;
    state.registry = { ready: true, rows: [], error: undefined };
    state.machine = {
      id: 'machine',
      ownerUserId: 'owner',
      timeZone: 'UTC',
      protocolCapabilities: { schedules: 3 },
      raceLimits: limits(),
    };
    const docs = new Map<string, LoroDoc>();
    const rows = new Map<string, unknown>();
    failFlush = false;
    const port: ScheduleRepositoryPort = {
      openPersistedDoc: async (id) => {
        if (!docs.has(id)) docs.set(id, new LoroDoc());
        return { doc: docs.get(id)! };
      },
      openFlockDoc: async () => ({
        flock: {
          scan: () => [...rows].map(([key, value]) => ({ key: JSON.parse(key), value })),
          get: (key) => rows.get(JSON.stringify(key)),
          set: (key, value) => rows.set(JSON.stringify(key), value),
        },
      }),
      flush: async () => {
        if (failFlush) throw new Error('Synthetic flush failure');
      },
    };
    repository = new ScheduleRepository(port, 'workspace' as never);
    getDefaultStore().set(userAtom, { id: 'owner' } as never);
    getDefaultStore().set(runtimeAtom, {
      workspaceId: 'workspace',
      repo: port,
      withScheduleStore: async (_id: string, write: () => Promise<unknown>) => write(),
    } as never);
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    getDefaultStore().set(runtimeAtom, null);
  });
  const render = async (entryId = 'failure') => {
    await act(async () =>
      root.render(<SessionLimitContinueAction session={{ ...session }} entryId={entryId} />)
    );
  };
  const click = async () => {
    await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  };

  it('uses a stable reservation identity scoped to the failed Turn', () => {
    const first = quotaContinueIdentity('workspace', 'session', RESET, 'user');
    expect(first).toEqual(quotaContinueIdentity('workspace', 'session', RESET, 'user'));
    expect(first.scheduleId).not.toBe(
      quotaContinueIdentity('workspace', 'session', RESET, 'other-turn').scheduleId
    );
  });

  it('creates one full-message reservation after reset without consuming history or draft content', async () => {
    await render();
    expect(container.textContent).toContain('Schedule one “continue” message for 2:31 PM UTC');
    expect(container.textContent).toContain('Schedule');
    await act(async () => {
      container.querySelector<HTMLButtonElement>('button')!.click();
      container.querySelector<HTMLButtonElement>('button')!.click();
    });
    const id = quotaContinueIdentity('workspace', 'session', RESET, 'user').scheduleId;
    const document = await repository.read(id);
    expect(document?.prompt).toBe('continue');
    expect(document?.message).toEqual({
      inputBlocks: [{ type: 'text', text: 'continue' }],
      mcpServerIds: ['mcp-test'],
    });
    expect(document?.definition).toMatchObject({
      trigger: { kind: 'once', at: new Date(RESET + 60_000).toISOString() },
      destination: { kind: 'existing_session', sessionId: 'session' },
      agent: { modelId: 'claude-test', modeId: 'safe', configOptionValues: { plan_mode: false } },
    });
    expect(state.turns[0]?.items).toEqual([{ type: 'text', text: 'Original task' }]);
    expect(container.textContent).toContain('Continue scheduled for 2:31 PM UTC');
    expect(container.textContent).toContain('View');
    expect(document?.timeline).toHaveLength(1);
    await render();
    expect(container.textContent).toContain('Continue scheduled for 2:31 PM UTC');
    expect(container.textContent).toContain('View');
  });

  it('reuses the durable reservation after the shortcut remounts', async () => {
    await render();
    await click();
    act(() => root.unmount());
    root = createRoot(container);
    await render();
    await click();
    const document = await repository.read(
      quotaContinueIdentity('workspace', 'session', RESET, 'user').scheduleId
    );
    expect(document?.timeline).toHaveLength(1);
    expect(container.textContent).toContain('Continue scheduled for 2:31 PM UTC');
    expect(container.textContent).toContain('View');
  });

  it('keeps an existing legacy reservation visible without creating a second one', async () => {
    const oldId = legacyQuotaContinueId('workspace', 'session', RESET);
    state.registry.rows = [{ scheduleId: oldId }] as never[];
    await render();
    expect(container.textContent).toContain('Continue scheduled for 2:31 PM UTC');
    await click();
    expect(
      await repository.read(quotaContinueIdentity('workspace', 'session', RESET, 'user').scheduleId)
    ).toBeNull();
  });

  it('does not offer a new reservation while automatic capacity recovery is enabled', async () => {
    state.recoveryEnabled = true;
    await render();
    expect(container.querySelector('button')).toBeNull();
    state.recoveryEnabled = false;
    await render();
    await click();
    state.recoveryEnabled = true;
    await render();
    expect(container.textContent).toContain('Continue scheduled for 2:31 PM UTC');
  });

  it('rechecks expiry at click time and never sends immediately', async () => {
    await render();
    vi.spyOn(Date, 'now').mockReturnValue(RESET + 2000);
    await click();
    expect(
      await repository.read(quotaContinueIdentity('workspace', 'session', RESET, 'user').scheduleId)
    ).toBeNull();
  });

  it('retries a failed durable save with the same identity', async () => {
    failFlush = true;
    await render();
    await click();
    expect(container.textContent).toContain('Schedule one “continue” message for 2:31 PM UTC');
    failFlush = false;
    await click();
    expect(container.textContent).toContain('Continue scheduled for 2:31 PM UTC');
    expect(container.textContent).toContain('View');
    expect(
      (
        await repository.read(
          quotaContinueIdentity('workspace', 'session', RESET, 'user').scheduleId
        )
      )?.timeline
    ).toHaveLength(1);
  });

  it.each([null, (NOW - 1) / 1000])(
    'does not guess missing or expired reset time %s',
    async (reset) => {
      state.machine.raceLimits = limits(reset);
      await render();
      expect(container.textContent).toBe('');
    }
  );
  it.each([
    "You've hit your weekly limit · resets Friday",
    'HTTP 429: rate limited',
    'Unexpected failure',
  ])('ignores other provider errors: %s', async (message) => {
    state.turns = [user(), failed(message)];
    await render();
    expect(container.textContent).toBe('');
  });
  it('does not use a quoted user message or an old failure after a new user turn', async () => {
    state.turns = [user(), failed(), user()];
    await render();
    expect(container.textContent).toBe('');
    expect(findClaudeSessionLimit([entry('quote', 'user', failed().items)])).toBeNull();
  });
  it('rejects stale failure, foreign provider quota, and a still-exhausted weekly window', () => {
    const failure = findClaudeSessionLimit([user(), failed()])!;
    expect(
      quotaContinueReset({
        failure: { ...failure, failedAt: NOW - 6 * 3600000 },
        session,
        rateLimits: limits(),
        now: NOW,
      })
    ).toBeNull();
    expect(
      quotaContinueReset({
        failure,
        session,
        rateLimits: { unrelated: Object.values(limits())[0]! },
        now: NOW,
      })
    ).toBeNull();
    const rateLimits = limits();
    Object.values(rateLimits)[0]!.windows.push({
      usedPercent: 100,
      windowDurationSeconds: 604800,
      resetsAtEpochSeconds: RESET / 1000 + 86400,
    });
    expect(quotaContinueReset({ failure, session, rateLimits, now: NOW })).toBeNull();
  });
  it('mounts the shortcut inside the failed message banner', async () => {
    getDefaultStore().set(sessionMetaCacheAtom, {
      [getSessionRoomId(session.id)]: session,
    });
    await act(async () =>
      root.render(<MessageRowView message={failed()} sessionId={session.id as never} />)
    );
    const alert = container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('Agent internal error');
    expect(alert?.textContent).toContain('Schedule one “continue” message for 2:31 PM UTC');
    expect(
      [...(alert?.querySelectorAll('button') ?? [])].some((button) =>
        button.textContent?.includes('Schedule')
      )
    ).toBe(true);
  });
  it('rounds the trigger to the first full minute after reset', () => {
    expect(quotaContinueSendAt(RESET)).toBe(RESET + 60_000);
    expect(quotaContinueSendAt(RESET + 30_000)).toBe(RESET + 60_000);
    expect(quotaContinueSendAt(RESET + 59_999)).toBe(RESET + 60_000);
    expect(quotaContinueSendAt(RESET + 60_000)).toBe(RESET + 120_000);
  });
  it('uses the assistant host row when the notice is folded onto it', async () => {
    state.turns = [
      user(),
      entry('assistant', 'assistant', [{ type: 'text', text: 'Partial answer' }]),
      failed(),
    ];
    expect(findClaudeSessionLimit(state.turns)?.noticeId).toBe('assistant');
    await render('assistant');
    expect(container.textContent).toContain('Schedule one “continue” message for 2:31 PM UTC');
  });
  it('does not render the shortcut on a different failure entry', async () => {
    await render('an-older-failure');
    expect(container.textContent).toBe('');
  });
  it('does not show the shortcut after the conversation recovered', async () => {
    state.turns = [
      user(),
      failed(),
      entry('recovered', 'assistant', [{ type: 'text', text: 'Done' }]),
    ];
    expect(findClaudeSessionLimit(state.turns)).toBeNull();
    await render();
    expect(container.textContent).toBe('');
  });
  it('hides the action for old machines and another owner', async () => {
    state.machine.protocolCapabilities.schedules = 2;
    await render();
    expect(container.textContent).toBe('');
    state.machine.protocolCapabilities.schedules = 3;
    state.machine.ownerUserId = 'other';
    await render();
    expect(container.textContent).toBe('');
  });
});
