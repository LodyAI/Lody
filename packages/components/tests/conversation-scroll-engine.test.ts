import { describe, expect, it } from 'vitest';
import { ScrollSim, turnRows, type SimRow } from './support/scroll-engine-sim';

/**
 * Model tests of the conversation scroll engine's transaction logic
 * (`src/lib/conversation-scroll/controller.ts`), driven by a simulator with
 * the browser semantics the scroll-engine note requires. Every scenario checks
 * the invariants that matter to a reader: the viewport is covered by rows, a
 * following reader stays at the bottom, a reading position does not move under
 * the reader, and every task ends within the commit bound.
 */

const V = 600;
/** Two passes of at most one base commit and two supplementary commits. */
const COMMIT_BOUND = 6;

function expectHealthy(sim: ScrollSim) {
  expect(sim.covered()).toBe(true);
  expect(sim.maxCommitsPerTask).toBeLessThanOrEqual(COMMIT_BOUND);
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

describe('opening', () => {
  it('opens a following conversation at its real bottom, whatever the estimates', () => {
    // Estimates are a quarter of the real heights.
    const sim = new ScrollSim(
      turnRows(
        200,
        (i) => 80 + (i % 7) * 40,
        () => 30
      ),
      V
    );
    sim.render();
    sim.settle();
    expectHealthy(sim);
    expect(sim.controller.hasCompletedFirstCycle).toBe(true);
    expect(sim.readScrollTop()).toBe(sim.maxTop());
  });

  it('restores a reading position and keeps its row on screen when rows expand above it before first paint', () => {
    // The blank-pane case: a placeholder above the restored row becomes
    // fourteen rows, far more than the overscan, before anything was painted.
    const rows = turnRows(
      60,
      () => 100,
      () => 100
    );
    const first = new ScrollSim(rows, V);
    first.render();
    first.settle();
    first.task(() => first.controller.jumpToIndex(30));
    first.settle();
    const saved = first.controller.savedIntent();
    expect(saved.kind).toBe('read');

    const sim = new ScrollSim(rows, V, { initialIntent: saved });
    sim.render();
    expect(sim.screenTop('t30')).toBe(0);
    sim.render(expand(rows, 't5', 14, 100));
    sim.settle();
    expectHealthy(sim);
    expect(sim.screenTop('t30')).toBe(0);
  });
});

describe('following', () => {
  it('stays on the latest output while the last row streams and new rows arrive', () => {
    let rows = turnRows(40, () => 120);
    const sim = new ScrollSim(rows, V);
    sim.render();
    sim.settle();
    for (let step = 0; step < 30; step++) {
      rows = rows.map((row, i) =>
        i === rows.length - 1 ? { ...row, height: row.height + 23 } : row
      );
      if (step % 7 === 6) {
        rows = [
          ...rows,
          ...turnRows(
            1,
            () => 90,
            () => 60,
            `n${step}-`
          ),
        ];
      }
      sim.render(rows);
      sim.settle();
      expectHealthy(sim);
    }
  });

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
    sim.render([...turns, ...turnRows(1, () => 140, () => 88, 'sent'), activity, trailing(0)]);
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

  it('lets a held scrollbar thumb win over compensation and still covers the viewport', () => {
    let rows = turnRows(80, () => 100);
    const sim = new ScrollSim(rows, V);
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.release('drag-up'));
    sim.nativeScroll(3000);
    sim.settle();
    const held = sim.readScrollTop();
    sim.dragOverride = held;
    rows = rows.map((row, i) => (i < 20 ? { ...row, height: row.height + 60 } : row));
    sim.render(rows);
    sim.settle();
    sim.dragOverride = null;
    // The thumb's position wins (the anchor drifts, as it does today).
    expect(sim.readScrollTop()).toBe(held);
    expectHealthy(sim);
  });

  // Ten 100px turns, the placeholder of turn t10 (60px, keyed by its turn id,
  // like the product's), then ten more turns.
  const aroundPlaceholder = (): SimRow[] => [
    ...turnRows(10, () => 100, () => 100),
    { key: 't10', turnId: 't10', turnIndex: 10, placeholder: true, height: 60, estimate: 60 },
    ...turnRows(10, () => 100, () => 100).map((row, i) => ({
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
        ? { key: `t${i}`, turnId: `t${i}`, turnIndex: i, placeholder: true, height: 88, estimate: 88 }
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
      const [key, top] = [...sim.mounted].findLast(
        ([, rowTop]) => rowTop <= y - sim.contentTop
      )!;
      const before = sim.contentTop + top - y;
      sim.nativeScroll(y - step);
      sim.settle();
      expect(sim.screenTop(key)).toBe(before + step);
      expectHealthy(sim);
    }
  });

  it('re-arms follow when the reader scrolls down to the real bottom', () => {
    const sim = new ScrollSim(
      turnRows(40, () => 100),
      V
    );
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.release('wheel-up'));
    sim.nativeScroll(1000);
    sim.settle();
    expect(sim.controller.mode).toBe('read');
    sim.nativeScroll(sim.maxTop());
    sim.settle();
    expect(sim.controller.mode).toBe('follow');
  });
});

describe('commands', () => {
  it('jumps a row to the viewport top and back to the bottom', () => {
    const sim = new ScrollSim(
      turnRows(
        100,
        (i) => 60 + (i % 5) * 30,
        () => 50
      ),
      V
    );
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.jumpToIndex(20));
    sim.settle();
    expect(sim.screenTop('t20')).toBe(0);
    expect(sim.controller.mode).toBe('read');
    expectHealthy(sim);
    sim.task(() => sim.controller.scrollToBottom());
    sim.settle();
    expect(sim.controller.mode).toBe('follow');
    expectHealthy(sim);
  });

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

  it('holds a sent message at the top with reply room, then follows once the reply fills it', () => {
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
    expect(sim.screenTop('sent0')).toBe(sim.contentTop);
    expect(sim.replyRoom).toBeGreaterThan(0);

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
        expect(sim.screenTop('sent0')).toBe(sim.contentTop);
      }
    }
    expect(sim.controller.mode).toBe('follow');
    expect(sim.replyRoom).toBe(0);
    expectHealthy(sim);
  });

  it('glides a send across frames and lands on the same position', () => {
    let rows = turnRows(30, () => 100);
    const sim = new ScrollSim(rows, V);
    sim.reducedMotion = false;
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
    // The last glide frame lands within a pixel.
    expect(sim.screenTop('sent0')).toBeCloseTo(sim.contentTop, 0);
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

  it('shows a following conversation at the real bottom of what streamed while it was hidden', () => {
    let rows = turnRows(40, () => 120);
    const sim = new ScrollSim(rows, V);
    sim.render();
    sim.settle();
    const seen = observe(sim);

    sim.setHidden(true);
    for (let step = 0; step < 5; step++) {
      rows = [
        ...rows.map((row, i) =>
          i === rows.length - 1 ? { ...row, height: row.height + 300 } : row
        ),
        ...turnRows(
          1,
          () => 90,
          () => 60,
          `n${step}-`
        ),
      ];
      sim.render(rows);
      sim.settle();
    }
    expect(seen.scrolls).toEqual([]);

    sim.setHidden(false);
    sim.settle();
    expect(sim.controller.mode).toBe('follow');
    expectHealthy(sim);
  });
});

describe('momentum diagnostics', () => {
  it('counts compensations during a touch fling and which of them ended it', () => {
    let rows = turnRows(
      80,
      () => 100,
      () => 100
    );
    const stats: Array<{ compensations: number; interruptions: number }> = [];
    const sim = new ScrollSim(rows, V, { callbacks: { onMomentumEnd: (s) => stats.push(s) } });
    sim.render();
    sim.settle();
    sim.task(() => sim.controller.release('wheel-up'));
    sim.nativeScroll(4000);
    sim.settle();

    // A fling: the finger lifts, momentum keeps scrolling, rows above grow.
    sim.task(() => sim.controller.setTouchActive(true));
    sim.task(() => sim.controller.setTouchActive(false));
    sim.nativeScroll(3900);
    sim.settle();
    // Mounted rows just above the viewport grow (within the overscan).
    rows = rows.map((row, i) => (i >= 32 && i < 38 ? { ...row, height: row.height + 30 } : row));
    sim.render(rows);
    // The growth reaches the engine through the ResizeObserver; its compensation
    // write's own scroll event is not movement.
    sim.settle();
    // The write stopped the fling: scrollend arrives with no scroll after it.
    sim.task(() => sim.controller.onScrollEnd());
    expect(stats).toEqual([{ compensations: 1, interruptions: 1 }]);

    // A second fling that keeps moving after the compensation.
    sim.task(() => sim.controller.setTouchActive(true));
    sim.task(() => sim.controller.setTouchActive(false));
    rows = rows.map((row, i) => (i >= 32 && i < 38 ? { ...row, height: row.height + 30 } : row));
    sim.render(rows);
    sim.settle();
    sim.nativeScroll(sim.readScrollTop() - 200);
    sim.settle();
    sim.task(() => sim.controller.onScrollEnd());
    expect(stats[1]).toEqual({ compensations: 1, interruptions: 0 });
  });
});

/** Mulberry32: a small seeded PRNG so the sweep is reproducible. */
function prng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('randomized sequences', () => {
  it.each(Array.from({ length: 40 }, (_, seed) => seed + 1))(
    'keeps every invariant for seed %i',
    (seed) => {
      const random = prng(seed);
      const pick = (n: number) => Math.floor(random() * n);
      let counter = 0;
      const makeRow = (turnIndex: number): SimRow => {
        counter += 1;
        return {
          key: `k${counter}`,
          turnId: `k${counter}`,
          turnIndex,
          height: 20 + pick(400),
          estimate: 20 + pick(200),
        };
      };
      let rows: SimRow[] = Array.from({ length: 30 + pick(120) }, (_, i) => makeRow(i));
      const sim = new ScrollSim(rows, 300 + pick(700));
      sim.render();
      sim.settle();
      expectHealthy(sim);

      for (let step = 0; step < 60; step++) {
        const action = pick(10);
        const mode = sim.controller.mode;
        // The row under the viewport's top line is the reading anchor (I5).
        const anchorKey =
          mode === 'read'
            ? [...sim.mounted.keys()].find((key) => {
                const top = sim.screenTop(key);
                const height = rows.find((row) => row.key === key)?.height ?? 0;
                return top !== null && top <= 0 && top + height > 0;
              })
            : undefined;
        const anchorHeight = rows.find((row) => row.key === anchorKey)?.height;
        const anchorBefore = anchorKey ? sim.screenTop(anchorKey) : null;
        let geometryOnly = false;
        switch (action) {
          case 0: // rows above/below grow or shrink
            rows = rows.map((row) => (random() < 0.2 ? { ...row, height: 20 + pick(400) } : row));
            geometryOnly = true;
            break;
          case 1: {
            // a row expands into several (a placeholder hydrating)
            const index = pick(rows.length);
            const parts = 1 + pick(15);
            const base = rows[index]!;
            rows = [
              ...rows.slice(0, index),
              ...Array.from({ length: parts }, (_, part) => ({
                ...makeRow(base.turnIndex),
                turnId: base.turnId,
                itemIndex: part,
              })),
              ...rows.slice(index + 1),
            ];
            geometryOnly = true;
            break;
          }
          case 2: // rows appended (new output)
            rows = [...rows, ...Array.from({ length: 1 + pick(3) }, () => makeRow(rows.length))];
            break;
          case 3: // a row far from the reader is removed
            if (rows.length > 5) {
              const index = pick(rows.length);
              if (!anchorKey || rows[index]!.key !== anchorKey) {
                rows = rows.filter((_, i) => i !== index);
                geometryOnly = true;
              }
            }
            break;
          case 4:
            sim.task(() => sim.controller.release('wheel-up'));
            sim.nativeScroll(random() * sim.maxTop());
            break;
          case 5:
            sim.resizeViewport(250 + pick(800));
            break;
          case 6:
            sim.task(() => sim.controller.jumpToIndex(pick(rows.length)));
            break;
          case 7:
            sim.task(() => sim.controller.scrollToBottom());
            break;
          default:
            break;
        }
        sim.render(rows);
        sim.settle();
        expectHealthy(sim);
        // I5: a pure layout change keeps the reading row in place when it stays reachable.
        if (
          geometryOnly &&
          mode === 'read' &&
          sim.controller.mode === 'read' &&
          anchorKey &&
          anchorBefore !== null &&
          rows.some((row) => row.key === anchorKey)
        ) {
          const after = sim.screenTop(anchorKey);
          const reachable = sim.readScrollTop() > 1 && sim.readScrollTop() < sim.maxTop() - 1;
          const sameHeight = rows.find((row) => row.key === anchorKey)?.height === anchorHeight;
          if (after !== null && reachable && sameHeight) expect(after).toBeCloseTo(anchorBefore, 0);
        }
      }
    }
  );
});
