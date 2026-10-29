import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useState } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { ChatComposer, getChatComposerTextareaClassName } from '@/components/chat/chat-composer';
import { CombinedMentionTextarea } from '@/components/mentions/combined-mention-textarea';
import { commands, registerBuiltInCommands } from '@/lib/commands';
import { SettingsStoryProviders } from './settings-story-shell';
import { themeColors } from '../style/theme-colors.stylex';

registerBuiltInCommands();

const styles = stylex.create({
  frame: {
    padding: 16,
    maxWidth: 720,
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  controls: { display: 'flex', gap: 8, marginBottom: 16 },
  output: { display: 'block', marginTop: 16, fontSize: 12, whiteSpace: 'pre-wrap' },
});

function InputFixture({
  variant = 'landing',
  fallback = false,
  outerGroup = false,
  disabled = false,
}: {
  variant?: 'landing' | 'session' | 'dialog';
  fallback?: boolean;
  outerGroup?: boolean;
  disabled?: boolean;
}) {
  const [value, setValue] = useState('');
  return (
    <div
      {...stylex.props(styles.frame)}
      data-composer-input-fixture
      data-input-path={fallback ? 'fallback' : 'mention'}
    >
      <div className={outerGroup ? 'group' : undefined} data-input-outer>
        <div {...stylex.props(styles.controls)}>
          <Button data-outer-focus>Focus outside composer</Button>
          <Button onClick={() => setValue('')} data-clear-input>
            Clear draft
          </Button>
        </div>
        {fallback ? (
          <CombinedMentionTextarea
            id="migration-composer-input"
            value={value}
            onValueChange={setValue}
            label="Plain message"
            disabled={disabled}
            placeholder="Write a message with the plain field branch."
            className={getChatComposerTextareaClassName({ tone: 'light', variant })}
          />
        ) : (
          <ChatComposer
            variant={variant}
            promptId="migration-composer-input"
            promptValue={value}
            onPromptChange={setValue}
            promptDisabled={disabled}
            promptPlaceholder="Write a message with the mention field branch."
            primaryAction={<Button disabled={disabled}>Send</Button>}
          />
        )}
      </div>
      <output {...stylex.props(styles.output)} data-input-value>
        {value || 'Empty draft'}
      </output>
    </div>
  );
}

function BoundInputFixture({ outerGroup = false }: { outerGroup?: boolean }) {
  const [bindingReady, setBindingReady] = useState(false);
  useLayoutEffect(() => {
    // The desktop default is Electron-only. A real registry registration keeps
    // this browser fixture's discovery hint reachable without changing runtime detection.
    const dispose = commands.register({
      id: 'session.focusInput',
      titleKey: 'commands.session.focusInput',
      title: 'Focus composer input',
      keybindings: ['Mod+Shift+y'],
      run: () => document.getElementById('migration-composer-input')?.focus(),
    });
    setBindingReady(true);
    return dispose;
  }, []);
  if (!bindingReady) return null;
  return <InputFixture outerGroup={outerGroup} />;
}

const meta = {
  title: 'Migration/OwnedComposerInput',
  component: InputFixture,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
} satisfies Meta<typeof InputFixture>;
export default meta;
type Story = StoryObj<typeof meta>;
export const Landing: Story = {};
export const Session: Story = { args: { variant: 'session' } };
export const Dialog: Story = { args: { variant: 'dialog' } };
export const OuterGroup: Story = { args: { outerGroup: true } };
export const Disabled: Story = { args: { disabled: true } };
export const PlainFallback: Story = { args: { fallback: true } };

export const KeyboardHint: Story = { render: () => <BoundInputFixture /> };
export const OuterGroupKeyboardHint: Story = { render: () => <BoundInputFixture outerGroup /> };
