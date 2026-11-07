import type { Meta, StoryObj } from '@storybook/react';
import { Provider } from 'jotai';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { MessageContent, SessionHistoryParsed, SessionId } from '@lody/shared';
import { Button } from '@lody/ui/button';
import { MessageRowView, SubagentRunHistory } from '@/components/ai-gui/view';
import type { SubagentTask } from '@/components/ai-gui/subagent-task-panel';
import { SessionSearchProvider } from '@/components/sessions/session-search-context';
import { getThoughtSearchBlockId } from '@/lib/session-chat-search';
import { DEFAULT_CONVERSATION_FONT_SIZE } from '@/atoms/settings';
import { SettingsStoryProviders } from './settings-story-shell';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: {
    padding: 16,
    maxWidth: 1040,
    color: themeColors.foreground,
    backgroundColor: themeColors.background,
  },
  section: { marginBottom: 24 },
  control: { marginBottom: 16 },
});
const sessionId = 'private-collapsible-layout-session' as SessionId;
const svg =
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAxNjAgMzIiPjxyZWN0IHdpZHRoPSIxNjAiIGhlaWdodD0iMzIiIGZpbGw9IiM0YjcyODciLz48cGF0aCBkPSJNOCAyNCAzMiA4IDU2IDI0IDgwIDggMTA0IDI0IDEyOCA4IDE1MiAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZTdlZGYwIiBzdHJva2Utd2lkdGg9IjMiLz48L3N2Zz4=';
function message(
  id: string,
  role: 'user' | 'system',
  items: MessageContent[]
): SessionHistoryParsed {
  return { id, role, items, read: true, timestamp: '2026-10-22T08:00:00.000Z', finished: true };
}
type Tool = Extract<MessageContent, { type: 'tool_call' }>;
function media(title: string, { open = false, readonly = false } = {}): Tool {
  return {
    type: 'tool_call',
    toolCallId: title,
    title,
    kind: readonly ? 'read' : 'other',
    status: open ? 'failed' : 'completed',
    content: [
      { type: 'content', content: { type: 'image', mimeType: 'image/svg+xml', data: svg } },
      {
        type: 'content',
        content: {
          type: 'text',
          text: 'Synthetic detail keeps its real section, wrapping and padding.',
        },
      },
    ],
  };
}
function Worktree({ name = 'worktree' }: { name?: string }) {
  const script: MessageContent = {
    type: 'worktree_script',
    phase: 'setup',
    status: 'completed',
    steps: [
      {
        command: 'printf synthetic-worktree-output',
        status: 'completed',
        output: 'Synthetic worktree output\nSecond synthetic line.',
      },
    ],
  };
  return (
    <section data-collapsible-case={name} {...stylex.props(styles.section)}>
      <MessageRowView
        message={message('collapsible-' + name, 'system', [script])}
        sessionId={sessionId}
      />
    </section>
  );
}
function Normal({
  name = 'normal',
  title = 'Synthetic normal media',
  open = false,
  readonly = false,
}: {
  name?: string;
  title?: string;
  open?: boolean;
  readonly?: boolean;
}) {
  return (
    <section data-collapsible-case={name} {...stylex.props(styles.section)}>
      <MessageRowView
        message={message('collapsible-' + name, 'user', [media(title, { open, readonly })])}
        sessionId={sessionId}
      />
    </section>
  );
}
function Activity({
  name = 'activity',
  title = 'Synthetic activity media',
}: {
  name?: string;
  title?: string;
}) {
  const task: SubagentTask = {
    type: 'subagent_task',
    taskId: 'collapsible-' + name,
    taskKind: 'subagent',
    status: 'completed',
    actor: 'Explore',
    description: 'Synthetic streamed tool history',
    run: {
      sessionId: 'collapsible-child',
      snapshot: {
        state: 'completed',
        support: { stream: ['tool'], progress: true, outputRead: 'none', cancel: false },
      },
      items: [media(title, { open: true })],
    },
  };
  return (
    <section data-collapsible-case={name} {...stylex.props(styles.section)}>
      <SubagentRunHistory task={task} fontSize={DEFAULT_CONVERSATION_FONT_SIZE} />
    </section>
  );
}
function ScopedCases() {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return undefined;
    const apply = () => {
      const button = [...element.querySelectorAll<HTMLButtonElement>('button')].find(
        (e) =>
          e.textContent?.trim() === 'Synthetic scoped activity' &&
          e.firstElementChild?.tagName === 'DIV'
      );
      const body = button?.nextElementSibling as HTMLElement | null;
      if (button && body) {
        button.parentElement?.style.setProperty('--radius-md', '13px');
        body.style.setProperty('--spacing', '5px');
        element.dataset.writersReady = 'true';
      }
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(element, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  return (
    <div ref={root} data-collapsible-scopes style={{ '--spacing': '6px' } as CSSProperties}>
      <Worktree name="scoped-worktree" />
      <div style={{ '--spacing': '3px' } as CSSProperties}>
        <Normal name="scoped-normal" title="Synthetic scoped normal" open />
        <Activity name="scoped-activity" title="Synthetic scoped activity" />
      </div>
    </div>
  );
}
function SearchCaller() {
  const [active, setActive] = useState(true);
  const id = 'collapsible-thought-search';
  const blockId = getThoughtSearchBlockId(id, 0);
  return (
    <section data-collapsible-case="search" data-search-active={active}>
      <div {...stylex.props(styles.control)}>
        <Button onClick={() => setActive(false)} disabled={!active}>
          Clear synthetic search
        </Button>
      </div>
      <SessionSearchProvider
        value={{
          isOpen: active,
          query: active ? 'synthetic' : '',
          activeBlockId: active ? blockId : null,
          activeResultId: active ? 'collapsible-match' : null,
          blockMatches: new Map([
            [
              blockId,
              {
                blockId,
                resultIds: ['collapsible-match'],
                activeResultId: active ? 'collapsible-match' : null,
                activeOccurrenceIndex: active ? 0 : null,
              },
            ],
          ]),
          hasMatchedPrefix: (prefix) => active && prefix === blockId,
          hasActivePrefix: (prefix) => active && prefix === blockId,
        }}
      >
        <MessageRowView
          message={message(id, 'user', [
            {
              type: 'thought',
              text: 'A synthetic thought preserves the actual search caller and its compatibility ring.',
            },
          ])}
          sessionId={sessionId}
        />
      </SessionSearchProvider>
    </section>
  );
}
function Fixture({
  kind,
}: {
  kind: 'worktree' | 'normal' | 'activity' | 'readonly' | 'scoped' | 'search';
}) {
  return (
    <div data-owned-collapsible-layout={kind} {...stylex.props(styles.frame)}>
      {kind === 'worktree' ? (
        <Worktree />
      ) : kind === 'normal' ? (
        <Normal />
      ) : kind === 'activity' ? (
        <Activity />
      ) : kind === 'readonly' ? (
        <Normal name="readonly" title="Synthetic read-only media" readonly />
      ) : kind === 'scoped' ? (
        <ScopedCases />
      ) : (
        <SearchCaller />
      )}
    </div>
  );
}
const meta = {
  title: 'Migration/OwnedCollapsibleCardLayout',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <Provider>
        <SettingsStoryProviders>
          <Story />
        </SettingsStoryProviders>
      </Provider>
    ),
  ],
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const WorktreeLayout: Story = { args: { kind: 'worktree' } };
export const NormalMedia: Story = { args: { kind: 'normal' } };
export const ActivityMedia: Story = { args: { kind: 'activity' } };
export const ReadonlyTool: Story = { args: { kind: 'readonly' } };
export const ScopedLayout: Story = { args: { kind: 'scoped' } };
export const SearchCompatibility: Story = { args: { kind: 'search' } };
