import type { Meta, StoryObj } from '@storybook/react';
import { RefreshCw } from 'lucide-react';

import { Spinner } from '@/ui/spinner';

const meta = {
  title: 'UI/Spinner',
  component: Spinner,
  tags: ['autodocs'],
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: { className: 'h-4 w-4 text-muted-foreground' },
};

export const SidebarWorking: Story = {
  args: { className: 'h-3 w-3 text-primary' },
};

export const RefreshIconAtRest: Story = {
  args: { icon: RefreshCw, spinning: false, className: 'h-4 w-4' },
};

export const RefreshIconSpinning: Story = {
  args: { icon: RefreshCw, spinning: true, className: 'h-4 w-4' },
};
