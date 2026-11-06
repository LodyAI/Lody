import * as stylex from '@stylexjs/stylex';
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
const storyLayoutStylesStyles = stylex.create({
  stack: {
    display: 'flex',
    width: '360px',
    'flex-direction': 'column',
    gap: 'calc(var(--spacing) * 6)',
    'border-radius': 'var(--radius-2xl)',
    'background-color': 'hsl(var(--background) / 1)',
    padding: 'calc(var(--spacing) * 6)',
    'box-shadow': '0 0 #0000, 0 0 #0000, 0 0 #0000, 0 0 #0000, 0 25px 50px -12px rgb(0 0 0 / 0.25)',
  },
});

const storyLayoutStyles = stylex.create({
  caption: {
    'margin-bottom': 'calc(var(--spacing) * 2)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
    'font-weight': 'var(--font-weight-semibold)',
    'letter-spacing': 'var(--tracking-wide)',
    color: 'hsl(var(--muted-foreground) / 1)',
    'text-transform': 'uppercase',
  },
  row: {
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
    'border-radius': 'var(--radius-xl)',
    'border-style': 'solid',
    'border-width': '1px',
    'border-color': 'color-mix(in oklab, hsl(var(--border) / 1) 60%, transparent)',
    'background-color': 'hsl(var(--card) / 1)',
    padding: 'calc(var(--spacing) * 2)',
  },
  canvas: {
    'border-radius': 'var(--radius-md)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted) / 1) 60%, transparent)',
    'padding-inline': 'calc(var(--spacing) * 2)',
    'padding-block': 'calc(var(--spacing) * 1)',
    'font-size': 'var(--text-sm)',
    'line-height': 'var(--text-sm--line-height)',
  },
  canvas2: {
    'border-radius': 'var(--radius-md)',
    'background-color': 'color-mix(in oklab, hsl(var(--muted) / 1) 40%, transparent)',
    padding: 'calc(var(--spacing) * 3)',
    'font-size': 'var(--text-xs)',
    'line-height': 'var(--text-xs--line-height)',
  },
});

const storyLayout = stylex.create({
  row: {
    display: 'flex',
    'min-height': '100dvh',
    'align-items': 'center',
    'justify-content': 'center',
    'background-color': 'var(--color-stone-200)',
    padding: 'calc(var(--spacing) * 6)',
  },
  row2: {
    'margin-left': 'auto',
    display: 'flex',
    'align-items': 'center',
    gap: 'calc(var(--spacing) * 1.5)',
  },
});

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
    configId: 'collaboration_mode',
    category: 'collaboration_mode',
    label: 'Collaboration mode',
    description: 'Plan before editing.',
    options: [
      { value: 'default', label: 'Default' },
      { value: 'plan', label: 'Plan' },
    ],
    currentValue: 'default',
  },
];

function StoryShell({
  initialValues = {},
}: {
  initialValues?: Record<string, AcpConfigOptionValue>;
}) {
  const [values, setValues] = useState<Record<string, AcpConfigOptionValue>>(initialValues);

  return (
    <div {...stylex.props(storyLayout.row)}>
      <div {...stylex.props(storyLayoutStylesStyles.stack)}>
        <div>
          <div {...stylex.props(storyLayoutStyles.caption)}>
            Composer footer cluster (Fast lives here)
          </div>
          <div {...stylex.props(storyLayoutStyles.row)}>
            <button {...stylex.props(storyLayoutStyles.canvas)}>claude-3.5-sonnet</button>
            <button {...stylex.props(storyLayoutStyles.canvas)}>high</button>
            <MobileFastModeToggle
              configOptionSelectors={baseSelectors}
              configOptionValues={values}
              onConfigOptionChange={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
            />
          </div>
        </div>

        <div>
          <div {...stylex.props(storyLayoutStyles.caption)}>
            Below-composer row (Plan + permission)
          </div>
          <div {...stylex.props(storyLayoutStyles.row)}>
            <button {...stylex.props(storyLayoutStyles.canvas)}>Codex</button>
            <div {...stylex.props(storyLayout.row2)}>
              <MobilePlanModeToggle
                configOptionSelectors={baseSelectors}
                configOptionValues={values}
                onConfigOptionChange={(id, v) => setValues((p) => ({ ...p, [id]: v }))}
              />
              <button {...stylex.props(storyLayoutStyles.canvas)}>Full access</button>
            </div>
          </div>
        </div>

        <pre {...stylex.props(storyLayoutStyles.canvas2)}>{JSON.stringify(values, null, 2)}</pre>
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
    initialValues: { 'fast-mode': 'on', collaboration_mode: 'plan' },
  },
};
