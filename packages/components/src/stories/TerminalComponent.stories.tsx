import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { TerminalComponent } from '@/components/ai-gui/terminal-component';

const meta = {
  title: 'AI/TerminalComponent',
  component: TerminalComponent,
  parameters: {
    layout: 'fullscreen',
  },
  tags: ['autodocs'],
  decorators: [
    (Story) => (
      <div className="min-h-screen bg-muted/20 p-6">
        <div className="mx-auto w-full max-w-3xl">
          <Story />
        </div>
      </div>
    ),
  ],
} satisfies Meta<typeof TerminalComponent>;

export default meta;
type Story = StoryObj<typeof meta>;

const sampleTitle = 'Check user and home directory';
const sampleCommand = 'whoami && echo "HOME=$HOME" && ls -la /home/';
const sampleOutput = [
  'whoami: cannot find name for user ID 1001',
  'HOME=/home/developer',
  'total 8',
  'drwxr-xr-x  2 root root 4096 Jan 19 00:00 .',
  'drwxr-xr-x  1 root root 4096 Jan 19 00:00 ..',
].join('\n');

export const Basic: Story = {
  args: {
    title: sampleTitle,
    command: sampleCommand,
    output: sampleOutput,
  },
};

export const WithAnsi: Story = {
  args: {
    title: 'Build log',
    command: 'pnpm --filter @lody/components storybook',
    output: [
      '\u001b[90m[info]\u001b[0m Starting Storybook...',
      '\u001b[32m[success]\u001b[0m Local: http://localhost:6006',
      '\u001b[33m[warn]\u001b[0m Some warnings may be expected in dev.',
      '\u001b[31m[error]\u001b[0m Example error output for color rendering.',
    ].join('\n'),
  },
};

export const LongOutput: Story = {
  args: {
    title: 'Long output (click to focus)',
    command: 'rg -n "Terminal" packages/components/src/components/ai-gui/view.tsx',
    output: Array.from({ length: 80 }, (_, i) => `line ${String(i + 1).padStart(2, '0')}: output`)
      .concat(['', '...'])
      .join('\n'),
  },
};

export const NoInput: Story = {
  args: {
    title: 'Output only (no input line)',
    command: '',
    output: sampleOutput,
  },
};

export const EmptyOutput: Story = {
  args: {
    title: 'Empty output (renders a blank line)',
    command: sampleCommand,
    output: '',
  },
};
