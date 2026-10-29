import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { ChatComposer } from '@/components/chat/chat-composer';
import { SettingsStoryProviders } from './settings-story-shell';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: {
    padding: 16,
    maxWidth: 720,
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  output: { display: 'block', marginTop: 12, fontSize: 12 },
  scopes: { display: 'flex', flexDirection: 'column', gap: 16 },
});

function StatusFixture({
  variant = 'landing',
  tone = 'warning',
  message = 'Choose a project before sending.',
  id = 'status-prompt',
}: {
  variant?: 'landing' | 'session' | 'dialog';
  tone?: 'warning' | 'error' | 'info';
  message?: string;
  id?: string;
}) {
  const [prompt, setPrompt] = useState('Review the current changes.');
  const [sent, setSent] = useState(0);
  return (
    <div data-composer-status-fixture={id} {...stylex.props(styles.frame)}>
      <ChatComposer
        variant={variant}
        promptId={id}
        promptValue={prompt}
        onPromptChange={setPrompt}
        promptRows={1}
        statusMessage={message || undefined}
        statusTone={tone}
        primaryAction={
          <Button onClick={() => setSent((count) => count + 1)} aria-label="Send fixture">
            Send
          </Button>
        }
      />
      <output {...stylex.props(styles.output)} data-composer-status-result>
        Sent {sent}; {prompt}
      </output>
    </div>
  );
}

function ScopedPaletteFixture() {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const status = root.current?.querySelector<HTMLElement>(
      '[data-status-scope=self] [role=status]'
    );
    if (!status) return;
    status.classList.add('dark-scope');
    status.style.setProperty('--color-amber-600', 'rgb(171 45 51)');
    status.style.setProperty('--color-amber-400', 'rgb(34 91 173)');
  }, []);
  return (
    <div
      ref={root}
      data-composer-status-palette
      {...stylex.props(styles.scopes)}
      style={
        {
          '--color-amber-600': 'rgb(111 47 189)',
          '--color-amber-400': 'rgb(20 142 107)',
        } as CSSProperties
      }
    >
      <div className="dark-scope" data-status-scope="dark">
        <StatusFixture variant="session" id="status-dark" />
      </div>
      <div className="dark-scope">
        <div className="light-scope" data-status-scope="light">
          <StatusFixture variant="session" id="status-light" />
        </div>
      </div>
      <div data-status-scope="self">
        <StatusFixture variant="session" id="status-self" />
      </div>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedComposerStatus',
  component: StatusFixture,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
} satisfies Meta<typeof StatusFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const LandingWarning: Story = {};
export const SessionWarning: Story = { args: { variant: 'session' } };
export const DialogWarning: Story = { args: { variant: 'dialog' } };
export const LongWarning: Story = {
  args: {
    message:
      'Choose a project on the selected machine before sending this message. The current project is unavailable; select another project or reconnect the machine and try again.',
  },
};
export const Info: Story = { args: { tone: 'info', message: 'Select a project to continue.' } };
export const Error: Story = { args: { tone: 'error', message: 'A project is required.' } };
export const Absent: Story = { args: { message: '' } };
export const ScopedPalette: Story = { render: () => <ScopedPaletteFixture /> };
