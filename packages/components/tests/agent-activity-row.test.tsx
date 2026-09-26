// @vitest-environment jsdom

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { SessionId } from '@lody/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChatStreamItems } from '../src/components/ai-gui/build-chat-stream-items';
import { SessionChatStreamView } from '../src/components/ai-gui/view';
import { initI18n } from '../src/i18n';
import { createConversationViewFromHistory } from '../src/lib/conversation-view';

vi.mock('@lody/virtua', () => ({
  Virtualizer: ({ children }: { children: import('react').ReactNode }) => children,
}));

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
    container.remove();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  const render = async (
    history: unknown[],
    status: { label: string; tone?: 'primary' | 'warning' },
    options: { withTurnFooter?: boolean } = {}
  ) => {
    const view = createConversationViewFromHistory({
      sessionId,
      getHistory: () => history as never,
      subscribe: () => () => {},
    });
    const { items } = buildChatStreamItems(view, sessionId);
    view.dispose();
    await act(async () =>
      root.render(
        createElement(SessionChatStreamView, {
          items,
          sessionId,
          renderMessageRow: () => null,
          lastAssistantMessageId: 'assistant-turn',
          agentActivityLabel: status.label,
          agentActivityTone: status.tone ?? 'primary',
          // Copy-context makes a live turn render its footer (copy/fork actions).
          ...(options.withTurnFooter ? { onCopyContext: () => {} } : {}),
        })
      )
    );
  };

  const statusRow = () => container.querySelector('[data-agent-activity-row]');
  const shimmering = () =>
    Array.from(container.querySelectorAll('.agent-shimmer')).map((el) => el.textContent);

  it('does not report populated but scroll-hidden conversation content as ready', async () => {
    await render(liveTurn([{ type: 'text', text: 'Already hydrated answer.' }]), {
      label: 'Working',
    });
    const viewport = container.querySelector<HTMLElement>('[data-message-selection-scroll]');
    expect(viewport).not.toBeNull();
    expect(viewport!.style.visibility).toBe('hidden');
    expect(container.querySelector('[data-window-session-stream-ready]')).toBeNull();
  });

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

  it('keeps a still status row while waiting on the user', async () => {
    await render(liveTurn([{ type: 'text', text: 'May I run this?' }]), {
      label: 'Waiting for permission',
      tone: 'warning',
    });
    expect(statusRow()?.textContent).toBe('Waiting for permission (Worked for 30s)');
    expect(shimmering()).toEqual([]);
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
    await act(async () => info!.click());
    expect(document.body.textContent).toContain('Claude Opus 5');
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
    // A kindless call carrying terminal I/O is a command too.
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
        },
      }),
      { label: 'Working' }
    );
    // Token usage alone is enough to offer the turn details.
    const info = container.querySelector<HTMLButtonElement>('[aria-label="Turn configuration"]');
    await act(async () => info!.click());
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
    expect(document.body.textContent).not.toContain('No configuration recorded');
  });
});
