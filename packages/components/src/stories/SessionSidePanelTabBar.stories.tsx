import { useRef, useState, type CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { PanelRight } from 'lucide-react';
import {
  getSidePanelTabCloseFallback,
  SessionSidePanelEmptyState,
  SessionSidePanelTabBar,
  type SessionSidePanelOption,
  type SessionSidePanelTabItem,
  type SidePanelTabSplit,
} from '@/components/sessions/session-side-panel-tab-bar';
import { Button } from '@lody/ui/button';
import {
  SIDE_PANEL_SPLIT_RATIO_VAR,
  SidePanelSplitHandle,
} from '@/components/sessions/side-panel-split-handle';

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

const DEVICE_TABS: SessionSidePanelTabItem[] = [
  { id: 'files', label: 'Files', kind: 'files', closeable: true },
  { id: 'ios-simulator', label: 'iOS Simulator', kind: 'ios-simulator', closeable: true },
  { id: 'browser', label: 'Browser', kind: 'browser', closeable: true },
  { id: 'android-emulator', label: 'Android Emulator', kind: 'android-emulator', closeable: true },
];

function DeviceSplitStory({ initialSplit }: { initialSplit: SidePanelTabSplit | null }) {
  const [tabs, setTabs] = useState(DEVICE_TABS);
  const [activeTabId, setActiveTabId] = useState<string | null>('ios-simulator');
  const [split, setSplit] = useState<SidePanelTabSplit | null>(initialSplit);
  const [ratio, setRatio] = useState(0.5);
  const splitShown = split?.includes(activeTabId ?? '') ?? false;
  const shownIds = splitShown && split ? split : [activeTabId];

  return (
    <div className="min-h-screen bg-background p-8 text-foreground">
      <div className="flex h-[520px] w-[720px] flex-col overflow-hidden border-l border-border/70 bg-background">
        <SessionSidePanelTabBar
          tabs={tabs}
          activeTabId={activeTabId}
          onTabSelect={setActiveTabId}
          onTabClose={(tabId) => {
            setTabs((current) => current.filter((tab) => tab.id !== tabId));
            setSplit((current) => (current?.includes(tabId) ? null : current));
            setActiveTabId((current) =>
              current === tabId
                ? getSidePanelTabCloseFallback(
                    tabs.map((tab) => tab.id),
                    tabId
                  )
                : current
            );
          }}
          closeTabLabel={(label) => `Close ${label}`}
          split={split}
          onTabsSplit={(next, draggedTabId) => {
            setSplit(next);
            setActiveTabId(draggedTabId);
          }}
          onTabUnsplit={(tabId) => {
            setSplit(null);
            setActiveTabId(tabId);
          }}
          className="border-b border-border/60"
        />
        <div
          className="relative flex flex-1 divide-x divide-border/70 text-sm text-muted-foreground"
          style={{ [SIDE_PANEL_SPLIT_RATIO_VAR]: ratio } as CSSProperties}
        >
          {shownIds.map((id, index) => (
            <div
              key={id}
              className="flex items-center justify-center"
              style={{
                flexBasis:
                  shownIds.length > 1 ? `${(index === 0 ? ratio : 1 - ratio) * 100}%` : '100%',
              }}
            >
              {tabs.find((tab) => tab.id === id)?.label}
            </div>
          ))}
          {splitShown ? (
            <SidePanelSplitHandle
              ratio={ratio}
              label="Resize split view"
              onRatioChange={setRatio}
            />
          ) : null}
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

/** Drag one device tab onto the other to pair them; drag a member out to split them again. */
export const DeviceTabs: Story = {
  render: () => <DeviceSplitStory initialSplit={null} />,
};

export const DeviceSplit: Story = {
  render: () => <DeviceSplitStory initialSplit={['ios-simulator', 'android-emulator']} />,
};

export const EmptyState: Story = {
  render: () => (
    <div className="min-h-screen bg-background p-8 text-foreground">
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
          />
        </div>
      </div>
    </div>
  ),
};
