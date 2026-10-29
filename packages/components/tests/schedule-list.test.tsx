// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import i18next from 'i18next';
import { initReactI18next } from 'react-i18next';
import { createStore, Provider } from 'jotai';
import type { ScheduleRegistryRow, ScheduleRuntimeRow } from '@lody/shared';
import en from '../../../locales/en.json';
import { sidebarCollapsedAtom } from '../src/atoms/sidebar-state';
import { navigationSidebarVisibleAtom } from '../src/atoms/layout-state';
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

  it('offers run, pause and delete from the row’s context menu', () => {
    act(() => {
      rowOf('Nightly review').dispatchEvent(
        new MouseEvent('contextmenu', { bubbles: true, clientX: 10, clientY: 10 })
      );
    });
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    expect(items.map((item) => item.textContent)).toEqual([
      en['schedules.open'],
      en['schedules.runNow'],
      en['schedules.pause'],
      en['schedules.delete'],
    ]);
    act(() => (items[3] as HTMLElement).click());
    expect(handlers.onDelete).toHaveBeenCalledWith(timed);
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

  it('states each row’s status in words, separating tasks from scheduled messages', () => {
    renderList();
    expect(rowOf('Weekly report').textContent).toContain(en['schedules.paused']);
    expect(rowOf('Release notes').textContent).toContain(en['schedules.state.blocked']);
    expect(rowOf('Ask for the CI summary').textContent).toContain(en['schedules.status.sent']);
    expect(rowOf('Nightly review').textContent).toContain('Runs ');
    const headings = [...container.querySelectorAll('h2')].map((h) => h.textContent);
    expect(headings).toEqual([en['schedules.section.tasks'], en['schedules.section.messages']]);
    // Only scheduled messages explain themselves: they send once.
    const infos = [...container.querySelectorAll('button[aria-label^="What are"]')].map((b) =>
      b.getAttribute('aria-label')
    );
    expect(infos).toEqual([`What are ${en['schedules.section.messages']}?`]);
  });

  it('filters by status and project, and sorts by name', () => {
    renderList({ initialFilters: { status: 'paused' } });
    expect(titles()).toEqual(['Weekly report']);
    renderList({ initialFilters: { project: { kind: 'project', name: 'loro-dev/lody' } } });
    expect(titles()).toEqual(['Release notes']);
    renderList({ initialFilters: { sort: 'name', project: { kind: 'none' }, status: 'running' } });
    expect(titles()).toEqual(['Deploy checklist', 'Nightly review', 'Remind me to ship']);
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

  it('clears the status bar on the edge-to-edge list and stays flush when embedded', () => {
    const header = () => container.querySelector('header')!;
    const embeddedClass = header().className;
    expect(header().hasAttribute('data-safe-area-inset')).toBe(false);
    act(() =>
      root.render(
        <ScheduleListView
          insetSafeArea
          rows={[manual, timed]}
          runtimes={[]}
          ready
          now={NOW}
          contextForRow={context}
          {...handlers}
        />
      )
    );
    expect(header().hasAttribute('data-safe-area-inset')).toBe(true);
    // The safe-area rule replaces the fixed 44px height. jsdom does not
    // apply the StyleX sheet, so the class change is the check.
    expect(header().className).not.toBe(embeddedClass);
  });

  it('uses the home search text and hides the standalone header', () => {
    act(() =>
      root.render(
        <ScheduleListView
          hideHeader
          query="night"
          rows={[manual, timed]}
          runtimes={[]}
          ready
          now={NOW}
          contextForRow={context}
          {...handlers}
        />
      )
    );
    expect(container.querySelector('header')).toBeNull();
    expect(container.textContent).toContain('Nightly review');
    expect(container.textContent).not.toContain('Deploy checklist');
    expect(container.querySelector('[data-schedule-row]')?.textContent).toContain('MacBook Pro');
    expect(buttonIn(rowOf('Nightly review'), 'Pause')).not.toBeNull();
    expect(container.querySelector('[role=separator]')).toBeNull();
  });
});

describe('schedule list sidebar chrome', () => {
  let container: HTMLDivElement;
  let root: Root;
  const handlers = {
    onOpen: vi.fn(),
    onNew: vi.fn(),
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
    layout.mobile = false;
    layout.macElectron = false;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    window.localStorage.removeItem('lody-sidebar-collapsed');
  });

  function render(store: ReturnType<typeof createStore>) {
    act(() =>
      root.render(
        <Provider store={store}>
          <ScheduleListView
            rows={[manual]}
            runtimes={[]}
            ready
            now={NOW}
            contextForRow={context}
            {...handlers}
          />
        </Provider>
      )
    );
  }

  it('hides the expand control while the navigation sidebar is on screen', () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, false);
    render(store);
    expect(container.querySelector('button[aria-label="Show navigation sidebar"]')).toBeNull();
    expect(container.querySelector('header')?.hasAttribute('data-beside-traffic-lights')).toBe(
      false
    );
  });

  it('shows the expand control on desktop when the navigation sidebar is hidden', () => {
    const store = createStore();
    store.set(sidebarCollapsedAtom, true);
    render(store);
    const toggle = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Show navigation sidebar"]'
    );
    expect(toggle).not.toBeNull();
    expect(store.get(navigationSidebarVisibleAtom)).toBe(false);
    act(() => toggle!.click());
    expect(store.get(navigationSidebarVisibleAtom)).toBe(true);
    expect(store.get(sidebarCollapsedAtom)).toBe(false);
  });

  it('keeps the expand control off the mobile list', () => {
    layout.mobile = true;
    const store = createStore();
    store.set(sidebarCollapsedAtom, true);
    render(store);
    expect(container.querySelector('button[aria-label="Show navigation sidebar"]')).toBeNull();
  });

  it('insets the header beside macOS traffic lights when the sidebar is hidden', () => {
    layout.macElectron = true;
    const store = createStore();
    store.set(sidebarCollapsedAtom, true);
    render(store);
    expect(container.querySelector('header')?.hasAttribute('data-beside-traffic-lights')).toBe(
      true
    );
    store.set(sidebarCollapsedAtom, false);
    render(store);
    expect(container.querySelector('header')?.hasAttribute('data-beside-traffic-lights')).toBe(
      false
    );
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
