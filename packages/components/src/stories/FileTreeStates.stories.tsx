import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { CloudOff, FileWarning, FolderOpen, RefreshCw } from 'lucide-react';
import {
  FileTreeSkeleton,
  FileTreeStatePanel,
} from '@/components/sessions/components/file-tree-states';
import { Button } from '@lody/ui/button';
const sceneStyles = stylex.create({
  retryGlyph: { width: 'calc(var(--spacing) * 3.5)', height: 'calc(var(--spacing) * 3.5)' },
});

const storyLayout = stylex.create({
  frame: {
    height: '560px',
    width: '320px',
    overflow: 'hidden',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'hsl(var(--border) / 1)',
    'background-color': 'hsl(var(--background) / 1)',
  },
});

const meta = {
  title: 'Sessions/FileTreeStates',
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div {...stylex.props(storyLayout.frame)}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  render: () => <FileTreeSkeleton />,
};

export const Empty: Story = {
  render: () => (
    <FileTreeStatePanel
      icon={FolderOpen}
      title="No files here"
      description="This directory is empty."
    />
  ),
};

export const Unavailable: Story = {
  render: () => (
    <FileTreeStatePanel
      icon={CloudOff}
      title="Files unavailable"
      description="We couldn't reach the code session for this workspace. They'll appear once it reconnects."
    />
  ),
};

export const Error: Story = {
  render: () => (
    <FileTreeStatePanel
      icon={FileWarning}
      tone="error"
      title="Couldn't load files"
      description="Permission denied while reading the project directory."
    />
  ),
};

export const ErrorWithRetry: Story = {
  render: () => (
    <FileTreeStatePanel
      icon={FileWarning}
      tone="error"
      title="Couldn't load files"
      description="Permission denied while reading the project directory."
      action={
        <Button variant="secondary" size="small">
          <RefreshCw {...stylex.props(sceneStyles.retryGlyph)} />
          Try again
        </Button>
      }
    />
  ),
};
