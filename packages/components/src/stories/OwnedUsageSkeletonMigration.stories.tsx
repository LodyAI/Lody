import * as stylex from '@stylexjs/stylex';
import { radius } from '@lody/ui/tokens/scales.stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useState, type CSSProperties } from 'react';
import { UsageCalendarSkeleton } from '@/components/settings/usage-calendar-skeleton';
import type { SettingsUsageRange } from '@/components/settings/settings-data-cache';

function Fixture({
  range = 'day',
  scope = 'default',
  maxWidth,
}: {
  range?: SettingsUsageRange;
  scope?: 'default' | 'root' | 'subtree' | 'mini-radius';
  maxWidth?: number;
}) {
  const [ready, setReady] = useState(false);
  useLayoutEffect(() => {
    const root = document.documentElement;
    const previous = root.style.getPropertyValue('--spacing');
    const priority = root.style.getPropertyPriority('--spacing');
    if (scope === 'root') root.style.setProperty('--spacing', '7px');
    setReady(true);
    return () => {
      if (scope !== 'root') return;
      if (previous) root.style.setProperty('--spacing', previous, priority);
      else root.style.removeProperty('--spacing');
    };
  }, [scope]);

  const hostStyle: CSSProperties = {
    width: '100%',
    maxWidth,
    ...(scope === 'subtree' ? ({ '--spacing': '7px' } as CSSProperties) : {}),
  };
  return (
    <div
      {...stylex.props(scope === 'mini-radius' && styles.miniRadius)}
      style={hostStyle}
      data-usage-skeleton-fixture={range}
      data-usage-skeleton-scope={scope}
      data-usage-skeleton-ready={ready}
      data-usage-skeleton-max-width={maxWidth}
    >
      <UsageCalendarSkeleton range={range} />
    </div>
  );
}

const meta = {
  title: 'Settings/OwnedUsageSkeletonMigration',
  component: Fixture,
  parameters: { layout: 'fullscreen' },
} satisfies Meta<typeof Fixture>;
export default meta;
type Story = StoryObj<typeof meta>;

export const Day: Story = { args: { range: 'day' } };
export const Week: Story = { args: { range: 'week' } };
export const Month: Story = { args: { range: 'month' } };
export const Year: Story = { args: { range: 'total' } };
export const RootSpacing: Story = { args: { range: 'day', scope: 'root' } };
export const SubtreeSpacing: Story = { args: { range: 'day', scope: 'subtree' } };
export const ContainerBelow: Story = { args: { range: 'total', maxWidth: 705 } };
export const ContainerBoundary: Story = { args: { range: 'total', maxWidth: 706 } };
export const ContainerAbove: Story = { args: { range: 'total', maxWidth: 707 } };

export const MiniRadiusDay: Story = { args: { range: 'day', scope: 'mini-radius' } };
export const MiniRadiusYear: Story = { args: { range: 'total', scope: 'mini-radius' } };

const styles = stylex.create({ miniRadius: { [radius.mini]: '11px' } });
