import * as stylex from '@stylexjs/stylex';
import type { Meta, StoryObj } from '@storybook/react';

import { OnboardingShell, OnboardingShellHost } from '@/components/onboarding/onboarding-shell';
import { TestCloudPlatformProvider } from '../../tests/test-platform';
const providerPreview = stylex.create({
  row: {
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 3)',
    borderRadius: 'var(--radius-lg)',
    borderWidth: 1,
    borderStyle: 'solid',
    borderColor: 'color-mix(in oklab,hsl(var(--border) / 1) 60%,transparent)',
    backgroundColor: 'color-mix(in oklab,hsl(var(--card) / 1) 40%,transparent)',
    padding: 'calc(var(--spacing) * 4)',
    transitionProperty:
      'color, background-color, border-color, outline-color, text-decoration-color, fill, stroke',
    transitionDuration: 'var(--default-transition-duration)',
    transitionTimingFunction: 'var(--default-transition-timing-function)',
  },
});
const storyLayoutStyles = stylex.create({
  label: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    fontWeight: 'var(--font-weight-medium)',
  },
  label2: {
    fontSize: 'var(--text-xs)',
    lineHeight: 'var(--text-xs--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  row: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 'calc(var(--spacing) * 1)',
    borderRadius: 'calc(infinity * 1px)',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'color-mix(in oklab, hsl(var(--primary)) 35%, transparent)',
    backgroundColor: 'color-mix(in oklab, hsl(var(--primary)) 8%, transparent)',
    paddingInline: 'calc(var(--spacing) * 2)',
    paddingBlock: 'calc(var(--spacing) * 0.5)',
    fontSize: '10px',
    color: 'hsl(var(--primary))',
  },
  label3: {
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
    color: 'hsl(var(--muted-foreground) / 1)',
  },
  canvas: {
    borderRadius: 'var(--radius-md)',
    borderStyle: 'solid',
    borderWidth: '1px',
    borderColor: 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    paddingInline: 'calc(var(--spacing) * 3)',
    paddingBlock: 'calc(var(--spacing) * 1)',
    fontSize: 'var(--text-sm)',
    lineHeight: 'var(--text-sm--line-height)',
  },
});

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
        <div key={row.name} className={'group ' + stylex.props(providerPreview.row).className}>
          <div {...stylex.props(storyLayout.row)}>
            <div {...stylex.props(storyLayout.frame)} />
          </div>
          <div {...stylex.props(storyLayout.stack2)}>
            <span {...stylex.props(storyLayoutStyles.label)}>{row.name}</span>
            <span {...stylex.props(storyLayoutStyles.label2)}>{row.subtitle}</span>
          </div>
          <span {...stylex.props(storyLayoutStyles.row)}>{row.badge}</span>
          <span {...stylex.props(storyLayoutStyles.label3)}>Edit</span>
          <span {...stylex.props(storyLayoutStyles.canvas)}>Test</span>
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
