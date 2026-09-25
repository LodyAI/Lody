import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';
import { fn } from 'storybook/test';

import { MobileSidebarDrawer } from '@/components/mobile/mobile-sidebar-drawer';
import { Button } from '@lody/ui/button';

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
    <div className="relative h-[640px] overflow-hidden border bg-muted/10">
      <div className="p-4">
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
        <div className="flex h-full flex-col bg-background p-4">
          <div className="text-sm font-semibold">Mobile sidebar</div>
          <div className="mt-3 space-y-2 text-sm text-muted-foreground">
            <div className="rounded-md border p-2">Navigation item</div>
            <div className="rounded-md border p-2">Sessions</div>
            <div className="rounded-md border p-2">Settings</div>
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
