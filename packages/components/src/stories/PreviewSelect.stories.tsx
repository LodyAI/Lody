import * as stylex from '@stylexjs/stylex';
import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { Moon, Sun, Monitor } from 'lucide-react';
import { PreviewSelect } from '@/components/settings/preview-select';
import type { PreviewSelectOption } from '@/components/settings/preview-select';

const storyOverrides = stylex.create({ trigger: { width: '220px' } });

const storyLayoutStyles = stylex.create({
  frame: {
    height: 'calc(var(--spacing) * 4)',
    width: 'calc(var(--spacing) * 4)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 2)',
  },
});

const meta = {
  title: 'Settings/PreviewSelect',
  component: PreviewSelect,
  parameters: {
    layout: 'centered',
  },
  tags: ['autodocs'],
} satisfies Meta<typeof PreviewSelect>;

export default meta;
type Story = StoryObj<typeof meta>;

const simpleOptions: PreviewSelectOption<string>[] = [
  { value: 'option-a', label: 'Option A' },
  { value: 'option-b', label: 'Option B' },
  { value: 'option-c', label: 'Option C' },
];

const themeOptions: PreviewSelectOption<string>[] = [
  {
    value: 'light',
    label: (
      <div {...stylex.props(storyLayout.row)}>
        <Sun {...stylex.props(storyLayoutStyles.frame)} />
        <span>Light</span>
      </div>
    ),
  },
  {
    value: 'dark',
    label: (
      <div {...stylex.props(storyLayout.row)}>
        <Moon {...stylex.props(storyLayoutStyles.frame)} />
        <span>Dark</span>
      </div>
    ),
  },
  {
    value: 'system',
    label: (
      <div {...stylex.props(storyLayout.row)}>
        <Monitor {...stylex.props(storyLayoutStyles.frame)} />
        <span>System</span>
      </div>
    ),
  },
];

export const Basic: Story = {
  args: {
    value: 'option-a',
    options: simpleOptions,
    onPreview: () => {},
    onCommit: () => {},
    onCancel: () => {},
  },
};

export const WithIcons: Story = {
  args: {
    value: 'light',
    options: themeOptions,
    onPreview: () => {},
    onCommit: () => {},
    onCancel: () => {},
    triggerXstyle: storyOverrides.trigger,
  },
};

function InteractiveDemo() {
  const [value, setValue] = useState('light');
  const [previewValue, setPreviewValue] = useState<string | null>(null);

  return (
    <div className="space-y-4">
      <PreviewSelect
        value={value}
        options={themeOptions}
        onPreview={(v) => setPreviewValue(v)}
        onCommit={(v) => {
          setValue(v);
          setPreviewValue(null);
        }}
        onCancel={() => setPreviewValue(null)}
        triggerXstyle={storyOverrides.trigger}
      />
      <div className="text-sm text-muted-foreground">
        <div>Committed: {value}</div>
        {previewValue && <div>Previewing: {previewValue}</div>}
      </div>
    </div>
  );
}

export const Interactive: Story = {
  render: () => <InteractiveDemo />,
  args: {
    value: 'light',
    options: themeOptions,
    onPreview: () => {},
    onCommit: () => {},
    onCancel: () => {},
  },
};
