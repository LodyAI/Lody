import { useMemo } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  MobileAppIconSettings,
  type AppIconBridge,
} from '@/components/mobile/mobile-app-icon-settings';

function preview(color: string) {
  return `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="128" height="128"><rect width="128" height="128" rx="28" fill="${color}"/><circle cx="64" cy="64" r="28" fill="white"/></svg>`)}`;
}

function StoryShell({
  selected = 'default',
  mode = 'ready',
}: {
  selected?: string;
  mode?: 'ready' | 'pending' | 'error';
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
    <div className="max-w-[393px] bg-background py-4">
      <MobileAppIconSettings bridge={bridge} />
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
