import React from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import * as stylex from '@stylexjs/stylex';
import {
  EnvVarsTextarea,
  type EnvCredentialEditMode,
} from '@/components/settings/env-vars-textarea';

const styles = stylex.create({ frame: { width: 420, maxWidth: '100%' } });
function Credentials({
  initialMode = 'keep',
  present = true,
}: {
  initialMode?: EnvCredentialEditMode;
  present?: boolean;
}) {
  const [mode, setMode] = React.useState(initialMode);
  const [value, setValue] = React.useState<Record<string, string>>({});
  return (
    <div {...stylex.props(styles.frame)}>
      <EnvVarsTextarea
        value={value}
        onChange={setValue}
        credentialEdit={{ present, mode, onModeChange: setMode, onEntriesChange: () => {} }}
      />
    </div>
  );
}
const meta = {
  title: 'Settings/Environment credentials',
  component: Credentials,
  parameters: { layout: 'centered' },
} satisfies Meta<typeof Credentials>;
export default meta;
type Story = StoryObj<typeof meta>;
export const KeepSaved: Story = { args: {} };
export const ReplaceAll: Story = { args: { initialMode: 'replace' } };
export const ChangeIndividualKeys: Story = { args: { initialMode: 'entries' } };
export const ClearAll: Story = { args: { initialMode: 'clear' } };
export const NoSavedVariables: Story = { args: { present: false } };
