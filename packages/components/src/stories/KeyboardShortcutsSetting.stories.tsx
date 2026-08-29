import type { Meta, StoryObj } from '@storybook/react';
import { KeyboardShortcutsSetting } from '@/components/settings/keyboard-shortcuts-setting';

if (typeof window !== 'undefined') {
  window.__LODY_ELECTRON__ = true;
  let appFocusBinding: string | null = 'Ctrl+Alt+l';
  window.ipc = {
    invoke: async (channel, ...args) => {
      if (channel === 'app.getGlobalShortcuts') {
        return [
          {
            id: 'app.focus',
            binding: appFocusBinding,
            defaultBinding: 'Ctrl+Alt+l',
          },
        ];
      }
      if (channel === 'app.setGlobalShortcut') {
        const input = args[0] as { id: string; binding: string | null };
        if (input.id === 'app.focus') {
          appFocusBinding = input.binding;
          return { ok: true, binding: appFocusBinding };
        }
        return { ok: false, error: 'invalid' };
      }
      if (channel === 'app.setGlobalShortcutsSuspended') return undefined;
      throw new Error(`unexpected invoke ${channel}`);
    },
    on: () => () => {},
    send: () => {},
  };
}

const meta = {
  title: 'Settings/KeyboardShortcutsSetting',
  component: KeyboardShortcutsSetting,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof KeyboardShortcutsSetting>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  render: () => (
    <div className="w-[560px] rounded-lg border border-border/60 bg-background p-4">
      <KeyboardShortcutsSetting />
    </div>
  ),
};
