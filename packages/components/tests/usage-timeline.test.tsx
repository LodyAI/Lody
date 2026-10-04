// @vitest-environment jsdom

import { renderToStaticMarkup } from 'react-dom/server';
import { act, useState } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

function timeline(range: SettingsUsageTimelineData['range']): SettingsUsageTimelineData {
  const hourly = range === 'day' || range === 'week';
  const startMs = Date.UTC(2026, 8, 30, hourly ? 16 : 0);
  const count = range === 'day' ? 24 : range === 'week' ? 168 : 8;
  const bucketSizeMs = hourly ? HOUR_MS : DAY_MS;
  return {
    workspaceId: 'synthetic-workspace',
    range,
    startMs,
    endMs: startMs + count * bucketSizeMs,
    bucketSizeMs,
    totals: { tokens: 500, costUSD: 0 },
    users: {},
    buckets: Array.from({ length: count }, (_, index) => ({
      bucketStartMs: startMs + index * bucketSizeMs,
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

class ControlledResizeObserver {
  static instances: ControlledResizeObserver[] = [];
  target: Element | null = null;
  connected = false;

  constructor(private readonly callback: ResizeObserverCallback) {
    ControlledResizeObserver.instances.push(this);
  }

  observe(target: Element) {
    this.target = target;
    this.connected = true;
  }

  unobserve() {}
  disconnect() {
    this.connected = false;
  }

  deliver() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function SelectionHarness({ data }: { data: SettingsUsageTimelineData }) {
  const [selected, setSelected] = useState<number | null>(null);
  return (
    <>
      <output>{selected === null ? 'closed' : selected}</output>
      <UsageCalendarVisualization
        calendar={{
          workspaceId: data.workspaceId,
          timezone: 'UTC',
          startMs: Date.UTC(2026, 8, 30),
          endMs: Date.UTC(2026, 9, 8),
          days: Array.from({ length: 8 }, (_, index) => ({
            dayStartMs: Date.UTC(2026, 8, 30) + index * DAY_MS,
            date: new Date(Date.UTC(2026, 8, 30) + index * DAY_MS).toISOString().slice(0, 10),
            tokens: 500,
            costUSD: 1,
            isFuture: false,
          })),
        }}
        timeline={data}
        dayDetail={
          selected === null
            ? undefined
            : {
                workspaceId: data.workspaceId,
                dayStartMs: selected,
                date: new Date(selected).toISOString().slice(0, 10),
                totals: {
                  tokens: 500,
                  costUSD: 1,
                  inputTokens: 500,
                  outputTokens: 0,
                  cacheReadInputTokens: 0,
                  cacheCreationInputTokens: 0,
                  reasoningOutputTokens: 0,
                  webSearchRequests: 0,
                },
                byModel: [],
                byUser: [],
                users: {},
              }
        }
        onSelectedDayChange={setSelected}
      />
    </>
  );
}

describe('usage day selection across ranges', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.stubGlobal('ResizeObserver', ControlledResizeObserver);
    ControlledResizeObserver.instances = [];
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  async function show(data: SettingsUsageTimelineData) {
    await act(async () => root.render(<SelectionHarness data={data} />));
  }

  async function selectCell(index: number, range?: 'day' | 'week') {
    const cells = [...container.querySelectorAll<HTMLButtonElement>('[role="gridcell"]')];
    const cell = cells.filter(
      (item) =>
        !range || (item.title.includes('UTC') && item.title.includes(' – ') === (range === 'day'))
    )[index]!;
    await act(async () => cell.click());
    return cell;
  }

  async function selectRangeCell(range: SettingsUsageTimelineData['range']) {
    if (range === 'day' || range === 'week') return selectCell(0, range);
    const cell = container.querySelector<HTMLButtonElement>(
      '[role="gridcell"][aria-label*="Sep 30, 2026"]'
    )!;
    expect(cell).not.toBeNull();
    await act(async () => cell.click());
    return cell;
  }

  function selectedObserver(cell: Element) {
    const observer = ControlledResizeObserver.instances.findLast((item) =>
      item.target?.contains(cell)
    );
    expect(observer).toBeDefined();
    return observer!;
  }

  function expectClosed() {
    expect(container.querySelector('output')!.textContent).toBe('closed');
  }

  it.each([
    ['week', 'day'],
    ['day', 'week'],
    ['week', 'month'],
    ['day', 'total'],
    ['month', 'day'],
    ['total', 'week'],
  ] as const)('keeps detail closed after %s → %s and an old resize callback', async (from, to) => {
    await show(timeline(from));
    const oldCell = await selectRangeCell(from);
    const observer = selectedObserver(oldCell);
    expect(container.querySelector('output')!.textContent).toBe(String(Date.UTC(2026, 8, 30)));
    await show(timeline(to));
    expectClosed();
    // Real AnimatePresence retains the old cell until its exit completes.
    expect(observer.target!.contains(oldCell)).toBe(true);
    if (from === 'month' || from === 'total') expect(observer.connected).toBe(true);
    if (from === 'month' || from === 'total') {
      await act(async () => oldCell.closest('[dir="rtl"]')!.dispatchEvent(new Event('scroll')));
      expectClosed();
    }
    await act(async () => observer.deliver());
    expectClosed();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expectClosed();
    const exitingDetail = container.querySelector(
      '[aria-label="workspace.usage.skyline.dayDetail"]'
    )!;
    expect(exitingDetail).not.toBeNull();
    await act(async () =>
      exitingDetail.dispatchEvent(new Event('transitionend', { bubbles: true }))
    );
    expect(container.querySelector('[aria-label="workspace.usage.skyline.dayDetail"]')).toBeNull();
    await selectRangeCell(to);
    expect(container.querySelector('output')!.textContent).toBe(String(Date.UTC(2026, 8, 30)));
    expect(
      container.querySelector('[aria-label="workspace.usage.skyline.dayDetail"] p')?.textContent
    ).toBe('Wed, Sep 30, 2026');
  });

  it.each(['day', 'month'] as const)(
    'moves the %s caret without changing the selected date',
    async (range) => {
      await show(timeline(range));
      const cell = await selectRangeCell(range);
      const observer = selectedObserver(cell);
      vi.spyOn(cell, 'getBoundingClientRect').mockReturnValue(new DOMRect(30, 0, 20, 8));
      await act(async () => observer.deliver());
      expect(container.querySelector('output')!.textContent).toBe(String(Date.UTC(2026, 8, 30)));
      const detail = container.querySelector('[aria-label="workspace.usage.skyline.dayDetail"]')!;
      expect((detail.previousElementSibling as HTMLElement).style.left).toBe('40px');
    }
  );

  it('retains a selected day across 30d ↔ All and rejects a callback for another day', async () => {
    await show(timeline('month'));
    const cell = await selectRangeCell('month');
    const observer = selectedObserver(cell);
    await show(timeline('total'));
    expect(container.querySelector('output')!.textContent).toBe(String(Date.UTC(2026, 8, 30)));
    await show(timeline('month'));
    expect(container.querySelector('output')!.textContent).toBe(String(Date.UTC(2026, 8, 30)));
    const other = container.querySelector<HTMLButtonElement>(
      '[role="gridcell"][aria-label*="Oct 1, 2026"]'
    )!;
    await act(async () => other.click());
    await act(async () => observer.deliver());
    expect(container.querySelector('output')!.textContent).toBe(String(Date.UTC(2026, 9, 1)));
    expect(
      container.querySelector('[aria-label="workspace.usage.skyline.dayDetail"] p')!.textContent
    ).toBe('Thu, Oct 1, 2026');
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="common.close"]')!.click()
    );
    await act(async () => selectedObserver(other).deliver());
    expectClosed();
  });
});
