import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';
import type { CSSProperties } from 'react';
import { CircleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '../ui/alert';

const callerStyles = stylex.create({
  capitalize: { textTransform: 'capitalize' },
  root: {
    position: 'relative',
    display: 'block',
    width: '75%',
    alignItems: 'center',
    rowGap: 'calc(var(--spacing) * 3)',
    borderRadius: 0,
    borderWidth: 4,
    borderColor: 'hsl(var(--status-info))',
    backgroundColor: 'color-mix(in oklab,hsl(var(--status-info)) 10%,transparent)',
    paddingInline: 'calc(var(--spacing) * 5)',
    paddingBlock: 'calc(var(--spacing) * 4)',
    fontSize: 17,
  },
  glyph: {
    width: 'calc(var(--spacing) * 6)',
    height: 'calc(var(--spacing) * 6)',
    translate: '0 calc(var(--spacing) * 1)',
    color: 'hsl(var(--status-info))',
  },
  title: {
    gridColumnStart: '1',
    minHeight: 'calc(var(--spacing) * 6)',
    fontWeight: 'var(--font-weight-normal)',
    lineHeight: 'calc(var(--spacing) * 6)',
    letterSpacing: 'var(--tracking-wide)',
  },
  description: {
    gridColumnStart: '1',
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--status-info))',
  },
  grid: { gridTemplateColumns: 'minmax(0,1fr)', columnGap: 'calc(var(--spacing) * 5)' },
});

const meta = {
  title: 'Code Review Helper/AlertMigration',
  component: Alert,
  parameters: { layout: 'fullscreen', controls: { disable: true } },
} satisfies Meta<typeof Alert>;

export default meta;
type Story = StoryObj<typeof meta>;
type Variant = React.ComponentProps<typeof Alert>['variant'];

function Scope({ children, dark }: { children: React.ReactNode; dark: boolean }) {
  const theme = {
    '--background': dark ? '220 10% 9%' : '0 0% 100%',
    '--foreground': dark ? '0 0% 93%' : '0 0% 10%',
    '--muted': dark ? '220 8% 22%' : '210 40% 96%',
    '--muted-foreground': dark ? '215 12% 69%' : '215 16% 42%',
    '--border': dark ? '220 12% 32%' : '214 32% 89%',
    '--status-danger': dark ? '0 80% 70%' : '0 74% 48%',
    '--status-warning': dark ? '30 95% 68%' : '30 95% 32%',
    '--status-info': dark ? '217 80% 72%' : '217 75% 42%',
    padding: 16,
    display: 'grid',
    gap: 16,
    minHeight: '100vh',
    alignContent: 'start',
    backgroundColor: 'hsl(var(--background))',
    color: 'hsl(var(--foreground))',
  } as CSSProperties;
  return (
    <main data-alert-migration data-theme={dark ? 'dark' : 'light'} style={theme}>
      {children}
    </main>
  );
}

function Contents({ icon = 'direct' }: { icon?: 'direct' | 'nested' | 'none' }) {
  return (
    <>
      {icon === 'direct' && <CircleAlert />}
      {icon === 'nested' && (
        <span>
          <CircleAlert />
        </span>
      )}
      <AlertTitle xstyle={callerStyles.capitalize}>review diagnostic</AlertTitle>
      <AlertDescription>
        Synthetic local diagnostic with a longer message that wraps on narrow viewports.{' '}
        <a href="#local">Local reference</a>
      </AlertDescription>
    </>
  );
}

export const Variants: Story = {
  render: () => (
    <Scope dark={window.matchMedia('(prefers-color-scheme: dark)').matches}>
      {(['default', 'destructive', 'warning', 'info'] as const).map((variant) => (
        <Alert key={variant} variant={variant} data-case={variant}>
          <Contents />
        </Alert>
      ))}
    </Scope>
  ),
};

export const Structure: Story = {
  render: () => (
    <Scope dark={window.matchMedia('(prefers-color-scheme: dark)').matches}>
      {(['none', 'direct', 'nested'] as const).map((icon) => (
        <Alert key={icon} data-case={icon}>
          <Contents icon={icon} />
        </Alert>
      ))}
      <Alert data-case="description-only">
        <AlertDescription>A description without a title or icon.</AlertDescription>
      </Alert>
    </Scope>
  ),
};

export const VariantDefaults: Story = {
  render: () => (
    <Scope dark={window.matchMedia('(prefers-color-scheme: dark)').matches}>
      <Alert data-case="omitted">
        <Contents />
      </Alert>
      <Alert variant={undefined} data-case="undefined">
        <Contents />
      </Alert>
      <Alert variant={null} data-case="null">
        <Contents />
      </Alert>
      <Alert variant={'unknown' as Variant} data-case="unknown">
        <Contents />
      </Alert>
    </Scope>
  ),
};

export const CallerOverrides: Story = {
  render: () => (
    <Scope dark={window.matchMedia('(prefers-color-scheme: dark)').matches}>
      <Alert variant="warning" data-case="root-classes" xstyle={callerStyles.root}>
        <Contents icon="none" />
      </Alert>
      <Alert data-case="child-classes">
        <CircleAlert {...stylex.props(callerStyles.glyph)} />
        <AlertTitle xstyle={callerStyles.title}>Caller title</AlertTitle>
        <AlertDescription xstyle={callerStyles.description}>Caller description.</AlertDescription>
      </Alert>
      <Alert
        data-case="inline"
        style={{ display: 'block', padding: 23, borderRadius: 11, color: 'rgb(149, 45, 78)' }}
      >
        <Contents />
      </Alert>
      <Alert data-case="conditional-grid-caller" xstyle={callerStyles.grid}>
        <Contents />
      </Alert>
    </Scope>
  ),
};
