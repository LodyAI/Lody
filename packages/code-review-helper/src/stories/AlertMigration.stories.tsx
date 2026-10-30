import type { Meta, StoryObj } from '@storybook/react';
import type { CSSProperties } from 'react';
import { CircleAlert } from 'lucide-react';

import { Alert, AlertDescription, AlertTitle } from '../ui/alert';

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
      <AlertTitle className="capitalize">review diagnostic</AlertTitle>
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
      <Alert
        variant="warning"
        data-case="root-classes"
        className="relative block w-3/4 items-center gap-y-3 rounded-none border-4 border-info bg-info/10 px-5 py-4 text-[17px]"
      >
        <Contents icon="none" />
      </Alert>
      <Alert data-case="child-classes">
        <CircleAlert className="size-6 translate-y-1 text-info" />
        <AlertTitle className="col-start-1 min-h-6 font-normal leading-6 tracking-wide">
          Caller title
        </AlertTitle>
        <AlertDescription className="col-start-1 text-xs text-info">
          Caller description.
        </AlertDescription>
      </Alert>
      <Alert
        data-case="inline"
        style={{ display: 'block', padding: 23, borderRadius: 11, color: 'rgb(149, 45, 78)' }}
      >
        <Contents />
      </Alert>
      <Alert data-case="conditional-grid-caller" className="grid-cols-1 gap-x-5">
        <Contents />
      </Alert>
    </Scope>
  ),
};
