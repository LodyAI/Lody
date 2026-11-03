import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';

import { OnboardingShell, OnboardingShellHost } from '@/components/onboarding/onboarding-shell';
import { TestCloudPlatformProvider } from '../../tests/test-platform';
const storyLayout = stylex.create({
  stack: {
    display: 'flex',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 3)',
  },
  row: {
    display: 'flex',
    height: 'calc(var(--spacing) * 10)',
    width: 'calc(var(--spacing) * 10)',
    'flex-shrink': '0',
    'align-items': 'center',
    'justify-content': 'center',
    'border-radius': 'var(--radius-lg)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted) / 1) 40%, transparent)',
  },
  frame: {
    height: 'calc(var(--spacing) * 5)',
    width: 'calc(var(--spacing) * 5)',
    'border-radius': 'calc(infinity * 1px)',
    'background-color': 'color-mix(in oklab, hsl(var(--foreground) / 1) 70%, transparent)',
  },
  stack2: {
    display: 'flex',
    'min-width': 'calc(var(--spacing) * 0)',
    flex: '1',
    'flex-direction': 'column',
  },
  frame2: {
    position: 'relative',
    height: '100vh',
    width: '100%',
    overflow: 'hidden',
    'background-color': '#f7f5f2',
  },
});

/**
 * Renders the full onboarding stage for the providers step: the real
 * `TourStill` product preview behind a mock of the "Connect a coding agent"
 * form. Exists to eyeball the camera blur / veil treatment.
 */
const meta = {
  title: 'Onboarding/ProvidersStage',
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta;

export default meta;
type Story = StoryObj<typeof meta>;

const PROVIDER_ROWS = [
  { name: 'Claude Code', subtitle: 'Claude', badge: 'Verified' },
  { name: 'Codex', subtitle: 'Codex', badge: 'Checking' },
  { name: 'Grok', subtitle: 'grok', badge: 'Untested' },
];

function MockProvidersForm() {
  return (
    <div {...stylex.props(storyLayout.stack)}>
      {PROVIDER_ROWS.map((row) => (
        <div
          key={row.name}
          className="group flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/40 p-4 transition-colors"
        >
          <div {...stylex.props(storyLayout.row)}>
            <div {...stylex.props(storyLayout.frame)} />
          </div>
          <div {...stylex.props(storyLayout.stack2)}>
            <span className="text-sm font-medium">{row.name}</span>
            <span className="text-xs text-muted-foreground">{row.subtitle}</span>
          </div>
          <span className="inline-flex items-center gap-1 rounded-full border border-primary/35 bg-primary/8 px-2 py-0.5 text-[10px] text-primary">
            {row.badge}
          </span>
          <span className="text-sm text-muted-foreground">Edit</span>
          <span className="rounded-md border border-border/60 px-3 py-1 text-sm">Test</span>
        </div>
      ))}
    </div>
  );
}

export const ProvidersStep: Story = {
  render: () => (
    <TestCloudPlatformProvider>
      <div {...stylex.props(storyLayout.frame2)}>
        <OnboardingShellHost>
          <OnboardingShell
            stepKey="providers"
            eyebrow="Step 3 of 6"
            title="Connect a coding agent"
            description="Add an Agent now. Lody will continue setup and let you know if anything needs your attention."
          >
            <MockProvidersForm />
          </OnboardingShell>
        </OnboardingShellHost>
      </div>
    </TestCloudPlatformProvider>
  ),
};
