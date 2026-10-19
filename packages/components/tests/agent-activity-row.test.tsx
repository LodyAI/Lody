// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { SessionChatStreamView } from '../src/components/ai-gui/view';
import { initI18n } from '../src/i18n';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';
import type {
  HistoryLiveSync,
  HistoryLiveWindow,
  LiveTurnActivity,
} from '../src/components/ai-gui/assistant-turn-timing';
import { useHistoryLiveWindow } from '../src/hooks/use-history-live-window';
import { clearSavedScrollStates } from '../src/lib/conversation-scroll/saved-state';

(
  globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const sessionId = 'activity-session' as SessionId;

const toolCall = (id: string) => ({
  type: 'tool_call' as const,
  toolCallId: id,
  title: `Run check ${id}`,
  kind: 'execute' as const,
  status: 'completed' as const,
});

/** A live (unfinished) assistant turn with the given items. */
const liveTurn = (items: unknown[], assistant: Record<string, unknown> = {}) => [
  {
    id: 'user-turn',
    role: 'user',
    timestamp: '2026-09-19T00:00:00Z',
    items: [{ type: 'text', text: 'Please check the build.' }],
  },
  {
    id: 'assistant-turn',
    role: 'assistant',
    timestamp: '2026-09-19T00:00:01Z',
    items,
    fileDiff: [],
    finished: false,
    ...assistant,
  },
];

describe('live agent status', () => {
  let root: Root;
  let container: HTMLDivElement;

  beforeEach(async () => {
    await initI18n('en');
    clearSavedScrollStates();
    // The live turn started at 00:00:01, so every live status reads 30s in.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-09-19T00:00:31Z'));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        unobserve() {}
        disconnect() {}
      }
    );
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    clearSavedScrollStates();
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const render = async (
    history: unknown[],
    status: { label: string; tone?: 'primary' | 'warning' },
    options: {
      withTurnFooter?: boolean;
      scrollAway?: boolean;
      /** Presence and the live-sync window as the session page reports them. */
      live?: { activity: LiveTurnActivity | null; window: HistoryLiveWindow };
    } = {}
  ) => {
    let current = history;
    let notify: () => void = () => {};
    const view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => current as never,
      subscribe: (listener) => {
        notify = listener;
        return () => {};
      },
    });
    const { items } = buildChatStreamItems(view, sessionId);
    const renderWith = (window: HistoryLiveWindow | undefined) =>
      act(async () =>
        root.render(
          createElement(SessionChatStreamView, {
            items,
            sessionId,
            conversationView: view,
            renderMessageRow: () => null,
            lastAssistantMessageId: 'assistant-turn',
            agentActivityLabel: status.label,
            agentActivityTone: status.tone ?? 'primary',
            liveTurnActivity: options.live?.activity ?? null,
            ...(window ? { historyLive: window } : {}),
            // Copy-context makes a live turn render its footer (copy/fork actions).
            ...(options.withTurnFooter ? { onCopyContext: () => {} } : {}),
          })
        )
      );
    await renderWith(options.live?.window);
    const controls = {
      /** The same turns arriving again from the backend: an update, not an edit. */
      deliverUpdate: async () => {
        current = history.slice();
        await act(async () => notify());
      },
      setLiveWindow: (window: HistoryLiveWindow) => renderWith(window),
    };

    if (options.scrollAway) {
      const viewport = container.querySelector<HTMLElement>('[data-message-selection-scroll]');
      expect(viewport).not.toBeNull();
      Object.defineProperties(viewport, {
        clientHeight: { configurable: true, value: 400 },
        scrollHeight: { configurable: true, value: 1000 },
        // The synthetic wheel must start somewhere it can actually scroll up.
        scrollTop: { configurable: true, writable: true, value: 600 },
      });
      await act(async () => {
        viewport!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, deltaY: -20 }));
      });
    }
    return controls;
  };

  /** Moves the clock and every interval (the live tickers) together. */
  const useTickingClock = (iso: string) => {
    vi.useRealTimers();
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    vi.setSystemTime(new Date(iso));
  };
  const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
  /** A live window that opened at the current (fake) instant. */
  const liveNow = (): HistoryLiveWindow => ({ sync: 'live', since: Date.now() });

  const statusRow = () => container.querySelector('[data-agent-activity-row]');
  const shimmering = () =>
    Array.from(container.querySelectorAll('.agent-shimmer')).map((el) => el.textContent);

  it('shimmers the collapsed tool group at the bottom of a working turn instead of adding a row', async () => {
    await render(liveTurn([{ type: 'text', text: 'Checking.' }, toolCall('a'), toolCall('b')]), {
      label: 'Working',
    });
    expect(statusRow()).toBeNull();
    expect(shimmering()).toEqual(['Ran 2 commands (Worked for 30s)']);
  });

  it('adds a shimmering status row when the working turn does not end in a collapsed group', async () => {
    await render(liveTurn([toolCall('a'), toolCall('b'), { type: 'text', text: 'Now writing.' }]), {
      label: 'Working',
    });
    expect(statusRow()?.textContent).toBe('Working (Worked for 30s)');
    expect(shimmering()).toEqual(['Working (Worked for 30s)']);
  });

  it('says how long a working turn has gone without output once that passes two minutes', async () => {
    useTickingClock('2026-09-19T00:04:29Z');
    const { deliverUpdate } = await render(
      liveTurn([toolCall('a'), { type: 'text', text: 'Running the lint gate.' }]),
      { label: 'Working' },
      { live: { activity: 'working', window: liveNow() } }
    );
    // Advances stay on the label's 300ms sample grid, so each read is exact.
    await advance(2_100);
    await deliverUpdate();
    // 30s of silence is ordinary streaming: no notice yet.
    await advance(30_000);
    expect(statusRow()?.textContent).toBe('Working (Worked for 5m 00s)');
    await advance(219_900);
    expect(statusRow()?.textContent).toBe('Working (Worked for 8m 40s · no output for 4m)');
  });

  it('never reports silence while the agent waits on the user', async () => {
    useTickingClock('2026-09-19T00:04:29Z');
    const { deliverUpdate } = await render(
      liveTurn([{ type: 'text', text: 'May I run this?' }]),
      { label: 'Waiting for permission', tone: 'warning' },
      { live: { activity: 'awaitingUser', window: liveNow() } }
    );
    await advance(2_000);
    await deliverUpdate();
    await advance(250_000);
    expect(statusRow()?.textContent).toBe('Waiting for permission (Worked for 8m 40s)');
  });

  it('keeps a still status row while waiting on the user', async () => {
    await render(liveTurn([{ type: 'text', text: 'May I run this?' }]), {
      label: 'Waiting for permission',
      tone: 'warning',
    });
    expect(statusRow()?.textContent).toBe('Waiting for permission (Worked for 30s)');
    expect(shimmering()).toEqual([]);
  });

  it('keeps the scroll-to-latest button actionable while output streams', async () => {
    await render(
      liveTurn([{ type: 'text', text: 'Still writing.' }]),
      { label: 'Working' },
      { scrollAway: true }
    );
    const button = container.querySelector<HTMLButtonElement>('[data-scroll-to-latest]');
    expect(button).not.toBeNull();
    expect(button!.querySelector('.animate-spin')).not.toBeNull();
    expect(button!.querySelector('.lucide-arrow-down')).not.toBeNull();
    await act(async () => button!.click());
    expect(container.querySelector('[data-scroll-to-latest]')).toBeNull();
  });

  it('keeps the scroll-to-latest arrow while waiting for permission', async () => {
    await render(
      liveTurn([{ type: 'text', text: 'May I continue?' }]),
      { label: 'Waiting for permission', tone: 'warning' },
      { scrollAway: true }
    );
    const button = container.querySelector<HTMLButtonElement>('[data-scroll-to-latest]');
    expect(button).not.toBeNull();
    expect(button!.querySelector('.animate-spin')).toBeNull();
    expect(button!.querySelector('.lucide-arrow-down')).not.toBeNull();
  });

  it('places the status inside a live turn, above its footer actions', async () => {
    await render(
      liveTurn([toolCall('a'), toolCall('b'), { type: 'text', text: 'Now writing.' }]),
      { label: 'Working' },
      { withTurnFooter: true }
    );
    expect(statusRow()).toBeNull();
    const status = container.querySelector('[data-agent-activity-status]');
    expect(status?.textContent).toBe('Working (Worked for 30s)');
    expect(
      status?.closest('[data-assistant-turn-id]')?.getAttribute('data-assistant-turn-id')
    ).toBe('assistant-turn');
    const copyContext = container.querySelector('[aria-label="Copy context as Markdown"]');
    expect(copyContext).not.toBeNull();
    // Status precedes the footer's actions in reading order.
    expect(
      status!.compareDocumentPosition(copyContext!) & Node.DOCUMENT_POSITION_FOLLOWING
    ).toBeTruthy();
    expect(status?.parentElement?.classList.contains('pt-1')).toBe(true);
  });

  it.each([
    { withTurnFooter: false, taskStatus: 'completed' },
    { withTurnFooter: true, taskStatus: 'completed' },
    { withTurnFooter: false, taskStatus: 'in_progress' },
    { withTurnFooter: true, taskStatus: 'in_progress' },
  ])(
    'places status above $taskStatus tasks with footer=$withTurnFooter',
    async ({ withTurnFooter, taskStatus }) => {
      await render(
        liveTurn([
          toolCall('a'),
          { type: 'text', text: 'Partial answer.' },
          ...['a', 'b', 'c'].map((id) => ({
            type: 'subagent_task',
            taskId: `task-${id}`,
            status: taskStatus,
            actor: `Researcher ${id}`,
            description: `Inspect check ${id}`,
          })),
        ]),
        { label: 'Working' },
        { withTurnFooter }
      );

      const status = container.querySelector('[data-agent-activity-status]');
      const summary = Array.from(container.querySelectorAll('button')).find(
        (button) =>
          button.textContent === (taskStatus === 'completed' ? '3 tasks' : 'Waiting on 3 tasks')
      );
      expect(status?.textContent).toBe('Working (Worked for 30s)');
      expect(container.querySelectorAll('[data-agent-activity-status]')).toHaveLength(1);
      expect(statusRow()).toBeNull();
      expect(summary).toBeDefined();
      expect(
        status!.compareDocumentPosition(summary!) & Node.DOCUMENT_POSITION_FOLLOWING
      ).toBeTruthy();
      if (taskStatus === 'in_progress') {
        expect(container.textContent).toContain('Inspect check a');
        return;
      }
      expect(summary!.getAttribute('aria-expanded')).toBe('false');
      await act(async () => summary!.click());
      expect(summary!.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain('Inspect check a');
      await act(async () => summary!.click());
      expect(summary!.getAttribute('aria-expanded')).toBe('false');
      expect(container.textContent).not.toContain('Inspect check a');
    }
  );

  it('exposes the turn configuration while the reply is still streaming', async () => {
    await render(
      liveTurn([{ type: 'text', text: 'Partial answer' }], {
        modelInfo: { modelId: 'claude-opus-5', name: 'Claude Opus 5' },
      }),
      { label: 'Working' }
    );
    const info = container.querySelector<HTMLButtonElement>('[aria-label="Turn configuration"]');
    expect(info).not.toBeNull();
    // The status joins the turn, above the actions that now exist while it runs.
    const status = container.querySelector('[data-agent-activity-status]');
    expect(status?.closest('[data-assistant-turn-id]')).not.toBeNull();
    expect(status!.compareDocumentPosition(info!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // Copying the whole response still waits for the reply to finish.
    expect(container.querySelector('[aria-label="Copy response"]')).toBeNull();
    // Row overlays mount once their row is armed by a pointer entry, as in the
    // app; arming remounts the trigger, so click the live one.
    await act(async () => {
      info!
        .closest('[data-virtual-index]')!
        .dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Turn configuration"]')!.click()
    );
    expect(document.body.textContent).toContain('Claude Opus 5');
  });

  const openTurnInfo = async () => {
    const info = container.querySelector<HTMLButtonElement>('[aria-label="Turn configuration"]');
    // Row overlays mount once their row is armed by a pointer entry.
    await act(async () => {
      info!
        .closest('[data-virtual-index]')!
        .dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Turn configuration"]')!.click()
    );
  };
  const popoverValue = (label: string) =>
    [...document.body.querySelectorAll('dt')].find((dt) => dt.textContent === label)
      ?.nextElementSibling;

  const modelInfo = { modelId: 'claude-opus-5', name: 'Claude Opus 5' };
  const streamingTurn = () => liveTurn([{ type: 'text', text: 'Partial answer' }], { modelInfo });

  it('times a running turn in its info popover and warns when updates stop', async () => {
    useTickingClock('2026-09-19T00:00:05Z');
    const { deliverUpdate } = await render(
      streamingTurn(),
      { label: 'Working' },
      { live: { activity: 'working', window: liveNow() } }
    );
    await advance(2_000);
    await deliverUpdate();
    await advance(12_000);
    await openTurnInfo();
    expect(popoverValue('Started')?.textContent).toMatch(/ · running 18s$/);
    expect(popoverValue('Last update')?.textContent).toBe('12s ago');
    expect(popoverValue('Last update')?.hasAttribute('data-stale')).toBe(false);
    expect(popoverValue('Ended')).toBeUndefined();

    await advance(48_000);
    const stale = popoverValue('Last update');
    expect(stale?.textContent).toBe('1m 00s ago');
    expect(stale?.hasAttribute('data-stale')).toBe(true);
    expect(stale?.getAttribute('title')).toContain('may be stuck');
  });

  it('does not read a catch-up import as fresh output', async () => {
    useTickingClock('2026-09-19T00:00:05Z');
    const { deliverUpdate, setLiveWindow } = await render(
      streamingTurn(),
      { label: 'Working' },
      { live: { activity: 'working', window: { sync: 'syncing', since: null } } }
    );
    await openTurnInfo();
    expect(popoverValue('Last update')?.textContent).toBe('—');
    expect(popoverValue('Last update')?.getAttribute('title')).toContain('Catching up');

    // Joining imports what was missed, and the room reports synced around it.
    await deliverUpdate();
    await setLiveWindow(liveNow());
    await deliverUpdate();
    await advance(30_000);
    expect(popoverValue('Last update')?.textContent).toBe('—');
    expect(popoverValue('Last update')?.hasAttribute('data-stale')).toBe(false);

    // Only output that arrives while live counts.
    await deliverUpdate();
    await advance(5_000);
    expect(popoverValue('Last update')?.textContent).toBe('5s ago');
  });

  it('says the agent waits on the user, or that this device is offline, instead of a time', async () => {
    useTickingClock('2026-09-19T00:00:05Z');
    const { deliverUpdate, setLiveWindow } = await render(
      streamingTurn(),
      { label: 'Waiting for permission', tone: 'warning' },
      { live: { activity: 'awaitingUser', window: liveNow() } }
    );
    await advance(2_000);
    await deliverUpdate();
    await advance(300_000);
    await openTurnInfo();
    expect(popoverValue('Last update')?.textContent).toBe('Waiting for you');
    expect(popoverValue('Last update')?.hasAttribute('data-stale')).toBe(false);

    await setLiveWindow({ sync: 'offline', since: null });
    expect(popoverValue('Last update')?.textContent).toBe('Disconnected');
    expect(popoverValue('Last update')?.hasAttribute('data-stale')).toBe(true);
  });

  it('shows an unfinished turn nothing is running as started, without running time or liveness', async () => {
    // The daemon died before finalizing: history stays unfinished, presence is gone.
    await render(
      streamingTurn(),
      { label: 'Working' },
      { live: { activity: null, window: liveNow() } }
    );
    await openTurnInfo();
    expect(popoverValue('Started')?.textContent).not.toContain('running');
    expect(popoverValue('Last update')).toBeUndefined();
  });

  it('opens a new live window each time live sync resumes, and none while it is down', async () => {
    useTickingClock('2026-09-19T00:00:05Z');
    const seen: HistoryLiveWindow[] = [];
    const Probe = ({ sync }: { sync: HistoryLiveSync }) => {
      seen.push(useHistoryLiveWindow(sync));
      return null;
    };
    await act(async () => root.render(createElement(Probe, { sync: 'live' })));
    expect(seen.at(-1)).toEqual({ sync: 'live', since: Date.parse('2026-09-19T00:00:05Z') });
    await advance(10_000);
    await act(async () => root.render(createElement(Probe, { sync: 'offline' })));
    expect(seen.at(-1)).toEqual({ sync: 'offline', since: null });
    await advance(10_000);
    await act(async () => root.render(createElement(Probe, { sync: 'live' })));
    expect(seen.at(-1)).toEqual({ sync: 'live', since: Date.parse('2026-09-19T00:00:25Z') });
  });

  it('times a finished turn by its start, end and Worked-for duration', async () => {
    await render(
      liveTurn([{ type: 'text', text: 'Done.' }], {
        finished: true,
        endedAt: Date.parse('2026-09-19T00:00:25Z'),
        modelInfo: { modelId: 'claude-opus-5', name: 'Claude Opus 5' },
      }),
      { label: 'Working' },
      { withTurnFooter: true }
    );
    await openTurnInfo();
    expect(popoverValue('Started')?.textContent).not.toContain('running');
    expect(popoverValue('Started')?.getAttribute('title')).toBeTruthy();
    expect(popoverValue('Ended')?.textContent).toBeTruthy();
    expect(popoverValue('Duration')?.textContent).toBe('24s');
    expect(popoverValue('Last update')).toBeUndefined();
  });

  it('labels command steps with the Run verb in the expanded group', async () => {
    await render(
      liveTurn([
        {
          type: 'tool_call',
          toolCallId: 'sed-1',
          title: "sed -n '1,240p' apps/view.tsx",
          kind: 'execute',
          status: 'completed',
        },
        {
          type: 'tool_call',
          toolCallId: 'bash-1',
          title: 'pnpm --dir apps/electron test',
          kind: 'bash',
          status: 'in_progress',
        },
        {
          type: 'tool_call',
          toolCallId: 'mystery-1',
          title: 'mycmd --flag',
          status: 'completed',
          content: [{ type: 'terminal_command', command: 'mycmd', args: ['--flag'] }],
        },
        {
          type: 'tool_call',
          toolCallId: 'shell-1',
          title: 'Shell: cat hello.txt',
          kind: 'execute',
          status: 'completed',
        },
        {
          type: 'tool_call',
          toolCallId: 'shell-2',
          title: 'Shell: npm start',
          kind: 'execute',
          status: 'in_progress',
        },
        {
          type: 'tool_call',
          toolCallId: 'search-1',
          title: "Search for 'createServer'",
          kind: 'search',
          status: 'completed',
        },
      ]),
      { label: 'Working' }
    );

    const header = [...container.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('commands')
    );
    expect(header).toBeDefined();
    await act(async () => header!.click());

    // Bare command titles get the verb, in the step's tense.
    expect(container.textContent).toContain("Ran sed -n '1,240p' apps/view.tsx");
    expect(container.textContent).toContain('Running pnpm --dir apps/electron test');
    // A kindless call carrying a command is a command too.
    expect(container.textContent).toContain('Ran mycmd --flag');
    // Agent-authored labels keep their own wording — no doubled verb.
    expect(container.textContent).toContain('Shell: cat hello.txt');
    expect(container.textContent).not.toContain('Ran Shell');
    expect(container.textContent).toContain("Searched for 'createServer'");

    // The shimmering verb is the running signal: a tense-verb row drops the
    // trailing spinner, while a running authored label keeps it.
    const step = (text: string) =>
      [...container.querySelectorAll('button')].find((button) =>
        button.textContent?.includes(text)
      )!;
    expect(step('Running pnpm').querySelector('.animate-spin')).toBeNull();
    expect(step('Shell: npm start').querySelector('.animate-spin')).not.toBeNull();
  });

  it('opens a step onto one sheet: the command once, then its output', async () => {
    const script =
      "cd /tmp/extract && python3 -c \"\nimport re\nprint(*re.findall(r'a*', 'aa'))\n\"";
    const linkedEcho = script.replace('/tmp/extract', '[/tmp/extract](file:///tmp/extract)');
    await render(
      liveTurn([
        {
          type: 'tool_call',
          toolCallId: 'python-1',
          title: 'python3',
          kind: 'execute',
          status: 'completed',
          content: [
            // The agent restates the command as text beside the structured one.
            { type: 'content', content: { type: 'text', text: linkedEcho } },
            { type: 'terminal_command', command: script },
            { type: 'terminal_output', output: 'aa', stream: 'combined' },
          ],
        },
        {
          type: 'tool_call',
          toolCallId: 'codex-1',
          title: 'pnpm typecheck',
          kind: 'execute',
          status: 'failed',
          content: [
            { type: 'terminal_command', command: '/bin/bash', args: ['-lc', 'pnpm typecheck'] },
            {
              type: 'terminal_output',
              output: "error TS6133: 'Badge' is declared",
              stream: 'combined',
              exitStatus: { exitCode: 2, signal: null },
            },
          ],
        },
        {
          type: 'tool_call',
          toolCallId: 'task-stop-1',
          title: 'TaskStop',
          kind: 'other',
          status: 'completed',
          // A Claude tool's string result is stored as terminal output.
          content: [{ type: 'terminal_output', output: '{"task_id":"b7q2"}', stream: 'combined' }],
        },
      ]),
      { label: 'Working' }
    );

    const button = (text: string) =>
      [...container.querySelectorAll('button')].find((candidate) =>
        candidate.textContent?.includes(text)
      )!;
    // A string result does not make a tool a command.
    expect(button('Ran 2 commands').textContent).toContain('Called 1 tool');
    await act(async () => button('Ran 2 commands').click());
    expect(container.textContent).not.toContain('Ran TaskStop');
    for (const step of ['Ran python3', 'Ran pnpm typecheck', 'TaskStop']) {
      await act(async () => button(step).click());
    }

    const sheets = [...container.querySelectorAll('[data-tool-detail-sheet]')];
    expect(sheets).toHaveLength(3);
    const [python, codex, taskStop] = sheets as [Element, Element, Element];
    // The echo is gone: the script appears once, as code, never as Markdown.
    expect(container.textContent!.split('import re')).toHaveLength(2);
    expect(python.querySelector('.markdown-renderer')).toBeNull();
    expect(python.querySelectorAll('pre')[1]?.textContent).toBe('aa');
    expect(python.textContent).toContain('$');
    // Codex's shell wrapper is not part of what the reader ran.
    expect(codex.textContent).toContain('pnpm typecheck');
    expect(codex.textContent).not.toContain('/bin/bash');
    expect(codex.textContent).toContain('Exit 2');
    // A result has no prompt and no header restating the row's title.
    expect(taskStop.textContent).toBe('{"task_id":"b7q2"}');
  });

  it('shows a shell step text result verbatim instead of reflowing it as Markdown', async () => {
    // Pi sessions recorded before its results became terminal output stored
    // them as plain text content.
    const output = '==== one ====\nline 1\n==== two ====\nline 2';
    await render(
      liveTurn([
        {
          type: 'tool_call',
          toolCallId: 'pi-bash-1',
          title: 'bash',
          kind: 'execute',
          status: 'completed',
          content: [
            { type: 'content', content: { type: 'text', text: output } },
            { type: 'terminal_command', command: 'echo one; echo two' },
          ],
        },
        {
          type: 'tool_call',
          toolCallId: 'pi-bash-2',
          title: 'pwd',
          kind: 'execute',
          status: 'completed',
          content: [{ type: 'terminal_command', command: 'pwd' }],
        },
      ]),
      { label: 'Working' }
    );

    const button = (text: string) =>
      [...container.querySelectorAll('button')].find((candidate) =>
        candidate.textContent?.includes(text)
      )!;
    await act(async () => button('Ran 2 commands').click());
    if (button('Ran bash').getAttribute('aria-expanded') !== 'true') {
      await act(async () => button('Ran bash').click());
    }

    const sheet = [...container.querySelectorAll('[data-tool-detail-sheet]')].find((candidate) =>
      candidate.textContent?.includes('echo one; echo two')
    );
    expect(sheet).toBeDefined();
    expect(sheet!.querySelector('.markdown-renderer')).toBeNull();
    expect([...sheet!.querySelectorAll('pre')].map((pre) => pre.textContent)).toContain(output);
  });

  it('shows the turn token usage in compact units with exact values on hover', async () => {
    await render(
      liveTurn([{ type: 'text', text: 'Done.' }], {
        finished: true,
        tokenUsage: {
          inputTokens: 1234,
          outputTokens: 300,
          cacheReadInputTokens: 1_500_000,
          cacheCreationInputTokens: 2000,
          reasoningOutputTokens: 200,
          costUSD: 0.0182,
        },
      }),
      { label: 'Working' }
    );
    // Token usage alone is enough to offer the turn details.
    const info = container.querySelector<HTMLButtonElement>('[aria-label="Turn configuration"]');
    // Row overlays mount once their row is armed by a pointer entry, as in the
    // app; arming remounts the trigger, so click the live one.
    await act(async () => {
      info!
        .closest('[data-virtual-index]')!
        .dispatchEvent(new MouseEvent('pointerover', { bubbles: true }));
    });
    await act(async () =>
      container.querySelector<HTMLButtonElement>('[aria-label="Turn configuration"]')!.click()
    );
    const value = (label: string) =>
      [...document.body.querySelectorAll('dt')].find((dt) => dt.textContent === label)
        ?.nextElementSibling;
    expect(document.body.textContent).toContain('Tokens');
    expect(value('Input')?.textContent).toBe('1.2K');
    // Output includes reasoning; cache sums reads and writes.
    expect(value('Output')?.textContent).toBe('500');
    expect(value('Output')?.getAttribute('title')).toBe('500 · Reasoning 200');
    expect(value('Cache')?.textContent).toBe('1.5M');
    expect(value('Cache')?.getAttribute('title')).toBe('1,502,000 · Read 1,500,000 · Write 2,000');
    // The cost estimate is one more row of the same token section.
    expect(document.body.textContent).toContain('Cost estimate');
    expect(value('Cost estimate')?.textContent).toBe('$0.0182');
    expect(value('Cost estimate')?.getAttribute('title')).toContain('not an invoice');
    expect(document.body.textContent).not.toContain('No configuration recorded');
  });
});
