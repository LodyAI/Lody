import { useLayoutEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { GitFork } from 'lucide-react';

import {
  SessionForkDestinationMenu,
  type SessionForkWorktreeAvailability,
} from '@/components/sessions/session-fork-destination-menu';
import { Button } from '@lody/ui/button';

function ForkTrigger({
  worktreeAvailability,
  nativeForkAvailable = true,
  spacingScope,
}: {
  spacingScope?: 'root' | 'subtree';
  nativeForkAvailable?: boolean;
  worktreeAvailability: SessionForkWorktreeAvailability;
}) {
  useLayoutEffect(() => {
    if (!spacingScope) return undefined;
    const target = spacingScope === 'root' ? document.documentElement : document.body;
    const previous = target.style.getPropertyValue('--spacing');
    target.style.setProperty('--spacing', '5px');
    return () => {
      if (previous) target.style.setProperty('--spacing', previous);
      else target.style.removeProperty('--spacing');
    };
  }, [spacingScope]);
  const [open, setOpen] = useState(true);
  const [lastChoice, setLastChoice] = useState<string>('none');
  return (
    <div
      data-spacing-scope={spacingScope}
      className="flex min-h-[220px] flex-col items-start justify-end gap-3 bg-background p-6 text-foreground"
    >
      <div className="text-xs text-muted-foreground">Last choice: {lastChoice}</div>
      <SessionForkDestinationMenu
        open={open}
        onOpenChange={setOpen}
        worktreeAvailability={worktreeAvailability}
        nativeForkAvailable={nativeForkAvailable}
        onCopyContext={() => setLastChoice('copied')}
        onSelect={(destination) => setLastChoice(destination)}
      >
        <Button type="button" variant="ghost" aria-label="Fork session" size="small" icon>
          <GitFork className="h-3.5 w-3.5" />
        </Button>
      </SessionForkDestinationMenu>
    </div>
  );
}

const meta = {
  title: 'Sessions/SessionForkDestinationMenu',
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

export const CopyOnly: Story = {
  args: { nativeForkAvailable: false, worktreeAvailability: 'hidden' },
};

export const CheckingGitRootSpacing: Story = {
  args: { worktreeAvailability: 'checking', spacingScope: 'root' },
};
export const CheckingGitSubtreeSpacing: Story = {
  args: { worktreeAvailability: 'checking', spacingScope: 'subtree' },
};
