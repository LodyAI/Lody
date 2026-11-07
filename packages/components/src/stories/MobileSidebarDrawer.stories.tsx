import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';

import { MobileSidebarDrawer } from '@/components/mobile/mobile-sidebar-drawer';
import { Button } from '@lody/ui/button';
const drawerStory = stylex.create({
  copy: {
    marginTop: 'calc(var(--spacing) * 3)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
    ':is(*) > :not(:last-child)': {
      marginBlockStart: 0,
      marginBlockEnd: 'calc(var(--spacing) * 2)',
    },
  },
});
const storyLayoutStyles = stylex.create({
  frame: {
    position: 'relative',
    height: '640px',
    overflow: 'hidden',
    'border-style': 'solid',
    'border-width': '1px',
    'background-color': 'color-mix(in oklab, hsl(var(--muted) / 1) 10%, transparent)',
  },
  caption: {
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
  },
  canvas: {
    'border-radius': 'var(--radius-md)',
    'border-style': 'solid',
    'border-width': '1px',
    padding: 'calc(var(--spacing) * 2)',
  },
});

const storyLayout = stylex.create({
  canvas: {
    padding: 'calc(var(--spacing) * 4)',
  },
  stack: {
    display: 'flex',
    height: '100%',
    'flex-direction': 'column',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
});

function StoryShell({
  open,
  width,
  onOpenChange,
}: {
  open: boolean;
  width?: number;
  onOpenChange?: (open: boolean) => void;
}) {
  const [isOpen, setIsOpen] = useState(open);

  return (
    <div {...stylex.props(storyLayoutStyles.frame)}>
      <div {...stylex.props(storyLayout.canvas)}>
        <Button type="button" onClick={() => setIsOpen(true)}>
          Open drawer
        </Button>
      </div>
      <MobileSidebarDrawer
        open={isOpen}
        width={width}
        onOpenChange={(nextOpen) => {
          setIsOpen(nextOpen);
          onOpenChange?.(nextOpen);
        }}
      >
        <div {...stylex.props(storyLayout.stack)}>
          <div {...stylex.props(storyLayoutStyles.caption)}>Mobile sidebar</div>
          <div {...stylex.props(drawerStory.copy)}>
            <div {...stylex.props(storyLayoutStyles.canvas)}>Navigation item</div>
            <div {...stylex.props(storyLayoutStyles.canvas)}>Sessions</div>
            <div {...stylex.props(storyLayoutStyles.canvas)}>Settings</div>
          </div>
        </div>
      </MobileSidebarDrawer>
    </div>
  );
}

const meta = {
  title: 'Components/MobileSidebarDrawer',
  component: StoryShell,
  parameters: {
    layout: 'padded',
  },
  tags: ['autodocs'],
  args: {
    open: true,
    width: 280,
    onOpenChange: fn(),
  },
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Open: Story = {};

export const Closed: Story = {
  args: {
    open: false,
  },
};
