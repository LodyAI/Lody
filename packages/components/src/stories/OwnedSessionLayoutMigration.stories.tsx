import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import { createStore, Provider } from 'jotai';
import { DesktopSessionDetailLayout } from '../components/sessions/desktop-session-detail-layout';
import { WorkspaceCard } from '../components/workspace-frame';
import { ForceDesktopLayoutProvider } from '../hooks/use-mobile';

const PANEL_STORAGE_KEY = 'react-resizable-panels:session-detail-panels';
const meta = {
  title: 'Sessions/OwnedSessionLayoutMigration',
  parameters: { layout: 'fullscreen' },
  loaders: [async () => window.localStorage.removeItem(PANEL_STORAGE_KEY)],
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

function Pane({ side }: { side: boolean }) {
  return (
    <section
      data-layout-pane={side ? 'secondary' : 'conversation'}
      style={{
        display: 'flex',
        height: '100%',
        minWidth: 0,
        flexDirection: 'column',
        padding: 12,
        gap: 12,
        borderLeft: side ? '1px solid hsl(var(--border))' : undefined,
      }}
    >
      <strong>{side ? 'Synthetic file preview' : 'Synthetic conversation'}</strong>
      <p style={{ margin: 0, overflowWrap: 'anywhere' }}>
        {side
          ? 'packages/synthetic-workspace/international-team/长路径与布局-contract.tsx'
          : 'Conversation content keeps its own column while the side panel opens or resizes.'}
      </p>
      <textarea
        aria-label={side ? 'Panel retained draft' : 'Conversation draft'}
        defaultValue={side ? 'Retained panel draft' : 'Synthetic unsent draft'}
        style={{
          width: '100%',
          boxSizing: 'border-box',
          minHeight: 80,
          resize: 'none',
          background: 'hsl(var(--background))',
          color: 'hsl(var(--foreground))',
          border: '1px solid hsl(var(--border))',
        }}
      />
      <button type="button" data-scope-item>
        {side ? 'Panel action' : 'Conversation action'}
      </button>
    </section>
  );
}

function Fixture({
  mode = 'open',
}: {
  mode?: 'open' | 'closed' | 'variables' | 'caller' | 'unanchored';
}) {
  const [store] = useState(createStore);
  const [sidebarOpen, setSidebarOpen] = useState(mode !== 'closed');
  const [restoreSeq, setRestoreSeq] = useState(0);
  const [request, setRequest] = useState<{ seq: number; minWidthPx: number } | null>(null);
  const scope =
    mode === 'variables'
      ? ({ '--spacing': '6px', '--sidebar-ring': '15 90% 45%' } as CSSProperties)
      : undefined;
  const restore = (open: boolean) => {
    setRestoreSeq((previous) => previous + 1);
    setSidebarOpen(open);
  };
  return (
    <Provider store={store}>
      <ForceDesktopLayoutProvider>
        <main
          data-session-layout-fixture={mode}
          data-sidebar-open={sidebarOpen}
          data-restore-seq={restoreSeq}
          style={{
            ...scope,
            display: 'flex',
            height: 680,
            minWidth: 0,
            flexDirection: 'column',
            color: 'hsl(var(--foreground))',
            background: 'hsl(var(--sidebar))',
          }}
        >
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, padding: 8 }}>
            <button type="button" onClick={() => setSidebarOpen((open) => !open)}>
              Toggle panel
            </button>
            <button type="button" onClick={() => restore(true)}>
              Restore open
            </button>
            <button type="button" onClick={() => restore(false)}>
              Restore closed
            </button>
            <button
              type="button"
              onClick={() => {
                setRequest((previous) => ({ seq: (previous?.seq ?? 0) + 1, minWidthPx: 500 }));
                setSidebarOpen(true);
              }}
            >
              Request 500px
            </button>
          </div>
          <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
            <WorkspaceCard
              anchored={mode !== 'unanchored'}
              className={
                mode === 'caller'
                  ? 'min-w-[360px] w-4/5 flex-none flex-row overflow-visible'
                  : undefined
              }
            >
              <DesktopSessionDetailLayout
                defaultSizes={{ main: 65, sidebar: 35 }}
                topBar={
                  <header
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      height: 40,
                      paddingInline: 12,
                      flexShrink: 0,
                      borderBottom: '1px solid hsl(var(--border))',
                    }}
                  >
                    Session tabs · synthetic-layout
                  </header>
                }
                chatSurfaces={<Pane side={false} />}
                terminalDock={
                  <footer style={{ padding: 8, borderTop: '1px solid hsl(var(--border))' }}>
                    Terminal dock remains in conversation
                  </footer>
                }
                secondaryPanel={<Pane side />}
                sidebarOpen={sidebarOpen}
                onSidebarCollapse={() => setSidebarOpen(false)}
                sidebarRestoreSeq={restoreSeq}
                sidebarMinWidthRequest={request}
                deleteConfirmDialog={null}
              />
            </WorkspaceCard>
          </div>
        </main>
      </ForceDesktopLayoutProvider>
    </Provider>
  );
}

export const Open: Story = { render: () => <Fixture /> };
export const Closed: Story = { render: () => <Fixture mode="closed" /> };
export const SubtreeVariables: Story = { render: () => <Fixture mode="variables" /> };
export const CallerOverrides: Story = { render: () => <Fixture mode="caller" /> };
export const Unanchored: Story = { render: () => <Fixture mode="unanchored" /> };
