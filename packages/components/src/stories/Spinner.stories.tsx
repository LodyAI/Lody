import type { Meta, StoryObj } from '@storybook/react';
import { RefreshCw } from 'lucide-react';

import { Spinner } from '@lody/ui/spinner';
import { Spinner as IconSpinner } from '@/ui/spinner';

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
  args: { size: 'small', className: 'text-primary' },
};

/** `ui/spinner.tsx` puts the same spin on an arbitrary icon, at rest or in flight. */
export const RefreshIconAtRest: Story = {
  render: () => <IconSpinner icon={RefreshCw} spinning={false} className="h-4 w-4" />,
};

export const RefreshIconSpinning: Story = {
  render: () => <IconSpinner icon={RefreshCw} spinning className="h-4 w-4" />,
};
