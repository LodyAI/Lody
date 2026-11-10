// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';

import type { ScheduleRegistryRow, ScheduleRuntimeRow } from '@lody/shared';
import en from '../../../locales/en.json';

import { ScheduleListView } from '../src/components/schedules/schedule-view';

const layout = vi.hoisted(() => ({ mobile: false, macElectron: false }));

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
