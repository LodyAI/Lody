// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { WeekBento } from '../src/components/chat/home/week-bento';
import { initI18n } from '../src/i18n';
import { buildHomeWeek, homeWeekDayKey, type HomeWeekRow } from '../src/lib/home-week';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 9, 16, 10, 0, 0);
const at = (daysBack: number, hour = 12): number =>
  new Date(2026, 9, 16 - daysBack, hour).getTime();

function row(overrides: Partial<HomeWeekRow> = {}): HomeWeekRow {
  return {
    createdAt: at(1),
    lastAt: at(1),
    add: 0,
    del: 0,
    mergedPrs: 0,
    cliType: 'builtin',
    agentType: 'claude',
    repo: null,
    ...overrides,
  };
}

const label = (agent: { agentType: string }) => (agent.agentType === 'claude' ? 'Claude' : 'Codex');

describe('WeekBento', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = (rows: HomeWeekRow[], activeDays: string[] = []) => {
    act(() => {
      root.render(
        <WeekBento
          model={buildHomeWeek({ rows, activeDays }, NOW)}
          agentLabel={label}
          animate={false}
        />
      );
    });
  };
  const text = () => container.textContent ?? '';

  it('shows zeros, not an empty space, when the last seven days were quiet', () => {
    render([]);
    expect(container.querySelector('[data-testid="home-week"]')).not.toBeNull();
    expect(text()).toContain('Code shipped, last 7 days');
    expect(container.querySelector('[data-count="0"]')).not.toBeNull();
    expect(text()).toContain('–');
    expect(text()).not.toContain('vs the week before');
    // Fourteen weeks of five workdays, the last stopping today (a Friday): 13 full weeks and five days.
    expect(container.querySelectorAll('[data-level]')).toHaveLength(13 * 5 + 5);
    expect(container.querySelectorAll('[data-level]:not([data-level="0"])')).toHaveLength(0);
  });

  it('shows the code shipped with its comparison, and the other tiles', () => {
    render([
      row({ lastAt: at(1), add: 2000, del: 418, mergedPrs: 3, agentType: 'claude' }),
      row({ lastAt: at(8), add: 1000 }),
      row({ createdAt: at(2), agentType: 'codex' }),
    ]);
    expect(text()).toContain('Code shipped, last 7 days');
    expect(text()).toContain('2,418');
    // The number is its two parts: what was added and what was removed.
    expect(text()).toContain('+2,000added');
    expect(text()).toContain('−418removed');
    // 2,000 of 2,418 lines is four of the five diffstat squares; the rest are the removed share.
    expect(
      Array.from(container.querySelectorAll('[data-kind]')).map((square) =>
        square.getAttribute('data-kind')
      )
    ).toEqual(['added', 'added', 'added', 'added', 'removed']);
    expect(text()).toContain('↑ 142%');
    expect(text()).toContain('vs the week before');
    expect(text()).toContain('PRs merged');
    expect(container.querySelector('[data-count="3"]')).not.toBeNull();
    expect(text()).toContain('Claude 67%');
    expect(text()).toContain('Codex');
  });

  it('leaves the comparison out when there is nothing to compare', () => {
    render([row({ add: 10 })]);
    expect(text()).not.toContain('vs the week before');
  });

  it('names the most-used repository with its share', () => {
    render([
      row({ createdAt: at(1), repo: 'LodyAI/lody' }),
      row({ createdAt: at(1, 15), repo: 'LodyAI/lody' }),
      row({ createdAt: at(3), repo: 'LodyAI/site-docs' }),
    ]);
    expect(container.querySelector('[data-repo="LodyAI/lody"]')?.textContent).toBe('lody');
    expect(text()).toContain('67% of your sessions');
  });

  it('shows a dash where there is no repository or agent', () => {
    render([]);
    expect(container.querySelector('[data-repo]')).toBeNull();
    expect(text().match(/–/g)?.length).toBe(2);
  });

  it('shades the days that had activity on the wall and says what it shows', () => {
    render([], [homeWeekDayKey(at(1)), homeWeekDayKey(at(3))]);
    expect(container.querySelectorAll('[data-level="4"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-level="0"]')).toHaveLength(13 * 5 + 5 - 2);
    expect(
      container.querySelector('[role="img"][aria-label="Active workdays, last 14 weeks"]')
    ).not.toBeNull();
  });

  it('names a day and its activity over the cell under the pointer, and closes on leaving', async () => {
    const today = homeWeekDayKey(at(0));
    const wall = () => container.querySelector('[data-testid="home-week"] [role="img"]')!;
    const cell = (day: string) => container.querySelector<HTMLElement>(`[data-day="${day}"]`)!;
    const over = (element: Element) =>
      act(async () => {
        element.dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
      });
    render([], [today, homeWeekDayKey(at(1))]);
    // Nothing is shown until a cell is pointed at, and the whole wall no longer carries a title.
    expect(document.body.textContent).not.toContain('session event');
    expect(wall().getAttribute('title')).toBeNull();

    await over(cell(today));
    expect(document.body.textContent).toContain('Fri, Oct 16, 2026 · 1 session event');

    // Moving to a quiet day (Thursday 15 is active, Wednesday 14 is not) re-anchors the same tip.
    await over(cell(homeWeekDayKey(at(2))));
    expect(document.body.textContent).toContain('Wed, Oct 14, 2026 · No activity');
    expect(document.body.textContent).not.toContain('Fri, Oct 16, 2026');

    await act(async () => {
      wall().dispatchEvent(new MouseEvent('pointerout', { bubbles: true }));
      wall().dispatchEvent(new MouseEvent('pointerleave'));
    });
    expect(document.body.textContent).not.toContain('Wed, Oct 14, 2026');
  });

  it('shows singular and plural units', () => {
    render([row({ add: 1 })]);
    expect(text()).toContain('1line');
    render([row({ add: 2 })]);
    expect(text()).toContain('2lines');
  });
});
