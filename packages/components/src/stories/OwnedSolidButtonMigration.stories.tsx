import type { Meta, StoryObj } from '@storybook/react';
import { useState, type CSSProperties } from 'react';
import { ArrowUp } from 'lucide-react';
import { Button, type ButtonProps } from '@lody/ui/button';
import { button } from '@lody/ui/button/button.tokens.stylex';
import * as stylex from '@stylexjs/stylex';
import { composerActionButtonTheme } from '../components/chat/composer-action-button.stylex';

const tokenName = (value: unknown) => String(value).slice(4, -1);

// The fixed composer action keeps its inherited control density and current
// element ink variables; arbitrary token-writing descendants are not consumers.
function ActionButton({ className, ...props }: Omit<ButtonProps, 'variant'>) {
  return (
    <Button
      {...props}
      variant="solid"
      className={[
        stylex.props(composerActionButtonTheme).className,
        'shadow-xs transition-all active:translate-y-[1px]',
        className,
      ]
        .filter(Boolean)
        .join(' ')}
    />
  );
}

type Scope = 'default' | 'palette' | 'writers' | 'caller' | 'inline-token';

function Fixture({ scope = 'default' }: { scope?: Scope }) {
  const [clicks, setClicks] = useState(0);
  const inherited: CSSProperties =
    scope === 'palette'
      ? {
          ['--foreground' as string]: '220 42% 26%',
          ['--background' as string]: '44 70% 91%',
          [tokenName(button.primaryBackground)]: 'rgb(235, 119, 41)',
          [tokenName(button.primaryLabel)]: 'rgb(55, 15, 110)',
        }
      : scope === 'writers'
        ? {
            ['--spacing' as string]: '5px',
            ['--tw-duration' as string]: '240ms',
            ['--tw-ease' as string]: 'linear',
            ['--tw-translate-x' as string]: '3px',
            ['--shadow-xs' as string]: '1px 3px 6px rgb(75 20 120 / 0.2)',
            [tokenName(button.gap)]: '11px',
            [tokenName(button.ringWidth)]: '3px',
            [tokenName(button.ring)]: 'rgb(174, 45, 160)',
          }
        : {};
  return (
    <main
      data-solid-owner-migration={scope}
      style={{
        padding: 24,
        minHeight: '100vh',
        color: 'hsl(var(--foreground))',
        backgroundColor: 'hsl(var(--background))',
        ...inherited,
      }}
    >
      <output data-solid-receipt>Clicks: {clicks}</output>
      <section style={{ display: 'flex', gap: 20, alignItems: 'center', marginBlock: 24 }}>
        <ActionButton
          data-solid-action
          icon
          shape="pill"
          size="small"
          aria-label="Owner action"
          onClick={() => setClicks((value) => value + 1)}
          className={
            scope === 'caller'
              ? 'bg-sky-200 text-fuchsia-700 hover:bg-sky-300 hover:text-fuchsia-800'
              : undefined
          }
          render={
            scope === 'inline-token' ? (
              <button style={{ [tokenName(button.primaryBackground)]: 'rgb(235, 119, 41)' }} />
            ) : undefined
          }
        >
          <ArrowUp style={{ width: 20, height: 20 }} />
        </ActionButton>
        <ActionButton icon shape="pill" size="medium" disabled aria-label="Owner disabled">
          <ArrowUp style={{ width: 20, height: 20 }} />
        </ActionButton>
      </section>
      <section data-unmodified-variants style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
        {(['primary', 'secondary', 'ghost', 'destructive', 'link'] as const).map((variant) => (
          <Button key={variant} variant={variant} data-original-variant={variant}>
            {variant}
          </Button>
        ))}
      </section>
    </main>
  );
}

const meta = {
  title: 'Migration/OwnedSolidButton',
  parameters: { layout: 'fullscreen' },
} satisfies Meta;
export default meta;
type Story = StoryObj<typeof meta>;

export const Owner: Story = { render: () => <Fixture /> };
export const LocalPalette: Story = { render: () => <Fixture scope="palette" /> };
export const LocalWriters: Story = { render: () => <Fixture scope="writers" /> };
export const CallerClasses: Story = { render: () => <Fixture scope="caller" /> };
export const InlineTokenNegativeControl: Story = {
  render: () => <Fixture scope="inline-token" />,
};
