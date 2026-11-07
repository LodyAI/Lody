import { clsx } from 'clsx';
import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { DesktopSessionDetailLayout } from '@/components/sessions/desktop-session-detail-layout';
import { Button } from '@lody/ui/button';
import { useSemanticActionRouter } from '@/lib/commands/use-semantic-action-router';
const sceneStyles = stylex.create({
  widthReadout: {
    marginLeft: 'calc(var(--spacing) * 1)',
    fontFamily: 'var(--font-mono)',
    fontVariantLigatures: 'var(--lody-font-ligatures, contextual)',
    fontWeight: 'var(--font-weight-medium)',
    color: 'hsl(var(--foreground) / 1)',
  },
  mainHeader: {
    display: 'flex',
    height: 'calc(var(--spacing) * 11)',
    alignItems: 'center',
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderColor: {
      default: 'hsl(var(--border) / 1)',
      ':is(:where(.group\\/close-scope)[data-lody-action-active="true"] *)':
        'hsl(var(--primary) / 1)',
    },
    paddingInline: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
  secondaryHeader: {
    height: 'calc(var(--spacing) * 11)',
    flexShrink: 0,
    borderBottomWidth: '1px',
    borderBottomStyle: 'solid',
    borderColor: {
      default: 'hsl(var(--border) / 1)',
      ':is(:where(.group\\/close-scope)[data-lody-action-active="true"] *)':
        'hsl(var(--primary) / 1)',
    },
    padding: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
});

const storyLayoutStyles = stylex.create({
  row: {
    display: 'flex',
    height: '100%',
    'align-items': 'center',
    'justify-content': 'center',
    'border-style': 'dashed',
    'border-width': '1px',
    'border-color': 'hsl(var(--border) / 1)',
    'background-color': 'hsl(var(--background) / 1)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  label: {
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  caption: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
  },
});

const storyLayout = stylex.create({
  stack: {
    display: 'flex',
    height: '100vh',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 2)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted) / 1) 30%, transparent)',
    padding: 'calc(var(--spacing) * 4)',
  },
  row: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
  frame: {
    'min-height': 'calc(var(--spacing) * 0)',
    flex: '1',
    'align-self': 'stretch',
  },
  stack2: {
    display: 'flex',
    height: '100%',
    'flex-direction': 'column',
  },
});

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
    <div ref={ref} {...stylex.props(storyLayoutStyles.row)}>
      {label}
      <span {...stylex.props(sceneStyles.widthReadout)}>{width}px</span>
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
  semanticShortcuts?: boolean;
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
  semanticShortcuts = false,
}: HarnessProps) {
  const actionRootRef = useRef<HTMLDivElement>(null);
  const [lastClosed, setLastClosed] = useState('none');
  const [sidebarOpen, setSidebarOpen] = useState(startOpen);
  const [empty, setEmpty] = useState(startEmpty);
  const [request, setRequest] = useState<{ seq: number; minWidthPx: number } | null>(null);

  const router = useSemanticActionRouter({
    rootRef: actionRootRef,
    enabled: semanticShortcuts,
    resetKey: 'story',
    defaultScopeId: 'conversation',
    scopes: {
      conversation: {
        close: () => {
          setLastClosed('conversation');
          return 'handled';
        },
      },
      'side-panel': {
        close: () => {
          setLastClosed(empty ? 'empty panel' : 'panel tab');
          setSidebarOpen(false);
          router.current?.activate('conversation');
          return 'handled';
        },
      },
    },
  });
  useEffect(() => {
    if (!semanticShortcuts) return undefined;
    const onKey = (event: KeyboardEvent) => {
      // Browser-safe substitute for the native close entry point in this story.
      if (event.key === 'F8') {
        event.preventDefault();
        router.current?.dispatch('close');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [semanticShortcuts, router]);

  const openPrTab = useCallback(() => {
    if (!sidebarOpen || empty) {
      setRequest((current) => ({ seq: (current?.seq ?? 0) + 1, minWidthPx: 500 }));
    }
    setSidebarOpen(true);
    setEmpty(false);
    router.current?.activate('side-panel');
  }, [empty, sidebarOpen, router]);

  return (
    <div {...stylex.props(storyLayout.stack)}>
      <div {...stylex.props(storyLayout.row)}>
        <Button size="small" onClick={openPrTab}>
          Open PR tab
        </Button>
        <Button variant="secondary" size="small" onClick={() => setSidebarOpen(false)}>
          Close sidebar
        </Button>
        <span {...stylex.props(storyLayoutStyles.label)}>container: {containerWidthPx}px</span>
      </div>
      {semanticShortcuts && (
        <p {...stylex.props(storyLayoutStyles.caption)}>
          Point at a pane and press F8 to close. Last closed: {lastClosed}
        </p>
      )}
      <div
        ref={actionRootRef}
        {...stylex.props(storyLayout.frame)}
        style={{ width: containerWidthPx, maxWidth: '100%' }}
      >
        <DesktopSessionDetailLayout
          defaultSizes={{ main: 100 - defaultSidebarSize, sidebar: defaultSidebarSize }}
          topBar={<div {...stylex.props(sceneStyles.mainHeader)}>Session tabs</div>}
          chatSurfaces={<WidthReadout label="Conversation" />}
          terminalDock={null}
          secondaryPanel={
            <div
              data-lody-action-scope="side-panel"
              className={clsx(stylex.props(storyLayout.stack2).className, 'group/close-scope')}
            >
              <div {...stylex.props(sceneStyles.secondaryHeader)}>Panel tabs</div>
              <WidthReadout label={empty ? 'Empty sidebar' : 'PR panel'} />
            </div>
          }
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

export const SemanticCloseTarget: Story = {
  args: { startOpen: true, containerWidthPx: 1200, semanticShortcuts: true },
};

export const SemanticCloseEmptyPanel: Story = {
  args: { startOpen: true, startEmpty: true, containerWidthPx: 1200, semanticShortcuts: true },
};
