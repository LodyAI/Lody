import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import * as stylex from '@stylexjs/stylex';
import { ContextSwitch, type SessionContextType } from '@/components/chat/context-switch';
import { useTheme } from '@/theme-provider';

const meta = {
  title: 'Migration/OwnedContextTypography',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;
const styles = stylex.create({
  canvas: {
    minHeight: '100vh',
    padding: 16,
    color: 'hsl(var(--foreground))',
    backgroundColor: 'hsl(var(--background))',
  },
  receipt: { display: 'block', marginTop: 16 },
});

function LongLabels({ scoped = false }: { scoped?: boolean }) {
  const [value, setValue] = useState<SessionContextType>('local');
  const { resolvedTheme } = useTheme();
  const variables = scoped
    ? ({
        '--spacing': '5px',
        '--text-sm': '17px',
        '--text-sm--line-height': '26px',
        '--tw-leading': '1.6',
        '--font-weight-medium': '640',
      } as CSSProperties)
    : undefined;
  return (
    <div {...stylex.props(styles.canvas)} style={variables} data-context-type-fixture="">
      <ContextSwitch
        value={value}
        onChange={setValue}
        tone={resolvedTheme === 'dark' ? 'dark' : 'light'}
        localLabel="Local development workspaces"
        githubLabel="GitHub organization repositories"
        chatLabel="Independent conversations"
        className={scoped ? 'max-w-none' : undefined}
        triggerJustifyClassName={scoped ? 'justify-start' : undefined}
      />
      <output aria-label="Selected context" {...stylex.props(styles.receipt)}>
        {value}
      </output>
    </div>
  );
}
export const LongTabLabels: Story = { render: () => <LongLabels /> };
export const ScopedLongTabLabels: Story = { render: () => <LongLabels scoped /> };
