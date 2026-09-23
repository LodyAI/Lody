import type { Meta, StoryObj } from '@storybook/react';

import { OnboardingShell, OnboardingShellHost } from '@/components/onboarding/onboarding-shell';
import { TestCloudPlatformProvider } from '../../tests/test-platform';

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
    <div className="flex flex-col gap-3">
      {PROVIDER_ROWS.map((row) => (
        <div
          key={row.name}
          className="group flex flex-wrap items-center gap-3 rounded-lg border border-border/60 bg-card/40 p-4 transition-colors"
        >
          <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg bg-muted/40">
            <div className="h-5 w-5 rounded-full bg-foreground/70" />
          </div>
          <div className="flex min-w-0 flex-1 flex-col">
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
      <div className="relative h-screen w-full overflow-hidden bg-[#f7f5f2]">
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
