import { describe, expect, it } from 'vitest';
import { ScrollSim, turnRows, type SimRow } from './support/scroll-engine-sim';

/**
 * Model tests of the conversation scroll engine's transaction logic
 * (`src/lib/conversation-scroll/controller.ts`), driven by a simulator with
 * the browser semantics the scroll-engine note requires. Every scenario checks
 * the invariants that matter to a reader: the viewport is covered by rows, a
 * following reader stays at the bottom, a reading position does not move under
 * the reader, and new output does not displace the reading position.
 */

const V = 600;

function expectHealthy(sim: ScrollSim) {
  expect(sim.covered()).toBe(true);
  if (sim.controller.mode === 'follow') {
    expect(Math.abs(sim.readScrollTop() - sim.maxTop())).toBeLessThanOrEqual(1);
  }
}

const expand = (rows: SimRow[], key: string, parts: number, height: number): SimRow[] =>
  rows.flatMap((row) =>
    row.key === key
      ? Array.from({ length: parts }, (_, part) => ({
          ...row,
          key: `${key}.${part}`,
          itemIndex: part,
          placeholder: false,
          height,
          estimate: 60,
        }))
      : [row]
  );

describe('native touch layout growth', () => {
  function readingFling() {
    const sim = new ScrollSim(
      turnRows(
        80,
        () => 100,
        () => 100
      ),
      V
    );
    sim.setContentShift = (shift: number) => {
      sim.contentTop = 24 - shift;
    };
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.jumpToIndex(40));
    sim.settle();
    sim.controller.setTouchActive(true);
    sim.controller.release('touch-up');
    sim.nativeScroll(sim.top - 120);
    sim.frame();
    sim.controller.setTouchActive(false, true);
    sim.writes = [];
    return sim;
  }

  it('keeps native offsets and reading lines during repeated growth, then absorbs the shift at scrollend', () => {
    const sim = readingFling();
    for (let step = 0; step < 4; step++) {
      const top = sim.readScrollTop();
      const line = sim.screenTop('t40');
      sim.render(sim.rows.map((row, i) => (i === 35 ? { ...row, height: row.height + 80 } : row)));
      sim.settle();
      expect(sim.readScrollTop()).toBe(top);
      expect(sim.screenTop('t40')).toBe(line);
      expect(sim.writes).toEqual([]);
      expectHealthy(sim);
      sim.nativeScroll(top - 40);
      sim.frame();
    }
    const line = sim.screenTop('t40');
    const top = sim.readScrollTop();
    sim.task(() => sim.controller.onScrollEnd());
    sim.settle();
    expect(sim.contentTop).toBe(24);
    expect(sim.readScrollTop()).toBe(top + 320);
    expect(sim.screenTop('t40')).toBe(line);
    expectHealthy(sim);
  });
  it('keeps an existing shift when another touch catches the fling before moving', () => {
    const sim = readingFling();
    sim.render(sim.rows.map((row, i) => (i === 35 ? { ...row, height: 300 } : row)));
    sim.settle();
    const top = sim.readScrollTop();
    const line = sim.screenTop('t40');
    sim.controller.setTouchActive(true);
    sim.render(sim.rows.map((row, i) => (i === 35 ? { ...row, height: 400 } : row)));
    sim.settle();
    expect(sim.readScrollTop()).toBe(top);
    expect(sim.screenTop('t40')).toBe(line);
    expect(sim.writes).toEqual([]);
    sim.task(() => sim.controller.onScrollEnd());
    expect(sim.readScrollTop()).toBe(top);
    sim.task(() => sim.controller.setTouchActive(false, false));
    sim.settle();
    expect(sim.contentTop).toBe(24);
    expect(sim.screenTop('t40')).toBe(line);
    expectHealthy(sim);
  });

  it('does not shift for a touch without confirmed conversation movement', () => {
    const sim = new ScrollSim(
      turnRows(
        80,
        () => 100,
        () => 100
      ),
      V
    );
    sim.setContentShift = (shift) => {
      sim.contentTop = 24 - shift;
    };
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.jumpToIndex(40));
    sim.settle();
    sim.controller.setTouchActive(true);
    sim.controller.setTouchActive(false, true);
    const top = sim.readScrollTop();
    const line = sim.screenTop('t40');
    sim.render(sim.rows.map((row, i) => (i === 35 ? { ...row, height: 300 } : row)));
    sim.settle();
    expect(sim.contentTop).toBe(24);
    expect(sim.readScrollTop()).toBe(top + 200);
    expect(sim.screenTop('t40')).toBe(line);
    expectHealthy(sim);
  });

  it.each(['top', 'jump', 'follow', 'cancel', 'hide'])(
    'absorbs a pending shift at %s without leaving a blank viewport',
    (action) => {
      const sim = readingFling();
      sim.render(sim.rows.map((row, i) => (i === 35 ? { ...row, height: 300 } : row)));
      sim.settle();
      expect(sim.contentTop).toBe(-176);
      if (action === 'top') {
        sim.nativeScroll(0);
        sim.frame();
      }
      if (action === 'jump') sim.task(() => sim.controller.jumpToIndex(20));
      if (action === 'follow') sim.task(() => sim.controller.scrollToBottom());
      if (action === 'cancel') sim.task(() => sim.controller.setTouchActive(false, false));
      if (action === 'hide') {
        sim.setHidden(true);
        sim.setHidden(false);
      }
      sim.settle();
      expect(sim.contentTop).toBe(24);
      if (action === 'top') expect(sim.readScrollTop()).toBe(200);
      if (action === 'jump') expect(sim.screenTop('t20')).toBe(0);
      if (action === 'follow') expect(sim.controller.mode).toBe('follow');
      expectHealthy(sim);
    }
  );

  it('compensates shrinkage immediately with a positive shift already pending', () => {
    const sim = readingFling();
    sim.render(sim.rows.map((row, i) => (i === 35 ? { ...row, height: 300 } : row)));
    sim.settle();
    const top = sim.readScrollTop();
    const line = sim.screenTop('t40');
    sim.render(sim.rows.map((row, i) => (i === 35 ? { ...row, height: 150 } : row)));
    sim.settle();
    expect(sim.readScrollTop()).toBe(top - 150);
    expect(sim.screenTop('t40')).toBe(line);
    expectHealthy(sim);
    sim.task(() => sim.controller.onScrollEnd());
    sim.settle();
    expect(sim.contentTop).toBe(24);
    expect(sim.screenTop('t40')).toBe(line);
    expectHealthy(sim);
  });
});

describe('following', () => {
  it('keeps the bottom as a pending message appears after the activity row and is then committed', () => {
    const activity: SimRow = {
      key: 'activity',
      turnId: null,
      turnIndex: -1,
      fixed: 'agent-activity',
      height: 36,
      estimate: 36,
    };
    const trailing = (height: number): SimRow => ({
      key: 'trailing',
      turnId: null,
      turnIndex: -1,
      fixed: 'trailing',
      height,
      estimate: 0,
    });
    const turns = turnRows(40, () => 120);
    const sim = new ScrollSim([...turns, activity, trailing(0)], V);
    sim.render();
    sim.settle();
    expectHealthy(sim);

    // The pending message shows in the trailing row, then the history commits
    // it as a turn and the trailing row empties again.
    sim.render([...turns, activity, trailing(140)]);
    sim.settle();
    expect(sim.controller.mode).toBe('follow');
    expectHealthy(sim);
    sim.render([
      ...turns,
      ...turnRows(
        1,
        () => 140,
        () => 88,
        'sent'
      ),
      activity,
      trailing(0),
    ]);
    sim.settle();
    expect(sim.controller.mode).toBe('follow');
    expectHealthy(sim);
  });

  it('keeps the bottom when the viewport grows and clamps (composer shrinking)', () => {
    const sim = new ScrollSim(
      turnRows(50, () => 100),
      V
    );
    sim.render();
    sim.settle();
    sim.resizeViewport(V + 120);
    sim.settle();
    expect(sim.controller.mode).toBe('follow');
    expectHealthy(sim);
    sim.resizeViewport(V - 80);
    sim.settle();
    expect(sim.controller.mode).toBe('follow');
    expectHealthy(sim);
  });
});

describe('manual disclosures', () => {
  const header: SimRow = {
    key: 'tool-header',
    turnId: 'tool-turn',
    turnIndex: 20,
    itemIndex: 0,
    height: 32,
    estimate: 32,
  };
  const prefix = turnRows(
    20,
    () => 100,
    () => 100
  );
  const tail = turnRows(
    3,
    () => 100,
    () => 100,
    'tail'
  );
  const rows = (expanded: boolean) => [
    ...prefix,
    { ...header, height: expanded ? 832 : 32 },
    ...tail,
  ];
  const screenY = (sim: ScrollSim) => sim.contentTop + 2000 - sim.readScrollTop();
  const setup = () => {
    const sim = new ScrollSim(rows(false), V);
    sim.render();
    sim.settle();
    return sim;
  };

  it('holds the clicked header when expanding from follow and while later output grows', () => {
    const sim = setup();
    const before = screenY(sim);
    sim.task(() => sim.controller.preserveDisclosure(header.key, 0));
    sim.render(rows(true));
    sim.settle();
    expect(sim.controller.mode).toBe('read');
    expect(screenY(sim)).toBe(before);
    sim.render([
      ...rows(true),
      ...turnRows(
        2,
        () => 200,
        () => 200,
        'new-output'
      ),
    ]);
    sim.settle();
    expect(screenY(sim)).toBe(before);
    expectHealthy(sim);
  });

  it('does not let the previous downward scroll end resume following after a toggle', () => {
    const sim = setup();
    sim.task(() => sim.controller.release('reader-up'));
    sim.nativeScroll(sim.readScrollTop() - 100);
    sim.settle();
    sim.controller.onReaderInput(false);
    sim.nativeScroll(sim.maxTop());
    sim.settle();
    sim.task(() => sim.controller.preserveDisclosure(header.key, 0));
    sim.task(() => sim.controller.onScrollEnd());
    expect(sim.controller.mode).toBe('read');
    const before = screenY(sim);
    sim.render(rows(true));
    sim.settle();
    expect(screenY(sim)).toBe(before);
    expectHealthy(sim);
  });

  it('reserves bounded space when a collapse near the end would clamp away the header', () => {
    const sim = setup();
    sim.task(() => sim.controller.preserveDisclosure(header.key, 0));
    sim.render(rows(true));
    sim.settle();
    sim.controller.onReaderInput(false);
    sim.nativeScroll(sim.readScrollTop() + screenY(sim) - 20);
    sim.settle();
    expect(screenY(sim)).toBe(20);
    sim.task(() => sim.controller.preserveDisclosure(header.key, 0));
    sim.render(rows(false));
    sim.settle();
    expect(screenY(sim)).toBe(20);
    expect(sim.replyRoom).toBeGreaterThan(0);
    expect(sim.replyRoom).toBeLessThanOrEqual(V);
    sim.controller.onReaderInput(true);
    sim.nativeScroll(sim.readScrollTop() - 100);
    sim.settle();
    expect(sim.replyRoom).toBeLessThan(224);
    sim.task(() => sim.controller.scrollToBottom());
    sim.settle();
    expect(sim.replyRoom).toBe(0);
    expect(sim.controller.mode).toBe('follow');
    expectHealthy(sim);
  });

  it.each([false, true])(
    'only reveals a mobile preview when details are entirely outside (hidden=%s)',
    (hidden) => {
      const sim = setup();
      sim.controller.onReaderInput(true);
      if (hidden) sim.nativeScroll(sim.readScrollTop() - (V - screenY(sim) - 32));
      sim.settle();
      const before = screenY(sim);
      sim.task(() => sim.controller.preserveDisclosure(header.key, 0, 32));
      sim.render(rows(true));
      sim.settle();
      expect(screenY(sim)).toBe(hidden ? before - 96 : before);
      expect(sim.controller.mode).toBe('read');
      expectHealthy(sim);
    }
  );
});

describe('reading', () => {
  it('keeps the row under the reader in place when rows above change size or expand', () => {
    let rows = turnRows(
      80,
      () => 100,
      () => 100
    );
    const sim = new ScrollSim(rows, V);
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.release('wheel-up'));
    sim.nativeScroll(4000);
    sim.settle();
    const key = 't40';
    const before = sim.screenTop(key);
    expect(before).not.toBeNull();

    rows = rows.map((row, i) => (i < 30 ? { ...row, height: row.height + 37 } : row));
    sim.render(rows);
    sim.settle();
    expect(sim.screenTop(key)).toBe(before);

    sim.render(expand(rows, 't10', 9, 140));
    sim.settle();
    expect(sim.screenTop(key)).toBe(before);
    expectHealthy(sim);
  });

  it('keeps and covers reader movement that lands between a sample and a relative write', () => {
    let rows = turnRows(80, () => 100);
    const sim = new ScrollSim(rows, V);
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.release('wheel-up'));
    sim.nativeScroll(4000);
    sim.settle();

    // The reader's fling moves 1500px while the compensation is written.
    const original = sim.scrollBy.bind(sim);
    sim.scrollBy = (delta: number) => {
      sim.scrollBy = original;
      original(delta + 1500);
    };
    rows = rows.map((row, i) => (i < 20 ? { ...row, height: row.height + 50 } : row));
    sim.render(rows);
    expect(sim.covered()).toBe(true);
    sim.settle();
    expectHealthy(sim);
    // A later event reporting the same offset changes nothing.
    const top = sim.readScrollTop();
    sim.task(() => sim.controller.onScrollEvent());
    expect(sim.readScrollTop()).toBe(top);
    expect(sim.covered()).toBe(true);
  });

  // Ten 100px turns, the placeholder of turn t10 (60px, keyed by its turn id,
  // like the product's), then ten more turns.
  const aroundPlaceholder = (): SimRow[] => [
    ...turnRows(
      10,
      () => 100,
      () => 100
    ),
    { key: 't10', turnId: 't10', turnIndex: 10, placeholder: true, height: 60, estimate: 60 },
    ...turnRows(
      10,
      () => 100,
      () => 100
    ).map((row, i) => ({
      ...row,
      key: `t${i + 11}`,
      turnId: `t${i + 11}`,
      turnIndex: i + 11,
    })),
  ];

  it('lets the reader rest inside a placeholder, then keeps the offset when its turn hydrates under the same key', () => {
    let rows = aroundPlaceholder();
    const sim = new ScrollSim(rows, 300);
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.release('wheel-up'));
    sim.writes = [];
    // 30px into the placeholder (content top 24 + ten 100px rows).
    sim.nativeScroll(1054);
    sim.settle();
    expect(sim.writes).toEqual([]);
    expect(sim.readScrollTop()).toBe(1054);

    // A user turn hydrates into one taller row with the same key.
    rows = rows.map((row) =>
      row.key === 't10' ? { ...row, placeholder: false, height: 200, estimate: 60 } : row
    );
    sim.render(rows);
    sim.settle();
    expect(sim.screenTop('t10')).toBe(-30);
    expectHealthy(sim);
  });

  it('lands on the first row of a turn that hydrates into rows with new keys', () => {
    const rows = aroundPlaceholder();
    const sim = new ScrollSim(rows, 300);
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.release('wheel-up'));
    sim.nativeScroll(1054);
    sim.settle();

    sim.render(expand(rows, 't10', 3, 100));
    sim.settle();
    expect(sim.screenTop('t10.0')).toBe(0);
    expectHealthy(sim);
  });

  it('gets its offset back when the row it read is evicted to a placeholder and hydrates again', () => {
    let rows = aroundPlaceholder().map((row) =>
      row.key === 't10' ? { ...row, placeholder: false, height: 200, estimate: 60 } : row
    );
    const sim = new ScrollSim(rows, 300);
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.release('wheel-up'));
    sim.nativeScroll(1024 + 150);
    sim.settle();
    expect(sim.screenTop('t10')).toBe(-150);

    // Evicted: the placeholder is shorter than the offset, which clamps to it.
    rows = rows.map((row) => (row.key === 't10' ? { ...row, placeholder: true, height: 60 } : row));
    sim.render(rows);
    sim.settle();
    expect(sim.screenTop('t10')).toBe(-60);

    rows = rows.map((row) =>
      row.key === 't10' ? { ...row, placeholder: false, height: 200 } : row
    );
    sim.render(rows);
    sim.settle();
    expect(sim.screenTop('t10')).toBe(-150);
    expectHealthy(sim);
  });

  it('moves the row under the reader by exactly each wheel step through mixed hydrated and placeholder turns', () => {
    // Every third turn is a placeholder; hydrated rows are taller than their
    // estimates, so rows are measured (and compensated) as they come into view.
    const rows: SimRow[] = Array.from({ length: 120 }, (_, i) =>
      i % 3 === 1
        ? {
            key: `t${i}`,
            turnId: `t${i}`,
            turnIndex: i,
            placeholder: true,
            height: 88,
            estimate: 88,
          }
        : {
            key: `t${i}`,
            turnId: `t${i}`,
            turnIndex: i,
            height: 120 + (i % 5) * 45,
            estimate: 60,
          }
    );
    const sim = new ScrollSim(rows, V);
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.release('wheel-up'));
    const step = 173;
    for (let i = 0; i < 60 && sim.readScrollTop() > step; i++) {
      const y = sim.readScrollTop();
      const [key, top] = [...sim.mounted].findLast(([, rowTop]) => rowTop <= y - sim.contentTop)!;
      const before = sim.contentTop + top - y;
      sim.nativeScroll(y - step);
      sim.settle();
      expect(sim.screenTop(key)).toBe(before + step);
      expectHealthy(sim);
    }
  });

  // Rows streamed in while the reader was above were never mounted, so the
  // bottom a fast fling runs into is estimated and too short. The compositor
  // stops the fling at that stale bottom while the engine has already grown
  // the range behind it, so the scroll lands short of the new bottom.
  const flingIntoStaleBottom = () => {
    const sim = new ScrollSim(
      turnRows(40, () => 100),
      V
    );
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.release('wheel-up'));
    sim.nativeScroll(sim.maxTop() - 2000);
    sim.settle();
    const streamed = turnRows(
      6,
      () => 300,
      () => 60,
      'late'
    ).map((row, i) => ({ ...row, turnIndex: 40 + i }));
    sim.render([...sim.rows, ...streamed]);
    sim.settle();
    const wall = sim.maxTop();
    sim.controller.setTouchActive(true);
    sim.controller.setTouchActive(false);
    // The fling's first steps mount and measure the streamed rows...
    sim.nativeScroll(wall - 700);
    sim.settle();
    expect(sim.maxTop()).toBeGreaterThan(wall + 1000);
    return { sim, wall };
  };

  it('follows again when a fast downward fling stops at the bottom it was scrolling toward', () => {
    const { sim, wall } = flingIntoStaleBottom();
    // ...and the fling dies against the range the compositor last saw.
    sim.nativeScroll(wall);
    sim.settle();
    sim.task(() => sim.controller.onScrollEnd());
    sim.settle();
    expect(sim.controller.mode).toBe('follow');
    expect(sim.readScrollTop()).toBe(sim.maxTop());
    expectHealthy(sim);
  });

  it('keeps reading when a downward scroll comes to rest anywhere else', () => {
    const { sim, wall } = flingIntoStaleBottom();
    sim.nativeScroll(wall - 300);
    sim.settle();
    sim.task(() => sim.controller.onScrollEnd());
    sim.settle();
    expect(sim.controller.mode).toBe('read');
    expect(sim.readScrollTop()).toBe(wall - 300);
  });
});

describe('commands', () => {
  it('lands a jump that arrives while a transaction is still in flight', () => {
    let rows = turnRows(
      200,
      (i) => 60 + (i % 5) * 30,
      () => 50
    );
    const sim = new ScrollSim(rows, V);
    sim.render();
    sim.settle();
    // A size change starts a transaction whose commit is still pending when an
    // outline jump arrives in the same task.
    rows = rows.map((row, i) => (i === 190 ? { ...row, height: row.height + 40 } : row));
    sim.rows = rows;
    sim.task(() => {
      sim.controller.onRowsResized([{ key: 't190', height: rows[190]!.height }]);
      sim.controller.jumpToIndex(20);
    });
    sim.settle();
    expect(sim.screenTop('t20')).toBe(0);
    expect(sim.controller.mode).toBe('read');
    expectHealthy(sim);
  });

  it('keeps a jumped row at the top while the rows around it hydrate into several rows', () => {
    let rows = turnRows(
      200,
      () => 100,
      () => 60
    );
    const sim = new ScrollSim(rows, V);
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.jumpToIndex(100));
    sim.settle();
    expect(sim.screenTop('t100')).toBe(0);
    // Placeholder turns on both sides become several rows, one after another.
    for (const key of ['t95', 't98', 't99', 't103', 't90']) {
      rows = expand(rows, key, 4, 80);
      sim.render(rows);
      sim.settle();
      expect(sim.screenTop('t100')).toBe(0);
    }
    expectHealthy(sim);
  });

  it('holds a sent message below 100px of context with reply room, then follows once the reply fills it', () => {
    let rows = turnRows(30, () => 100);
    const sim = new ScrollSim(rows, V);
    sim.render();
    sim.settle();
    rows = [
      ...rows,
      ...turnRows(
        1,
        () => 80,
        () => 80,
        'sent'
      ),
    ];
    sim.render(rows);
    sim.settle();
    sim.task(() => sim.controller.anchorToRow(rows.length - 1));
    sim.settle();
    expect(sim.controller.mode).toBe('sent');
    expect(sim.screenTop('sent0')).toBe(sim.contentTop + 100);
    expect(sim.replyRoom).toBe(V - sim.contentTop - sim.paddingBottom - 100 - 80);
    expect(sim.screenTop('t29') + 100).toBe(sim.contentTop + 100);

    const reply: SimRow = {
      key: 'reply',
      turnId: 'reply',
      turnIndex: 31,
      height: 50,
      estimate: 50,
    };
    rows = [...rows, reply];
    for (let height = 50; height < 900; height += 90) {
      rows = rows.map((row) => (row.key === 'reply' ? { ...row, height } : row));
      sim.render(rows);
      sim.settle();
      if (sim.controller.mode === 'sent') {
        expect(sim.screenTop('sent0')).toBe(sim.contentTop + 100);
      }
    }
    expect(sim.controller.mode).toBe('follow');
    expect(sim.replyRoom).toBe(0);
    expectHealthy(sim);
  });

  it.each([true, false])(
    'clamps send context to the start (reduced motion: %s)',
    (reducedMotion) => {
      for (const previousHeight of [0, 60]) {
        const rows =
          previousHeight === 0
            ? turnRows(1, () => 80)
            : turnRows(2, (i) => (i === 0 ? previousHeight : 80));
        const sim = new ScrollSim(rows, V);
        sim.reducedMotion = reducedMotion;
        sim.render();
        sim.settle();
        sim.task(() => sim.controller.anchorToRow(rows.length - 1));
        sim.settle();
        expect(sim.readScrollTop()).toBe(0);
        expect(sim.screenTop(rows[rows.length - 1]!.key)).toBe(sim.contentTop + previousHeight);
        expect(sim.replyRoom).toBe(V - sim.contentTop - sim.paddingBottom - previousHeight - 80);
        expectHealthy(sim);
      }
    }
  );

  it.each([500, 900])(
    'shows the end of a %spx sent message that cannot fit below context',
    (height) => {
      const rows = [
        ...turnRows(30, () => 100),
        ...turnRows(
          1,
          () => height,
          () => height,
          'sent'
        ),
      ];
      const sim = new ScrollSim(rows, V);
      sim.render();
      sim.settle();
      sim.task(() => sim.controller.anchorToRow(rows.length - 1));
      sim.settle();
      expect(sim.controller.mode).toBe('follow');
      expect(sim.replyRoom).toBe(0);
      expect(sim.screenTop('sent0') + height).toBe(V - sim.paddingBottom);
      expectHealthy(sim);
    }
  );
});

describe('onScroll must not re-enter a cycle (React #185)', () => {
  it('keeps an anchor on a creation record that its hydrated neighbour groups away', () => {
    // Consecutive creation records c0, c1 share c0's row only while c0 is
    // hydrated, and the hydration window follows each reported offset.
    const rowsFor = (grouped: boolean): SimRow[] => [
      ...turnRows(20, () => 300),
      grouped
        ? {
            key: 'c0',
            turnId: 'c0',
            turnIndex: 20,
            groupTurnIds: ['c1'],
            height: 160,
            estimate: 60,
          }
        : { key: 'c0', turnId: 'c0', turnIndex: 20, placeholder: true, height: 60, estimate: 60 },
      ...(grouped ? [] : [{ key: 'c1', turnId: 'c1', turnIndex: 21, height: 100, estimate: 60 }]),
      ...turnRows(18, () => 300, undefined, 'u').map((row) => ({
        ...row,
        turnIndex: row.turnIndex + 22,
      })),
    ];
    let grouped = false;
    const sim: ScrollSim = new ScrollSim(rowsFor(grouped), V, {
      // A recorded turn index can be out of date; the production report fell
      // back from the missing row to a turn ~9000px away.
      initialIntent: {
        kind: 'read',
        anchor: { kind: 'turn', turnId: 'c1', turnIndex: 3, rowKey: 'c1', item: null, offsetPx: 0 },
        screenY: 0,
      },
      callbacks: {
        onScroll: (offset) => {
          const top = sim.rows[sim.controller.findItemIndex(offset - sim.contentTop)]!;
          const next = Math.abs(top.turnIndex - 20) <= 4;
          if (next === grouped) return;
          grouped = next;
          sim.render(rowsFor(grouped));
        },
      },
    });
    sim.render();
    sim.settle();
    expect(grouped).toBe(true);
    expect(sim.screenTop('c0')).toBe(0);
    expectHealthy(sim);
  });
});

describe('hidden viewport', () => {
  // An inactive tab stays mounted under `display: none` and keeps committing
  // as its conversation streams. Reporting its offset 0 to the view once fed a
  // synchronous render loop (React #185).
  function observe(sim: ScrollSim) {
    const seen = { scrolls: [] as number[], transactions: 0 };
    sim.controller.setCallbacks({
      onScroll: (offset) => seen.scrolls.push(offset),
      onDiagnostic: () => {
        seen.transactions += 1;
      },
    });
    return seen;
  }

  it('reports nothing while hidden and shows again at the reading position, whatever changed above it', () => {
    let rows = turnRows(
      60,
      () => 100,
      () => 100
    );
    const sim = new ScrollSim(rows, V);
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.jumpToIndex(30));
    sim.settle();
    const seen = observe(sim);
    const writes = sim.writes.length;

    sim.setHidden(true);
    rows = expand(rows, 't5', 14, 100);
    sim.render(rows);
    sim.settle();
    rows = [...rows, ...turnRows(3, () => 200, undefined, 'n')];
    sim.render(rows);
    sim.settle();
    expect(seen).toEqual({ scrolls: [], transactions: 0 });
    expect(sim.writes.length).toBe(writes);
    expect(sim.controller.mode).toBe('read');

    sim.setHidden(false);
    sim.settle();
    expectHealthy(sim);
    expect(sim.screenTop('t30')).toBe(0);
    expect(seen.scrolls.at(-1)).toBe(sim.readScrollTop());
  });
});

describe('momentum diagnostics', () => {
  it('keeps the reading anchor when a viewport clamp ends an active downward sequence', () => {
    const sim = new ScrollSim(
      turnRows(
        40,
        () => 100,
        () => 100
      ),
      V
    );
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.jumpToIndex(30));
    sim.settle();
    sim.controller.setTouchActive(true);
    sim.controller.setTouchActive(false);
    const reading = sim.maxTop() - 80;
    sim.nativeScroll(reading);
    sim.settle();
    // Browser scroll steps sample the clamp before its resize delivery.
    sim.viewport = V + 120;
    sim.frame();
    sim.task(() => sim.controller.onViewportResized());
    sim.task(() => sim.controller.onScrollEnd());
    sim.resizeViewport(V);
    sim.settle();
    expect(sim.controller.mode).toBe('read');
    expect(sim.readScrollTop()).toBe(reading);
    expectHealthy(sim);
  });

  it('waits for the native fling to finish before closing a near-bottom gap', () => {
    const sim = new ScrollSim(
      turnRows(
        40,
        () => 100,
        () => 100
      ),
      V
    );
    sim.render();
    sim.settle();
    sim.controller.release('touch-up');
    sim.nativeScroll(sim.maxTop() - 100);
    sim.settle();
    sim.controller.setTouchActive(true);
    sim.controller.setTouchActive(false);
    sim.writes = [];
    sim.nativeScroll(sim.maxTop() - 3);
    sim.settle();
    // Output and parent commits at this position must not interrupt the fling.
    sim.render();
    sim.settle();
    expect(sim.controller.mode).toBe('read');
    expect(sim.readScrollTop()).toBe(sim.maxTop() - 3);
    expect(sim.writes).toEqual([]);
    sim.task(() => sim.controller.onScrollEnd());
    sim.settle();
    expect(sim.controller.mode).toBe('follow');
    expect(sim.readScrollTop()).toBe(sim.maxTop());
    expectHealthy(sim);
  });

  it('ignores elastic overshoot and rebound without losing native input', () => {
    const sim = new ScrollSim(
      turnRows(
        40,
        () => 100,
        () => 100
      ),
      V
    );
    sim.render();
    sim.settle();
    sim.controller.release('touch-up');
    sim.nativeScroll(sim.maxTop() - 100);
    sim.settle();
    sim.controller.setTouchActive(true);
    sim.controller.setTouchActive(false);
    sim.nativeScroll(sim.maxTop());
    sim.settle();
    expect(sim.controller.mode).toBe('follow');
    sim.writes = [];
    for (const sample of [24, 18, 12, 6, 0]) {
      sim.elasticOffset = sample;
      sim.task(() => sim.controller.onScrollEvent());
      sim.render();
      sim.settle();
      expect(sim.controller.mode).toBe('follow');
      expect(sim.controller.scrollOffset).toBe(sim.maxTop());
    }
    expect(sim.writes).toEqual([]);
    // Input survives the automatic edge transition until scrollend.
    sim.nativeScroll(sim.maxTop() - 60);
    sim.settle();
    expect(sim.controller.mode).toBe('read');
    expect(sim.readScrollTop()).toBe(sim.maxTop() - 60);
    expectHealthy(sim);
  });

  it.each([0, 40])(
    'compensates %ipx row growth above an elastic read anchor without drifting it',
    (growth) => {
      const sim = new ScrollSim(
        turnRows(
          40,
          () => 100,
          () => 100
        ),
        V
      );
      sim.render();
      sim.settle();
      sim.controller.release('reader-up');
      const before = sim.readScrollTop();
      const anchor = sim.controller.savedIntent();
      const rowTop = sim.screenTop('t35');
      sim.elasticOffset = 24;
      // Growth above the reading anchor needs compensation. Additional
      // growth below it leaves room for an incorrect +24px write to escape clamp.
      sim.rows[33]!.height += growth;
      sim.rows[39]!.height += 100;
      sim.task(() =>
        sim.controller.onRowsResized([
          { key: 't33', height: 100 + growth },
          { key: 't39', height: 200 },
        ])
      );
      sim.settle();
      expect(sim.readScrollTop()).toBe(before + growth);
      expect(sim.screenTop('t35')).toBe(rowTop);
      expect(sim.controller.savedIntent()).toEqual(anchor);
      expectHealthy(sim);
    }
  );

  it('preserves the top reading anchor when content inset changes during negative overscroll', () => {
    const sim = new ScrollSim(
      turnRows(
        40,
        () => 100,
        () => 100
      ),
      V
    );
    sim.render();
    sim.settle();
    sim.controller.release('reader-up');
    sim.nativeScroll(0);
    sim.settle();
    const anchor = sim.controller.savedIntent();
    const rowTop = sim.screenTop('t0');
    sim.elasticOffset = -24;
    sim.contentTop += 40;
    sim.task(() => sim.controller.onViewportResized());
    sim.settle();
    expect(sim.readScrollTop()).toBe(40);
    expect(sim.screenTop('t0')).toBe(rowTop);
    expect(sim.controller.savedIntent()).toEqual(anchor);
    expectHealthy(sim);
  });
});
