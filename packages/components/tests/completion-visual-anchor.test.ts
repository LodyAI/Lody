// @vitest-environment jsdom

import { describe, expect, it } from 'vitest';
import {
  captureCompletionVisualAnchor,
  resolveCompletionAnchorAdjustment,
  resolveCompletionContractionMessageId,
} from '../src/components/ai-gui/completion-visual-anchor';

describe('completion visual anchor', () => {
  it('protects both presence-first and finished-first contractions', () => {
    const working = { messageId: 'turn-a', finished: false, activityVisible: true };
    const activityRetired = { ...working, activityVisible: false };
    const finishedWithActivity = { ...working, finished: true };

    expect(resolveCompletionContractionMessageId(working, activityRetired)).toBe('turn-a');
    expect(
      resolveCompletionContractionMessageId(activityRetired, {
        ...activityRetired,
        finished: true,
      })
    ).toBe('turn-a');
    expect(resolveCompletionContractionMessageId(working, finishedWithActivity)).toBe('turn-a');
    expect(
      resolveCompletionContractionMessageId(finishedWithActivity, {
        ...finishedWithActivity,
        activityVisible: false,
      })
    ).toBe('turn-a');
    expect(
      resolveCompletionContractionMessageId(working, {
        messageId: 'turn-b',
        finished: true,
        activityVisible: false,
      })
    ).toBeNull();
  });

  it('anchors the nearest visible mounted row that survives folding', () => {
    const viewport = document.createElement('div');
    Object.defineProperties(viewport, {
      scrollTop: { configurable: true, value: 640 },
      scrollHeight: { configurable: true, value: 1_800 },
    });
    viewport.getBoundingClientRect = () =>
      ({ top: 100, bottom: 500, left: 0, right: 400, width: 400, height: 400 }) as DOMRect;
    const addRow = (key: string, top: number, bottom: number) => {
      const row = document.createElement('div');
      row.dataset.chatVirtualRowKey = key;
      row.getBoundingClientRect = () =>
        ({ top, bottom, left: 0, right: 400, width: 400, height: bottom - top }) as DOMRect;
      viewport.appendChild(row);
    };
    addRow('removed-tool', 108, 160);
    addRow('surviving-answer', 180, 260);
    addRow('later-footer', 320, 360);

    expect(
      captureCompletionVisualAnchor(
        viewport,
        'turn-a',
        new Set(['surviving-answer', 'later-footer'])
      )
    ).toEqual({
      messageId: 'turn-a',
      rowKey: 'surviving-answer',
      viewportOffset: 80,
      scrollTop: 640,
      provisionalSpacerHeight: 1_800,
    });
  });

  it('compensates the anchor and keeps the follow tolerance released', () => {
    expect(
      resolveCompletionAnchorAdjustment({
        currentScrollTop: 1_000,
        oldAnchorOffset: 140,
        newAnchorOffset: -260,
        viewportHeight: 400,
        scrollHeightWithSpacer: 2_900,
        provisionalSpacerHeight: 2_000,
      })
    ).toEqual({ scrollTop: 600, spacerHeight: 171 });

    expect(
      resolveCompletionAnchorAdjustment({
        currentScrollTop: 1_000,
        oldAnchorOffset: null,
        newAnchorOffset: null,
        viewportHeight: 400,
        scrollHeightWithSpacer: 2_900,
        provisionalSpacerHeight: 2_000,
      })
    ).toEqual({ scrollTop: 1_000, spacerHeight: 571 });
  });
});
