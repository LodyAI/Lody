import { describe, expect, it } from 'vitest';

import {
  buildPinnedSectionLayout,
  planNewPinPlacement,
  planNewPinSectionOrderKey,
  planPinSectionMove,
  planPinnedSessionMove,
  type PinSection,
  type PinnedSessionPlacement,
} from '../src/pinned-sections';

const section = (id: string, orderKey: string, name = id): PinSection => ({ id, name, orderKey });

const pinned = (
  id: string,
  recency: number,
  pinSectionId?: string,
  orderKey?: string
): PinnedSessionPlacement => ({ id, recency, pinSectionId, orderKey });

// Deterministic jitter so planned keys are reproducible.
const jitter = { jitter: 1, randomByte: () => 0x11 };

const idsBySection = (
  layout: ReturnType<typeof buildPinnedSectionLayout<PinnedSessionPlacement>>
) => layout.map((entry) => [entry.sectionId, entry.items.map((item) => item.id)]);

describe('pinned section layout', () => {
  it('puts the default section first, then user sections by order key', () => {
    const layout = buildPinnedSectionLayout(
      [pinned('a', 1), pinned('b', 1, 'later'), pinned('c', 1, 'earlier')],
      [section('later', '81'), section('earlier', '7F80')],
      (item) => item
    );
    expect(idsBySection(layout)).toEqual([
      [null, ['a']],
      ['earlier', ['c']],
      ['later', ['b']],
    ]);
  });

  it('keeps empty user sections so they remain visible drop targets', () => {
    const layout = buildPinnedSectionLayout([], [section('maintenance', '80')], (item) => item);
    expect(idsBySection(layout)).toEqual([
      [null, []],
      ['maintenance', []],
    ]);
  });

  it('shows a conversation whose section was deleted in the default section', () => {
    const layout = buildPinnedSectionLayout(
      [pinned('orphan', 1, 'deleted-section', '80')],
      [],
      (item) => item
    );
    expect(idsBySection(layout)).toEqual([[null, ['orphan']]]);
  });

  it('orders keyed conversations by key and older unkeyed ones after them by recency', () => {
    const layout = buildPinnedSectionLayout(
      [
        pinned('legacy-old', 10),
        pinned('second', 1, undefined, '81'),
        pinned('legacy-new', 20),
        pinned('first', 1, undefined, '80'),
        pinned('bad-key', 30, undefined, 'not-hex'),
      ],
      [],
      (item) => item
    );
    expect(idsBySection(layout)).toEqual([
      [null, ['first', 'second', 'bad-key', 'legacy-new', 'legacy-old']],
    ]);
  });

  it('holds back sectioned conversations until the sections themselves are known', () => {
    const items = [pinned('loose', 1), pinned('weekly', 2, 'maintenance', '80')];
    // Section rows not read yet: the sectioned conversation must not flash in the default section.
    expect(
      idsBySection(buildPinnedSectionLayout(items, [], (item) => item, { sectionsLoaded: false }))
    ).toEqual([[null, ['loose']]]);
    // Read, and the section exists: it lands there.
    expect(
      idsBySection(
        buildPinnedSectionLayout(items, [section('maintenance', '80')], (item) => item, {
          sectionsLoaded: true,
        })
      )
    ).toEqual([
      [null, ['loose']],
      ['maintenance', ['weekly']],
    ]);
  });

  it('breaks equal keys from concurrent writers by id so every client agrees', () => {
    const layout = buildPinnedSectionLayout(
      [pinned('b', 1, undefined, '80'), pinned('a', 2, undefined, '80')],
      [],
      (item) => item
    );
    expect(idsBySection(layout)).toEqual([[null, ['a', 'b']]]);
  });
});

describe('pinned conversation moves', () => {
  const sections = [section('maintenance', '80')];

  it('moves a conversation between two keyed neighbours with a single write', () => {
    const items = [
      pinned('x', 1, undefined, '80'),
      pinned('m1', 1, 'maintenance', '80'),
      pinned('m2', 1, 'maintenance', '82'),
    ];
    const layout = buildPinnedSectionLayout(items, sections, (item) => item);
    const writes = planPinnedSessionMove(
      layout,
      { sessionId: 'x', toSectionId: 'maintenance', toIndex: 1 },
      jitter
    );
    expect(writes).toHaveLength(1);
    const [write] = writes;
    expect(write?.sessionId).toBe('x');
    expect(write?.pinSectionId).toBe('maintenance');

    const moved = items.map((item) =>
      item.id === 'x' ? { ...item, pinSectionId: 'maintenance', orderKey: write?.orderKey } : item
    );
    expect(idsBySection(buildPinnedSectionLayout(moved, sections, (item) => item))).toEqual([
      [null, []],
      ['maintenance', ['m1', 'x', 'm2']],
    ]);
  });

  it('moves back to the default section by clearing the section id', () => {
    const items = [pinned('m1', 1, 'maintenance', '80')];
    const layout = buildPinnedSectionLayout(items, sections, (item) => item);
    const writes = planPinnedSessionMove(
      layout,
      { sessionId: 'm1', toSectionId: null, toIndex: 0 },
      jitter
    );
    expect(writes).toEqual([
      { sessionId: 'm1', pinSectionId: undefined, orderKey: expect.any(String) },
    ]);
  });

  it('keys older unkeyed neighbours only when the drop lands among them', () => {
    const items = [
      pinned('keyed', 1, undefined, '80'),
      pinned('legacy-new', 20),
      pinned('legacy-old', 10),
      pinned('mover', 1, 'maintenance', '80'),
    ];
    const layout = buildPinnedSectionLayout(items, sections, (item) => item);
    const writes = planPinnedSessionMove(
      layout,
      { sessionId: 'mover', toSectionId: null, toIndex: 2 },
      jitter
    );
    // legacy-new is above the drop, so it needs a key; legacy-old stays unkeyed below it.
    expect(writes.map((write) => write.sessionId)).toEqual(['legacy-new', 'mover']);

    const byId = new Map(writes.map((write) => [write.sessionId, write]));
    const moved = items.map((item) => {
      const write = byId.get(item.id);
      return write ? { ...item, pinSectionId: write.pinSectionId, orderKey: write.orderKey } : item;
    });
    expect(idsBySection(buildPinnedSectionLayout(moved, sections, (item) => item))).toEqual([
      [null, ['keyed', 'legacy-new', 'mover', 'legacy-old']],
      ['maintenance', []],
    ]);
  });

  it('places a newly pinned conversation at the top of the default section', () => {
    const items = [pinned('top', 1, undefined, '80'), pinned('legacy', 5)];
    const layout = buildPinnedSectionLayout(items, sections, (item) => item);
    const placement = planNewPinPlacement(layout, jitter);
    const next = [...items, pinned('new', 0, undefined, placement.orderKey)];
    expect(idsBySection(buildPinnedSectionLayout(next, sections, (item) => item))[0]).toEqual([
      null,
      ['new', 'top', 'legacy'],
    ]);
  });
});

describe('pin section order', () => {
  const ordered = [section('a', '80'), section('b', '81'), section('c', '82')];

  it('moves a section with a key between its new neighbours', () => {
    const key = planPinSectionMove(ordered, 'c', 0, jitter);
    const next = ordered.map((entry) => (entry.id === 'c' ? { ...entry, orderKey: key } : entry));
    expect(
      buildPinnedSectionLayout([], next, (item: PinnedSessionPlacement) => item)
        .slice(1)
        .map((entry) => entry.sectionId)
    ).toEqual(['c', 'a', 'b']);
  });

  it('appends a new section after the existing ones', () => {
    const key = planNewPinSectionOrderKey(ordered, jitter);
    const next = [...ordered, section('d', key)];
    expect(
      buildPinnedSectionLayout([], next, (item: PinnedSessionPlacement) => item)
        .slice(1)
        .map((entry) => entry.sectionId)
    ).toEqual(['a', 'b', 'c', 'd']);
  });
});
