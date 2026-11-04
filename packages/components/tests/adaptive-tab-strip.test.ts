import { describe, expect, it } from 'vitest';

import {
  ACTIVE_TAB_MIN_WIDTH,
  allocateAdaptiveTabStripLayout,
  type AdaptiveTabStripLayout,
} from '../src/components/sessions/adaptive-tab-strip';

const DEFAULT_OPTIONS = {
  gap: 6,
  paddingLeft: 4,
  paddingRight: 8,
  activeMinWidth: ACTIVE_TAB_MIN_WIDTH,
} as const;

function allocatedWidth(layout: AdaptiveTabStripLayout): number {
  return (
    layout.paddingLeft +
    layout.paddingRight +
    layout.items.reduce((total, item) => total + item.width + item.marginRight, 0)
  );
}

describe('allocateAdaptiveTabStripLayout', () => {
  it('evenly divides all tabs when every tab can be at least the minimum width', () => {
    const layout = allocateAdaptiveTabStripLayout({
      ...DEFAULT_OPTIONS,
      viewportWidth: 1000,
      itemIds: ['parent', 'one', 'two', 'three'],
      activeItemId: 'two',
    });

    const widths = layout.items.map((item) => item.width);

    expect(allocatedWidth(layout)).toBe(1000);
    expect(widths.every((width) => width >= ACTIVE_TAB_MIN_WIDTH)).toBe(true);
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThanOrEqual(1);
  });

  it('keeps the active minimum width in a narrow multi-tab viewport', () => {
    const layout = allocateAdaptiveTabStripLayout({
      ...DEFAULT_OPTIONS,
      viewportWidth: 280,
      itemIds: ['parent', 'one', 'two', 'three'],
      activeItemId: 'one',
    });

    const active = layout.items.find((item) => item.id === 'one')!;
    const inactiveWidths = layout.items
      .filter((item) => item.id !== 'one')
      .map((item) => item.width);

    expect(allocatedWidth(layout)).toBe(280);
    expect(active.width).toBe(ACTIVE_TAB_MIN_WIDTH);
    expect(inactiveWidths.every((width) => active.width > width)).toBe(true);
    expect(inactiveWidths.every((width) => width > 0)).toBe(true);
    expect(Math.max(...inactiveWidths) - Math.min(...inactiveWidths)).toBeLessThanOrEqual(1);
  });
});
