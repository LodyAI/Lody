import type { Meta, StoryObj } from '@storybook/react';
import { useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { Button } from '@lody/ui/button';
import { ChatLandingView } from '@/components/chat/chat-landing-view';
import { SettingsStoryProviders } from './settings-story-shell';
import { themeColors } from '../style/theme-colors.stylex';

const styles = stylex.create({
  frame: {
    display: 'flex',
    flexDirection: 'column',
    height: 700,
    backgroundColor: themeColors.background,
    color: themeColors.foreground,
  },
  compact: { height: 380 },
  controls: { display: 'flex', alignItems: 'center', gap: 8, padding: 8, flexShrink: 0 },
  output: { fontSize: 12 },
  scopes: { display: 'flex', flexDirection: 'column', gap: 12 },
});

function CrashSelector({ fail }: { fail: boolean }) {
  if (fail) throw new globalThis.Error('Synthetic composer selector failure');
  return <span data-recovered-selector>Selector recovered</span>;
}

function FallbackFixture({
  tone = 'warning',
  message = 'Choose a project before sending.',
  isMobile = false,
  compact = false,
}: {
  tone?: 'warning' | 'error' | 'info';
  message?: string;
  isMobile?: boolean;
  compact?: boolean;
}) {
  const [prompt, setPrompt] = useState('Preserved draft.');
  const [fail, setFail] = useState(true);
  const [sent, setSent] = useState(0);
  return (
    <div
      data-composer-fallback-fixture
      data-selector-failing={fail}
      {...stylex.props(styles.frame, compact && styles.compact)}
    >
      <div {...stylex.props(styles.controls)}>
        <Button onClick={() => setFail(false)} disabled={!fail}>
          Allow retry
        </Button>
        <output {...stylex.props(styles.output)} data-fallback-result>
          Sent {sent}; {prompt}
        </output>
      </div>
      <ChatLandingView
        tone="light"
        isMobile={isMobile}
        title="Composer recovery"
        promptValue={prompt}
        onPromptChange={setPrompt}
        topSelector={<CrashSelector fail={fail} />}
        composerStatusMessage={message}
        composerStatusTone={tone}
        resetKeys={[fail]}
        onSubmit={() => setSent((count) => count + 1)}
      />
    </div>
  );
}

function ScopedPaletteFixture() {
  const root = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const status = root.current?.querySelector<HTMLElement>(
      '[data-fallback-scope=dark] [role=status]'
    );
    status?.style.setProperty('--color-amber-400', 'rgb(34 91 173)');
  }, []);
  return (
    <div
      ref={root}
      data-composer-fallback-palette
      {...stylex.props(styles.scopes)}
      style={
        {
          '--color-amber-600': 'rgb(111 47 189)',
          '--color-amber-400': 'rgb(20 142 107)',
        } as CSSProperties
      }
    >
      <div className="dark-scope" data-fallback-scope="dark">
        <FallbackFixture compact />
      </div>
      <div className="dark-scope">
        <div className="light-scope" data-fallback-scope="light">
          <FallbackFixture compact />
        </div>
      </div>
    </div>
  );
}

const meta = {
  title: 'Migration/OwnedComposerFallback',
  component: FallbackFixture,
  parameters: { layout: 'fullscreen' },
  decorators: [
    (Story) => (
      <SettingsStoryProviders>
        <Story />
      </SettingsStoryProviders>
    ),
  ],
} satisfies Meta<typeof FallbackFixture>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Warning: Story = {};
export const MobileWarning: Story = { args: { isMobile: true } };
export const LongWarning: Story = {
  args: {
    message:
      'Choose a project on the selected machine before sending this message. The current project is unavailable; select another project or reconnect the machine and try again.',
  },
};
export const Error: Story = { args: { tone: 'error', message: 'A project is required.' } };
export const Info: Story = { args: { tone: 'info', message: 'Select a project to continue.' } };
export const ScopedPalette: Story = { render: () => <ScopedPaletteFixture /> };
