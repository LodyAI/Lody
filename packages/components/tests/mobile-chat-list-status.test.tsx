// @vitest-environment jsdom
import { act, useState, type ReactNode } from 'react';
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
import { resolveCustomLaterTime } from '../src/components/mobile/mobile-later-sheet';
import { planStatusUndo } from '../src/components/mobile/use-mobile-status-actions';
import { initI18n } from '../src/i18n';

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

function Harness({ initial, writable = true }: { initial: Host; writable?: boolean }) {
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
      groupBy="status"
      capGroupPreviews
      pinSections={host.sections}
      statusCommands={commands}
      statusWritable={writable}
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
  return {
    ...state,
    sessions: host.chats.map((chat) => ({
      id: chat.id,
      title: chat.title,
      lastMessageAt: chat.lastMessageAt ?? null,
      activityAt: chat.latestMessageAt ?? null,
      lastReadAt: chat.lastReadAt ?? null,
      isPinned: chat.isPinned === true,
      pinSectionId: chat.pinSectionId ?? null,
      orderKey: chat.orderKey ?? null,
      snoozedUntil: chat.snoozedUntil ?? null,
      settledAt: chat.settledAt ?? null,
      focusRestoredAt: chat.focusRestoredAt ?? null,
      openedById: null,
      isWorking: false,
      isWaitingPermission: false,
      canManage: chat.readOnly !== true,
      canPrefer: true,
    })),
  };
}

function render(initial: Host, writable = true) {
  act(() => {
    root.render(
      <Provider store={createStore()}>
        <Harness initial={initial} writable={writable} />
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
    (button) => button.textContent?.trim() === label
  )!;
const rowElement = (id: string) =>
  container.querySelector<HTMLElement>(`[data-status-row-id="${id}"]`)!;

function pointer(type: string, target: Element, x: number, y: number) {
  const event = new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, button: 0 });
  Object.defineProperty(event, 'pointerId', { value: 1 });
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

  it('folds Settled past 20 rows behind Show all', () => {
    const settled = Array.from({ length: 23 }, (_, index) =>
      item({ id: `s${index}`, settledAt: NOW - index })
    );
    render({ chats: settled, sections: [] });
    act(() => heading('Settled').click());
    expect(rowTitles()).toHaveLength(20);
    expect(text()).toContain('Show all (23)');
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
