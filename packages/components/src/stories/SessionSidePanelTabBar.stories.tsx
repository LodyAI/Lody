import * as stylex from '@stylexjs/stylex';
import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PanelRight } from 'lucide-react';
import {
  getSidePanelTabCloseFallback,
  SessionSidePanelEmptyState,
  SessionSidePanelTabBar,
  type SessionSidePanelOption,
  type SessionSidePanelTabItem,
} from '@/components/sessions/session-side-panel-tab-bar';
import { Button } from '@lody/ui/button';

const storyOverrides = stylex.create({
  border: {
    borderBottomWidth: 1,
    borderBottomStyle: 'solid',
    borderBottomColor: 'color-mix(in oklab, hsl(var(--border)) 60%, transparent)',
  },
  tall: { height: 'calc(var(--spacing) * 11)' },
});

const storyLayoutStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
});

const storyLayout = stylex.create({
  frame: {
    'min-height': '100vh',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 8)',
    color: 'hsl(var(--foreground) / 1)',
  },
  frame2: {
    'min-height': 'calc(var(--spacing) * 0)',
    flex: '1',
  },
});

const ALL_PANELS: SessionSidePanelOption[] = [
  { id: 'side-session', label: 'Side Chat', kind: 'session' },
  { id: 'files', label: 'Files', kind: 'files' },
  { id: 'changes', label: 'All Changes', kind: 'changes' },
  { id: 'browser', label: 'Browser', kind: 'browser' },
  { id: 'ios-simulator', label: 'iOS Simulator', kind: 'ios-simulator' },
  { id: 'pr', label: 'PR', kind: 'pr' },
];
const INITIAL_TABS: SessionSidePanelTabItem[] = [
  { ...ALL_PANELS[1]!, closeable: true },
  {
    id: 'side-session:one',
    label: '(fork) Fix login race',
    kind: 'session',
    closeable: true,
  },
  {
    id: 'side-session:two',
    label: '(fork) Review tests',
    kind: 'session',
    closeable: true,
  },
  { ...ALL_PANELS[2]!, closeable: true },
  {
    id: 'file:src/app.tsx',
    label: 'app.tsx',
    kind: 'file',
    filePath: 'src/app.tsx',
    closeable: true,
    dirty: true,
  },
  { id: 'diff:turn-1', label: 'Conversation Diff', kind: 'diff', closeable: true },
];

function SidePanelTabBarStory({ pending = false }: { pending?: boolean }) {
  const [tabs, setTabs] = useState(() =>
    INITIAL_TABS.map((tab, index) => (pending && index === 1 ? { ...tab, pending: true } : tab))
  );
  const [activeTabId, setActiveTabId] = useState<string | null>('file:src/app.tsx');
  const sideSessionCountRef = useRef(2);
  const openedPanelIds = new Set(tabs.map((tab) => tab.id));
  const availablePanels = ALL_PANELS.filter(
    (panel) => panel.id === 'side-session' || !openedPanelIds.has(panel.id)
  );

  return (
    <div {...stylex.props(storyLayout.frame)}>
      <div className="flex h-[520px] w-[620px] flex-col overflow-hidden border-l border-border/70 bg-background">
        <SessionSidePanelTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          availablePanels={availablePanels}
          onTabSelect={setActiveTabId}
          onPanelOpen={(panelId) => {
            if (panelId === 'side-session') {
              sideSessionCountRef.current += 1;
              const id = `side-session:${sideSessionCountRef.current}`;
              setTabs((current) => [
                ...current,
                {
                  id,
                  label: `(fork) Side Chat ${sideSessionCountRef.current}`,
                  kind: 'session',
                  closeable: true,
                },
              ]);
              setActiveTabId(id);
              return;
            }
            const panel = ALL_PANELS.find((candidate) => candidate.id === panelId);
            if (!panel) return;
            setTabs((current) => [...current, { ...panel, closeable: true }]);
            setActiveTabId(panelId);
          }}
          onTabClose={(tabId) => {
            const fallbackTabId = getSidePanelTabCloseFallback(
              tabs.map((tab) => tab.id),
              tabId
            );
            setTabs((current) => current.filter((tab) => tab.id !== tabId));
            setActiveTabId((current) => (current === tabId ? fallbackTabId : current));
          }}
          addPanelLabel="Add panel"
          closeTabLabel={(label) => `Close ${label}`}
          endSlot={
            <Button variant="ghost" size="small" icon>
              <PanelRight {...stylex.props(storyLayoutStyles.frame)} />
            </Button>
          }
          xstyle={storyOverrides.border}
        />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {tabs.find((tab) => tab.id === activeTabId)?.label}
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Sessions/SessionSidePanelTabBar',
  component: SessionSidePanelTabBar,
  parameters: { layout: 'fullscreen' },
  args: {
    tabs: INITIAL_TABS,
    activeTabId: 'files',
    availablePanels: ALL_PANELS,
    onTabSelect: () => {},
    onTabClose: () => {},
    onPanelOpen: () => {},
    addPanelLabel: 'Add panel',
    closeTabLabel: (label: string) => `Close ${label}`,
  },
} satisfies Meta<typeof SessionSidePanelTabBar>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UnifiedTabs: Story = {
  render: () => <SidePanelTabBarStory />,
};

export const PendingTab: Story = { render: () => <SidePanelTabBarStory pending /> };

export const EmptyState: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.frame)}>
      <div className="flex h-[520px] w-[420px] flex-col overflow-hidden border-l border-border/70 bg-background">
        <SessionSidePanelTabBar
          tabs={[]}
          activeTabId={null}
          availablePanels={ALL_PANELS}
          onTabSelect={() => {}}
          onTabClose={() => {}}
          onPanelOpen={() => {}}
          addPanelLabel="Add panel"
          closeTabLabel={(label) => `Close ${label}`}
          endSlot={
            <Button variant="ghost" size="small" icon>
              <PanelRight {...stylex.props(storyLayoutStyles.frame)} />
            </Button>
          }
          xstyle={[storyOverrides.border, storyOverrides.tall]}
        />
        <div {...stylex.props(storyLayout.frame2)}>
          <SessionSidePanelEmptyState
            panels={ALL_PANELS}
            onPanelOpen={() => {}}
            title="Open a panel"
          />
        </div>
      </div>
    </div>
  ),
};
