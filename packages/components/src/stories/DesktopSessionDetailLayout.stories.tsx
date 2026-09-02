import type { Meta, StoryObj } from '@storybook/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import { Button } from '@lody/ui/button';

/* The layout persists panel sizes under this key (autoSaveId); clear it so
   every story starts from its declared defaultSizes, not a previous drag. */
const PANEL_STORAGE_KEY = 'react-resizable-panels:session-detail-panels';

/** Fills its panel and shows the measured pixel width — the whole point of
 *  these stories is how wide each column ends up. */
function WidthReadout({ label }: { label: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  useEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    setWidth(Math.round(el.getBoundingClientRect().width));
    const observer = new ResizeObserver(() => {
      setWidth(Math.round(el.getBoundingClientRect().width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return (
    <div
      ref={ref}
      className="flex h-full items-center justify-center border border-dashed border-border bg-background text-sm text-muted-foreground"
    >
      {label}
      <span className="ml-1 font-mono font-medium text-foreground">{width}px</span>
    </div>
  );
}

interface HarnessProps {
  /** Start with the sidebar collapsed — the "first expand" path. */
  startOpen: boolean;
  /** Show the sidebar empty state (no panel tabs) — the "empty" path. */
  startEmpty?: boolean;
  /** Stand-in for the window width; the width guard reads the group width. */
  containerWidthPx: number;
  /** Default sidebar split in percent (25 matches the app's fixed panel). */
  defaultSidebarSize?: number;
}

/**
 * Mirrors the relevant slice of session-detail.tsx: the "Open PR tab" action
 * requests a ≥500px sidebar only when the panel is collapsed or empty, then
 * opens it. Everything else (drag/close/reopen) is stock layout behavior.
 */
function LayoutHarness({
  startOpen,
  startEmpty = false,
  containerWidthPx,
  defaultSidebarSize = 25,
}: HarnessProps) {
  const [sidebarOpen, setSidebarOpen] = useState(startOpen);
  const [empty, setEmpty] = useState(startEmpty);
  const [request, setRequest] = useState<{ seq: number; minWidthPx: number } | null>(null);

  const openPrTab = useCallback(() => {
    if (!sidebarOpen || empty) {
      setRequest((current) => ({ seq: (current?.seq ?? 0) + 1, minWidthPx: 500 }));
    }
    setSidebarOpen(true);
    setEmpty(false);
  }, [empty, sidebarOpen]);

  return (
    <div className="flex h-screen flex-col gap-2 bg-muted/30 p-4">
      <div className="flex items-center gap-2">
        <Button size="small" onClick={openPrTab}>
          Open PR tab
        </Button>
        <Button variant="secondary" size="small" onClick={() => setSidebarOpen(false)}>
          Close sidebar
        </Button>
        <span className="text-xs text-muted-foreground">container: {containerWidthPx}px</span>
      </div>
      <div
        className="min-h-0 flex-1 self-stretch"
        style={{ width: containerWidthPx, maxWidth: '100%' }}
      >
        <DesktopSessionDetailLayout
          defaultSizes={{ main: 100 - defaultSidebarSize, sidebar: defaultSidebarSize }}
          topBar={
            <div className="flex h-11 items-center border-b border-border px-3 text-sm">
              Session tabs
            </div>
          }
          chatSurfaces={<WidthReadout label="Conversation" />}
          terminalDock={null}
          secondaryPanel={<WidthReadout label={empty ? 'Empty sidebar' : 'PR panel'} />}
          sidebarOpen={sidebarOpen}
          onSidebarCollapse={() => setSidebarOpen(false)}
          deleteConfirmDialog={null}
          sidebarMinWidthRequest={request}
        />
      </div>
    </div>
  );
}

const meta = {
  title: 'Sessions/DesktopSessionDetailLayout',
  component: LayoutHarness,
  parameters: {
    layout: 'fullscreen',
  },
  loaders: [
    async () => {
      window.localStorage.removeItem(PANEL_STORAGE_KEY);
    },
  ],
} satisfies Meta<typeof LayoutHarness>;

export default meta;
type Story = StoryObj<typeof meta>;

/** First expand: the sidebar was collapsed, so opening the PR tab asks for
 *  ≥500px instead of restoring the cramped default 25% split. */
export const OpenPrFromCollapsed: Story = {
  args: { startOpen: false, containerWidthPx: 1200 },
};

/** Empty state: the sidebar is open but shows no tabs; opening the PR tab
 *  raises it from the leftover 25% to 500px. */
export const OpenPrFromEmpty: Story = {
  args: { startOpen: true, startEmpty: true, containerWidthPx: 1200 },
};

/** Raising only: a panel already wider than 500px keeps the user's size. */
export const OpenPrKeepsWiderPanel: Story = {
  args: { startOpen: true, containerWidthPx: 1200, defaultSidebarSize: 45 },
};

/** Too narrow to spare 500px: the conversation would drop below its 500px
 *  floor, so the request is dropped and the default split is restored. */
export const OpenPrNarrowWindow: Story = {
  args: { startOpen: false, containerWidthPx: 900 },
};
