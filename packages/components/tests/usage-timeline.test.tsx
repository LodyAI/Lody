// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { UsageCalendarVisualization } from '../src/components/settings/usage-calendar-visualization';
import type { SettingsUsageTimelineData } from '../src/components/settings/settings-data-cache';
import {
  createUsageTimelineFormatter,
  formatUsageTimelineBucketLabel,
} from '../src/components/settings/usage-timeline-bucket-label';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

function timeline(range: 'day' | 'week'): SettingsUsageTimelineData {
  const startMs = Date.UTC(2026, 8, 30, 16);
  const count = range === 'day' ? 24 : 168;
  return {
    workspaceId: 'synthetic-workspace',
    range,
    startMs,
    endMs: startMs + count * HOUR_MS,
    bucketSizeMs: HOUR_MS,
    totals: { tokens: 500, costUSD: 0 },
    users: {},
    buckets: Array.from({ length: count }, (_, index) => ({
      bucketStartMs: startMs + index * HOUR_MS,
      bucketLabel: 'untrusted display label',
      tokens: index === count - 1 ? 500 : 0,
      costUSD: 0,
      byModel: [{ modelId: 'synthetic-model', tokens: index === count - 1 ? 500 : 0, costUSD: 0 }],
      byUser: [{ userId: 'synthetic-member', tokens: index === count - 1 ? 500 : 0, costUSD: 0 }],
    })),
  };
}

function render(data: SettingsUsageTimelineData): HTMLDivElement {
  const firstDay = Math.floor(data.startMs / DAY_MS) * DAY_MS;
  const container = document.createElement('div');
  container.innerHTML = renderToStaticMarkup(
    <UsageCalendarVisualization
      timeline={data}
      calendar={{
        workspaceId: data.workspaceId,
        timezone: 'UTC',
        startMs: firstDay,
        endMs: data.endMs,
        days: Array.from({ length: 8 }, (_, index) => ({
          dayStartMs: firstDay + index * DAY_MS,
          date: new Date(firstDay + index * DAY_MS).toISOString().slice(0, 10),
          tokens: 0,
          costUSD: 0,
          isFuture: false,
        })),
      }}
    />
  );
  return container;
}

describe('usage timeline presentation', () => {
  it('renders the actual UTC window and bucket-aligned skyline axis', () => {
    const data = timeline('day');
    const container = render(data);
    const cells = [...container.querySelectorAll<HTMLButtonElement>('[role="gridcell"]')];
    expect(cells).toHaveLength(24);
    expect(container.querySelector('[title="Sep 30, 16:00 – Oct 1, 16:00 UTC"]')).not.toBeNull();
    const axis = cells[0]!.closest('[role="row"]')!.nextElementSibling!.nextElementSibling!;
    expect([...axis.children].map((cell) => cell.textContent).filter(Boolean)).toEqual([
      '16',
      '19',
      '22',
      '01',
      '04',
      '07',
      '10',
      '13',
    ]);
    const peak = cells[23]!;
    expect(peak.querySelector('span')!.style.height).toBe('100%');
    expect(peak.title).toBe('Oct 1, 15:00 – Oct 1, 16:00 UTC · 500');
    const splitLabel = formatUsageTimelineBucketLabel(
      data,
      data.buckets[23]!,
      createUsageTimelineFormatter('en')
    );
    expect(splitLabel).toBe('Oct 1, 15:00 UTC');
    expect(container.textContent).toContain(splitLabel);
  });

  it('renders all eight UTC dates touched by a rolling seven-day window', () => {
    const data = timeline('week');
    const container = render(data);
    const peak = container.querySelector<HTMLButtonElement>('[title="Oct 7, 15:00 UTC · 500"]');
    expect(peak).not.toBeNull();
    expect(container.querySelectorAll('[role="row"]')).toHaveLength(8);
    expect(container.textContent).toContain('Sep 30, 16:00 – Oct 7, 16:00 UTC');
  });
});
