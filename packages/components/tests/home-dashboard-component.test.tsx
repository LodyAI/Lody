// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { HomeDashboard } from '../src/components/chat/home/home-dashboard';
import { LandingStageContext, type LandingStage } from '../src/components/chat/landing-stage';
import { initI18n } from '../src/i18n';
import type { HomeBoard } from '../src/lib/home-board';
import { buildHomeNow, type HomeNowRow } from '../src/lib/home-now';
import { buildHomeWeek } from '../src/lib/home-week';
import type {
  HomeWeekForecast,
  HomeWeekUsage,
  HomeWeekUsageSource,
} from '../src/lib/home-week-usage';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const NOW = new Date(2026, 9, 16, 10, 0, 0);
const NOW_MS = NOW.getTime();
const MINUTE = 60_000;

function nowRow(id: string, overrides: Partial<HomeNowRow> = {}): HomeNowRow {
  return {
    id,
    title: `Session ${id}`,
    cliType: 'builtin',
    agentType: 'claude',
    lastAt: NOW_MS - 5 * MINUTE,
    working: false,
    waiting: false,
    unread: false,
    pr: null,
    ...overrides,
  };
}

const usage = (resetsInHours = 2): HomeWeekUsage => ({
  name: null,
  windows: [
    {
      usedPercent: 38,
      remainingPercent: 62,
      windowDurationSeconds: 5 * 60 * 60,
      resetsAtEpochSeconds: NOW_MS / 1000 + resetsInHours * 60 * 60,
    },
    {
      usedPercent: 21,
      remainingPercent: 79,
      windowDurationSeconds: 7 * 24 * 60 * 60,
      resetsAtEpochSeconds: null,
    },
  ],
});

const CODEX: HomeWeekUsageSource = {
  id: 'codex-work',
  cliType: 'builtin',
  agentType: 'codex',
  name: 'Codex (work)',
};
const CLAUDE: HomeWeekUsageSource = {
  id: 'claude-main',
  cliType: 'builtin',
  agentType: 'claude',
  name: 'Claude',
};

const label = (agent: { agentType: string }) => (agent.agentType === 'claude' ? 'Claude' : 'Codex');

describe('HomeDashboard', () => {
  let root: Root;
  let container: HTMLDivElement;
  let opened: string[];

  beforeEach(async () => {
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    opened = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
  });

  const render = (
    extra: {
      rows?: HomeNowRow[];
      board?: HomeBoard | null;
      defaultBoard?: HomeBoard | null;
      usage?: HomeWeekUsage | null;
      usageSources?: HomeWeekUsageSource[];
      usageSourceId?: string | null;
      onUsageSourceChange?: (id: string) => void;
      forecast?: HomeWeekForecast | null;
      onBoardChange?: (board: HomeBoard | null) => void;
      /** A landing stage of this many pixels, the rest of its group taking `rest`. */
      stage?: { height: number; rest: number };
    } = {}
  ) => {
    const { rows = [], stage, ...rest } = extra;
    const dashboard = (
      <HomeDashboard
        now={buildHomeNow({ rows }, NOW_MS)}
        week={buildHomeWeek({ rows: [], activeDays: [] }, NOW)}
        agentLabel={label}
        nowMs={NOW_MS}
        onOpenSession={(id) => opened.push(id)}
        animate={false}
        {...rest}
      />
    );
    act(() => {
      root.render(
        stage ? (
          <LandingStageContext.Provider value={landingStage(stage.height, stage.rest)}>
            {dashboard}
          </LandingStageContext.Provider>
        ) : (
          dashboard
        )
      );
    });
  };
  /** jsdom lays nothing out: a stage and group that report the given sizes. */
  const landingStage = (height: number, groupHeight: number): LandingStage => {
    const stage = document.createElement('div');
    const group = document.createElement('div');
    Object.defineProperty(stage, 'clientHeight', { value: height });
    Object.defineProperty(group, 'offsetHeight', { value: groupHeight });
    return { stage, group };
  };
  const q = (selector: string) => container.querySelector<HTMLElement>(selector);
  const byTestId = (id: string) => q(`[data-testid="${id}"]`);
  const click = (element: HTMLElement) =>
    act(() => {
      element.click();
    });

  describe('now', () => {
    it('sorts sessions into what needs you, what runs, what finished and what to continue', () => {
      render({
        rows: [
          nowRow('wait', { waiting: true }),
          nowRow('ci', { pr: { number: 812, status: 'open', ci: 'fail', ready: false } }),
          nowRow('run', { working: true }),
          nowRow('done', { unread: true }),
          nowRow('ready', { pr: { number: 799, status: 'open', ci: 'pass', ready: true } }),
        ],
      });
      const attention = byTestId('home-now-attention')!;
      expect(attention.textContent).toContain('Needs you');
      expect(attention.textContent).toContain('Session waitNeeds your reply');
      expect(attention.textContent).toContain('Session ciCI failed · #812');
      expect(byTestId('home-now-running')?.textContent).toContain('Session run');
      expect(byTestId('home-now-finished')?.textContent).toContain('Session done');
      expect(byTestId('home-now-next')?.textContent).toContain(
        'Session readyReady to merge · #799'
      );
    });

    it('opens the session a row names', () => {
      render({ rows: [nowRow('wait', { waiting: true })] });
      click(q('[data-session="wait"]')!);
      expect(opened).toEqual(['wait']);
    });

    it('leaves an empty list out, and opens the whole of a long one over the board', () => {
      render({
        rows: Array.from({ length: 5 }, (_, index) =>
          nowRow(`run-${index}`, { working: true, lastAt: NOW_MS - index * MINUTE })
        ),
      });
      expect(byTestId('home-now-attention')).toBeNull();
      expect(byTestId('home-now-quiet')).toBeNull();
      // Alone and without a plan to sit beside, it takes the whole board.
      const running = q('[data-now-column="whole"] [data-testid="home-now-running"]')!;
      expect(running.querySelectorAll('[data-session]')).toHaveLength(4);
      const toggle = byTestId('home-now-running-toggle')!;
      expect(toggle.textContent).toBe('Show all 5');

      // The list takes the board's box; the board under it is out of reach until it closes.
      click(toggle);
      const all = byTestId('home-now-running-all')!;
      expect(all.querySelectorAll('[data-session]')).toHaveLength(5);
      expect(byTestId('home-now')?.getAttribute('data-focus')).toBe('running');
      expect(running.closest('[inert]')).not.toBeNull();
      expect(document.activeElement).toBe(byTestId('home-now-back'));

      // Back returns to the board and to the "Show all" that opened it.
      click(byTestId('home-now-back')!);
      expect(byTestId('home-now-running-all')).toBeNull();
      expect(running.closest('[inert]')).toBeNull();
      expect(document.activeElement).toBe(byTestId('home-now-running-toggle'));

      // Escape closes it too; a row opens its session.
      click(byTestId('home-now-running-toggle')!);
      act(() => {
        byTestId('home-now-running-all')!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
        );
      });
      expect(byTestId('home-now-running-all')).toBeNull();
      click(byTestId('home-now-running-toggle')!);
      click(q('[data-session="run-4"]')!);
      expect(opened).toEqual(['run-4']);
    });

    it('opens the whole list from the tile itself, a row still opening its session', () => {
      render({
        rows: Array.from({ length: 5 }, (_, index) =>
          nowRow(`run-${index}`, { working: true, lastAt: NOW_MS - index * MINUTE })
        ),
      });
      const tile = byTestId('home-now-running')!;

      // Pressing the tile does what its "Show all" does.
      click(tile);
      expect(byTestId('home-now-running-all')).not.toBeNull();
      expect(byTestId('home-now')?.getAttribute('data-focus')).toBe('running');
      click(byTestId('home-now-back')!);
      expect(byTestId('home-now-running-all')).toBeNull();

      // Back at the board, a row pressed in the tile opens the session, not the list.
      click(q('[data-session="run-2"]')!);
      expect(opened).toEqual(['run-2']);
      expect(byTestId('home-now-running-all')).toBeNull();
    });

    it('leaves a tile that shows everything alone under a press', () => {
      render({ rows: [nowRow('run', { working: true })] });
      click(byTestId('home-now-running')!);
      expect(byTestId('home-now-running-all')).toBeNull();
    });

    it('fits a short window, and folds into the line when even one row each does not fit', () => {
      const boards: (HomeBoard | null)[] = [];
      const rows = [
        ...Array.from({ length: 9 }, (_, index) => nowRow(`wait-${index}`, { waiting: true })),
        ...Array.from({ length: 6 }, (_, index) => nowRow(`run-${index}`, { working: true })),
      ];
      // Plenty of room: the whole budget.
      render({ rows, defaultBoard: 'now', stage: { height: 2000, rest: 100 } });
      expect(byTestId('home-now-attention')?.querySelectorAll('[data-session]')).toHaveLength(6);

      // Room for six rows a column (182px of board): needs you keeps three rows with its
      // "Show all", and running, levelled beside it, shows three as well.
      render({ rows, defaultBoard: 'now', stage: { height: 340, rest: 100 } });
      expect(byTestId('home-now-attention')?.querySelectorAll('[data-session]')).toHaveLength(3);
      expect(byTestId('home-now-running')?.querySelectorAll('[data-session]')).toHaveLength(3);
      expect(byTestId('home-dashboard')?.hasAttribute('data-auto-folded')).toBe(false);

      // No room: folded into the line, without forgetting that now was open.
      render({
        rows,
        defaultBoard: 'now',
        stage: { height: 160, rest: 100 },
        onBoardChange: (board) => boards.push(board),
      });
      expect(byTestId('home-now')).toBeNull();
      expect(byTestId('home-dashboard')?.hasAttribute('data-auto-folded')).toBe(true);
      expect(byTestId('home-now-summary')?.textContent).toBe('Needs you9Running6');
      expect(boards).toEqual([]);

      // Asked for from the line, it shows anyway.
      click(q('[data-segment="now"]')!);
      expect(byTestId('home-now')).not.toBeNull();
      expect(boards).toEqual(['now']);
    });

    it('is one calm tile, not four empty ones, when nothing is going on', () => {
      render({ usage: usage() });
      expect(byTestId('home-now-quiet')?.textContent).toBe(
        'All quietNothing is running or waiting on you.'
      );
      expect(q('[data-now-column="left"] [data-testid="home-now-quiet"]')).not.toBeNull();
      expect(q('[data-now-column="right"] [data-testid="home-week-usage"]')).not.toBeNull();
      expect(container.querySelectorAll('[data-testid="home-now"] [data-session]')).toHaveLength(0);
    });
  });

  describe('plan usage', () => {
    const text = () => byTestId('home-now')?.textContent ?? '';

    it('shows one window, the shortest, with how much is used and when it resets', () => {
      render({ usage: usage(2) });
      expect(text()).toContain('Plan usage');
      expect(text()).toContain('5 hours');
      expect(text()).toContain('38% used');
      expect(text()).toContain('Resets in about 2 hours');
      expect(text()).not.toContain('Weekly');
      expect(container.querySelectorAll('[data-usage-fill]')).toHaveLength(1);
      expect(byTestId('home-week-forecast')).toBeNull();
      expect(byTestId('home-week-usage')?.getAttribute('data-column')).toBe('1 / span 2');
    });

    it('names the tier the provider named', () => {
      render({ usage: { ...usage(), name: 'GPT-5.3-Codex-Spark' } });
      expect(text()).toContain('Plan usage · GPT-5.3-Codex-Spark');
    });

    it('gives a known Codex reset a tile of its own beside the usage', () => {
      render({
        usage: usage(),
        forecast: { title: 'Codex reset forecast', chancePercent: 65, when: 'Today 2:00 PM' },
      });
      const forecast = byTestId('home-week-forecast')!;
      expect(forecast.textContent).toBe('Codex reset forecast65%chanceToday 2:00 PM');
      expect(byTestId('home-week-usage')?.contains(forecast)).toBe(false);
      expect(byTestId('home-week-usage')?.getAttribute('data-column')).toBe('1');
      const source = byTestId('home-week-forecast-source')!;
      expect(source.tagName).toBe('BUTTON');
      expect(source.getAttribute('aria-label')).toContain('codex-resets.com');
    });

    it('words a scheduled reset without a probability', () => {
      render({
        usage: usage(),
        forecast: { title: 'Codex reset scheduled', chancePercent: null, when: 'Today 2:00 PM' },
      });
      expect(byTestId('home-week-forecast')?.textContent).toBe(
        'Codex reset scheduledToday 2:00 PM'
      );
    });

    it('says whose plan it is, in a control that opens a list when there are several', () => {
      render({ usage: usage(), usageSources: [CODEX, CLAUDE], usageSourceId: CODEX.id });
      // Without a handler the control cannot change anything, so it stays a plain outline.
      expect(byTestId('home-week-usage-source')?.tagName).toBe('SPAN');
      render({
        usage: usage(),
        usageSources: [CODEX, CLAUDE],
        usageSourceId: CLAUDE.id,
        onUsageSourceChange: () => undefined,
      });
      const trigger = byTestId('home-week-usage-source')!;
      expect(trigger.tagName).toBe('BUTTON');
      expect(trigger.textContent).toBe('Claude');
      expect(trigger.getAttribute('aria-haspopup')).toBe('menu');
    });
  });

  describe('the line', () => {
    const segment = (id: HomeBoard) => q(`[data-segment="${id}"]`)!;
    const fold = () => byTestId('home-dashboard-fold')!;

    it('opens on now, with the week waiting as its summary', () => {
      render({ rows: [nowRow('run', { working: true })], defaultBoard: 'now' });
      expect(byTestId('home-now')).not.toBeNull();
      expect(byTestId('home-week')).toBeNull();
      expect(segment('now').getAttribute('aria-expanded')).toBe('true');
      expect(byTestId('home-now-summary')).toBeNull();
      expect(segment('week').contains(byTestId('home-week-summary'))).toBe(true);
    });

    it('swaps the boards from the other segment, and folds the open one into the line', () => {
      render({ rows: [nowRow('wait', { waiting: true }), nowRow('run', { working: true })] });
      click(segment('week'));
      expect(byTestId('home-now')).toBeNull();
      expect(byTestId('home-week')).not.toBeNull();
      // Now lives on as its summary: one thing needs you, one agent runs.
      expect(byTestId('home-now-summary')?.textContent).toBe('Needs you1Running1');

      click(segment('week'));
      expect(byTestId('home-week')).toBeNull();
      expect(byTestId('home-dashboard-line')?.hasAttribute('data-alone')).toBe(true);
      expect(fold().getAttribute('aria-label')).toBe('Unfold');

      // The control at the end brings back the board that was open last.
      click(fold());
      expect(byTestId('home-week')).not.toBeNull();
      expect(byTestId('home-dashboard-line')?.hasAttribute('data-alone')).toBe(false);
    });

    it('folds on Escape from wherever the focus sits', () => {
      const boards: (HomeBoard | null)[] = [];
      render({
        rows: [nowRow('run', { working: true })],
        defaultBoard: 'week',
        onBoardChange: (board) => boards.push(board),
      });
      expect(byTestId('home-week')).not.toBeNull();
      const press = (from: EventTarget) =>
        act(() => {
          from.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
        });

      // From nowhere in particular: the board is the page's one transient surface.
      press(window);
      expect(byTestId('home-week')).toBeNull();
      expect(boards).toEqual([null]);

      // Focus on the line stays on the line: the fold and its ring do not move.
      click(fold());
      expect(byTestId('home-week')).not.toBeNull();
      act(() => {
        segment('week').focus();
      });
      press(segment('week'));
      expect(byTestId('home-week')).toBeNull();
      expect(boards).toEqual([null, 'week', null]);
      expect(document.activeElement).toBe(segment('week'));

      // A focused "now" row leaves with the board; the fold control takes the focus.
      click(fold());
      click(segment('now'));
      const row = q('[data-session="run"]')!;
      act(() => {
        row.focus();
      });
      press(row);
      expect(byTestId('home-now')).toBeNull();
      expect(boards).toEqual([null, 'week', null, 'week', 'now', null]);
      expect(document.activeElement).toBe(fold());

      // A text field keeps its Escape.
      click(fold());
      const field = document.createElement('textarea');
      byTestId('home-dashboard')!.appendChild(field);
      press(field);
      expect(byTestId('home-now')).not.toBeNull();
      expect(boards).toEqual([null, 'week', null, 'week', 'now', null, 'now']);
      field.remove();
    });

    it('says all is quiet when nothing is going on', () => {
      render({ defaultBoard: null });
      expect(byTestId('home-now-summary')?.textContent).toBe('All quiet');
    });

    it('shows the board it is given when controlled', () => {
      render({ board: 'week' });
      expect(byTestId('home-week')).not.toBeNull();
      render({ board: null });
      expect(byTestId('home-week')).toBeNull();
      expect(byTestId('home-now')).toBeNull();
    });
  });
});
