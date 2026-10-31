import type { Meta, StoryObj } from '@storybook/react';

import { SidebarFabricBackdrop, SidebarFabricBand } from '@/components/fabric/sidebar-fabric';

/**
 * The layers read `--sidebar-background` from the document root, so this
 * story only demonstrates layout/stacking; theme-following is exercised in
 * the LoroSidebar story with real theme tokens.
 */
function Panel({ label, fabricClassName }: { label: string; fabricClassName?: string }) {
  return (
    <div
      style={{
        position: 'relative',
        width: 280,
        height: 420,
        borderRadius: 16,
        overflow: 'hidden',
        background: 'hsl(var(--sidebar-background))',
        color: 'hsl(var(--sidebar-foreground))',
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <SidebarFabricBackdrop className={fabricClassName} />
      <div style={{ flex: 1, padding: 16, fontSize: 13 }}>
        <div style={{ fontWeight: 600, marginBottom: 8 }}>{label}</div>
        <div style={{ opacity: 0.65 }}>
          List content sits above the whisper-level backdrop. Muted text like this must stay
          readable on top of the weave.
        </div>
      </div>
      <div
        data-fabric-pointer-scope=""
        style={{
          position: 'relative',
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '10px 16px',
          borderTop: '1px solid hsl(var(--sidebar-border))',
        }}
      >
        <SidebarFabricBand className={fabricClassName} />
        <span style={{ fontSize: 12, opacity: 0.8 }}>⚙</span>
        <span style={{ fontSize: 12, opacity: 0.8 }}>?</span>
        <span style={{ fontSize: 12, opacity: 0.8 }}>▣</span>
        <span style={{ fontSize: 11, opacity: 0.55, marginLeft: 'auto' }}>hover me</span>
      </div>
    </div>
  );
}

function StoryShell() {
  return (
    <div
      style={{
        minHeight: '100dvh',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 24,
        background: '#0a0a0c',
      }}
    >
      <Panel label="Sidebar fabric layers" />
    </div>
  );
}

const meta = {
  title: 'Effects/SidebarFabric',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {};

export const PublicCanvasPointerVariants: Story = {
  render: () => (
    <div
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 24,
        padding: 24,
        minHeight: '100dvh',
        background: 'hsl(var(--background))',
      }}
    >
      <Panel
        label="Zero-specificity public canvas selector"
        fabricClassName="z-10 [:where(&_canvas)]:pointer-events-auto"
      />
      <Panel
        label="Higher-specificity public canvas selector"
        fabricClassName="z-10 [&_canvas]:pointer-events-auto"
      />
    </div>
  ),
};
