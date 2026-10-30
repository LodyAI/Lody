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
  ScheduleRepository,
  type SessionHistory,
  type SessionMeta,
  type ScheduleRepositoryPort,
} from '@lody/shared';
import en from '../../../locales/en.json';
import { userAtom } from '../src/atoms';
import { runtimeAtom } from '../src/atoms/runtime';
import { QuotaContinueAction } from '../src/components/schedules/quota-continue-action';
import {
  findClaudeSessionLimit,
  quotaContinueIdentity,
  legacyQuotaContinueId,
  quotaContinueReset,
} from '../src/components/schedules/quota-continue';

const NOW = Date.parse('2026-10-27T01:00:00Z');
const RESET = NOW + 60 * 60 * 1000;
const state = vi.hoisted(() => ({
  turns: [] as SessionHistory[],
  machine: null as any,
  registry: { ready: true, rows: [], error: undefined },
  allowed: true,
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
const failed = (message = "You've hit your session limit · resets 10am (Asia/Shanghai)") =>
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
    state.registry = { ready: true, rows: [], error: undefined };
    state.machine = {
      id: 'machine',
      ownerUserId: 'owner',
      timeZone: 'Asia/Shanghai',
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
  const render = async () => {
    await act(async () => root.render(<QuotaContinueAction session={session} visible />));
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
    expect(container.textContent).toBe('Send continue after reset');
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
      trigger: { kind: 'once', at: new Date(RESET + 1000).toISOString() },
      destination: { kind: 'existing_session', sessionId: 'session' },
      agent: { modelId: 'claude-test', modeId: 'safe', configOptionValues: { plan_mode: false } },
    });
    expect(state.turns[0]?.items).toEqual([{ type: 'text', text: 'Original task' }]);
    expect(container.textContent).toContain('View scheduled continue');
    expect(document?.timeline).toHaveLength(1);
    await render();
    expect(container.textContent).toContain('View scheduled continue');
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
    expect(container.textContent).toContain('View scheduled continue');
  });

  it('keeps an existing legacy reservation visible without creating a second one', async () => {
    const oldId = legacyQuotaContinueId('workspace', 'session', RESET);
    state.registry.rows = [{ scheduleId: oldId }] as never[];
    await render();
    expect(container.textContent).toContain('View scheduled continue');
    await click();
    expect(
      await repository.read(quotaContinueIdentity('workspace', 'session', RESET, 'user').scheduleId)
    ).toBeNull();
  });

  it('does not offer a new reservation while automatic capacity recovery is enabled', async () => {
    await act(async () =>
      root.render(<QuotaContinueAction session={session} visible autoRecoveryEnabled />)
    );
    expect(container.querySelector('button')).toBeNull();
    await render();
    await click();
    await act(async () =>
      root.render(<QuotaContinueAction session={session} visible autoRecoveryEnabled />)
    );
    expect(container.textContent).toContain('View scheduled continue');
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
    expect(container.textContent).toContain('Send continue after reset');
    failFlush = false;
    await click();
    expect(container.textContent).toContain('View scheduled continue');
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
