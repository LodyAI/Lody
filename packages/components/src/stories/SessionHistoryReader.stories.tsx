import type { Meta, StoryObj } from '@storybook/react';
import { Provider, createStore } from 'jotai';
import { useLayoutEffect, useState } from 'react';
import { fn } from 'storybook/test';
import { WindowDragStrip } from '../ui/window-drag-region';
import { WorkspaceCard } from '../components/workspace-frame';
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
const styles = stylex.create({
  page: { height: '100dvh', minHeight: 0, position: 'relative', display: 'flex' },
});
function Preview({ children }: { children: React.ReactNode }) {
  const [store] = useState(createStore);
  return (
    <PlatformContext.Provider value={platform}>
      <Provider store={store}>
        <div {...stylex.props(styles.page)}>
          <WindowDragStrip />
          <WorkspaceCard>{children}</WorkspaceCard>
        </div>
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
    onCopy: fn(),
    onBack: fn(),
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

// Mock only the host environment. The card, drag strip, header and menus are production components.
export const MacWindow: Story = {
  args: { reserveMacTrafficLightInset: true },
  beforeEach: () => {
    const electron = window.__LODY_ELECTRON__;
    const priorPlatform = window.__LODY_PLATFORM__;
    window.__LODY_ELECTRON__ = true;
    window.__LODY_PLATFORM__ = { os: 'darwin', homeDir: '/Users/story' };
    return () => {
      window.__LODY_ELECTRON__ = electron;
      window.__LODY_PLATFORM__ = priorPlatform;
    };
  },
};
export const MacWindowChinese: Story = {
  ...MacWindow,
  globals: { locale: 'zh_CN' },
  args: { ...MacWindow.args, title: '未共享机器上的历史会话' },
};
function NarrowWindow({ children }: { children: React.ReactNode }) {
  useLayoutEffect(() => {
    // Resize the manager's real preview iframe, preserving the desktop layout family.
    const frame = window.frameElement as HTMLElement | null;
    if (!frame) return undefined;
    const properties = ['width', 'min-width', 'max-width'] as const;
    const prior = properties.map(
      (name) =>
        [name, frame.style.getPropertyValue(name), frame.style.getPropertyPriority(name)] as const
    );
    for (const name of properties) frame.style.setProperty(name, '390px', 'important');
    window.dispatchEvent(new Event('resize'));
    return () => {
      for (const [name, value, priority] of prior) frame.style.setProperty(name, value, priority);
      window.dispatchEvent(new Event('resize'));
    };
  }, []);
  return children;
}
export const NarrowMacWindow: Story = {
  ...MacWindow,
  decorators: [
    (Story) => (
      <NarrowWindow>
        <Story />
      </NarrowWindow>
    ),
  ],
};
export const NarrowMacWindowChinese: Story = {
  ...NarrowMacWindow,
  globals: { locale: 'zh_CN' },
  args: MacWindowChinese.args,
};
