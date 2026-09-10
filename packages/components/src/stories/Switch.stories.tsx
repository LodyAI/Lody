import type { Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
import { Switch } from '@/ui/switch';
import { useTheme } from '@/theme-provider';
import { Field as UiField } from '@lody/ui/field';

const meta = {
  title: 'UI/Switch',
  component: Switch,
  parameters: {
    layout: 'centered',
  },
} satisfies Meta<typeof Switch>;

export default meta;
type Story = StoryObj<typeof meta>;

function SwitchShowcase({ mode }: { mode: 'dark' | 'light' }) {
  const { setTheme } = useTheme();

  useEffect(() => {
    setTheme(mode);
  }, [mode, setTheme]);

  return (
    <div className="min-w-[320px] space-y-6 rounded-lg bg-background p-6 text-foreground">
      <h2 className="text-sm font-semibold">Lody {mode}</h2>
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <UiField.Label className="text-sm">Disabled toggle (off)</UiField.Label>
          <Switch />
        </div>
        <div className="flex items-center justify-between">
          <UiField.Label className="text-sm">Enabled toggle (on)</UiField.Label>
          <Switch defaultChecked />
        </div>
        <div className="flex items-center justify-between">
          <UiField.Label className="text-sm text-muted-foreground">Disabled state</UiField.Label>
          <Switch disabled />
        </div>
        <div className="flex items-center justify-between">
          <UiField.Label className="text-sm text-muted-foreground">Disabled checked</UiField.Label>
          <Switch disabled defaultChecked />
        </div>
      </div>
    </div>
  );
}

export const Default: Story = {
  render: () => <SwitchShowcase mode="light" />,
  globals: { theme: 'light' },
};

export const DefaultDark: Story = {
  render: () => <SwitchShowcase mode="dark" />,
  globals: { theme: 'dark' },
};
