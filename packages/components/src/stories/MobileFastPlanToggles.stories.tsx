import type { Meta, StoryObj } from '@storybook/react';
import { useState } from 'react';

import {
  MobileFastModeToggle,
  MobilePlanModeToggle,
} from '@/components/mobile/mobile-fast-plan-toggles';
import type {
  AcpConfigOptionSelector,
  AcpConfigOptionValue,
} from '@/components/shared/acp-selector-options';

const baseSelectors: AcpConfigOptionSelector[] = [
  {
    type: 'select',
    configId: 'fast-mode',
    category: 'fast-mode',
    label: 'Fast mode',
    description: 'Skip extra reasoning for faster responses.',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
    currentValue: 'off',
  },
  {
    type: 'select',
    configId: 'plan-mode',
    category: 'plan-mode',
    label: 'Plan mode',
    description: 'Plan before editing.',
    options: [
      { value: 'off', label: 'Off' },
      { value: 'on', label: 'On' },
    ],
    currentValue: 'off',
  },
];

function StoryShell({
  initialValues = {},
}: {
  initialValues?: Record<string, AcpConfigOptionValue>;
}) {
  const [values, setValues] = useState<Record<string, AcpConfigOptionValue>>(initialValues);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-stone-200 p-6">
      <div className="flex w-[360px] flex-col gap-6 rounded-2xl bg-background p-6 shadow-2xl">
        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Composer footer cluster (Fast lives here)
          </div>
          <div className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-card p-2">
            <button className="rounded-md bg-muted/60 px-2 py-1 text-sm">claude-3.5-sonnet</button>
            <button className="rounded-md bg-muted/60 px-2 py-1 text-sm">high</button>
            <MobileFastModeToggle
              configOptionSelectors={baseSelectors}
              configOptionValues={values}
              onConfigOptionChange={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
            />
          </div>
        </div>

        <div>
          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            Below-composer row (Plan + permission)
          </div>
          <div className="flex items-center gap-1.5 rounded-xl border border-border/60 bg-card p-2">
            <button className="rounded-md bg-muted/60 px-2 py-1 text-sm">Codex</button>
            <div className="ml-auto flex items-center gap-1.5">
              <MobilePlanModeToggle
                configOptionSelectors={baseSelectors}
                configOptionValues={values}
                onConfigOptionChange={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
              />
              <button className="rounded-md bg-muted/60 px-2 py-1 text-sm">Full access</button>
            </div>
          </div>
        </div>

        <pre className="rounded-md bg-muted/40 p-3 text-xs">{JSON.stringify(values, null, 2)}</pre>
      </div>
    </div>
  );
}

const meta = {
  title: 'Mobile/MobileFastPlanToggles',
  component: StoryShell,
  parameters: { layout: 'fullscreen' },
  tags: ['autodocs'],
} satisfies Meta<typeof StoryShell>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BothOff: Story = {};

export const BothOn: Story = {
  args: {
    initialValues: { 'fast-mode': 'on', 'plan-mode': 'on' },
  },
};
