import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { createLocalPlatformProvider, createStaticStore } from '@lody/platform';
import { PlatformContext } from '@lody/platform/react';
import type { SessionHistory, SessionId } from '@lody/shared';
import { SessionHistoryView } from '../components/sessions/session-history-reader';
import { createConversationViewFromHistory } from '../lib/conversation-view/create-conversation-view-from-history';

const platform = createLocalPlatformProvider({
  session: createStaticStore({ status: 'unauthenticated' }),
  workspaces: createStaticStore({ status: 'ready', workspaces: [], activeWorkspaceId: null }),
});
const sessionId = 'readable-owner-history' as SessionId;
const history: SessionHistory[] = [
  {
    id: 'question',
    role: 'user',
    timestamp: '2026-10-01T00:00:00Z',
    fileDiff: [],
    items: [{ type: 'text', text: 'What did we decide before I joined?' }],
  },
  {
    id: 'answer',
    role: 'assistant',
    timestamp: '2026-10-01T00:00:01Z',
    fileDiff: [],
    finished: true,
    items: [
      {
        type: 'text',
        text: 'All workspace members can read this history. Running another turn still requires the machine owner’s permission.',
      },
    ],
  },
];
const view = createConversationViewFromHistory({
  sessionId,
  getHistory: () => history,
  subscribe: () => () => {},
});
const emptyView = createConversationViewFromHistory({
  sessionId,
  getHistory: () => [],
  subscribe: () => () => {},
});
const styles = stylex.create({ page: { height: '100dvh', minHeight: 0 } });
function Preview({ children }: { children: React.ReactNode }) {
  const [store] = useState(createStore);
  return (
    <PlatformContext.Provider value={platform}>
      <Provider store={store}>
        <div {...stylex.props(styles.page)}>{children}</div>
      </Provider>
    </PlatformContext.Provider>
  );
}
const meta = {
  title: 'Sessions/ReadOnlyHistory',
  component: SessionHistoryView,
  parameters: { layout: 'fullscreen' },
  args: {
    sessionId,
    title: 'Workspace history on an unavailable machine',
    history: view,
    ready: true,
  },
  decorators: [
    (Story) => (
      <Preview>
        <Story />
      </Preview>
    ),
  ],
} satisfies Meta<typeof SessionHistoryView>;
export default meta;
type Story = StoryObj<typeof meta>;
export const History: Story = {};
export const Loading: Story = { args: { history: null, ready: false } };
export const Empty: Story = { args: { history: emptyView, ready: true } };
export const MachineOwnedFormat: Story = {
  args: { history: null, ready: false, requiresMachine: true },
};
