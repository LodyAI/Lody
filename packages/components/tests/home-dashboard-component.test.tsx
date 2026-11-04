// @vitest-environment jsdom

// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The composer's mention sources read the authenticated workspace; the page under test is the
// landing view and its dashboard, not mentions.
vi.mock('../src/components/mentions/mention-session-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useSessionMentionItems: () => [],
}));
vi.mock('../src/components/mentions/mention-agent-role-source', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  useAgentRoleMentionItems: () => [],
}));

import { ChatLandingView } from '../src/components/chat/chat-landing-view';
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
      // Running takes the left column with needs you: with nothing else to place, that is the
      // arrangement that leaves those two columns level, and just finished stays on the right.
      const running = q('[data-now-column="left"] [data-testid="home-now-running"]')!;
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
      expect(q('[data-now-column="left"]')?.contains(all)).toBe(true);
      expect(running.closest('[inert]')).not.toBeNull();
      expect(attention.closest('[inert]')).not.toBeNull();
      expect(byTestId('home-now-next')?.closest('[inert]')).toBeNull();
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

    it('fits a short window, and folds into the line when even one row each does not fit', () => {
      const boards: (HomeBoard | null)[] = [];
      const rows = [
        ...Array.from({ length: 9 }, (_, index) => nowRow(`wait-${index}`, { waiting: true })),
        ...Array.from({ length: 6 }, (_, index) => nowRow(`run-${index}`, { working: true })),
      ];
      // With room for the whole board, the chosen arrangement levels needs you to its full list.
      render({ rows, defaultBoard: 'now', stage: { height: 2000, rest: 100 } });
      expect(byTestId('home-now-attention')?.querySelectorAll('[data-session]')).toHaveLength(9);

      // Room for ten rows a column (262px of board): needs you takes the left column alone and
      // shows seven of its nine, and running the first three of its six on the right.
      render({ rows, defaultBoard: 'now', stage: { height: 420, rest: 100 } });
      expect(byTestId('home-now-attention')?.querySelectorAll('[data-session]')).toHaveLength(7);
      expect(byTestId('home-now-running')?.querySelectorAll('[data-session]')).toHaveLength(3);
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

    it('words a scheduled reset without a probability', () => {
      render({
        usage: usage(),
        forecast: { title: 'Codex reset scheduled', chancePercent: null, when: 'Today 2:00 PM' },
      });
      expect(byTestId('home-week-forecast')?.textContent).toBe(
        'Codex reset scheduledToday 2:00 PM'
      );
    });
  });

  describe('the line', () => {
    const segment = (id: HomeBoard) => q(`[data-segment="${id}"]`)!;
    const fold = () => byTestId('home-dashboard-fold')!;

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
  });

  describe('under the composer', () => {
    beforeEach(() => {
      vi.stubGlobal('matchMedia', (query: string): MediaQueryList => ({
        matches: false,
        media: query,
        onchange: null,
        addEventListener: () => undefined,
        removeEventListener: () => undefined,
        addListener: () => undefined,
        removeListener: () => undefined,
        dispatchEvent: () => false,
      }));
    });

    const states: { name: string; rows: HomeNowRow[]; usage: HomeWeekUsage | null }[] = [
      // A new account's first visit: no sessions yet, and no provider reporting usage.
      { name: 'a new account', rows: [], usage: null },
      { name: 'a quiet board beside the usage', rows: [], usage: usage() },
      {
        name: 'busy lists without usage',
        rows: [nowRow('wait', { waiting: true }), nowRow('run', { working: true })],
        usage: null,
      },
      {
        name: 'busy lists beside the usage',
        rows: [
          ...Array.from({ length: 9 }, (_, index) => nowRow(`wait-${index}`, { waiting: true })),
          ...Array.from({ length: 6 }, (_, index) => nowRow(`done-${index}`, { unread: true })),
        ],
        usage: usage(),
      },
    ];
    const boards: (HomeBoard | null)[] = ['now', 'week', null];

    it.each(states.flatMap((state) => boards.map((defaultBoard) => ({ ...state, defaultBoard }))))(
      'keeps the prompt on the page for $name on board $defaultBoard',
      (state) => {
        act(() => {
          root.render(
            <ChatLandingView
              tone="light"
              title="New chat"
              promptValue=""
              onPromptChange={() => undefined}
              submitLabel="Send"
              ambient={
                <HomeDashboard
                  now={buildHomeNow({ rows: state.rows }, NOW_MS)}
                  week={buildHomeWeek({ rows: [], activeDays: [] }, NOW)}
                  agentLabel={label}
                  nowMs={NOW_MS}
                  animate={false}
                  defaultBoard={state.defaultBoard}
                  usage={state.usage}
                />
              }
            />
          );
        });
        expect(q('#chat-prompt')).not.toBeNull();
        expect(byTestId('home-dashboard')).not.toBeNull();
      }
    );

    it('keeps the prompt on the page when the dashboard fails to render', () => {
      const BrokenDashboard = (): never => {
        throw new TypeError("Cannot read properties of undefined (reading 'reduce')");
      };
      vi.spyOn(console, 'error').mockImplementation(() => undefined);
      act(() => {
        root.render(
          <ChatLandingView
            tone="light"
            title="New chat"
            promptValue=""
            onPromptChange={() => undefined}
            submitLabel="Send"
            ambient={<BrokenDashboard />}
          />
        );
      });
      expect(q('#chat-prompt')).not.toBeNull();
      const alert = q('[role="alert"]');
      expect(alert?.textContent).toContain("This part couldn't be shown.");
      expect(alert?.querySelector('[title]')?.getAttribute('title')).toContain('reduce');
    });
  });
});
