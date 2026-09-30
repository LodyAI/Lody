import type { Meta, StoryObj } from '@storybook/react';
import { CloudOff, FileWarning, FolderOpen, RefreshCw } from 'lucide-react';
import {
  FileTreeSkeleton,
  FileTreeStatePanel,
} from '@/components/sessions/components/file-tree-states';
import { Button } from '@lody/ui/button';

const meta = {
  title: 'Sessions/FileTreeStates',
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="h-[560px] w-[320px] overflow-hidden border border-border bg-background">
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
          <RefreshCw className="h-3.5 w-3.5" />
          Try again
        </Button>
      }
    />
  ),
};
