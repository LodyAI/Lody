// @vitest-environment jsdom
import { act, Profiler, useState, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { createStore, Provider } from 'jotai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  planStatusViewCommand,
  type PinSection,
  type StatusViewCommand,
  type StatusViewState,
} from '@lody/shared';
import { MobileChatList } from '../src/components/mobile/mobile-chat-list';
import type { MobileConversationItem } from '../src/components/mobile/mobile-project-screen';
import type { MobileStatusCommands } from '../src/components/mobile/use-mobile-status-list';
import { LIFT_DELAY_MS } from '../src/components/mobile/use-status-list-drag';
import {
  presetTimeFormatter,
  resolveCustomLaterTime,
} from '../src/components/mobile/mobile-later-sheet';
import { planStatusUndo } from '../src/components/mobile/use-mobile-status-actions';
import { toStatusViewSession } from '../src/components/mobile/mobile-status-view';
import { initI18n } from '../src/i18n';
import { createTestI18n, withTestI18n } from './test-i18n';

/** The fake host runs the real shared planner and applies its writes to the rows. */

vi.mock('../src/ui/drawer', () => {
  const Part = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  return {
    Drawer: ({ children, open }: { children?: ReactNode; open: boolean }) =>
      open ? <div data-test-sheet="">{children}</div> : null,
    DrawerContent: Part,
    DrawerTitle: Part,
    DrawerDescription: Part,
    DrawerClose: Part,
  };
});

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;
const NOW = Date.UTC(2026, 10, 21, 10, 0, 0);

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function item(overrides: Partial<MobileConversationItem> & { id: string }): MobileConversationItem {
  return {
    kind: 'chat',
    title: overrides.id,
    latestMessageAt: NOW - HOUR,
    lastMessageAt: NOW - HOUR,
    lastReadAt: NOW,
    ...overrides,
  };
}

type Host = {
  chats: MobileConversationItem[];
  sections: PinSection[];
  /** When set, the next write fails (after the list has shown its held order). */
  fail?: boolean;
  /** When set, writes are planned but not applied yet (no read-back). */
  holdWrites?: boolean;
};

let container: HTMLDivElement;
let root: Root;
let setHost: (update: (host: Host) => Host) => void;
let currentHost: Host;

function apply(host: Host, state: StatusViewState, command: StatusViewCommand): Host {
  const writes = planStatusViewCommand(state, command, { nowMs: NOW, randomByte: () => 128 });
  let { chats, sections } = host;
  for (const write of writes) {
    if (write.type === 'session') {
      chats = chats.map((chat) => {
        if (chat.id !== write.sessionId) return chat;
        const next: MobileConversationItem = { ...chat };
        for (const [key, value] of Object.entries(write.patch))
          (next as Record<string, unknown>)[key] = value;
        return next;
      });
    } else if (write.type === 'putSection') {
      sections = [...sections.filter((section) => section.id !== write.section.id), write.section];
    } else {
      sections = sections.filter((section) => section.id !== write.sectionId);
    }
  }
  return { ...host, chats, sections };
}

type HarnessOptions = {
  writable?: boolean;
  preferable?: boolean;
  groupBy?: 'status' | 'project';
  scopeHiddenCounts?: Record<string, number>;
};

function Harness({
  initial,
  writable = true,
  preferable = true,
  groupBy = 'status',
  scopeHiddenCounts,
}: { initial: Host } & HarnessOptions) {
  const [host, update] = useState(initial);
  setHost = update;
  currentHost = host;
  const run = async (command: StatusViewCommand, state: StatusViewState) => {
    if (currentHost.fail) throw new Error('write refused');
    if (currentHost.holdWrites) return;
    update((current) => apply(current, state, command));
  };
  const stateOf = (): StatusViewState => ({
    sessions: [],
    sections: currentHost.sections,
    sectionsLoaded: true,
    canManageSections: true,
    nowMs: NOW,
  });
  const commands: MobileStatusCommands = {
    run,
    snooze: (sessionId, until) =>
      update((current) =>
        apply(current, withSessions(stateOf(), current), {
          type: 'snooze',
          sessionId,
          until,
          includeOpened: false,
        })
      ),
    settle: (sessionId) =>
      update((current) =>
        apply(current, withSessions(stateOf(), current), {
          type: 'settle',
          sessionId,
          includeOpened: false,
        })
      ),
    moveToFocus: (sessionId) =>
      update((current) =>
        apply(current, withSessions(stateOf(), current), {
          type: 'moveToFocus',
          sessionId,
          includeOpened: false,
        })
      ),
    report: () => {},
  };
  return (
    <MobileChatList
      chats={host.chats}
      groupBy={groupBy}
      capGroupPreviews
      pinSections={host.sections}
      statusCommands={commands}
      statusWritable={writable}
      statusPreferable={preferable}
      scopeHiddenCounts={scopeHiddenCounts}
      rowActions={{
        onTogglePin: (id, pinned) =>
          update((current) =>
            apply(current, withSessions(stateOf(), current), {
              type: 'setPinned',
              sessionId: id,
              pinned,
            })
          ),
        onArchive: () => {},
      }}
    />
  );
}

function withSessions(state: StatusViewState, host: Host): StatusViewState {
  return { ...state, sessions: host.chats.map((chat) => toStatusViewSession(chat)) };
}

function render(initial: Host, options: HarnessOptions | boolean = {}) {
  const resolved = typeof options === 'boolean' ? { writable: options } : options;
  act(() => {
    root.render(
      <Provider store={createStore()}>
        <Harness initial={initial} {...resolved} />
      </Provider>
    );
  });
}

/** Row ids in render order (every fixture row is top-level, so the id is its own). */
const rowTitles = () =>
  Array.from(container.querySelectorAll('[data-status-row-id]')).map(
    (row) => row.getAttribute('data-status-row-id') ?? ''
  );
const text = () => container.textContent ?? '';
const sheetButtons = () =>
  Array.from(document.querySelectorAll<HTMLButtonElement>('[data-test-sheet] button')).map(
    (button) => button.textContent?.trim() ?? ''
  );
const clickSheet = (label: string) => {
  const button = Array.from(
    document.querySelectorAll<HTMLButtonElement>('[data-test-sheet] button')
  ).find((candidate) => candidate.textContent?.trim() === label);
  if (!button) throw new Error(`no sheet button ${label}: ${sheetButtons().join(', ')}`);
  act(() => button.click());
};
const heading = (label: string) =>
  Array.from(container.querySelectorAll<HTMLButtonElement>('button[aria-expanded]')).find(
    (button) => button.textContent?.trim().replace(/\d+$/, '') === label
  )!;
const rowElement = (id: string) =>
  container.querySelector<HTMLElement>(`[data-status-row-id="${id}"]`)!;

function pointer(type: string, target: Element, x: number, y: number, pointerId = 1) {
  const event = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button: 0,
  });
  Object.defineProperty(event, 'pointerId', { value: pointerId });
  act(() => {
    target.dispatchEvent(event);
  });
}

/** Long press without moving: the row's action menu. */
function longPress(id: string) {
  const row = rowElement(id);
  pointer('pointerdown', row, 10, 10);
  act(() => vi.advanceTimersByTime(LIFT_DELAY_MS));
  pointer('pointerup', row, 10, 10);
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(NOW);
  await initI18n();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.useRealTimers();
});

describe('phone Status grouping', () => {
  const tiers = (): MobileConversationItem[] => [
    item({ id: 'focus-a', orderKey: '80' }),
    item({ id: 'focus-b', orderKey: '81' }),
    item({ id: 'later', snoozedUntil: NOW + 3 * HOUR }),
    item({ id: 'settled', settledAt: NOW }),
    item({ id: 'quiet', latestMessageAt: NOW - 8 * DAY, lastMessageAt: NOW - 8 * DAY }),
    item({ id: 'pinned', isPinned: true }),
  ];

  it('shows Pinned, then Focus, with Later and Settled collapsed until opened', () => {
    render({ chats: tiers(), sections: [] });
    expect(rowTitles()).toEqual(['pinned', 'focus-a', 'focus-b']);
    expect(text()).toContain('Later');
    act(() => heading('Later').click());
    expect(rowTitles()).toEqual(['pinned', 'focus-a', 'focus-b', 'later']);
    expect(rowElement('later').textContent).toContain('3h');
    act(() => heading('Settled').click());
    expect(rowTitles().slice(-2).sort()).toEqual(['quiet', 'settled']);
  });

  it('folds Settled past 20 rows behind Show more', () => {
    const settled = Array.from({ length: 23 }, (_, index) =>
      item({ id: `s${index}`, settledAt: NOW - index })
    );
    render({ chats: settled, sections: [] });
    act(() => heading('Settled').click());
    expect(rowTitles()).toHaveLength(20);
    expect(text()).toContain('Show more');
  });

  it('offers each tier its own swipe actions', () => {
    render({ chats: tiers(), sections: [] });
    act(() => heading('Settled').click());
    const actionsOf = (id: string) =>
      Array.from(
        rowElement(id).querySelectorAll<HTMLButtonElement>('[data-status-swipe-row] > div button')
      ).map((button) => button.getAttribute('aria-label'));
    expect(actionsOf('focus-a')).toEqual(['Pin', 'Settle', 'Later']);
    expect(actionsOf('settled')).toEqual(['Pin', 'Archive']);
  });

  it('long press opens the action menu; Settle moves the row to Settled', () => {
    render({ chats: tiers(), sections: [] });
    longPress('focus-a');
    expect(sheetButtons()).toEqual(
      expect.arrayContaining(['Later', 'Settle', 'Pin Session', 'Move down', 'Archive Session'])
    );
    expect(sheetButtons()).not.toContain('Move to Focus');
    clickSheet('Settle');
    act(() => heading('Settled').click());
    expect(
      container.querySelector('[data-status-area="settled"][data-status-row-id="focus-a"]')
    ).not.toBeNull();
  });

  it('reorders Focus from the menu and holds the order until the write reads back', () => {
    render({ chats: tiers(), sections: [], holdWrites: true });
    longPress('focus-a');
    clickSheet('Move down');
    expect(rowTitles()).toEqual(['pinned', 'focus-b', 'focus-a']);
    act(() => setHost((host) => ({ ...host, holdWrites: false })));
    longPress('focus-b');
    clickSheet('Move down');
    expect(rowTitles()).toEqual(['pinned', 'focus-a', 'focus-b']);
  });

  it('drops the held order when the write is refused', async () => {
    render({ chats: tiers(), sections: [], fail: true });
    longPress('focus-a');
    clickSheet('Move down');
    await act(async () => {});
    expect(rowTitles()).toEqual(['pinned', 'focus-a', 'focus-b']);
  });

  it('drags a Settled row into Focus', () => {
    render({ chats: tiers(), sections: [] });
    act(() => heading('Settled').click());
    const target = rowElement('focus-a');
    target.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40 }) as DOMRect;
    document.elementFromPoint = () => target;
    const dragged = rowElement('settled');
    pointer('pointerdown', dragged, 10, 300);
    act(() => vi.advanceTimersByTime(LIFT_DELAY_MS));
    pointer('pointermove', dragged, 10, 100);
    pointer('pointermove', dragged, 10, 5);
    expect(container.querySelector('[data-status-drop-indicator]')).not.toBeNull();
    pointer('pointerup', dragged, 10, 5);
    expect(rowTitles().slice(0, 3)).toEqual(['pinned', 'settled', 'focus-a']);
  });

  it('keeps status actions away from a read-only row but still lets it be pinned', () => {
    render({ chats: [item({ id: 'shared', readOnly: true }), item({ id: 'own' })], sections: [] });
    longPress('shared');
    expect(sheetButtons()).not.toContain('Settle');
    expect(sheetButtons()).not.toContain('Later');
    expect(sheetButtons()).toContain('Pin Session');
  });

  it('offers a read-only workspace member only pinning', () => {
    render(
      {
        chats: [item({ id: 'a', isPinned: true, pinSectionId: 'first' }), item({ id: 'own' })],
        sections: [{ id: 'first', name: 'First', orderKey: '80' }],
      },
      false
    );
    expect(container.querySelector('[data-status-section-menu]')).toBeNull();
    longPress('own');
    expect(sheetButtons()).toContain('Pin Session');
    for (const label of ['Later', 'Settle', 'Move down', 'Move to top'])
      expect(sheetButtons()).not.toContain(label);
  });

  it('acts on a nested opened conversation alone, never on its opener', () => {
    render({
      chats: [
        item({ id: 'opener', orderKey: '80' }),
        item({ id: 'child', openedBySessionId: 'opener', openedByRowSessionId: 'opener' }),
      ],
      sections: [],
    });
    expect(rowElement('child').getAttribute('data-status-root-id')).toBe('opener');
    longPress('child');
    expect(sheetButtons()).not.toContain('Move to top');
    clickSheet('Settle');
    act(() => heading('Settled').click());
    expect(
      container.querySelector('[data-status-area="settled"][data-status-row-id="child"]')
    ).not.toBeNull();
    expect(currentHost.chats.find((chat) => chat.id === 'opener')?.settledAt).toBeUndefined();
  });

  it('offers Later on a Later row so its wake-up can be moved', () => {
    render({ chats: [item({ id: 'later', snoozedUntil: NOW + 3 * HOUR })], sections: [] });
    act(() => heading('Later').click());
    longPress('later');
    expect(sheetButtons()).toEqual(expect.arrayContaining(['Move to Focus', 'Later', 'Settle']));
  });

  it('gives a read-only member no status swipes, and no pin where pins cannot land', () => {
    render({ chats: [item({ id: 'row' })], sections: [] }, { writable: false });
    const actionsOf = () =>
      Array.from(
        rowElement('row').querySelectorAll<HTMLButtonElement>('[data-status-swipe-action]')
      ).map((button) => button.getAttribute('aria-label'));
    expect(actionsOf()).toEqual(['Pin', 'Archive']);
    render({ chats: [item({ id: 'row' })], sections: [] }, { writable: false, preferable: false });
    expect(actionsOf()).toEqual(['Archive']);
  });

  it('does not spin on a wake-up past the timer limit, which browsers fire at once', () => {
    const fakeSetTimeout = window.setTimeout;
    vi.spyOn(window, 'setTimeout').mockImplementation(((handler: () => void, delay?: number) =>
      fakeSetTimeout(handler, (delay ?? 0) > 2_147_483_647 ? 1 : delay)) as typeof setTimeout);
    let commits = 0;
    act(() => {
      root.render(
        <Provider store={createStore()}>
          <Profiler id="list" onRender={() => (commits += 1)}>
            <Harness
              initial={{
                chats: [item({ id: 'pinned', isPinned: true, snoozedUntil: NOW + 30 * DAY })],
                sections: [],
              }}
              groupBy="project"
            />
          </Profiler>
        </Provider>
      );
    });
    const settled = commits;
    for (let step = 0; step < 50; step += 1) act(() => vi.advanceTimersByTime(100));
    expect(commits - settled).toBeLessThan(3);
    vi.restoreAllMocks();
  });

  it('cancels a drop released away from any slot', () => {
    render({
      chats: [item({ id: 'focus-a', orderKey: '80' }), item({ id: 'old', settledAt: NOW })],
      sections: [],
    });
    act(() => heading('Settled').click());
    const focus = rowElement('focus-a');
    focus.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40 }) as DOMRect;
    const dragged = rowElement('old');
    let under: Element | null = focus;
    document.elementFromPoint = () => under;
    pointer('pointerdown', dragged, 10, 300);
    act(() => vi.advanceTimersByTime(LIFT_DELAY_MS));
    pointer('pointermove', dragged, 10, 5);
    expect(container.querySelector('[data-status-drop-indicator]')).not.toBeNull();
    under = dragged;
    pointer('pointermove', dragged, 10, 300);
    pointer('pointerup', dragged, 10, 300);
    expect(
      container.querySelector('[data-status-area="settled"][data-status-row-id="old"]')
    ).not.toBeNull();
  });

  it('drags after a slow sideways start, and a second finger cancels the lift', () => {
    render({
      chats: [item({ id: 'a', orderKey: '80' }), item({ id: 'b', orderKey: '81' })],
      sections: [],
    });
    const a = rowElement('a');
    pointer('pointerdown', a, 10, 10);
    act(() => vi.advanceTimersByTime(LIFT_DELAY_MS));
    expect(a.style.boxShadow).not.toBe('');
    pointer('pointerdown', a, 50, 10, 2);
    expect(a.style.boxShadow).toBe('');
    pointer('pointerup', a, 10, 10);
    expect(sheetButtons()).toEqual([]);

    document.elementFromPoint = () => rowElement('b');
    pointer('pointerdown', a, 10, 10, 3);
    act(() => vi.advanceTimersByTime(LIFT_DELAY_MS));
    for (let x = 12; x <= 20; x += 2) pointer('pointermove', a, x, 10, 3);
    expect(container.querySelector('[data-status-drop-indicator]')).not.toBeNull();
    pointer('pointerup', a, 20, 10, 3);
    expect(rowTitles()).toEqual(['b', 'a']);

    const moved = rowElement('a');
    document.elementFromPoint = () => rowElement('b');
    rowElement('b').getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40 }) as DOMRect;
    pointer('pointerdown', moved, 10, 60, 4);
    act(() => vi.advanceTimersByTime(LIFT_DELAY_MS));
    pointer('pointermove', moved, 10, 5, 4);
    pointer('pointerup', moved, 10, 5, 4);
    expect(rowTitles()).toEqual(['a', 'b']);
  });

  it('opens the row menu on a context-menu request instead of the platform menu', () => {
    render({ chats: [item({ id: 'row' })], sections: [] });
    const event = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
    act(() => {
      rowElement('row').dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    expect(sheetButtons()).toContain('Settle');
  });

  it('marks a woken conversation unread and counts the folded tiers', () => {
    render({
      chats: [
        item({ id: 'woken', snoozedUntil: NOW - 60_000, lastReadAt: NOW - HOUR }),
        item({ id: 'l1', snoozedUntil: NOW + HOUR }),
        item({ id: 'l2', snoozedUntil: NOW + 2 * HOUR, lastReadAt: NOW - 2 * HOUR }),
      ],
      sections: [],
    });
    expect(rowElement('woken').querySelector('[data-unread-dot]')).not.toBeNull();
    const later = container.querySelector<HTMLButtonElement>('button[aria-expanded="false"]')!;
    expect(later.textContent).toContain('Later2');
    expect(later.querySelector('[aria-label="Unread messages"]')).not.toBeNull();
  });

  it('asks before deleting a pin section and keeps section menus to the Status grouping', () => {
    const host = {
      chats: [item({ id: 'a', isPinned: true, pinSectionId: 'first', orderKey: '80' })],
      sections: [{ id: 'first', name: 'First', orderKey: '80' }],
    };
    render(host);
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-status-section-menu="first"]')!.click()
    );
    clickSheet('Delete Section');
    expect(currentHost.sections).toHaveLength(1);
    const confirm = Array.from(document.querySelectorAll<HTMLButtonElement>('button')).filter(
      (button) => button.textContent?.trim() === 'Delete Section'
    );
    act(() => confirm.at(-1)!.click());
    expect(currentHost.sections).toHaveLength(0);

    render(host, { groupBy: 'project' });
    expect(container.querySelector('[data-status-section-menu]')).toBeNull();
  });

  it('shows how many pinned rows the scope hid', () => {
    render(
      { chats: [item({ id: 'mine', isPinned: true })], sections: [] },
      { scopeHiddenCounts: { '': 2 } }
    );
    expect(text()).toContain('2 sessions hidden');
  });

  it('reorders pin sections from the section header menu', () => {
    render({
      chats: [
        item({ id: 'a', isPinned: true, pinSectionId: 'first', orderKey: '80' }),
        item({ id: 'b', isPinned: true, pinSectionId: 'second', orderKey: '80' }),
      ],
      sections: [
        { id: 'first', name: 'First', orderKey: '80' },
        { id: 'second', name: 'Second', orderKey: '81' },
      ],
    });
    expect(rowTitles()).toEqual(['a', 'b']);
    act(() =>
      container.querySelector<HTMLButtonElement>('[data-status-section-menu="first"]')!.click()
    );
    expect(sheetButtons()).toEqual(
      expect.arrayContaining(['New Section…', 'Rename Section', 'Move down', 'Delete Section'])
    );
    expect(sheetButtons()).not.toContain('Move up');
    clickSheet('Move down');
    expect(rowTitles()).toEqual(['b', 'a']);
  });
});

describe('phone Later sheet and Undo', () => {
  it('mounts the list and picks a Later preset under zh_CN without Intl RangeError', () => {
    const zhI18n = createTestI18n({ language: 'zh_CN' });
    act(() => {
      root.render(
        withTestI18n(
          <Provider store={createStore()}>
            <Harness initial={{ chats: [item({ id: 'focus-a', orderKey: '80' })], sections: [] }} />
          </Provider>,
          zhI18n
        )
      );
    });
    longPress('focus-a');
    clickSheet('Later');
    const oneHour = document.querySelector<HTMLButtonElement>('[data-later-preset="oneHour"]');
    expect(oneHour).not.toBeNull();
    act(() => oneHour!.click());
    expect(currentHost.chats[0]?.snoozedUntil).toBe(NOW + LIFT_DELAY_MS + HOUR);
    act(() => heading('Later').click());
    expect(
      container.querySelector('[data-status-area="later"][data-status-row-id="focus-a"]')
    ).not.toBeNull();

    const formatZhProduct = presetTimeFormatter('zh_CN', NOW);
    const formatZhBcp47 = presetTimeFormatter('zh-CN', NOW);
    expect(formatZhProduct(NOW + HOUR)).toBe(formatZhBcp47(NOW + HOUR));
    expect(formatZhProduct(NOW + 2 * DAY)).toBe(formatZhBcp47(NOW + 2 * DAY));
  });

  it('refuses a custom time that is not in the future', () => {
    expect(resolveCustomLaterTime('2026-11-21T09:00', Date.parse('2026-11-21T10:00'))).toBeNull();
    expect(resolveCustomLaterTime('', NOW)).toBeNull();
    const future = resolveCustomLaterTime('2026-11-22T09:00', Date.parse('2026-11-21T10:00'));
    expect(future).toBe(Date.parse('2026-11-22T09:00'));
  });

  it('Undo restores exactly the conversations the action changed', () => {
    const before = new Map([
      ['root', { snoozedUntil: NOW + HOUR, settledAt: undefined, focusRestoredAt: undefined }],
      ['opened', { snoozedUntil: undefined, settledAt: undefined, focusRestoredAt: 5 }],
    ]);
    const after = new Map([
      ['root', { snoozedUntil: undefined, settledAt: NOW, focusRestoredAt: undefined }],
      ['opened', { snoozedUntil: undefined, settledAt: undefined, focusRestoredAt: 5 }],
    ]);
    expect(planStatusUndo(before, after)).toEqual([
      { sessionId: 'root', patch: before.get('root') },
    ]);
  });
});
