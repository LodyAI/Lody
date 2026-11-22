import { describe, expect, it } from 'vitest';
import type { TodayDate } from '@lody/shared';
import {
  buildDayStream,
  localTodayDate,
  msUntilNextLocalMidnight,
} from '../src/components/today/today-stream';

const d = (value: string) => value as TodayDate;

describe('Today day stream', () => {
  it('puts today on top even when empty, then earlier registered days, skipping emptied ones', () => {
    expect(
      buildDayStream({
        today: d('2026-11-20'),
        registered: [d('2026-11-21'), d('2026-11-18'), d('2026-11-15'), d('2026-11-10')],
        empty: new Set([d('2026-11-15')]),
      })
    ).toEqual(['2026-11-20', '2026-11-18', '2026-11-10']);
  });

  it('keeps future days out unless the calendar anchors the stream there', () => {
    expect(
      buildDayStream({
        today: d('2026-11-20'),
        anchor: d('2026-11-25'),
        registered: [d('2026-11-21'), d('2026-11-18')],
        empty: new Set(),
      })
    ).toEqual(['2026-11-25', '2026-11-21', '2026-11-18']);
  });

  it('shows an anchored empty past day on top, followed by earlier days', () => {
    expect(
      buildDayStream({
        today: d('2026-11-20'),
        anchor: d('2026-11-12'),
        registered: [d('2026-11-18'), d('2026-11-10')],
        empty: new Set(),
      })
    ).toEqual(['2026-11-12', '2026-11-10']);
  });

  it('uses the local calendar day and schedules the rollover at local midnight', () => {
    const now = new Date(2026, 10, 20, 23, 59, 30);
    expect(localTodayDate(now)).toBe('2026-11-20');
    expect(msUntilNextLocalMidnight(now)).toBe(30_000);
  });
});

describe('Today route search', () => {
  it('keeps a day or node focus and drops anything else', async () => {
    const { validateTodaySearch } = await import('../src/components/today/today-stream');
    expect(validateTodaySearch({ date: '2026-11-21', focus: 'day' })).toEqual({
      date: '2026-11-21',
      focus: 'day',
    });
    expect(validateTodaySearch({ focus: '12@3456' })).toEqual({ focus: '12@3456' });
    expect(validateTodaySearch({ focus: '<script>' })).toEqual({});
  });
});

describe('Today route while pinned', () => {
  it('hands the link to the pinned column, but shows the page where the column cannot appear', async () => {
    const { todayRouteOutcome } = await import('../src/components/today/today-stream');
    expect(todayRouteOutcome({ enabled: false, pinned: false, compact: false })).toBe('redirect');
    expect(todayRouteOutcome({ enabled: true, pinned: true, compact: false })).toBe('to-column');
    expect(todayRouteOutcome({ enabled: true, pinned: true, compact: true })).toBe('page');
    expect(todayRouteOutcome({ enabled: true, pinned: false, compact: false })).toBe('page');
  });
});

describe('Today date heading', () => {
  it('formats in the product language, including zh_CN, without throwing', async () => {
    const { formatTodayHeading } = await import('../src/components/today/today-stream');
    const today = '2026-11-20' as never;
    expect(formatTodayHeading('2026-11-21' as never, today, 'zh_CN')).toEqual({
      date: '11月21日',
      meta: '星期六',
      isToday: false,
    });
    expect(formatTodayHeading(today, today, 'en')).toEqual({
      date: 'November 20',
      meta: 'Friday, November 20',
      isToday: true,
    });
  });
});
