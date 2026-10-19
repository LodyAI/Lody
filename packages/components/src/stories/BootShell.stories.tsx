import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { colors } from '@lody/ui/tokens/colors.stylex';
import { space } from '@lody/ui/tokens/scales.stylex';
import { BootShell, BootShellProvider } from '@/components/boot-shell';
import { WorkspaceCard } from '@/components/workspace-frame';
import { useIsCompactDesktop, useIsMobile } from '@/hooks/use-mobile';
import { LoadingPlaceholder } from '@/components/loading-placeholder';

const meta = {
  title: 'Components/BootShell',
  component: BootShell,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof BootShell>;
export default meta;
type Story = StoryObj<typeof meta>;

export const WorkspaceWithSidebar: Story = { args: { sidebar: true, layout: 'workspace' } };
export const CollapsedWorkspace: Story = { args: { sidebar: false, layout: 'workspace' } };
export const MarkOnly: Story = { args: { sidebar: false, layout: 'plain' } };

const styles = stylex.create({
  controls: {
    position: 'fixed',
    bottom: space[3],
    left: space[3],
    zIndex: 40,
    display: 'flex',
    gap: space[2],
  },
  ground: {
    display: 'flex',
    width: '100%',
    height: '100svh',
    backgroundColor: 'hsl(var(--sidebar-background))',
  },
  sidebar: { width: '280px', flexShrink: 0, padding: space[4], color: colors.secondaryLabel },
  ready: { padding: space[6], color: colors.label },
});

type Phase = 'entry' | 'workspace' | 'content' | 'ready' | 'recovery' | 'settings';
function EntryGate() {
  return <BootShell status="Opening Lody…" />;
}
function WorkspaceGate() {
  return <BootShell path="/example/chat" status="Opening workspace…" />;
}

/** Explicit controls keep slow startup, handoff and reversal observable without timers. */
function StartupTransition() {
  const [phase, setPhase] = useState<Phase>('entry');
  const [collapsed, setCollapsed] = useState(false);
  const [forceMobile, setForceMobile] = useState(false);
  const mobile = useIsMobile() || forceMobile;
  const compact = useIsCompactDesktop();
  const sidebarVisible = !collapsed && !mobile && !compact;
  const workspace = phase === 'workspace' || phase === 'content' || phase === 'ready';
  return (
    <>
      <BootShellProvider
        path={
          workspace ? '/example/chat' : phase === 'settings' ? '/example/settings/general' : '/'
        }
        sidebar={sidebarVisible}
        sidebarWidth={280}
        mobile={mobile}
      >
        {phase === 'entry' ? (
          <EntryGate />
        ) : phase === 'workspace' ? (
          <WorkspaceGate />
        ) : phase === 'settings' ? (
          <BootShell status="Opening settings…" />
        ) : phase === 'recovery' ? (
          <div {...stylex.props(styles.ready)}>
            <Button onClick={() => setPhase('entry')}>Retry startup</Button>
          </div>
        ) : (
          <div {...stylex.props(styles.ground)}>
            {sidebarVisible ? (
              <aside {...stylex.props(styles.sidebar)}>Example workspace</aside>
            ) : null}
            <WorkspaceCard anchored={sidebarVisible}>
              {phase === 'content' ? (
                <LoadingPlaceholder variant="content" title="Syncing workspace…" />
              ) : (
                <div {...stylex.props(styles.ready)}>
                  <label>
                    Message
                    <input aria-label="Message" defaultValue="Draft survives loading handoff" />
                  </label>
                </div>
              )}
            </WorkspaceCard>
          </div>
        )}
      </BootShellProvider>
      <div {...stylex.props(styles.controls)}>
        {(['entry', 'workspace', 'content', 'ready', 'recovery', 'settings'] as const).map(
          (value) => (
            <Button key={value} size="small" variant="secondary" onClick={() => setPhase(value)}>
              {value}
            </Button>
          )
        )}
        <Button size="small" variant="secondary" onClick={() => setCollapsed(!collapsed)}>
          Toggle sidebar
        </Button>
        <Button size="small" variant="secondary" onClick={() => setForceMobile(!forceMobile)}>
          Toggle mobile
        </Button>
      </div>
    </>
  );
}
export const Transition: Story = { render: () => <StartupTransition /> };
