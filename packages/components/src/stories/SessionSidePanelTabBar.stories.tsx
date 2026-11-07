import * as stylex from '@stylexjs/stylex';
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
const storyLayoutStylesStyles = stylex.create({
  stack: {
    display: 'flex',
    height: '520px',
    width: '620px',
    flexDirection: 'column',
    overflow: 'hidden',
    borderLeftStyle: 'solid',
    borderLeftWidth: '1px',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 70%, transparent)',
    backgroundColor: 'hsl(var(--background) / 1)',
  },
  row: {
    display: 'flex',
    flex: '1',
    alignItems: 'center',
    justifyContent: 'center',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  stack2: {
    display: 'flex',
    height: '520px',
    width: '420px',
    flexDirection: 'column',
    overflow: 'hidden',
    borderLeftStyle: 'solid',
    borderLeftWidth: '1px',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 70%, transparent)',
    backgroundColor: 'hsl(var(--background) / 1)',
  },
});

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
import {
  SIDE_PANEL_SPLIT_RATIO_VAR,
  SidePanelSplitHandle,
} from '@/components/sessions/side-panel-split-handle';

const mergedStoryLayout = stylex.create({
  part1: {
    minHeight: '100vh',
    backgroundColor: 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 8)',
    color: 'hsl(var(--foreground) / 1)',
  },
  part2: {
    display: 'flex',
    height: 520,
    width: 720,
    flexDirection: 'column',
    overflow: 'hidden',
    borderLeftStyle: 'solid',
    borderLeftWidth: 1,
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 70%, transparent)',
    backgroundColor: 'hsl(var(--background) / 1)',
  },
  part3: {
    borderBottomStyle: 'solid',
    borderBottomWidth: 1,
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
  },
  part4: {
    position: 'relative',
    display: 'flex',
    flex: 1,
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
    ':is(*) > :not(:last-child)': {
      borderInlineEndStyle: 'solid',
      borderInlineEndWidth: 1,
      borderInlineEndColor: 'color-mix(in oklab, hsl(var(--border) / 1) 70%, transparent)',
    },
  },
  part5: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
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
      <div {...stylex.props(storyLayoutStylesStyles.stack)}>
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
        <div {...stylex.props(storyLayoutStylesStyles.row)}>
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
    <div {...stylex.props(mergedStoryLayout.part1)}>
      <div {...stylex.props(mergedStoryLayout.part2)}>
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
          xstyle={mergedStoryLayout.part3}
        />
        <div
          {...stylex.props(mergedStoryLayout.part4)}
          style={{ [SIDE_PANEL_SPLIT_RATIO_VAR]: ratio } as CSSProperties}
        >
          {shownIds.map((id, index) => (
            <div
              key={id}
              {...stylex.props(mergedStoryLayout.part5)}
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

export const PendingTab: Story = { render: () => <SidePanelTabBarStory pending /> };
/** Drag one device tab onto the other to pair them; drag a member out to split them again. */
export const DeviceTabs: Story = {
  render: () => <DeviceSplitStory initialSplit={null} />,
};

export const DeviceSplit: Story = {
  render: () => <DeviceSplitStory initialSplit={['ios-simulator', 'android-emulator']} />,
};

export const EmptyState: Story = {
  render: () => (
    <div {...stylex.props(storyLayout.frame)}>
      <div {...stylex.props(storyLayoutStylesStyles.stack2)}>
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
