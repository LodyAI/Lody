import { useState } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import { Input } from '@lody/ui/input';
import { CatalogPrivateField } from '@/components/settings/agent-config-dialog';

const styles = stylex.create({ frame: { width: 420, maxWidth: '100%' } });
function PrivateField({
  initialMode = 'keep',
  present = true,
  disabled = false,
}: {
  initialMode?: 'keep' | 'replace' | 'clear';
  present?: boolean;
  disabled?: boolean;
}) {
  const [mode, setMode] = useState(initialMode),
    [value, setValue] = useState('');
  return (
    <div {...stylex.props(styles.frame)}>
      <CatalogPrivateField
        label="Custom command"
        present={present}
        mode={mode}
        disabled={disabled}
        onModeChange={(next) => {
          setMode(next);
          setValue('');
        }}
      >
        <Input
          aria-label="New custom command"
          value={value}
          onChange={(event) => setValue(event.target.value)}
        />
      </CatalogPrivateField>
    </div>
  );
}
const meta = {
  title: 'Settings/Private configuration field',
  component: PrivateField,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof PrivateField>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Keep: Story = { args: {} };
export const Replace: Story = { args: { initialMode: 'replace' } };
export const Clear: Story = { args: { initialMode: 'clear' } };
export const NoSavedValue: Story = { args: { present: false } };
export const Busy: Story = { args: { disabled: true } };
