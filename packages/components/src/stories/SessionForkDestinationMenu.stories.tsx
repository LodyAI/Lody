import * as stylex from '@stylexjs/stylex';
import { useLayoutEffect, useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react-vite';
import { GitFork } from 'lucide-react';

import {
  SessionForkDestinationMenu,
  type SessionForkWorktreeAvailability,
} from '@/components/sessions/session-fork-destination-menu';
import { Button } from '@lody/ui/button';
const storyLayoutStylesStyles = stylex.create({
  caption: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
});

const storyLayoutStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 3.5)',
    width: 'calc(var(--spacing) * 3.5)',
  },
});

const storyLayout = stylex.create({
  stack: {
    display: 'flex',
    'min-height': '220px',
    'flex-direction': 'column',
    'align-items': 'flex-start',
    'justify-content': 'flex-end',
    gap: 'calc(var(--spacing) * 3)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--foreground) / 1)',
  },
});

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
    <div data-spacing-scope={spacingScope} {...stylex.props(storyLayout.stack)}>
      <div {...stylex.props(storyLayoutStylesStyles.caption)}>Last choice: {lastChoice}</div>
      <SessionForkDestinationMenu
        open={open}
        onOpenChange={setOpen}
        worktreeAvailability={worktreeAvailability}
        nativeForkAvailable={nativeForkAvailable}
        onCopyContext={() => setLastChoice('copied')}
        onSelect={(destination) => setLastChoice(destination)}
      >
        <Button type="button" variant="ghost" aria-label="Fork session" size="small" icon>
          <GitFork {...stylex.props(storyLayoutStyles.frame)} />
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
