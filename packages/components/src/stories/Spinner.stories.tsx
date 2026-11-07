import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { RefreshCw } from 'lucide-react';

import { Spinner } from '@lody/ui/spinner';
import { Spinner as IconSpinner } from '@/ui/spinner';

const storyOverrides = stylex.create({
  muted: { color: 'hsl(var(--muted-foreground))' },
  primary: { color: 'hsl(var(--primary))' },
  square: { width: 'calc(var(--spacing) * 4)', height: 'calc(var(--spacing) * 4)' },
});

const meta = {
  title: 'UI/Spinner',
  component: Spinner,
  tags: ['autodocs'],
} satisfies Meta<typeof Spinner>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    diameter: 'calc(var(--spacing) * 4)',
    className: stylex.props(storyOverrides.muted).className,
  },
};

export const SidebarWorking: Story = {
  args: { size: 'small', className: stylex.props(storyOverrides.primary).className },
};

/** `ui/spinner.tsx` puts the same spin on an arbitrary icon, at rest or in flight. */
export const RefreshIconAtRest: Story = {
  render: () => <IconSpinner icon={RefreshCw} spinning={false} xstyle={storyOverrides.square} />,
};

export const RefreshIconSpinning: Story = {
  render: () => <IconSpinner icon={RefreshCw} spinning xstyle={storyOverrides.square} />,
};
