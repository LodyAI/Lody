import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { fn } from 'storybook/test';
import { Folder, Github, MessageCircle, Settings, FileCode } from 'lucide-react';
import { MdChat, MdFolder, MdSettings } from 'react-icons/md';

import {
  MobileWorkspaceTabBar,
  type MobileBottomTabBarTabSpec,
} from '@/components/mobile/mobile-workspace-tabbar';
const tabStory = stylex.create({
  scroll: {
    height: '100%',
    overflowY: 'auto',
    padding: 'calc(var(--spacing) * 4)',
    paddingBottom: 'calc(var(--spacing) * 32)',
  },
});
const storySpacing = stylex.create({
  children: {
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 3)',
    },
  },
});

const phoneFrame = stylex.create({
  frame: {
    height: { default: '100dvh', '@media (min-width: 40rem)': 'min(852px,calc(100dvh - 3rem))' },
    width: { default: '100%', '@media (min-width: 40rem)': '393px' },
    borderRadius: { default: null, '@media (min-width: 40rem)': '34px' },
    backgroundColor: 'hsl(var(--background) / 1)',
    boxShadow: '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
    overflow: 'hidden',
    position: 'relative',
    translate: '0 0 0',
  },
});

const storyViewport = stylex.create({
  canvas: {
    display: 'flex',
    minHeight: '100dvh',
    alignItems: 'center',
    justifyContent: 'center',
    '--story-device-canvas-components': '92.3% 0.003 48.717',
    backgroundColor: 'oklch(var(--story-device-canvas-components))',
    padding: { default: '0px', '@media (min-width: 40rem)': 'calc(var(--spacing) * 6)' },
  },
});

const storyLayout = stylex.create({
  caption: {
    'margin-bottom': 'calc(var(--spacing) * 4)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  frame: {
    height: 'calc(var(--spacing) * 16)',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 40%, transparent)',
    'background-color': 'hsl(var(--card) / 1)',
    padding: 'calc(var(--spacing) * 3)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
  },
  canvas: {
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 40%, transparent)',
    'background-color': 'hsl(var(--card) / 1)',
    padding: 'calc(var(--spacing) * 6)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
  },
});

type HomeTab = 'local' | 'github' | 'chat';
type ProjectTab = 'chat' | 'files' | 'settings';

const homeTabs: MobileBottomTabBarTabSpec<HomeTab>[] = [
  {
    key: 'local',
    label: 'Local',
    iconSize: 'calc(var(--spacing) * 5)',
    ios: <Folder />,
    material: <MdFolder />,
  },
  {
    key: 'github',
    label: 'GitHub',
    iconSize: 'calc(var(--spacing) * 5)',
    ios: <Github />,
    material: <Github />,
  },
  {
    key: 'chat',
    label: 'Chat',
    iconSize: 'calc(var(--spacing) * 5)',
    ios: <MessageCircle />,
    material: <MdChat />,
  },
];

const projectTabs: MobileBottomTabBarTabSpec<ProjectTab>[] = [
  {
    key: 'chat',
    label: '会话',
    iconSize: 'calc(var(--spacing) * 5)',
    ios: <MessageCircle />,
    material: <MdChat />,
  },
  {
    key: 'files',
    label: '文件',
    iconSize: 'calc(var(--spacing) * 5)',
    ios: <FileCode />,
    material: <FileCode />,
  },
  {
    key: 'settings',
    label: '设置',
    iconSize: 'calc(var(--spacing) * 5)',
    ios: <Settings />,
    material: <MdSettings />,
  },
];

function ShellShared<T extends string>({
  tabs,
  theme,
  hideNewChat,
  scrollable,
  signalScrolling,
  noSelection,
}: {
  tabs: MobileBottomTabBarTabSpec<T>[];
  theme: 'ios' | 'material';
  hideNewChat?: boolean;
  scrollable?: boolean;
  signalScrolling?: boolean;
  noSelection?: boolean;
}) {
  const [selected, setSelected] = useState<T | null>(noSelection ? null : tabs[0]!.key);
  const [scrollSignal, setScrollSignal] = useState({ scrollTop: 0, seq: 0 });
  const scrollRef = useRef<HTMLDivElement | null>(null);

  return (
    <div {...stylex.props(storyViewport.canvas)}>
      <div {...stylex.props(phoneFrame.frame)}>
        <div
          ref={scrollRef}
          data-testid="dock-scroll"
          onScroll={
            signalScrolling
              ? (event) => {
                  const scrollTop = event.currentTarget.scrollTop;
                  setScrollSignal((previous) => ({ scrollTop, seq: previous.seq + 1 }));
                }
              : undefined
          }
          {...stylex.props(tabStory.scroll)}
        >
          <div {...stylex.props(storyLayout.caption)}>
            selectedTab = <code>{String(selected)}</code> · theme = <code>{theme}</code>
            {scrollable ? ' · 滚动列表以触发 collapse' : ''}
          </div>
          {scrollable ? (
            <div {...stylex.props(storySpacing.children)}>
              {Array.from({ length: 40 }).map((_, i) => (
                <div key={i} {...stylex.props(storyLayout.frame)}>
                  Row {i + 1}
                </div>
              ))}
            </div>
          ) : (
            <div {...stylex.props(storyLayout.canvas)}>
              Mock content for the {String(selected)} tab.
            </div>
          )}
        </div>
        <MobileWorkspaceTabBar
          tabs={tabs}
          selectedTab={selected}
          onTabSelect={setSelected}
          onNewChat={hideNewChat ? undefined : fn()}
          theme={theme}
          scrollContainerRef={scrollable && !signalScrolling ? scrollRef : undefined}
          scrollSignal={signalScrolling ? scrollSignal : undefined}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileWorkspaceTabBar',
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const HomeIOS: Story = {
  render: () => <ShellShared tabs={homeTabs} theme="ios" />,
};

export const HomeMaterial: Story = {
  render: () => <ShellShared tabs={homeTabs} theme="material" />,
};

export const ProjectIOS: Story = {
  render: () => <ShellShared tabs={projectTabs} theme="ios" />,
};

export const WithoutNewChat: Story = {
  render: () => <ShellShared tabs={homeTabs} theme="ios" hideNewChat />,
};

export const ScrollCollapsing: Story = {
  render: () => <ShellShared tabs={homeTabs} theme="ios" scrollable />,
};

export const ScrollMaterial: Story = {
  render: () => <ShellShared tabs={homeTabs} theme="material" scrollable />,
};

export const SignalScrolling: Story = {
  render: () => <ShellShared tabs={projectTabs} theme="material" scrollable signalScrolling />,
};

export const ScrollWithoutNewChat: Story = {
  render: () => <ShellShared tabs={homeTabs.slice(0, 2)} theme="ios" scrollable hideNewChat />,
};

export const NoSelection: Story = {
  render: () => <ShellShared tabs={homeTabs} theme="ios" scrollable noSelection />,
};
