import { beforeEach, describe, expect, it } from 'vitest';
import type { SessionHistoryParsed } from '@lody/shared';
import {
  OUTLINE_MIN_USER_ROUNDS,
  buildConversationOutline,
  countUserDrivenRounds,
  type ConversationOutlineSource,
  buildOutlineAnchors,
  resolveActiveOutlineIndex,
  type ConversationOutlineAnchor,
  type ConversationOutlineEntry,
} from '../src/lib/conversation-outline';
import {
  ACTIVE_BAR_OVERHANG,
  ACTIVE_TICK_WIDTH,
  TICK_PITCH,
  RAIL_TRACK_WIDTH,
  RAIL_EDGE_FADE_LENGTH,
  TICK_WIDTHS,
  outlineTickRestingWidth,
  outlineTickWidth,
  outlineTickWidthAt,
} from '../src/components/ai-gui/conversation-outline-rail-geometry';

describe('conversation-outline', () => {
  let nextId = 0;

  const message = (
    role: 'user' | 'assistant' | 'system',
    items: unknown[],
    overrides: Partial<SessionHistoryParsed> = {}
  ): ConversationOutlineSource => {
    nextId += 1;
    return {
      type: 'message',
      message: {
        id: `msg-${nextId}`,
        role,
        items,
        timestamp: '2026-08-19T00:00:00.000Z',
        ...overrides,
      } as unknown as SessionHistoryParsed,
    };
  };

  const text = (value: string) => ({ type: 'text', text: value });
  const thought = (value: string) => ({ type: 'thought', text: value });

  beforeEach(() => {
    nextId = 0;
  });

  describe('buildConversationOutline', () => {
    it('makes one entry per round and takes the preview from the round’s first agent prose', () => {
      const outline = buildConversationOutline([
        message('user', [text('Add a rail to the session view')]),
        message('assistant', [text('Here is the plan for the rail.')]),
        message('assistant', [text('And here is the follow-up.')]),
        message('user', [text('Ship it')]),
        message('assistant', [text('Shipped.')]),
      ]);

      expect(outline).toHaveLength(2);
      expect(outline[0]).toMatchObject({
        title: 'Add a rail to the session view',
        preview: 'Here is the plan for the rail.',
      });
      expect(outline[1]).toMatchObject({ title: 'Ship it', preview: 'Shipped.' });
    });

    it('preserves literal identifiers in summaries and refreshes only changed turns', () => {
      const user = message('user', [text('Find QA_RESUMED_OK')]);
      const assistant = message('assistant', [text('**QA_RESUMED_OK** `foo_bar`')]);
      const first = buildConversationOutline([user, assistant]);
      expect(first[0]).toMatchObject({
        title: 'Find QA_RESUMED_OK',
        preview: 'QA_RESUMED_OK foo_bar',
      });
      expect(buildConversationOutline([user, assistant])).toEqual(first);
      const updated = {
        ...assistant,
        message: { ...assistant.message!, items: [text('QA_RESUMED_OK — updated')] },
      };
      expect(buildConversationOutline([user, updated])[0]?.preview).toBe('QA_RESUMED_OK — updated');
      expect(buildConversationOutline([user, assistant])).toEqual(first);
      const long = message('assistant', [
        text('QA_RESUMED_OK ' + 'x'.repeat(960) + ' OUTSIDE_WINDOW'),
      ]);
      expect(buildConversationOutline([user, long])[0]?.preview).toContain('QA_RESUMED_OK');
      expect(buildConversationOutline([user, long])[0]?.preview).not.toContain('OUTSIDE_WINDOW');
    });

    it('leaves the preview empty while a round has produced no agent prose yet', () => {
      const outline = buildConversationOutline([
        message('user', [text('Start working')]),
        message('assistant', [thought('planning…')]),
      ]);

      expect(outline[0]?.preview).toBe('');
    });

    it('opens a round for content that precedes the first user message', () => {
      const outline = buildConversationOutline([
        message('assistant', [text('Scheduled run starting.')]),
        message('user', [text('Thanks')]),
      ]);

      expect(outline).toHaveLength(2);
      expect(outline[0]).toMatchObject({
        startsWithAgent: true,
        title: 'Scheduled run starting.',
        preview: 'Scheduled run starting.',
      });
      expect(outline[1]?.startsWithAgent).toBe(false);
    });

    describe('weight', () => {
      it('accumulates across every message in the round, not just the first', () => {
        // Stated as a comparison rather than a fixed bucket, so recalibrating the
        // thresholds against real sessions cannot silently invalidate the claim.
        const half = 'y'.repeat(600);
        const oneReply = buildConversationOutline([
          message('user', [text('hi')]),
          message('assistant', [text(half)]),
        ]);
        const twoReplies = buildConversationOutline([
          message('user', [text('hi')]),
          message('assistant', [text(half)]),
          message('assistant', [text(half)]),
        ]);

        expect(twoReplies[0]?.weight).toBeGreaterThan(oneReply[0]?.weight ?? 0);
      });

      it('ignores non-prose items so a tool-heavy turn is not maxed out', () => {
        const outline = buildConversationOutline([
          message('user', [text('hi')]),
          message('assistant', [
            { type: 'tool_call', toolCallId: 't1', title: 'z'.repeat(50_000) },
            text('done'),
          ]),
        ]);

        expect(outline[0]?.weight).toBe(0);
      });
    });
  });

  describe('countUserDrivenRounds', () => {
    const rounds = (count: number): ConversationOutlineSource[] =>
      Array.from({ length: count }, (_unused, index) =>
        message('user', [text(`round ${index + 1}`)])
      );

    it('does not count a leading agent round toward the rail threshold', () => {
      const outline = buildConversationOutline([
        message('assistant', [text('Scheduled run starting.')]),
        ...rounds(OUTLINE_MIN_USER_ROUNDS - 1),
      ]);

      expect(outline).toHaveLength(OUTLINE_MIN_USER_ROUNDS);
      expect(countUserDrivenRounds(outline)).toBe(OUTLINE_MIN_USER_ROUNDS - 1);
    });
  });
});

describe('conversation-outline-active', () => {
  /**
   * Reader position is resolved from Virtua's index math, never from the DOM —
   * the conversation is virtualized, so most rounds have no element to observe.
   * These tests drive that math with a plain offset table: no DOM, no timers, no
   * virtualizer.
   */

  const entry = (messageIndex: number): ConversationOutlineEntry => ({
    key: `k${messageIndex}`,
    messageId: `m${messageIndex}`,
    messageIndex,
    title: `round ${messageIndex}`,
    preview: '',
    startsWithAgent: false,
    weight: 0,
    timestamp: undefined,
  });

  /** Row heights → cumulative offsets, the shape Virtua's `getItemOffset` has. */
  const offsetTable = (heights: readonly number[]): ((rowIndex: number) => number) => {
    const offsets: number[] = [];
    let total = 0;
    for (const height of heights) {
      offsets.push(total);
      total += height;
    }
    return (rowIndex) => offsets[rowIndex] ?? total;
  };

  describe('buildOutlineAnchors', () => {
    it('drops a round that produced no rows instead of leaving a hole', () => {
      // Reachable in production: `buildChatStreamItems` discards empty assistant
      // entries, so a round can consist of nothing renderable.
      const rows = [{ messageIndex: 0 }, { messageIndex: 4 }];
      const anchors = buildOutlineAnchors(rows, [entry(0), entry(2), entry(4)]);

      expect(anchors).toEqual<ConversationOutlineAnchor[]>([
        { outlineIndex: 0, rowIndex: 0 },
        { outlineIndex: 2, rowIndex: 1 },
      ]);
    });
  });

  describe('resolveActiveOutlineIndex', () => {
    const anchors: ConversationOutlineAnchor[] = [
      { outlineIndex: 0, rowIndex: 0 },
      { outlineIndex: 1, rowIndex: 2 },
      { outlineIndex: 2, rowIndex: 5 },
    ];
    // Seven 100px rows, so row N starts at N*100:
    // rows 0,1 → round 0 (0..200) | rows 2,3,4 → round 1 (200..500) | rows 5,6 → round 2 (500..)
    const getRowOffset = offsetTable([100, 100, 100, 100, 100, 100, 100]);

    it('keeps reporting a round after its anchor has scrolled above the viewport', () => {
      // The property that makes the rail usable during a long turn: highlighting
      // only an on-screen anchor would blank it for most of the scroll.
      expect(resolveActiveOutlineIndex(anchors, getRowOffset, 380)).toBe(1);
      expect(resolveActiveOutlineIndex(anchors, getRowOffset, 490)).toBe(1);
    });

    it('reports the outline index, not the anchor position, when rounds were dropped', () => {
      const sparse: ConversationOutlineAnchor[] = [
        { outlineIndex: 0, rowIndex: 0 },
        { outlineIndex: 7, rowIndex: 2 },
      ];

      expect(resolveActiveOutlineIndex(sparse, getRowOffset, 250)).toBe(7);
    });

    describe('at the end of the list', () => {
      // The final rounds are usually shorter than the viewport, so the scroll
      // clamps and the top edge still belongs to an earlier round.
      it('reports the last round even though an earlier one owns the top edge', () => {
        expect(resolveActiveOutlineIndex(anchors, getRowOffset, 380, true)).toBe(2);
      });
    });
  });
});

describe('conversation-outline-rail-geometry', () => {
  const RESTING = [...TICK_WIDTHS];
  const LIGHTEST = Math.min(...RESTING);
  const HEAVIEST = Math.max(...RESTING);

  /** The widths a run of ticks takes when the pointer sits on the middle one. */
  const profileAround = (restingWidths: readonly number[], hoveredIndex: number): number[] =>
    restingWidths.map((resting, index) => outlineTickWidth(resting, index - hoveredIndex));

  describe('outlineTickWidth', () => {
    it('makes the tick under the cursor the longest, whatever its neighbours weigh', () => {
      // The regression this exists for: while the bell was ADDED to each tick's
      // resting width, a heavy neighbour outgrew the tick being pointed at.
      const restingWidths = [HEAVIEST, HEAVIEST, HEAVIEST, LIGHTEST, HEAVIEST, HEAVIEST, HEAVIEST];
      const widths = profileAround(restingWidths, 3);
      const hovered = widths[3] ?? 0;

      for (const [index, width] of widths.entries()) {
        if (index === 3) continue;
        expect(width).toBeLessThan(hovered);
      }
    });

    it('falls off monotonically on both sides of the cursor', () => {
      // Uniform resting widths, because that is what isolates the bell. Across
      // MIXED weights the profile is deliberately not monotonic past the bell's
      // radius: the swell melts back into the rail's resting texture, and a heavy
      // round beyond the radius is simply long again.
      const restingWidths = Array.from({ length: 11 }, () => LIGHTEST);
      const widths = profileAround(restingWidths, 5);

      for (let index = 1; index <= 5; index += 1) {
        expect(widths[5 - index]).toBeLessThan(widths[5 - index + 1] ?? Infinity);
        expect(widths[5 + index]).toBeLessThan(widths[5 + index - 1] ?? Infinity);
      }
    });

    it('barely disturbs a tick at the edge of the radius', () => {
      // The fringe of the blend pulls a heavy tick very slightly toward the
      // bell's base. Keep that sub-pixel, or the rail visibly breathes far from
      // the cursor.
      for (const resting of RESTING) {
        expect(Math.abs(outlineTickWidth(resting, 4) - resting)).toBeLessThan(1);
      }
    });

    it('gives the cursor the same length regardless of the round’s weight', () => {
      // At the peak the bell fully replaces the resting width, so the tip of the
      // swell is stable as the pointer travels across rounds of different sizes.
      const peaks = RESTING.map((resting) => outlineTickWidth(resting, 0));
      for (const peak of peaks) {
        expect(peak).toBeCloseTo(peaks[0] ?? 0, 6);
      }
    });

    it('leaves ticks outside the radius at their resting width', () => {
      for (const resting of RESTING) {
        expect(outlineTickWidth(resting, 5)).toBe(resting);
        expect(outlineTickWidth(resting, 50)).toBe(resting);
      }
    });
  });

  describe('outlineTickWidthAt', () => {
    it('leaves every tick at rest while the pointer is off the rail', () => {
      for (const index of [0, 3, 40]) {
        expect(outlineTickWidthAt(HEAVIEST, index, -1)).toBe(HEAVIEST);
      }
    });
  });

  describe('rail track', () => {
    it('is wide enough for anything the rail can paint', () => {
      // The strip is an `overflow-y: auto` box, which makes the x axis `auto`
      // too — a magnified element wider than the track would scroll the rail
      // sideways rather than simply extending.
      for (const resting of RESTING) {
        for (const distance of [0, 1, 2, 3, 4, 9]) {
          const tick = outlineTickWidth(resting, distance);
          expect(tick).toBeLessThanOrEqual(RAIL_TRACK_WIDTH);
          expect(tick + ACTIVE_BAR_OVERHANG).toBeLessThanOrEqual(RAIL_TRACK_WIDTH);
        }
      }
      expect(ACTIVE_TICK_WIDTH).toBeLessThanOrEqual(RAIL_TRACK_WIDTH);
    });
  });

  describe('outlineTickRestingWidth', () => {
    it('grows with weight', () => {
      expect(outlineTickRestingWidth(0)).toBeLessThan(outlineTickRestingWidth(3));
    });
  });

  describe('rail edge fade length', () => {
    it('spans enough ticks for the taper to be visible', () => {
      // Two ticks was too subtle to read as "there is more here" on a rail this
      // low-contrast. The mask itself is the shared `buildScrollEdgeFadeMask`,
      // covered by `tests/scroll-edge-fade.test.ts`.
      expect(RAIL_EDGE_FADE_LENGTH).toBeGreaterThanOrEqual(TICK_PITCH * 5);
    });
  });
});
