import { useRef, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PanelRight } from 'lucide-react';
import { SessionChangesSidebar } from '@/components/sessions/session-changes-sidebar';
import {
  getSidePanelTabCloseFallback,
  SessionSidePanelEmptyState,
  SessionSidePanelTabBar,
  type SessionSidePanelOption,
  type SessionSidePanelTabItem,
} from '@/components/sessions/session-side-panel-tab-bar';
import { CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE } from '@/lib/chat-workspace-geometry';
import { Button } from '@/ui/button';

const ALL_PANELS: SessionSidePanelOption[] = [
  { id: 'side-session', label: 'Side Chat', kind: 'session' },
  { id: 'files', label: 'Files', kind: 'files' },
  { id: 'changes', label: 'All Changes', kind: 'changes' },
  { id: 'browser', label: 'Browser', kind: 'browser' },
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

const GEOMETRY_CHANGE_ENTRIES = [
  { filePath: 'packages/components/src/components/sessions/session-detail.tsx', add: 60, del: 12 },
  { filePath: 'packages/components/src/lib/chat-workspace-geometry.ts', add: 40, del: 8 },
  { filePath: 'docs/session-layout.md', add: 60, del: 12 },
  { filePath: 'docs/geometry-validation.md', add: 40, del: 8 },
];

function SidePanelTabBarStory() {
  const [tabs, setTabs] = useState(INITIAL_TABS);
  const [activeTabId, setActiveTabId] = useState<string | null>('file:src/app.tsx');
  const sideSessionCountRef = useRef(2);
  const openedPanelIds = new Set(tabs.map((tab) => tab.id));
  const availablePanels = ALL_PANELS.filter(
    (panel) => panel.id === 'side-session' || !openedPanelIds.has(panel.id)
  );

  return (
    <div className="min-h-screen bg-background p-8 text-foreground">
      <div className="flex h-[520px] w-[620px] flex-col overflow-hidden rounded-xl border border-sidebar-border/80 bg-sidebar shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]">
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
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
              <PanelRight className="h-4 w-4" />
            </Button>
          }
          className="border-b border-border/60"
        />
        <div className="flex flex-1 items-center justify-center text-sm text-muted-foreground">
          {tabs.find((tab) => tab.id === activeTabId)?.label}
        </div>
      </div>
    </div>
  );
}

function RightSidePanelGeometryStory() {
  const tabs: SessionSidePanelTabItem[] = [
    { ...ALL_PANELS[1]!, closeable: true },
    { ...ALL_PANELS[2]!, closeable: true },
    {
      id: 'file:src/app.tsx',
      label: 'app.tsx',
      kind: 'file',
      filePath: 'src/app.tsx',
      closeable: true,
      dirty: true,
    },
  ];

  return (
    <div
      data-geometry-fixture-ready="true"
      className="flex h-screen justify-end bg-background p-2 text-foreground"
    >
      <div
        {...{ [CHAT_WORKSPACE_RAIL_DISCOVERY_ATTRIBUTE]: 'session.side-panel' }}
        className="flex h-full w-[420px] min-w-0 flex-col overflow-hidden rounded-xl border border-border/70 bg-background shadow-[0_1px_3px_-1px_rgba(15,17,21,0.08),0_1px_2px_rgba(15,17,21,0.04)]"
      >
        <SessionSidePanelTabBar
          tabs={tabs}
          activeTabId="changes"
          availablePanels={ALL_PANELS.filter(
            (panel) => panel.id === 'side-session' || !tabs.some((tab) => tab.id === panel.id)
          )}
          onTabSelect={() => {}}
          onTabClose={() => {}}
          onPanelOpen={() => {}}
          addPanelLabel="Add panel"
          closeTabLabel={(label) => `Close ${label}`}
          endSlot={
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
              <PanelRight className="h-4 w-4" />
            </Button>
          }
          className="h-11 border-b border-border/50 bg-background"
        />
        <div className="min-h-0 flex-1 overflow-hidden">
          <SessionChangesSidebar
            ready
            synced
            changeEntries={GEOMETRY_CHANGE_ENTRIES}
            changeFilePaths={GEOMETRY_CHANGE_ENTRIES.map((entry) => entry.filePath)}
            onOpenChangesDiff={() => {}}
          />
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

export const EmptyState: Story = {
  render: () => (
    <div className="min-h-screen bg-background p-8 text-foreground">
      <div className="flex h-[520px] w-[420px] flex-col overflow-hidden rounded-xl border border-sidebar-border/80 bg-background shadow-[0_1px_4px_-1px_rgba(0,0,0,0.18)]">
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
            <Button variant="ghost" size="icon" className="h-7 w-7 text-muted-foreground">
              <PanelRight className="h-4 w-4" />
            </Button>
          }
          className="h-11 border-b border-border/60"
        />
        <div className="min-h-0 flex-1">
          <SessionSidePanelEmptyState
            panels={ALL_PANELS}
            onPanelOpen={() => {}}
            title="Open a panel"
            description="Choose what you want to see in this sidebar."
          />
        </div>
      </div>
    </div>
  ),
};

export const GeometryReport: Story = {
  render: () => <RightSidePanelGeometryStory />,
};
