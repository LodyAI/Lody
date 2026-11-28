// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { I18nextProvider, initReactI18next } from 'react-i18next';
import { Provider, createStore } from 'jotai';
import { LoroRepo } from 'loro-repo';

import {
  CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
  getScheduleRegistryFlockDocId,
  getSessionRoomId,
  scheduleOwnSessionId,
  type MachineId,
  type MachineViewMeta,
  type ScheduleDocument,
  type ScheduleRegistryRow,
  type ScheduleRuntimeRow,
  type SessionId,
  type SessionLiveStatusResponse,
  type SessionMeta,
  type WorkspaceId,
} from '@lody/shared';
import { ScheduleRepository } from '@lody/shared/schedule-repository';
import en from '../../../locales/en.json';
import zh from '../../../locales/zh_CN.json';

import { ScheduleForm, ScheduleListView } from '../src/components/schedules/schedule-view';
import { SchedulesWorkspace } from '../src/components/schedules/schedules-workspace';
import {
  inspectBoundSessionBeforeRun,
  resolveScheduleBoundSessionTarget,
} from '../src/components/schedules/schedule-run-check';
import { ScheduledQueueRow } from '../src/components/sessions/message-queue/scheduled-queue-row';
import { formatUpcoming, scheduleRowTimeZone } from '../src/components/schedules/schedule-format';
import {
  lodyPresenceNowMsAtom,
  lodyPresenceStatesAtom,
  lodyPresenceSyncStateAtom,
} from '../src/atoms/presence';
import { runtimeAtom, type WorkspaceRuntime } from '../src/atoms/runtime';
import { scheduleRegistryAtom } from '../src/atoms/schedules';
import { currentWorkspaceSlugAtom, userAtom } from '../src/atoms';
import { sessionMetaCacheAtom } from '../src/atoms/doc-meta';
import { UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS } from '../src/lib/session-dispatch-state';
import { TestCloudPlatformProvider } from './test-platform';

const layout = vi.hoisted(() => ({ mobile: false, macElectron: false }));
const workspaceHarness = vi.hoisted(() => ({
  workspaceId: 'ws-test' as WorkspaceId,
  machines: new Map<MachineId, MachineViewMeta>(),
  detailDoc: null as ScheduleDocument | null,
  toasts: [] as string[],
}));

vi.mock('../src/hooks/use-mobile', () => ({
  useIsMobile: () => layout.mobile,
}));
vi.mock('../src/lib/electron', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/electron')>();
  return {
    ...actual,
    isMacOSElectronRenderer: () => layout.macElectron,
  };
});
vi.mock('@tanstack/react-router', () => ({
  useNavigate: () => vi.fn(),
}));
vi.mock('../src/hooks/use-workspace-feature', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks/use-workspace-feature')>();
  return {
    ...actual,
    useWorkspaceFeature: () => true,
  };
});
vi.mock('../src/hooks/use-resolved-workspace-scope', () => ({
  useResolvedWorkspaceScope: () => ({
    enabled: true,
    workspaceId: workspaceHarness.workspaceId,
  }),
}));
vi.mock('../src/hooks/use-workspace-members', () => ({
  useWorkspaceMembers: () => ({ members: [{ userId: 'owner', name: 'Owner' }] }),
}));
vi.mock('../src/hooks/use-visible-machine-metas', () => ({
  useVisibleMachineMetas: () => ({
    machines: workspaceHarness.machines,
    accessByMachineId: new Map(),
  }),
}));
vi.mock('../src/hooks/use-visible-local-projects', () => ({
  useVisibleLocalProjects: () => ({
    projects: new Map(),
    accessByProjectKey: new Map(),
  }),
}));
vi.mock('../src/hooks/use-open-settings', () => ({
  useOpenSettings: () => ({ openSettings: vi.fn() }),
}));
vi.mock('../src/hooks/use-github-workspace', () => ({
  useGithubWorkspaceQuery: () => [],
}));
vi.mock('../src/lib/commands', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/lib/commands')>();
  return {
    ...actual,
    useCommand: () => undefined,
  };
});
vi.mock('../src/lib/toast', () => ({
  toast: {
    success: (message: string) => {
      workspaceHarness.toasts.push(message);
    },
    error: vi.fn(),
  },
}));
vi.mock('../src/hooks/use-schedules', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/hooks/use-schedules')>();
  return {
    ...actual,
    useScheduleDocument: (scheduleId?: string) => ({
      document: scheduleId ? workspaceHarness.detailDoc : null,
      ready: true,
    }),
  };
});

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = Date.parse('2026-09-06T09:12:00+08:00');
const base = {
  ownerId: 'owner',
  machineId: 'machine',
  enabled: true,
  activationId: 'a',
  activeFrom: 0,
  createdAt: 0,
  updatedAt: 0,
  destination: { kind: 'new_session' },
  elevatedPermissions: false,
  agentConfigId: 'agent',
  definitionFingerprint: 'f',
} as unknown as ScheduleRegistryRow;
const manual = {
  ...base,
  scheduleId: 'm',
  title: 'Deploy checklist',
  trigger: { kind: 'manual' },
} as ScheduleRegistryRow;
const timed = {
  ...base,
  scheduleId: 't',
  title: 'Nightly review',
  trigger: { kind: 'cron', expression: '0 21 * * *', timeZone: 'UTC' },
} as ScheduleRegistryRow;
const context = () => ({
  machine: 'MacBook Pro',
  agent: 'Code reviewer',
  project: null,
  presence: 'online' as const,
  canToggle: true,
  canRun: true,
  canDelete: true,
});

describe('schedule list rows', () => {
  let container: HTMLDivElement;
  let root: Root;
  const handlers = {
    onOpen: vi.fn(),
    onNew: vi.fn(),
    onToggle: vi.fn(),
    onRun: vi.fn(),
    onDelete: vi.fn(),
    onClearEnded: vi.fn(),
    onOpenSession: vi.fn(),
  };
  beforeAll(async () => {
    if (!i18next.isInitialized)
      await i18next.use(initReactI18next).init({
        lng: 'en',
        resources: { en: { translation: en } },
        interpolation: { escapeValue: false },
      });
  });
  beforeEach(() => {
    Object.values(handlers).forEach((fn) => fn.mockReset());
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    act(() =>
      root.render(
        <ScheduleListView
          rows={[manual, timed]}
          runtimes={[]}
          ready
          now={NOW}
          contextForRow={context}
          {...handlers}
        />
      )
    );
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const rowOf = (title: string) =>
    [...container.querySelectorAll('[data-schedule-row]')].find((row) =>
      row.textContent?.includes(title)
    )!;
  const buttonIn = (row: Element, label: string) =>
    row.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

  it.each([false, true])(
    'keeps saved rows visible with a retry action (retrying=%s)',
    (retrying) => {
      const retry = vi.fn();
      act(() =>
        root.render(
          <ScheduleListView
            rows={[timed]}
            runtimes={[]}
            ready
            error="REGISTRY_UNAVAILABLE"
            retrying={retrying}
            onRetry={retry}
            {...handlers}
          />
        )
      );
      expect(rowOf('Nightly review')).toBeTruthy();
      expect(container.querySelector('[role="alert"]')?.textContent).toContain(
        'Showing saved tasks'
      );
      const button = [...container.querySelectorAll('button')].find(
        (b) => b.textContent === (retrying ? 'Retrying…' : 'Retry')
      )!;
      expect(button.disabled).toBe(retrying);
      act(() => button.click());
      expect(retry).toHaveBeenCalledTimes(retrying ? 0 : 1);
    }
  );

  it('offers retry instead of claiming an unavailable registry is empty', () => {
    const retry = vi.fn();
    act(() =>
      root.render(
        <ScheduleListView
          rows={[]}
          runtimes={[]}
          ready
          error="REGISTRY_UNAVAILABLE"
          onRetry={retry}
          {...handlers}
        />
      )
    );
    expect(container.textContent).toContain('Schedules could not be loaded.');
    expect(container.textContent).not.toContain('No schedules yet');
    const button = [...container.querySelectorAll('button')].find(
      (b) => b.textContent === 'Retry'
    )!;
    act(() => button.click());
    expect(retry).toHaveBeenCalledOnce();
  });

  it.each([
    ['America/Los_Angeles', '2:21 AM'],
    ['Asia/Singapore', '5:21 PM'],
  ])('shows the same machine clock in Once frequency and next run (%s)', (timeZone, time) => {
    const once: ScheduleRegistryRow = {
      ...timed,
      trigger: { kind: 'once', at: '2026-10-01T09:21:00.000Z' },
    };
    act(() =>
      root.render(
        <ScheduleListView
          rows={[once]}
          ready
          now={Date.parse('2026-10-01T00:00:00Z')}
          runtimes={[
            {
              scheduleId: once.scheduleId,
              machineId: once.machineId,
              activationId: once.activationId,
              observedDefinitionFingerprint: once.definitionFingerprint,
              nextScheduledAt: Date.parse('2026-10-01T09:21:00Z'),
              updatedAt: 0,
            },
          ]}
          contextForRow={() => ({ ...context(), timeZone })}
          {...handlers}
        />
      )
    );
    const row = container.querySelector('[data-schedule-row]')!;
    expect(row.textContent).toContain(timeZone);
    expect(row.textContent!.split(time)).toHaveLength(3);
  });

  it('gives a manual task a Run button and a timed one a Pause button', () => {
    const manualRow = rowOf('Deploy checklist');
    expect(buttonIn(manualRow, en['schedules.pause'])).toBeNull();
    act(() => buttonIn(manualRow, en['schedules.runNow'])!.click());
    expect(handlers.onRun).toHaveBeenCalledWith(manual);
    const timedRow = rowOf('Nightly review');
    expect(buttonIn(timedRow, en['schedules.runNow'])).toBeNull();
    act(() => buttonIn(timedRow, en['schedules.pause'])!.click());
    expect(handlers.onToggle).toHaveBeenCalledWith(timed);
  });

  const runtime = (row: ScheduleRegistryRow, extra: Partial<ScheduleRuntimeRow> = {}) => ({
    scheduleId: row.scheduleId,
    machineId: row.machineId,
    activationId: row.activationId,
    observedDefinitionFingerprint: row.definitionFingerprint,
    updatedAt: 0,
    ...extra,
  });
  const message = (scheduleId: string, title: string): ScheduleRegistryRow =>
    ({
      ...base,
      scheduleId,
      title,
      scheduledMessage: true,
      trigger: { kind: 'once', at: '2026-09-06T10:00:00.000Z' },
      destination: { kind: 'existing_session', sessionId: 'chat-1' },
    }) as ScheduleRegistryRow;
  const sent = message('sent', 'Ask for the CI summary');
  const pending = message('pending', 'Remind me to ship');
  const paused = {
    ...timed,
    scheduleId: 'p',
    title: 'Weekly report',
    enabled: false,
  } as ScheduleRegistryRow;
  const blocked = {
    ...timed,
    scheduleId: 'b',
    title: 'Release notes',
    projectKey: 'loro-dev/lody',
  } as ScheduleRegistryRow;
  const renderList = (props: Partial<Parameters<typeof ScheduleListView>[0]> = {}) =>
    act(() =>
      root.render(
        <ScheduleListView
          // Filters are initial state: a new key starts a fresh list.
          key={JSON.stringify(props.initialFilters ?? null)}
          rows={[manual, timed, paused, blocked, sent, pending]}
          runtimes={[
            runtime(timed, { nextScheduledAt: Date.parse('2026-09-06T13:00:00Z') }),
            runtime(blocked, { queueState: 'blocked', blockedCode: 'PERMISSION_UNAVAILABLE' }),
            runtime(sent, {
              messageState: 'sent',
              lastDispatch: {
                scheduledFor: 0,
                dispatchedAt: Date.parse('2026-09-06T00:00:00Z'),
                sessionId: 'chat-1',
              },
            }),
            runtime(pending, { messageState: 'pending' }),
          ]}
          ready
          now={NOW}
          contextForRow={(row) => ({
            ...context(),
            project: row.projectKey ?? null,
            chat: row.scheduledMessage ? { title: 'CI triage', sessionId: 'chat-1' } : undefined,
          })}
          {...handlers}
          {...props}
        />
      )
    );
  const titles = () =>
    [...container.querySelectorAll('[data-schedule-row]')].map(
      (row) => row.querySelector('button span:nth-child(2)')?.textContent
    );

  it('filters ownership across tasks and messages, composes with project, and clears filters', () => {
    const teammateTask = { ...blocked, ownerId: 'teammate' };
    const teammateMessage = { ...pending, ownerId: 'teammate' };
    const rows = [manual, teammateTask, sent, teammateMessage];
    renderList({ rows, currentUserId: 'owner', initialFilters: { owner: 'mine' } });
    expect(titles()).toEqual(expect.arrayContaining([manual.title, sent.title]));
    expect(titles()).toHaveLength(2);
    expect(rowOf(manual.title).textContent).toContain('You');

    renderList({ rows, currentUserId: 'owner', initialFilters: { owner: 'others' } });
    expect(titles()).toEqual(expect.arrayContaining([blocked.title, pending.title]));
    expect(titles()).toHaveLength(2);
    expect(rowOf(blocked.title).textContent).toContain('teammate');

    renderList({
      rows,
      currentUserId: 'owner',
      initialFilters: {
        owner: 'others',
        project: { kind: 'project', name: 'loro-dev/lody' },
      },
    });
    expect(titles()).toEqual([blocked.title]);
    const clear = [...container.querySelectorAll('button')].find(
      (button) => button.textContent === 'Clear filters'
    )!;
    act(() => clear.click());
    expect(titles()).toHaveLength(4);

    renderList({
      rows,
      currentUserId: 'owner',
      query: 'missing task',
      initialFilters: { owner: 'mine' },
    });
    expect(titles()).toEqual([]);
    expect(container.textContent).toContain(en['schedules.noMatches']);
  });

  it('clears only finished scheduled messages, and opens a message’s chat from its row', () => {
    renderList();
    const clear = [...container.querySelectorAll('button')].find((b) =>
      b.textContent?.startsWith('Clear finished')
    )!;
    act(() => clear.click());
    expect(handlers.onClearEnded).toHaveBeenCalledWith([sent]);
    const chat = rowOf('Remind me to ship').querySelector<HTMLButtonElement>(
      'button[title="Open chat “CI triage”"]'
    )!;
    act(() => chat.click());
    expect(handlers.onOpenSession).toHaveBeenCalledWith('chat-1');
    expect(handlers.onOpen).not.toHaveBeenCalled();
  });

  it('deletes a finished message from its row without opening it', () => {
    renderList();
    act(() => buttonIn(rowOf('Ask for the CI summary'), en['schedules.delete'])!.click());
    expect(handlers.onDelete).toHaveBeenCalledWith(sent);
    expect(buttonIn(rowOf('Remind me to ship'), en['schedules.delete'])).toBeNull();
  });

  it('shows a scheduled message’s text instead of its stored title', () => {
    renderList({
      contentForRow: (row) =>
        row.scheduleId === 'pending' ? 'Actually review the release notes' : undefined,
    });
    const row = rowOf('Actually review the release notes');
    expect(row.textContent).not.toContain('Remind me to ship');
    expect(row.querySelector('[title="Actually review the release notes"]')).not.toBeNull();
  });

  it('shows a scheduled message at the viewer’s clock, not the machine clock', () => {
    renderList({
      viewerTimeZone: 'Asia/Shanghai',
      contextForRow: (row) => ({
        ...context(),
        project: row.projectKey ?? null,
        timeZone: 'UTC',
        chat: row.scheduledMessage ? { title: 'CI triage', sessionId: 'chat-1' } : undefined,
      }),
    });
    expect(rowOf('Remind me to ship').textContent).toContain('6:00 PM');
    expect(rowOf('Nightly review').textContent).toContain('Runs ');
  });
});

describe('run history of a schedule that posts into one chat', () => {
  it('lists the chat’s turns stamped with this schedule, newest first, with their reply state', async () => {
    const { pickScheduleChatRuns } =
      await import('../src/components/schedules/use-schedule-chat-runs');
    const turn = (id: string, role: 'user' | 'assistant', extra: Record<string, unknown> = {}) =>
      ({ id, role, timestamp: `2026-09-0${id.slice(-1)}T00:00:00Z`, ...extra }) as never;
    const runs = pickScheduleChatRuns(
      [
        turn('u1', 'user', { scheduleRun: { scheduleId: 'journal', turnId: 'u1', title: 'J' } }),
        turn('a1', 'assistant', { userTurnId: 'u1', endedAt: 1 }),
        turn('u2', 'user'),
        turn('u3', 'user', { scheduleRun: { scheduleId: 'other', turnId: 'u3', title: 'O' } }),
        turn('u4', 'user', { scheduleRun: { scheduleId: 'journal', turnId: 'u4', title: 'J' } }),
        turn('a4', 'assistant', { userTurnId: 'u4' }),
      ],
      'journal'
    );
    expect(runs.map((run) => [run.turnId, run.state])).toEqual([
      ['u4', 'running'],
      ['u1', 'done'],
    ]);
  });
});

/**
 * The product language is `zh_CN`, which every `Intl` constructor rejects with a
 * RangeError. These render the real components under it, because the pure
 * formatters were already "correct" in isolation while the pages they back
 * crashed.
 */
describe('Chinese is a product language, not an Intl locale', () => {
  const row: ScheduleRegistryRow = {
    scheduleId: 'daily-review',
    title: '每天回顾',
    ownerId: 'owner',
    machineId: 'machine',
    enabled: true,
    activationId: 'activation',
    activeFrom: 0,
    createdAt: 0,
    updatedAt: 0,
    trigger: { kind: 'cron', expression: '0 9 * * MON-FRI', timeZone: 'Asia/Shanghai' },
    destination: { kind: 'new_session' },
    elevatedPermissions: false,
    agentConfigId: 'agent',
    definitionFingerprint: '0'.repeat(64),
    projectKind: 'github',
    projectKey: 'loro-dev/lody',
  };

  let container: HTMLDivElement;
  let root: Root;
  let instance: typeof i18next;
  beforeAll(async () => {
    instance = i18next.createInstance();
    await instance.use(initReactI18next).init({
      lng: 'zh_CN',
      resources: { zh_CN: { translation: zh }, en: { translation: en } },
      interpolation: { escapeValue: false },
    });
  });
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });
  const render = (node: React.ReactNode) =>
    act(() => root.render(<I18nextProvider i18n={instance}>{node}</I18nextProvider>));

  it('shows a scheduled message on the viewer clock and other schedules on the machine clock', () => {
    const once = { kind: 'once' as const, at: '2026-09-07T09:00:00.000Z' };
    expect(
      scheduleRowTimeZone({ ...row, scheduledMessage: true, trigger: once }, 'UTC', 'Asia/Shanghai')
    ).toBe('Asia/Shanghai');
    expect(scheduleRowTimeZone({ ...row, trigger: once }, 'UTC')).toBe('UTC');
    expect(scheduleRowTimeZone(row, 'UTC')).toBe('Asia/Shanghai');
  });

  it('renders a persisted scheduled queue row under zh_CN', () => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    try {
      const at = NOW + 86_400_000;
      render(
        <ScheduledQueueRow
          item={{
            scheduleId: 's',
            content: '每天回顾',
            at,
            timeZone: 'Asia/Shanghai',
            state: 'pending',
          }}
        />
      );
    } finally {
      vi.useRealTimers();
    }
    const time = container.querySelector('[data-scheduled-row] button');
    expect(time?.textContent).toBe(formatUpcoming(NOW + 86_400_000, 'Asia/Shanghai', NOW, 'zh-CN'));
    expect(time?.textContent).toContain('明天');
    expect(container.textContent).toContain('每天回顾');
  });

  it('renders the schedule list in Chinese', () => {
    const runtimes: ScheduleRuntimeRow[] = [
      {
        scheduleId: row.scheduleId,
        machineId: row.machineId,
        activationId: row.activationId,
        observedDefinitionFingerprint: row.definitionFingerprint,
        updatedAt: 0,
        nextScheduledAt: Date.parse('2026-09-07T09:00:00+08:00'),
      },
    ];
    render(
      <ScheduleListView
        rows={[
          row,
          {
            ...row,
            scheduleId: 'weekly',
            trigger: { kind: 'cron', expression: '0 17 * * 1,3', timeZone: 'Asia/Shanghai' },
          },
        ]}
        runtimes={runtimes}
        ready
        now={NOW}
        onOpen={() => {}}
        onNew={() => {}}
        contextForRow={() => ({
          machine: 'MacBook',
          agent: '代码审查员',
          project: 'loro-dev/lody',
          presence: 'online',
          canToggle: true,
        })}
      />
    );
    expect(container.textContent).toContain('每天回顾');
    expect(container.textContent).toContain(zh['schedules.column.status']);
    expect(container.textContent).not.toContain('* * MON-FRI');
  });

  it.each(['en', 'zh_CN'])(
    'explains that protected-message changes need an owner save in %s',
    async (language) => {
      await act(async () => {
        await instance.changeLanguage(language);
      });
      const message = {
        ...row,
        scheduledMessage: true,
        trigger: { kind: 'once' as const, at: new Date(NOW + 60000).toISOString() },
      };
      try {
        const view = (enabled: boolean) => (
          <ScheduleListView
            rows={[{ ...message, enabled }]}
            runtimes={[
              {
                scheduleId: row.scheduleId,
                machineId: row.machineId,
                activationId: row.activationId,
                observedDefinitionFingerprint: row.definitionFingerprint,
                updatedAt: NOW,
                queueState: 'blocked',
                blockedCode: 'E2EE_SCHEDULE_NOT_AUTHORIZED',
                messageState: 'pending',
              },
            ]}
            ready
            now={NOW}
            onOpen={() => {}}
            onNew={() => {}}
            contextForRow={() => ({
              machine: 'Remote machine',
              agent: 'Agent',
              project: null,
              presence: 'online',
              canToggle: true,
            })}
          />
        );
        render(view(true));
        const recovery =
          language === 'en'
            ? 'Its owner must review and save it again before it can run.'
            : '需要由计划所有者检查并重新保存，才能执行。';
        expect(container.textContent).toContain(recovery);
        expect(container.textContent).not.toContain('E2EE_SCHEDULE_NOT_AUTHORIZED');
        render(view(false));
        expect(container.textContent).not.toContain(recovery);
        expect(container.textContent).toContain(instance.t('schedules.status.cancelling'));
      } finally {
        await act(async () => {
          await instance.changeLanguage('zh_CN');
        });
      }
    }
  );

  it('renders the editor and its weekday pickers in Chinese', () => {
    render(
      <ScheduleForm
        now={NOW}
        saving={false}
        onSave={() => {}}
        initial={{
          title: '每天回顾',
          prompt: '回顾昨天的提交。',
          trigger: { kind: 'cron', expression: '0 17 * * 1,3,5', timeZone: 'Asia/Shanghai' },
          misfire: 'run_once',
          overlap: 'queue_one',
        }}
      />
    );
    expect(container.textContent).toContain(zh['schedules.repeat.label']);
    expect(container.textContent).toContain(zh['schedules.nextRuns']);
    const monday = container.querySelector('[aria-pressed="true"]');
    expect(monday).not.toBeNull();
    expect(monday!.getAttribute('aria-label')).toBeTruthy();
  });
});

describe('bound-session pre-run check', () => {
  const machineId = 'machine-1' as MachineId;
  const sessionId = 'chat-bound' as SessionId;

  it('targets existing_session always, own_session only when created or active, and skips new_session', () => {
    const ownId = scheduleOwnSessionId('sched-own', 0);
    expect(
      resolveScheduleBoundSessionTarget(
        { scheduleId: 'sched-new', destination: { kind: 'new_session' } },
        { hasSession: () => true }
      )
    ).toBeUndefined();
    expect(
      resolveScheduleBoundSessionTarget(
        { scheduleId: 'sched-ex', destination: { kind: 'existing_session', sessionId } },
        { hasSession: () => false }
      )
    ).toEqual({ sessionId, kind: 'existing_session' });
    expect(
      resolveScheduleBoundSessionTarget(
        { scheduleId: 'sched-own', destination: { kind: 'own_session', epoch: 0 } },
        { hasSession: () => false, hasLiveStatus: () => false }
      )
    ).toBeUndefined();
    expect(
      resolveScheduleBoundSessionTarget(
        { scheduleId: 'sched-own', destination: { kind: 'own_session', epoch: 0 } },
        { hasSession: (id) => id === ownId }
      )
    ).toEqual({ sessionId: ownId, kind: 'own_session' });
  });

  it('classifies presence busy, fresh vs stale pointers, RPC busy/idle, check-to-dispatch race, and failures', async () => {
    const rpc = vi.fn<
      (
        machineId: MachineId,
        sessionId: SessionId,
        options?: { timeoutMs?: number }
      ) => Promise<SessionLiveStatusResponse | null>
    >();

    // 1. Live presence immediately reports busy without waiting for RPC.
    expect(
      await inspectBoundSessionBeforeRun({
        machineId,
        sessionId,
        getSnapshot: () => ({
          liveStatus: { type: 'running' },
          presenceSyncState: 'synced',
          machineOnline: true,
          nowMs: NOW,
        }),
        requestLiveStatus: rpc,
      })
    ).toEqual({ state: 'busy', source: 'presence', detail: 'running' });
    expect(rpc).not.toHaveBeenCalled();

    // 2. Fresh pending user-turn activation (< 30s) reports busy.
    const pendingMeta = {
      id: sessionId,
      machineId,
      userId: 'owner',
      createdAt: new Date(NOW - 5_000).toISOString(),
      lastMessageAt: NOW - 2_000,
      latestUserMsgId: 'turn-2',
      lastHandledUserMsgId: 'turn-1',
    } as SessionMeta;
    expect(
      await inspectBoundSessionBeforeRun({
        machineId,
        sessionId,
        getSnapshot: () => ({
          liveStatus: null,
          presenceSyncState: 'synced',
          machineOnline: true,
          sessionMeta: pendingMeta,
          nowMs: NOW,
        }),
        requestLiveStatus: rpc,
      })
    ).toEqual({ state: 'busy', source: 'pointer', detail: 'initializing' });

    // 3. Stale pending pointer (> 30s) defers to daemon RPC: daemon observing no active work => idle.
    rpc.mockResolvedValueOnce({
      type: 'session/live-status_response',
      machineId,
      sessionId,
      success: true,
      state: 'unknown',
      observedAtMs: NOW,
      reason: 'No active session presence or pending daemon work was observed.',
    });
    expect(
      await inspectBoundSessionBeforeRun({
        machineId,
        sessionId,
        getSnapshot: () => ({
          liveStatus: null,
          presenceSyncState: 'synced',
          machineOnline: true,
          sessionMeta: {
            ...pendingMeta,
            lastMessageAt: NOW - UNSTARTED_TRAILING_USER_TURN_TIMEOUT_MS - 1_000,
          },
          nowMs: NOW,
        }),
        requestLiveStatus: rpc,
      })
    ).toEqual({ state: 'idle' });

    // 4. Daemon RPC reporting waiting/running/initializing => busy.
    rpc.mockResolvedValueOnce({
      type: 'session/live-status_response',
      machineId,
      sessionId,
      success: true,
      state: 'waiting',
      observedAtMs: NOW,
    });
    expect(
      await inspectBoundSessionBeforeRun({
        machineId,
        sessionId,
        getSnapshot: () => ({
          liveStatus: null,
          presenceSyncState: 'synced',
          machineOnline: true,
          nowMs: NOW,
        }),
        requestLiveStatus: rpc,
      })
    ).toEqual({ state: 'busy', source: 'rpc', detail: 'waiting' });

    // 5. Check-to-dispatch race: session starts running while RPC is in flight.
    let midFlightStatus: { type: 'running' } | null = null;
    rpc.mockImplementationOnce(async () => {
      midFlightStatus = { type: 'running' };
      return {
        type: 'session/live-status_response',
        machineId,
        sessionId,
        success: true,
        state: 'unknown',
        observedAtMs: NOW,
      };
    });
    expect(
      await inspectBoundSessionBeforeRun({
        machineId,
        sessionId,
        getSnapshot: () => ({
          liveStatus: midFlightStatus,
          presenceSyncState: 'synced',
          machineOnline: true,
          nowMs: NOW,
        }),
        requestLiveStatus: rpc,
      })
    ).toEqual({ state: 'busy', source: 'presence', detail: 'running' });

    // 6. RPC failure, timeout, and definitively offline machine all return unknown.
    rpc.mockRejectedValueOnce(new Error('network error'));
    expect(
      await inspectBoundSessionBeforeRun({
        machineId,
        sessionId,
        getSnapshot: () => ({
          liveStatus: null,
          presenceSyncState: 'synced',
          machineOnline: true,
          nowMs: NOW,
        }),
        requestLiveStatus: rpc,
      })
    ).toEqual({ state: 'unknown', reason: 'rpc_failed', error: 'network error' });

    expect(
      await inspectBoundSessionBeforeRun({
        machineId,
        sessionId,
        getSnapshot: () => ({
          liveStatus: null,
          presenceSyncState: 'synced',
          machineOnline: false,
          nowMs: NOW,
        }),
        requestLiveStatus: rpc,
      })
    ).toEqual({ state: 'unknown', reason: 'machine_offline' });
  });
});

describe('SchedulesWorkspace manual Run now bound-session confirmation', () => {
  const workspaceId = 'ws-test' as WorkspaceId;
  const machineId = 'machine-1' as MachineId;
  const boundSessionId = 'chat-bound' as SessionId;
  let container: HTMLDivElement;
  let root: Root;
  let repo: LoroRepo;
  let store: ReturnType<typeof createStore>;
  let liveStatusResponder: (
    machineId: MachineId,
    sessionId: SessionId
  ) => Promise<SessionLiveStatusResponse | null>;
  let liveStatusCalls: Array<{ machineId: MachineId; sessionId: SessionId }>;
  let withScheduleStoreOverride:
    | ((id: string, fn: () => Promise<unknown>) => Promise<unknown>)
    | undefined;
  let i18nInstance: ReturnType<typeof i18next.createInstance>;

  const createDeferred = <T,>() => {
    let resolve!: (value: T) => void;
    let reject!: (reason?: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
      resolve = res;
      reject = rej;
    });
    return { promise, resolve, reject };
  };

  const manualRequestsFor = async (scheduleId: string) => {
    const flock = await repo.openFlockDoc(getScheduleRegistryFlockDocId(workspaceId));
    return [...flock.flock.scan({ prefix: ['manual', scheduleId] })];
  };

  const setPresence = (opts: {
    machineOnline: boolean;
    sessionStatus?: { type: 'running' } | { type: 'requestPermission' } | null;
    syncState?: 'synced' | 'connecting' | 'idle';
  }) => {
    const now = Date.now();
    const states: Record<string, unknown> = {};
    if (opts.machineOnline) {
      states[`m:${machineId}`] = {
        kind: 'machine',
        machineId,
        instanceId: 'inst-1',
        updatedAt: now,
      };
    }
    if (opts.sessionStatus) {
      states[`s:${boundSessionId}`] = {
        kind: 'session',
        sessionId: boundSessionId,
        machineId,
        instanceId: 'inst-1',
        status: opts.sessionStatus,
        updatedAt: now,
      };
    }
    store.set(lodyPresenceNowMsAtom, now);
    store.set(lodyPresenceStatesAtom, states as never);
    store.set(lodyPresenceSyncStateAtom, opts.syncState ?? 'synced');
  };

  const seedSchedule = async (args: {
    scheduleId: string;
    title: string;
    destination: ScheduleRegistryRow['destination'];
  }) => {
    const repository = new ScheduleRepository(repo, workspaceId);
    const saved = await repository.save({
      scheduleId: args.scheduleId,
      activationId: `act-${args.scheduleId}`,
      activityId: `ev-${args.scheduleId}`,
      actorId: 'owner',
      now: NOW,
      create: true,
      draft: {
        title: args.title,
        prompt: 'Run check',
        trigger: { kind: 'manual' },
        machineId,
        agent: { agentConfigId: 'agent-1' },
        destination: args.destination,
        misfirePolicy: { kind: 'run_once' },
        overlapPolicy: 'queue_one',
        retryPolicy: { dispatchMaxAttempts: 5, dispatchMaxAgeMs: 86_400_000 },
      },
    });
    const rows = await repository.list();
    store.set(scheduleRegistryAtom, {
      workspaceId,
      rows,
      runtimes: [],
      ready: true,
    });
    return saved;
  };

  const flushUi = async () => {
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });
  };

  const mountWorkspace = async (scheduleId?: string) => {
    await act(async () => {
      root.render(
        <TestCloudPlatformProvider>
          <I18nextProvider i18n={i18nInstance}>
            <Provider store={store}>
              <SchedulesWorkspace scheduleId={scheduleId} />
            </Provider>
          </I18nextProvider>
        </TestCloudPlatformProvider>
      );
    });
    // Wait for lazy ScheduleRepository dynamic import in SchedulesWorkspace.
    await flushUi();
    await flushUi();
  };

  const findDialog = () => document.body.querySelector<HTMLElement>('[role="alertdialog"]');
  const clickButtonText = async (rootEl: ParentNode, label: string) => {
    const btn = [...rootEl.querySelectorAll<HTMLButtonElement>('button')].find(
      (b) => b.textContent?.trim() === label
    );
    expect(btn, `expected button "${label}"`).toBeTruthy();
    await act(async () => {
      btn!.click();
    });
    await flushUi();
  };

  beforeEach(async () => {
    layout.mobile = false;
    workspaceHarness.workspaceId = workspaceId;
    workspaceHarness.toasts = [];
    workspaceHarness.detailDoc = null;
    workspaceHarness.machines = new Map([
      [
        machineId,
        {
          id: machineId,
          name: 'MacBook Pro',
          ownerUserId: 'owner',
          protocolCapabilities: CURRENT_MACHINE_PROTOCOL_CAPABILITIES,
        } as MachineViewMeta,
      ],
    ]);
    liveStatusCalls = [];
    withScheduleStoreOverride = undefined;
    liveStatusResponder = async () => ({
      type: 'session/live-status_response',
      machineId,
      sessionId: boundSessionId,
      success: true,
      state: 'unknown',
      observedAtMs: Date.now(),
    });
    repo = await LoroRepo.create({});
    store = createStore();
    store.set(userAtom, { id: 'owner', name: 'Owner' } as never);
    store.set(currentWorkspaceSlugAtom, 'ws-slug');
    store.set(sessionMetaCacheAtom, {
      [getSessionRoomId(boundSessionId)]: {
        id: boundSessionId,
        title: 'Release Chat',
        machineId,
        userId: 'owner',
        agentConfigId: 'agent-1',
        createdAt: new Date(NOW).toISOString(),
      } as SessionMeta,
    });
    setPresence({ machineOnline: true, sessionStatus: null, syncState: 'synced' });
    const runtime = {
      workspaceId,
      workspaceSlug: 'ws-slug',
      contentMode: 'plaintext',
      repo,
      withScheduleStore: async (id: string, fn: () => Promise<unknown>) =>
        withScheduleStoreOverride ? await withScheduleStoreOverride(id, fn) : await fn(),
      requestSessionLiveStatus: async (mId: MachineId, sId: SessionId) => {
        liveStatusCalls.push({ machineId: mId, sessionId: sId });
        return await liveStatusResponder(mId, sId);
      },
    } as unknown as WorkspaceRuntime;
    store.set(runtimeAtom, runtime);

    i18nInstance = i18next.createInstance();
    await i18nInstance.use(initReactI18next).init({
      lng: 'en',
      resources: {
        en: { translation: en },
        zh_CN: { translation: zh },
      },
      interpolation: { escapeValue: false },
    });

    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    await repo.destroy();
  });

  it('runs new_session and idle existing_session schedules directly from the list without confirmation', async () => {
    await seedSchedule({
      scheduleId: 'sched-new',
      title: 'Fresh Chat Task',
      destination: { kind: 'new_session' },
    });
    await seedSchedule({
      scheduleId: 'sched-idle',
      title: 'Bound Idle Task',
      destination: { kind: 'existing_session', sessionId: boundSessionId },
    });
    await mountWorkspace();

    const rowOf = (title: string) =>
      [...container.querySelectorAll('[data-schedule-row]')].find((el) =>
        el.textContent?.includes(title)
      )!;
    const runBtn = (title: string) =>
      rowOf(title).querySelector<HTMLButtonElement>(`button[aria-label="${en['schedules.runNow']}"]`)!;

    await act(async () => {
      runBtn('Fresh Chat Task').click();
    });
    await flushUi();
    expect(findDialog()).toBeNull();
    expect(liveStatusCalls).toHaveLength(0);
    expect(await manualRequestsFor('sched-new')).toHaveLength(1);

    await act(async () => {
      runBtn('Bound Idle Task').click();
    });
    await flushUi();
    expect(findDialog()).toBeNull();
    expect(liveStatusCalls).toEqual([{ machineId, sessionId: boundSessionId }]);
    expect(await manualRequestsFor('sched-idle')).toHaveLength(1);
  });

  it.each(['en', 'zh_CN'] as const)(
    'confirms before running a busy bound session, cancels without dispatch, and confirms once (%s)',
    async (language) => {
      await i18nInstance.changeLanguage(language);
      await seedSchedule({
        scheduleId: 'sched-busy',
        title: 'Release Sync',
        destination: { kind: 'existing_session', sessionId: boundSessionId },
      });
      setPresence({ machineOnline: true, sessionStatus: { type: 'running' } });
      await mountWorkspace();

      const runLabel = i18nInstance.t('schedules.runNow');
      const runBtn = container.querySelector<HTMLButtonElement>(`button[aria-label="${runLabel}"]`)!;
      await act(async () => {
        runBtn.click();
      });
      await flushUi();

      const dialog = findDialog();
      expect(dialog).not.toBeNull();
      expect(dialog!.textContent).toContain(
        i18nInstance.t('schedules.runNowBusyTitle', { chat: 'Release Chat' })
      );
      expect(dialog!.textContent).toContain(
        i18nInstance.t('schedules.runNowBusyHelp', { title: 'Release Sync' })
      );
      expect(await manualRequestsFor('sched-busy')).toHaveLength(0);

      // Cancel does not dispatch.
      await clickButtonText(dialog!, i18nInstance.t('schedules.cancel'));
      expect(findDialog()).toBeNull();
      expect(await manualRequestsFor('sched-busy')).toHaveLength(0);

      // Trigger again and confirm => dispatches exactly once.
      await act(async () => {
        runBtn.click();
      });
      await flushUi();
      await clickButtonText(findDialog()!, i18nInstance.t('schedules.runNowConfirm'));
      expect(findDialog()).toBeNull();
      expect(await manualRequestsFor('sched-busy')).toHaveLength(1);
      expect(workspaceHarness.toasts).toContain(
        i18nInstance.t('schedules.runStarted', { title: 'Release Sync' })
      );
    }
  );

  it('confirms when bound session live status check fails (unknown), and respects cancel vs confirm', async () => {
    await seedSchedule({
      scheduleId: 'sched-err',
      title: 'Nightly Check',
      destination: { kind: 'existing_session', sessionId: boundSessionId },
    });
    liveStatusResponder = async () => {
      throw new Error('RPC timeout');
    };
    await mountWorkspace();

    const runBtn = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${en['schedules.runNow']}"]`
    )!;
    await act(async () => {
      runBtn.click();
    });
    await flushUi();

    const dialog = findDialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('Couldn’t confirm whether “Release Chat” is running');
    expect(await manualRequestsFor('sched-err')).toHaveLength(0);

    await clickButtonText(dialog!, en['schedules.cancel']);
    expect(await manualRequestsFor('sched-err')).toHaveLength(0);

    await act(async () => {
      runBtn.click();
    });
    await flushUi();
    await clickButtonText(findDialog()!, en['schedules.runNowConfirm']);
    expect(await manualRequestsFor('sched-err')).toHaveLength(1);
  });

  it('deduplicates rapid clicks and catches check-to-dispatch race when bound session turns busy mid-check', async () => {
    await seedSchedule({
      scheduleId: 'sched-race',
      title: 'Race Task',
      destination: { kind: 'existing_session', sessionId: boundSessionId },
    });
    const deferred = createDeferred<SessionLiveStatusResponse | null>();
    liveStatusResponder = () => deferred.promise;
    await mountWorkspace();

    const runBtn = container.querySelector<HTMLButtonElement>(
      `button[aria-label="${en['schedules.runNow']}"]`
    )!;
    await act(async () => {
      runBtn.click();
      runBtn.click();
    });
    await flushUi();
    // Second click while check is in flight is deduplicated.
    expect(liveStatusCalls).toHaveLength(1);
    expect(await manualRequestsFor('sched-race')).toHaveLength(0);

    // Session flips to busy while the RPC is still pending.
    act(() => {
      setPresence({ machineOnline: true, sessionStatus: { type: 'running' } });
    });
    deferred.resolve({
      type: 'session/live-status_response',
      machineId,
      sessionId: boundSessionId,
      success: true,
      state: 'unknown',
      observedAtMs: Date.now(),
    });
    await flushUi();

    // Must not silently dispatch; opens busy confirmation instead.
    expect(await manualRequestsFor('sched-race')).toHaveLength(0);
    const dialog = findDialog();
    expect(dialog).not.toBeNull();
    expect(dialog!.textContent).toContain('“Release Chat” is currently running');
  });

  it('escalates detail-view Run now confirmation if the bound session becomes busy before confirm, and surfaces dispatch errors', async () => {
    const doc = await seedSchedule({
      scheduleId: 'sched-detail',
      title: 'Detail Task',
      destination: { kind: 'existing_session', sessionId: boundSessionId },
    });
    workspaceHarness.detailDoc = doc;
    await mountWorkspace('sched-detail');

    // Click the manual Run now button in the detail header while the chat is idle.
    const detailRunBtn = [...document.body.querySelectorAll<HTMLButtonElement>('button')].find(
      (btn) => btn.textContent?.trim() === en['schedules.runNow']
    )!;
    expect(detailRunBtn).toBeTruthy();
    await act(async () => {
      detailRunBtn.click();
    });
    await flushUi();

    // Standard detail confirmation opens first because the bound chat was idle.
    const idleDialog = findDialog();
    expect(idleDialog).not.toBeNull();
    expect(idleDialog!.textContent).toContain(en['schedules.runNowHelp']);

    // Bound chat starts running before the user confirms.
    act(() => {
      setPresence({ machineOnline: true, sessionStatus: { type: 'running' } });
    });
    await clickButtonText(idleDialog!, en['schedules.confirm']);

    // Escalated to busy confirmation instead of dispatching silently.
    expect(await manualRequestsFor('sched-detail')).toHaveLength(0);
    const busyDialog = findDialog();
    expect(busyDialog).not.toBeNull();
    expect(busyDialog!.textContent).toContain('“Release Chat” is currently running');

    // Dispatch error surfaces in the alert banner without locking future actions.
    withScheduleStoreOverride = async () => {
      throw new Error('Disk write failed');
    };
    await clickButtonText(busyDialog!, en['schedules.runNowConfirm']);
    expect(findDialog()).toBeNull();
    expect(container.querySelector('[role="alert"]')?.textContent).toContain('Disk write failed');
    expect(await manualRequestsFor('sched-detail')).toHaveLength(0);
  });
});
