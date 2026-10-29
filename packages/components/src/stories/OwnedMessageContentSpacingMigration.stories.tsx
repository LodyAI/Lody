import type { Meta, StoryObj } from '@storybook/react';
import { Provider } from 'jotai';
import { useLayoutEffect, useRef, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import type { SessionHistoryParsed, SessionId } from '@lody/shared';
import { MessageRowView } from '@/components/ai-gui/view';
import { SettingsStoryProviders } from './settings-story-shell';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: {
    padding: 16,
    maxWidth: 800,
    color: themeColors.foreground,
    backgroundColor: themeColors.background,
  },
  case: { marginBottom: 28 },
  heading: { fontSize: 12, marginBottom: 12 },
});
const sessionId = 'message-content-spacing-session' as SessionId;
const imageData =
  'PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxNjAiIGhlaWdodD0iMzIiIHZpZXdCb3g9IjAgMCAxNjAgMzIiPjxyZWN0IHdpZHRoPSIxNjAiIGhlaWdodD0iMzIiIGZpbGw9IiM0YjcyODciLz48cGF0aCBkPSJNOCAyNCAzMiA4IDU2IDI0IDgwIDggMTA0IDI0IDEyOCA4IDE1MiAyNCIgZmlsbD0ibm9uZSIgc3Ryb2tlPSIjZTdlZGYwIiBzdHJva2Utd2lkdGg9IjMiLz48L3N2Zz4=';
const audioData =
  'UklGRnQAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YVAAAACAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgA==';
type Item = SessionHistoryParsed['items'][number];
const entries: Extract<Item, { type: 'plan' }>['entries'] = [
  {
    content:
      'First synthetic step with a long description that wraps naturally on a narrow viewport.',
    status: 'completed',
    priority: 'high',
  },
  {
    content: 'Second synthetic step preserves the sibling margin and its local spacing variable.',
    status: 'in_progress',
    priority: 'medium',
  },
  {
    content: 'Final synthetic step keeps its original zero trailing margin.',
    status: 'pending',
    priority: 'low',
  },
];
const image: Extract<Item, { type: 'tool_call' }>['content'] = [
  { type: 'content', content: { type: 'image', mimeType: 'image/svg+xml', data: imageData } },
];
const media: Extract<Item, { type: 'tool_call' }>['content'] = [
  ...image!,
  { type: 'content', content: { type: 'audio', mimeType: 'audio/wav', data: audioData } },
  {
    type: 'content',
    content: {
      type: 'resource',
      resource: {
        uri: '#synthetic-blob-download',
        mimeType: 'application/octet-stream',
        blob: 'c3ludGhldGlj',
      },
    },
  },
];
function turn(id: string, items: Item[]): SessionHistoryParsed {
  return { id, role: 'user', timestamp: '2026-10-22T08:00:00.000Z', read: true, items };
}
function tool(id: string, expanded = false, imageOnly = false): Item {
  return {
    type: 'tool_call',
    toolCallId: id,
    title: 'Synthetic media result',
    kind: 'other',
    status: expanded ? 'failed' : 'completed',
    content: imageOnly ? image : media,
  };
}
function Row({ name, items }: { name: string; items: Item[] }) {
  return (
    <section data-spacing-case={name} {...stylex.props(styles.case)}>
      <MessageRowView message={turn(`spacing-${name}`, items)} sessionId={sessionId} />
    </section>
  );
}
function PlanCountCases() {
  return (
    <>
      <Row name="empty" items={[{ type: 'plan', entries: [] }]} />
      <Row name="single" items={[{ type: 'plan', entries: entries.slice(0, 1) }]} />
      <Row name="multiple" items={[{ type: 'plan', entries }]} />
    </>
  );
}
function ScopedContentCases() {
  const element = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const root = element.current;
    if (!root) return undefined;
    const apply = () => {
      for (const label of root.querySelectorAll<HTMLDivElement>('div')) {
        if (
          (label.textContent === 'Image' || label.textContent === 'Plan') &&
          ![...label.children].some(
            (child) => child.tagName === 'DIV' && child.textContent === label.textContent
          )
        ) {
          label.style.setProperty('--spacing', '5px');
          label.style.setProperty('--tw-space-y-reverse', '1');
        }
      }
      const title = [...root.querySelectorAll('span')].find(
        (node) => node.textContent === entries[0]!.content
      );
      const card = title?.parentElement?.parentElement?.parentElement;
      card?.style.setProperty('--spacing', '5px');
      card?.style.setProperty('--tw-space-y-reverse', '1');
      root.dataset.writersReady = String(Boolean(root.querySelector('img') && card));
    };
    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true });
    return () => observer.disconnect();
  }, []);
  const items: Item[] = [
    { type: 'plan', entries: entries.slice(0, 2) },
    tool('scoped-media', true, true),
  ];
  return (
    <div
      data-spacing-scopes
      style={{ '--spacing': '6px', '--tw-space-y-reverse': '1' } as CSSProperties}
    >
      <Row name="outer" items={items} />
      <div style={{ '--spacing': '3px' } as CSSProperties}>
        <Row name="inner" items={items} />
        <div ref={element} data-element-writers>
          <Row name="element" items={items} />
        </div>
      </div>
    </div>
  );
}
function UserStates() {
  return (
    <section data-user-spacing-state {...stylex.props(styles.case)}>
      <MessageRowView
        message={turn('spacing-user-actions', [
          {
            type: 'text',
            text: 'Synthetic message for the actual hidden actions and edit cancellation.',
          },
        ])}
        sessionId={sessionId}
        user={{ name: 'Synthetic Sender With A Long Name', email: 'spacing-fixture@example.com' }}
        showSenderIdentity
        onEdit={async () => true}
      />
    </section>
  );
}
function Fixture({ kind }: { kind: 'plans' | 'media' | 'scoped' | 'user' }) {
  return (
    <div data-owned-message-content-spacing={kind} {...stylex.props(styles.frame)}>
      {kind === 'plans' ? (
        <PlanCountCases />
      ) : kind === 'media' ? (
        <Row name="media" items={[tool('media')]} />
      ) : kind === 'scoped' ? (
        <ScopedContentCases />
      ) : (
        <UserStates />
      )}
    </div>
  );
}
const meta = {
  title: 'Migration/OwnedMessageContentSpacing',
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
export const PlanCounts: Story = { args: { kind: 'plans' } };
export const ToolMedia: Story = { args: { kind: 'media' } };
export const ScopedContent: Story = { args: { kind: 'scoped' } };
export const UserActions: Story = { args: { kind: 'user' } };
