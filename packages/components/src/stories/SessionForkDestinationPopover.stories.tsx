import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { GitFork } from 'lucide-react';

import {
  SessionForkDestinationPopover,
  type SessionForkWorktreeAvailability,
} from '@/components/sessions/session-fork-destination-menu';
import { Button } from '@lody/ui/button';

function ForkTrigger({
  worktreeAvailability,
}: {
  worktreeAvailability: SessionForkWorktreeAvailability;
}) {
  const [open, setOpen] = useState(true);
  const [lastChoice, setLastChoice] = useState<string>('none');
  return (
    <div className="flex min-h-[220px] flex-col items-start justify-end gap-3 bg-background p-6 text-foreground">
      <div className="text-xs text-muted-foreground">Last choice: {lastChoice}</div>
      <SessionForkDestinationPopover
        open={open}
        onOpenChange={setOpen}
        worktreeAvailability={worktreeAvailability}
        onSelect={(destination) => setLastChoice(destination)}
      >
        <Button type="button" variant="ghost" aria-label="Fork session" size="small" icon>
          <GitFork className="h-3.5 w-3.5" />
        </Button>
      </SessionForkDestinationPopover>
    </div>
  );
}

const meta = {
  title: 'Sessions/SessionForkDestinationPopover',
  component: ForkTrigger,
  parameters: { layout: 'centered' },
  tags: ['autodocs'],
  args: {
    worktreeAvailability: 'available',
  },
} satisfies Meta<typeof ForkTrigger>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Available: Story = {};

export const CheckingGit: Story = {
  args: { worktreeAvailability: 'checking' },
};
