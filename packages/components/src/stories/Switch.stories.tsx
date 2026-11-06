import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import { useEffect } from 'react';
import { Switch } from '@lody/ui/switch';
import { useTheme } from '@/theme-provider';
import { Field as UiField } from '@lody/ui/field';
import { field } from '@lody/ui/field/field.tokens.stylex';
const showcaseStyles = stylex.create({
  card: {
    minWidth: '320px',
    borderRadius: 'var(--radius-lg)',
    backgroundColor: 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
    color: 'hsl(var(--foreground) / 1)',
  },
  headingSpace: {
    marginBlockStart: 'calc(var(--spacing) * 0)',
    marginBlockEnd: 'calc(var(--spacing) * 6)',
  },
  rowSpace: {
    marginBlockStart: 'calc(var(--spacing) * 0)',
    marginBlockEnd: 'calc(var(--spacing) * 4)',
  },
  label: {
    [field.labelSize]: 'var(--text-sm)',
    [field.labelLeading]: 'var(--text-sm--line-height)',
  },
  mutedLabel: { [field.label]: 'hsl(var(--muted-foreground) / 1)' },
});
const storyLayoutStyles = stylex.create({
  caption: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-semibold)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'align-items': 'center',
    'justify-content': 'space-between',
  },
});

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
    <div {...stylex.props(showcaseStyles.card)}>
      <h2 {...stylex.props(storyLayoutStyles.caption, showcaseStyles.headingSpace)}>Lody {mode}</h2>
      <div>
        <div {...stylex.props(storyLayout.row, showcaseStyles.rowSpace)}>
          <UiField.Label className={stylex.props(showcaseStyles.label).className}>
            Disabled toggle (off)
          </UiField.Label>
          <Switch />
        </div>
        <div {...stylex.props(storyLayout.row, showcaseStyles.rowSpace)}>
          <UiField.Label className={stylex.props(showcaseStyles.label).className}>
            Enabled toggle (on)
          </UiField.Label>
          <Switch defaultChecked />
        </div>
        <div {...stylex.props(storyLayout.row, showcaseStyles.rowSpace)}>
          <UiField.Label
            className={stylex.props(showcaseStyles.label, showcaseStyles.mutedLabel).className}
          >
            Disabled state
          </UiField.Label>
          <Switch disabled />
        </div>
        <div {...stylex.props(storyLayout.row)}>
          <UiField.Label
            className={stylex.props(showcaseStyles.label, showcaseStyles.mutedLabel).className}
          >
            Disabled checked
          </UiField.Label>
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
