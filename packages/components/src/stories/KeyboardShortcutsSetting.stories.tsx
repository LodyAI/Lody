import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { KeyboardShortcutsSetting } from '@/components/settings/keyboard-shortcuts-setting';
const storyLayout = stylex.create({
  frame: {
    width: '560px',
    'border-radius': 'var(--radius-lg)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 4)',
  },
});

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
    <div {...stylex.props(storyLayout.frame)}>
      <KeyboardShortcutsSetting />
    </div>
  ),
};
