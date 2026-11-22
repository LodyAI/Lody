import type {
  StatusViewCommand,
  StatusViewLayoutInput,
  StatusViewSession,
  StatusViewState,
} from '../src/status-view';
import type { PinSection } from '../src/pinned-sections';

/**
 * Inputs of the Status view golden vectors. `status-view.test.ts` computes the
 * expected output and compares the whole file with
 * `src/status-view/vectors/*.json`; `vitest -u` rewrites it, and the diff is
 * the behavior change to review.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
/** 2026-11-21T00:00:00.000Z */
export const NOW = Date.UTC(2026, 10, 21);
/** Consumed in order, then repeated. */
export const RANDOM_BYTES = [0x11, 0x22, 0x33];

/** Ascending, all valid fractional indexes. */
const K1 = '7F80';
const K2 = '80';
const K3 = '8180';
const K4 = '82';

const session = (id: string, overrides: Partial<StatusViewSession> = {}): StatusViewSession => ({
  id,
  title: id,
  lastMessageAt: NOW - HOUR,
  lastReadAt: NOW - HOUR,
  isPinned: false,
  pinSectionId: null,
  orderKey: null,
  snoozedUntil: null,
  settledAt: null,
  focusRestoredAt: null,
  openedById: null,
  isWorking: false,
  isWaitingPermission: false,
  canManage: true,
  canPrefer: true,
  ...overrides,
});

const section = (id: string, orderKey: string, name = id): PinSection => ({ id, name, orderKey });

const layoutInput = (
  sessions: StatusViewSession[],
  overrides: Partial<StatusViewLayoutInput> = {}
): StatusViewLayoutInput => ({
  sessions,
  sections: [],
  sectionsLoaded: true,
  canManageSections: true,
  nowMs: NOW,
  ...overrides,
});

export type LayoutCase = { name: string; description: string; input: StatusViewLayoutInput };

export const LAYOUT_CASES: LayoutCase[] = [
  {
    name: 'focus-order-expired-snooze-floats-to-top',
    description:
      'Expired snoozes lead Focus, latest wake-up first, and read as unread; keyed rows follow by key, then rows without orderKey by id.',
    input: layoutInput([
      session('keyed-late', { orderKey: K3 }),
      session('keyed-early', { orderKey: K1 }),
      session('unkeyed-b'),
      session('unkeyed-a', { lastMessageAt: NOW - MINUTE }),
      session('woke-earlier', {
        orderKey: K2,
        lastMessageAt: NOW - 10 * DAY,
        lastReadAt: NOW - 10 * DAY,
        snoozedUntil: NOW - 2 * HOUR,
      }),
      session('woke-later', {
        lastMessageAt: NOW - 3 * DAY,
        lastReadAt: NOW - 3 * DAY,
        snoozedUntil: NOW - HOUR,
      }),
    ]),
  },
  {
    name: 'seven-day-auto-settle-and-restore',
    description:
      'Seven quiet days settle a row unless it is working or was restored to Focus since; an explicit settle holds until a newer message. nextChangeAt is the earliest coming auto-settle.',
    input: layoutInput([
      session('quiet-7d', { lastMessageAt: NOW - 7 * DAY, lastReadAt: NOW - 7 * DAY }),
      session('quiet-almost', {
        lastMessageAt: NOW - 7 * DAY + 10 * MINUTE,
        lastReadAt: NOW - 7 * DAY + 10 * MINUTE,
      }),
      session('quiet-working', { lastMessageAt: NOW - 30 * DAY, isWorking: true }),
      session('quiet-restored', {
        lastMessageAt: NOW - 30 * DAY,
        focusRestoredAt: NOW - DAY,
      }),
      session('settled-explicit', { lastMessageAt: NOW - 2 * HOUR, settledAt: NOW - HOUR }),
      session('settled-then-replied', { lastMessageAt: NOW - MINUTE, settledAt: NOW - HOUR }),
      session('settled-tie-b', { title: 'Same', lastMessageAt: NOW - 3 * HOUR, settledAt: NOW }),
      session('settled-tie-a', { title: 'Same', lastMessageAt: NOW - 3 * HOUR, settledAt: NOW }),
    ]),
  },
  {
    name: 'waiting-permission-overrides-later-and-settled',
    description:
      'A conversation waiting for a permission approval stays in Focus whatever its snooze or settle state; the snooze still schedules a change.',
    input: layoutInput([
      session('waiting-snoozed', { isWaitingPermission: true, snoozedUntil: NOW + 2 * HOUR }),
      session('waiting-settled', { isWaitingPermission: true, settledAt: NOW }),
      session('waiting-old', { isWaitingPermission: true, lastMessageAt: NOW - 40 * DAY }),
      session('snoozed', { snoozedUntil: NOW + 3 * HOUR }),
    ]),
  },
  {
    name: 'later-order-and-countdown-field',
    description:
      'Later sorts by wake-up ascending and only Later rows carry snoozedUntil; nextChangeAt is the soonest wake-up.',
    input: layoutInput([
      session('later-tomorrow', { snoozedUntil: NOW + DAY }),
      session('later-soon', { snoozedUntil: NOW + 30 * MINUTE }),
      session('later-soon-b', { snoozedUntil: NOW + 30 * MINUTE }),
      session('focus-row', { orderKey: K2 }),
    ]),
  },
  {
    name: 'opener-and-children-across-tiers',
    description:
      'An opened conversation nests under its opener only in the same tier; a grandchild attaches to the topmost visible opener; a child in another tier stands alone there.',
    input: layoutInput([
      session('opener', { orderKey: K2 }),
      session('child-focus', { openedById: 'opener', orderKey: K1 }),
      session('grandchild', { openedById: 'child-focus' }),
      session('child-later', { openedById: 'opener', snoozedUntil: NOW + HOUR }),
      session('child-settled', { openedById: 'opener', settledAt: NOW }),
      session('orphan', { openedById: 'not-visible', orderKey: K3 }),
      session('settled-opener', { settledAt: NOW, lastMessageAt: NOW - 5 * HOUR }),
      session('settled-child', {
        openedById: 'settled-opener',
        settledAt: NOW,
        lastMessageAt: NOW - 2 * HOUR,
      }),
      session('settled-fresh', { settledAt: NOW, lastMessageAt: NOW - 3 * HOUR }),
    ]),
  },
  {
    name: 'pinned-sections-deleted-section-and-hidden-counts',
    description:
      'Default section first, then sections by key; keyed rows by key, unkeyed by activity; a row naming a deleted section shows in the default one; an opened row follows its pinned opener; scope-hidden counts fold unknown sections into the default.',
    input: layoutInput(
      [
        session('pin-keyed', { isPinned: true, orderKey: K2 }),
        session('pin-unkeyed-old', { isPinned: true, lastMessageAt: NOW - 2 * DAY }),
        session('pin-unkeyed-new', { isPinned: true, lastMessageAt: NOW - MINUTE }),
        session('pin-in-work', { isPinned: true, pinSectionId: 'work', orderKey: K1 }),
        session('pin-in-deleted', { isPinned: true, pinSectionId: 'deleted', orderKey: K1 }),
        session('opened-by-pin', { openedById: 'pin-in-work', snoozedUntil: NOW + HOUR }),
        session('pin-snoozed', {
          isPinned: true,
          pinSectionId: 'home',
          snoozedUntil: NOW + 4 * HOUR,
        }),
        session('unpinned-focus', { orderKey: K4 }),
      ],
      {
        sections: [section('home', K3, 'Home'), section('work', K2, 'Work')],
        scopeHiddenCounts: { '': 1, work: 2, deleted: 1 },
      }
    ),
  },
  {
    name: 'pinned-sections-not-loaded',
    description:
      'Before the section rows are read, a row naming a section is held back rather than shown in the default section, and no hidden counts are reported.',
    input: layoutInput(
      [
        session('pin-default', { isPinned: true, orderKey: K2 }),
        session('pin-in-work', { isPinned: true, pinSectionId: 'work', orderKey: K1 }),
        session('opened-by-held', { openedById: 'pin-in-work' }),
      ],
      { sectionsLoaded: false, scopeHiddenCounts: { '': 3 } }
    ),
  },
  {
    name: 'read-only-rows-and-sections',
    description:
      'Permissions pass through per row; a read-only member manages no sections; an empty Focus is still present.',
    input: layoutInput(
      [
        session('read-only-later', {
          canManage: false,
          canPrefer: false,
          snoozedUntil: NOW + HOUR,
        }),
        session('history-only-pinned', { canManage: false, isPinned: true }),
      ],
      { canManageSections: false }
    ),
  },
  {
    name: 'pinned-root-carries-opened-rows-at-any-depth',
    description:
      'A row opened by a row the pinned root opened follows the root into its section and nests under it, like the direct child.',
    input: layoutInput(
      [
        session('root', { isPinned: true, pinSectionId: 'work', orderKey: K1 }),
        session('child', { openedById: 'root' }),
        session('grandchild', { openedById: 'child' }),
        session('other-pin', { isPinned: true, orderKey: K2 }),
      ],
      { sections: [section('work', K2, 'Work')] }
    ),
  },
  {
    name: 'all-zero-order-key-reads-as-no-key',
    description:
      'An all-zero order key has no key before it, so Focus orders that row as unkeyed rather than failing later.',
    input: layoutInput([session('zero', { orderKey: '00' }), session('keyed', { orderKey: K2 })]),
  },
  {
    name: 'placed-woken-row-keeps-unread-at-its-place',
    description:
      'A woken row placed by a Focus reorder (focusRestoredAt at its wake-up, expired snoozedUntil kept) orders by its key and stays unread; an unplaced woken row still floats.',
    input: layoutInput([
      session('f1', { orderKey: K1 }),
      session('placed-woken', {
        orderKey: K2,
        lastMessageAt: NOW - 3 * DAY,
        lastReadAt: NOW - 3 * DAY,
        snoozedUntil: NOW - 2 * HOUR,
        focusRestoredAt: NOW - 2 * HOUR,
      }),
      session('f3', { orderKey: K3 }),
      session('fresh-woken', {
        lastMessageAt: NOW - 3 * DAY,
        lastReadAt: NOW - 3 * DAY,
        snoozedUntil: NOW - HOUR,
      }),
    ]),
  },
  {
    name: 'placed-woken-row-read-clears-unread',
    description:
      'Opening the placed row moves the read receipt past its wake-up and clears unread.',
    input: layoutInput([
      session('placed-woken', {
        orderKey: K2,
        lastMessageAt: NOW - 3 * DAY,
        lastReadAt: NOW - MINUTE,
        snoozedUntil: NOW - 2 * HOUR,
        focusRestoredAt: NOW - 2 * HOUR,
      }),
    ]),
  },
  {
    name: 'placed-row-re-snoozed-floats-again',
    description:
      'A placed row snoozed again wakes past its earlier placement, so it floats to the top again.',
    input: layoutInput([
      session('f1', { orderKey: K1 }),
      session('re-woken', {
        orderKey: K3,
        lastMessageAt: NOW - 3 * DAY,
        lastReadAt: NOW - 2 * DAY,
        snoozedUntil: NOW - 10 * MINUTE,
        focusRestoredAt: NOW - 2 * DAY,
      }),
    ]),
  },
];

const state = (
  sessions: StatusViewSession[],
  overrides: Partial<StatusViewState> = {}
): StatusViewState => ({ ...layoutInput(sessions), ...overrides });

export type CommandCase = {
  name: string;
  description: string;
  state: StatusViewState;
  command: StatusViewCommand;
};

const tree = [
  session('root', { orderKey: K2 }),
  session('child', { openedById: 'root', snoozedUntil: NOW + HOUR }),
  session('grandchild', { openedById: 'child', lastMessageAt: NOW + 5 * MINUTE }),
  session('unrelated', { orderKey: K3 }),
];
const treeState = state(tree, {
  related: [session('hidden-child', { openedById: 'root', lastMessageAt: NOW - 3 * DAY })],
});

const focusList = [
  session('woke-a', { orderKey: K4, snoozedUntil: NOW - HOUR, focusRestoredAt: NOW - 2 * DAY }),
  session('woke-b', { snoozedUntil: NOW - 2 * HOUR }),
  session('f1', { orderKey: K1 }),
  session('f2', { orderKey: K2 }),
  session('f3'),
  session('f4'),
  session('later-row', { snoozedUntil: NOW + DAY }),
  session('later-child', { openedById: 'later-row', settledAt: NOW - HOUR }),
  session('pinned-row', { isPinned: true, orderKey: K1 }),
];

const pinList = [
  session('p-default-1', { isPinned: true, orderKey: K2 }),
  session('p-default-2', { isPinned: true, orderKey: K3 }),
  session('p-unkeyed-new', { isPinned: true, pinSectionId: 'work', lastMessageAt: NOW - MINUTE }),
  session('p-unkeyed-old', { isPinned: true, pinSectionId: 'work', lastMessageAt: NOW - DAY }),
  session('p-work-keyed', { isPinned: true, pinSectionId: 'work', orderKey: K2 }),
  session('carried', { openedById: 'p-default-1' }),
  session('focus-row', { orderKey: K1 }),
];
const pinState = (overrides: Partial<StatusViewState> = {}) =>
  state(pinList, {
    sections: [section('work', K2, 'Work'), section('home', K3, 'Home')],
    ...overrides,
  });

export const COMMAND_CASES: CommandCase[] = [
  {
    name: 'snooze-only-this',
    description: 'Later writes the wake-up time and clears an explicit settle.',
    state: treeState,
    command: { type: 'snooze', sessionId: 'root', until: NOW + DAY, includeOpened: false },
  },
  {
    name: 'snooze-opened-tree',
    description:
      'Including opened sub-conversations reaches every descendant, also ones the list does not show.',
    state: treeState,
    command: { type: 'snooze', sessionId: 'root', until: NOW + DAY, includeOpened: true },
  },
  {
    name: 'snooze-in-the-past-is-refused',
    description: 'A wake-up time at or before now plans nothing.',
    state: treeState,
    command: { type: 'snooze', sessionId: 'root', until: NOW, includeOpened: false },
  },
  {
    name: 'snooze-read-only-is-refused',
    description: 'A target without management permission refuses the whole command.',
    state: state([session('ro', { canManage: false }), session('ok', { openedById: 'ro' })]),
    command: { type: 'snooze', sessionId: 'ro', until: NOW + HOUR, includeOpened: true },
  },
  {
    name: 'settle-tree-tolerates-clock-skew',
    description: 'settledAt is max(now, lastMessageAt) per target, and clears snoozedUntil.',
    state: treeState,
    command: { type: 'settle', sessionId: 'root', includeOpened: true },
  },
  {
    name: 'move-to-focus-only-this',
    description: 'Move to Focus clears snooze and settle and records focusRestoredAt.',
    state: treeState,
    command: { type: 'moveToFocus', sessionId: 'child', includeOpened: false },
  },
  {
    name: 'pin-goes-to-top-of-default-section',
    description:
      'A newly pinned row gets a key above the default section; other sections do not count.',
    state: pinState(),
    command: { type: 'setPinned', sessionId: 'focus-row', pinned: true },
  },
  {
    name: 'unpin-keeps-order-key',
    description: 'Unpinning clears the section and keeps orderKey for Focus.',
    state: pinState(),
    command: { type: 'setPinned', sessionId: 'p-work-keyed', pinned: false },
  },
  {
    name: 'move-in-focus-materializes-expired-snoozes',
    description:
      'Reordering Focus first keys the woken rows at the top, clearing their snooze and keeping focusRestoredAt, then keys unkeyed rows above the drop and the moved row.',
    state: state(focusList),
    command: { type: 'move', sessionId: 'f1', to: { area: 'focus' }, beforeId: 'f4' },
  },
  {
    name: 'move-in-focus-to-end',
    description: 'beforeId null lands after the last row.',
    state: state(focusList),
    command: { type: 'move', sessionId: 'f2', to: { area: 'focus' }, beforeId: null },
  },
  {
    name: 'move-in-focus-stale-before-id',
    description: 'A beforeId that is not a Focus row resolves to the end.',
    state: state(focusList),
    command: { type: 'move', sessionId: 'f2', to: { area: 'focus' }, beforeId: 'gone' },
  },
  {
    name: 'move-later-row-into-focus-restores-opened',
    description:
      'Dropping a Later row into Focus restores it and its opened sub-conversations; only the dropped row gets a key.',
    state: state(focusList),
    command: { type: 'move', sessionId: 'later-row', to: { area: 'focus' }, beforeId: 'f1' },
  },
  {
    name: 'move-pinned-row-into-focus-unpins',
    description: 'A pinned row dropped into Focus leaves the Pinned area at the drop slot.',
    state: state(focusList),
    command: { type: 'move', sessionId: 'pinned-row', to: { area: 'focus' }, beforeId: 'f2' },
  },
  {
    name: 'move-woken-row-keeps-its-wake-up',
    description:
      'Dragging a woken row places it by key and records focusRestoredAt at its wake-up; its expired snoozedUntil stays, so it remains unread.',
    state: state(focusList),
    command: { type: 'move', sessionId: 'woke-b', to: { area: 'focus' }, beforeId: 'f3' },
  },
  {
    name: 'later-reorder-keeps-a-placed-woken-row',
    description:
      'A woken row placed by an earlier reorder no longer floats, so a later reorder leaves it where it is and writes nothing to it.',
    state: state([
      session('placed-woken', {
        orderKey: K1,
        snoozedUntil: NOW - 2 * HOUR,
        focusRestoredAt: NOW - 2 * HOUR,
      }),
      session('f2', { orderKey: K2 }),
      session('f3', { orderKey: K3 }),
    ]),
    command: { type: 'move', sessionId: 'f3', to: { area: 'focus' }, beforeId: 'f2' },
  },
  {
    name: 'pinned-woken-row-dropped-into-focus-keeps-its-wake-up',
    description:
      'A pinned row with an expired snooze dropped into Focus is unpinned and placed without clearing the snooze, so it stays unread.',
    state: state([
      session('f1', { orderKey: K1 }),
      session('f2', { orderKey: K2 }),
      session('pinned-woken', {
        isPinned: true,
        orderKey: K3,
        lastReadAt: NOW - 2 * DAY,
        snoozedUntil: NOW - HOUR,
      }),
    ]),
    command: { type: 'move', sessionId: 'pinned-woken', to: { area: 'focus' }, beforeId: 'f2' },
  },
  {
    name: 'drop-restores-opened-child-keeping-its-wake-up',
    description:
      'A Later row dropped into Focus restores its opened sub-conversations; a woken child keeps its expired snooze, so it stays unread, while a future snooze is cleared.',
    state: state([
      session('f1', { orderKey: K1 }),
      session('later-parent', { snoozedUntil: NOW + DAY }),
      session('woken-child', {
        openedById: 'later-parent',
        lastReadAt: NOW - 2 * DAY,
        snoozedUntil: NOW - HOUR,
      }),
    ]),
    command: { type: 'move', sessionId: 'later-parent', to: { area: 'focus' }, beforeId: 'f1' },
  },
  {
    name: 'move-to-focus-tree-keeps-woken-child-wake-up',
    description:
      'Move to Focus with its opened sub-conversations clears a future snooze and settle state but keeps an expired snooze on a woken child.',
    state: state([
      session('settled-parent', { settledAt: NOW - HOUR, lastMessageAt: NOW - 2 * HOUR }),
      session('woken-child', {
        openedById: 'settled-parent',
        lastReadAt: NOW - 2 * DAY,
        snoozedUntil: NOW - HOUR,
      }),
      session('later-child', { openedById: 'settled-parent', snoozedUntil: NOW + HOUR }),
    ]),
    command: { type: 'moveToFocus', sessionId: 'settled-parent', includeOpened: true },
  },
  {
    name: 'new-session-order-ignores-an-all-zero-key',
    description:
      'An all-zero key cannot have a key above it; the new top key is planned from the real keys.',
    state: state([session('zero', { orderKey: '0000' }), session('keyed', { orderKey: K2 })]),
    command: { type: 'newSessionOrder', sessionId: 'brand-new' },
  },
  {
    name: 'move-to-focus-top-over-an-all-zero-key',
    description:
      'Moving above a row with an all-zero key gives that row a real key instead of failing.',
    state: state([session('zero', { orderKey: '00' }), session('f1', { orderKey: K2 })]),
    command: { type: 'move', sessionId: 'f1', to: { area: 'focus' }, beforeId: 'zero' },
  },
  {
    name: 'pin-lands-above-a-pin-whose-section-was-deleted',
    description:
      'A pin naming a deleted section shows in the default section, so a new pin is keyed above it too.',
    state: state(
      [
        session('orphan', { isPinned: true, pinSectionId: 'deleted', orderKey: K1 }),
        session('default-pin', { isPinned: true, orderKey: K2 }),
        session('focus-row', { orderKey: K3 }),
      ],
      { sections: [section('work', K3, 'Work')] }
    ),
    command: { type: 'setPinned', sessionId: 'focus-row', pinned: true },
  },
  {
    name: 'pin-move-before-sections-load-ignores-held-back-rows',
    description:
      'Before the section rows are read, a pin naming a section is held back from the default section, so it is not a neighbor there.',
    state: state(
      [
        session('held', { isPinned: true, pinSectionId: 'work', orderKey: K1 }),
        session('default-pin', { isPinned: true, orderKey: K2 }),
        session('focus-row', { orderKey: K3 }),
      ],
      { sectionsLoaded: false }
    ),
    command: {
      type: 'move',
      sessionId: 'focus-row',
      to: { area: 'pinned', sectionId: null },
      beforeId: 'default-pin',
    },
  },
  {
    name: 'settle-covers-activity-newer-than-the-clock',
    description:
      'settledAt is never before the row activity (contained Tabs included), so a Tab clock running ahead cannot keep the row out of Settled.',
    state: state([session('ahead', { lastMessageAt: NOW - HOUR, activityAt: NOW + 2 * MINUTE })]),
    command: { type: 'settle', sessionId: 'ahead', includeOpened: false },
  },
  {
    name: 'move-in-focus-over-read-only-unkeyed-row-is-refused',
    description:
      'A drop below a row without a key that the member cannot manage would have to write that row, so the move plans nothing.',
    state: state([
      session('k1', { orderKey: K1 }),
      session('ro-unkeyed', { canManage: false }),
      session('mine'),
    ]),
    command: { type: 'move', sessionId: 'k1', to: { area: 'focus' }, beforeId: null },
  },
  {
    name: 'move-in-focus-leaves-read-only-woken-row-unkeyed',
    description:
      'A woken row the member cannot manage keeps floating at the top without a key; the move still lands.',
    state: state([
      session('ro-woken', { canManage: false, snoozedUntil: NOW - HOUR }),
      session('f1', { orderKey: K1 }),
      session('f2', { orderKey: K2 }),
    ]),
    command: { type: 'move', sessionId: 'f2', to: { area: 'focus' }, beforeId: 'f1' },
  },
  {
    name: 'move-into-section-keys-unkeyed-rows-above',
    description:
      'Dropping below rows without keys gives those above the drop keys first, in their current order.',
    state: pinState(),
    command: {
      type: 'move',
      sessionId: 'p-default-1',
      to: { area: 'pinned', sectionId: 'work' },
      beforeId: null,
    },
  },
  {
    name: 'move-unpinned-row-into-section-pins-it',
    description: 'A Focus row dropped into a pin section is pinned at that slot.',
    state: pinState(),
    command: {
      type: 'move',
      sessionId: 'focus-row',
      to: { area: 'pinned', sectionId: null },
      beforeId: 'p-default-2',
    },
  },
  {
    name: 'move-to-section-top',
    description: '"Move to section" lands at the top of that section.',
    state: pinState(),
    command: {
      type: 'move',
      sessionId: 'p-default-2',
      to: { area: 'pinned', sectionId: 'home' },
      beforeId: null,
    },
  },
  {
    name: 'create-section-after-the-last',
    description: 'A new section goes after every existing one; the name is trimmed.',
    state: pinState(),
    command: { type: 'createSection', sectionId: 'new', name: '  Reading  ' },
  },
  {
    name: 'create-section-blank-name-is-refused',
    description: 'A section the catalog would drop is never written.',
    state: pinState(),
    command: { type: 'createSection', sectionId: 'new', name: '   ' },
  },
  {
    name: 'rename-section',
    description: 'Rename rewrites the whole row with the same key.',
    state: pinState(),
    command: { type: 'renameSection', sectionId: 'work', name: 'Office' },
  },
  {
    name: 'move-section-down',
    description: 'Move down places the section after its next neighbor.',
    state: pinState(),
    command: { type: 'moveSection', sectionId: 'work', beforeId: null },
  },
  {
    name: 'delete-section',
    description: 'Deleting a section deletes its row; its conversations fall back on read.',
    state: pinState(),
    command: { type: 'deleteSection', sectionId: 'home' },
  },
  {
    name: 'section-management-read-only-is-refused',
    description: 'A read-only member cannot change sections.',
    state: pinState({ canManageSections: false }),
    command: { type: 'deleteSection', sectionId: 'home' },
  },
  {
    name: 'touch-on-send-clears-status',
    description: 'Sending clears snoozedUntil and settledAt that are set, and nothing else.',
    state: state([session('snoozed', { snoozedUntil: NOW + HOUR })]),
    command: { type: 'touchOnSend', sessionId: 'snoozed' },
  },
  {
    name: 'touch-on-send-without-status',
    description: 'Sending in a Focus row plans nothing.',
    state: state([session('plain')]),
    command: { type: 'touchOnSend', sessionId: 'plain' },
  },
  {
    name: 'new-session-goes-to-top-of-focus',
    description:
      'A new top-level conversation gets a key below every existing key, pinned rows included.',
    state: pinState(),
    command: { type: 'newSessionOrder', sessionId: 'brand-new' },
  },
  {
    name: 'new-opened-session-gets-no-key',
    description: 'A conversation opened by another one renders nested and gets no key.',
    state: state([
      session('opener', { orderKey: K2 }),
      session('opened', { openedById: 'opener' }),
    ]),
    command: { type: 'newSessionOrder', sessionId: 'opened' },
  },
];
