import * as stylex from '@stylexjs/stylex';
import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  MobileAppIconSettings,
  type AppIconBridge,
} from '@/components/mobile/mobile-app-icon-settings';
const storyLayout = stylex.create({
  section: {
    'max-width': '393px',
    'background-color': 'hsl(var(--background) / 1)',
    'padding-block': 'calc(var(--spacing) * 4)',
  },
});

function preview(color: string) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="28" fill="${color}"/><circle cx="64" cy="64" r="28" fill="white"/></svg>`)}`;
}

function StoryShell({
  selected = 'default',
  mode = 'ready',
  layout = 'mobile',
}: {
  selected?: string;
  mode?: 'ready' | 'pending' | 'error';
  layout?: 'mobile' | 'desktop';
}) {
  const bridge = useMemo<AppIconBridge>(
    () => ({
      icons: [
        { name: 'default', previewUrl: preview('#333333') },
        { name: 'alternate', previewUrl: preview('#269dcc') },
      ],
      getState: async () => ({ supported: true, name: selected }),
      setIcon: async ({ name }) => {
        if (mode === 'error') throw new Error('Native icon change failed');
        if (mode === 'pending') return new Promise(() => {});
        return { supported: true, name };
      },
    }),
    [selected, mode]
  );
  return (
    <div {...stylex.props(storyLayout.section)}>
      <MobileAppIconSettings bridge={bridge} layout={layout} />
    </div>
  );
}

const meta = {
  title: 'Mobile/AppIconSettings',
  component: StoryShell,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof StoryShell>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Default: Story = {};
export const AlternateSelected: Story = { args: { selected: 'alternate' } };
export const ChangePending: Story = { args: { mode: 'pending' } };
export const ChangeFailure: Story = { args: { mode: 'error' } };
export const MacDesktop: Story = { args: { layout: 'desktop' } };
export const MacDesktopAlternate: Story = { args: { layout: 'desktop', selected: 'alternate' } };
export const MacDesktopFailure: Story = { args: { layout: 'desktop', mode: 'error' } };
