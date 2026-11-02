// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  HOME_BOARD_HANG_SHARE,
  HOME_BOARD_MAX_TILT,
  HOME_FOLDED_LIFT,
  HomeDashboard,
} from '../src/components/chat/home/home-dashboard';
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
/** The board's height, as jsdom reports it: the dashboard measures it for the slot it holds. */
const BOARD_HEIGHT_PX = 120;

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
    // The opened list scrolls in a `ScrollArea`; jsdom has no ResizeObserver.
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    // jsdom has no layout, so the board's height — which the dashboard measures for the
    // slot it holds — is a fixed number here.
    vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockImplementation(
      function (this: HTMLElement) {
        return this.dataset?.testid === 'home-dashboard-board' ? BOARD_HEIGHT_PX : 0;
      }
    );
    await initI18n('en');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    opened = [];
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
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
  /**
   * jsdom lays nothing out: a stage and group that report the given sizes. Like a real group,
   * it is shorter by what the dashboard hangs below it (its negative bottom margin).
   */
  const landingStage = (height: number, groupHeight: number): LandingStage => {
    const stage = document.createElement('div');
    const group = document.createElement('div');
    Object.defineProperty(stage, 'clientHeight', { value: height });
    Object.defineProperty(group, 'offsetHeight', {
      get: () => {
        const hang = Number.parseFloat(byTestId('home-dashboard')?.style.marginBottom ?? '');
        return groupHeight + (Number.isFinite(hang) ? hang : 0);
      },
    });
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

    it('keeps an empty list in its place, and opens a long one from where it goes on', () => {
      render({
        rows: Array.from({ length: 6 }, (_, index) =>
          nowRow(`run-${index}`, { working: true, lastAt: NOW_MS - index * MINUTE })
        ),
      });
      // Needs you has nothing, and is still its title at the top of the left column.
      const attention = q('[data-now-column="left"] [data-testid="home-now-attention"]')!;
      expect(attention.textContent).toBe('Needs you0');
      expect(attention.querySelectorAll('[data-session]')).toHaveLength(0);
      const running = q('[data-now-column="right"] [data-testid="home-now-running"]')!;
      expect(running.querySelectorAll('[data-session]')).toHaveLength(4);
      // "Show all" under the last row: an action, not a session.
      const toggle = byTestId('home-now-running-toggle')!;
      expect(toggle.textContent).toBe('Show all 6');
      expect(toggle.hasAttribute('data-session')).toBe(false);

      // The list opens over its own column only; that column's tiles are out of reach until it
      // closes, and the other column stays as it was. The way back is at its foot.
      click(toggle);
      const all = byTestId('home-now-running-all')!;
      expect(all.querySelectorAll('[data-session]')).toHaveLength(6);
      expect(byTestId('home-now')?.getAttribute('data-focus')).toBe('running');
      expect(q('[data-now-column="right"]')?.contains(all)).toBe(true);
      expect(running.closest('[inert]')).not.toBeNull();
      expect(attention.closest('[inert]')).toBeNull();
      const back = byTestId('home-now-back')!;
      expect(document.activeElement).toBe(back);
      expect(back.textContent).toBe('Show less');
      expect(all.lastElementChild?.contains(back)).toBe(true);

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
        rows: Array.from({ length: 6 }, (_, index) =>
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

      // Room for six rows a column (182px of board): needs you keeps one row and its "Show all"
      // over just finished's title, and running, in the other column, the same.
      render({ rows, defaultBoard: 'now', stage: { height: 340, rest: 100 } });
      expect(byTestId('home-now-attention')?.querySelectorAll('[data-session]')).toHaveLength(1);
      expect(byTestId('home-now-running')?.querySelectorAll('[data-session]')).toHaveLength(1);
      expect(byTestId('home-now-running-toggle')).not.toBeNull();
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
      expect(byTestId('home-now-summary')?.textContent).toBe('Needs you9Running6Just finished0');
      expect(boards).toEqual([]);

      // Asked for from the line, it shows anyway.
      click(q('[data-segment="now"]')!);
      expect(byTestId('home-now')).not.toBeNull();
      expect(boards).toEqual(['now']);
    });

    it('keeps breathing room below a busy board in a compact landing', () => {
      render({
        rows: [
          ...Array.from({ length: 14 }, (_, index) => nowRow(`wait-${index}`, { waiting: true })),
          ...Array.from({ length: 6 }, (_, index) => nowRow(`run-${index}`, { working: true })),
          ...Array.from({ length: 5 }, (_, index) => nowRow(`done-${index}`, { unread: true })),
          ...Array.from({ length: 11 }, (_, index) =>
            nowRow(`ready-${index}`, {
              pr: { number: 700 + index, status: 'open', ci: 'pass', ready: true },
            })
          ),
        ],
        usage: usage(),
        // Mirrors the 620px Storybook landing: a 492px stage with 60px used by the heading.
        stage: { height: 492, rest: 60 },
      });

      expect(byTestId('home-now-attention')?.querySelectorAll('[data-session]')).toHaveLength(5);
      expect(byTestId('home-now-running')?.querySelectorAll('[data-session]')).toHaveLength(1);
      expect(byTestId('home-now-finished')?.querySelectorAll('[data-session]')).toHaveLength(1);
      expect(byTestId('home-now-next')?.querySelectorAll('[data-session]')).toHaveLength(1);
      expect(byTestId('home-dashboard')?.hasAttribute('data-auto-folded')).toBe(false);
    });

    it('puts one quiet card beside the usage when nothing is going on', () => {
      render({ usage: usage() });
      const quiet = byTestId('home-now-quiet');
      const usageTile = byTestId('home-week-usage');
      expect(quiet).not.toBeNull();
      expect(quiet?.textContent).toContain('All quiet');
      expect(quiet?.textContent).toContain('Nothing is running or waiting on you.');
      // The lists take their places back the moment anything is happening.
      const left = q('[data-now-column="left"]')!;
      const right = q('[data-now-column="right"]')!;
      expect(left.contains(quiet)).toBe(true);
      expect(right.contains(usageTile)).toBe(true);
      expect(left.textContent).toContain('All quiet');
      expect(right.textContent).toContain('Plan usage');
      expect(container.querySelectorAll('[data-testid="home-now"] [data-session]')).toHaveLength(0);

      render({ usage: usage(), rows: [nowRow('a', { working: true })] });
      expect(byTestId('home-now-quiet')).toBeNull();
      expect(q('[data-now-column="left"]')?.textContent).toContain('Needs you');
    });

    it('holds the board at its own height, hung a little low but in balance; folded, high', () => {
      const section = () => byTestId('home-dashboard')!;
      const slotPx = () => Number.parseFloat(byTestId('home-dashboard-slot')!.style.minHeight);
      const hang = () => -Number.parseFloat(section().style.marginBottom || '0');
      // The stage centres the group's box (the rest, the line, the board's gap and slot, less
      // what hangs); the space under the board is the space above the heading less the hang.
      const gaps = (stage: number) => {
        const box = 100 + 28 + slotPx() + 6 - hang();
        const above = (stage - box) / 2;
        return { above, below: above - hang() };
      };

      // A tall stage: part of the board hangs, lifting the heading less than centring would,
      // with the space above the heading at most `HOME_BOARD_MAX_TILT` times the space under it.
      render({ defaultBoard: 'now', stage: { height: 2000, rest: 100 } });
      const height = slotPx();
      const tall = hang();
      expect(tall).toBeGreaterThan(0);
      expect(tall).toBeLessThanOrEqual((height + 6) * HOME_BOARD_HANG_SHARE);
      expect(gaps(2000).above).toBeLessThanOrEqual(HOME_BOARD_MAX_TILT * gaps(2000).below + 1);
      // The slot is the board's own height: no band of nothing under the tiles.
      expect(height).toBe(BOARD_HEIGHT_PX);
      // Switching boards gives the other board its own height.
      click(q('[data-segment="week"]')!);
      expect(byTestId('home-week')).not.toBeNull();
      expect(slotPx()).toBe(BOARD_HEIGHT_PX);
      // Folded, no slot is held, and a little space is kept under the line instead, so the stage
      // centres the heading and the line a little above its middle.
      click(q('[data-segment="week"]')!);
      expect(byTestId('home-dashboard-slot')).toBeNull();
      const kept = -hang();
      expect(kept).toBe(Math.floor(2 * HOME_FOLDED_LIFT * (2000 - 100 - 28)));
      // Opening never moves the heading down: what the open board does not hang is at least
      // what the folded page keeps under its line.
      expect(height + 6 - tall).toBeGreaterThanOrEqual(kept);
    });

    it('holds the board up off the composer in a middling stage', () => {
      const section = () => byTestId('home-dashboard')!;
      const slotPx = () => Number.parseFloat(byTestId('home-dashboard-slot')!.style.minHeight);
      const hang = () => -Number.parseFloat(section().style.marginBottom || '0');
      const gaps = (stage: number) => {
        const box = 100 + 28 + slotPx() + 6 - hang();
        const above = (stage - box) / 2;
        return { above, below: above - hang() };
      };

      // Start folded explicitly: the compact quiet card now fits this stage on its own, while
      // this case is about the geometry after a person opens a board from the line.
      render({ defaultBoard: null, stage: { height: 700, rest: 100 } });
      expect(byTestId('home-dashboard-slot')).toBeNull();
      click(q('[data-segment="now"]')!);
      expect(hang()).toBeGreaterThan(0);
      expect(hang()).toBeLessThan((slotPx() + 6) * HOME_BOARD_HANG_SHARE);
      expect(gaps(700).above).toBeLessThanOrEqual(HOME_BOARD_MAX_TILT * gaps(700).below + 1);
      expect(gaps(700).below).toBeGreaterThan(12);
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

    it.each([CODEX, CLAUDE])('closes the usage picker after choosing $name', async (candidate) => {
      const selected: string[] = [];
      render({
        usage: usage(),
        usageSources: [CODEX, CLAUDE],
        usageSourceId: CODEX.id,
        onUsageSourceChange: (id) => selected.push(id),
      });
      const trigger = byTestId('home-week-usage-source')!;
      await act(async () => trigger.click());
      expect(trigger.getAttribute('aria-expanded')).toBe('true');
      const option = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
      ).find((item) => item.textContent === candidate.name)!;
      expect(option).toBeDefined();

      await act(async () => option.click());

      expect(trigger.getAttribute('aria-expanded')).toBe('false');
      expect(selected).toEqual([candidate.id]);
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
      // Both segments keep their summaries open or folded, so neither changes width.
      expect(segment('now').contains(byTestId('home-now-summary'))).toBe(true);
      expect(segment('week').contains(byTestId('home-week-summary'))).toBe(true);
    });

    it('swaps the boards from the other segment, and folds the open one into the line', () => {
      render({ rows: [nowRow('wait', { waiting: true }), nowRow('run', { working: true })] });
      click(segment('week'));
      expect(byTestId('home-now')).toBeNull();
      expect(byTestId('home-week')).not.toBeNull();
      // Now's summary: one thing needs you, one agent runs, nothing just finished.
      expect(byTestId('home-now-summary')?.textContent).toBe('Needs you1Running1Just finished0');

      click(segment('week'));
      expect(byTestId('home-week')).toBeNull();
      expect(segment('week').getAttribute('aria-expanded')).toBe('false');
      expect(segment('week').contains(byTestId('home-week-summary'))).toBe(true);
      expect(fold().getAttribute('aria-label')).toBe('Unfold');

      // The control at the end brings back the board that was open last.
      click(fold());
      expect(byTestId('home-week')).not.toBeNull();
      expect(fold().getAttribute('aria-label')).toBe('Fold into one line');
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

    it('says so in one quiet phrase when nothing at all is going on', () => {
      render({ defaultBoard: null });
      expect(byTestId('home-now-summary')?.textContent).toBe('All caught up');
      expect(byTestId('home-now-summary')?.getAttribute('data-summary')).toBe('quiet');
    });

    it('keeps the three counts once anything is going on', () => {
      render({ defaultBoard: null, rows: [nowRow('a', { waiting: true })] });
      expect(byTestId('home-now-summary')?.textContent).toBe('Needs you1Running0Just finished0');
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
