import type { Meta, StoryObj } from '@storybook/react';
import { useRef, useState } from 'react';
import { fn } from 'storybook/test';
import { Folder, Github, MessageCircle, Settings, FileCode } from 'lucide-react';
import { MdChat, MdFolder, MdSettings } from 'react-icons/md';

import {
  MobileWorkspaceTabBar,
  type MobileBottomTabBarTabSpec,
} from '@/components/mobile/mobile-workspace-tabbar';

type HomeTab = 'local' | 'github' | 'chat';
type ProjectTab = 'chat' | 'files' | 'settings';

const homeTabs: MobileBottomTabBarTabSpec<HomeTab>[] = [
  {
    key: 'local',
    label: 'Local',
    ios: <Folder className="h-5 w-5" />,
    material: <MdFolder className="h-5 w-5" />,
  },
  {
    key: 'github',
    label: 'GitHub',
    ios: <Github className="h-5 w-5" />,
    material: <Github className="h-5 w-5" />,
  },
  {
    key: 'chat',
    label: 'Chat',
    ios: <MessageCircle className="h-5 w-5" />,
    material: <MdChat className="h-5 w-5" />,
  },
];

const projectTabs: MobileBottomTabBarTabSpec<ProjectTab>[] = [
  {
    key: 'chat',
    label: '会话',
    ios: <MessageCircle className="h-5 w-5" />,
    material: <MdChat className="h-5 w-5" />,
  },
  {
    key: 'files',
    label: '文件',
    ios: <FileCode className="h-5 w-5" />,
    material: <FileCode className="h-5 w-5" />,
  },
  {
    key: 'settings',
    label: '设置',
    ios: <Settings className="h-5 w-5" />,
    material: <MdSettings className="h-5 w-5" />,
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
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-0 sm:p-6">
      <div className="relative translate-z-0 h-dvh w-full overflow-hidden bg-background shadow-2xl sm:h-[min(852px,calc(100dvh-3rem))] sm:w-[393px] sm:rounded-[34px]">
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
          className="h-full overflow-y-auto p-4 pb-32"
        >
          <div className="mb-4 text-xs text-muted-foreground">
            selectedTab = <code>{String(selected)}</code> · theme = <code>{theme}</code>
            {scrollable ? ' · 滚动列表以触发 collapse' : ''}
          </div>
          {scrollable ? (
            <div className="space-y-3">
              {Array.from({ length: 40 }).map((_, i) => (
                <div
                  key={i}
                  className="h-16 rounded-xl border border-border/40 bg-card p-3 text-sm"
                >
                  Row {i + 1}
                </div>
              ))}
            </div>
          ) : (
            <div className="rounded-xl border border-border/40 bg-card p-6 text-sm">
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
